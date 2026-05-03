# Guidely — Design Spec

**Date:** 2026-05-03  
**Hackathon:** Kaggle × Google DeepMind — Gemma 4 Good Hackathon  
**Deadline:** 2026-05-18  
**Prize Pool:** $200,000  

---

## 1. Problem Statement

Elderly users struggle to navigate the modern web — not because of low intelligence, but because of unfamiliar interfaces, confusing jargon, and fear of making irreversible mistakes. There is no patient, always-available guide that meets them where they are: on the page, in the moment.

Existing assistants require users to context-switch (open a new app, describe their problem in words). That is precisely what seniors find hardest.

---

## 2. Solution

**Guidely** is a local-first AI browser co-pilot for seniors delivered as a Chrome extension.

The user clicks a single floating "Help me" button on any webpage. Guidely captures a screenshot of the current tab, sends it to a local AI backend powered by Gemma 4 (via Ollama), and returns a plain-English instruction — one step at a time — alongside a visual highlight ring drawn directly on the element the user needs to interact with.

Everything runs on-device. No data leaves the user's machine.

**Positioning:** "An AI that teaches seniors how to use the internet, as they use it."

---

## 3. Hackathon Fit

| Judging Criterion | How Guidely Addresses It |
|---|---|
| **Impact (30%)** | Targets 1B+ elderly internet users globally; solves a universal, high-stakes pain point (forms, logins, payments, healthcare bookings) |
| **Technical Execution (30%)** | Gemma 4 multimodal reasoning over screenshot + DOM map; CSS selector-based pixel-perfect element targeting; structured JSON output; local-first architecture |
| **Communication (40%)** | Clean, demo-friendly flow; single button → screenshot → highlight + instruction; emotionally resonant framing around privacy and dignity |

**Gemma 4 capabilities used:**
- Multimodal input (screenshot understanding)
- Structured reasoning over DOM element map + visual context
- Instruction following (structured JSON output with CSS selector targeting)
- Local deployment via Ollama (privacy guarantee)

---

## 4. Architecture

### 4.1 Components

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                   │
│                                                     │
│  background.js     content.js        popup.html     │
│  (screenshot)   (sidebar + overlay)  (status/brand) │
└────────────────────┬────────────────────────────────┘
                     │ HTTP POST localhost:8000/analyze
                     ▼
┌─────────────────────────────────────────────────────┐
│              FastAPI Backend (Python)               │
│                                                     │
│  POST /analyze                                      │
│  • builds structured prompt                         │
│  • calls Ollama                                     │
│  • parses + validates JSON response                 │
│  • returns clean { instruction, element, position } │
└────────────────────┬────────────────────────────────┘
                     │ HTTP POST localhost:11434/api/generate
                     ▼
┌─────────────────────────────────────────────────────┐
│                  Ollama (local)                     │
│                  Model: gemma4                      │
│                  (all inference on-device)          │
└─────────────────────────────────────────────────────┘
```

### 4.2 Chrome Extension

**Manifest V3.** Three files with distinct responsibilities:

**`background.js`** (service worker)
- Listens for a message from `content.js` requesting a screenshot
- Calls `chrome.tabs.captureVisibleTab()` → returns base64-encoded PNG
- Forwards the base64 image back to `content.js`

**`content.js`** (injected into every page)
- Renders a floating "Help me" button (bottom-right corner, always visible)
- On click: serializes interactive DOM elements into a compact element map (see Section 5.1), requests screenshot from `background.js`, then POSTs `{ screenshot, dom_map, history }` to `localhost:8000/analyze`
- On response: renders the instruction in a right-side sliding sidebar panel
- Uses `document.querySelector(selector)` with the returned CSS selector to find the target element; calls `getBoundingClientRect()` to size and position the highlight ring exactly over it; calls `scrollIntoView()` if the element is off-screen
- Maintains a conversation history array (last N turns) passed on each request to support follow-up context
- Clears the highlight on the next "Help me" click

**`popup.html`**
- Minimal: Guidely logo, status indicator (backend reachable / offline), version number

### 4.3 FastAPI Backend

**Language:** Python 3.11+  
**Framework:** FastAPI  
**Single endpoint:** `POST /analyze`

**Request body:**
```json
{
  "screenshot": "<base64-encoded PNG>",
  "dom_map": [
    { "id": 1, "tag": "input", "type": "text", "label": "First Name", "selector": "#fname", "visible": true },
    { "id": 2, "tag": "button", "type": "submit", "label": "Next", "selector": "button.next-step", "visible": true }
  ],
  "history": [
    { "role": "assistant", "content": "Type your first name in the 'First Name' box." }
  ]
}
```

**Response body:**
```json
{
  "instruction": "Click the blue 'Next' button to continue.",
  "element_label": "Next button",
  "selector": "button.next-step"
}
```

**Processing steps:**
1. Decode base64 screenshot
2. Build prompt with screenshot + serialized DOM map (see Section 5)
3. POST to `http://localhost:11434/api/generate` with model `gemma4`, stream: false
4. Extract JSON block from Gemma's response using regex
5. Validate that `instruction` and `selector` are present
6. Return parsed response to extension

**CORS:** Allow `chrome-extension://` origins.

### 4.4 Ollama

- Runs locally, model pulled once: `ollama pull gemma4`
- Backend calls `http://localhost:11434/api/generate`
- No internet dependency at inference time
- Recommended minimum hardware: 16GB RAM, Apple Silicon or NVIDIA GPU

---

## 5. Prompt Design

The system prompt instructs Gemma to behave as a patient digital guide for an elderly user. It receives both the screenshot (visual context) and a serialized DOM element map (structured context). It must respond **only** with valid JSON — no prose outside the JSON block.

### 5.1 DOM Map Serialization

`content.js` builds the DOM map before each request by querying all interactive elements:

```javascript
const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [tabindex]';
document.querySelectorAll(INTERACTIVE)
```

For each element, it captures:
- `tag` — element type (input, button, a, select, etc.)
- `type` — input type if applicable (text, email, password, submit, etc.)
- `label` — derived from `aria-label`, `placeholder`, `innerText`, or associated `<label>` element (in that order)
- `selector` — a unique CSS selector (prefer `#id`, fall back to a short stable path)
- `visible` — true if the element is in the viewport and not hidden

Elements with no discernible label and no ID are skipped. The map is capped at 30 elements to keep the prompt token-efficient.

### 5.2 System Prompt

```
You are Guidely, a patient and friendly assistant helping elderly people use the internet.
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
Do not include any text outside the JSON block.
```

### 5.3 User Turn

```
Here is the current page. What should I do next?

Interactive elements on the page:
[serialized DOM map as JSON array]

[screenshot attached as base64 image]
```

For follow-up turns, prior assistant instructions are prepended as conversation history so Gemma guides sequentially without repeating steps already completed.

---

## 6. Data Flow (end-to-end)

```
1.  User clicks "Help me" floating button
2.  content.js serializes interactive DOM elements → dom_map (up to 30 elements)
3.  content.js sends message to background.js: { type: "CAPTURE" }
4.  background.js calls chrome.tabs.captureVisibleTab() → base64 PNG
5.  background.js replies to content.js with { screenshot: "<base64>" }
6.  content.js POSTs { screenshot, dom_map, history } to http://localhost:8000/analyze
7.  FastAPI backend constructs prompt (screenshot + dom_map), calls Ollama
8.  Gemma 4 returns JSON: { instruction, element_label, selector }
9.  FastAPI validates and returns JSON to extension
10. content.js displays instruction in sidebar
11. content.js calls document.querySelector(selector) → finds the exact DOM element
12. content.js calls element.scrollIntoView() if element is off-screen
13. content.js reads element.getBoundingClientRect() → sizes and positions highlight ring exactly
14. Pulsing ring is rendered over the element; does not interfere with clicks (pointer-events: none)
```

---

## 7. Error Handling

| Failure Scenario | Behavior |
|---|---|
| Ollama not running | Backend returns `503`; extension shows "Guidely is offline. Please make sure Ollama is running." |
| Gemma returns malformed JSON | Backend retries once with a stricter prompt ("You must respond with ONLY the JSON object, nothing else."); on second failure returns `{ instruction: <raw text>, element_label: null, selector: null }` — sidebar shows instruction only, no highlight |
| Gemma returns a selector not in the dom_map | `content.js` attempts `document.querySelector(selector)` anyway; if it returns null, highlight is skipped and instruction-only is shown |
| Screenshot capture fails (PDF, `chrome://` page, etc.) | `background.js` catches the error; extension shows "This page type isn't supported." |
| Backend unreachable (not started) | `content.js` fetch timeout/error; extension shows "Could not connect to Guidely. Please start the backend." |
| `selector` is null | Sidebar shows instruction; highlight overlay is not rendered |

---

## 8. File Structure

```
guidely/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── assets/
│       └── icon.png
├── backend/
│   ├── main.py           # FastAPI app, /analyze endpoint
│   ├── prompt.py         # System prompt construction
│   ├── ollama_client.py  # Ollama API calls + response parsing
│   └── requirements.txt
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-05-03-guidely-design.md
└── README.md
```

---

## 9. Highlight Overlay Implementation

The highlight is a `<div>` injected into the page body. Its size and position are derived from the target element's `getBoundingClientRect()`, so it wraps the element exactly regardless of its dimensions.

```javascript
const rect = element.getBoundingClientRect();
const overlay = document.createElement('div');
overlay.id = 'guidely-highlight';
Object.assign(overlay.style, {
  position: 'fixed',
  top:    `${rect.top    - 4}px`,
  left:   `${rect.left   - 4}px`,
  width:  `${rect.width  + 8}px`,
  height: `${rect.height + 8}px`,
  border: '3px solid #FF6B35',   /* warm orange — visible, not alarming */
  borderRadius: '8px',
  pointerEvents: 'none',         /* doesn't interfere with clicks */
  animation: 'guidely-pulse 1.2s ease-in-out infinite',
  zIndex: '2147483647',          /* always on top */
});
document.body.appendChild(overlay);
```

The 4px padding on each side prevents the ring from sitting flush against the element's edge. On the next "Help me" click, the overlay is removed and redrawn on the new target.

---

## 10. Out of Scope (this hackathon)

- Voice input or text-to-speech output
- Multilingual support
- Continuous/proactive monitoring mode
- User accounts, settings persistence, or onboarding flow
- Cloud deployment or remote model hosting
- Automatic form-filling or DOM mutation on behalf of the user
- Mobile browser support

---

## 11. Setup & Run (for demo/judges)

```bash
# 1. Pull the model
ollama pull gemma4

# 2. Start the backend
cd backend
pip install -r requirements.txt
uvicorn main:app --port 8000

# 3. Load the extension
# Open chrome://extensions → Enable Developer Mode → Load Unpacked → select /extension

# 4. Visit any webpage, click the "Help me" button
```

---

## 12. Demo Script (for video submission)

1. Open a Medicare enrollment form (or similar government form)
2. Click "Help me"
3. Guidely highlights the first name field: *"Type your first name in the box that says 'First Name' — it's near the top of the page."*
4. User fills it in, clicks "Help me" again
5. Guidely moves to next field, highlights it
6. Repeat through form completion
7. Final step: Guidely highlights the submit button: *"You're almost done. Click the green 'Submit' button to send your form."*

This demo hits: form guidance, highlight accuracy, step-by-step patience, and the emotional payoff of completion.
