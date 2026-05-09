import json
import logging
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
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
)
from ollama_client import (
    analyze_guidely,
    call_ollama_text,
    extract_json,
    list_ollama_models,
    get_active_model,
    set_active_model,
    OllamaUnavailableError,
    MIN_SCREENSHOT_B64_CHARS,
)
from prompt import WORKFLOW_PLAN_PROMPT, EXPLAIN_PROMPT

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
    """Generate a 3-8 step plan for the given goal and page context."""
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
        for i, s in enumerate(steps_raw[:8])
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
