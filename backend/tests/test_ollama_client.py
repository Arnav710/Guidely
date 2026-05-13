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


def test_extract_json_brace_inside_string():
    raw = r'{"message": "Use } carefully", "ok": true}'
    result = extract_json(raw)
    assert result["ok"] is True
    assert "}" in result["message"]


def test_recover_partial_agent_plan_truncated_question():
    from ollama_client import recover_partial_agent_plan

    raw = (
        '{"needs_clarification": true, "question": "Which airport and what date?'
    )
    out = recover_partial_agent_plan(raw)
    assert out is not None
    assert out["needs_clarification"] is True
    assert "airport" in out["question"]


@pytest.mark.asyncio
async def test_call_ollama_returns_parsed_response():
    from unittest.mock import MagicMock
    mock_response_body = {
        "response": '{"instruction": "Click Next", "element_label": "Next", "selector": "button.next"}'
    }
    with patch("ollama_client._model_detected", True):
        with patch("ollama_client.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client
            # httpx Response.json() is synchronous — use MagicMock, not AsyncMock
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = mock_response_body
            mock_response.raise_for_status = lambda: None
            mock_client.post.return_value = mock_response

            elements = [DomElement(id=1, tag="button", type="submit", label="Next", selector="button.next", visible=True)]
            result = await call_ollama(elements, [], screenshot_b64="abc123")

    assert result["instruction"] == "Click Next"
    assert result["selector"] == "button.next"


@pytest.mark.asyncio
async def test_call_ollama_raises_when_body_contains_error_field():
    from unittest.mock import MagicMock
    with patch("ollama_client._model_detected", True):
        with patch("ollama_client.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client
            mock_response = MagicMock()
            mock_response.raise_for_status = lambda: None
            mock_response.json.return_value = {"error": "model runner exploded"}
            mock_client.post.return_value = mock_response

            elements = [DomElement(id=1, tag="button", type="submit", label="Next", selector="button.next", visible=True)]
            with pytest.raises(OllamaUnavailableError, match="model runner"):
                await call_ollama(elements, [], screenshot_b64="abc")


@pytest.mark.asyncio
async def test_call_ollama_raises_on_connection_error():
    import httpx as _httpx
    with patch("ollama_client._model_detected", True):
        with patch("ollama_client.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client
            mock_client.post.side_effect = _httpx.ConnectError("connection refused")

            elements = [DomElement(id=1, tag="button", type="submit", label="Next", selector="button.next", visible=True)]
            with pytest.raises(OllamaUnavailableError):
                await call_ollama(elements, [], screenshot_b64="abc123")
