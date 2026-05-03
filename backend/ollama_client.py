"""
Ollama API client — handles model selection, JSON extraction, and retry logic.

Model-switching design:
  - A module-level `_active_model` variable holds the current model name.
  - On startup it auto-detects the best available Gemma 4 model from Ollama.
  - `set_active_model()` / `get_active_model()` provide thread-safe get/set.
  - `call_ollama()` accepts an optional `model` override per-request.
"""

import re
import json
from typing import Optional
import httpx
from models import DomElement, HistoryEntry
from prompt import build_system_prompt, build_user_turn

OLLAMA_BASE = "http://localhost:11434"
OLLAMA_GENERATE_URL = f"{OLLAMA_BASE}/api/generate"
OLLAMA_TAGS_URL = f"{OLLAMA_BASE}/api/tags"

# Fallback preference order — first match wins if multiple are installed
# Tag reference: e2b=5.1B, e4b=~9B, 26b=26B MoE (4B active), 31b=31B dense
_MODEL_PREFERENCE = [
    "gemma4:31b",
    "gemma4:26b",
    "gemma4:e4b",
    "gemma4:e2b",
    "gemma4:2b",
    "gemma4",
]

_active_model: str = "gemma4:e2b"  # overwritten at first real call if needed
_model_detected: bool = False


class OllamaUnavailableError(Exception):
    pass


async def _detect_best_model() -> str:
    """Query Ollama tags and pick the best available Gemma 4 model."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(OLLAMA_TAGS_URL)
            resp.raise_for_status()
            names = [m["name"] for m in resp.json().get("models", [])]
    except Exception:
        return _active_model

    for preferred in _MODEL_PREFERENCE:
        if preferred in names:
            return preferred
    # Return any gemma4 variant found
    gemma_models = [n for n in names if n.startswith("gemma4")]
    return gemma_models[0] if gemma_models else _active_model


async def list_ollama_models() -> list[dict]:
    """Return all models currently registered in Ollama."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(OLLAMA_TAGS_URL)
            resp.raise_for_status()
            return resp.json().get("models", [])
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned error: {exc.response.status_code}")


def get_active_model() -> str:
    return _active_model


def set_active_model(model: str) -> None:
    global _active_model, _model_detected
    _active_model = model
    _model_detected = True


def extract_json(raw: str) -> dict:
    """Extract the first JSON object from a raw string, ignoring surrounding prose."""
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError(f"No valid JSON found in response: {raw[:200]}")
    return json.loads(match.group())


async def call_ollama(
    screenshot_b64: str,
    elements: list[DomElement],
    history: list[HistoryEntry],
    model: Optional[str] = None,
    retry: bool = True,
) -> dict:
    global _active_model, _model_detected

    # Auto-detect best installed model once on first real call
    if not _model_detected:
        _active_model = await _detect_best_model()
        _model_detected = True

    chosen_model = model or _active_model

    system = build_system_prompt()
    user_text = build_user_turn(elements, history)

    payload = {
        "model": chosen_model,
        "system": system,
        "prompt": user_text,
        "images": [screenshot_b64],
        "stream": False,
        "format": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(OLLAMA_GENERATE_URL, json=payload)
            response.raise_for_status()
    except httpx.ConnectError:
        raise OllamaUnavailableError("Ollama is not running at localhost:11434")
    except httpx.RemoteProtocolError as exc:
        raise OllamaUnavailableError(f"Ollama disconnected unexpectedly: {exc}")
    except httpx.HTTPStatusError as exc:
        raise OllamaUnavailableError(f"Ollama returned error: {exc.response.status_code}")

    raw = response.json().get("response", "")

    try:
        result = extract_json(raw)
        result["_model"] = chosen_model
        return result
    except (ValueError, json.JSONDecodeError):
        if retry:
            payload["prompt"] += "\n\nYou MUST respond with ONLY the JSON object. No other text."
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    response = await client.post(OLLAMA_GENERATE_URL, json=payload)
                    response.raise_for_status()
                raw = response.json().get("response", "")
                result = extract_json(raw)
                result["_model"] = chosen_model
                return result
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.HTTPStatusError):
                pass
            except (ValueError, json.JSONDecodeError):
                pass
        return {"instruction": raw.strip(), "element_label": None, "selector": None, "_model": chosen_model}
