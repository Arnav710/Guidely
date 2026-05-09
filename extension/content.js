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
  #g-sidebar.g-open ~ #guidely-btn { display: none !important; }

  @keyframes guidely-ring-pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(255,107,53,0.45); }
    50%       { box-shadow: 0 0 0 10px rgba(255,107,53,0); }
  }
  .guidely-ring {
    outline: 3px solid #FF6B35 !important;
    outline-offset: 4px !important;
    animation: guidely-ring-pulse 1s ease-in-out infinite !important;
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

function clearHighlight() {
  if (_highlightTarget) {
    _highlightTarget.classList.remove('guidely-ring');
    _highlightTarget = null;
  }
  if (_highlightTimer) { clearTimeout(_highlightTimer); _highlightTimer = null; }
}

function highlightElement(selector, label) {
  clearHighlight();
  if (!selector && !label) return;

  // Try selector first, then label fuzzy match via the agent-loop's searchPage.
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch { /* bad CSS */ }
  }
  if (!el && label && _agentLoop) {
    const results = _agentLoop.searchPage(label);
    for (const m of results.matches.slice(0, 2)) {
      try { el = document.querySelector(m.selector); if (el) break; } catch { /* ignore */ }
    }
  }
  if (!el) return;

  _highlightTarget = el;
  el.classList.add('guidely-ring');
  try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
  _highlightTimer = setTimeout(clearHighlight, 12000);
}

// ── Module handles ────────────────────────────────────────────────────────────

let _store = null;
let _sidebar = null;
let _api = null;
let _agentLoop = null;

async function loadModules() {
  if (_store && _sidebar && _api && _agentLoop) return;
  const base = chrome.runtime.getURL('modules/');
  [_store, _api, _agentLoop] = await Promise.all([
    import(`${base}conversation-store.js`),
    import(`${base}api.js`),
    import(`${base}agent-loop.js`),
  ]);
  const { mountSidebar } = await import(`${base}ui/agent-sidebar.js`);
  _sidebar = await mountSidebar({ onSubmit: handleUserInput });
}

// ── User input handler ────────────────────────────────────────────────────────

async function handleUserInput({ conversationId, text, mode = 'autonomous' }) {
  clearHighlight();

  // Persist the user's message immediately so it appears in the thread.
  const displayText = (text || '').trim() || '(What should I do here?)';
  await _store.appendMessage(conversationId, {
    role: 'user',
    content: displayText,
    pageUrl: window.location.href,
    pageTitle: document.title,
  });

  const session = await _store.getAgentSession(conversationId);

  // Case 1: Agent is paused waiting for user input — always resume with answer regardless of mode.
  if (session?.status === 'paused' && session.pendingUserQuestion) {
    await _agentLoop.respondToUserQuestion(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  // Case 2: Agent is already running (shouldn't normally reach here).
  if (session?.status === 'running') return;

  if (!displayText || displayText === '(What should I do here?)') {
    _sidebar.appendLiveMessage({ role: 'system', content: "Please tell me what you'd like help with." });
    return;
  }

  // Case 3: Summarize mode — one-shot, no browsing.
  if (mode === 'summarize') {
    await _agentLoop.runSummarize(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  // Case 4: Guide mode — highlight only, no clicking.
  if (mode === 'guide') {
    await _agentLoop.runGuideMode(conversationId, displayText, highlightElement, _makeCallbacks(conversationId));
    return;
  }

  // Case 5: Agent is idle (finished a task) — continue conversation in autonomous mode.
  if (session?.status === 'idle' && session?.toolHistory?.length > 0) {
    await _agentLoop.continueAgentLoop(conversationId, displayText, _makeCallbacks(conversationId));
    return;
  }

  // Case 6: Fresh autonomous goal — start the agent loop.
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
      // Persist asynchronously to chrome.storage.local.
      _store.appendMessage(conversationId, message).catch(() => {});
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
    onDone() {
      _sidebar.setAgentStatus('idle');
      clearHighlight();
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
  document.body.appendChild(btn);
  return btn;
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
  btn.addEventListener('click', () => _sidebar.open());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
