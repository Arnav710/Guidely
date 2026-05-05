// ─── DOM Serializer ───────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]';
const MAX_ELEMENTS = 50;
const MAX_HISTORY = 20; // user+assistant pairs for backend context
/** Must match backend `MIN_SCREENSHOT_B64_CHARS` — only send screenshot when base64 is long enough. */
const MIN_SCREENSHOT_B64_CHARS = 80;

const GUIDELY_DEBUG_TRACE = false;

/** Selectors we computed from the live DOM in `buildDomMap` — never pass other strings to querySelector. */
let guidelyTrustedSelectors = new Set();

/** Count matches without throwing on invalid selector strings (should not happen for DOM-built candidates). */
function safeQuerySelectorAllCount(root, sel) {
  if (!sel || typeof sel !== 'string') return 0;
  try {
    return root.querySelectorAll(sel).length;
  } catch {
    return 0;
  }
}

function getLabel(el) {
  // Explicit accessible labels first
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();

  // aria-labelledby: resolve the referenced element's text
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    try {
      const lbEl = document.getElementById(labelledBy);
      if (lbEl && lbEl.innerText.trim()) return lbEl.innerText.trim().slice(0, 60);
    } catch {
      /* ignore */
    }
  }

  // Placeholder (inputs)
  if (el.placeholder) return el.placeholder.trim();

  // title attribute
  if (el.title && el.title.trim()) return el.title.trim().slice(0, 60);

  // Visible text content (buttons, links, labels)
  if (el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 60);

  // value attribute on submit/button inputs
  if ((el.type === 'submit' || el.type === 'button') && el.value) return el.value.trim().slice(0, 60);

  // <label for="id"> association
  if (el.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.innerText.trim()) return label.innerText.trim().slice(0, 60);
    } catch {
      /* invalid id / selector edge case */
    }
  }

  // name attribute as last resort (common on form inputs)
  if (el.name && el.name.trim()) return el.name.trim().slice(0, 60);

  return null;
}

function getSelector(el) {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    const candidate = `${tag}${classes}`;
    if (safeQuerySelectorAllCount(document, candidate) === 1) return candidate;
    const parent = el.parentElement;
    if (parent) {
      let siblings;
      try {
        siblings = Array.from(parent.querySelectorAll(tag));
      } catch {
        siblings = [el];
      }
      const idx = siblings.indexOf(el) + 1;
      const parentSel = getSelector(parent);
      return `${parentSel} > ${tag}:nth-of-type(${idx})`;
    }
    return tag;
  } catch {
    try {
      return el.tagName.toLowerCase();
    } catch {
      return '*';
    }
  }
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function buildDomMap() {
  let elements = [];
  try {
    elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  } catch {
    guidelyTrustedSelectors = new Set();
    return [];
  }
  const map = [];
  let id = 1;
  for (const el of elements) {
    if (map.length >= MAX_ELEMENTS) break;
    try {
      const label = getLabel(el);
      // Build a descriptive fallback so the model still knows what kind of element this is
      const tag = el.tagName.toLowerCase();
      const typeAttr = el.type ? `[type=${el.type}]` : '';
      const fallbackLabel = label || (el.id ? `#${el.id}` : null) || `${tag}${typeAttr}`;
      // Skip elements that are completely non-identifiable (e.g., bare <div tabindex="-1">)
      if (!fallbackLabel || fallbackLabel === 'div' || fallbackLabel === 'span') continue;
      map.push({
        id: id++,
        tag,
        type: el.type || null,
        label: fallbackLabel,
        selector: getSelector(el),
        visible: isVisible(el),
      });
    } catch {
      /* skip hostile or broken nodes */
    }
  }
  guidelyTrustedSelectors = new Set(map.map((m) => m.selector));
  return map;
}

window.__guidely_buildDomMap = buildDomMap;

// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
  #guidely-btn {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483646;
    background: #FF6B35;
    color: white;
    border: none;
    border-radius: 28px;
    padding: 14px 22px;
    font-size: 16px;
    font-family: system-ui, sans-serif;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    transition: background 0.2s;
  }
  #guidely-btn:hover { background: #e05a28; }
  #guidely-btn:disabled { background: #aaa; cursor: not-allowed; }

  #guidely-sidebar {
    position: fixed;
    top: 0;
    right: -400px;
    width: 384px;
    height: 100vh;
    z-index: 2147483645;
    background: #fafafa;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
    font-family: system-ui, -apple-system, sans-serif;
    transition: right 0.3s ease;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 0;
    overflow: hidden;
  }
  #guidely-sidebar.open { right: 0; }

  #guidely-sidebar-header {
    flex-shrink: 0;
    padding: 14px 44px 10px 16px;
    background: white;
    border-bottom: 1px solid #eee;
  }
  #guidely-sidebar-title {
    font-size: 18px;
    font-weight: 700;
    color: #FF6B35;
    margin: 0;
  }
  #guidely-context-hint {
    font-size: 11px;
    color: #888;
    margin: 6px 0 0;
    line-height: 1.35;
  }

  #guidely-chat-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .guidely-msg {
    max-width: 92%;
    padding: 10px 12px;
    border-radius: 14px;
    font-size: 15px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .guidely-msg-user {
    align-self: flex-end;
    background: #FF6B35;
    color: white;
    margin-left: 12%;
  }
  .guidely-msg-assistant {
    align-self: flex-start;
    background: white;
    color: #222;
    border: 1px solid #e8e8e8;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    margin-right: 8%;
  }
  .guidely-msg-error {
    align-self: flex-start;
    background: #fff5f5;
    color: #c0392b;
    border: 1px solid #f5c6cb;
    margin-right: 8%;
  }
  .guidely-msg-system {
    align-self: center;
    max-width: 100%;
    font-size: 12px;
    color: #888;
    background: transparent;
    padding: 4px 8px;
    text-align: center;
  }

  #guidely-meta {
    flex-shrink: 0;
    font-size: 11px;
    color: #999;
    font-family: ui-monospace, monospace;
    padding: 0 14px 8px;
    line-height: 1.35;
  }

  #guidely-composer {
    flex-shrink: 0;
    padding: 10px 12px 14px;
    background: white;
    border-top: 1px solid #eee;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  #guidely-question {
    width: 100%;
    min-height: 72px;
    max-height: 160px;
    padding: 10px 12px;
    font-size: 15px;
    line-height: 1.45;
    border: 1px solid #ddd;
    border-radius: 12px;
    resize: vertical;
    box-sizing: border-box;
    font-family: inherit;
  }
  #guidely-question:focus {
    outline: none;
    border-color: #FF6B35;
    box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.15);
  }
  #guidely-question:disabled {
    background: #f3f3f3;
    color: #888;
  }
  #guidely-send-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
  }
  #guidely-send-hint {
    font-size: 11px;
    color: #aaa;
    flex: 1;
    margin: 0;
  }
  #guidely-send {
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    color: white;
    background: #FF6B35;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
  }
  #guidely-send:hover:not(:disabled) { background: #e05a28; }
  #guidely-send:disabled { background: #aaa; cursor: not-allowed; }

  #guidely-close {
    position: absolute;
    top: 12px;
    right: 12px;
    background: none;
    border: none;
    font-size: 22px;
    cursor: pointer;
    color: #aaa;
    line-height: 1;
    padding: 4px 8px;
  }

  @keyframes guidely-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.5); }
    50%       { box-shadow: 0 0 0 8px rgba(255, 107, 53, 0); }
  }
  #guidely-highlight {
    position: fixed;
    pointer-events: none;
    border: 3px solid #FF6B35;
    border-radius: 8px;
    z-index: 2147483647;
    animation: guidely-pulse 1.2s ease-in-out infinite;
  }
`;

function injectStyles() {
  if (document.getElementById('guidely-styles')) return;
  const style = document.createElement('style');
  style.id = 'guidely-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

// ─── Highlight ────────────────────────────────────────────────────────────────

function clearHighlight() {
  const existing = document.getElementById('guidely-highlight');
  if (existing) existing.remove();
}

/**
 * Resolves a node only for selectors we generated in `buildDomMap` for this tab.
 * The model may return jQuery/XPath/natural-language strings; those are never in the set, so we never
 * call the browser’s querySelector with them (avoids SyntaxError and “line 288” devtools noise).
 */
function safeQuerySelector(sel) {
  if (!sel || typeof sel !== 'string') return null;
  const t = sel.trim();
  if (!t || t.length > 512) return null;
  if (!guidelyTrustedSelectors.has(t)) return null;
  try {
    return document.querySelector(t);
  } catch {
    return null;
  }
}

function labelsRoughlyMatch(mapLabel, wanted) {
  const a = (mapLabel || '').trim().toLowerCase();
  const b = (wanted || '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  const words = (s) => new Set(s.split(/\s+/).filter((w) => w.length > 2));
  const wa = words(a);
  for (const w of words(b)) {
    if (wa.has(w)) return true;
  }
  return false;
}

/**
 * Highlight target element. Never passes the model's raw "selector" string to the DOM API unless it
 * exactly matches a selector we serialized in buildDomMap (trusted set). Junk like button:contains(...)
 * is ignored; we resolve by element_label against a fresh map first.
 */
function highlightElement(selector, elementLabel) {
  try {
    clearHighlight();
    const s = typeof selector === 'string' ? selector.trim() : '';
    const labelRaw = typeof elementLabel === 'string' ? elementLabel.trim() : '';

    let el = null;

    if (labelRaw) {
      const map = buildDomMap();
      for (const item of map) {
        if (!labelsRoughlyMatch(item.label, labelRaw)) continue;
        el = safeQuerySelector(item.selector);
        if (el) break;
      }
    }

    if (!el && s && guidelyTrustedSelectors.has(s)) {
      el = safeQuerySelector(s);
    }

    if (!el) return;

    // Instant scroll so the element is in its final viewport position before we measure.
    // Smooth scroll is animation-based — measuring during animation gives the wrong coordinates.
    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Double rAF: first frame triggers layout after the scroll, second frame ensures the
    // browser has composited the new scroll position so getBoundingClientRect() is accurate.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return; // element not visible, skip
          const overlay = document.createElement('div');
          overlay.id = 'guidely-highlight';
          Object.assign(overlay.style, {
            top: `${rect.top - 4}px`,
            left: `${rect.left - 4}px`,
            width: `${rect.width + 8}px`,
            height: `${rect.height + 8}px`,
          });
          document.body.appendChild(overlay);

          // Auto-remove after 8 seconds so it doesn't stay forever
          setTimeout(clearHighlight, 8000);
        } catch {
          /* ignore overlay failures */
        }
      });
    });
  } catch {
    /* ignore invalid selectors / DOM edge cases */
  }
}

// ─── Chat UI ────────────────────────────────────────────────────────────────

const guidely_history = [];
let guidely_sidebar_wired = false;
let guidely_chat_initialized = false;

function scrollChatToBottom() {
  const el = document.getElementById('guidely-chat-scroll');
  if (el) el.scrollTop = el.scrollHeight;
}

function appendChatMessage(kind, text) {
  const scroll = document.getElementById('guidely-chat-scroll');
  if (!scroll) return;
  const div = document.createElement('div');
  if (kind === 'user') {
    div.className = 'guidely-msg guidely-msg-user';
  } else if (kind === 'error') {
    div.className = 'guidely-msg guidely-msg-error';
  } else if (kind === 'system') {
    div.className = 'guidely-msg guidely-msg-system';
  } else {
    div.className = 'guidely-msg guidely-msg-assistant';
  }
  div.textContent = text;
  scroll.appendChild(div);
  scrollChatToBottom();
}

function setComposerDisabled(disabled) {
  const ta = document.getElementById('guidely-question');
  const send = document.getElementById('guidely-send');
  if (ta) ta.disabled = disabled;
  if (send) send.disabled = disabled;
}

function getOrCreateSidebar() {
  let sidebar = document.getElementById('guidely-sidebar');
  if (sidebar) return sidebar;

  sidebar = document.createElement('div');
  sidebar.id = 'guidely-sidebar';
  sidebar.setAttribute('role', 'dialog');
  sidebar.setAttribute('aria-label', 'Guidely chat');
  sidebar.innerHTML = `
    <button type="button" id="guidely-close" title="Close">✕</button>
    <div id="guidely-sidebar-header">
      <div id="guidely-sidebar-title">💡 Guidely</div>
      <p id="guidely-context-hint">Each send captures a <strong>screenshot</strong> and the page’s <strong>interactive elements</strong> for full visual context.</p>
    </div>
    <div id="guidely-chat-scroll" aria-live="polite"></div>
    <div id="guidely-meta"></div>
    <div id="guidely-composer">
      <textarea id="guidely-question" rows="3" maxlength="2000"
        placeholder="Message Guidely… (Enter to send, Shift+Enter for new line)"
        aria-label="Message to Guidely"></textarea>
      <div id="guidely-send-row">
        <p id="guidely-send-hint">Enter send · Shift+Enter newline</p>
        <button type="button" id="guidely-send">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById('guidely-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
    clearHighlight();
  });

  if (!guidely_sidebar_wired) {
    guidely_sidebar_wired = true;
    const ta = document.getElementById('guidely-question');
    const send = document.getElementById('guidely-send');

    send.addEventListener('click', () => {
      void submitGuidelyMessage().catch(() => {});
    });

    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void submitGuidelyMessage().catch(() => {});
      }
    });
  }

  return sidebar;
}

function ensureWelcomeMessage() {
  if (guidely_chat_initialized) return;
  guidely_chat_initialized = true;
  appendChatMessage(
    'assistant',
    "Hi! Ask anything about this page, or send an empty message for a suggested next step. I'll capture the page and its interactive elements each time you send.",
  );
}

function openAskPanel() {
  injectStyles();
  getOrCreateSidebar();
  ensureWelcomeMessage();
  document.getElementById('guidely-meta').textContent = '';
  document.getElementById('guidely-sidebar').classList.add('open');
  document.getElementById('guidely-question').focus();
}

// ─── Send message (DOM + screenshot always, for full visual context) ─────────

async function captureTabScreenshot() {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
  if (response && response.error) throw new Error(response.error);
  const raw = response && response.screenshot;
  if (typeof raw !== 'string' || !raw.length) {
    throw new Error('No screenshot returned');
  }
  return raw;
}

function captureErrorMessage(err) {
  const detail = err && err.message ? err.message : '';
  const isRestricted =
    /chrome:\/\//i.test(window.location.href) ||
    /^(edge|brave|vivaldi):\/\//i.test(window.location.href);
  const msg = isRestricted
    ? "Guidely can't run on this built-in browser page. Open a normal website."
    : "Couldn't capture this tab. Reload the page or check extension permissions.";
  return msg + (detail ? ` (${detail})` : '');
}

function buildAnalyzeRequestPayload(domMap, questionText, screenshotB64) {
  const payload = {
    dom_map: domMap,
    history: guidely_history,
    question: questionText || null,
    enable_tools: true,
    page_url: window.location.href,
    page_title: document.title || null,
  };
  // Only attach a real base64 string long enough for the backend to accept.
  // Omitting the key entirely (not sending null) is safest for proxy/client compat.
  if (
    typeof screenshotB64 === 'string' &&
    screenshotB64.length >= MIN_SCREENSHOT_B64_CHARS
  ) {
    payload.screenshot = screenshotB64;
  }
  return payload;
}

async function postGuidelyAnalyze(domMap, questionText, screenshotB64) {
  const analyzeUrl = GUIDELY_DEBUG_TRACE
    ? 'http://localhost:8000/analyze?trace=1'
    : 'http://localhost:8000/analyze';
  const res = await fetch(analyzeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildAnalyzeRequestPayload(domMap, questionText, screenshotB64)),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      kind: 'bad_json',
      status: res.status,
      payload: null,
    };
  }

  if (!res.ok) {
    return { ok: false, kind: 'http', status: res.status, payload };
  }

  return { ok: true, data: payload };
}

function formatAnalyzeError(result) {
  if (result.kind === 'bad_json') {
    return `Guidely returned a non-JSON response (HTTP ${result.status}). Is the backend on port 8000?`;
  }
  const payload = result.payload;
  const d = payload && payload.detail;
  if (Array.isArray(d)) {
    return d.map((x) => (x.msg ? `${x.loc?.join?.('.') || ''}: ${x.msg}` : JSON.stringify(x))).join(' ');
  }
  if (typeof d === 'string') {
    return d;
  }
  return JSON.stringify(payload);
}

async function submitGuidelyMessage() {
  const sendBtn = document.getElementById('guidely-send');
  const floatBtn = document.getElementById('guidely-btn');
  const questionEl = document.getElementById('guidely-question');
  const sidebarEl = document.getElementById('guidely-sidebar');
  const raw = (questionEl.value || '').trim();
  const userDisplayText = raw || '(Suggested next step for this page)';

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  if (floatBtn) floatBtn.disabled = true;
  setComposerDisabled(true);
  clearHighlight();
  document.getElementById('guidely-meta').textContent = '';

  appendChatMessage('user', userDisplayText);

  function resetUI() {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    if (floatBtn) floatBtn.disabled = false;
    setComposerDisabled(false);
    if (sidebarEl) sidebarEl.classList.add('open');
  }

  // ── Step 1: Build DOM map ──────────────────────────────────────────────────
  let domMap = [];
  try {
    domMap = buildDomMap();
  } catch {
    domMap = [];
    guidelyTrustedSelectors = new Set();
  }

  // ── Step 2: Capture screenshot — always, so the model always has visual context ──
  // Hide Guidely's own UI during capture so it doesn't obscure the page content.
  let screenshot = null;
  if (sidebarEl) sidebarEl.style.opacity = '0';
  if (floatBtn) floatBtn.style.opacity = '0';
  try {
    // Brief pause so the browser composites the opacity change before capture
    await new Promise((resolve) => setTimeout(resolve, 60));
    screenshot = await captureTabScreenshot();
  } catch (err) {
    // Screenshot failed — continue with DOM-only context; model will still answer
    appendChatMessage('system', `Note: ${captureErrorMessage(err)} — using DOM context only.`);
  } finally {
    if (sidebarEl) sidebarEl.style.opacity = '';
    if (floatBtn) floatBtn.style.opacity = '';
  }

  // ── Step 3: POST to backend (DOM + screenshot if available) ────────────────
  let data;
  try {
    const result = await postGuidelyAnalyze(domMap, raw, screenshot);
    if (!result.ok) {
      appendChatMessage('error', formatAnalyzeError(result) || `Request failed (HTTP ${result.status}).`);
      resetUI();
      return;
    }
    data = result.data;
  } catch {
    appendChatMessage(
      'error',
      'Could not reach Guidely. Start the backend: cd backend && uvicorn main:app --port 8000',
    );
    resetUI();
    return;
  }

  // ── Step 4: Display response ───────────────────────────────────────────────
  appendChatMessage('assistant', data.instruction);

  const meta = document.getElementById('guidely-meta');
  let metaText = data.model_used ? `Model: ${data.model_used}` : '';
  if (data.trace) {
    const t = data.trace;
    const bits = [
      t.ollama_elapsed_ms != null ? `${t.ollama_elapsed_ms} ms` : null,
      t.image_base64_chars != null ? `img ${t.image_base64_chars} chars` : null,
      t.dom_element_count != null ? `dom ${t.dom_element_count}` : null,
    ].filter(Boolean);
    if (bits.length) metaText = [metaText, bits.join(' · ')].filter(Boolean).join(' · ');
  }
  meta.textContent = metaText;

  // ── Step 5: Highlight the referenced element ───────────────────────────────
  try {
    highlightElement(data.selector, data.element_label);
  } catch {
    /* highlight is best-effort; never fail the send flow */
  }

  // ── Step 6: Update history ─────────────────────────────────────────────────
  // Use the same text for both display and history so the model sees what the user actually typed
  guidely_history.push({ role: 'user', content: userDisplayText });
  guidely_history.push({ role: 'assistant', content: data.instruction });
  if (guidely_history.length > MAX_HISTORY) {
    guidely_history.splice(0, guidely_history.length - MAX_HISTORY);
  }

  questionEl.value = '';
  resetUI();
  questionEl.focus();
}

// ─── Floating button ──────────────────────────────────────────────────────────

function getOrCreateButton() {
  let btn = document.getElementById('guidely-btn');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = 'guidely-btn';
  btn.type = 'button';
  btn.textContent = '💡 Help me';
  document.body.appendChild(btn);
  return btn;
}

function init() {
  injectStyles();
  const btn = getOrCreateButton();
  btn.addEventListener('click', openAskPanel);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
