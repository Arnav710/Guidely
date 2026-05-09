"""
web_search.py — LLM-optimised web search with a three-tier provider cascade.

Priority order (first configured provider wins):
  1. Tavily  — purpose-built for AI agents; clean structured results.
              Set TAVILY_API_KEY in your environment.
  2. Brave   — high-quality structured results; free 2 000 req/month.
              Set BRAVE_SEARCH_API_KEY in your environment.
  3. DuckDuckGo Lite — zero config, zero cost fallback; scrapes
              lite.duckduckgo.com and returns up to 5 snippet results.

Public API:
  web_search(query)        → str          (LLM-ready text blob)
  web_search_rich(query)   → (str, list)  (text + list[{title,url,snippet}])
"""

import asyncio
import os
import re
import logging
import html
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_SEARCH_TIMEOUT = httpx.Timeout(connect=8.0, read=20.0, write=8.0, pool=5.0)
_MAX_RESULTS = 5
_MAX_SNIPPET_CHARS = 300

# Type alias for structured results
SearchResultList = list[dict]  # [{title: str, url: str, snippet: str}]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", html.unescape(text)).strip()


def _format_results(results: SearchResultList, summary: Optional[str] = None) -> str:
    """
    Format structured results as indexed lines so the LLM can reference them
    by index when using goto_result.  Example output:
      [0] Utah DMV — Renew your license online
          driver.utah.gov | Official renewal portal for Utah residents.
    """
    lines: list[str] = []
    if summary:
        lines.append(f"Summary: {summary}\n")
    for r in results:
        lines.append(f"[{r['index']}] {r['title']}")
        lines.append(f"    {r['url']} | {r['snippet']}")
    lines.append(
        "\nUse goto_result {\"index\": N} to open one of the results above."
    )
    return "\n".join(lines)


# ── Tavily ────────────────────────────────────────────────────────────────────

async def _tavily(query: str) -> Optional[tuple[SearchResultList, Optional[str]]]:
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        return None
    try:
        async with httpx.AsyncClient(timeout=_SEARCH_TIMEOUT) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": key,
                    "query": query,
                    "search_depth": "basic",
                    "include_answer": True,
                    "max_results": _MAX_RESULTS,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("Tavily search failed: %s", exc)
        return None

    results: SearchResultList = []
    for i, r in enumerate((data.get("results") or [])[:_MAX_RESULTS]):
        results.append({
            "index": i,
            "title":   (r.get("title")   or "").strip(),
            "url":     (r.get("url")     or "").strip(),
            "snippet": (r.get("content") or r.get("snippet") or "").strip()[:_MAX_SNIPPET_CHARS],
        })
    summary = (data.get("answer") or "").strip() or None
    return results, summary


# ── Brave Search ──────────────────────────────────────────────────────────────

async def _brave(query: str) -> Optional[tuple[SearchResultList, Optional[str]]]:
    key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()
    if not key:
        return None
    try:
        async with httpx.AsyncClient(timeout=_SEARCH_TIMEOUT) as client:
            resp = await client.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": query, "count": _MAX_RESULTS, "text_decorations": False},
                headers={"Accept": "application/json", "X-Subscription-Token": key},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("Brave search failed: %s", exc)
        return None

    results: SearchResultList = []
    for i, r in enumerate((data.get("web", {}).get("results") or [])[:_MAX_RESULTS]):
        results.append({
            "index": i,
            "title":   (r.get("title")       or "").strip(),
            "url":     (r.get("url")         or "").strip(),
            "snippet": (r.get("description") or "").strip()[:_MAX_SNIPPET_CHARS],
        })
    return results, None


# ── DuckDuckGo Lite (no-key fallback) ────────────────────────────────────────

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
)


def _is_ddg_captcha(body: str) -> bool:
    """Detect DDG's bot-challenge page. Lite endpoint serves this on rate-limit."""
    return (
        "Unfortunately, bots use DuckDuckGo" in body
        or "anomaly detected" in body.lower()
        or ("complete the following challenge" in body.lower() and "duck" in body.lower())
    )


async def _ddg_fetch(url: str, query: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(
            timeout=_SEARCH_TIMEOUT,
            headers={"User-Agent": _BROWSER_UA},
            follow_redirects=True,
        ) as client:
            resp = await client.post(url, data={"q": query, "kl": "us-en"})
            resp.raise_for_status()
            return resp.text
    except Exception as exc:
        logger.warning("DDG fetch %s failed: %s", url, exc)
        return None


# Regex pairs — each (link_re, snippet_re) matches one of the two endpoints.
_DDG_LITE_LINK = re.compile(
    r"<a\b[^>]*?\bhref=['\"]([^'\"]+)['\"][^>]*?\bclass=['\"]result-link['\"][^>]*>(.*?)</a>",
    re.DOTALL | re.IGNORECASE,
)
_DDG_LITE_SNIPPET = re.compile(
    r"<td\b[^>]*?\bclass=['\"]result-snippet['\"][^>]*>(.*?)</td>",
    re.DOTALL | re.IGNORECASE,
)
# html.duckduckgo.com/html/ uses different classnames.
_DDG_HTML_LINK = re.compile(
    r"<a\b[^>]*?\bclass=['\"][^'\"]*\bresult__a\b[^'\"]*['\"][^>]*?\bhref=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>",
    re.DOTALL | re.IGNORECASE,
)
_DDG_HTML_SNIPPET = re.compile(
    r"<a\b[^>]*?\bclass=['\"][^'\"]*\bresult__snippet\b[^'\"]*['\"][^>]*>(.*?)</a>",
    re.DOTALL | re.IGNORECASE,
)


def _parse_ddg_body(
    body: str, link_re: re.Pattern, snippet_re: re.Pattern, source: str,
) -> SearchResultList:
    """Parse DDG HTML into structured results, filtering ads/internal links."""
    from urllib.parse import unquote, urlparse, parse_qs

    links    = link_re.findall(body)
    snippets = snippet_re.findall(body)
    if not links:
        return []

    results: SearchResultList = []
    skipped_ads = 0

    for raw_url, raw_title in links:
        url = html.unescape(raw_url).strip()

        # DDG wraps organic results through //duckduckgo.com/l/?uddg= — unwrap.
        if url.startswith("//duckduckgo.com/l/?uddg=") or url.startswith("/l/?uddg="):
            full = "https:" + url if url.startswith("//") else "https://duckduckgo.com" + url
            try:
                qs = parse_qs(urlparse(full).query)
                if qs.get("uddg"):
                    url = unquote(qs["uddg"][0])
            except Exception:
                pass

        # Skip sponsored / internal links.
        if "duckduckgo.com/y.js" in url or "duckduckgo.com/aclk" in url:
            skipped_ads += 1
            continue
        try:
            host = urlparse(url).netloc.lower()
            if host.endswith("duckduckgo.com") or not host:
                skipped_ads += 1
                continue
        except Exception:
            pass

        title = _strip_tags(raw_title)[:120]
        snippet_idx = len(results) + skipped_ads
        snippet = (
            _strip_tags(snippets[snippet_idx])[:_MAX_SNIPPET_CHARS]
            if snippet_idx < len(snippets) else ""
        )
        if title or snippet:
            results.append({
                "index": len(results),
                "title": title,
                "url":   url,
                "snippet": snippet,
            })
        if len(results) >= _MAX_RESULTS:
            break

    logger.info(
        "DDG %s parsed results=%d (skipped %d ads, %d total links)",
        source, len(results), skipped_ads, len(links),
    )
    return results


async def _duckduckgo_pkg(query: str) -> Optional[tuple[SearchResultList, Optional[str]]]:
    """
    Use the `duckduckgo-search` package (uses Rust-based `primp` under the hood
    which better mimics a real browser and is far less likely to hit CAPTCHA).
    Wraps the sync API in asyncio.to_thread so our event loop isn't blocked.
    """
    try:
        # Optional dependency — keep import local so it's not required at module load.
        from duckduckgo_search import DDGS
    except ImportError:
        logger.debug("duckduckgo-search package not installed; skipping")
        return None

    def _run() -> list[dict]:
        with DDGS() as ddg:
            return list(ddg.text(query, max_results=_MAX_RESULTS, region="us-en"))

    try:
        raw_results = await asyncio.to_thread(_run)
    except Exception as exc:
        logger.warning("duckduckgo-search failed: %s", exc)
        return None

    results: SearchResultList = []
    for i, r in enumerate(raw_results[:_MAX_RESULTS]):
        title   = (r.get("title") or "").strip()[:120]
        url     = (r.get("href")  or "").strip()
        snippet = (r.get("body")  or "").strip()[:_MAX_SNIPPET_CHARS]
        if not url or not (title or snippet):
            continue
        results.append({"index": len(results), "title": title, "url": url, "snippet": snippet})

    logger.info("duckduckgo-search parsed %d results", len(results))
    return (results, None) if results else None


async def _duckduckgo_scrape(query: str) -> Optional[tuple[SearchResultList, Optional[str]]]:
    """Last-resort raw HTTP scraping. Often hits CAPTCHA after a few queries."""
    # Endpoint 1: lite.duckduckgo.com
    body = await _ddg_fetch("https://lite.duckduckgo.com/lite/", query)
    if body and _is_ddg_captcha(body):
        logger.warning(
            "DDG lite returned CAPTCHA for query=%r — falling back to html endpoint",
            query[:60],
        )
        body = None
    if body:
        results = _parse_ddg_body(body, _DDG_LITE_LINK, _DDG_LITE_SNIPPET, "lite")
        if results:
            return results, None

    # Endpoint 2: html.duckduckgo.com/html/
    body = await _ddg_fetch("https://html.duckduckgo.com/html/", query)
    if body and _is_ddg_captcha(body):
        logger.warning(
            "DDG html endpoint also CAPTCHA'd for query=%r — install duckduckgo-search "
            "or set TAVILY_API_KEY / BRAVE_SEARCH_API_KEY for reliable search.",
            query[:60],
        )
        return None
    if body:
        results = _parse_ddg_body(body, _DDG_HTML_LINK, _DDG_HTML_SNIPPET, "html")
        if results:
            return results, None
        logger.warning(
            "DDG html parsed 0 results for query=%r (body=%d chars) — page format may have changed",
            query[:60], len(body),
        )

    return None


async def _duckduckgo_lite(query: str) -> Optional[tuple[SearchResultList, Optional[str]]]:
    """Try the duckduckgo-search package first, then raw scraping as fallback."""
    res = await _duckduckgo_pkg(query)
    if res:
        return res
    return await _duckduckgo_scrape(query)


# ── Public entry points ───────────────────────────────────────────────────────

async def web_search_rich(query: str) -> tuple[str, SearchResultList]:
    """
    Run a web search and return (formatted_text, structured_results).
    formatted_text is indexed for the LLM (references goto_result).
    structured_results is [{index, title, url, snippet}] for the extension.
    """
    query = query.strip()[:500]
    if not query:
        return ("(empty search query)", [])

    for provider_fn, name in [
        (_tavily,          "Tavily"),
        (_brave,           "Brave"),
        (_duckduckgo_lite, "DuckDuckGo"),
    ]:
        try:
            pair = await provider_fn(query)
        except Exception as exc:
            logger.warning("%s search raised unexpectedly: %s", name, exc)
            pair = None

        if pair:
            results, summary = pair
            if results:
                logger.info(
                    "web_search provider=%s query=%r results=%d",
                    name, query[:60], len(results),
                )
                return _format_results(results, summary), results

    return (
        "All search providers failed. Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY "
        "for more reliable results.",
        [],
    )


async def web_search(query: str) -> str:
    """Plain-text web search — backwards-compatible wrapper used by ollama_client.py."""
    text, _ = await web_search_rich(query)
    return text
