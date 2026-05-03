import pytest
from httpx import AsyncClient, ASGITransport
from main import app


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
    assert data["model_used"] == "gemma4:e2b"


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
