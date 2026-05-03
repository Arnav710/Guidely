from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ModelInfo,
    ModelsResponse,
    SetModelRequest,
)
from ollama_client import (
    call_ollama,
    list_ollama_models,
    get_active_model,
    set_active_model,
    OllamaUnavailableError,
)

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
async def analyze(request: AnalyzeRequest):
    try:
        result = await call_ollama(
            screenshot_b64=request.screenshot,
            elements=request.dom_map,
            history=request.history,
            model=request.model,
        )
    except OllamaUnavailableError:
        raise HTTPException(
            status_code=503,
            detail="Guidely is offline. Please make sure Ollama is running.",
        )

    return AnalyzeResponse(
        instruction=result.get(
            "instruction",
            "I couldn't figure out the next step. Try clicking 'Help me' again.",
        ),
        element_label=result.get("element_label"),
        selector=result.get("selector"),
        model_used=result.get("_model"),
    )
