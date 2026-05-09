"""
agent.py — Autonomous agent service layer.

Handles two operations:
  run_agent_start  — interpret a goal + page context → return a step plan
  run_agent_step   — given current loop state → return one tool call

The backend is stateless: all conversational context is passed in every request
by the extension (from chrome.storage.local). The backend never stores chat history.
"""

import json
import logging
import re
import time
from typing import Any, AsyncIterator, Optional

from models import AgentStartRequest, AgentStartResponse, AgentStepRequest, AgentStepResponse
from ollama_client import (
    call_agent,
    call_ollama_text,
    detect_hallucination,
    extract_json,
    screenshot_usable,
    stream_agent_call,
    OllamaUnavailableError,
)
from prompt import AGENT_SYSTEM_PROMPT, AGENT_PLAN_PROMPT

logger = logging.getLogger(__name__)

# After this many agent loop iterations, force a terminal "done" so the user gets a chat answer.
_AGENT_FORCE_DONE_AT_ITERATION = 18


def _apply_loop_budget_force_done(
    request: AgentStepRequest,
    tool: str,
    params: dict,
    thought: str,
    display: str,
) -> tuple[str, dict, str, str]:
    """If the client has run many steps, stop browsing and surface a final message."""
    n = int(getattr(request, "loop_iteration", 0) or 0)
    if n < _AGENT_FORCE_DONE_AT_ITERATION or tool in ("done", "ask_user"):
        return tool, params, display, thought
    summary = " ".join(
        p for p in (thought or "", display or "") if p and str(p).strip()
    ).strip()
    if len(summary) < 40:
        summary = (
            "I've opened several pages while working on your request. Check the site we're on now for "
            "official details, or tell me what you'd like me to focus on next."
        )
    logger.info(
        "loop_iteration=%d >= %d — forcing done (was tool=%r)",
        n,
        _AGENT_FORCE_DONE_AT_ITERATION,
        tool,
    )
    return (
        "done",
        {"message": summary[:4000]},
        "Here's a summary for you.",
        thought,
    )


# Maximum observation content lengths to keep context compact for small models.
_MAX_SECTIONS = 10
_MAX_ELEMENTS = 20
_MAX_SEARCH_MATCHES = 8
_MAX_TEXT_CHARS = 700
_MAX_RESULT_CHARS = 250

# ── Search results cache ──────────────────────────────────────────────────────
# Stores the last web_search results per conversation so goto_result can resolve
# the URL without the LLM ever producing one. TTL: 5 minutes.
_SEARCH_CACHE: dict[str, tuple[float, list[dict]]] = {}
_SEARCH_CACHE_TTL = 300.0


def _cache_results(conv_id: str, results: list[dict]) -> None:
    _SEARCH_CACHE[conv_id] = (time.monotonic(), results)


def _get_cached_results(conv_id: str) -> Optional[list[dict]]:
    entry = _SEARCH_CACHE.get(conv_id)
    if not entry:
        return None
    ts, results = entry
    if time.monotonic() - ts > _SEARCH_CACHE_TTL:
        _SEARCH_CACHE.pop(conv_id, None)
        return None
    return results


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compact_params(params: dict) -> str:
    """Render params as a short string for the history block."""
    try:
        s = json.dumps(params, separators=(",", ":"))
        return s[:80] + ("…" if len(s) > 80 else "")
    except Exception:
        return str(params)[:80]


def _compress_result(result: Any) -> str:
    """Compress a tool result to a short string for the rolling history."""
    if result is None:
        return "null"
    if isinstance(result, str):
        s = result
    else:
        try:
            s = json.dumps(result, separators=(",", ":"))
        except Exception:
            s = str(result)
    return s[:_MAX_RESULT_CHARS] + ("…" if len(s) > _MAX_RESULT_CHARS else "")


def plan_goal_from_step(request: "AgentStepRequest") -> str:
    """Return the current step description or overall goal as a fallback search query."""
    plan = request.plan
    idx = plan.current_step_idx
    if 0 <= idx < len(plan.steps):
        return plan.steps[idx].description or plan.goal
    return plan.goal


def _format_search_results(results: list[dict], query: str) -> str:
    """Format search result records as a numbered list for the LLM."""
    if not results:
        return f"No results found for '{query}'."
    lines = []
    for r in results:
        domain = ""
        try:
            from urllib.parse import urlparse
            domain = urlparse(r["url"]).netloc
        except Exception:
            domain = r["url"][:40]
        lines.append(
            f"[{r['index']}] {r['title']}  ({domain})\n"
            f"    {r['snippet']}"
        )
    return "\n".join(lines)


def _render_observation(obs: Any) -> list[str]:
    """Convert the structured observation dict into compact text lines for the prompt."""
    if not obs or not isinstance(obs, dict):
        return []

    lines = []
    otype = obs.get("type", "")

    if otype == "sections":
        sections = obs.get("sections") or []
        lines.append(f"Page sections ({len(sections)} regions):")
        for s in sections[:_MAX_SECTIONS]:
            lines.append(f"  [{s.get('id','')}] {s.get('label','')} — {s.get('element_count',0)} elements")

    elif otype == "elements":
        elems = obs.get("elements") or []
        lines.append(f"Elements in section '{obs.get('section_id','')}' ({len(elems)} total):")
        for e in elems[:_MAX_ELEMENTS]:
            lines.append(
                f"  {e.get('tag','?')} '{e.get('label','')}' type={e.get('type','') or '-'}"
                f" selector={e.get('selector','')}"
            )

    elif otype == "search":
        matches = obs.get("matches") or []
        lines.append(f"Search '{obs.get('query','')}' — {len(matches)} match(es):")
        for m in matches[:_MAX_SEARCH_MATCHES]:
            context = f" [in: {m.get('context','')}]" if m.get("context") else ""
            lines.append(
                f"  '{m.get('label','')}' <{m.get('tag','?')}> selector={m.get('selector','')}{context}"
            )

    elif otype == "text":
        content = str(obs.get("content") or "")
        lines.append("Page text:")
        lines.append(content[:_MAX_TEXT_CHARS])

    elif otype == "action_result":
        tool_name = obs.get("tool", "action")
        if obs.get("success"):
            details = obs.get("details", "")
            lines.append(f"✓ {tool_name} succeeded. {details}")
            # If action_result is paired with sections (after auto-capture), render them too
            if obs.get("sections"):
                lines.append(f"New page sections ({len(obs['sections'])} regions):")
                for s in obs["sections"][:_MAX_SECTIONS]:
                    lines.append(f"  [{s.get('id','')}] {s.get('label','')} — {s.get('element_count',0)} elements")
        else:
            error = obs.get("error", "unknown error")
            lines.append(f"✗ {tool_name} FAILED: {error}")

    return lines


def _build_agent_context(request: AgentStepRequest) -> str:
    """
    Build the compact user-turn text for the LLM.
    Budget target: ~600–800 tokens of text (excluding optional image).
    """
    lines: list[str] = []

    # Page context (always present)
    page_url = request.page_url or ""
    page_info = f"{request.page_title or 'unknown page'} — {page_url}"
    lines.append(f"Current page: {page_info}")

    # Explicit nudge: if we're sitting on a search engine, remind model to use web_search
    _SEARCH_ENGINE_HOSTS = ("google.", "bing.com", "duckduckgo.com", "yahoo.com", "search.yahoo")
    if any(h in page_url for h in _SEARCH_ENGINE_HOSTS):
        lines.append("NOTE: You are on a search engine. Use web_search tool — do NOT interact with this page's UI.")
    lines.append("")

    # Goal + step summary
    plan = request.plan
    steps = plan.steps
    idx = plan.current_step_idx
    current = steps[idx] if 0 <= idx < len(steps) else None
    done_steps = [s for s in steps if s.status == "done"]
    upcoming = [s for s in steps[idx + 1:] if s.status not in ("done", "skipped")][:2]

    lines.append(f"GOAL: {plan.goal}")
    if done_steps:
        lines.append("Completed: " + " → ".join(s.description for s in done_steps[-3:]))
    if current:
        lines.append(f"CURRENT STEP ({current.id}): {current.description}")
    if upcoming:
        lines.append("Next steps: " + " | ".join(s.description for s in upcoming))
    if request.retry_count > 0:
        lines.append(f"[Current step retried {request.retry_count}× — consider replan if stuck]")
    lines.append("")

    # Conversation history — lets the model see clarifying answers and follow-ups.
    history = getattr(request, "chat_history", None) or []
    if history:
        lines.append("Conversation so far:")
        for turn in history[-6:]:  # last 6 turns to keep context compact
            prefix = "User" if turn.role == "user" else "Assistant"
            content = str(turn.content)[:300]
            lines.append(f"  {prefix}: {content}")
        lines.append("")

    # Rolling tool history (last 3 calls, each compressed to one line)
    if request.last_tool_calls:
        lines.append("Recent actions:")
        for tc in request.last_tool_calls[-3:]:
            result_str = _compress_result(tc.result)
            lines.append(f"  {tc.tool}({_compact_params(tc.params)}) → {result_str}")
        lines.append("")

        # Detect when the model is spinning on the same observation tool with the
        # same arguments — warn it explicitly so it stops repeating and acts.
        _OBS_TOOLS = {"get_page_text", "get_elements", "get_sections", "search_page"}
        recent = request.last_tool_calls[-3:]
        if len(recent) >= 2:
            keys = [
                f"{tc.tool}:{_compact_params(tc.params)}"
                for tc in recent
                if tc.tool in _OBS_TOOLS
            ]
            if len(keys) >= 2 and len(set(keys)) == 1:
                lines.append(
                    f"WARNING: You have called {recent[-1].tool}({_compact_params(recent[-1].params)}) "
                    "multiple times in a row and received the same result. "
                    "Do NOT call it again. Either summarise what you have observed and call done, "
                    "or try a DIFFERENT tool or section."
                )
                lines.append("")

    # Latest observation
    if request.observation:
        obs_lines = _render_observation(request.observation)
        if obs_lines:
            lines.extend(obs_lines)
            lines.append("")

    # Exploration budget: client sends monotonically increasing loop_iteration (1-based).
    n = int(getattr(request, "loop_iteration", 0) or 0)
    if n >= 6:
        lines.append(
            f"NOTE: Agent step #{n}. If the goal is to FIND or EXPLAIN information and you already have "
            "enough from this page or your last observation, call done with a clear summary in "
            '"message" for the user. Avoid another web_search or navigation unless still missing the core facts.'
        )
    if n >= 12:
        lines.append(
            f"STEP BUDGET ({n}): Prefer done with a helpful message summary for the user, "
            "or ask_user. Do not chain more navigations unless strictly necessary."
        )
    if n >= 16:
        lines.append(
            "FINAL BUDGET WARNING: Your next tool should be done or ask_user only — no more browsing."
        )

    lines.append("What is your next tool call?")
    return "\n".join(lines)


# ── Public service functions ──────────────────────────────────────────────────

async def run_agent_start(request: AgentStartRequest) -> AgentStartResponse:
    """
    Generate a step-by-step plan for the given goal.
    Uses the active model (text-only; no vision needed for planning).

    If the planner returns {"needs_clarification": true, "question": "..."} the
    backend synthesises a one-step plan whose single step is ask_user, so the
    agent loop fires the clarifying question on the very first iteration instead
    of wandering around booking sites for a dozen steps.
    """
    parts: list[str] = [f"Goal: {request.goal}"]
    if request.page_url:
        parts.append(f"Current URL: {request.page_url}")
    if request.page_title:
        parts.append(f"Page title: {request.page_title}")
    if request.dom_summary:
        parts.append(f"Visible page elements: {request.dom_summary}")
    # Explicit signal so the model doesn't ask for context that's already on screen.
    if request.page_url or request.page_title:
        parts.append(
            "NOTE: The user is already on this page. "
            "If the goal can be addressed using the content visible on this page, "
            "do NOT ask for clarification — set needs_clarification = false and plan directly."
        )

    user_text = "\n".join(parts)
    raw = await call_ollama_text(AGENT_PLAN_PROMPT, user_text)

    try:
        parsed = extract_json(raw)
    except (ValueError, Exception) as exc:
        logger.warning("agent/start plan parse failed: %s | raw=%s", exc, raw[:300])
        raise ValueError("Model returned an unparseable plan. Please try again.")

    # Planner signalled that required details are missing — synthesise a
    # one-step plan so the loop immediately calls ask_user on iteration 1.
    if parsed.get("needs_clarification"):
        question = str(parsed.get("question") or (
            "Before I start, I need a few details. Could you tell me the "
            "specific dates and any other information needed for this task?"
        ))[:500]
        logger.info("agent/start needs_clarification — injecting ask_user step")
        return AgentStartResponse(
            plan={
                "goal": request.goal[:500],
                "steps": [{"id": "s1", "description": f"ask_user: {question}"}],
                # Embed the question so the step loop can surface it directly.
                "clarification_question": question,
            }
        )

    steps_raw = parsed.get("steps") or []
    steps = [
        {"id": str(s.get("id") or f"s{i + 1}"), "description": str(s.get("description", ""))[:300]}
        for i, s in enumerate(steps_raw[:3])   # cap at 3 for rolling-horizon planning
        if isinstance(s, dict) and s.get("description")
    ]
    if not steps:
        raise ValueError("Model returned an empty plan. Please try again.")

    return AgentStartResponse(
        plan={
            "goal": str(parsed.get("goal") or request.goal)[:500],
            "steps": steps,
        }
    )


async def run_agent_step(request: AgentStepRequest) -> AgentStepResponse:
    """
    Run one iteration of the agent loop:
    1. Build compact context text
    2. Call the LLM (with optional screenshot vision)
    3. Handle server-side tools: web_search (second LLM call), replan (plan generation)
    4. Return the tool call to the extension
    """
    user_text = _build_agent_context(request)
    has_vision = screenshot_usable(request.screenshot)

    raw_out = await call_agent(
        AGENT_SYSTEM_PROMPT,
        user_text,
        screenshot_b64=request.screenshot if has_vision else None,
        model=request.model,
    )

    tool = str(raw_out.get("tool") or "ask_user").strip()
    params = raw_out.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    thought = str(raw_out.get("thought") or "")[:500]
    display = str(raw_out.get("display") or "")[:300] or f"Running {tool}…"
    model_used: Optional[str] = raw_out.get("_model")

    # ── Intercept: navigate to a search engine → convert to web_search ────────
    # Catches the common hallucination where the model tries to navigate to
    # google.com/search?q=... or bing.com/search?q=... instead of using web_search.
    _SEARCH_ENGINE_RE = re.compile(
        r"https?://(www\.)?"
        r"(google\.[a-z]{2,3}(/search)?|bing\.com(/search)?|duckduckgo\.com|search\.yahoo\.com)"
        r"[/?]",
        re.IGNORECASE,
    )
    if tool in ("navigate", "navigate_and_read"):
        nav_url = str(params.get("url") or "").strip()
        if _SEARCH_ENGINE_RE.match(nav_url):
            # Extract the query from common URL param patterns
            q_match = re.search(r"[?&]q=([^&]+)", nav_url)
            inferred_query = (
                re.sub(r"\+", " ", q_match.group(1)) if q_match else plan_goal_from_step(request)
            )
            logger.info(
                "Intercepted search-engine navigate → web_search (url=%s, query=%r)",
                nav_url[:120], inferred_query[:80],
            )
            tool = "web_search"
            params = {"query": inferred_query}
            display = f"Searching for '{inferred_query}'…"

    # ── Handle goto_result WITHOUT a prior web_search (edge case) ─────────────
    # If the model calls goto_result before searching, check the cache.
    # If nothing found, redirect to web_search using the current step as the query.
    conv_id = (request.conversation_id or "").strip()
    if tool == "goto_result" and not conv_id:
        # No conversation_id — can't cache/lookup; fall through to the handler below
        # which will return ask_user if no results are available.
        pass

    # ── Handle web_search server-side ─────────────────────────────────────────
    # Runs the search, formats numbered results, caches them, then makes a second
    # LLM call so the model can immediately decide what to do with the results.
    current_search_results: list[dict] = []

    if tool == "web_search":
        query = str(params.get("query") or "").strip()[:300]
        raw_results: list[dict] = []
        formatted = f"No results found for '{query}'."
        if query:
            try:
                from tools.web_search import web_search_rich
                formatted, raw_results = await web_search_rich(query)
            except Exception as exc:
                formatted = f"Search failed: {str(exc)[:200]}"
                raw_results = []

        # Cache results keyed by conversation_id so goto_result can resolve them later.
        if conv_id and raw_results:
            _cache_results(conv_id, raw_results)
        current_search_results = raw_results

        extra = (
            f"\n\nWeb search results for '{query}':\n{formatted}\n\n"
            "Decide your next tool call. Use goto_result with the index of the best result, "
            "or use another tool if the results are not helpful."
        )
        raw_out2 = await call_agent(
            AGENT_SYSTEM_PROMPT,
            user_text + extra,
            screenshot_b64=request.screenshot if has_vision else None,
            model=request.model,
        )
        tool = str(raw_out2.get("tool") or tool).strip()
        params = raw_out2.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        thought = str(raw_out2.get("thought") or thought)[:500]
        display = str(raw_out2.get("display") or display)[:300] or f"Running {tool}…"
        model_used = raw_out2.get("_model")

    # ── Resolve goto_result → navigate ────────────────────────────────────────
    # The LLM picks a result by index; we supply the real URL so it never
    # produces one itself.
    if tool == "goto_result":
        idx_raw = params.get("index")
        try:
            result_idx = int(idx_raw)
        except (TypeError, ValueError):
            result_idx = 0

        # Prefer results from this request; fall back to the per-conversation cache.
        results_to_use = current_search_results or (
            _get_cached_results(conv_id) if conv_id else None
        )

        if results_to_use and 0 <= result_idx < len(results_to_use):
            resolved_url = results_to_use[result_idx].get("url", "")
            if resolved_url:
                logger.info(
                    "goto_result index=%d → %s", result_idx, resolved_url[:120]
                )
                tool = "navigate"
                params = {"url": resolved_url}
                display = f"Going to result {result_idx}…"
            else:
                tool = "ask_user"
                params = {"question": "I found a search result but couldn't get its link. Could you search for it manually?"}
                display = "Asking for help…"
        else:
            logger.warning(
                "goto_result index=%d but no search results available (cache key=%r)",
                result_idx, conv_id,
            )
            tool = "web_search"
            params = {"query": plan_goal_from_step(request)}
            display = "Let me search for that first…"

    # ── Handle replan server-side ─────────────────────────────────────────────
    new_steps: Optional[list[dict]] = None
    if tool == "replan":
        reason = str(params.get("reason") or "")[:300]
        current_desc = ""
        plan = request.plan
        if 0 <= plan.current_step_idx < len(plan.steps):
            current_desc = plan.steps[plan.current_step_idx].description

        replan_context = (
            f"Goal: {plan.goal}\n"
            f"Stuck on: {current_desc}\n"
            f"Reason: {reason}\n"
            f"Current URL: {request.page_url or 'unknown'}\n"
            "Create a new plan to complete the goal from this position."
        )
        try:
            raw_plan = await call_ollama_text(AGENT_PLAN_PROMPT, replan_context)
            parsed_plan = extract_json(raw_plan)
            steps_raw = parsed_plan.get("steps") or []
            new_steps = [
                {"id": str(s.get("id") or f"r{i + 1}"), "description": str(s.get("description", ""))[:300]}
                for i, s in enumerate(steps_raw[:8])
                if isinstance(s, dict) and s.get("description")
            ]
        except Exception as exc:
            logger.warning("replan generation failed: %s", exc)
            new_steps = None

    tool, params, display, thought = _apply_loop_budget_force_done(
        request, tool, params, thought, display,
    )

    return AgentStepResponse(
        thought=thought or None,
        tool=tool,
        params=params,
        display=display,
        model_used=model_used,
        new_steps=new_steps,
    )


# ── Streaming version ─────────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    """Format one Server-Sent Events frame."""
    return f"data: {json.dumps(data, separators=(',', ':'))}\n\n"


def _extract_thought_partial(accumulated: str) -> Optional[str]:
    """
    Given an in-progress JSON string from the model, extract a readable snippet
    of the 'thought' value to show while the model is still generating.
    Returns None until we have at least a few characters of the thought value.
    """
    marker = '"thought"'
    idx = accumulated.find(marker)
    if idx < 0:
        return None
    rest = accumulated[idx + len(marker):]
    # Skip whitespace and colon
    colon_idx = rest.find(':"')
    if colon_idx < 0:
        return None
    content = rest[colon_idx + 2:]
    if len(content) < 4:
        return None
    # Unescape and truncate at the closing quote (if we've reached it)
    unescaped = content.replace('\\"', '"').replace("\\n", " ").replace("\\t", " ")
    end = 0
    i = 0
    while i < len(unescaped):
        if unescaped[i] == '"' and (i == 0 or unescaped[i - 1] != '\\'):
            end = i
            break
        i += 1
    return unescaped[:end] if end else unescaped[:200]


async def stream_agent_step(request: AgentStepRequest) -> AsyncIterator[str]:
    """
    Async generator of SSE frames for the streaming /agent/step/stream endpoint.

    SSE event types:
      {"type":"thinking"}                         — model started generating
      {"type":"thought","text":"..."}             — partial thought text (progressive)
      {"type":"searching","query":"..."}          — web_search triggered
      {"type":"replanning","reason":"..."}        — replan triggered
      {"type":"done","tool":"...","params":{...},"display":"...","thought":"..."}
      {"type":"error","message":"..."}            — unrecoverable error
    """
    user_text = _build_agent_context(request)
    has_vision = screenshot_usable(request.screenshot)

    conv_id_log = (request.conversation_id or "?")[:8]
    logger.info(
        "[stream %s] BEGIN goal=%r step=%d/%d iter=%d page=%r vision=%s",
        conv_id_log, request.plan.goal[:60],
        request.plan.current_step_idx, len(request.plan.steps),
        int(getattr(request, "loop_iteration", 0) or 0),
        (request.page_url or "")[:80], has_vision,
    )

    # Signal that the model has started.
    yield _sse({"type": "thinking"})

    accumulated = ""
    last_thought_len = 0

    try:
        async for token in stream_agent_call(
            AGENT_SYSTEM_PROMPT,
            user_text,
            screenshot_b64=request.screenshot if has_vision else None,
            model=request.model,
        ):
            accumulated += token

            # Try to surface partial thought text progressively.
            thought_partial = _extract_thought_partial(accumulated)
            if thought_partial and len(thought_partial) > last_thought_len + 8:
                last_thought_len = len(thought_partial)
                yield _sse({"type": "thought", "text": thought_partial})

    except OllamaUnavailableError as exc:
        logger.warning("[stream %s] ollama unavailable: %s", conv_id_log, exc)
        yield _sse({"type": "error", "message": str(exc)})
        return

    logger.info(
        "[stream %s] LLM_CALL_1 raw_chars=%d preview=%r",
        conv_id_log, len(accumulated), accumulated[:300],
    )

    # Parse the complete JSON.
    try:
        raw_out = extract_json(accumulated)
    except (ValueError, json.JSONDecodeError):
        logger.warning("[stream %s] LLM_CALL_1 json_parse_failed — retrying via call_agent", conv_id_log)
        try:
            raw_out = await call_agent(
                AGENT_SYSTEM_PROMPT,
                user_text + "\n\nRespond with ONLY the JSON object. No other text.",
                screenshot_b64=request.screenshot if has_vision else None,
                model=request.model,
            )
        except Exception as exc:
            logger.error("[stream %s] LLM_CALL_1 retry failed: %s", conv_id_log, exc)
            yield _sse({"type": "error", "message": f"Parse failed: {str(exc)[:200]}"})
            return

    tool = str(raw_out.get("tool") or "ask_user").strip()
    params = raw_out.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    thought = str(raw_out.get("thought") or "")[:500]
    display = str(raw_out.get("display") or "")[:300] or f"Running {tool}…"

    logger.info(
        "[stream %s] LLM_CALL_1 parsed tool=%r params=%s",
        conv_id_log, tool, json.dumps(params)[:200],
    )

    # ── Handle web_search server-side ─────────────────────────────────────────
    conv_id = (request.conversation_id or "").strip()
    stream_search_results: list[dict] = []

    if tool == "web_search":
        query = str(params.get("query") or "").strip()[:300]
        logger.info("[stream %s] WEB_SEARCH query=%r", conv_id_log, query)
        yield _sse({"type": "searching", "query": query})

        formatted = f"No results found for '{query}'."
        if query:
            try:
                from tools.web_search import web_search_rich
                formatted, stream_search_results = await web_search_rich(query)
                logger.info(
                    "[stream %s] WEB_SEARCH ok query=%r results=%d",
                    conv_id_log, query, len(stream_search_results),
                )
            except Exception as exc:
                logger.error("[stream %s] WEB_SEARCH failed: %s", conv_id_log, exc)
                formatted = f"Search failed: {str(exc)[:200]}"
                stream_search_results = []

        if conv_id and stream_search_results:
            _cache_results(conv_id, stream_search_results)

        extra = (
            f"\n\nWeb search results for '{query}':\n{formatted}\n\n"
            "Decide your next tool call. Use goto_result with the index of the best result, "
            "or use another tool if the results are not helpful. "
            "DO NOT call web_search again — pick a result with goto_result."
        )

        # Stream the second LLM call with search results.
        accumulated2 = ""
        last2 = 0
        try:
            async for token in stream_agent_call(
                AGENT_SYSTEM_PROMPT,
                user_text + extra,
                screenshot_b64=request.screenshot if has_vision else None,
                model=request.model,
            ):
                accumulated2 += token
                thought_p = _extract_thought_partial(accumulated2)
                if thought_p and len(thought_p) > last2 + 8:
                    last2 = len(thought_p)
                    yield _sse({"type": "thought", "text": thought_p})
        except OllamaUnavailableError as exc:
            logger.warning("[stream %s] LLM_CALL_2 ollama unavailable: %s", conv_id_log, exc)
            yield _sse({"type": "error", "message": str(exc)})
            return

        logger.info(
            "[stream %s] LLM_CALL_2 raw_chars=%d preview=%r",
            conv_id_log, len(accumulated2), accumulated2[:300],
        )

        try:
            raw_out = extract_json(accumulated2)
        except Exception as exc:
            logger.error(
                "[stream %s] LLM_CALL_2 json_parse_failed: %s | raw=%r",
                conv_id_log, exc, accumulated2[:500],
            )
            yield _sse({"type": "error", "message": "Could not parse model response after web search."})
            return

        prev_tool = tool
        tool = str(raw_out.get("tool") or tool).strip()
        params = raw_out.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        thought = str(raw_out.get("thought") or thought)[:500]
        display = str(raw_out.get("display") or display)[:300] or f"Running {tool}…"
        logger.info(
            "[stream %s] LLM_CALL_2 parsed tool=%r (was %r) params=%s",
            conv_id_log, tool, prev_tool, json.dumps(params)[:200],
        )

        # SAFETY NET: model called web_search again instead of picking a result.
        # Auto-pick the first result (or fall back to ask_user) so we never send
        # web_search to the extension as a final tool.
        if tool == "web_search":
            logger.warning(
                "[stream %s] SAFETY_NET model returned web_search again — auto-picking result 0",
                conv_id_log,
            )
            if stream_search_results:
                tool = "goto_result"
                params = {"index": 0}
                display = "Opening the top search result…"
            else:
                tool = "ask_user"
                params = {"question": "I couldn't find good search results. Could you tell me where to look?"}
                display = "Asking for help…"

    # ── Resolve goto_result → navigate ────────────────────────────────────────
    # The LLM picks a result index; we supply the real URL so it never outputs one.
    if tool == "goto_result":
        try:
            result_idx = int(params.get("index", 0))
        except (TypeError, ValueError):
            result_idx = 0

        results_to_use = stream_search_results or (
            _get_cached_results(conv_id) if conv_id else None
        )

        logger.info(
            "[stream %s] GOTO_RESULT idx=%d cached_count=%d",
            conv_id_log, result_idx, len(results_to_use or []),
        )

        if results_to_use and 0 <= result_idx < len(results_to_use):
            resolved_url = results_to_use[result_idx].get("url", "")
            if resolved_url:
                logger.info(
                    "[stream %s] GOTO_RESULT resolved idx=%d → %s",
                    conv_id_log, result_idx, resolved_url[:120],
                )
                tool = "navigate"
                params = {"url": resolved_url}
                display = f"Going to result {result_idx}…"
            else:
                logger.warning("[stream %s] GOTO_RESULT result has no URL", conv_id_log)
                tool = "ask_user"
                params = {"question": "I found a search result but couldn't get its link. Please search manually."}
                display = "Asking for help…"
        else:
            # No cached results — fall back to ask_user (NOT web_search; that
            # would leak to the extension as an unknown tool).
            logger.warning(
                "[stream %s] GOTO_RESULT no results in cache — converting to ask_user",
                conv_id_log,
            )
            tool = "ask_user"
            params = {"question": "I lost track of my search results. Could you tell me what you'd like me to look up?"}
            display = "Asking for help…"

    # ── Handle replan server-side ─────────────────────────────────────────────
    new_steps: Optional[list] = None
    if tool == "replan":
        reason = str(params.get("reason") or "")[:300]
        current_desc = ""
        plan = request.plan
        if 0 <= plan.current_step_idx < len(plan.steps):
            current_desc = plan.steps[plan.current_step_idx].description

        yield _sse({"type": "replanning", "reason": reason})

        replan_context = (
            f"Goal: {plan.goal}\n"
            f"Stuck on: {current_desc}\n"
            f"Reason: {reason}\n"
            f"Current URL: {request.page_url or 'unknown'}\n"
            "Create a new plan to complete the goal from this position."
        )
        try:
            raw_plan = await call_ollama_text(AGENT_PLAN_PROMPT, replan_context)
            parsed_plan = extract_json(raw_plan)
            steps_raw = parsed_plan.get("steps") or []
            new_steps = [
                {"id": str(s.get("id") or f"r{i + 1}"), "description": str(s.get("description", ""))[:300]}
                for i, s in enumerate(steps_raw[:8])
                if isinstance(s, dict) and s.get("description")
            ]
        except Exception as exc:
            logger.warning("replan generation failed: %s", exc)
            new_steps = None

    # Hard cap on exploration — guarantees a final chat message for the user.
    tool, params, display, thought = _apply_loop_budget_force_done(
        request, tool, params, thought, display,
    )

    # ── Final safety net: never emit a server-only tool to the extension ──────
    _CLIENT_TOOLS = {
        "get_sections", "get_elements", "search_page", "get_page_text",
        "screenshot", "find_and_click", "fill_field", "click_link",
        "click", "type_text", "scroll", "navigate",
        "complete_step", "replan", "ask_user", "done",
    }
    if tool not in _CLIENT_TOOLS:
        logger.error(
            "[stream %s] FINAL_SAFETY_NET tool=%r is server-only or unknown — "
            "converting to ask_user. params=%s",
            conv_id_log, tool, json.dumps(params)[:200],
        )
        tool = "ask_user"
        params = {"question": "I got a bit confused about what to do next. Could you tell me what you see?"}
        display = "Asking for help…"

    # ── Final done frame ──────────────────────────────────────────────────────
    logger.info(
        "[stream %s] DONE tool=%r display=%r params=%s",
        conv_id_log, tool, display[:80], json.dumps(params)[:200],
    )
    done_data: dict[str, Any] = {
        "type": "done",
        "tool": tool,
        "params": params,
        "display": display,
    }
    if thought:
        done_data["thought"] = thought
    if new_steps is not None:
        done_data["new_steps"] = new_steps
    yield _sse(done_data)
