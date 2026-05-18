# Lumineer

> **Lighting the safe way forward**

AI browser co-pilot for seniors — local-first, powered by Gemma 4 via Ollama.

A Chrome extension that helps elderly users navigate any website by capturing a screenshot and reading the page's interactive elements, then using a Gemma 4 model (running locally via Ollama) to give one clear, plain-English instruction and highlight the exact element to interact with.

## Main Use Cases

Lumineer is designed for older adults, caregivers, and anyone who wants a safer, simpler way to use the web without sending private browsing data to a cloud AI service.

### 1. Simplify large and confusing documents

Lumineer can turn long, complex documents into simple, plain-English explanations.

Examples:
- Insurance letters and Explanation of Benefits documents
- Medical portal messages
- Government forms
- Bills and payment notices
- Legal or policy documents
- Long emails or attachments

Instead of only summarizing the text, Lumineer explains:
- What the document is
- Whether the user needs to take action
- Whether money is owed
- Important dates or deadlines
- What to be careful about
- What the next safe step should be

This is especially useful for users who struggle with dense wording, small text, confusing layouts, or documents that mix important information with legal or technical language.

### 2. “Do It For Me” browser tasks

Lumineer can act as a local browser agent. The user can ask for a goal in normal language, and Lumineer uses the browser to help complete that task.

Examples:
- “Book a Visionworks appointment in Sandy, Utah”
- “Find the official page to renew my license”
- “Help me schedule an appointment”
- “Find where I need to upload this document”
- “Look for the closest location and start the booking process”

Lumineer can:
- Understand the user’s goal
- Make a step-by-step plan
- Use page context and browser location when allowed
- Search or navigate to relevant pages
- Click, scroll, and inspect pages
- Ask follow-up questions when needed
- Stop before sensitive steps like passwords, payments, or final submission

The user stays in control while Lumineer handles the confusing navigation.

### 3. “Guide Me” step-by-step assistance

Guide Me mode is for users who want to learn how to do the task themselves.

Instead of taking over, Lumineer:
- Explains the next step in simple words
- Highlights the exact button, link, or field to use
- Waits for the user to act
- Helps the user understand why that step matters
- Continues one step at a time

This is useful for building confidence and digital independence. The goal is not just automation — it is helping users become more comfortable using websites on their own.

### 4. Vigilance Mode for scams and risky pages

Vigilance Mode acts like another pair of eyes while the user browses.

When enabled, Lumineer periodically checks the visible screen, such as every few seconds, and looks for suspicious or harmful patterns.

It can flag:
- Phishing emails
- Fake login pages
- Urgent “verify your account” messages
- Suspicious links
- Sender/domain mismatches
- Requests for private information
- Fake news or misleading claims
- AI-generated or manipulative content patterns

When Lumineer sees something risky, it does not just say “scam.” It explains:
- What looks suspicious
- Why it may be risky
- What the user should avoid clicking
- What the safer next step is

This helps users check email, browse the web, and read online content with more confidence.

### 5. Home camera and network device assistance

Lumineer can also connect to supported devices on the local network, such as home security cameras.

Examples:
- “Is there a package at the door?”
- “Can you check the kitchen?”
- “Is the garage door open?”
- “What is happening in the camera view?”

Lumineer can pull in local camera streams or snapshots, move supported pan/tilt cameras when needed, inspect the scene, and describe what it sees in plain language.

This is useful for older users who may not want to walk downstairs, go outside, or check multiple camera apps just to confirm something simple.

### 6. Local-first privacy

Lumineer is built around a local-first privacy model.

Key privacy properties:
- The LLM runs locally through Ollama
- The backend runs on the user’s machine or on a dedicated device on the local WAN
- Any computer on the same network can use Lumineer through the Chrome extension
- Conversation history and UI state are stored in the browser’s session storage
- Browser data, screenshots, and camera context are processed through the local backend
- No cloud LLM API is required
- Private data does not need to leave the local network

This makes Lumineer especially suitable for sensitive tasks involving emails, documents, health portals, bills, government forms, and home camera feeds.

### 7. Shared household AI hub

A single device on the home network can act as the Lumineer hub.

For example:
- A laptop
- Desktop
- Raspberry Pi-style home server
- Small always-on local machine

Family members can install the Chrome extension on their own devices and point it to the same local Lumineer server. This allows a household, caregiver, or senior center to provide one private AI assistant across multiple browsers without sending user data outside the local WAN.

---

## Requirements

- macOS / Linux (Windows untested)
- Python 3.9+
- [Ollama](https://ollama.ai) installed and running
- Google Chrome

---

## Setup

### 1. Pull the model

```bash
# Default target: multimodal ~9B (Lumineer prefers this over 2B when installed)
ollama pull gemma4:e4b

# Smaller / larger options:
ollama pull gemma4:e2b    # ~7 GB — faster, less capable
ollama pull gemma4:26b    # ~18 GB — 26B MoE
ollama pull gemma4:31b    # ~20 GB — dense 31B
```

The backend auto-picks the best **installed** Gemma 4 tag (order: 31b → 26b → **e4b** → e2b → …).

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
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The Lumineer icon appears in your toolbar
5. If Chrome shows a permission prompt, **Allow** — Lumineer needs broad site access so `captureVisibleTab` can screenshot normal pages (e.g. google.com). Screenshots are only sent to your local backend.

### 4. Use it

Navigate to any webpage and click the orange **💡 Help me** button. A **chat** panel opens: messages scroll like a normal chat. **Each send** first sends the page’s **interactive elements (DOM map)** to the backend; the model may answer from that alone, or ask for a **screenshot**—then the extension captures the tab and sends a second request with the image. **Enter** sends; **Shift+Enter** starts a new line. You can leave the input empty to ask for a suggested next step. Errors appear as chat messages. The toolbar popup still shows backend health and model switching.

### Web tools (optional)

The repo has a top-level `tools/` package. The model can request **`web_search`** (DuckDuckGo text results via `duckduckgo-search`); the server runs the tool and **calls Ollama a second time** with the snippets. Set `"enable_tools": false` on `POST /analyze` to disable. All answers still go through Ollama — the server does not improvise replies without the model.

---

## Switching Models

### Via the extension popup

1. Click the Lumineer toolbar icon
2. Select a model from the **Active Model** dropdown (only installed models appear)
3. Click **Switch Model**

The new model takes effect immediately for the next **💡 Help me** click.

### Via the API directly

```bash
# List available models
curl http://localhost:8000/models

# Switch active model
curl -X POST http://localhost:8000/models/active \
  -H "Content-Type: application/json" \
  -d '{"model": "gemma4:e2b"}'
```

### Via the analyze endpoint (per-request override)

```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "screenshot": "<base64_png>",
    "dom_map": [...],
    "history": [],
    "model": "gemma4:e2b",
    "question": "Where do I sign in?"
  }'
```

---

## Verifying Ollama is really called

Lumineer does call Ollama on every successful `/analyze` (no shortcut). Replies can feel fast on a GPU, especially for short JSON.

1. **Trace mode** — add `?trace=1` to the analyze URL. The JSON response includes `trace` with `ollama_elapsed_ms`, `image_base64_chars`, `dom_element_count`, `json_parsed_ok`, etc. (no screenshot or prompt text).

   ```bash
   curl -s -X POST 'http://localhost:8000/analyze?trace=1' -H 'Content-Type: application/json' -d '{"screenshot":"...", "dom_map":[], "history":[]}' | python3 -m json.tool
   ```

2. **Server logs** — run uvicorn with `--log-level info` and watch for lines like `ollama ok model=... elapsed_ms=...`.

3. **Extension** — in the page DevTools console, set `window.__LUMINEER_DEBUG__ = true`, reload the extension, then ask again for verbose client logging (see `extension/modules/agent-loop.js`).

If Ollama returns an error in the JSON body (HTTP 200 with `"error": "..."`), the API now returns **503** with that message instead of a blank or generic answer.

---

## Running tests

```bash
cd backend
source .venv/bin/activate
pytest tests/ -v
```

Expected: **23 passed** (run from `backend/`).

---

## Architecture

```
Chrome Extension (content.js + background.js)
  → POST /analyze (FastAPI, localhost:8000)
    → Ollama (/api/generate, <active_model>, localhost:11434)
    → optional: tools/web_search.py → second Ollama round if model requested web_search
```

### Model auto-detection

On the first inference call, the backend queries Ollama and selects the best available Gemma 4 model in this preference order:

```
gemma4:31b  →  gemma4:26b  →  gemma4:e4b  →  gemma4:e2b  →  gemma4:2b  →  gemma4
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Backend liveness check |
| `GET` | `/models` | List installed Ollama models + active model |
| `POST` | `/models/active` | Switch the active model `{"model": "gemma4:26b"}` |
| `POST` | `/analyze` | Vision + DOM + optional `question`; `enable_tools` (default true) |

---

## File map

```
├── tools/
│   ├── web_search.py    # DuckDuckGo text search (invoked by backend, not the browser)
├── extension/
│   ├── manifest.json      # MV3 manifest
│   ├── background.js      # Screenshot capture service worker
│   ├── content.js         # DOM serializer + floating button + sidebar + highlight
│   ├── popup.html         # Toolbar popup
│   ├── popup.js           # Health check + model switcher
│   └── assets/icon.png
├── backend/
│   ├── main.py            # FastAPI app: /health, /analyze, /models
│   ├── prompt.py          # System prompt + user turn builder
│   ├── ollama_client.py   # Ollama API client, JSON extraction, retry, model switching
│   ├── models.py          # Pydantic request/response models
│   ├── requirements.txt
│   └── tests/
│       ├── test_main.py
│       ├── test_prompt.py
│       └── test_ollama_client.py
└── README.md
```
