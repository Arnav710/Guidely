"""
Ollama API client — handles model selection, JSON extraction, and retry logic.

Model-switching design:
  - A module-level `_active_model` variable holds the current model name.
  - On startup it auto-detects the best available Gemma 4 model from Ollama.
  - `set_active_model()` / `get_active_model()` provide thread-safe get/set.
  - `call_ollama(elements, history, screenshot_b64=...)` — image optional; omit for DOM-only text passes.
  - Per-request `model` override is supported.
"""

import sys
import re
import json
import logging
import time
from pathlib import Path
from typing import Optional, Any
import httpx

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from models import DomElement, HistoryEntry
from prompt import (
    build_system_prompt,
    build_user_turn,
    SYSTEM_PROMPT_AFTER_TOOLS,
    SYSTEM_PROMPT_AFTER_TOOLS_DOM_FIRST,
    SYSTEM_PROMPT_WITH_TOOLS,
    SYSTEM_PROMPT_WITH_TOOLS_DOM_FIRST,
    WORKFLOW_PLAN_PROMPT,
    EXPLAIN_PROMPT,
)
from models import WorkflowSnapshot

MIN_SCREENSHOT_B64_CHARS = 80

# Split timeout: short connect (fail fast) + long read (model inference can be slow)
_OLLAMA_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

# Ollama generation options applied to every call.
# repeat_penalty > 1.0 penalises repeated tokens — prevents sw/sw/sw hallucination loops.
# num_predict caps generation length so a runaway loop is cut short automatically.
_OLLAMA_OPTIONS: dict[str, Any] = {
    "repeat_penalty": 1.15,
    "num_predict": 512,
}

# Tighter options for the streaming agent endpoint (must still fit full tool JSON)
_AGENT_OPTIONS: dict[str, Any] = {
    "repeat_penalty": 1.18,
    "num_predict": 512,
}

# ── Constrained output schema for agent calls ─────────────────────────────────
# Ollama supports passing a full JSON Schema as the `format` field.
# By listing every valid tool name in an enum, the model's constrained-decoding
# engine is physically prevented from generating an invalid/hallucinated tool name.
AGENT_TOOL_NAMES: list[str] = [
    "get_sections", "get_elements", "search_page", "get_page_text",
    "screenshot", "web_search",
    "find_and_click", "fill_field",
    "click_link", "goto_result",
    "click", "type_text", "scroll",
    "complete_step", "replan", "ask_user", "done",
]

_AGENT_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "thought":  {"type": "string"},
        "tool":     {"type": "string", "enum": AGENT_TOOL_NAMES},
        "params":   {"type": "object"},
        "display":  {"type": "string"},
    },
    "required": ["thought", "tool", "params", "display"],
}

OLLAMA_BASE = "http://localhost:11434"
OLLAMA_GENERATE_URL = f"{OLLAMA_BASE}/api/generate"
OLLAMA_TAGS_URL = f"{OLLAMA_BASE}/api/tags"

# Fallback preference order — first match wins if multiple are installed
# Tag reference: e2b=~5B vision, e4b=~9B vision (default), 26b/31b larger
_MODEL_PREFERENCE = [
    "gemma4:31b",
    "gemma4:26b",
    "gemma4:e4b",
    "gemma4:e2b",
    "gemma4:2b",
    "gemma4",
]

_active_model: str = "gemma4:e4b"  # prefer 4B-class multimodal; overwritten after detection if missing
_model_detected: bool = False

logger = logging.getLogger(__name__)


class OllamaUnavailableError(Exception):
    pass


def _ollama_generate_error_message(body: dict) -> Optional[str]:
    """Ollama often returns HTTP 200 with {\"error\": \"...\"} when inference fails."""
    err = body.get("error")
    if err is None:
        return None
    if isinstance(err, str) and err.strip():
        return err.strip()[:800]
    return str(err)[:800]


async def _detect_best_model() -> str:
    """Query Ollama tags and pick the best available Gemma 4 model."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(OLLAMA_TAGS_URL)
            resp.raise_for_status()
            names = [m["name"] for m in resp.json().get("models", [])]
    except Exception:
        return _active_model

    for preferred in _MODEL_PREFERENCE:
        if preferred in names:
            return preferred
    # Return any gemma4 variant found
    gemma_models = [n for n in names if n.startswith("gemma4")]
    return gemma_models[0] if gemma_models else _active_model


async def list_ollama_models() -> list[dict]:
    """Return all models currently registered in Ollama."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(OLLAMA_TAGS_URL)
            resp.raise_for_status()
            return resp.json().get("models", [])
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned error: {exc.response.status_code}")


def get_active_model() -> str:
    return _active_model


def set_active_model(model: str) -> None:
    global _active_model, _model_detected
    _active_model = model
    _model_detected = True


def screenshot_usable(screenshot_b64: Optional[str]) -> bool:
    s = (screenshot_b64 or "").strip()
    return len(s) >= MIN_SCREENSHOT_B64_CHARS


def extract_json(raw: str) -> dict:
    """Extract the first JSON object from a raw string, ignoring surrounding prose."""
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError(f"No valid JSON found in response: {raw[:200]}")
    return json.loads(match.group())


def detect_hallucination(raw: str) -> bool:
    """
    Detect token-repetition hallucinations common in small models (e.g. Gemma 4 2B/4B).

    Two patterns are checked:
    1. Path-segment repetition: same URL path chunk appears 4+ times consecutively
       (catches bing.com/sw/sw/sw/sw/sw/sw… and similar patterns).
    2. Short n-gram repetition: any 3–10 char sequence that repeats 8+ times
       anywhere in the output (catches broader looping).
    """
    if not raw:
        return False

    # Pattern 1 — repeated URL path segment  (e.g. /sw/sw/sw/sw)
    if re.search(r"(/[^/\s]{1,20})\1{3,}", raw):
        return True

    # Pattern 2 — any short substring repeated 8+ times
    for length in range(3, 11):
        for i in range(len(raw) - length * 8):
            chunk = raw[i : i + length]
            if raw.count(chunk) >= 8 and chunk.strip() and len(chunk.strip()) >= 2:
                return True

    return False


async def call_ollama(
    elements: list[DomElement],
    history: list[HistoryEntry],
    screenshot_b64: Optional[str] = None,
    model: Optional[str] = None,
    question: Optional[str] = None,
    trace: bool = False,
    retry: bool = True,
    system_prompt: Optional[str] = None,
    extra_user_context: Optional[str] = None,
    page_url: Optional[str] = None,
    page_title: Optional[str] = None,
    workflow: Optional[WorkflowSnapshot] = None,
) -> dict:
    global _active_model, _model_detected

    # Auto-detect best installed model once on first real call
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen_model = model or _active_model

    has_vision = screenshot_usable(screenshot_b64)
    system = system_prompt if system_prompt is not None else build_system_prompt(has_vision=has_vision)
    user_text = build_user_turn(
        elements,
        history,
        question=question,
        extra_context=extra_user_context,
        has_vision=has_vision,
        page_url=page_url,
        page_title=page_title,
        workflow=workflow,
    )

    trace_info: dict[str, Any] = {
        "model": chosen_model,
        "dom_element_count": len(elements),
        "history_entries": len(history),
        "image_base64_chars": len((screenshot_b64 or "").strip()) if has_vision else 0,
        "user_prompt_chars": len(user_text),
        "system_prompt_chars": len(system),
        "question_provided": bool((question or "").strip()),
        "vision_image_attached": has_vision,
    }

    payload: dict[str, Any] = {
        "model": chosen_model,
        "system": system,
        "prompt": user_text,
        "stream": False,
        "format": "json",
        "options": _OLLAMA_OPTIONS,
    }
    if has_vision:
        payload["images"] = [screenshot_b64]

    async def _do_post(client: httpx.AsyncClient) -> tuple[dict, float]:
        t0 = time.monotonic()
        response = await client.post(OLLAMA_GENERATE_URL, json=payload)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        response.raise_for_status()
        body = response.json()
        return body, elapsed_ms

    try:
        async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
            body, elapsed_ms = await _do_post(client)
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.ReadTimeout:
        raise OllamaUnavailableError("Ollama timed out generating a response — the model may be overloaded or too large for this hardware")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned HTTP {exc.response.status_code}")

    err_msg = _ollama_generate_error_message(body)
    if err_msg:
        logger.warning("Ollama generate error (model=%s): %s", chosen_model, err_msg[:300])
        raise OllamaUnavailableError(f"Ollama could not run the model: {err_msg}")

    raw = body.get("response") or ""
    trace_info["ollama_elapsed_ms"] = round(elapsed_ms, 2)
    trace_info["ollama_response_chars"] = len(raw)

    def _finish(result: dict, parsed_ok: bool) -> dict:
        result["_model"] = chosen_model
        trace_info["json_parsed_ok"] = parsed_ok
        if trace:
            result["_trace"] = trace_info
        logger.info(
            "ollama ok model=%s elapsed_ms=%.1f response_chars=%s parsed=%s dom=%s img_b64_len=%s",
            chosen_model,
            elapsed_ms,
            len(raw),
            parsed_ok,
            len(elements),
            len((screenshot_b64 or "").strip()) if has_vision else 0,
        )
        return result

    try:
        result = extract_json(raw)
        return _finish(result, True)
    except (ValueError, json.JSONDecodeError):
        trace_info["json_parse_error"] = True
        if retry:
            payload["prompt"] += "\n\nYou MUST respond with ONLY the JSON object. No other text."
            try:
                async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
                    body2, elapsed2 = await _do_post(client)
                err2 = _ollama_generate_error_message(body2)
                if err2:
                    raise OllamaUnavailableError(f"Ollama (retry): {err2}")
                raw = body2.get("response") or ""
                trace_info["ollama_retry_elapsed_ms"] = round(elapsed2, 2)
                trace_info["ollama_response_chars"] = len(raw)
                try:
                    result = extract_json(raw)
                    return _finish(result, True)
                except (ValueError, json.JSONDecodeError):
                    pass
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.HTTPStatusError) as exc:
                logger.warning("Ollama retry HTTP failed: %s", exc)
            except OllamaUnavailableError:
                raise
        fb: dict[str, Any] = {"instruction": raw.strip(), "element_label": None, "selector": None}
        if not has_vision:
            fb["needs_screenshot"] = False
        return _finish(fb, False)


def _normalize_analyze_out(out: dict, has_vision: bool) -> dict:
    o = dict(out)
    o.pop("tool_requests", None)
    if has_vision:
        o.pop("needs_screenshot", None)
        o["needs_screenshot"] = False
    else:
        o["needs_screenshot"] = bool(o.get("needs_screenshot"))
    return o


async def call_agent(
    system_prompt: str,
    user_text: str,
    screenshot_b64: Optional[str] = None,
    model: Optional[str] = None,
) -> dict:
    """
    Agent-specific Ollama call: plain system + user text, optional vision image.
    Returns a parsed JSON dict. On parse failure retries once, then falls back
    to an ask_user tool call so the loop degrades gracefully instead of crashing.
    """
    global _active_model, _model_detected
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen = model or _active_model
    has_vision = screenshot_usable(screenshot_b64)

    payload: dict[str, Any] = {
        "model": chosen,
        "system": system_prompt,
        "prompt": user_text,
        "stream": False,
        "format": _AGENT_RESPONSE_SCHEMA,
        "options": _AGENT_OPTIONS,
    }
    if has_vision:
        payload["images"] = [screenshot_b64]

    async def _do_post(client: httpx.AsyncClient) -> tuple[dict, float]:
        t0 = time.monotonic()
        response = await client.post(OLLAMA_GENERATE_URL, json=payload)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        response.raise_for_status()
        return response.json(), elapsed_ms

    try:
        async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
            body, elapsed_ms = await _do_post(client)
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.ReadTimeout:
        raise OllamaUnavailableError("Ollama timed out generating a response — the model may be overloaded or too large for this hardware")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned HTTP {exc.response.status_code}")

    err_msg = _ollama_generate_error_message(body)
    if err_msg:
        raise OllamaUnavailableError(f"Ollama agent call failed: {err_msg}")

    raw = body.get("response") or ""
    logger.info(
        "ollama agent ok model=%s elapsed_ms=%.1f chars=%s vision=%s",
        chosen, round(elapsed_ms, 1), len(raw), has_vision,
    )

    if detect_hallucination(raw):
        logger.warning("ollama agent hallucination detected (model=%s) — returning screenshot recovery", chosen)
        return {
            "thought": "Model output contained a repetition loop — taking a screenshot to reorient.",
            "tool": "screenshot",
            "params": {},
            "display": "Taking a fresh look at the page...",
            "_model": chosen,
        }

    def _fallback_get_sections() -> dict:
        """Safe structural recovery: re-read the page instead of asking the user."""
        return {
            "thought": "Model response could not be parsed — re-reading page structure to recover.",
            "tool": "get_sections",
            "params": {},
            "display": "Re-reading the page structure...",
            "_model": chosen,
        }

    try:
        result = extract_json(raw)
        result["_model"] = chosen
        return result
    except (ValueError, json.JSONDecodeError):
        # Retry with an explicit JSON reminder appended to the prompt
        payload["prompt"] += "\n\nRespond with ONLY the JSON object described in the instructions. No other text."
        try:
            async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
                body2, _ = await _do_post(client)
            err2 = _ollama_generate_error_message(body2)
            if err2:
                raise OllamaUnavailableError(f"Ollama agent retry failed: {err2}")
            raw2 = body2.get("response") or ""
            result = extract_json(raw2)
            result["_model"] = chosen
            return result
        except (ValueError, json.JSONDecodeError):
            logger.warning("agent JSON parse failed after retry — falling back to get_sections")
            return _fallback_get_sections()


async def stream_agent_call(
    system_prompt: str,
    user_text: str,
    screenshot_b64: Optional[str] = None,
    model: Optional[str] = None,
):
    """
    Async generator: streams raw token strings from Ollama's generate API.
    Yields each non-empty token string as it arrives.
    Raises OllamaUnavailableError on connection or model errors.
    The caller accumulates tokens and parses the final JSON.
    """
    global _active_model, _model_detected
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen = model or _active_model
    has_vision = screenshot_usable(screenshot_b64)

    payload: dict[str, Any] = {
        "model": chosen,
        "system": system_prompt,
        "prompt": user_text,
        "stream": True,
        "format": _AGENT_RESPONSE_SCHEMA,
        "options": _AGENT_OPTIONS,
    }
    if has_vision:
        payload["images"] = [screenshot_b64]

    t0 = time.monotonic()
    accumulated_for_log = []
    try:
        async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
            async with client.stream("POST", OLLAMA_GENERATE_URL, json=payload) as response:
                if response.status_code != 200:
                    raise OllamaUnavailableError(f"Ollama returned HTTP {response.status_code}")
                async for raw_line in response.aiter_lines():
                    if not raw_line:
                        continue
                    try:
                        chunk = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("error"):
                        raise OllamaUnavailableError(f"Ollama stream error: {chunk['error']}")
                    token = chunk.get("response") or ""
                    if token:
                        accumulated_for_log.append(token)
                        yield token
                    if chunk.get("done"):
                        elapsed_ms = (time.monotonic() - t0) * 1000.0
                        full = "".join(accumulated_for_log)
                        logger.info(
                            "ollama stream done model=%s elapsed_ms=%.1f vision=%s chars=%d full=%r",
                            chosen, round(elapsed_ms, 1), has_vision, len(full), full[:400],
                        )
                        return
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.ReadTimeout:
        raise OllamaUnavailableError("Ollama stream timed out — the model may be overloaded or too large for this hardware")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama stream disconnected: {exc}")


async def call_ollama_text(
    system_prompt: str,
    user_text: str,
    *,
    model: Optional[str] = None,
) -> str:
    """
    Text-only (no vision) Ollama call. Returns the raw response string.
    Used for plan generation, explain, and vigilance triage.
    """
    global _active_model, _model_detected
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen = model or _active_model
    payload: dict[str, Any] = {
        "model": chosen,
        "system": system_prompt,
        "prompt": user_text,
        "stream": False,
        "format": "json",
        "options": _OLLAMA_OPTIONS,
    }
    try:
        async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
            response = await client.post(OLLAMA_GENERATE_URL, json=payload)
            response.raise_for_status()
            body = response.json()
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.ReadTimeout:
        raise OllamaUnavailableError("Ollama timed out generating a response — the model may be overloaded or too large for this hardware")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned HTTP {exc.response.status_code}")

    err_msg = _ollama_generate_error_message(body)
    if err_msg:
        raise OllamaUnavailableError(f"Ollama could not run the model: {err_msg}")

    return body.get("response") or ""


async def analyze_guidely(
    elements: list[DomElement],
    history: list[HistoryEntry],
    screenshot_b64: Optional[str] = None,
    model: Optional[str] = None,
    question: Optional[str] = None,
    trace: bool = False,
    enable_tools: bool = True,
    page_url: Optional[str] = None,
    page_title: Optional[str] = None,
    workflow: Optional[WorkflowSnapshot] = None,
) -> dict:
    """
    Run Gemma via Ollama. With a usable screenshot, attach vision; without it, DOM-only pass
    may set needs_screenshot for a follow-up request from the extension.
    Optionally allow one round of web_search before the final JSON answer.
    When a workflow is provided, uses a workflow-aware system prompt and returns step_update.
    """
    from tools.web_search import web_search

    has_image = screenshot_usable(screenshot_b64)
    img_arg = screenshot_b64 if has_image else None
    has_workflow = workflow is not None

    if not enable_tools:
        out = await call_ollama(
            elements,
            history,
            screenshot_b64=img_arg,
            model=model,
            question=question,
            trace=trace,
            system_prompt=build_system_prompt(has_vision=has_image, has_workflow=has_workflow),
            page_url=page_url,
            page_title=page_title,
            workflow=workflow,
        )
        return _normalize_analyze_out(out, has_image)

    sys_first = SYSTEM_PROMPT_WITH_TOOLS if has_image else SYSTEM_PROMPT_WITH_TOOLS_DOM_FIRST
    # Workflow conversations bypass the tool-request path and go straight to the focused prompt
    if has_workflow:
        sys_first = build_system_prompt(has_vision=has_image, has_workflow=True)

    r1 = await call_ollama(
        elements,
        history,
        screenshot_b64=img_arg,
        model=model,
        question=question,
        trace=trace,
        system_prompt=sys_first,
        page_url=page_url,
        page_title=page_title,
        workflow=workflow,
    )

    reqs_raw = r1.get("tool_requests")
    reqs = reqs_raw if isinstance(reqs_raw, list) else []

    if not has_image and r1.get("needs_screenshot") and not reqs:
        return _normalize_analyze_out(r1, False)

    if not reqs:
        r1.pop("tool_requests", None)
        if not has_image and r1.get("needs_screenshot"):
            return _normalize_analyze_out(r1, False)
        return _normalize_analyze_out(r1, has_image)

    queries: list[str] = []
    for item in reqs[:2]:
        if not isinstance(item, dict):
            continue
        if item.get("tool") != "web_search":
            continue
        q = item.get("query")
        if isinstance(q, str) and q.strip():
            queries.append(q.strip()[:500])
    if not queries:
        r1.pop("tool_requests", None)
        if not has_image and r1.get("needs_screenshot"):
            return _normalize_analyze_out(r1, False)
        return _normalize_analyze_out(r1, has_image)

    parts: list[str] = []
    for q in queries:
        try:
            text = await web_search(q)
            parts.append(f"Query: {q}\n{text}")
        except Exception as exc:
            parts.append(f"Query: {q}\n(Error: {str(exc)[:400]})")

    blob = "\n\n---\n\n".join(parts)
    extra = (
        "---\nWeb search results (verify against the page; use plain language):\n"
        f"{blob}\n---\nAnswer the user completely. Do not request more tools. JSON only."
    )

    sys_after = SYSTEM_PROMPT_AFTER_TOOLS if has_image else SYSTEM_PROMPT_AFTER_TOOLS_DOM_FIRST
    r2 = await call_ollama(
        elements,
        history,
        screenshot_b64=img_arg,
        model=model,
        question=question,
        trace=trace,
        system_prompt=sys_after,
        extra_user_context=extra,
        page_url=page_url,
        page_title=page_title,
        workflow=workflow,
    )

    if trace:
        t2 = dict(r2.get("_trace") or {})
        t1 = r1.get("_trace") or {}
        if t1:
            t2["analyze_round_1_ms"] = t1.get("ollama_elapsed_ms")
            t2["analyze_round_1_response_chars"] = t1.get("ollama_response_chars")
        t2["web_search_queries"] = queries
        t2["web_search_used"] = True
        r2["_trace"] = t2

    if not has_image and r2.get("needs_screenshot"):
        return _normalize_analyze_out(r2, False)

    return _normalize_analyze_out(r2, has_image)
