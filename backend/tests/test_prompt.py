from prompt import build_system_prompt, build_user_turn
from models import DomElement, HistoryEntry, WorkflowSnapshot, WorkflowStepSchema


def test_system_prompt_contains_json_instruction():
    prompt = build_system_prompt()
    assert "ONLY valid JSON" in prompt
    assert '"instruction"' in prompt
    assert '"selector"' in prompt


def test_user_turn_contains_dom_map():
    elements = [
        DomElement(id=1, tag="input", type="text", label="First Name", selector="#fname", visible=True),
        DomElement(id=2, tag="button", type="submit", label="Next", selector="button.next-step", visible=True),
    ]
    turn = build_user_turn(elements, history=[])
    assert "#fname" in turn
    assert "First Name" in turn
    assert "button.next-step" in turn


def test_user_turn_includes_history():
    elements = [
        DomElement(id=1, tag="input", type="text", label="Email", selector="#email", visible=True),
    ]
    history = [HistoryEntry(role="assistant", content="Type your first name in the First Name box.")]
    turn = build_user_turn(elements, history=history)
    assert "Type your first name" in turn


def test_user_turn_caps_dom_map_at_50():
    # The current cap is 50 elements.
    elements = [
        DomElement(id=i, tag="input", type="text", label=f"Field {i}", selector=f"#f{i}", visible=True)
        for i in range(70)
    ]
    turn = build_user_turn(elements, history=[])
    assert "#f49" in turn
    assert "#f50" not in turn


def test_user_turn_includes_workflow_step():
    elements = [
        DomElement(id=1, tag="a", label="Renew Online", selector="a.renew", visible=True),
    ]
    workflow = WorkflowSnapshot(
        goal="Renew California driver's license",
        current_step_idx=1,
        steps=[
            WorkflowStepSchema(id="s1", description="Sign in to mydmv.ca.gov", status="done"),
            WorkflowStepSchema(id="s2", description="Open Renew Online section", status="in_progress"),
        ],
    )
    turn = build_user_turn(elements, history=[], workflow=workflow)
    assert "Renew California" in turn
    assert "Open Renew Online section" in turn
    assert "s2" in turn


def test_user_turn_includes_question():
    elements = [
        DomElement(id=1, tag="input", type="text", label="Email", selector="#email", visible=True),
    ]
    turn = build_user_turn(elements, history=[], question="Where do I sign in?")
    assert "Where do I sign in" in turn
    assert "Answer using the screenshot" in turn
    assert "#email" in turn


def test_user_turn_dom_only_mentions_no_screenshot_yet():
    elements = [
        DomElement(id=1, tag="input", type="text", label="Email", selector="#email", visible=True),
    ]
    turn = build_user_turn(
        elements, history=[], question="Where do I sign in?", has_vision=False
    )
    assert "Where do I sign in" in turn
    assert "screenshot yet" in turn.lower()
    assert "#email" in turn


def test_user_turn_extra_context_appended():
    elements = [
        DomElement(id=1, tag="button", type="submit", label="Go", selector="button.go", visible=True),
    ]
    turn = build_user_turn(elements, history=[], question=None, extra_context="WEB BITS HERE")
    assert "WEB BITS HERE" in turn
    assert "button.go" in turn


def test_user_turn_blank_question_uses_next_step_prompt():
    elements = [
        DomElement(id=1, tag="button", type="submit", label="Go", selector="button.go", visible=True),
    ]
    turn = build_user_turn(elements, history=[], question="   ")
    assert "did not type a specific question" in turn
    assert "button.go" in turn
