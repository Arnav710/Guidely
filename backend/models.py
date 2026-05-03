from pydantic import BaseModel, Field
from typing import Optional


class DomElement(BaseModel):
    id: int
    tag: str
    type: Optional[str] = None
    label: str
    selector: str
    visible: bool


class HistoryEntry(BaseModel):
    role: str
    content: str


class AnalyzeRequest(BaseModel):
    screenshot: str        # base64-encoded PNG
    dom_map: list[DomElement]
    history: list[HistoryEntry] = []
    model: Optional[str] = None  # override active model per-request
    question: Optional[str] = Field(
        None,
        max_length=2000,
        description="Optional user question about this page; answered using screenshot + DOM map.",
    )


class AnalyzeResponse(BaseModel):
    instruction: str
    element_label: Optional[str] = None
    selector: Optional[str] = None
    model_used: Optional[str] = None
    # Present only when POST /analyze?trace=1 — confirms payload sizes and Ollama timing (no raw prompts/images).
    trace: Optional[dict] = None


class ModelInfo(BaseModel):
    name: str
    parameter_size: Optional[str] = None
    size_bytes: Optional[int] = None


class ModelsResponse(BaseModel):
    available: list[ModelInfo]
    active: str


class SetModelRequest(BaseModel):
    model: str
