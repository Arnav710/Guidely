import logging
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ModelInfo,
    ModelsResponse,
    SetModelRequest,
)
from ollama_client import (
    analyze_guidely,
    list_ollama_models,
    get_active_model,
    set_active_model,
    OllamaUnavailableError,
    MIN_SCREENSHOT_B64_CHARS,
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

    return AnalyzeResponse(
        instruction=instr,
        element_label=result.get("element_label"),
        selector=result.get("selector"),
        model_used=result.get("_model"),
        needs_screenshot=needs_shot,
        trace=trace_payload,
    )
