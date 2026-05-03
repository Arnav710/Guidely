import json
from models import DomElement, HistoryEntry

SYSTEM_PROMPT = """You are Guidely, a patient and friendly assistant helping elderly people use the internet.
You are given:
  1. A screenshot of the webpage the user is currently viewing
  2. A list of interactive elements currently on the page (their labels and CSS selectors)

Your job is to give the user ONE clear, simple next step — written in plain English with no jargon.
Speak as if explaining to someone who has never used a computer before.
Be warm, calm, and encouraging.

You MUST respond with ONLY valid JSON in this exact format:
{
  "instruction": "<one sentence telling the user what to do next>",
  "element_label": "<label of the element from the provided list, or null if none>",
  "selector": "<CSS selector of the element from the provided list, or null if none>"
}

Only use selectors from the provided element list. Do not invent selectors.
If no specific element action is needed, set both element_label and selector to null.
Do not include any text outside the JSON block."""


def build_system_prompt() -> str:
    return SYSTEM_PROMPT


def build_user_turn(elements: list[DomElement], history: list[HistoryEntry]) -> str:
    capped = elements[:30]
    dom_json = json.dumps(
        [{"id": e.id, "tag": e.tag, "type": e.type, "label": e.label, "selector": e.selector} for e in capped],
        indent=2,
    )

    history_block = ""
    if history:
        lines = [f"  [{h.role}]: {h.content}" for h in history]
        history_block = "\nPrevious steps already completed:\n" + "\n".join(lines) + "\n"

    return (
        f"{history_block}"
        f"Here is the current page. What should I do next?\n\n"
        f"Interactive elements on the page:\n{dom_json}"
    )
