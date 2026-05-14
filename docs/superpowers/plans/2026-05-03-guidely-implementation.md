# Lumineer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome extension + local FastAPI backend that captures a tab screenshot and DOM element map, sends them to Gemma 4 via Ollama, and highlights the exact element a senior user should interact with next.

**Architecture:** A Manifest V3 Chrome extension injects a floating "Help me" button into every page. On click, `content.js` serializes up to 30 interactive DOM elements and `background.js` captures a screenshot; both are POSTed to a FastAPI server that prompts Gemma 4 (via Ollama) to return a CSS selector + plain-English instruction. `content.js` resolves the selector, scrolls the element into view, and renders a pulsing highlight ring sized exactly to the element via `getBoundingClientRect()`.

**Tech Stack:** Chrome Extensions (Manifest V3, vanilla JS), Python 3.11+, FastAPI, Uvicorn, httpx, Ollama (`gemma4` model), pytest, pytest-asyncio

---

## File Map

```
Guidely/
├── extension/
│   ├── manifest.json          # MV3 manifest: permissions, content scripts, background
│   ├── background.js          # Service worker: handles CAPTURE messages, captureVisibleTab
│   ├── content.js             # Injected: button, sidebar, DOM serializer, highlight overlay
│   ├── popup.html             # Extension popup: status indicator
│   ├── popup.js               # Checks backend health on popup open
│   └── assets/
│       └── icon.png           # 128x128 extension icon (placeholder ok for hackathon)
├── backend/
│   ├── main.py                # FastAPI app, POST /analyze, POST /health
│   ├── prompt.py              # System prompt string + user turn builder
│   ├── ollama_client.py       # httpx call to Ollama, JSON extraction, retry logic
│   ├── models.py              # Pydantic request/response models
│   ├── requirements.txt       # fastapi, uvicorn, httpx, pydantic
│   └── tests/
│       ├── test_prompt.py     # Unit tests for prompt builder
│       ├── test_ollama_client.py  # Unit tests for JSON extraction + retry logic
│       └── test_main.py       # Integration tests for /analyze endpoint
└── README.md                  # Setup instructions
```

---

## Task 1: Backend project scaffold + health endpoint

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/models.py`
- Create: `backend/main.py`
- Create: `backend/tests/test_main.py`

- [ ] **Step 1: Create `backend/requirements.txt`**

```
fastapi==0.115.12
uvicorn[standard]==0.34.2
httpx==0.28.1
pydantic==2.11.4
pytest==8.3.5
pytest-asyncio==0.26.0
httpx==0.28.1
```

- [ ] **Step 2: Install dependencies**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Expected: all packages install without error.

- [ ] **Step 3: Write the failing test**

Create `backend/tests/test_main.py`:

```python
import pytest
from httpx import AsyncClient, ASGITransport
from main import app


@pytest.mark.asyncio
async def test_health_returns_ok():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd backend
pytest tests/test_main.py::test_health_returns_ok -v
```

Expected: `ImportError` or `ModuleNotFoundError` — `main` doesn't exist yet.

- [ ] **Step 5: Create `backend/models.py`**

```python
from pydantic import BaseModel
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


class AnalyzeResponse(BaseModel):
    instruction: str
    element_label: Optional[str] = None
    selector: Optional[str] = None
```

- [ ] **Step 6: Create `backend/main.py` with just the health endpoint**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Lumineer Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Chrome extensions send chrome-extension:// origin
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd backend
pytest tests/test_main.py::test_health_returns_ok -v
```

Expected: `PASSED`.

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat: backend scaffold with health endpoint"
```

---

## Task 2: Prompt builder

**Files:**
- Create: `backend/prompt.py`
- Create: `backend/tests/test_prompt.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_prompt.py`:

```python
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
    # Only the first 30 selectors should appear
    assert "#f29" in turn
    assert "#f30" not in turn
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
pytest tests/test_prompt.py -v
```

Expected: `ImportError` — `prompt` module doesn't exist.

- [ ] **Step 3: Create `backend/prompt.py`**

```python
import json
from models import DomElement, HistoryEntry

SYSTEM_PROMPT = """You are Lumineer, a patient and friendly assistant helping elderly people use the internet.
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend
pytest tests/test_prompt.py -v
```

Expected: all 4 tests `PASSED`.

- [ ] **Step 5: Commit**

```bash
git add backend/prompt.py backend/tests/test_prompt.py
git commit -m "feat: prompt builder with DOM map serialization"
```

---

## Task 3: Ollama client (JSON extraction + retry logic)

**Files:**
- Create: `backend/ollama_client.py`
- Create: `backend/tests/test_ollama_client.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_ollama_client.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from ollama_client import extract_json, call_ollama, OllamaUnavailableError
from models import DomElement, HistoryEntry


def test_extract_json_clean_response():
    raw = '{"instruction": "Click Next", "element_label": "Next", "selector": "button.next"}'
    result = extract_json(raw)
    assert result["instruction"] == "Click Next"
    assert result["selector"] == "button.next"


def test_extract_json_with_surrounding_prose():
    raw = 'Sure! Here you go:\n```json\n{"instruction": "Click Next", "element_label": "Next", "selector": "button.next"}\n```'
    result = extract_json(raw)
    assert result["instruction"] == "Click Next"


def test_extract_json_raises_on_no_json():
    with pytest.raises(ValueError, match="No valid JSON"):
        extract_json("I cannot help with that.")


def test_extract_json_null_selector():
    raw = '{"instruction": "You are done!", "element_label": null, "selector": null}'
    result = extract_json(raw)
    assert result["selector"] is None


@pytest.mark.asyncio
async def test_call_ollama_returns_parsed_response():
    mock_response_body = {
        "response": '{"instruction": "Click Next", "element_label": "Next", "selector": "button.next"}'
    }
    with patch("ollama_client.httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_response_body
        mock_response.raise_for_status = lambda: None
        mock_client.post.return_value = mock_response

        elements = [DomElement(id=1, tag="button", type="submit", label="Next", selector="button.next", visible=True)]
        result = await call_ollama(screenshot_b64="abc123", elements=elements, history=[])

    assert result["instruction"] == "Click Next"
    assert result["selector"] == "button.next"


@pytest.mark.asyncio
async def test_call_ollama_raises_on_connection_error():
    import httpx
    with patch("ollama_client.httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client.post.side_effect = httpx.ConnectError("connection refused")

        elements = [DomElement(id=1, tag="button", type="submit", label="Next", selector="button.next", visible=True)]
        with pytest.raises(OllamaUnavailableError):
            await call_ollama(screenshot_b64="abc123", elements=elements, history=[])
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
pytest tests/test_ollama_client.py -v
```

Expected: `ImportError` — `ollama_client` doesn't exist.

- [ ] **Step 3: Create `backend/ollama_client.py`**

```python
import re
import json
import httpx
from models import DomElement, HistoryEntry
from prompt import build_system_prompt, build_user_turn

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "gemma4"


class OllamaUnavailableError(Exception):
    pass


def extract_json(raw: str) -> dict:
    """Extract the first JSON object from a raw string, ignoring surrounding prose."""
    # Try to find a JSON block (with or without markdown fences)
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError(f"No valid JSON found in response: {raw[:200]}")
    return json.loads(match.group())


async def call_ollama(
    screenshot_b64: str,
    elements: list[DomElement],
    history: list[HistoryEntry],
    retry: bool = True,
) -> dict:
    system = build_system_prompt()
    user_text = build_user_turn(elements, history)

    payload = {
        "model": MODEL,
        "system": system,
        "prompt": user_text,
        "images": [screenshot_b64],
        "stream": False,
        "format": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(OLLAMA_URL, json=payload)
            response.raise_for_status()
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.HTTPStatusError as e:
        raise OllamaUnavailableError(f"Ollama returned error: {e.response.status_code}")

    raw = response.json().get("response", "")

    try:
        return extract_json(raw)
    except (ValueError, json.JSONDecodeError):
        if retry:
            # Retry once with a stricter prompt appended
            payload["prompt"] += "\n\nYou MUST respond with ONLY the JSON object. No other text."
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(OLLAMA_URL, json=payload)
                response.raise_for_status()
            raw = response.json().get("response", "")
            try:
                return extract_json(raw)
            except (ValueError, json.JSONDecodeError):
                # Return instruction-only fallback
                return {"instruction": raw.strip(), "element_label": None, "selector": None}
        return {"instruction": raw.strip(), "element_label": None, "selector": None}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd backend
pytest tests/test_ollama_client.py -v
```

Expected: all 5 tests `PASSED`.

- [ ] **Step 5: Commit**

```bash
git add backend/ollama_client.py backend/tests/test_ollama_client.py
git commit -m "feat: ollama client with JSON extraction and retry logic"
```

---

## Task 4: `/analyze` endpoint

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_main.py`:

```python
import json
from unittest.mock import patch, AsyncMock
from models import AnalyzeRequest, DomElement


@pytest.mark.asyncio
async def test_analyze_returns_instruction_and_selector():
    mock_result = {
        "instruction": "Click the Next button to continue.",
        "element_label": "Next",
        "selector": "button.next-step",
    }
    with patch("main.call_ollama", new_callable=AsyncMock, return_value=mock_result):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "screenshot": "aGVsbG8=",
                "dom_map": [
                    {"id": 1, "tag": "button", "type": "submit", "label": "Next",
                     "selector": "button.next-step", "visible": True}
                ],
                "history": [],
            })
    assert response.status_code == 200
    data = response.json()
    assert data["instruction"] == "Click the Next button to continue."
    assert data["selector"] == "button.next-step"


@pytest.mark.asyncio
async def test_analyze_returns_503_when_ollama_unavailable():
    from ollama_client import OllamaUnavailableError
    with patch("main.call_ollama", new_callable=AsyncMock, side_effect=OllamaUnavailableError("not running")):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "screenshot": "aGVsbG8=",
                "dom_map": [],
                "history": [],
            })
    assert response.status_code == 503
    assert "offline" in response.json()["detail"].lower()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend
pytest tests/test_main.py -v
```

Expected: `FAILED` — `/analyze` route doesn't exist.

- [ ] **Step 3: Add `/analyze` to `backend/main.py`**

Replace the entire `main.py` with:

```python
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import AnalyzeRequest, AnalyzeResponse
from ollama_client import call_ollama, OllamaUnavailableError

app = FastAPI(title="Lumineer Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest):
    try:
        result = await call_ollama(
            screenshot_b64=request.screenshot,
            elements=request.dom_map,
            history=request.history,
        )
    except OllamaUnavailableError:
        raise HTTPException(status_code=503, detail="Lumineer is offline. Please make sure Ollama is running.")

    return AnalyzeResponse(
        instruction=result.get("instruction", "I couldn't figure out the next step. Try clicking 'Help me' again."),
        element_label=result.get("element_label"),
        selector=result.get("selector"),
    )
```

- [ ] **Step 4: Run all backend tests**

```bash
cd backend
pytest tests/ -v
```

Expected: all tests `PASSED`.

- [ ] **Step 5: Smoke-test the running server manually**

```bash
uvicorn main:app --port 8000
# In another terminal:
curl http://localhost:8000/health
```

Expected: `{"status":"ok"}`

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "feat: /analyze endpoint wired to ollama client"
```

---

## Task 5: Chrome extension manifest + background service worker

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`
- Create: `extension/assets/icon.png` (placeholder — any 128×128 PNG)

- [ ] **Step 1: Create `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Lumineer",
  "version": "1.0.0",
  "description": "AI browser co-pilot for seniors",
  "permissions": [
    "activeTab",
    "tabs",
    "scripting"
  ],
  "host_permissions": [
    "http://localhost:8000/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "128": "assets/icon.png"
    }
  },
  "icons": {
    "128": "assets/icon.png"
  }
}
```

- [ ] **Step 2: Create `extension/background.js`**

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CAPTURE') return;

  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }
    // dataUrl is "data:image/png;base64,<b64>" — strip the prefix
    const base64 = dataUrl.split(',')[1];
    sendResponse({ screenshot: base64 });
  });

  return true; // keep message channel open for async sendResponse
});
```

- [ ] **Step 3: Create a placeholder icon**

```bash
# Create a simple 128x128 orange PNG as a placeholder
python3 -c "
from PIL import Image, ImageDraw
img = Image.new('RGB', (128, 128), color='#FF6B35')
draw = ImageDraw.Draw(img)
draw.text((40, 50), 'G', fill='white')
img.save('extension/assets/icon.png')
" 2>/dev/null || \
# Fallback: download a generic icon if PIL not available
curl -sL "https://via.placeholder.com/128/FF6B35/FFFFFF?text=G" -o extension/assets/icon.png 2>/dev/null || \
# Final fallback: create a minimal valid PNG with Python stdlib
python3 -c "
import base64, os
os.makedirs('extension/assets', exist_ok=True)
# 1x1 orange pixel PNG, scaled up by Chrome
png_b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg=='
with open('extension/assets/icon.png', 'wb') as f:
    f.write(base64.b64decode(png_b64))
"
```

- [ ] **Step 4: Load the extension in Chrome to verify manifest is valid**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Verify Lumineer appears in the list with no errors
5. Open any webpage — no visible changes yet (content.js doesn't exist yet)

- [ ] **Step 5: Commit**

```bash
git add extension/
git commit -m "feat: extension manifest and background screenshot capture"
```

---

## Task 6: DOM serializer (`content.js` — part 1)

**Files:**
- Create: `extension/content.js` (DOM serializer only, no UI yet)

The DOM serializer is the most complex piece of `content.js`. Build and verify it in isolation before adding UI.

- [ ] **Step 1: Create `extension/content.js` with only the DOM serializer**

```javascript
// ─── DOM Serializer ───────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]';
const MAX_ELEMENTS = 30;

function getLabel(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.placeholder) return el.placeholder.trim();
  if (el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 60);
  // Look for an associated <label> element
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.innerText.trim();
  }
  return null;
}

function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  // Build a short path: tag + classes (first 2) + nth-of-type if needed
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
  const candidate = `${tag}${classes}`;
  // Verify uniqueness; if not unique, fall back to a positional selector
  if (document.querySelectorAll(candidate).length === 1) return candidate;
  // nth-of-type fallback within parent
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll(tag));
    const idx = siblings.indexOf(el) + 1;
    const parentSel = getSelector(parent);
    return `${parentSel} > ${tag}:nth-of-type(${idx})`;
  }
  return tag;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function buildDomMap() {
  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const map = [];
  let id = 1;

  for (const el of elements) {
    if (map.length >= MAX_ELEMENTS) break;
    const label = getLabel(el);
    if (!label && !el.id) continue; // skip unlabeled, unidentified elements
    map.push({
      id: id++,
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      label: label || el.id,
      selector: getSelector(el),
      visible: isVisible(el),
    });
  }

  return map;
}

// Expose for manual testing in devtools console during development
window.__lumineer_buildDomMap = buildDomMap;
```

- [ ] **Step 2: Reload the extension and verify the DOM serializer in DevTools**

1. Reload extension at `chrome://extensions` (click the refresh icon on Lumineer)
2. Navigate to any form page (e.g. `https://www.w3schools.com/html/html_forms.asp`)
3. Open DevTools Console and run:

```javascript
window.__lumineer_buildDomMap()
```

Expected: an array of objects with `id`, `tag`, `label`, `selector`, `visible` fields. Selectors should resolve correctly:

```javascript
// Verify each selector resolves
window.__lumineer_buildDomMap().forEach(el => {
  const found = document.querySelector(el.selector);
  console.log(el.label, '->', found ? '✓' : '✗ MISSING', el.selector);
});
```

All entries should log `✓`.

- [ ] **Step 3: Commit**

```bash
git add extension/content.js
git commit -m "feat: DOM serializer in content.js"
```

---

## Task 7: Extension UI — floating button + sidebar + highlight overlay (`content.js` — part 2)

**Files:**
- Modify: `extension/content.js`

- [ ] **Step 1: Append the UI code to `extension/content.js`**

Add the following after the DOM serializer section:

```javascript
// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
  #lumineer-btn {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483646;
    background: #FF6B35;
    color: white;
    border: none;
    border-radius: 28px;
    padding: 14px 22px;
    font-size: 16px;
    font-family: system-ui, sans-serif;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    transition: background 0.2s;
  }
  #lumineer-btn:hover { background: #e05a28; }
  #lumineer-btn:disabled { background: #aaa; cursor: not-allowed; }

  #lumineer-sidebar {
    position: fixed;
    top: 0;
    right: -360px;
    width: 340px;
    height: 100vh;
    z-index: 2147483645;
    background: white;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
    font-family: system-ui, sans-serif;
    transition: right 0.3s ease;
    display: flex;
    flex-direction: column;
    padding: 24px;
    box-sizing: border-box;
    overflow-y: auto;
  }
  #lumineer-sidebar.open { right: 0; }
  #lumineer-sidebar-title {
    font-size: 20px;
    font-weight: 700;
    color: #FF6B35;
    margin-bottom: 16px;
  }
  #lumineer-instruction {
    font-size: 18px;
    line-height: 1.6;
    color: #222;
    background: #FFF5F0;
    border-left: 4px solid #FF6B35;
    padding: 16px;
    border-radius: 8px;
    margin-bottom: 16px;
  }
  #lumineer-status {
    font-size: 14px;
    color: #888;
    margin-top: auto;
  }
  #lumineer-close {
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    font-size: 22px;
    cursor: pointer;
    color: #aaa;
  }

  @keyframes lumineer-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.5); }
    50%       { box-shadow: 0 0 0 8px rgba(255, 107, 53, 0); }
  }
  #lumineer-highlight {
    position: fixed;
    pointer-events: none;
    border: 3px solid #FF6B35;
    border-radius: 8px;
    z-index: 2147483647;
    animation: lumineer-pulse 1.2s ease-in-out infinite;
  }
`;

function injectStyles() {
  if (document.getElementById('lumineer-styles')) return;
  const style = document.createElement('style');
  style.id = 'lumineer-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// ─── Highlight Overlay ────────────────────────────────────────────────────────

function clearHighlight() {
  const existing = document.getElementById('lumineer-highlight');
  if (existing) existing.remove();
}

function highlightElement(selector) {
  clearHighlight();
  if (!selector) return;

  const el = document.querySelector(selector);
  if (!el) return;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Wait for scroll to settle before measuring position
  setTimeout(() => {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = 'lumineer-highlight';
    Object.assign(overlay.style, {
      top:    `${rect.top    - 4}px`,
      left:   `${rect.left  - 4}px`,
      width:  `${rect.width  + 8}px`,
      height: `${rect.height + 8}px`,
    });
    document.body.appendChild(overlay);
  }, 400);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function getOrCreateSidebar() {
  let sidebar = document.getElementById('lumineer-sidebar');
  if (sidebar) return sidebar;

  sidebar = document.createElement('div');
  sidebar.id = 'lumineer-sidebar';
  sidebar.innerHTML = `
    <button id="lumineer-close" title="Close">✕</button>
    <div id="lumineer-sidebar-title">Lumineer</div>
    <div id="lumineer-instruction"></div>
    <div id="lumineer-status"></div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById('lumineer-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
    clearHighlight();
  });

  return sidebar;
}

function showSidebar(instruction, status = '') {
  const sidebar = getOrCreateSidebar();
  document.getElementById('lumineer-instruction').textContent = instruction;
  document.getElementById('lumineer-status').textContent = status;
  sidebar.classList.add('open');
}

// ─── Help Button ──────────────────────────────────────────────────────────────

const history = [];

function getOrCreateButton() {
  let btn = document.getElementById('lumineer-btn');
  if (btn) return btn;

  btn = document.createElement('button');
  btn.id = 'lumineer-btn';
  btn.textContent = '💡 Help me';
  document.body.appendChild(btn);
  return btn;
}

async function onHelpClick() {
  const btn = document.getElementById('lumineer-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  clearHighlight();

  const domMap = buildDomMap();

  // Request screenshot from background service worker
  let screenshot;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
    if (response.error) throw new Error(response.error);
    screenshot = response.screenshot;
  } catch (err) {
    showSidebar('This page type isn\'t supported.');
    btn.disabled = false;
    btn.textContent = '💡 Help me';
    return;
  }

  // Call backend
  let data;
  try {
    const res = await fetch('http://localhost:8000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot, dom_map: domMap, history }),
    });
    if (res.status === 503) {
      showSidebar('Lumineer is offline. Please make sure Ollama is running.');
      btn.disabled = false;
      btn.textContent = '💡 Help me';
      return;
    }
    data = await res.json();
  } catch {
    showSidebar('Could not connect to Lumineer. Please start the backend.');
    btn.disabled = false;
    btn.textContent = '💡 Help me';
    return;
  }

  // Show result
  showSidebar(data.instruction);
  highlightElement(data.selector);

  // Add to history for follow-up context
  history.push({ role: 'assistant', content: data.instruction });
  // Keep only last 5 turns to avoid bloating the prompt
  if (history.length > 5) history.shift();

  btn.disabled = false;
  btn.textContent = '💡 Help me';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  injectStyles();
  const btn = getOrCreateButton();
  btn.addEventListener('click', onHelpClick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

- [ ] **Step 2: Reload the extension and verify the UI**

1. Reload extension at `chrome://extensions`
2. Navigate to any webpage (e.g. `https://example.com`)
3. Verify:
   - The orange "💡 Help me" button appears in the bottom-right corner
   - Clicking it changes text to "Thinking…" and attempts to call the backend
   - If backend is not running, sidebar slides open with the "Could not connect" error message
   - Clicking the ✕ button closes the sidebar

- [ ] **Step 3: Commit**

```bash
git add extension/content.js
git commit -m "feat: floating button, sidebar, and highlight overlay in content.js"
```

---

## Task 8: Extension popup

**Files:**
- Create: `extension/popup.html`
- Create: `extension/popup.js`

- [ ] **Step 1: Create `extension/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      width: 240px;
      padding: 20px;
      font-family: system-ui, sans-serif;
      margin: 0;
    }
    h1 { font-size: 20px; color: #FF6B35; margin: 0 0 8px; }
    p  { font-size: 13px; color: #555; margin: 0 0 16px; line-height: 1.5; }
    #status {
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #ccc;
      flex-shrink: 0;
    }
    #status-dot.online  { background: #2ecc71; }
    #status-dot.offline { background: #e74c3c; }
  </style>
</head>
<body>
  <h1>Lumineer</h1>
  <p>AI browser co-pilot for seniors.<br>Click <strong>💡 Help me</strong> on any page.</p>
  <div id="status">
    <div id="status-dot"></div>
    <span id="status-text">Checking backend…</span>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/popup.js`**

```javascript
async function checkBackend() {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  try {
    const res = await fetch('http://localhost:8000/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      dot.className  = 'online';
      text.textContent = 'Backend online ✓';
    } else {
      throw new Error('non-ok');
    }
  } catch {
    dot.className  = 'offline';
    text.textContent = 'Backend offline — start uvicorn';
  }
}

checkBackend();
```

- [ ] **Step 3: Reload the extension and verify the popup**

1. Reload extension at `chrome://extensions`
2. Click the Lumineer toolbar icon
3. Verify:
   - Popup opens with Lumineer title and description
   - With backend running (`uvicorn main:app --port 8000`): green dot + "Backend online ✓"
   - With backend not running: red dot + "Backend offline — start uvicorn"

- [ ] **Step 4: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat: extension popup with backend health indicator"
```

---

## Task 9: End-to-end integration test (with Ollama running)

This task verifies the full flow works with a real Ollama instance. Not automated — manual verification only.

**Prerequisites:**
- Ollama installed and running: `ollama serve`
- Model pulled: `ollama pull gemma4`
- Backend running: `cd backend && uvicorn main:app --port 8000`
- Extension loaded in Chrome

- [ ] **Step 1: Verify Ollama is responding**

```bash
curl -s http://localhost:11434/api/generate \
  -d '{"model":"gemma4","prompt":"Reply with only this JSON: {\"instruction\":\"test\",\"element_label\":null,\"selector\":null}","stream":false}' \
  | python3 -m json.tool
```

Expected: a response JSON with a `"response"` field containing valid JSON.

- [ ] **Step 2: Test the backend with a real screenshot**

Take any small PNG screenshot, encode it, and POST to `/analyze`:

```bash
# Encode any PNG to base64
B64=$(base64 -i /path/to/screenshot.png)

curl -s -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d "{
    \"screenshot\": \"$B64\",
    \"dom_map\": [{\"id\":1,\"tag\":\"button\",\"type\":\"submit\",\"label\":\"Submit\",\"selector\":\"button[type=submit]\",\"visible\":true}],
    \"history\": []
  }" | python3 -m json.tool
```

Expected: JSON with `instruction`, `element_label`, `selector` fields.

- [ ] **Step 3: Full browser flow**

1. Navigate to `https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit` (a simple HTML form)
2. Click "💡 Help me"
3. Verify:
   - Button shows "Thinking…" while waiting
   - Sidebar slides open with a plain-English instruction
   - An orange pulsing ring appears around the element Gemma identified
   - The ring wraps the element tightly (not a fixed 120×48px box)
4. Click "💡 Help me" again
5. Verify Gemma gives the next step (not repeating the first instruction — history is working)

- [ ] **Step 4: Test error states**

- Stop the backend → click "Help me" → verify sidebar shows "Could not connect to Lumineer. Please start the backend."
- Stop Ollama but keep backend running → click "Help me" → verify sidebar shows "Lumineer is offline. Please make sure Ollama is running."

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: end-to-end integration verified"
```

---

## Task 10: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# Lumineer

> AI browser co-pilot for seniors — local-first, powered by Gemma 4.

A Chrome extension that helps elderly users navigate any website by capturing a screenshot and reading the page's interactive elements, then using Gemma 4 (running locally via Ollama) to give one clear, plain-English instruction and highlight the exact element to interact with.

---

## Requirements

- macOS / Linux (Windows untested)
- Python 3.11+
- [Ollama](https://ollama.ai) installed
- Google Chrome

---

## Setup

### 1. Pull the model

```bash
ollama pull gemma4
```

### 2. Start the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000
```

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. The Lumineer icon will appear in your toolbar

### 4. Use it

Navigate to any webpage and click the orange **💡 Help me** button.

---

## Running tests

```bash
cd backend
source .venv/bin/activate
pytest tests/ -v
```

---

## Architecture

```
Chrome Extension (content.js + background.js)
  → POST /analyze (FastAPI, localhost:8000)
    → Ollama (gemma4, localhost:11434)
```

See `docs/superpowers/specs/2026-05-03-guidely-design.md` for the full design spec.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add setup and usage README"
```

---

## Self-Review Notes

**Spec coverage check:**

| Spec Section | Covered By |
|---|---|
| Floating "Help me" button | Task 7 |
| Screenshot via `captureVisibleTab` | Task 5 |
| DOM map serialization (≤30 elements, label priority) | Task 6 |
| FastAPI `/analyze` endpoint | Task 4 |
| System prompt + user turn builder | Task 2 |
| Ollama call + JSON extraction + retry | Task 3 |
| CSS selector resolution + highlight via `getBoundingClientRect` | Task 7 |
| `scrollIntoView` for off-screen elements | Task 7 |
| Conversation history (last 5 turns) | Task 7 |
| Error states (Ollama down, backend down, capture failure, null selector) | Tasks 4, 7, 8 |
| CORS for chrome-extension origins | Task 4 |
| Popup with health indicator | Task 8 |
| Pulsing ring animation | Task 7 |
| End-to-end smoke test | Task 9 |
| README / setup instructions | Task 10 |

No gaps found.
