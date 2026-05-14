# Lumineer — Design Spec

**Date:** 2026-05-03 (revised 2026-05-06)  
**Hackathon:** Kaggle × Google DeepMind — Gemma 4 Good Hackathon  
**Deadline:** 2026-05-18  
**Prize Pool:** $200,000  

> **Revision 2026-05-06 — major scope expansion.** Adds 8 named feature modules (persistent memory, page understanding, guided navigation, voice, vigilance/scam detection, assisted workflows, plain-language explainer, document & camera understanding). The single-shot "Help me" interaction is upgraded to a **persistent conversational agent** modeled after the Cursor IDE agent sidebar: a chat thread that survives page reloads, navigations, and browser restarts, and can drive a user end-to-end through a multi-page workflow (e.g., "renew my driver's license"). See §13 for the canonical feature list and §14 for the persistent memory + workflow architecture.

---

## 1. Problem Statement

Elderly users struggle to navigate the modern web — not because of low intelligence, but because of unfamiliar interfaces, confusing jargon, and fear of making irreversible mistakes. There is no patient, always-available guide that meets them where they are: on the page, in the moment.

Existing assistants require users to context-switch (open a new app, describe their problem in words). That is precisely what seniors find hardest. They also forget where they left off the moment the page reloads — which is exactly when they most need their guide to remember.

The next layer of the problem: confusing real-world artifacts (credit-card statements, insurance letters, Medicare paperwork, prescription bottles, scammy emails) extend the same fear and confusion off-screen. A useful senior co-pilot must read both the **screen** and the **paper** the user is holding, and stay with them through an entire end-to-end task — not just one click.

---

## 2. Solution

**Lumineer** (codename **CareScout**) is a local-first AI browser co-pilot for seniors delivered as a Chrome extension.

The user clicks a floating "Help me" button on any webpage and is greeted by a **persistent conversational sidebar** — a chat thread that behaves like the Cursor IDE agent panel. The thread survives page reloads, tab navigation, and browser restarts; it is only cleared when the user explicitly clears it. Every message captures the current page (DOM map + screenshot) so the same conversation can guide the user across many pages of a single real-world workflow ("renew my license", "appeal a denied claim", "set up Medicare Part D").

Lumineer speaks plain English, optionally aloud. It highlights the next button or field directly on the page. It can read documents through the user's webcam (a prescription bottle, a bill, an insurance card). It watches passively for scam patterns (urgent payment language, lookalike domains, gift-card / wire-transfer asks) and warns the user *before* they click. The user chooses how active they want it: explain only, highlight only, or fill-and-confirm.

Everything runs on-device via Ollama + Gemma 4. No screenshots, no documents, and no chat history ever leave the user's machine.

**Positioning:** "An AI that teaches seniors how to use the internet, as they use it — and sticks with them until the task is done."

---

## 3. Hackathon Fit

| Judging Criterion | How Lumineer Addresses It |
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

### 4.1 Components (revised)

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Chrome Extension                            │
│                                                                      │
│  background.js     content.js                  popup.html / popup.js │
│  ─────────────     ──────────                  ──────────────────────│
│  • captureVisibleTab            modules/                             │
│  • mic / TTS bridge             ├── agent-sidebar.js   (Cursor-like) │
│  • alarms (vigilance ticks)     ├── conversation-store.js            │
│  • cross-tab broadcast          ├── workflow-runner.js               │
│                                 ├── voice.js          (Web Speech)   │
│                                 ├── vigilance.js      (regex+DOM)    │
│                                 ├── highlight.js                     │
│                                 ├── dom-map.js                       │
│                                 └── camera.js         (getUserMedia) │
│                                                                      │
│  ┌────────────────── chrome.storage.local ───────────────────────┐   │
│  │  conversations[], active_id, settings, vigilance flags, etc.  │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────┬──────────────────────────────┬─────────────┘
                          │ POST /analyze                │ POST /vigilance
                          │ POST /explain                │ POST /vision/doc
                          │ POST /workflow/*             │
                          ▼                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       FastAPI Backend (Python)                       │
│                                                                      │
│   routes/                       services/                            │
│   ├── analyze.py                ├── analyze.py        (orchestrator) │
│   ├── explain.py                ├── workflow.py       (state machine)│
│   ├── workflow.py               ├── vigilance.py      (fast detect)  │
│   ├── vigilance.py              └── explain.py        (plain-lang)   │
│   └── vision.py                                                      │
│                                 prompt/  models.py  ollama_client.py │
│                                                                      │
│   Optional dev cache: Redis 7 (Docker, OFF by default)               │
│   — cross-tab workflow state, only when client owns insufficient     │
│     context. Redis is NEVER the source of truth for chat history.    │
└─────────────────────────┬────────────────────────────────────────────┘
                          │ POST localhost:11434/api/generate
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           Ollama (local)                             │
│   Two-tier model use:                                                │
│   • Gemma 4  e2b/2b   — fast detector (vigilance triage, intent)     │
│   • Gemma 4  e4b/26b  — deep reasoning (instructions, explanations)  │
└──────────────────────────────────────────────────────────────────────┘
```

The extension is **the source of truth** for chat history. The backend stays stateless on the chat-history axis — every request carries its own `conversation_id` + recent turns. The optional Redis cache is for *workflow execution metadata* only (see §14.4). This preserves the local-first guarantee: if you uninstall the backend, your conversations remain on your own machine in `chrome.storage.local`.

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
- Minimal: Lumineer logo, status indicator (backend reachable / offline), version number

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
You are Lumineer, a patient and friendly assistant helping elderly people use the internet.
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
| Ollama not running | Backend returns `503`; extension shows "Lumineer is offline. Please make sure Ollama is running." |
| Gemma returns malformed JSON | Backend retries once with a stricter prompt ("You must respond with ONLY the JSON object, nothing else."); on second failure returns `{ instruction: <raw text>, element_label: null, selector: null }` — sidebar shows instruction only, no highlight |
| Gemma returns a selector not in the dom_map | `content.js` attempts `document.querySelector(selector)` anyway; if it returns null, highlight is skipped and instruction-only is shown |
| Screenshot capture fails (PDF, `chrome://` page, etc.) | `background.js` catches the error; extension shows "This page type isn't supported." |
| Backend unreachable (not started) | `content.js` fetch timeout/error; extension shows "Could not connect to Lumineer. Please start the backend." |
| `selector` is null | Sidebar shows instruction; highlight overlay is not rendered |

---

## 8. File Structure

```
Guidely/
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
overlay.id = 'lumineer-highlight';
Object.assign(overlay.style, {
  position: 'fixed',
  top:    `${rect.top    - 4}px`,
  left:   `${rect.left   - 4}px`,
  width:  `${rect.width  + 8}px`,
  height: `${rect.height + 8}px`,
  border: '3px solid #FF6B35',   /* warm orange — visible, not alarming */
  borderRadius: '8px',
  pointerEvents: 'none',         /* doesn't interfere with clicks */
  animation: 'lumineer-pulse 1.2s ease-in-out infinite',
  zIndex: '2147483647',          /* always on top */
});
document.body.appendChild(overlay);
```

The 4px padding on each side prevents the ring from sitting flush against the element's edge. On the next "Help me" click, the overlay is removed and redrawn on the new target.

---

## 10. Scope (revised 2026-05-06)

### 10.1 In scope (this hackathon)

- All 8 feature modules in §13 — at minimum a credible vertical slice of each.
- Persistent conversational sidebar with `chrome.storage.local`-backed history (§14).
- End-to-end workflow guidance for at least one canonical workflow ("renew driver's license") that survives page reloads and navigations.
- Voice in/out via the browser's Web Speech API (no third-party voice cloud).
- Vigilance / scam-pattern detection running on every navigation and DOM mutation, with a fast Gemma 4 e2b explanation when triggered.
- Plain-language explainer mode for credit-card statements, insurance letters, Medicare paperwork, prescription labels.
- Webcam document understanding (prescription, bill, insurance card) via Gemma 4 multimodal.
- Assisted-workflow levels 0–2 (explain / highlight / fill-and-ask). Level 3 (autonomous click) remains explicit-confirm only.

### 10.2 Out of scope (this hackathon)

- Multilingual support beyond English (string table is i18n-ready; translations deferred).
- Mobile browsers (Chrome desktop only).
- Cloud deployment or remote model hosting.
- Phone-call audio listening — the user-suggested "listen to my phone call" feature is **explicitly deferred** for legal-consent and platform-permission reasons (Chrome can't tap system audio without an OS-level helper). We support voice *to/from* Lumineer only; we do not record phone calls.
- Cross-device sync.
- Automatic actions without confirmation (Level 3 autonomy is gated behind a setting and a per-action prompt).
- User accounts; everything is single-user, single-machine.

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
3. Lumineer highlights the first name field: *"Type your first name in the box that says 'First Name' — it's near the top of the page."*
4. User fills it in, clicks "Help me" again
5. Lumineer moves to next field, highlights it
6. Repeat through form completion
7. Final step: Lumineer highlights the submit button: *"You're almost done. Click the green 'Submit' button to send your form."*

This demo hits: form guidance, highlight accuracy, step-by-step patience, and the emotional payoff of completion.

### 12.1 Revised "hero" demo (2026-05-06)

A single 90-second demo that shows every feature module:

1. **Open** a fake state-DMV homepage. The persistent **agent sidebar** is empty.
2. User types: *"Help me renew my driver's license."* → Lumineer (Level 1, "highlight only") replies with a 4-step plan and **highlights** the "Renew Online" link.
3. User clicks; page navigates. Sidebar **survives the navigation** with the full thread + plan visible. Step 1 is now ✓.
4. On the renewal form, user clicks the mic — speaks: *"What does 'Class C endorsement' mean?"* Lumineer **explains in plain English**, aloud.
5. The form contains a phishy "Pay $4.99 service fee at this gift-card portal" cross-link. **Vigilance Mode** flashes a calm warning before the user clicks.
6. User asks: *"Read this for me bro,"* and points the webcam at their old license. **Camera understanding** extracts name, DOB, license number, and offers to fill the form — *"Shall I fill these in or shall I guide you?"*
7. User says "Fill them in but ask before submitting." Lumineer fills the form (Level 2), highlights submit, and asks one final confirmation. User says yes; submission complete. Step 4 ✓.
8. User reloads the tab to test memory. Sidebar comes back with the entire thread + completed plan, with a "Conversation complete — clear?" prompt.

Every one of the 8 feature modules appears. Total runtime ~90 s.

---

## 13. Feature Modules (canonical list)

The product surface is decomposed into **8 feature modules**. Each module has a clear owner directory in the codebase, a single FastAPI route family (where applicable), and an explicit demo beat.

| # | Module | Backend service | Extension module | Demo beat |
|---|---|---|---|---|
| F1 | **Local Conversation Memory** | none (stateless) | `modules/conversation-store.js`, `modules/agent-sidebar.js` | Reload page → thread persists |
| F2 | **Webpage Understanding Engine** | `services/analyze.py` | `modules/dom-map.js` + screenshot | "What is this page asking me?" |
| F3 | **Guided Web Navigation** | `services/analyze.py` (selector output) | `modules/highlight.js` | Pulsing ring on next button |
| F4 | **Voice Interaction Layer** | none (in-browser Web Speech) | `modules/voice.js` | Mic button + speak responses |
| F5 | **Vigilance Mode** | `services/vigilance.py` (fast Gemma 2B) | `modules/vigilance.js` (regex + DOM scan + onNavigate) | Phishing link warning before click |
| F6 | **Assisted Workflow Mode** | `services/workflow.py` (state machine) | `modules/workflow-runner.js` | Level chooser + multi-step plan ✓ list |
| F7 | **Senior-Friendly Explainer** | `services/explain.py` (text-only fast path) | reuses sidebar; "Explain like I'm 80" button | Insurance letter → plain English |
| F8 | **Document & Camera Understanding** | `services/vision.py` (multimodal) | `modules/camera.js` | Read prescription bottle through webcam |

### 13.1 Module details

**F1 — Local Conversation Memory.** See §14. The chat thread is the user's main interface and *must* survive reloads, navigations, and browser restarts. Stored in `chrome.storage.local`. Each conversation has an id, title, message log, and optional `workflow` block.

**F2 — Webpage Understanding Engine.** Existing `analyze` pipeline. Sends DOM map (interactive elements) + screenshot to Gemma 4. Returns plain-English summary + next-step instruction + selector. Already implemented; this module is the foundation everything else builds on.

**F3 — Guided Web Navigation.** Pulsing orange ring drawn over the element identified by selector + element label. Already implemented in `content.js`; promoted to its own module under `modules/highlight.js` with these new requirements:

- A "next step" indicator floats next to the highlight with the instruction text (compact mode for elderly users with poor vision).
- ESC key clears the highlight; clicking the highlighted element clears it automatically.
- Pulses are pausable for users who find motion uncomfortable (accessibility setting).

**F4 — Voice Interaction Layer.** Built on the browser's `SpeechRecognition` (input) and `SpeechSynthesis` (output). Privacy-critical:

- Mic is **off by default**. A clearly labelled button toggles it.
- Wake-word ("Hey Lumineer") is *opt-in only*; default is push-to-talk.
- Visual indicator any time the mic is hot.
- **Hard out-of-scope:** listening to phone calls, recording other applications. Web Speech can only access the browser's mic stream. Chrome cannot legally tap system audio in MV3 without an OS helper, and recording phone conversations has wiretap-law implications. We do not implement it.

**F5 — Vigilance Mode.** Three layers, cheapest first:

1. **Regex / heuristic layer** (no LLM): scammy URL patterns (`paypa1.com`, punycode lookalikes, IDN homographs, `bit.ly` short links pointing to login pages, embedded "click here to win"), urgent-payment language ("verify your account in 24 hours"), gift-card / wire / OTP asks, fake support phone numbers.
2. **Gemma 4 e2b fast triage** when (1) hits: a 2-3 second call returning `{ risk: "low" | "medium" | "high", reason: string }`.
3. **Gemma 4 e4b deep explanation** only on `high` risk: a longer reply explaining *why* in senior-friendly terms with a calm "you can ignore this and close the tab" recommendation.

Vigilance runs on every `chrome.webNavigation.onCompleted`, every `MutationObserver` batch (debounced 800 ms), and on hover-over-link. Findings surface as a **non-blocking** warning chip near the suspicious element — never a modal.

**F6 — Assisted Workflow Mode.** See §15. Four levels of autonomy; level is per-conversation and switchable mid-thread.

**F7 — Senior-Friendly Explainer.** A reusable transformation: complex source text → plain-English summary in a fixed three-section format:

```
What this means:
Why:
What you should do:
```

Triggered by:
- Right-click selection → context menu "Explain like I'm 80".
- Sidebar shortcut button.
- Voice command: "explain this".
- Auto-suggested when Vigilance fires high-risk.

Backend: a stripped-down `/explain` endpoint that does *not* require a screenshot or DOM map — just text. Faster than `/analyze`.

**F8 — Document & Camera Understanding.** Two paths:

- **8A — Digital documents:** PDFs and inline images on the current page. Existing `/analyze` pipeline already handles screenshots; we add a "page area capture" tool so the user can lasso a region (e.g. a single cell of a credit-card statement table) instead of capturing the whole tab.
- **8B — Physical documents via webcam:** `getUserMedia({ video: true })`, single-frame capture on user gesture, sent as a base64 PNG to `/vision/doc`. Same Gemma 4 multimodal call, with a doc-specific system prompt that knows about prescription bottles, bill stubs, insurance cards, and Medicare letters. Permission for the camera is a separate, explicit prompt from the user — never auto-requested.

---

## 14. Persistent Conversation Memory (F1) — design

### 14.1 Goals

1. The right-side sidebar feels like the **Cursor IDE agent panel**: a list of past conversations + a focused thread for the current one.
2. A single conversation **survives** page reloads, tab navigation, and browser restarts.
3. A conversation **only ends when the user explicitly clears or archives it** — not on close, not on tab change.
4. A conversation can span **many URLs** (the DMV homepage, the renewal form, the payment page, the confirmation email opened in another tab).
5. The user can have **multiple concurrent conversations** (e.g., "renew license" *and* "explain my insurance bill") and switch between them.
6. Storage stays **local-first**: zero server-side persistence by default.

### 14.2 Storage choice: why `chrome.storage.local`, not Redis (yet)

The user proposed Redis-on-Docker for dev. We considered Redis, SQLite, IndexedDB, and `chrome.storage.local`. Decision: **`chrome.storage.local` is the primary store for chat history; Redis is opt-in for server-side workflow caching only.**

| Option | Verdict | Why |
|---|---|---|
| **`chrome.storage.local`** ✅ chosen primary | Built into MV3. Persists to disk. Survives reloads/restarts. ~10 MB quota; can request `unlimitedStorage`. Zero infra. Available to background, content, and popup. Local-first by definition. | Best fit for "remember chat across reloads." |
| **IndexedDB** ⚠️ secondary | Larger quota, async API. Use only if conversations grow past `chrome.storage.local` quota (e.g. screenshots stored inline). | Defer until needed; we don't store screenshots in history. |
| **SQLite (file via backend)** ❌ | Simpler than Redis, but moves source of truth off the client. Adds a backend dependency for what is fundamentally browser state. | Conflicts with local-first goal. |
| **Redis on Docker** ⚠️ optional, server-side | Excellent for sub-ms session lookup with TTL — but overkill for a single-user, single-machine product. Adds Docker as a hard dep, a network surface, and a port (6379). | **Use only as a workflow execution cache** (§14.4), not the chat store. |

If we later add **cross-device sync** or **server-driven workflow agents**, Redis becomes the right layer to add. Until then, the simpler answer wins.

### 14.3 Schema

Stored at `chrome.storage.local["lumineer.v1"]`:

```ts
type Store = {
  schemaVersion: 1;
  activeConversationId: string | null;
  conversations: Record<string, Conversation>;
  settings: {
    autonomyLevel: 0 | 1 | 2 | 3;
    voiceEnabled: boolean;
    vigilanceEnabled: boolean;
    motionReduced: boolean;
    fontScale: 1 | 1.25 | 1.5;
  };
};

type Conversation = {
  id: string;                    // uuid v4
  title: string;                 // first user message, truncated; user-editable
  createdAt: number;             // epoch ms
  updatedAt: number;
  status: "active" | "archived"; // user can archive; we never auto-delete
  messages: Message[];
  workflow?: Workflow;           // present when this conversation is driving a workflow
  pages: PageVisit[];            // page-by-page log for context recall
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "vigilance";
  content: string;
  createdAt: number;
  pageUrl?: string;
  pageTitle?: string;
  // Screenshots are NEVER stored in conversation history (privacy + quota).
  // Only their reference metadata: dimensions, dom_element_count, ollama_elapsed_ms.
  trace?: Record<string, number | string | null>;
  // For assistant turns that proposed an action:
  suggestedSelector?: string;
  suggestedLabel?: string;
};

type PageVisit = {
  url: string;
  title: string;
  visitedAt: number;
  // Optional plain-text summary the model generated for this page; helps later turns
  // recall "what was on the form 3 pages back" without re-shipping every screenshot.
  summary?: string;
};

type Workflow = {
  goal: string;                  // "Renew California driver's license"
  steps: WorkflowStep[];
  currentStepIdx: number;
  startedAt: number;
  completedAt?: number;
};

type WorkflowStep = {
  id: string;
  description: string;           // "Sign in to mydmv.ca.gov"
  status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  evidence?: { url?: string; element?: string; note?: string };
};
```

### 14.4 Optional Redis cache (server-side, dev only)

When and only when Phase 5 (server-driven workflow agents) ships, we add a thin Redis layer:

- `redis:7-alpine` in a `docker-compose.yml`, **off by default**.
- Backend reads `LUMINEER_REDIS_URL` env var; if unset, all workflow logic runs in-memory per request (still works, just less efficient).
- Stores: workflow state machines keyed by `conversation_id`, model call cache for vigilance triage (TTL 1 hour), recent DOM-summary embeddings (TTL 24 h).
- **Never** stores raw chat content, screenshots, or PII. If Redis disappears, the client's `chrome.storage.local` fully reconstructs the conversation; only execution metadata is lost.

A `docker-compose.dev.yml` is added under `tools/redis/` for the day we need it; it is not started by default in setup instructions.

### 14.5 Persistence lifecycle

- **Page reload (same URL):** content script reinjects, reads `activeConversationId`, rehydrates the sidebar with full message log + workflow state. No backend call.
- **Navigation (new URL, same tab):** content script in the new page reads the active conversation, appends a `PageVisit` entry, and continues the same thread.
- **New tab / new window:** by default opens a *new* conversation. The user can pick an existing active conversation from the sidebar's conversation list (Cursor-style "Recent Chats").
- **Browser restart:** `chrome.storage.local` is durable; the same active conversation reappears.
- **Clear:** explicit user action. Two flavors: "Clear current chat" (archives the conversation; user can restore from Archived) and "Delete forever" (gone). Both require a confirm step.
- **Cross-tab live sync:** `chrome.storage.onChanged` events propagate updates from one tab's sidebar to another's in real time.

### 14.6 Sidebar UX (Cursor-agent-style)

```
┌─ Sidebar (380px wide, full height) ─────────────────────────┐
│  [💡 Lumineer]  [+] [🎤] [⚙]                              [✕]│
│  ─────────────────────────────────────────────────────────  │
│  Recent ▾                                                   │
│   • Renew driver's license     · 4 steps · 2 done           │
│   • Explain my dental bill                                  │
│   • Set up Medicare Part D     · archived                   │
│  ─────────────────────────────────────────────────────────  │
│  Plan: Renew driver's license                               │
│   ✓ Sign in to mydmv.ca.gov                                 │
│   ✓ Open "Renew Online"                                     │
│   ◉ Fill personal info form        ← you are here           │
│   ○ Pay $39 fee                                             │
│  ─────────────────────────────────────────────────────────  │
│  [chat thread, scrollable, lots of vertical space]          │
│   user: Help me renew my license                            │
│   assistant: Here's a 4-step plan…                          │
│   user: 🎤 What does Class C mean?                          │
│   assistant: Class C is the regular car license…            │
│  ─────────────────────────────────────────────────────────  │
│  Mode: ◉ Highlight  ○ Explain  ○ Fill+Ask  ○ Auto+Confirm   │
│  [textarea]                                          [Send] │
└─────────────────────────────────────────────────────────────┘
```

- **Recent ▾** is a collapsible list of conversations (active + archived).
- **Plan** appears only when the conversation has a workflow attached; collapsible.
- **Mode** is the autonomy selector (F6).
- The thread itself is a normal chat — already implemented in `content.js`.
- The sidebar can be detached into a Chrome **Side Panel** (MV3 `sidePanel` API) so it doesn't cover page content; both modes share the same store.

---

## 15. Workflow Mode (F6) — design

### 15.1 Goals

1. The user states a goal in natural language ("renew my license", "appeal a denied claim").
2. Lumineer produces a **plan** (3–8 steps) and surfaces it next to the chat.
3. Lumineer guides through each step, page after page, marking them complete as they happen.
4. The user can change autonomy mid-workflow.
5. The plan is persisted in the conversation (§14.3) so a reload doesn't lose progress.

### 15.2 Plan generation

A new request type, `POST /workflow/plan`:

```jsonc
// request
{
  "conversation_id": "…",
  "goal": "Renew California driver's license",
  "context": {
    "page_url": "https://www.dmv.ca.gov/portal/",
    "page_title": "DMV - California",
    "dom_summary": "[summarized DOM map]"
  }
}

// response
{
  "plan": {
    "goal": "Renew California driver's license",
    "steps": [
      { "id": "s1", "description": "Sign in to mydmv.ca.gov" },
      { "id": "s2", "description": "Open the Renew Online section" },
      { "id": "s3", "description": "Fill in personal info" },
      { "id": "s4", "description": "Pay the renewal fee" },
      { "id": "s5", "description": "Save the confirmation page" }
    ]
  }
}
```

Plans are model-generated; they're a **suggestion**, not a contract. The runner is tolerant of skipped, re-ordered, or extra steps — the model marks step completion based on what it sees on each page (compare current `page_url`/`dom_summary` to step descriptions).

### 15.3 Step completion

On every `/analyze` call within a workflow conversation, the model is given the current plan + which step is `in_progress`. The response includes an optional `step_update`:

```jsonc
{
  "instruction": "Click 'Renew Online' under 'Quick links'.",
  "selector": "a.quick-link.renew",
  "step_update": { "step_id": "s2", "status": "in_progress" }
}
```

When the model determines a step's evidence is satisfied (e.g. URL matches, success message visible), it returns `status: "done"` and the next step automatically becomes `in_progress`. The sidebar's Plan view animates the checkmark.

### 15.4 Autonomy levels

| Level | Name | Behavior |
|---|---|---|
| **0** | **Explain only** | No selectors returned, no highlights. Pure plain-English narration of what the page is. |
| **1** | **Highlight next step** | (Default for elderly users.) Returns selector; pulsing ring; user always clicks. |
| **2** | **Fill + ask before submit** | Lumineer fills form fields it is confident about; pauses and asks before any button click. Fields marked sensitive (passwords, SSN, payment) are *never* auto-filled. |
| **3** | **Act with per-action confirm** | Lumineer will click non-destructive buttons after a 3-second hold-to-confirm prompt. Hard-disabled on financial transactions, account deletion, irreversible actions. |

Level is per-conversation, persisted in `Conversation.settings.autonomyLevel`. Switching mid-thread is allowed; the change is announced in the chat.

### 15.5 Hard safety rails

- **Never** auto-fill: passwords, SSNs, credit-card numbers, bank account numbers, security codes, OTPs, signatures.
- **Never** auto-click: any button containing the words *delete*, *cancel subscription*, *transfer*, *send money*, *confirm payment*, *agree*, *purchase*, or matching common destructive selectors. These always require explicit user click.
- A hard-coded **kill-switch**: ESC twice within 1 second clears all overlays, disables Level 2/3 for the rest of the session, and posts a system message.

---

## 16. Vigilance Mode (F5) — design

### 16.1 Detector cascade

```
DOM mutation / navigation
        │
        ▼
┌────────────────────────┐
│ Layer 1: regex + URL   │  cost: ~0 ms
│ heuristic match        │
└──────────┬─────────────┘
           │ candidate found?
           ▼
┌────────────────────────┐
│ Layer 2: Gemma 4 e2b   │  cost: ~2–3 s
│ triage call            │
│ → { risk, reason }     │
└──────────┬─────────────┘
           │ risk == "high"?
           ▼
┌────────────────────────┐
│ Layer 3: Gemma 4 e4b   │  cost: ~6–8 s
│ deep explanation       │
│ → senior-friendly text │
└────────────────────────┘
```

### 16.2 Layer 1 — regex / heuristic

Implemented in `modules/vigilance.js` (browser, no LLM). Patterns include:

- **Lookalike domain regex:** `/(payp[aA1l]+|amaz[oO0]n|g[oO0]ogle|micros[o0]ft).*\.(com|net)/` against the registrable domain, comparing against a small allowlist of legitimate domains.
- **Punycode / IDN homograph detection** via `new URL(href).hostname.startsWith('xn--')`.
- **Urgency phrases:** `/(verify (your )?account|suspend|locked|24 hours?|act now|final notice)/i`.
- **Payment-fraud phrases:** `/(gift card|wire transfer|moneygram|western union|bitcoin|crypto)/i` co-occurring with `/(send|pay|deposit)/i`.
- **Fake-support phone-number pattern:** any `tel:` link in a page that mentions Microsoft / Apple / IRS / Medicare without a same-origin signature.
- **OTP-leak detection:** any input field labelled `code`, `otp`, `verify` on a page also containing the user's stored email/phone — flag if the page is not on a known list.

All patterns use anchored character classes; **no user input is ever interpolated into a regex** (security-input-validation rule). Regex tables live in `modules/vigilance.patterns.js` and are unit-tested.

### 16.3 Layer 2 — fast triage

`POST /vigilance/triage` with `{ url, page_title, top_dom_text, matched_patterns }` → Gemma 4 e2b with a strict short prompt: *"Reply with JSON: {risk: 'low'|'medium'|'high', reason: <one sentence>}."* Hard timeout 4 s; on timeout, default to `low` (fail-secure as in: don't spam the user). Result cached in-memory by URL hash for 10 minutes.

### 16.4 Layer 3 — deep explanation

`POST /vigilance/explain` only on `high`. Returns a 60-90 word plain-English explanation in the §13 explainer format. Surfaced in the chat as a `vigilance` role message and as an inline warning chip on the page.

### 16.5 UX rules

- Vigilance is **never** a modal; it never blocks the user.
- A high-risk warning surfaces as a calm orange ribbon at the top of the sidebar with a "Tell me more" button. The ribbon dismisses on click of "I understand" or auto-fades after 30 s if no interaction.
- Vigilance can be globally disabled in settings; per-site allowlist is supported.

---

## 17. Voice Interaction (F4) — design

### 17.1 Browser APIs

- Input: `webkitSpeechRecognition` (Chrome) — interim + final transcripts; English by default; 8 s of silence ends a phrase.
- Output: `speechSynthesis` with `SpeechSynthesisUtterance`; voice selected from `getVoices()`, preferring a slow, clear voice (`Google US English` if installed).

### 17.2 Privacy & consent

- Mic is **off by default**. The mic button has 3 states: off (gray), armed (orange dot), recording (red pulsing).
- Push-to-talk by default. Wake-word ("Hey Lumineer") is opt-in in settings and requires re-confirmation every 7 days.
- A persistent on-page indicator shows when the mic is hot.
- Voice transcripts are streamed into the chat as user messages — they go through the same pipeline as typed input.
- We **do not** record audio files. The browser API streams text-only; we never persist raw audio.

### 17.3 Voice commands (built-in shortcuts)

- "Start listening" / "Stop listening" — toggles mic.
- "Read this" — TTS-narrates the current assistant message.
- "Read the page" — F7 explainer over the visible viewport.
- "Stop" — interrupts TTS playback.
- "Highlight the next step" — re-runs `/analyze` and pulses the result.
- "Help" — shows the voice command cheat-sheet.

### 17.4 Phone-call listening (NOT IMPLEMENTED)

The user-suggested "listen to my phone call where the user can start/stop" is **explicitly out of scope** for this hackathon. Reasons:

1. Chrome MV3 cannot access the operating system's audio stream — only the browser's mic stream — without an OS-level helper.
2. Recording phone calls has serious legal-consent implications that vary by jurisdiction (US wiretap laws, GDPR, etc.).
3. A safer alternative *is* in scope: voice input *to* Lumineer. The senior speaks to Lumineer about a confusing page; Lumineer answers. We do not record any other party.

If the team wants to revisit this, it would require: (a) a native helper app, (b) a per-call explicit consent flow, (c) jurisdiction-aware disclaimers, (d) a security review. None of those fit a 2-week hackathon.

---

## 18. Senior-Friendly Explainer (F7) — design

A single text-in / text-out endpoint for translating any confusing chunk of text into a fixed plain-English format.

### 18.1 Endpoint

`POST /explain`

```jsonc
// request
{
  "text": "Your statement balance of $4,217.83 is due by 11/30. The minimum payment is $105. APR is 24.99%.",
  "domain_hint": "credit_card_statement" // or insurance | medicare | prescription | bill | generic
}

// response
{
  "what_this_means": "You owe $4,217.83 by November 30. If you don't pay, you'll be charged extra interest at 25% per year.",
  "why": "This is the bill for what you bought on the credit card.",
  "what_you_should_do": "Pay at least $105 by November 30. Paying the full $4,217.83 avoids any interest.",
  "warnings": ["Confirm this is from your real card issuer before paying."]
}
```

### 18.2 Prompting

A single system prompt with domain-specific addenda. Gemma 4 e4b unless domain hint is `generic` and length < 200 chars (then e2b). Output is rendered into the standard 3-block explainer card in the chat.

### 18.3 Trigger surfaces

- Right-click → context menu "Explain like I'm 80" (uses selected text).
- Sidebar "Explain this page" button (uses readable text from the page).
- Voice: "explain this".
- Auto-suggested when Vigilance fires high-risk.

---

## 19. Document & Camera Understanding (F8) — design

### 19.1 Digital documents (8A)

- **Inline PDFs:** Chrome's PDF viewer ships pages as `<embed>`. We grab a `captureVisibleTab` screenshot and treat it like any other page.
- **Lasso capture:** new UI affordance — user drags a rectangle around any region; we crop the screenshot to that region client-side before sending. Reduces tokens, sharpens the model's focus on a single statement line / table cell.

### 19.2 Physical documents via webcam (8B)

```
[Sidebar 📷 button]
        │ user clicks
        ▼
chrome.permissions.request({ permissions: ['camera'] })  // first time only
        │
        ▼
getUserMedia({ video: { facingMode: 'environment' }})
        │
        ▼
[Camera modal: live preview + “Capture” button]
        │ user clicks Capture
        ▼
canvas.toBlob() → base64 PNG → POST /vision/doc
        │
        ▼
Gemma 4 multimodal with doc-aware prompt
        │
        ▼
{ doc_type, fields, plain_english_summary, warnings }
```

### 19.3 Doc-aware prompt

The system prompt is selected by `doc_type_hint` (the user can pick from a small list: prescription bottle / bill / insurance card / Medicare letter / unknown). Each prompt knows the canonical fields for that doc type.

### 19.4 Privacy

- Camera permission is requested only on first use, with a clear explanation.
- The captured frame is sent to the local backend only; never uploaded.
- The frame is not stored in `chrome.storage.local` (privacy + quota).
- The doc's extracted plain-English summary *is* stored in the chat thread (text only).

---

## 20. API Surface (revised)

| Method | Path | Module | Description |
|---|---|---|---|
| `GET`  | `/health` | platform | Existing liveness check. |
| `GET`  | `/models` | platform | Existing model list. |
| `POST` | `/models/active` | platform | Existing model switch. |
| `POST` | `/analyze` | F2/F3/F6 | Existing primary call. Gains optional `conversation_id`, `workflow`, `autonomy_level`, `step_update` fields. |
| `POST` | `/explain` | F7 | New. Text-only plain-English transformer. |
| `POST` | `/vigilance/triage` | F5 | New. Fast Gemma 2B classifier. |
| `POST` | `/vigilance/explain` | F5 | New. Deep Gemma 4 explanation when triage = high. |
| `POST` | `/workflow/plan` | F6 | New. Generates a workflow plan from a goal + page context. |
| `POST` | `/workflow/step` | F6 | New. Marks a step complete or returns the next step's hint. |
| `POST` | `/vision/doc` | F8 | New. Multimodal document understanding (camera capture or lasso crop). |

All endpoints require:

- Origin allowlist on CORS (extension origin only — replace current `*` once we ship).
- Body size limit (5 MB; screenshots compress well).
- Per-IP rate limit (10 rps for `/analyze`, 30 rps for `/vigilance/triage`).
- Strict pydantic validation; reject any unknown field by default (security-input-validation rule).

---

## 21. Phased delivery (revised)

| Phase | Scope | Status target |
|---|---|---|
| **P0** | This spec + the architecture doc updated in lockstep. | ✅ This commit. |
| **P1** | F1: persistent conversation memory in `chrome.storage.local` + sidebar conversation list. | Hackathon-critical. |
| **P2** | F6: workflow plan generation, step tracking, autonomy-level switcher. Drives the hero demo. | Hackathon-critical. |
| **P3** | F5: vigilance regex layer + e2b triage. e4b deep explanation if time. | Hackathon-critical. |
| **P4** | F4: voice in/out via Web Speech. | Demo-bonus. |
| **P5** | F7: `/explain` endpoint + right-click trigger. | Demo-bonus. |
| **P6** | F8B: webcam document capture; F8A lasso crop. | Demo-bonus. |
| **P7** | Polish: Side Panel API option, accessibility audit, error handling. | Stretch. |
| **P8** | Optional Redis cache for workflow execution metadata. | Post-hackathon. |
