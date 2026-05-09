import json
import logging
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ExplainRequest,
    ExplainResponse,
    ModelInfo,
    ModelsResponse,
    SetModelRequest,
    StepUpdate,
    WorkflowPlanRequest,
    WorkflowPlanResponse,
    WorkflowPlanStepOut,
    WorkflowPlanOut,
    WorkflowExtendRequest,
    WorkflowExtendResponse,
    AgentStartRequest,
    AgentStartResponse,
    AgentStepRequest,
    AgentStepResponse,
    SummarizeRequest,
    SummarizeResponse,
    GuideModeRequest,
    GuideModeResponse,
)
from ollama_client import (
    analyze_guidely,
    call_ollama_text,
    call_ollama_multimodal,
    extract_json,
    list_ollama_models,
    get_active_model,
    set_active_model,
    OllamaUnavailableError,
    MIN_SCREENSHOT_B64_CHARS,
)
from prompt import WORKFLOW_PLAN_PROMPT, WORKFLOW_EXTEND_PROMPT, EXPLAIN_PROMPT, SUMMARIZE_PROMPT, GUIDE_MODE_PROMPT
from agent import run_agent_start, run_agent_step, stream_agent_step

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Guidely Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Chrome extensions send chrome-extension:// origin
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/models", response_model=ModelsResponse)
async def get_models():
    """Return all Ollama models and the currently active model."""
    try:
        raw = await list_ollama_models()
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    available = [
        ModelInfo(
            name=m["name"],
            parameter_size=m.get("details", {}).get("parameter_size"),
            size_bytes=m.get("size"),
        )
        for m in raw
    ]
    return ModelsResponse(available=available, active=get_active_model())


@app.post("/models/active")
async def set_model(body: SetModelRequest):
    """Switch the active Gemma model used for inference."""
    try:
        installed = await list_ollama_models()
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    names = [m["name"] for m in installed]
    if body.model not in names:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{body.model}' is not installed. Available: {names}",
        )
    set_active_model(body.model)
    return {"active": body.model}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(
    request: AnalyzeRequest,
    trace: bool = Query(False, description="If true, include non-sensitive debug stats in the response."),
):
    s = (request.screenshot or "").strip()
    if s and len(s) < MIN_SCREENSHOT_B64_CHARS:
        raise HTTPException(
            status_code=400,
            detail="Screenshot is too small. Omit screenshot for a DOM-only pass, or send a full tab capture.",
        )
    screenshot_b64 = s if len(s) >= MIN_SCREENSHOT_B64_CHARS else None

    try:
        result = await analyze_guidely(
            request.dom_map,
            request.history,
            screenshot_b64=screenshot_b64,
            model=request.model,
            question=request.question,
            trace=trace,
            enable_tools=request.enable_tools,
            page_url=request.page_url,
            page_title=request.page_title,
            workflow=request.workflow,
        )
    except OllamaUnavailableError as exc:
        logger.warning("Ollama call failed: %s", str(exc)[:500])
        raise HTTPException(status_code=503, detail=str(exc))

    needs_shot = bool(result.get("needs_screenshot"))
    if not needs_shot:
        instr = result.get("instruction")
        if instr is None or (isinstance(instr, str) and not str(instr).strip()):
            instr = "I couldn't figure out the next step. Try clicking 'Help me' again."
    else:
        instr = (result.get("instruction") or "").strip() or "Taking a closer look at the page…"

    trace_payload = result.get("_trace") if trace else None

    if trace:
        logger.info(
            "analyze trace model=%s ollama_ms=%s prompt_chars=%s image_b64_chars=%s dom=%s parse_ok=%s",
            trace_payload.get("model") if trace_payload else None,
            trace_payload.get("ollama_elapsed_ms") if trace_payload else None,
            trace_payload.get("user_prompt_chars") if trace_payload else None,
            trace_payload.get("image_base64_chars") if trace_payload else None,
            trace_payload.get("dom_element_count") if trace_payload else None,
            trace_payload.get("json_parsed_ok") if trace_payload else None,
        )

    # Parse step_update from the model response (only meaningful when workflow is present)
    step_update = None
    if request.workflow:
        raw_su = result.get("step_update")
        if isinstance(raw_su, dict) and raw_su.get("step_id"):
            try:
                step_update = StepUpdate(
                    step_id=str(raw_su["step_id"]),
                    status=raw_su.get("status", "done"),
                )
            except Exception:
                pass

    return AnalyzeResponse(
        instruction=instr,
        element_label=result.get("element_label"),
        selector=result.get("selector"),
        model_used=result.get("_model"),
        needs_screenshot=needs_shot,
        trace=trace_payload,
        step_update=step_update,
    )


@app.post("/workflow/plan", response_model=WorkflowPlanResponse)
async def workflow_plan(request: WorkflowPlanRequest):
    """Generate the first 2-3 steps for the given goal and page context."""
    ctx = request.context
    page_lines: list[str] = []
    if ctx.page_url:
        page_lines.append(f"Current URL: {ctx.page_url}")
    if ctx.page_title:
        page_lines.append(f"Page title: {ctx.page_title}")
    if ctx.dom_summary:
        page_lines.append(f"Top interactive elements:\n{ctx.dom_summary}")

    user_text = f"Goal: {request.goal}\n\n" + "\n".join(page_lines)

    try:
        raw = await call_ollama_text(WORKFLOW_PLAN_PROMPT, user_text)
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        parsed = extract_json(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("workflow/plan JSON parse failed: %s | raw: %s", exc, raw[:300])
        raise HTTPException(status_code=502, detail="Model returned an unparseable plan. Please try again.")

    steps_raw = parsed.get("steps") or []
    if not isinstance(steps_raw, list):
        raise HTTPException(status_code=502, detail="Model returned steps in unexpected format.")

    steps = [
        WorkflowPlanStepOut(
            id=str(s.get("id") or f"s{i + 1}"),
            description=str(s.get("description", ""))[:300],
        )
        for i, s in enumerate(steps_raw[:3])   # cap at 3 for rolling-horizon planning
        if isinstance(s, dict) and s.get("description")
    ]
    if not steps:
        raise HTTPException(status_code=502, detail="Model returned an empty plan. Please try again.")

    return WorkflowPlanResponse(
        plan=WorkflowPlanOut(
            goal=str(parsed.get("goal") or request.goal)[:500],
            steps=steps,
        )
    )


@app.post("/workflow/extend", response_model=WorkflowExtendResponse)
async def workflow_extend(request: WorkflowExtendRequest):
    """
    Given goal + completed steps + current page, decide if the goal is done
    or plan the next 2-3 steps. Called automatically when the user finishes
    the last planned step.
    """
    ctx = request.context
    lines: list[str] = [f"Goal: {request.goal}"]

    if request.completed_steps:
        done_list = "\n".join(f"  - {s}" for s in request.completed_steps)
        lines.append(f"\nSteps already completed:\n{done_list}")
    else:
        lines.append("\nNo steps have been completed yet.")

    page_parts: list[str] = []
    if ctx.page_url:
        page_parts.append(f"URL: {ctx.page_url}")
    if ctx.page_title:
        page_parts.append(f"Page title: {ctx.page_title}")
    if ctx.dom_summary:
        page_parts.append(f"Interactive elements on this page:\n{ctx.dom_summary}")
    if page_parts:
        lines.append("\nCurrent page:\n" + "\n".join(page_parts))

    user_text = "\n".join(lines)

    try:
        raw = await call_ollama_text(WORKFLOW_EXTEND_PROMPT, user_text)
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        parsed = extract_json(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("workflow/extend JSON parse failed: %s | raw: %s", exc, raw[:300])
        raise HTTPException(status_code=502, detail="Model returned an unparseable response. Please try again.")

    if parsed.get("done"):
        return WorkflowExtendResponse(done=True, steps=[])

    steps_raw = parsed.get("steps") or []
    offset = request.existing_step_count
    steps = [
        WorkflowPlanStepOut(
            id=str(s.get("id") or f"s{offset + i + 1}"),
            description=str(s.get("description", ""))[:300],
        )
        for i, s in enumerate(steps_raw[:3])
        if isinstance(s, dict) and s.get("description")
    ]
    return WorkflowExtendResponse(done=False, steps=steps)


@app.post("/explain", response_model=ExplainResponse)
async def explain(request: ExplainRequest):
    """Translate confusing text into a plain-English three-section explanation."""
    user_text = f"Domain hint: {request.domain_hint}\n\nText to explain:\n{request.text}"

    try:
        raw = await call_ollama_text(EXPLAIN_PROMPT, user_text)
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        parsed = extract_json(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("explain JSON parse failed: %s | raw: %s", exc, raw[:300])
        raise HTTPException(status_code=502, detail="Model returned an unparseable explanation. Please try again.")

    warnings = parsed.get("warnings") or []
    if not isinstance(warnings, list):
        warnings = [str(warnings)] if warnings else []

    return ExplainResponse(
        what_this_means=str(parsed.get("what_this_means") or "")[:2000],
        why=str(parsed.get("why") or "")[:2000],
        what_you_should_do=str(parsed.get("what_you_should_do") or "")[:2000],
        warnings=[str(w)[:500] for w in warnings[:3]],
    )


# ── Autonomous agent endpoints ────────────────────────────────────────────────

@app.post("/agent/start", response_model=AgentStartResponse)
async def agent_start(request: AgentStartRequest):
    """
    Interpret the user's goal and return a 3–8 step execution plan.
    Called once at the start of a new agent session.
    """
    try:
        return await run_agent_start(request)
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/agent/step", response_model=AgentStepResponse)
async def agent_step(request: AgentStepRequest):
    """
    Run one iteration of the agent loop.
    Returns the next tool call for the extension to execute.
    The extension sends the tool result back in the next call.
    """
    try:
        return await run_agent_step(request)
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.post("/summarize", response_model=SummarizeResponse)
async def summarize(request: SummarizeRequest):
    """
    One-shot summarization mode.
    Accepts a screenshot and/or visible page text and returns a plain-English summary
    of what the user is currently looking at.
    """
    parts: list[str] = []
    if request.page_url:
        parts.append(f"Page URL: {request.page_url}")
    if request.page_title:
        parts.append(f"Page title: {request.page_title}")
    if request.user_question:
        parts.append(f"The user asked: {request.user_question}")
    if request.page_text:
        # Truncate to keep the prompt manageable; screenshots carry more info anyway.
        trimmed = request.page_text[:8000].strip()
        parts.append(f"\nVisible page text:\n{trimmed}")

    user_text = "\n".join(parts) or "Please summarize what is visible on the current screen."

    s = (request.screenshot or "").strip()
    screenshot_b64 = s if len(s) >= MIN_SCREENSHOT_B64_CHARS else None

    logger.info(
        "summarize request: page_text_chars=%s has_screenshot=%s url_host=%s",
        len(request.page_text or ""),
        bool(screenshot_b64),
        (request.page_url or "")[:80],
    )

    try:
        raw = await call_ollama_multimodal(
            SUMMARIZE_PROMPT,
            user_text,
            screenshot_b64=screenshot_b64,
            expect_json=False,
        )
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    summary = (raw or "").strip()
    if not summary:
        summary = "I couldn't read this page clearly. Please try again."

    from ollama_client import get_active_model as _get_model
    model = _get_model()
    logger.info(
        "summarize response: summary_chars=%s model=%s",
        len(summary),
        model,
    )
    return SummarizeResponse(summary=summary, model_used=model)


@app.post("/guide", response_model=GuideModeResponse)
async def guide_mode(request: GuideModeRequest):
    """
    Guide mode — identify the one element the user should interact with next.
    Returns a plain-English instruction + CSS selector to highlight (no navigation/clicks).
    """
    parts: list[str] = []
    if request.page_url:
        parts.append(f"Page URL: {request.page_url}")
    if request.page_title:
        parts.append(f"Page title: {request.page_title}")
    parts.append(f"User's goal: {request.user_question}")
    if request.dom_summary:
        parts.append(f"\nInteractive elements on this page:\n{request.dom_summary}")

    user_text = "\n".join(parts)

    s = (request.screenshot or "").strip()
    screenshot_b64 = s if len(s) >= MIN_SCREENSHOT_B64_CHARS else None

    dom_len = len(request.dom_summary or "")
    logger.info(
        "guide request: dom_summary_chars=%s has_screenshot=%s url_host=%s",
        dom_len,
        bool(screenshot_b64),
        (request.page_url or "")[:80],
    )

    try:
        raw = await call_ollama_multimodal(
            GUIDE_MODE_PROMPT,
            user_text,
            screenshot_b64=screenshot_b64,
            expect_json=True,
        )
    except OllamaUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        parsed = extract_json(raw)
    except Exception as exc:
        logger.warning("guide parse failed: %s | raw=%s", exc, raw[:300])
        raise HTTPException(status_code=502, detail="Model returned an unparseable response. Please try again.")

    instruction = str(parsed.get("instruction") or "").strip()
    if not instruction:
        raise HTTPException(status_code=502, detail="Model returned an empty instruction.")

    item_number = parsed.get("item_number")
    if item_number is not None:
        try:
            item_number = int(item_number)
        except (TypeError, ValueError):
            item_number = None

    from ollama_client import get_active_model as _get_model
    resp = GuideModeResponse(
        instruction=instruction,
        item_number=item_number,
        selector=parsed.get("selector") or None,
        label=parsed.get("label") or None,
        model_used=_get_model(),
    )
    logger.info(
        "guide response: item_number=%s label_preview=%r selector_len=%s instruction_len=%s",
        resp.item_number,
        (resp.label or "")[:60],
        len(resp.selector or ""),
        len(resp.instruction or ""),
    )
    return resp


@app.post("/agent/step/stream")
async def agent_step_stream(request: AgentStepRequest):
    """
    Streaming version of /agent/step using Server-Sent Events (SSE).
    Streams thought tokens in real-time as the model generates them, then
    emits a final "done" frame with the fully-parsed tool call.

    SSE event types (each line: data: <json>):
      {"type":"thinking"}                      — model started
      {"type":"thought","text":"..."}          — partial thought visible while generating
      {"type":"searching","query":"..."}       — about to do a web search
      {"type":"replanning","reason":"..."}     — about to replan
      {"type":"done","tool":"...","params":{...},"display":"...","thought":"..."}
      {"type":"error","message":"..."}         — unrecoverable error
    """
    async def _generate():
        try:
            async for frame in stream_agent_step(request):
                yield frame
        except Exception as exc:
            import json as _json
            yield f"data: {_json.dumps({'type': 'error', 'message': str(exc)[:300]})}\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable nginx buffering if present
        },
    )
