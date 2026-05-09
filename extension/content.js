// ── Guidely content script ────────────────────────────────────────────────────
//
// This file is the entry point injected into every page.
// It owns: DOM serialization, highlight overlay, screenshot capture, the
// floating "Help me" button, and orchestration of the message send flow.
//
// The sidebar UI, conversation storage, and API calls live in the /modules/
// directory and are dynamically imported via chrome.runtime.getURL() so they
// can use ES module syntax (import/export) even from a standard content script.

// ─── DOM Serializer ───────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]';
const MAX_ELEMENTS = 50;
const MIN_SCREENSHOT_B64_CHARS = 80;

let guidelyTrustedSelectors = new Set();

function safeQuerySelectorAllCount(root, sel) {
  if (!sel || typeof sel !== 'string') return 0;
  try { return root.querySelectorAll(sel).length; } catch { return 0; }
}

function getLabel(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    try {
      const lbEl = document.getElementById(labelledBy);
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
      try { siblings = Array.from(parent.querySelectorAll(tag)); } catch { siblings = [el]; }
      const idx = siblings.indexOf(el) + 1;
      return `${getSelector(parent)} > ${tag}:nth-of-type(${idx})`;
    }
    return tag;
  } catch {
    try { return el.tagName.toLowerCase(); } catch { return '*'; }
  }
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return !(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
}

function buildDomMap() {
  let elements = [];
  try { elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)); }
  catch { guidelyTrustedSelectors = new Set(); return []; }
  const map = [];
  let id = 1;
  for (const el of elements) {
    if (map.length >= MAX_ELEMENTS) break;
    try {
      const label = getLabel(el);
      const tag = el.tagName.toLowerCase();
      const typeAttr = el.type ? `[type=${el.type}]` : '';
      const fallback = label || (el.id ? `#${el.id}` : null) || `${tag}${typeAttr}`;
      if (!fallback || fallback === 'div' || fallback === 'span') continue;
      map.push({ id: id++, tag, type: el.type || null, label: fallback, selector: getSelector(el), visible: isVisible(el) });
    } catch { /* skip broken nodes */ }
  }
  guidelyTrustedSelectors = new Set(map.map((m) => m.selector));
  return map;
}

// Expose for manual debugging in DevTools.
window.__guidely_buildDomMap = buildDomMap;

// ─── Floating button styles ───────────────────────────────────────────────────

const BTN_STYLES = `
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
    font-size: 17px;
    font-family: system-ui, sans-serif;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(255,107,53,0.4);
    transition: background 0.2s, transform 0.1s;
    user-select: none;
  }
  #guidely-btn:hover { background: #e05a28; transform: scale(1.04); }
  #guidely-btn:disabled { background: #aaa; cursor: not-allowed; transform: none; }

  @keyframes guidely-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,107,53,0.5); }
    50%       { box-shadow: 0 0 0 10px rgba(255,107,53,0); }
  }
  #guidely-highlight {
    position: fixed;
    pointer-events: none;
    border: 3px solid #FF6B35;
    border-radius: 8px;
    z-index: 2147483647;
    animation: guidely-pulse 1.2s ease-in-out infinite;
    background: rgba(255,107,53,0.04);
  }
`;

function injectBtnStyles() {
  if (document.getElementById('guidely-btn-styles')) return;
  const style = document.createElement('style');
  style.id = 'guidely-btn-styles';
  style.textContent = BTN_STYLES;
  document.head.appendChild(style);
}

// ─── Highlight overlay ────────────────────────────────────────────────────────

function clearHighlight() {
  document.getElementById('guidely-highlight')?.remove();
}

function safeQuerySelector(sel) {
  if (!sel || typeof sel !== 'string') return null;
  const t = sel.trim();
  if (!t || t.length > 512 || !guidelyTrustedSelectors.has(t)) return null;
  try { return document.querySelector(t); } catch { return null; }
}

function labelsRoughlyMatch(a, b) {
  const la = (a || '').trim().toLowerCase();
  const lb = (b || '').trim().toLowerCase();
  if (!la || !lb) return false;
  if (la === lb) return true;
  if (la.length >= 3 && lb.includes(la)) return true;
  if (lb.length >= 3 && la.includes(lb)) return true;
  const words = (s) => new Set(s.split(/\s+/).filter((w) => w.length > 2));
  const wa = words(la);
  for (const w of words(lb)) if (wa.has(w)) return true;
  return false;
}

function highlightElement(selector, elementLabel) {
  try {
    clearHighlight();
    const s = typeof selector === 'string' ? selector.trim() : '';
    const labelRaw = typeof elementLabel === 'string' ? elementLabel.trim() : '';
    let el = null;
    if (labelRaw) {
      for (const item of buildDomMap()) {
        if (!labelsRoughlyMatch(item.label, labelRaw)) continue;
        el = safeQuerySelector(item.selector);
        if (el) break;
      }
    }
    if (!el && s) el = safeQuerySelector(s);
    if (!el) return;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const overlay = document.createElement('div');
        overlay.id = 'guidely-highlight';
        Object.assign(overlay.style, {
          top: `${rect.top - 4}px`, left: `${rect.left - 4}px`,
          width: `${rect.width + 8}px`, height: `${rect.height + 8}px`,
        });
        document.body.appendChild(overlay);
        setTimeout(clearHighlight, 10000);
      } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
}

// ─── Screenshot capture ───────────────────────────────────────────────────────

async function captureTabScreenshot() {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
  if (response?.error) throw new Error(response.error);
  const raw = response?.screenshot;
  if (typeof raw !== 'string' || !raw.length) throw new Error('No screenshot returned');
  return raw;
}

function captureErrorMessage(err) {
  const detail = err?.message || '';
  const isRestricted = /chrome:\/\//i.test(window.location.href) ||
    /^(edge|brave|vivaldi):\/\//i.test(window.location.href);
  return isRestricted
    ? "Guidely can't run on this built-in browser page. Open a normal website."
    : `Couldn't capture this tab.${detail ? ` (${detail})` : ''}`;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────
//
// The store and sidebar are loaded as dynamic ES module imports. This allows
// the modules to use import/export syntax while content.js stays a plain script.
// chrome.runtime.getURL() gives the absolute extension URL for the module file.

let _store = null;
let _sidebar = null;
let _api = null;
let _schema = null;

async function loadModules() {
  if (_store && _sidebar && _api && _schema) return;
  const base = chrome.runtime.getURL('modules/');
  [_store, _api, _schema] = await Promise.all([
    import(`${base}conversation-store.js`),
    import(`${base}api.js`),
    import(`${base}conversation-schema.js`),
  ]);
  const { mountSidebar } = await import(`${base}ui/agent-sidebar.js`);
  _sidebar = await mountSidebar({ onSubmit: handleSubmit });
}

// ─── Message send flow ────────────────────────────────────────────────────────

async function handleSubmit({ conversationId, text, autonomyLevel }) {
  const floatBtn = document.getElementById('guidely-btn');
  if (floatBtn) floatBtn.disabled = true;
  clearHighlight();

  const userDisplayText = text || '(Suggested next step for this page)';

  // 1. Persist user message immediately so the thread shows it right away.
  await _store.appendMessage(conversationId, {
    role: 'user',
    content: userDisplayText,
    pageUrl: window.location.href,
    pageTitle: document.title,
  });

  _sidebar.showThinkingIndicator();

  // 2. Check if this looks like a workflow goal and we have no workflow yet.
  const active = await _store.getActive();
  const hasWorkflow = !!active?.workflow;
  const isFirstMsg = (active?.messages?.filter((m) => m.role === 'user').length ?? 0) === 1;
  let workflowForRequest = null;

  if (!hasWorkflow && isFirstMsg && text && _schema.isGoalLike(text)) {
    try {
      const domMap = buildDomMap();
      const domSummary = domMap.slice(0, 10).map((e) => `${e.label} (${e.tag})`).join(', ');
      const planResp = await _api.fetchWorkflowPlan({
        goal: text,
        pageUrl: window.location.href,
        pageTitle: document.title,
        domSummary,
      });
      if (planResp?.plan?.steps?.length) {
        await _store.attachWorkflow(conversationId, planResp.plan);
        // Inject a system message about the plan.
        await _store.appendMessage(conversationId, {
          role: 'system',
          content: `Plan created: ${planResp.plan.steps.length} steps to "${planResp.plan.goal}".`,
        });
        // Build the workflow snapshot for this request.
        const updated = await _store.getActive();
        workflowForRequest = updated?.workflow ?? null;
      }
    } catch { /* workflow plan is best-effort; proceed without it */ }
  } else if (hasWorkflow) {
    workflowForRequest = active.workflow;
  }

  // Convert store workflow to the shape the backend expects.
  const workflowPayload = workflowForRequest ? {
    goal: workflowForRequest.goal,
    steps: workflowForRequest.steps.map((s) => ({ id: s.id, description: s.description, status: s.status })),
    current_step_idx: workflowForRequest.currentStepIdx ?? 0,
  } : null;

  // 3. Build history array from the conversation store (last 20 turns).
  const conv = await _store.getActive();
  const history = (conv?.messages ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  // 4. DOM map.
  let domMap = [];
  try { domMap = buildDomMap(); } catch { domMap = []; guidelyTrustedSelectors = new Set(); }

  // 5. Screenshot — hide Guidely UI first so it doesn't obscure page content.
  let screenshot = null;
  const sidebarEl = document.getElementById('g-sidebar');
  if (sidebarEl) sidebarEl.style.opacity = '0';
  if (floatBtn) floatBtn.style.opacity = '0';
  try {
    await new Promise((r) => setTimeout(r, 60));
    screenshot = await captureTabScreenshot();
  } catch (err) {
    await _store.appendMessage(conversationId, {
      role: 'system',
      content: `Note: ${captureErrorMessage(err)} — using DOM context only.`,
    });
  } finally {
    if (sidebarEl) sidebarEl.style.opacity = '';
    if (floatBtn) floatBtn.style.opacity = '';
  }

  // 6. POST /analyze.
  let data;
  try {
    data = await _api.runAnalyze({
      conversationId,
      questionText: text || null,
      screenshot,
      domMap,
      history,
      workflow: workflowPayload,
      autonomyLevel,
      pageUrl: window.location.href,
      pageTitle: document.title,
    });
  } catch (err) {
    _sidebar.hideThinkingIndicator();
    const msg = err?.message?.includes('fetch')
      ? 'Could not reach Guidely. Start the backend: cd backend && uvicorn main:app --port 8000'
      : (err?.message || 'Something went wrong. Please try again.');
    await _store.appendMessage(conversationId, { role: 'error', content: msg });
    if (floatBtn) floatBtn.disabled = false;
    return;
  }

  _sidebar.hideThinkingIndicator();

  // Handle needs_screenshot: retry with screenshot attached.
  if (data.needs_screenshot && !screenshot) {
    try {
      if (sidebarEl) sidebarEl.style.opacity = '0';
      if (floatBtn) floatBtn.style.opacity = '0';
      await new Promise((r) => setTimeout(r, 60));
      screenshot = await captureTabScreenshot();
    } catch { /* fall through */ } finally {
      if (sidebarEl) sidebarEl.style.opacity = '';
      if (floatBtn) floatBtn.style.opacity = '';
    }
    if (screenshot) {
      _sidebar.showThinkingIndicator();
      try {
        data = await _api.runAnalyze({
          conversationId, questionText: text || null, screenshot, domMap,
          history, workflow: workflowPayload, autonomyLevel,
          pageUrl: window.location.href, pageTitle: document.title,
        });
      } catch (err) {
        data = { instruction: err?.message || 'Something went wrong.', selector: null, element_label: null };
      } finally {
        _sidebar.hideThinkingIndicator();
      }
    }
  }

  // 7. Persist assistant response.
  await _store.appendMessage(conversationId, {
    role: 'assistant',
    content: data.instruction,
    suggestedSelector: data.selector,
    suggestedLabel: data.element_label,
    trace: data.trace || null,
  });

  // 8. Apply step update if the model marked a step done.
  if (data.step_update?.step_id) {
    await _store.applyStepUpdate(conversationId, data.step_update);
  }

  // 9. Highlight the referenced element.
  try { highlightElement(data.selector, data.element_label); } catch { /* best-effort */ }

  if (floatBtn) floatBtn.disabled = false;
}

// ─── Floating "Help me" button ────────────────────────────────────────────────

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

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  injectBtnStyles();

  try {
    await loadModules();
  } catch (err) {
    // If modules fail to load (e.g. restricted page), just show the button
    // and fail gracefully on click.
    console.warn('[Guidely] module load failed:', err);
    const btn = getOrCreateButton();
    btn.addEventListener('click', () =>
      alert("Guidely can't load on this page. Please try a normal website.")
    );
    return;
  }

  // Record this page visit in the active conversation.
  try {
    const active = await _store.getActive();
    if (active) {
      await _store.recordPageVisit(active.id, { url: window.location.href, title: document.title });
    }
  } catch { /* non-critical */ }

  const btn = getOrCreateButton();
  btn.addEventListener('click', () => _sidebar.open());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
