/**
 * agent-loop.js — Autonomous browser agent for Guidely.
 *
 * Responsibilities:
 *   • All browser tool executors (get_sections, search_page, click, type, scroll, navigate…)
 *   • The main agent step loop (send context → receive tool call → execute → repeat)
 *   • Auto-capture: after any state-changing action, automatically snapshot
 *     screenshot + page sections and attach them to the next /agent/step call —
 *     so the LLM never needs a separate "show me the page" round-trip.
 *   • Navigation survivability: before navigating, saves state to chrome.storage.local.
 *     On the new page, content.js calls resumeAgentLoop() to continue where we left off.
 *
 * Exports:
 *   startAgentLoop(conversationId, goal, callbacks)
 *   resumeAgentLoop(conversationId, callbacks)
 *   respondToUserQuestion(conversationId, answer, callbacks)
 *
 * Debug: Open DevTools (F12 or Cmd+Opt+I) while the **website tab** is focused
 * (e.g. Gmail) — not the extension popup, not chrome://extensions. In Console,
 * keep default levels on (especially "Verbose" / all levels) and filter by: Guidely
 *
 * Extra detail: set window.__GUIDELY_DEBUG__ = true then reload for verbose dom_map /
 * selector snippets in guide mode.
 */

import * as store from './conversation-store.js';
import { agentStart, agentStepStream, extendWorkflow, summarizePage, guideMode } from './api.js';

// Safety ceiling: stop the loop after this many tool calls to prevent infinite loops.
// Backend also forces `done` around iteration 18 when `loop_iteration` is sent.
const MAX_LOOP_CALLS = 24;

// Attribute injected on semantic landmark elements so we can find them by ID.
const SECTION_ATTR = 'data-guidely-section';

/**
 * Debug logging — always logs concise milestones. Set window.__GUIDELY_DEBUG__ = true
 * in the page DevTools console for verbose dumps (e.g. first lines of dom_map).
 */
function _guidelyLog(tag, data = {}) {
  try {
    // Use console.log — many users disable "Info" in DevTools, which hides console.info.
    console.log(`[Guidely ${tag}]`, data);
  } catch { /* ignore */ }
}

function _guidelyLogVerbose(tag, data = {}) {
  try {
    if (typeof window !== 'undefined' && window.__GUIDELY_DEBUG__) {
      console.log(`[Guidely ${tag}:verbose]`, data);
    }
  } catch { /* ignore */ }
}

// Module-level flag: only one loop runs at a time per content-script context.
let _loopRunning = false;

// ── Tool name normaliser (defence-in-depth against hallucinated tool names) ──
// Even with constrained JSON-schema output, a small edit-distance fuzzy matcher
// catches any edge cases where the model produces a near-miss name.

const _KNOWN_TOOLS = new Set([
  'get_sections', 'get_elements', 'search_page', 'get_page_text',
  'screenshot', 'web_search',
  'find_and_click', 'fill_field',
  'click_link', 'goto_result',
  'click', 'type_text', 'scroll',
  'complete_step', 'replan', 'ask_user', 'ask_action', 'done',
  // Legacy names — map to the new tools via normaliser
  'navigate', 'navigate_and_read',
]);

function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) dp[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function _normaliseTool(tool) {
  if (_KNOWN_TOOLS.has(tool)) return tool;
  let best = null, bestDist = Infinity;
  for (const known of _KNOWN_TOOLS) {
    const d = _levenshtein(tool, known);
    if (d < bestDist) { bestDist = d; best = known; }
  }
  if (bestDist <= 3) {
    console.warn(`[Guidely] Unknown tool "${tool}" → normalised to "${best}" (distance ${bestDist})`);
    return best;
  }
  return tool; // Return as-is — will hit the unknown-tool handler
}

// ── Page structure scanner (Tier 1 DOM tool) ─────────────────────────────────

/**
 * Scan the page for semantic landmark elements and return a compact structural
 * overview. Injects data-guidely-section attributes so later get_elements()
 * calls can locate the same elements without regenerating the full scan.
 */
export function getPageSections() {
  // Clear any previous section markers to avoid stale IDs after navigation.
  document.querySelectorAll(`[${SECTION_ATTR}]`).forEach((el) => el.removeAttribute(SECTION_ATTR));

  const LANDMARK_SELECTORS = [
    'main', '[role="main"]',
    'form',
    'nav', '[role="navigation"]',
    '[role="search"]',
    'header', '[role="banner"]',
    'footer', '[role="contentinfo"]',
    'aside', '[role="complementary"]',
    'section',
    '[role="form"]',
    'article',
    'dialog', '[role="dialog"]',
  ];

  const sections = [];
  const seen = new WeakSet();
  let idx = 0;

  for (const sel of LANDMARK_SELECTORS) {
    let candidates;
    try { candidates = Array.from(document.querySelectorAll(sel)); }
    catch { continue; }

    for (const el of candidates) {
      if (seen.has(el)) continue;
      // Skip elements that aren't visible/rendered.
      if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;

      seen.add(el);
      const id = `gs-${idx++}`;
      try { el.setAttribute(SECTION_ATTR, id); } catch { continue; }

      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      const heading = el.querySelector('h1,h2,h3,h4,h5');
      const label = ariaLabel || heading?.textContent?.trim().slice(0, 60) || role;

      let elementCount = 0;
      try {
        elementCount = el.querySelectorAll(
          'a,button,input,select,textarea,[role="button"],[tabindex]',
        ).length;
      } catch { /* ignore */ }

      sections.push({ id, role, label, element_count: elementCount });
    }
  }

  // Fallback: if no landmarks found the page uses div soup — treat body as one section.
  if (sections.length === 0) {
    const id = 'gs-body';
    try { document.body.setAttribute(SECTION_ATTR, id); } catch { /* ignore */ }
    sections.push({
      id,
      role: 'body',
      label: document.title || 'Page',
      element_count: document.querySelectorAll('a,button,input,select,textarea').length,
    });
  }

  return { type: 'sections', sections };
}

// ── Elements within a section (Tier 2 DOM tool) ───────────────────────────────

export function getElementsInSection(sectionId) {
  const safeId = String(sectionId).replace(/[^a-z0-9_-]/gi, '');
  let sectionEl = null;

  try { sectionEl = document.querySelector(`[${SECTION_ATTR}="${safeId}"]`); }
  catch { /* ignore */ }

  if (!sectionEl) {
    // Section IDs expire on navigation — regenerate and retry.
    getPageSections();
    try { sectionEl = document.querySelector(`[${SECTION_ATTR}="${safeId}"]`); } catch { /* ignore */ }
  }

  return _extractElements(sectionEl || document.body, sectionId);
}

function _extractElements(containerEl, sectionId) {
  const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [tabindex="0"]';
  let raw = [];
  try { raw = Array.from(containerEl.querySelectorAll(INTERACTIVE)); } catch { /* ignore */ }

  const elements = [];
  for (const el of raw) {
    if (elements.length >= 30) break;
    try {
      if (!_isVisible(el)) continue;
      const label = _getLabel(el);
      const tag = el.tagName.toLowerCase();
      const fallback = label || (el.id ? `#${el.id}` : null) || tag;
      if (!fallback || fallback === 'div' || fallback === 'span') continue;
      elements.push({
        tag,
        type: el.type || null,
        label: fallback,
        selector: _getSelector(el),
      });
    } catch { /* skip malformed nodes */ }
  }

  return { type: 'elements', section_id: sectionId, elements };
}

/** Higher rank = more desirable target for clicks/highlights. */
function _highlightTagRank(tag) {
  const t = String(tag || '').toLowerCase();
  if (t === 'a' || t === 'button') return 40;
  if (t === 'span') return 25;
  if (t === 'input' || t === 'select' || t === 'textarea') return 20;
  if (t === 'label') return 15;
  if (t === 'li') return 0;
  return 10;
}

// ── Fuzzy page search (fast locate without knowing section) ───────────────────

/**
 * @param {string} query
 * @param {{ excludeGuidelySidebar?: boolean, preferActionTags?: boolean, maxMatches?: number }} [options]
 */
export function searchPage(query, options = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { type: 'search', query, matches: [] };

  const {
    excludeGuidelySidebar = true,
    preferActionTags = false,
    maxMatches = 8,
  } = options;

  // Search across interactive elements AND text nodes (headings, labels, paragraphs).
  const SEARCHABLE = [
    'a', 'button', 'input', 'select', 'textarea',
    '[role="button"]', 'h1', 'h2', 'h3', 'h4', 'label', 'p', 'li',
  ].join(', ');

  let candidates = [];
  try { candidates = Array.from(document.querySelectorAll(SEARCHABLE)); } catch { /* ignore */ }

  const sidebar = excludeGuidelySidebar ? document.getElementById('g-sidebar') : null;
  const matches = [];

  for (const el of candidates) {
    try {
      if (sidebar && sidebar.contains(el)) continue;

      const text = (
        el.getAttribute('aria-label') ||
        el.textContent ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') || ''
      ).trim();

      if (!text) continue;
      const score = _fuzzyScore(text.toLowerCase(), q);
      if (score <= 0) continue;

      // Find nearest section ancestor for context
      const sectionEl = el.closest(`[${SECTION_ATTR}]`);
      const context = sectionEl
        ? (sectionEl.getAttribute('aria-label') || sectionEl.tagName.toLowerCase())
        : '';

      matches.push({
        label: text.slice(0, 60),
        tag: el.tagName.toLowerCase(),
        selector: _getSelector(el),
        score,
        context,
      });
    } catch { /* skip */ }
    if (matches.length >= 200) break;
  }

  matches.sort((a, b) => {
    const ta = preferActionTags ? _highlightTagRank(a.tag) : 0;
    const tb = preferActionTags ? _highlightTagRank(b.tag) : 0;
    const sa = a.score * 100 + ta;
    const sb = b.score * 100 + tb;
    return sb - sa;
  });

  return { type: 'search', query, matches: matches.slice(0, maxMatches) };
}

function _fuzzyScore(text, query) {
  if (text === query) return 10;
  if (text.startsWith(query)) return 8;
  if (text.includes(query)) return 6;
  const qWords = query.split(/\s+/).filter((w) => w.length > 2);
  const tWords = new Set(text.split(/\s+/));
  const overlap = qWords.filter((w) => tWords.has(w)).length;
  return overlap > 0 ? overlap * 3 : 0;
}

// ── Visible text reader ───────────────────────────────────────────────────────

export function getPageText(sectionId) {
  let el = document.body;
  if (sectionId) {
    const safeId = String(sectionId).replace(/[^a-z0-9_-]/gi, '');
    try { el = document.querySelector(`[${SECTION_ATTR}="${safeId}"]`) || document.body; } catch { /* ignore */ }
  }
  const text = (el.innerText || el.textContent || '').trim();
  return { type: 'text', content: text.slice(0, 800) };
}

// ── Direct action tools ───────────────────────────────────────────────────────

async function _clickElement(selector, label) {
  if (!_isSafeSelector(selector)) {
    return { success: false, error: 'Unsafe selector rejected' };
  }

  let el = null;

  // Primary: use the provided selector.
  try { el = document.querySelector(selector); } catch { /* invalid CSS */ }

  // Fallback: fuzzy label match against a fresh DOM scan.
  if (!el && label) {
    const search = searchPage(label);
    for (const m of search.matches.slice(0, 3)) {
      try {
        el = document.querySelector(m.selector);
        if (el) break;
      } catch { /* ignore */ }
    }
  }

  if (!el) return { success: false, error: `Element not found: ${selector}` };

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _wait(200);
    el.focus();
    el.click();
    // Dispatch synthetic events for SPA frameworks (React, Vue, Angular).
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await _wait(100); // brief settle; navigation detection is handled by callers
    return { success: true, clicked: label || selector };
  } catch (err) {
    return { success: false, error: String(err?.message || 'Click failed') };
  }
}

async function _typeInElement(selector, text) {
  if (!_isSafeSelector(selector)) {
    return { success: false, error: 'Unsafe selector rejected' };
  }

  let el = null;
  try { el = document.querySelector(selector); } catch { /* invalid CSS */ }
  if (!el) return { success: false, error: `Element not found: ${selector}` };

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    await _wait(100);
    // Clear, then set value — works for both plain inputs and React-controlled inputs.
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await _wait(200);
    return { success: true, typed: String(text).slice(0, 40) };
  } catch (err) {
    return { success: false, error: String(err?.message || 'Type failed') };
  }
}

// ── Macro tools ───────────────────────────────────────────────────────────────

/** find_and_click: search by text, click best match, return result. */
export async function findAndClick(text) {
  let search = searchPage(text);

  // If nothing found on visible page, try scrolling down to reveal more content.
  if (search.matches.length === 0) {
    window.scrollBy(0, 500);
    await _wait(400);
    search = searchPage(text);
  }

  if (search.matches.length === 0) {
    return {
      type: 'action_result', tool: 'find_and_click', success: false,
      error: `No element found matching "${text}"`,
    };
  }

  for (const match of search.matches.slice(0, 3)) {
    const res = await _clickElement(match.selector, match.label);
    if (res.success) {
      return { type: 'action_result', tool: 'find_and_click', success: true, details: `Clicked "${match.label}"` };
    }
  }

  return {
    type: 'action_result', tool: 'find_and_click', success: false,
    error: `Found "${text}" but could not click it`,
  };
}

/** fill_field: search for an input by label, type a value into it. */
export async function fillField(label, value) {
  const search = searchPage(label);

  // Prefer actual input/textarea/select over generic elements.
  const inputMatch =
    search.matches.find((m) => ['input', 'textarea', 'select'].includes(m.tag)) ||
    search.matches[0];

  if (!inputMatch) {
    return {
      type: 'action_result', tool: 'fill_field', success: false,
      error: `No input found with label "${label}"`,
    };
  }

  const res = await _typeInElement(inputMatch.selector, String(value));
  if (res.success) {
    return {
      type: 'action_result', tool: 'fill_field', success: true,
      details: `Filled "${label}" with "${String(value).slice(0, 30)}"`,
    };
  }
  return { type: 'action_result', tool: 'fill_field', success: false, error: res.error };
}

// ── Navigation helpers ────────────────────────────────────────────────────────

/**
 * After a DOM click, wait up to ~1.5 s to see if it triggered a page navigation.
 *
 * Strategy: set awaitingPageLoad BEFORE polling (optimistic) — if the page
 * unloads before we can detect it, resumeAgentLoop will still pick up correctly.
 * If no navigation happens within the timeout, clear the flag and auto-capture.
 *
 * Returns { navigated: true } or { navigated: false, capture }
 */
async function _waitForNavOrCapture(conversationId, priorUrl) {
  // Optimistically mark as awaiting so a surprise unload is survivable.
  await store.updateAgentSession(conversationId, {
    awaitingPageLoad: true,
    lastNavUrl: priorUrl,
  });

  const POLL_INTERVAL = 100;
  const MAX_POLLS = 15; // 1500 ms total

  for (let i = 0; i < MAX_POLLS; i++) {
    await _wait(POLL_INTERVAL);
    // If the document is gone or the URL changed, navigation is confirmed.
    try {
      if (window.location.href !== priorUrl) {
        // URL changed — navigation confirmed, keep awaitingPageLoad set.
        return { navigated: true };
      }
    } catch {
      // Can happen if page is unloading — treat as navigation.
      return { navigated: true };
    }
  }

  // No navigation detected — clear the flag and capture current page state.
  await store.updateAgentSession(conversationId, { awaitingPageLoad: false });
  const capture = await _autoCapture();
  return { navigated: false, capture };
}

/**
 * click_link: find an anchor element by its visible label text, extract the real
 * href from the DOM, and navigate via chrome.tabs.update (never uses an LLM URL).
 */
async function _clickLink(text, conversationId) {
  // Search all elements, then filter / prefer anchors.
  let search = searchPage(text);

  // If nothing found on the visible viewport, scroll and retry once.
  if (search.matches.length === 0) {
    window.scrollBy(0, 500);
    await _wait(400);
    search = searchPage(text);
  }

  if (search.matches.length === 0) {
    return {
      type: 'action_result', tool: 'click_link', success: false,
      error: `No link found matching "${text}"`,
    };
  }

  // Prefer <a> elements; fall back to any match.
  const anchors = search.matches.filter((m) => m.tag === 'a');
  const candidates = anchors.length > 0 ? anchors : search.matches;

  for (const match of candidates.slice(0, 4)) {
    let el = null;
    try { el = document.querySelector(match.selector); } catch { /* bad selector */ }
    if (!el) continue;

    // Get the resolved href (browser normalises relative URLs automatically).
    const href = el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href');

    if (href && href.startsWith('http') && !href.startsWith('javascript')) {
      // Navigate via the reliable chrome.tabs.update path.
      const navResult = await _doNavigate(href, conversationId);
      if (navResult.success) {
        return {
          type: 'action_result', tool: 'click_link', success: true,
          details: `Navigating to "${match.label || text}"`,
          navigated: true,
        };
      }
    } else {
      // No href or javascript: link — fall back to a DOM click and detect navigation.
      const priorUrl = window.location.href;
      await _clickElement(match.selector, match.label);
      const navOrCapture = await _waitForNavOrCapture(conversationId, priorUrl);
      if (navOrCapture.navigated) {
        return {
          type: 'action_result', tool: 'click_link', success: true,
          details: `Clicked "${match.label || text}" — navigating`,
          navigated: true,
        };
      }
      // Click didn't navigate — clear optimistic flag and try next candidate.
      await store.updateAgentSession(conversationId, { awaitingPageLoad: false });
    }
  }

  return {
    type: 'action_result', tool: 'click_link', success: false,
    error: `Found "${text}" but could not navigate to it`,
  };
}

export async function scrollPage(direction) {
  const AMOUNT = 400;
  switch (direction) {
    case 'down':   window.scrollBy(0, AMOUNT); break;
    case 'up':     window.scrollBy(0, -AMOUNT); break;
    case 'top':    window.scrollTo(0, 0); break;
    case 'bottom': window.scrollTo(0, document.body.scrollHeight); break;
    default:       window.scrollBy(0, AMOUNT);
  }
  await _wait(300);
  return { type: 'action_result', tool: 'scroll', success: true, details: `Scrolled ${direction}` };
}

// ── Screenshot ────────────────────────────────────────────────────────────────

export async function captureScreenshot() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
    if (response?.error) throw new Error(response.error);
    return response?.screenshot || null;
  } catch {
    return null;
  }
}

/**
 * Auto-capture after any state-changing action.
 * Returns { screenshot, sections } bundled for the next /agent/step request.
 * We hide the Guidely sidebar so it doesn't appear in the screenshot.
 */
async function _autoCapture() {
  const sidebarEl = document.getElementById('g-sidebar');
  const floatBtn = document.getElementById('guidely-btn');
  const prevSidebar = sidebarEl?.style.visibility ?? '';
  const prevBtn = floatBtn?.style.visibility ?? '';

  if (sidebarEl) sidebarEl.style.visibility = 'hidden';
  if (floatBtn) floatBtn.style.visibility = 'hidden';

  // Two rAF + 30 ms to let the compositor process the visibility change.
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))),
  );

  let screenshot = null;
  try { screenshot = await captureScreenshot(); } catch { /* ignore */ }

  if (sidebarEl) sidebarEl.style.visibility = prevSidebar;
  if (floatBtn) floatBtn.style.visibility = prevBtn;

  const sections = getPageSections();
  return { screenshot, sections };
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _getLabel(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  const lbId = el.getAttribute('aria-labelledby');
  if (lbId) {
    try {
      const lbEl = document.getElementById(lbId);
      if (lbEl?.innerText?.trim()) return lbEl.innerText.trim().slice(0, 60);
    } catch { /* ignore */ }
  }
  if (el.placeholder) return el.placeholder.trim();
  if (el.title?.trim()) return el.title.trim().slice(0, 60);
  if (el.innerText?.trim()) return el.innerText.trim().slice(0, 60);
  if ((el.type === 'submit' || el.type === 'button') && el.value) return el.value.trim().slice(0, 60);
  if (el.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.innerText?.trim()) return label.innerText.trim().slice(0, 60);
    } catch { /* ignore */ }
  }
  if (el.name?.trim()) return el.name.trim().slice(0, 60);
  return null;
}

function _isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

function _getSelector(el) {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    const candidate = `${tag}${classes}`;
    if (document.querySelectorAll(candidate).length === 1) return candidate;
    const parent = el.parentElement;
    if (parent) {
      let siblings;
      try { siblings = Array.from(parent.querySelectorAll(tag)); } catch { siblings = [el]; }
      const idx = siblings.indexOf(el) + 1;
      return `${_getSelector(parent)} > ${tag}:nth-of-type(${idx})`;
    }
    return tag;
  } catch {
    return el.tagName?.toLowerCase() || '*';
  }
}

function _isSafeSelector(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || t.length > 512) return false;
  if (/:(contains|has-text|matches-css)\s*\(/i.test(t)) return false;
  if (/\/\/|xpath|\$\s*\(|\beval\b/i.test(t)) return false;
  return true;
}

function _wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Agent loop public API ─────────────────────────────────────────────────────

// ── Summarize mode (one-shot) ─────────────────────────────────────────────────

/**
 * Take a fresh screenshot + extract visible text → ask backend to summarize.
 * No loop, no planning — one request in, one plain-English response out.
 *
 * @param {string} conversationId
 * @param {string} userQuestion  What the user asked ("summarize what I see", etc.)
 * @param {{ onMessage, onDone, onError, onStatusChange }} callbacks
 */
export async function runSummarize(conversationId, userQuestion, callbacks = {}) {
  const { onMessage, onDone, onError, onStatusChange } = callbacks;
  if (_loopRunning) return;

  await store.setAgentStatus(conversationId, 'running');
  onStatusChange?.('running');
  onMessage?.({ role: 'system', content: 'Reading what\'s on your screen…' });

  const { screenshot } = await _autoCapture();
  const pageText = (document.body?.innerText || '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .slice(0, 8000);

  _guidelyLog('summarize', {
    conversationId,
    pageTextChars: pageText.length,
    screenshotB64Chars: (screenshot || '').length,
    questionPreview: String(userQuestion || '').slice(0, 120),
  });

  try {
    const result = await summarizePage({
      screenshot,
      pageText,
      pageUrl: window.location.href,
      pageTitle: document.title,
      userQuestion,
    });
    const summary = result?.summary || 'I couldn\'t read this page clearly. Please try again.';
    _guidelyLog('summarize:ok', {
      summaryChars: summary.length,
      model: result?.model_used ?? null,
    });
    onMessage?.({ role: 'assistant', content: summary });
  } catch (err) {
    _guidelyLog('summarize:error', { message: err?.message || String(err) });
    onError?.(`Couldn't summarize: ${err.message}`);
    await store.setAgentStatus(conversationId, 'error');
    onStatusChange?.('error');
    return;
  }

  await store.setAgentStatus(conversationId, 'idle');
  onDone?.();
}

// ── Guide mode (highlight-only) ───────────────────────────────────────────────

/**
 * Take a fresh screenshot + build a compact DOM map → ask backend to identify
 * the one element the user should interact with → highlight it.
 * No navigation, no clicking, no form filling.
 *
 * @param {string} conversationId
 * @param {string} userQuestion  The user's goal ("where do I click to renew?", etc.)
 * @param {Function} highlightFn  content.js highlightElement(selector, label)
 * @param {{ onMessage, onDone, onError, onStatusChange }} callbacks
 */
export async function runGuideMode(conversationId, userQuestion, highlightFn, callbacks = {}) {
  const { onMessage, onDone, onError, onStatusChange } = callbacks;
  if (_loopRunning) return;

  await store.setAgentStatus(conversationId, 'running');
  onStatusChange?.('running');
  onMessage?.({ role: 'system', content: 'Looking at your screen to find what you should click…' });

  const { screenshot, sections } = await _autoCapture();

  // Build a flat element list from every section.
  // Exclude Guidely's own sidebar elements (they live inside #g-sidebar).
  const sidebarEl = document.getElementById('g-sidebar');
  // selectorMap: index (1-based) → full original selector, used for highlighting.
  const selectorMap = {};
  const allElements = [];
  for (const sec of (sections?.sections || [])) {
    const secElements = getElementsInSection(sec.id);
    for (const el of (secElements?.elements || [])) {
      // Skip elements that belong to Guidely's own UI.
      try {
        const node = document.querySelector(el.selector);
        if (node && sidebarEl && sidebarEl.contains(node)) continue;
      } catch { /* bad selector — keep it */ }
      // Strip surrogate characters that would break UTF-8 encoding.
      const safeLabel = (el.label || '').replace(/[\uD800-\uDFFF]/g, '').trim();
      const safeSelector = (el.selector || '').replace(/[\uD800-\uDFFF]/g, '');
      // Skip unlabelled links (label is literally "a") — not useful to the model.
      if (!safeLabel || safeLabel === 'a') continue;
      const idx = allElements.length + 1;
      // Store the FULL selector locally for highlighting.
      selectorMap[idx] = safeSelector;
      // Send the model only a short display selector (ID/class prefix ≤80 chars) to keep
      // the prompt compact — the model picks by index, not by reproducing the full path.
      const displaySelector = safeSelector.length > 80 ? safeSelector.slice(0, 80) + '…' : safeSelector;
      allElements.push({ tag: el.tag, label: safeLabel, selector: displaySelector, idx });
      if (allElements.length >= 60) break;
    }
    if (allElements.length >= 60) break;
  }

  // Format as a numbered list. Model is asked to reply with the item number.
  const domMap = allElements.length > 0
    ? allElements.map((el) =>
        `${el.idx}. [${el.tag}] "${el.label}" — selector: ${el.selector}`
      ).join('\n')
    : '(no interactive elements found)';

  _guidelyLog('guide:prepare', {
    conversationId,
    sectionCount: (sections?.sections || []).length,
    candidateElements: allElements.length,
    domMapChars: domMap.length,
    screenshotB64Chars: (screenshot || '').length,
    questionPreview: String(userQuestion || '').slice(0, 120),
  });
  _guidelyLogVerbose('guide:dom_map', {
    head: domMap.slice(0, 1200),
  });

  try {
    const result = await guideMode({
      screenshot,
      pageUrl: window.location.href,
      pageTitle: document.title,
      domSummary: domMap,
      userQuestion,
    });

    const instruction = result?.instruction || 'I couldn\'t identify the right element. Please try again.';
    onMessage?.({ role: 'assistant', content: instruction });

    // Resolve the selector: prefer looking up the full selector from selectorMap
    // using the item number the model returned, fall back to the model's raw selector,
    // then fall back to a label-based fuzzy search in highlightFn.
    let resolvedSelector = null;
    let resolveSource = 'none';
    if (result?.item_number && selectorMap[result.item_number]) {
      resolvedSelector = selectorMap[result.item_number];
      resolveSource = 'item_number_map';
    } else if (result?.selector) {
      // Try the model's selector directly (works when it's an ID like #avWBGd-9).
      resolvedSelector = result.selector;
      resolveSource = 'model_selector';
    }

    _guidelyLog('guide:response', {
      item_number: result?.item_number ?? null,
      label: result?.label ? String(result.label).slice(0, 80) : null,
      modelSelectorChars: result?.selector ? String(result.selector).length : 0,
      resolvedSelectorChars: resolvedSelector ? resolvedSelector.length : 0,
      resolveSource,
      mapHasItem: !!(result?.item_number && selectorMap[result.item_number]),
    });
    _guidelyLogVerbose('guide:selectors', {
      modelSelector: result?.selector || null,
      resolvedHead: resolvedSelector ? resolvedSelector.slice(0, 200) : null,
    });

    if (highlightFn && (resolvedSelector || result?.label)) {
      // Longer pulse for guide mode so users can find the control (onDone no longer clears it).
      highlightFn(resolvedSelector, result?.label || null, { durationMs: 90000 });
    } else {
      _guidelyLog('guide:highlight_skipped', {
        hasHighlightFn: !!highlightFn,
        hasResolved: !!resolvedSelector,
        hasLabel: !!result?.label,
      });
    }
  } catch (err) {
    _guidelyLog('guide:error', { message: err?.message || String(err) });
    onError?.(`Couldn't identify element: ${err.message}`);
    await store.setAgentStatus(conversationId, 'error');
    onStatusChange?.('error');
    return;
  }

  await store.setAgentStatus(conversationId, 'idle');
  onDone?.({ keepHighlight: true });
}

/**
 * Start a new agent loop for a goal.
 * 1. Calls /agent/start to generate a plan.
 * 2. Saves the plan to chrome.storage.local.
 * 3. Runs the first step with the initial page context.
 *
 * @param {string} conversationId
 * @param {string} goal
 * @param {{ onToolCall, onMessage, onDone, onError, onStatusChange }} callbacks
 */
export async function startAgentLoop(conversationId, goal, callbacks = {}) {
  const { onMessage, onError } = callbacks;

  if (_loopRunning) return;
  await store.setAgentStatus(conversationId, 'running');

  // Take a fresh screenshot before planning so the model sees current state.
  const { screenshot: freshScreenshot, sections: freshSections } = await _autoCapture();

  // Seed plan with a compact page summary (first ~5 section labels).
  const sections = freshSections || getPageSections();
  const domSummary = sections.sections
    .slice(0, 5)
    .map((s) => `${s.label} (${s.element_count})`)
    .join(', ');

  onMessage?.({ role: 'system', content: `Planning how to: "${goal}"…` });

  let planData;
  try {
    planData = await agentStart({
      goal,
      pageUrl: window.location.href,
      pageTitle: document.title,
      domSummary,
    });
  } catch (err) {
    onError?.(`Couldn't create a plan: ${err.message}`);
    await store.setAgentStatus(conversationId, 'error');
    return;
  }

  await store.attachWorkflow(conversationId, planData.plan);

  // If the planner detected missing required details, surface the clarifying
  // question immediately — no browsing, no step loop.
  if (planData.plan.clarification_question) {
    const question = planData.plan.clarification_question;
    await store.updateAgentSession(conversationId, {
      status: 'paused',
      pendingUserQuestion: question,
    });
    callbacks.onMessage?.({ role: 'assistant', content: question });
    callbacks.onStatusChange?.('paused');
    return;
  }

  onMessage?.({ role: 'system', content: `Starting with ${planData.plan.steps.length} step${planData.plan.steps.length > 1 ? 's' : ''} — more will be planned as we go.` });

  // Pass the fresh screenshot we captured pre-plan, plus the page sections.
  await _runLoop(conversationId, callbacks, { screenshot: freshScreenshot || null, observation: sections });
}

/**
 * Resume the agent loop after a page navigation.
 * Called from content.js init() when agentSession.awaitingPageLoad is true.
 */
export async function resumeAgentLoop(conversationId, callbacks = {}) {
  if (_loopRunning) return;
  // Brief wait for the new page to fully render.
  await _wait(1000);

  // Auto-capture the new page state; the LLM immediately sees where it landed.
  const { screenshot, sections } = await _autoCapture();

  await store.updateAgentSession(conversationId, { awaitingPageLoad: false });
  await _runLoop(conversationId, callbacks, { screenshot, observation: sections });
}

/**
 * Resume the loop after the user answered an ask_user question.
 */
export async function respondToUserQuestion(conversationId, answer, callbacks = {}) {
  if (_loopRunning) return;
  const session = await store.getAgentSession(conversationId);
  if (!session || session.status !== 'paused') return;

  await store.setAgentStatus(conversationId, 'running');

  // Take a fresh screenshot so the model sees the current page state.
  const { screenshot: freshScreenshot } = await _autoCapture();

  // Surface the user's reply as an action result so the LLM understands the answer.
  const answerObs = {
    type: 'action_result', tool: 'ask_user', success: true,
    details: `User replied: "${String(answer).slice(0, 200)}"`,
  };
  await _runLoop(conversationId, callbacks, { screenshot: freshScreenshot || null, observation: answerObs });
}

/**
 * Handle the user's response to an ask_action prompt.
 *
 * choice: 'do_it'    — agent executes the identified action automatically.
 * choice: 'guide_me' — agent calls done with a plain-English instruction
 *                      pointing to the already-highlighted element.
 */
export async function respondToActionChoice(conversationId, choice, callbacks = {}) {
  if (_loopRunning) return;
  const session = await store.getAgentSession(conversationId);
  if (!session || session.status !== 'paused') return;

  const selector = session.pendingActionSelector || null;
  const label = session.pendingActionLabel || '';

  await store.setAgentStatus(conversationId, 'running');

  if (choice === 'do_it') {
    // Inject an observation that tells the model to go ahead and click.
    const obs = {
      type: 'action_result', tool: 'ask_action', success: true,
      details: `User chose: do it for me. Use find_and_click or click to activate: label="${label}" selector="${selector}".`,
    };
    await _runLoop(conversationId, callbacks, { screenshot: null, observation: obs });
  } else {
    // 'guide_me' — tell the model to summarise with a pointer to the element.
    const obs = {
      type: 'action_result', tool: 'ask_action', success: true,
      details: `User chose: show me where. Call done with a friendly plain-English instruction telling the user to click the highlighted element: label="${label}".`,
    };
    await _runLoop(conversationId, callbacks, { screenshot: null, observation: obs });
  }
}

/**
 * Continue an existing conversation after the agent has become idle.
 *
 * This covers two cases:
 *   1. The agent called `done` but the user sends a follow-up message.
 *   2. The original goal was too vague (e.g. "book a flight") and the agent
 *      asked a clarifying question; the user's reply is now in `userMessage`.
 *
 * The follow-up is appended to the persistent chat history so the model can
 * see it in `chat_history` on the very next step. Then the loop restarts with
 * the same plan and goal, giving the model full conversational context.
 */
export async function continueAgentLoop(conversationId, userMessage, callbacks = {}) {
  if (_loopRunning) return;
  const session = await store.getAgentSession(conversationId);
  if (!session) return;

  // Only re-enter when idle (task finished or clarification needed).
  if (session.status !== 'idle') return;

  await store.setAgentStatus(conversationId, 'running');

  // Take a fresh screenshot so the model sees the current page state.
  const { screenshot: freshScreenshot } = await _autoCapture();

  // Surface the user's message as an observation so the LLM sees it immediately.
  const obs = {
    type: 'action_result', tool: 'ask_user', success: true,
    details: `User follow-up: "${String(userMessage).slice(0, 200)}"`,
  };
  await _runLoop(conversationId, callbacks, { screenshot: freshScreenshot || null, observation: obs });
}

// ── Core loop ─────────────────────────────────────────────────────────────────

async function _runLoop(conversationId, callbacks = {}, initial = {}) {
  if (_loopRunning) return;
  _loopRunning = true;

  const { onToolCall, onMessage, onDone, onError, onStatusChange, onStartStreaming, onActionChoice } = callbacks;

  let currentScreenshot = initial.screenshot || null;
  let currentObservation = initial.observation || null;
  let callCount = 0;
  // Track the "mark done" handle from the previous iteration's tool-call bubble.
  // We flip it to a checkmark at the start of the NEXT thinking phase — this
  // gives the user a clean sequence: tool fires → spinner → thinking → checkmark.
  let prevMarkToolDone = null;

  try {
    while (callCount < MAX_LOOP_CALLS) {
      callCount++;

      // Flip the previous tool-call bubble spinner to a checkmark now that
      // we are about to start thinking about the next action.
      prevMarkToolDone?.();
      prevMarkToolDone = null;

      // Re-read conversation state on every iteration (may have changed).
      const conv = await store.getActive();
      if (!conv || conv.id !== conversationId) break;

      const session = await store.getAgentSession(conversationId);
      if (!session) break;
      if (session.status === 'done' || session.status === 'error') break;
      if (session.status === 'paused') break;

      const plan = conv.workflow;
      if (!plan) {
        onError?.('No plan found. Please start a new conversation.');
        await store.setAgentStatus(conversationId, 'error');
        break;
      }

      onStatusChange?.('running');

      // ── Call backend (streaming) ────────────────────────────────────────────
      // Start a live "Thinking…" bubble in the sidebar immediately.
      const streamBubble = onStartStreaming?.() ?? { updateThought() {}, markSearching() {}, markReplanning() {}, dismiss() {} };

      let response = null;
      let streamError = null;

      // Gather the last 10 chat messages to give the model conversational context.
      const chatHistory = (conv.messages || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

      await agentStepStream(
        {
          goal: plan.goal,
          plan: {
            goal: plan.goal,
            steps: plan.steps,
            current_step_idx: plan.currentStepIdx,
          },
          conversationId,
          lastToolCalls: session.toolHistory || [],
          pageUrl: window.location.href,
          pageTitle: document.title,
          screenshot: currentScreenshot,
          observation: currentObservation,
          retryCount: session.retryCount || 0,
          loopIteration: callCount,
          chatHistory,
        },
        {
          onThinking: () => { /* bubble already shown */ },
          onThought:  (text) => streamBubble.updateThought(text),
          onSearching: (query) => streamBubble.markSearching(query),
          onReplanning: (reason) => streamBubble.markReplanning(reason),
          onDone: (result) => { response = result; },
          onError: (msg) => { streamError = msg; },
        },
      );

      // Remove the streaming thought bubble before showing the tool-call bubble.
      streamBubble.dismiss();

      if (streamError) {
        onError?.(`Connection error: ${streamError}`);
        await store.setAgentStatus(conversationId, 'error');
        break;
      }
      if (!response) {
        onError?.('No response received from backend.');
        await store.setAgentStatus(conversationId, 'error');
        break;
      }

      const { tool: rawTool, params = {}, display, thought, new_steps } = response;
      // Normalise tool name — catches near-miss hallucinations before dispatch.
      const tool = _normaliseTool(rawTool || 'ask_user');
      console.log(
        '[Guidely] tool received',
        { rawTool, normalised: tool, params, display, callCount },
      );

      // Reset for the next iteration.
      currentScreenshot = null;
      currentObservation = null;

      // Show the tool-call activity bubble. We get back a `markDone` handle
      // to flip the spinner to a checkmark once the tool has actually run.
      const markDoneRef = { fn: null };
      if (display) onToolCall?.({ tool, params, display, markDoneRef });
      const markToolDone = () => markDoneRef.fn?.();
      // Save for the next iteration to call at the top of the thinking phase.
      prevMarkToolDone = markToolDone;

      // ── Control tools ───────────────────────────────────────────────────────

      if (tool === 'done') {
        markToolDone();
        const msg = String(params?.message || 'Task complete!');
        // Use 'idle' instead of 'done' so the user can send a follow-up message.
        await store.setAgentStatus(conversationId, 'idle');
        onMessage?.({ role: 'assistant', content: msg });
        onDone?.();
        break;
      }

      if (tool === 'ask_user') {
        markToolDone();
        const question = String(params?.question || 'What would you like me to do?');
        await store.updateAgentSession(conversationId, {
          status: 'paused',
          pendingUserQuestion: question,
        });
        onMessage?.({ role: 'assistant', content: question });
        onStatusChange?.('paused');
        break;
      }

      if (tool === 'ask_action') {
        markToolDone();
        const question = String(params?.question || 'I found the element. Would you like me to act on it?');
        const selector = params?.selector || null;
        const label = String(params?.label || '');
        // Save the pending action context so the loop can execute it if the user chooses "do it".
        await store.updateAgentSession(conversationId, {
          status: 'paused',
          pendingUserQuestion: question,
          pendingActionSelector: selector,
          pendingActionLabel: label,
        });
        // Fire the highlight callback — content.js will highlight the element.
        onActionChoice?.({ question, selector, label });
        onStatusChange?.('paused');
        break;
      }

      if (tool === 'complete_step') {
        const evidence = String(params?.evidence || '');
        const currentStep = plan.steps[plan.currentStepIdx];
        if (currentStep) {
          await store.applyStepUpdate(conversationId, { step_id: currentStep.id, status: 'done' });
        }
        await store.updateAgentSession(conversationId, { retryCount: 0 });
        await store.addToToolHistory(conversationId, { tool, params, result: { evidence }, calledAt: Date.now() });

        // Check if all currently-planned steps are done.
        const updatedConv = await store.getActive();
        const allDone = updatedConv?.workflow?.steps?.every(
          (s) => s.status === 'done' || s.status === 'skipped',
        );
        if (allDone) {
          // Rolling-horizon: ask the backend whether the goal is truly complete
          // or whether 2-3 more steps are needed based on the current page state.
          onMessage?.({ role: 'system', content: 'Checking if there are more steps needed…' });
          let extended = false;
          try {
            const wf = updatedConv.workflow;
            const completedDescriptions = wf.steps
              .filter((s) => s.status === 'done' || s.status === 'skipped')
              .map((s) => s.description);
            const freshSections = getPageSections();
            const domSummary = freshSections.sections
              .slice(0, 5).map((s) => `${s.label} (${s.element_count})`).join(', ');

            const extResp = await extendWorkflow({
              goal: wf.goal,
              completedSteps: completedDescriptions,
              existingStepCount: wf.steps.length,
              pageUrl: window.location.href,
              pageTitle: document.title,
              domSummary,
            });

            if (!extResp?.done && extResp?.steps?.length) {
              await store.appendWorkflowSteps(conversationId, extResp.steps);
              onMessage?.({
                role: 'system',
                content: `${extResp.steps.length} more step${extResp.steps.length > 1 ? 's' : ''} planned — continuing…`,
              });
              currentObservation = freshSections;
              extended = true;
            }
          } catch { /* best-effort — fall through to done if extend fails */ }

          if (!extended) {
            const msg = 'All done! The task is complete.';
            // Use 'idle' so the user can ask follow-up questions without starting a new session.
            await store.setAgentStatus(conversationId, 'idle');
            onMessage?.({ role: 'assistant', content: msg });
            onDone?.();
            break;
          }
          continue;
        }

        // More steps remain in the current plan — proceed.
        currentObservation = getPageSections();
        continue;
      }

      if (tool === 'replan') {
        if (new_steps && new_steps.length > 0) {
          await store.replanWorkflow(conversationId, new_steps);
          const reason = String(params?.reason || '');
          onMessage?.({ role: 'system', content: `Replanning: ${reason}` });
          await store.updateAgentSession(conversationId, { retryCount: 0 });
          await store.addToToolHistory(conversationId, { tool, params, result: { new_steps }, calledAt: Date.now() });
        } else {
          // Replan generation failed — surface to user.
          const q = "I'm stuck and couldn't figure out a new plan. Can you tell me what you see on the page?";
          await store.updateAgentSession(conversationId, { status: 'paused', pendingUserQuestion: q });
          onMessage?.({ role: 'assistant', content: q });
          onStatusChange?.('paused');
          break;
        }
        currentObservation = getPageSections();
        continue;
      }

      // ── Observation tools ───────────────────────────────────────────────────

      if (tool === 'get_sections') {
        const result = getPageSections();
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'get_elements') {
        const sectionId = String(params?.section_id || 'gs-0');
        const result = getElementsInSection(sectionId);
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'search_page') {
        const query = String(params?.query || '');
        const result = searchPage(query);
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'get_page_text') {
        const sectionId = params?.section_id ? String(params.section_id) : null;
        const result = getPageText(sectionId);
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'screenshot') {
        const shot = await captureScreenshot();
        currentScreenshot = shot;
        currentObservation = { type: 'action_result', tool: 'screenshot', success: !!shot };
        await store.addToToolHistory(conversationId, { tool, params, result: { captured: !!shot }, calledAt: Date.now() });
        continue;
      }

      // ── Macro action tools ──────────────────────────────────────────────────

      if (tool === 'find_and_click') {
        const text = String(params?.text || '');
        const priorUrl = window.location.href;
        const result = await findAndClick(text);
        await _recordRetry(conversationId, result.success);

        if (result.success) {
          const navOrCapture = await _waitForNavOrCapture(conversationId, priorUrl);
          if (navOrCapture.navigated) {
            markToolDone();
            await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
            break;
          }
          currentScreenshot = navOrCapture.capture.screenshot;
          currentObservation = { ...result, type: 'action_result', sections: navOrCapture.capture.sections.sections };
        } else {
          currentObservation = result;
        }
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'fill_field') {
        const label = String(params?.label || '');
        const value = String(params?.value || '');
        const result = await fillField(label, value);
        await _recordRetry(conversationId, result.success);
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'click_link') {
        const text = String(params?.text || '');
        const result = await _clickLink(text, conversationId);
        await _recordRetry(conversationId, result.success);
        if (result.navigated) {
          markToolDone();
          await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
          break;
        }
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'navigate_and_read') {
        // Legacy alias — treat as navigate.
        const url = String(params?.url || '');
        const navResult = await _doNavigate(url, conversationId);
        if (!navResult.success) {
          currentObservation = navResult;
          await _recordRetry(conversationId, false);
          await store.addToToolHistory(conversationId, { tool, params, result: navResult, calledAt: Date.now() });
          continue;
        }
        markToolDone();
        await store.addToToolHistory(conversationId, { tool, params, result: navResult, calledAt: Date.now() });
        break;
      }

      // ── Direct action tools ─────────────────────────────────────────────────

      if (tool === 'click') {
        const selector = String(params?.selector || '');
        const label = params?.label ? String(params.label) : undefined;
        const priorUrl = window.location.href;
        const result = await _clickElement(selector, label);
        await _recordRetry(conversationId, result.success);

        if (result.success) {
          const navOrCapture = await _waitForNavOrCapture(conversationId, priorUrl);
          if (navOrCapture.navigated) {
            markToolDone();
            await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
            break;
          }
          currentScreenshot = navOrCapture.capture.screenshot;
          currentObservation = {
            type: 'action_result', tool: 'click', ...result,
            sections: navOrCapture.capture.sections.sections,
          };
        } else {
          currentObservation = { type: 'action_result', tool: 'click', ...result };
        }
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'type_text') {
        const selector = String(params?.selector || '');
        const text = String(params?.text || '');
        const result = await _typeInElement(selector, text);
        await _recordRetry(conversationId, result.success);
        currentObservation = { type: 'action_result', tool: 'type_text', ...result };
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'scroll') {
        const direction = String(params?.direction || 'down');
        const result = await scrollPage(direction);
        currentObservation = result;
        await store.addToToolHistory(conversationId, { tool, params, result, calledAt: Date.now() });
        continue;
      }

      if (tool === 'navigate') {
        const url = String(params?.url || '');
        const navResult = await _doNavigate(url, conversationId);
        if (!navResult.success) {
          currentObservation = navResult;
          await _recordRetry(conversationId, false);
          await store.addToToolHistory(conversationId, { tool, params, result: navResult, calledAt: Date.now() });
          continue;
        }
        markToolDone(); // flip spinner before the page unloads
        await store.addToToolHistory(conversationId, { tool, params, result: navResult, calledAt: Date.now() });
        break;
      }

      // Unknown tool — log loudly and surface a clear message to the user.
      {
        console.error(
          '[Guidely] UNKNOWN_TOOL — this should not happen. Check backend logs.',
          { rawTool, normalisedTool: tool, params, display, response, callCount },
        );
        markToolDone();
        const q = `I tried to use an unknown action (${tool}). Can you tell me what to do next?`;
        await store.updateAgentSession(conversationId, { status: 'paused', pendingUserQuestion: q });
        onMessage?.({ role: 'assistant', content: q });
        onStatusChange?.('paused');
        break;
      }
    }

    if (callCount >= MAX_LOOP_CALLS) {
      const msg =
        'I stopped after many steps to avoid running forever. Tell me what to do next and I\'ll continue.';
      onMessage?.({ role: 'assistant', content: msg });
      await store.setAgentStatus(conversationId, 'idle');
      onDone?.();
    }
  } finally {
    prevMarkToolDone?.(); // Mark last tool done before the loop fully exits.
    _loopRunning = false;
    onStatusChange?.('idle');
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _doNavigate(url, conversationId) {
  let validUrl;
  try {
    validUrl = new URL(url);
    if (validUrl.protocol !== 'http:' && validUrl.protocol !== 'https:') {
      throw new Error('Only http/https URLs are allowed');
    }
  } catch (err) {
    return {
      type: 'action_result', tool: 'navigate', success: false,
      error: String(err?.message || 'Invalid URL'),
    };
  }

  // Save navigation state so resumeAgentLoop() knows to pick up where we left off.
  await store.updateAgentSession(conversationId, {
    awaitingPageLoad: true,
    lastNavUrl: validUrl.href,
  });

  try {
    await chrome.runtime.sendMessage({ type: 'NAVIGATE', url: validUrl.href });
  } catch (err) {
    await store.updateAgentSession(conversationId, { awaitingPageLoad: false });
    return {
      type: 'action_result', tool: 'navigate', success: false,
      error: String(err?.message || 'Navigation failed'),
    };
  }

  // Page is about to reload — content script will be destroyed.
  return { type: 'action_result', tool: 'navigate', success: true, details: `Navigating to ${validUrl.href}` };
}

async function _recordRetry(conversationId, success) {
  if (success) {
    await store.updateAgentSession(conversationId, { retryCount: 0 });
  } else {
    const session = await store.getAgentSession(conversationId);
    await store.updateAgentSession(conversationId, { retryCount: (session?.retryCount || 0) + 1 });
  }
}
