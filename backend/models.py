from pydantic import BaseModel, Field, field_validator
from typing import Optional, Any


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
    screenshot: Optional[str] = Field(
        None,
        description="Base64 PNG of the visible tab. Omit or null for a DOM-only pass.",
    )
    dom_map: list[DomElement]
    history: list[HistoryEntry] = []
    model: Optional[str] = None  # override active model per-request
    question: Optional[str] = Field(
        None,
        max_length=2000,
        description="Optional user question about this page; answered using screenshot + DOM map.",
    )
    enable_tools: bool = Field(
        True,
        description="If true, model may request web_search; backend runs tools and calls Ollama again.",
    )
    page_url: Optional[str] = Field(
        None,
        max_length=2000,
        description="Full URL of the page the user is viewing.",
    )
    page_title: Optional[str] = Field(
        None,
        max_length=500,
        description="document.title of the page the user is viewing.",
    )

    @field_validator("screenshot", mode="before")
    @classmethod
    def screenshot_str_or_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        # Mistyped JSON would otherwise raise "Input should be a valid string"; treat as no image.
        return None


class AnalyzeResponse(BaseModel):
    instruction: str
    element_label: Optional[str] = None
    selector: Optional[str] = None
    model_used: Optional[str] = None
    needs_screenshot: bool = Field(
        False,
        description="True when the DOM-only pass needs a screenshot; client should POST again with screenshot.",
    )
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
