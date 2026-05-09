from pydantic import BaseModel, Field, field_validator
from typing import Optional, Any, Literal


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


# ── Workflow schemas ──────────────────────────────────────────────────────────

class WorkflowStepSchema(BaseModel):
    id: str
    description: str
    status: Literal["pending", "in_progress", "done", "skipped", "blocked"] = "pending"


class WorkflowSnapshot(BaseModel):
    """Subset of client-side workflow state sent with each /analyze request."""
    goal: str = Field(..., max_length=500)
    steps: list[WorkflowStepSchema]
    current_step_idx: int = Field(0, ge=0)


class StepUpdate(BaseModel):
    """Returned by /analyze when the model is confident a step is complete."""
    step_id: str
    status: Literal["pending", "in_progress", "done", "skipped", "blocked"]
    evidence: Optional[dict] = None


# ── Analyze ──────────────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    screenshot: Optional[str] = Field(
        None,
        description="Base64 PNG of the visible tab. Omit or null for a DOM-only pass.",
    )
    dom_map: list[DomElement]
    history: list[HistoryEntry] = []
    model: Optional[str] = None
    question: Optional[str] = Field(None, max_length=2000)
    enable_tools: bool = Field(True)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    # Persistent conversation fields (P1/P2 — ignored by the backend for state, used for prompting)
    conversation_id: Optional[str] = Field(None, max_length=128)
    autonomy_level: int = Field(1, ge=0, le=3)
    workflow: Optional[WorkflowSnapshot] = None

    @field_validator("screenshot", mode="before")
    @classmethod
    def screenshot_str_or_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        return None


class AnalyzeResponse(BaseModel):
    instruction: str
    element_label: Optional[str] = None
    selector: Optional[str] = None
    model_used: Optional[str] = None
    needs_screenshot: bool = Field(False)
    trace: Optional[dict] = None
    step_update: Optional[StepUpdate] = None


# ── Workflow plan ─────────────────────────────────────────────────────────────

class WorkflowContext(BaseModel):
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    dom_summary: Optional[str] = Field(None, max_length=5000)


class WorkflowPlanRequest(BaseModel):
    goal: str = Field(..., max_length=500)
    context: WorkflowContext


class WorkflowPlanStepOut(BaseModel):
    id: str
    description: str
    status: str = "pending"


class WorkflowPlanOut(BaseModel):
    goal: str
    steps: list[WorkflowPlanStepOut]


class WorkflowPlanResponse(BaseModel):
    plan: WorkflowPlanOut


# ── Explain ──────────────────────────────────────────────────────────────────

class ExplainRequest(BaseModel):
    text: str = Field(..., max_length=8000)
    domain_hint: str = Field("generic", max_length=64)


class ExplainResponse(BaseModel):
    what_this_means: str
    why: str
    what_you_should_do: str
    warnings: list[str] = []


# ── Models ───────────────────────────────────────────────────────────────────

class ModelInfo(BaseModel):
    name: str
    parameter_size: Optional[str] = None
    size_bytes: Optional[int] = None


class ModelsResponse(BaseModel):
    available: list[ModelInfo]
    active: str


class SetModelRequest(BaseModel):
    model: str
