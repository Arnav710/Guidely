"""
Web search tool — retrieves short text snippets for a query (DuckDuckGo text results).

The model supplies only a search query string (validated length); we do not fetch arbitrary URLs
from model output (SSRF-safe pattern).
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

MAX_QUERY_LEN = 500
MAX_SNIPPET_CHARS = 2800


def _sanitize_query(q: str) -> str:
    q = (q or "").strip()
    if len(q) > MAX_QUERY_LEN:
        q = q[:MAX_QUERY_LEN]
    return q


async def web_search(query: str, max_results: int = 5) -> str:
    """
    Return a plain-text bundle of search snippets for the given query.
    Runs the blocking DDG client in a worker thread.
    """
    q = _sanitize_query(query)
    if not q:
        raise ValueError("Empty search query")

    max_results = max(1, min(max_results, 8))

    def _sync_search() -> str:
        try:
            from duckduckgo_search import DDGS  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "duckduckgo-search is not installed. Run: pip install duckduckgo-search"
            ) from exc

        lines: list[str] = []
        with DDGS() as ddgs:
            for i, r in enumerate(ddgs.text(q, max_results=max_results)):
                if i >= max_results:
                    break
                title = (r.get("title") or "").strip()
                body = (r.get("body") or "").strip()
                href = (r.get("href") or "").strip()
                if not title and not body:
                    continue
                line = f"• {title}\n  {body}"
                if href and re.match(r"^https?://", href):
                    line += f"\n  {href}"
                lines.append(line)
        if not lines:
            return "(No web results returned for this query.)"
        text = "\n\n".join(lines)
        if len(text) > MAX_SNIPPET_CHARS:
            text = text[: MAX_SNIPPET_CHARS - 20] + "\n… (truncated)"
        return text

    try:
        return await asyncio.to_thread(_sync_search)
    except Exception as exc:
        logger.warning("web_search failed: %s", exc)
        raise RuntimeError(f"Web search failed: {exc}") from exc
