from prompt import build_system_prompt, build_user_turn
from models import DomElement, HistoryEntry


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


def test_user_turn_caps_dom_map_at_30():
    elements = [
        DomElement(id=i, tag="input", type="text", label=f"Field {i}", selector=f"#f{i}", visible=True)
        for i in range(50)
    ]
    turn = build_user_turn(elements, history=[])
    assert "#f29" in turn
    assert "#f30" not in turn


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
