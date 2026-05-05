import pytest
from httpx import AsyncClient, ASGITransport
from main import app

# Meets MIN_SCREENSHOT_B64_CHARS for /analyze validation (bytes not decoded server-side).
FAKE_SCREENSHOT_B64 = "A" * 80


@pytest.mark.asyncio
async def test_health_returns_ok():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ── /analyze ─────────────────────────────────────────────────────────────────

import json
from unittest.mock import patch, AsyncMock
from models import AnalyzeRequest, DomElement


@pytest.mark.asyncio
async def test_analyze_returns_instruction_and_selector():
    mock_result = {
        "instruction": "Click the Next button to continue.",
        "element_label": "Next",
        "selector": "button.next-step",
        "_model": "gemma4:e2b",
    }
    with patch("main.analyze_guidely", new_callable=AsyncMock, return_value=mock_result):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "screenshot": FAKE_SCREENSHOT_B64,
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
    assert data["model_used"] == "gemma4:e2b"


@pytest.mark.asyncio
async def test_analyze_passes_question_to_ollama():
    mock_result = {
        "instruction": "The Settings link is in the footer.",
        "element_label": None,
        "selector": None,
        "_model": "gemma4:e2b",
    }
    mock_ollama = AsyncMock(return_value=mock_result)
    with patch("main.analyze_guidely", mock_ollama):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "screenshot": FAKE_SCREENSHOT_B64,
                "dom_map": [
                    {"id": 1, "tag": "a", "type": None, "label": "Settings",
                     "selector": "a.settings", "visible": True}
                ],
                "history": [],
                "question": "Where is Settings?",
            })
    assert response.status_code == 200
    mock_ollama.assert_awaited_once()
    assert mock_ollama.await_args.kwargs["question"] == "Where is Settings?"


@pytest.mark.asyncio
async def test_analyze_trace_query_passes_through():
    mock_result = {
        "instruction": "OK",
        "element_label": None,
        "selector": None,
        "_model": "gemma4:e2b",
        "_trace": {"model": "gemma4:e2b", "ollama_elapsed_ms": 12.3},
    }
    with patch("main.analyze_guidely", new_callable=AsyncMock, return_value=mock_result):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/analyze?trace=1",
                json={
                    "screenshot": FAKE_SCREENSHOT_B64,
                    "dom_map": [],
                    "history": [],
                },
            )
    assert response.status_code == 200
    data = response.json()
    assert data["trace"] is not None
    assert data["trace"]["ollama_elapsed_ms"] == 12.3


@pytest.mark.asyncio
async def test_analyze_rejects_tiny_screenshot():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/analyze", json={
            "screenshot": "abc",
            "dom_map": [],
            "history": [],
        })
    assert response.status_code == 400
    assert "screenshot" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_analyze_accepts_dom_only_without_screenshot():
    mock_result = {
        "instruction": "Click the blue Sign in link.",
        "element_label": "Sign in",
        "selector": "a.signin",
        "needs_screenshot": False,
        "_model": "gemma4:e2b",
    }
    with patch("main.analyze_guidely", new_callable=AsyncMock, return_value=mock_result):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "dom_map": [
                    {"id": 1, "tag": "a", "type": None, "label": "Sign in",
                     "selector": "a.signin", "visible": True}
                ],
                "history": [],
            })
    assert response.status_code == 200
    data = response.json()
    assert data["needs_screenshot"] is False
    assert data["instruction"] == "Click the blue Sign in link."
    assert data["selector"] == "a.signin"


@pytest.mark.asyncio
async def test_analyze_returns_503_when_ollama_unavailable():
    from ollama_client import OllamaUnavailableError
    with patch("main.analyze_guidely", new_callable=AsyncMock, side_effect=OllamaUnavailableError("not running")):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/analyze", json={
                "screenshot": FAKE_SCREENSHOT_B64,
                "dom_map": [],
                "history": [],
            })
    assert response.status_code == 503
    assert "not running" in response.json()["detail"].lower()


# ── /models ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_models_returns_list():
    fake_models = [
        {"name": "gemma4:e2b", "details": {"parameter_size": "5.1B"}, "size": 7162405886},
        {"name": "gemma4:27b", "details": {"parameter_size": "27B"}, "size": 16000000000},
    ]
    with patch("main.list_ollama_models", new_callable=AsyncMock, return_value=fake_models):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/models")
    assert response.status_code == 200
    data = response.json()
    assert len(data["available"]) == 2
    assert "active" in data


@pytest.mark.asyncio
async def test_set_model_validates_against_installed():
    fake_models = [
        {"name": "gemma4:e2b", "details": {}, "size": 0},
    ]
    with patch("main.list_ollama_models", new_callable=AsyncMock, return_value=fake_models):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/models/active", json={"model": "gemma4:not-installed"})
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_set_model_succeeds_for_installed_model():
    fake_models = [
        {"name": "gemma4:e2b", "details": {}, "size": 0},
        {"name": "gemma4:27b", "details": {}, "size": 0},
    ]
    with patch("main.list_ollama_models", new_callable=AsyncMock, return_value=fake_models):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/models/active", json={"model": "gemma4:27b"})
    assert response.status_code == 200
    assert response.json()["active"] == "gemma4:27b"
