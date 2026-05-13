// ── Guidely content script ────────────────────────────────────────────────────
//
// Thin orchestrator: owns the floating button, the Guidely UI mount, and the
// connection between user events and the agent loop.
//
// Heavy lifting lives in:
//   modules/agent-loop.js  — tool executors + the agent step loop
//   modules/ui/            — sidebar, composer, chat thread, plan view
//   modules/conversation-store.js — persistent chrome.storage.local state

// ── Floating button styles ────────────────────────────────────────────────────

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
  #g-sidebar.g-open ~ #guidely-btn {
    display: none !important;
  }
  #guidely-btn.guidely-btn--vigilance-stop {
    display: none !important;
  }

  /* Vigilance mode — single summary popup fixed bottom-right. */
  .guidely-vigil-popup-wrap {
    position: fixed;
    z-index: 2147483645;
    bottom: 16px;
    right: 16px;
    width: 300px;
    max-height: 60vh;
    overflow-y: auto;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    color: #111827;
    background: #fff7f7;
    border: 1px solid #fecaca;
    border-left: 4px solid #dc2626;
    border-radius: 10px;
    padding: 12px 12px 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.22);
  }
  .guidely-vigil-popup-wrap .g-vigil-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .guidely-vigil-popup-wrap .g-vigil-title {
    font-size: 13px;
    font-weight: 700;
    color: #991b1b;
    flex: 1;
  }
  .guidely-vigil-popup-wrap .g-vigil-flag {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid #fecaca;
  }
  .guidely-vigil-popup-wrap .g-vigil-flag:last-of-type {
    border-bottom: none;
    margin-bottom: 6px;
  }
  .guidely-vigil-popup-wrap .g-vigil-reason {
    display: block;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #b91c1c;
    margin-bottom: 2px;
  }
  .guidely-vigil-popup-wrap .g-vigil-explanation {
    margin: 0;
    color: #374151;
    font-size: 12.5px;
  }
  .guidely-vigil-popup-wrap button {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid #dc2626;
    background: #fff;
    color: #b91c1c;
    cursor: pointer;
    width: 100%;
    margin-top: 4px;
  }
  .guidely-vigil-popup-wrap button:hover { background: #fef2f2; }

  /* Static rectangular ring: no pulse (pulse + outline looked broken on rounded links). */
  .guidely-ring {
    outline: 2px solid #FF6B35 !important;
    outline-offset: 2px !important;
    scroll-margin: 80px;
  }
`;

function injectBtnStyles() {
  if (document.getElementById('guidely-btn-styles')) return;
  const style = document.createElement('style');
  style.id = 'guidely-btn-styles';
  style.textContent = BTN_STYLES;
  document.head.appendChild(style);
}

// ── Highlight ring ────────────────────────────────────────────────────────────

let _highlightTarget = null;
let _highlightTimer = null;

// ── Text-to-speech ────────────────────────────────────────────────────────────

const _tts = window.speechSynthesis;

function _speak(text) {
  if (!_tts) return;
  _tts.cancel(); // stop any current speech before starting new
  if (!text?.trim()) return;
  // Strip markdown-ish symbols so they aren't read aloud.
  const clean = String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_`#>]/g, '')
    .trim();
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 1.05;
  utt.pitch = 1;
  _tts.speak(utt);
}

function _stopSpeech() {
  _tts?.cancel();
}

function clearHighlight() {
  if (_highlightTarget) {
    _highlightTarget.classList.remove('guidely-ring');
    _highlightTarget = null;
  }
  if (_highlightTimer) { clearTimeout(_highlightTimer); _highlightTimer = null; }
}

/** Visible enough for the user to notice the ring. */
function _roughVisible(el) {
  if (!el?.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
}

/**
 * If we matched a big container (LI/DIV/TD…), try to use the inner control that
 * actually shows the label (e.g. Unsubscribe link inside a list row).
 */
function _refineHighlightNode(el, label) {
  if (!el || !label) return el;
  const want = String(label).toLowerCase().trim();
  if (!want || want.length > 80) return el;
  const tag = el.tagName?.toUpperCase();
  if (!['LI', 'DIV', 'TD', 'TR', 'SECTION', 'ARTICLE'].includes(tag)) return el;
  const innerPick = el.querySelectorAll('a, button, span, [role="button"], [role="link"]');
  for (const node of innerPick) {
    const t = (node.textContent || '').trim().toLowerCase();
    if (!t) continue;
    if (t === want || t.includes(want) || want.includes(t)) {
      if (_roughVisible(node)) return node;
    }
  }
  return el;
}

/** Long composite selectors sometimes fail after re-render; try embedded #id fragments. */
function _querySelectorWithIdFallback(selector) {
  if (!selector) return null;
  try {
    const el = document.querySelector(selector);
    if (el) return el;
  } catch (e) {
    console.log('[Guidely highlight] querySelector threw', e?.message || e);
  }
  if (!selector.includes('#')) return null;
  const idRe = /#[A-Za-z_][\w-]*/g;
  let m;
  while ((m = idRe.exec(selector)) !== null) {
    const frag = m[0];
    try {
      const node = document.querySelector(frag);
      if (node) return node;
    } catch { /* invalid fragment */ }
  }
  return null;
}

function highlightElement(selector, label, opts = {}) {
  clearHighlight();
  if (!selector && !label) {
    console.log('[Guidely highlight] skipped — no selector or label');
    return;
  }

  const durationMs = typeof opts.durationMs === 'number' && opts.durationMs > 0
    ? opts.durationMs
    : 12000;
  let el = null;
  let selectorError = null;
  if (selector) {
    try {
      el = document.querySelector(selector);
    } catch (e) {
      selectorError = e?.message || String(e);
    }
    if (!el) el = _querySelectorWithIdFallback(selector);
    if (!el && selector) {
      console.warn('[Guidely highlight] querySelector returned null', {
        selectorLen: selector.length,
        selectorHead: selector.slice(0, 100),
        parseError: selectorError,
      });
    }
  }
  if (!el && label && _agentLoop) {
    const results = _agentLoop.searchPage(label, {
      excludeGuidelySidebar: true,
      preferActionTags: true,
      maxMatches: 16,
    });
    console.log('[Guidely highlight] label fallback', {
      label: String(label).slice(0, 80),
      matchCount: results.matches?.length ?? 0,
      topTags: results.matches?.slice(0, 4).map((x) => x.tag),
    });
    for (let i = 0; i < results.matches.length; i++) {
      const m = results.matches[i];
      try {
        let candidate = document.querySelector(m.selector);
        if (!candidate) continue;
        candidate = _refineHighlightNode(candidate, label);
        if (!_roughVisible(candidate)) continue;
        el = candidate;
        console.log('[Guidely highlight] fallback picked match', { index: i, tag: el.tagName });
        break;
      } catch { /* ignore */ }
    }
  }
  if (!el) {
    console.warn('[Guidely highlight] no element found — ring not shown');
    return;
  }

  console.log('[Guidely highlight] ok', { tag: el.tagName, id: el.id || null });
  _highlightTarget = el;
  el.classList.add('guidely-ring');
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
  _highlightTimer = setTimeout(clearHighlight, durationMs);
}

// ── Vigilance overlays (red outline + small acknowledge popup) ───────────────

const _VIGILANCE_REASON_LABELS = {
  fake_urgency: 'Fake urgency',
  asking_for_money: 'Money or payment request',
  no_sources: 'No sources listed',
  misleading_language: 'Misleading wording',
  suspicious_contact_or_link: 'Odd link, email, or phone',
  excessive_punctuation: 'Excessive punctuation',
  ai_generated_or_generic: 'Generic or AI-like text',
  other: 'Unusual pattern',
};

/** @type {{ el: Element, wrap: HTMLElement }[]} */
const _vigilanceMarked = [];

function clearVigilanceOverlays() {
  while (_vigilanceMarked.length) {
    const row = _vigilanceMarked.pop();
    try { row.el?.classList?.remove('guidely-vigilance-risk'); } catch { /* ignore */ }
    try { row.wrap?.remove(); } catch { /* ignore */ }
  }
}

/**
 * Show a single summary popup listing all flags. No per-element red outlines.
 * @param {{ flags: Array<{ item_number: number, reason: string, explanation: string }>, pageSummary: string }} payload
 */
function applyVigilanceFlags(payload) {
  injectBtnStyles();
  clearVigilanceOverlays();
  const flags = (payload?.flags || []).filter((f) => f?.reason && f?.explanation);
  if (flags.length === 0) return;

  const wrap = document.createElement('div');
  wrap.className = 'guidely-vigil-popup-wrap';

  const header = document.createElement('div');
  header.className = 'g-vigil-header';
  header.innerHTML = `<span style="font-size:18px">⚠️</span><span class="g-vigil-title">Guidely spotted ${flags.length} warning${flags.length > 1 ? 's' : ''}</span>`;
  wrap.appendChild(header);

  for (const f of flags) {
    const flagEl = document.createElement('div');
    flagEl.className = 'g-vigil-flag';
    const label = _VIGILANCE_REASON_LABELS[f.reason] || 'Unusual pattern';
    flagEl.innerHTML = `<span class="g-vigil-reason">${label}</span><p class="g-vigil-explanation">${String(f.explanation || '').slice(0, 220)}</p>`;
    wrap.appendChild(flagEl);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Got it — dismiss';
  btn.addEventListener('click', () => {
    wrap.remove();
    const ix = _vigilanceMarked.findIndex((r) => r.wrap === wrap);
    if (ix >= 0) _vigilanceMarked.splice(ix, 1);
  });
  wrap.appendChild(btn);

  document.body.appendChild(wrap);
  // If the Guidely sidebar is open, shift the popup left so it's not hidden behind it.
  const sidebarOpen = !!document.querySelector('#g-sidebar.g-open');
  if (sidebarOpen) wrap.style.right = '420px';
  _vigilanceMarked.push({ el: null, wrap });
}

// ── Module handles ────────────────────────────────────────────────────────────

let _store = null;
let _sidebar = null;
let _api = null;
let _agentLoop = null;

async function handleSidebarClosed() {
  if (!_agentLoop?.isVigilanceActive?.()) return;
  const active = await _store.getActive();
  if (active?.id) {
    await _store.appendMessage(active.id, {
      role: 'system',
      content: 'Vigilance stopped (sidebar closed).',
      pageUrl: window.location.href,
      pageTitle: document.title,
    }).catch(() => {});
    _agentLoop.stopVigilanceMode(active.id, _makeCallbacks(active.id), { silent: true });
  } else {
    _agentLoop.stopVigilanceMode('_', { onVigilanceClear: clearVigilanceOverlays, onMessage: () => {} }, { silent: true });
  }
  _syncFloatingButtonVigilance();
  _sidebar?.setVigilanceActive?.(false);
}

async function loadModules() {
  if (_store && _sidebar && _api && _agentLoop) return;
  const base = chrome.runtime.getURL('modules/');
  [_store, _api, _agentLoop] = await Promise.all([
    import(`${base}conversation-store.js`),
    import(`${base}api.js`),
    import(`${base}agent-loop.js`),
  ]);
  const { mountSidebar } = await import(`${base}ui/agent-sidebar.js`);
  _sidebar = await mountSidebar({
    onSubmit: handleUserInput,
    onSidebarClose: handleSidebarClosed,
  });
}

// ── User input handler ────────────────────────────────────────────────────────

async function handleUserInput({ conversationId, text, mode = 'autonomous' }) {
  const rawTrim = (text || '').trim();

  // Vigilance: while active, clicking the button again stops it.
  if (mode === 'vigilance' && _agentLoop?.isVigilanceActive?.()) {
    clearVigilanceOverlays();
    clearHighlight();
    _stopSpeech();
    _agentLoop.stopVigilanceMode(conversationId, _makeCallbacks(conversationId));
    _syncFloatingButtonVigilance();
    _sidebar.setVigilanceActive?.(false);
    return;
  }

  if (mode !== 'vigilance' && _agentLoop?.isVigilanceActive?.()) {
    _agentLoop.stopVigilanceMode(conversationId, _makeCallbacks(conversationId), { silent: true });
    _syncFloatingButtonVigilance();
    _sidebar.setVigilanceActive?.(false);
  }

  clearHighlight();
  _stopSpeech();

  // For vigilance toggle, skip the user message bubble — the system message from
  // startVigilanceMode is enough feedback.
  if (mode === 'vigilance') {
    _agentLoop.startVigilanceMode(conversationId, _makeCallbacks(conversationId));
    _syncFloatingButtonVigilance();
    _sidebar.setVigilanceActive?.(true);
    return;
  }

  const displayText = rawTrim || '(What should I do here?)';

  await _store.appendMessage(conversationId, {
    role: 'user',
    content: displayText,
    pageUrl: window.location.href,
    pageTitle: document.title,
  });

  const session = await _store.getAgentSession(conversationId);

  if (session?.status === 'paused' && session.pendingUserQuestion) {
    await _agentLoop.respondToUserQuestion(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  if (session?.status === 'running') return;

  if (!rawTrim) {
    _sidebar.appendLiveMessage({ role: 'system', content: "Please tell me what you'd like help with." });
    return;
  }

  if (mode === 'summarize') {
    await _agentLoop.runSummarize(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  if (mode === 'guide') {
    await _agentLoop.runGuideMode(conversationId, displayText, highlightElement, _makeCallbacks(conversationId));
    return;
  }

  if (session?.status === 'idle' && session?.toolHistory?.length > 0) {
    await _agentLoop.continueAgentLoop(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  await _agentLoop.startAgentLoop(conversationId, displayText, _makeCallbacks(conversationId));
}

function _makeCallbacks(conversationId) {
  return {
    onToolCall({ tool, params, display, markDoneRef }) {
      // Show a tool-call activity bubble and return a "mark done" handle.
      const markDone = _sidebar.appendToolCall({ tool, display });
      // Store the handle so the loop can mark it done after execution.
      if (markDoneRef) markDoneRef.fn = markDone;
      // If the LLM is about to click something, highlight it on the page.
      if ((tool === 'click' || tool === 'find_and_click') && params) {
        const selector = params.selector || null;
        const label = params.text || params.label || null;
        if (selector || label) highlightElement(selector, label);
      }
    },
    onStartStreaming() {
      // Open a live streaming thought bubble and return its control object.
      return _sidebar.startStreamingThought?.();
    },
    onMessage(message) {
      // Show immediately in the sidebar (live path — no full re-render).
      _sidebar.appendLiveMessage(message);
      if (message.role === 'assistant') _speak(message.content);
      _store.appendMessage(conversationId, message).catch(() => {});
    },
    onVigilanceFlags(payload) {
      applyVigilanceFlags(payload);
    },
    onVigilanceClear() {
      clearVigilanceOverlays();
    },
    onActionChoice({ question, selector, label }) {
      // Highlight the element immediately so the user can see what we're referring to.
      if (selector || label) highlightElement(selector, label);

      // Render the two-button choice card.
      const { dismiss } = _sidebar.appendActionChoice({
        question,
        onChoice(choice) {
          dismiss();
          // Persist the assistant's question and user's implicit choice.
          _store.appendMessage(conversationId, { role: 'assistant', content: question }).catch(() => {});
          const choiceLabel = choice === 'do_it' ? 'Do it for me' : 'Show me where';
          _store.appendMessage(conversationId, { role: 'user', content: choiceLabel }).catch(() => {});

          if (choice === 'guide_me') clearHighlight();

          _agentLoop.respondToActionChoice(
            conversationId,
            choice,
            _makeCallbacks(conversationId),
          );
        },
      });
    },
    onDone(opts = {}) {
      _sidebar.setAgentStatus('idle');
      // Guide mode finishes after showing a highlight — do not clear it here;
      // the highlight timer (or the user's next message) clears it.
      if (!opts.keepHighlight) clearHighlight();
    },
    onError(msg) {
      _sidebar.appendLiveMessage({ role: 'error', content: msg });
      _store.appendMessage(conversationId, { role: 'error', content: msg }).catch(() => {});
      _sidebar.setAgentStatus('error');
    },
    onStatusChange(status) {
      _sidebar.setAgentStatus(status);
    },
  };
}

// ── Floating button ───────────────────────────────────────────────────────────

function getOrCreateButton() {
  let btn = document.getElementById('guidely-btn');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = 'guidely-btn';
  btn.type = 'button';
  btn.textContent = '💡 Help me';
  btn.setAttribute('aria-label', 'Open Guidely');
  document.body.appendChild(btn);
  return btn;
}

function _syncFloatingButtonVigilance() {
  // No-op: vigilance start/stop is controlled exclusively by the in-sidebar button.
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  injectBtnStyles();

  try {
    await loadModules();
  } catch (err) {
    console.warn('[Guidely] module load failed:', err);
    const btn = getOrCreateButton();
    btn.addEventListener('click', () =>
      alert("Guidely can't load on this page. Please try a normal website."),
    );
    return;
  }

  // Ensure there's always an active conversation.
  await _store.init();
  let active = await _store.getActive();
  if (!active) active = await _store.createConversation();

  // Record this page visit in the active conversation.
  try {
    await _store.recordPageVisit(active.id, { url: window.location.href, title: document.title });
  } catch { /* non-critical */ }

  // Check if the agent was mid-loop and navigated to this page.
  const session = await _store.getAgentSession(active.id);
  if (session?.awaitingPageLoad && session?.status === 'running') {
    _agentLoop.resumeAgentLoop(active.id, _makeCallbacks(active.id));
  }

  const btn = getOrCreateButton();
  btn.addEventListener('click', () => {
    _sidebar.open();
  });

  _syncFloatingButtonVigilance();

  // One visible line so you know logging works — content-script logs only appear
  // in this page's Console when that tab's DevTools is open (not extension popup).
  console.log(
    '%cGuidely%c · Debug logs are prefixed %c[Guidely …]%c — filter the Console by "Guidely". '
    + 'Keep DevTools open on this tab (the site), not on chrome://extensions.',
    'color:#fff;background:#FF6B35;font-weight:bold;padding:2px 8px;border-radius:4px',
    'color:inherit',
    'color:#FF6B35;font-weight:bold',
    'color:#888',
    { page: window.location.href.slice(0, 120) },
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
