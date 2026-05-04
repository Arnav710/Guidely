"""
Ollama API client — handles model selection, JSON extraction, and retry logic.

Model-switching design:
  - A module-level `_active_model` variable holds the current model name.
  - On startup it auto-detects the best available Gemma 4 model from Ollama.
  - `set_active_model()` / `get_active_model()` provide thread-safe get/set.
  - `call_ollama()` accepts an optional `model` override per-request.
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
    SYSTEM_PROMPT_WITH_TOOLS,
)

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


def extract_json(raw: str) -> dict:
    """Extract the first JSON object from a raw string, ignoring surrounding prose."""
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError(f"No valid JSON found in response: {raw[:200]}")
    return json.loads(match.group())


async def call_ollama(
    screenshot_b64: str,
    elements: list[DomElement],
    history: list[HistoryEntry],
    model: Optional[str] = None,
    question: Optional[str] = None,
    trace: bool = False,
    retry: bool = True,
    system_prompt: Optional[str] = None,
    extra_user_context: Optional[str] = None,
) -> dict:
    global _active_model, _model_detected

    # Auto-detect best installed model once on first real call
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen_model = model or _active_model

    system = system_prompt if system_prompt is not None else build_system_prompt()
    user_text = build_user_turn(
        elements,
        history,
        question=question,
        extra_context=extra_user_context,
    )

    trace_info: dict[str, Any] = {
        "model": chosen_model,
        "dom_element_count": len(elements),
        "history_entries": len(history),
        "image_base64_chars": len(screenshot_b64 or ""),
        "user_prompt_chars": len(user_text),
        "system_prompt_chars": len(system),
        "question_provided": bool((question or "").strip()),
    }

    payload = {
        "model": chosen_model,
        "system": system,
        "prompt": user_text,
        "images": [screenshot_b64],
        "stream": False,
        "format": "json",
    }

    async def _do_post(client: httpx.AsyncClient) -> tuple[dict, float]:
        t0 = time.monotonic()
        response = await client.post(OLLAMA_GENERATE_URL, json=payload)
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        response.raise_for_status()
        body = response.json()
        return body, elapsed_ms

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            body, elapsed_ms = await _do_post(client)
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
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
            len(screenshot_b64 or ""),
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
                async with httpx.AsyncClient(timeout=120.0) as client:
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
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.HTTPStatusError) as exc:
                logger.warning("Ollama retry HTTP failed: %s", exc)
            except OllamaUnavailableError:
                raise
        return _finish(
            {"instruction": raw.strip(), "element_label": None, "selector": None},
            False,
        )


async def analyze_guidely(
    screenshot_b64: str,
    elements: list[DomElement],
    history: list[HistoryEntry],
    model: Optional[str] = None,
    question: Optional[str] = None,
    trace: bool = False,
    enable_tools: bool = True,
) -> dict:
    """
    Run vision LLM; optionally allow one round of web_search tools before final JSON answer.
    All inference goes through Ollama's /api/generate — nothing is answered without the model.
    """
    from tools.web_search import web_search

    if not enable_tools:
        out = await call_ollama(
            screenshot_b64,
            elements,
            history,
            model=model,
            question=question,
            trace=trace,
        )
        out.pop("tool_requests", None)
        return out

    r1 = await call_ollama(
        screenshot_b64,
        elements,
        history,
        model=model,
        question=question,
        trace=trace,
        system_prompt=SYSTEM_PROMPT_WITH_TOOLS,
    )

    reqs = r1.get("tool_requests")
    if not isinstance(reqs, list) or not reqs:
        r1.pop("tool_requests", None)
        return r1

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
        return r1

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

    r2 = await call_ollama(
        screenshot_b64,
        elements,
        history,
        model=model,
        question=question,
        trace=trace,
        system_prompt=SYSTEM_PROMPT_AFTER_TOOLS,
        extra_user_context=extra,
    )

    r2.pop("tool_requests", None)

    if trace:
        t2 = dict(r2.get("_trace") or {})
        t1 = r1.get("_trace") or {}
        if t1:
            t2["analyze_round_1_ms"] = t1.get("ollama_elapsed_ms")
            t2["analyze_round_1_response_chars"] = t1.get("ollama_response_chars")
        t2["web_search_queries"] = queries
        t2["web_search_used"] = True
        r2["_trace"] = t2

    return r2
