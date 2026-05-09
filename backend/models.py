from pydantic import BaseModel, Field, field_validator
from typing import Optional, Any, Literal, List


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


# ── Workflow extend ───────────────────────────────────────────────────────────

class WorkflowExtendRequest(BaseModel):
    goal: str = Field(..., max_length=500)
    completed_steps: list[str] = Field(default_factory=list, max_length=20)
    existing_step_count: int = Field(0, ge=0)
    context: WorkflowContext


class WorkflowExtendResponse(BaseModel):
    done: bool
    steps: list[WorkflowPlanStepOut] = []


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


# ── Agent (autonomous mode) ───────────────────────────────────────────────────

class AgentToolCallIn(BaseModel):
    """One tool call + its result, stored in the rolling history sent with each step."""
    tool: str = Field(..., max_length=64)
    params: dict = Field(default_factory=dict)
    # Compact result — never raw screenshots; just text/structured summaries.
    result: Optional[Any] = None
    called_at: Optional[int] = None


class AgentPlanStepIn(BaseModel):
    id: str = Field(..., max_length=32)
    description: str = Field(..., max_length=300)
    status: Literal["pending", "in_progress", "done", "skipped", "blocked"] = "pending"


class AgentPlanIn(BaseModel):
    goal: str = Field(..., max_length=500)
    steps: List[AgentPlanStepIn]
    current_step_idx: int = Field(0, ge=0)


class AgentStartRequest(BaseModel):
    goal: str = Field(..., max_length=500)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    # Compact summary of page elements to seed the plan (not full DOM).
    dom_summary: Optional[str] = Field(None, max_length=2000)


class AgentStartResponse(BaseModel):
    plan: dict  # { goal: str, steps: [{id, description}] }


class ChatTurn(BaseModel):
    """One user or assistant turn from the persistent conversation thread."""
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=2000)


class AgentStepRequest(BaseModel):
    goal: str = Field(..., max_length=500)
    plan: AgentPlanIn
    # Rolling window of recent tool calls (max 3 sent by client).
    last_tool_calls: List[AgentToolCallIn] = Field(default_factory=list, max_length=5)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    # Latest screenshot — only sent when the most recent tool was screenshot/click/navigate.
    screenshot: Optional[str] = Field(None)
    # Structured result from most recent observation tool (sections/elements/search/text/action_result).
    observation: Optional[Any] = None
    # How many times the current step has been retried.
    retry_count: int = Field(0, ge=0, le=20)
    model: Optional[str] = None
    # Conversation ID — used to key the search results cache for goto_result resolution.
    conversation_id: Optional[str] = Field(None, max_length=128)
    # How many agent loop iterations have run (1-based from client). Used to cap endless exploration.
    loop_iteration: int = Field(0, ge=0, le=500)
    # Last N user/assistant turns from the persistent chat thread — gives the model
    # conversational context (e.g. clarifying answers, follow-ups) across loop restarts.
    chat_history: List[ChatTurn] = Field(default_factory=list, max_length=20)

    @field_validator("screenshot", mode="before")
    @classmethod
    def screenshot_str_or_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        return None


class AgentStepResponse(BaseModel):
    thought: Optional[str] = None
    tool: str
    params: dict = Field(default_factory=dict)
    display: str = ""
    model_used: Optional[str] = None
    # Populated only when tool == "replan"; new steps to replace remaining steps.
    new_steps: Optional[List[dict]] = None


# ── Summarize (one-shot mode) ─────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    """
    Multimodal one-shot summarization request.
    Either screenshot, page_text, or both must be provided.
    """
    screenshot: Optional[str] = Field(
        None,
        description="Base64 PNG of the visible tab. Recommended for visual documents.",
    )
    page_text: Optional[str] = Field(
        None,
        max_length=20000,
        description="Extracted visible text from the page (document.body.innerText).",
    )
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    user_question: Optional[str] = Field(
        None,
        max_length=500,
        description="Optional specific question the user has about what they see.",
    )

    @field_validator("screenshot", mode="before")
    @classmethod
    def screenshot_str_or_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        return None

    @field_validator("page_text", "page_url", "page_title", "user_question", mode="before")
    @classmethod
    def sanitize_unicode(cls, v: Any) -> Optional[str]:
        return _strip_surrogates(v)


class SummarizeResponse(BaseModel):
    summary: str
    model_used: Optional[str] = None


# ── Guide mode (highlight-only mode) ─────────────────────────────────────────

def _strip_surrogates(v: Any) -> Optional[str]:
    """Remove lone surrogate characters that are invalid UTF-8."""
    if v is None:
        return None
    if not isinstance(v, str):
        return None
    return v.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")


class GuideModeRequest(BaseModel):
    """
    Guide mode: the user has asked 'what should I click?'
    The model sees the screenshot + page structure and returns a selector to highlight.
    No navigation, no form filling — pointer only.
    """
    screenshot: Optional[str] = Field(None)
    page_url: Optional[str] = Field(None, max_length=2000)
    page_title: Optional[str] = Field(None, max_length=500)
    dom_summary: Optional[str] = Field(None, max_length=20000)
    user_question: str = Field(..., max_length=500)

    @field_validator("screenshot", mode="before")
    @classmethod
    def screenshot_str_or_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v
        return None

    @field_validator("dom_summary", "page_url", "page_title", "user_question", mode="before")
    @classmethod
    def sanitize_unicode(cls, v: Any) -> Optional[str]:
        return _strip_surrogates(v)


class GuideModeResponse(BaseModel):
    instruction: str
    item_number: Optional[int] = None
    selector: Optional[str] = None
    label: Optional[str] = None
    model_used: Optional[str] = None
