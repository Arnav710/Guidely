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
| **Technical Execution (30%)** | Gemma 4 multimodal reasoning for spatial element detection; structured JSON output; local-first architecture |
| **Communication (40%)** | Clean, demo-friendly flow; single button → screenshot → highlight + instruction; emotionally resonant framing around privacy and dignity |

**Gemma 4 capabilities used:**
- Multimodal input (screenshot understanding)
- Spatial reasoning (element coordinate estimation)
- Instruction following (structured JSON output)
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
- On click: requests screenshot from `background.js`, then POSTs `{ screenshot, history }` to `localhost:8000/analyze`
- On response: renders the instruction in a right-side sliding sidebar panel
- Renders a highlight overlay `<div>` absolutely positioned at `(x * window.innerWidth, y * window.innerHeight)` with a pulsing CSS ring animation
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
  "history": [
    { "role": "assistant", "content": "Click the blue Sign In button" }
  ]
}
```

**Response body:**
```json
{
  "instruction": "Click the blue 'Next' button to continue",
  "element_label": "Next button",
  "position": { "x": 0.82, "y": 0.91 }
}
```

**Processing steps:**
1. Decode base64 screenshot
2. Build prompt (see Section 5)
3. POST to `http://localhost:11434/api/generate` with model `gemma4`, stream: false
4. Extract JSON block from Gemma's response using regex
5. Validate all required fields are present
6. Return parsed response to extension

**CORS:** Allow `chrome-extension://` origins.

### 4.4 Ollama

- Runs locally, model pulled once: `ollama pull gemma4`
- Backend calls `http://localhost:11434/api/generate`
- No internet dependency at inference time
- Recommended minimum hardware: 16GB RAM, Apple Silicon or NVIDIA GPU

---

## 5. Prompt Design

The system prompt instructs Gemma to behave as a patient digital guide for an elderly user. It must respond **only** with valid JSON matching the schema below — no prose outside the JSON block.

**System prompt:**
```
You are Guidely, a patient and friendly assistant helping elderly people use the internet.
You are given a screenshot of a webpage the user is currently viewing.
Your job is to give them ONE clear, simple next step — written in plain English with no jargon.
Speak as if explaining to someone who has never used a computer before.
Be warm, calm, and encouraging.

You MUST respond with ONLY valid JSON in this exact format:
{
  "instruction": "<one sentence telling the user what to do next>",
  "element_label": "<name/description of the UI element they should interact with>",
  "position": { "x": <0.0 to 1.0>, "y": <0.0 to 1.0> }
}

The x and y values are the normalized screen coordinates (0,0 = top-left, 1,1 = bottom-right)
of the center of the element the user should interact with.
If there is no specific element to interact with (e.g. you are just providing information),
set position to { "x": 0.5, "y": 0.5 }.

Do not include any text outside the JSON block.
```

**User turn:**
```
Here is a screenshot of the webpage I am looking at. What should I do next?
[base64 image attached]
```

For follow-up turns, prior assistant responses are prepended as conversation history so Gemma can guide sequentially without repeating itself.

---

## 6. Data Flow (end-to-end)

```
1. User clicks "Help me" floating button
2. content.js sends message to background.js: { type: "CAPTURE" }
3. background.js calls chrome.tabs.captureVisibleTab() → base64 PNG
4. background.js replies to content.js with { screenshot: "<base64>" }
5. content.js POSTs { screenshot, history } to http://localhost:8000/analyze
6. FastAPI backend constructs prompt, calls Ollama
7. Gemma 4 returns JSON: { instruction, element_label, position }
8. FastAPI validates and returns JSON to extension
9. content.js displays instruction in sidebar
10. content.js draws pulsing highlight ring at (position.x * innerWidth, position.y * innerHeight)
```

---

## 7. Error Handling

| Failure Scenario | Behavior |
|---|---|
| Ollama not running | Backend returns `503`; extension shows "Guidely is offline. Please make sure Ollama is running." |
| Gemma returns malformed JSON | Backend retries once with a stricter prompt ("You must respond with ONLY the JSON object, nothing else."); on second failure returns `{ instruction: <raw text>, element_label: null, position: null }` — sidebar shows instruction only, no highlight |
| Screenshot capture fails (PDF, `chrome://` page, etc.) | `background.js` catches the error; extension shows "This page type isn't supported." |
| Backend unreachable (not started) | `content.js` fetch timeout/error; extension shows "Could not connect to Guidely. Please start the backend." |
| `position` is null or out of range | Sidebar shows instruction; highlight overlay is not rendered |

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

The highlight is a `<div>` injected into the page body with:

```css
position: fixed;
pointer-events: none;          /* doesn't interfere with clicks */
border: 3px solid #FF6B35;     /* warm orange — visible, not alarming */
border-radius: 8px;
width: 120px;
height: 48px;
transform: translate(-50%, -50%);
animation: guidely-pulse 1.2s ease-in-out infinite;
z-index: 2147483647;           /* always on top */
```

Positioned at `left: position.x * 100vw`, `top: position.y * 100vh`. Since Gemma estimates the center of the element, the `translate(-50%, -50%)` centers the ring on that point.

The fixed size (120×48px) is intentional — most interactive elements (buttons, inputs, links) fit within this box, and an approximate ring is more helpful than no ring.

---

## 10. Out of Scope (this hackathon)

- Voice input or text-to-speech output
- Multilingual support
- Continuous/proactive monitoring mode
- User accounts, settings persistence, or onboarding flow
- Cloud deployment or remote model hosting
- DOM parsing or accessibility tree traversal (coordinate-based targeting only)
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
