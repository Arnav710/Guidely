# Guidely

> AI browser co-pilot for seniors — local-first, powered by Gemma 4 via Ollama.

A Chrome extension that helps elderly users navigate any website by capturing a screenshot and reading the page's interactive elements, then using a Gemma 4 model (running locally via Ollama) to give one clear, plain-English instruction and highlight the exact element to interact with.

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
# Recommended: multimodal 5B model (already installed by default)
ollama pull gemma4:e2b

# Optional higher-quality variants (larger download):
ollama pull gemma4:e4b    # ~9 GB — solid mid-tier
ollama pull gemma4:26b    # ~18 GB — best quality, 26B MoE (recommended)
ollama pull gemma4:31b    # ~20 GB — densest, highest quality
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
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The Guidely icon appears in your toolbar
5. If Chrome shows a permission prompt, **Allow** — Guidely needs broad site access so `captureVisibleTab` can screenshot normal pages (e.g. google.com). Screenshots are only sent to your local backend.

### 4. Use it

Navigate to any webpage and click the orange **💡 Help me** button.

---

## Switching Models

### Via the extension popup

1. Click the Guidely toolbar icon
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
  -d '{"model": "gemma4:27b"}'
```

### Via the analyze endpoint (per-request override)

```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "screenshot": "<base64_png>",
    "dom_map": [...],
    "history": [],
    "model": "gemma4:12b"
  }'
```

---

## Running tests

```bash
cd backend
source .venv/bin/activate
pytest tests/ -v
```

Expected: **16 passed**.

---

## Architecture

```
Chrome Extension (content.js + background.js)
  → POST /analyze (FastAPI, localhost:8000)
    → Ollama (<active_model>, localhost:11434)
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
| `POST` | `/models/active` | Switch the active model `{"model": "gemma4:27b"}` |
| `POST` | `/analyze` | Main inference endpoint |

---

## File map

```
guidely/
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
