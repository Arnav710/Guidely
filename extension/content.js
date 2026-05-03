// ─── DOM Serializer ───────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]';
const MAX_ELEMENTS = 30;
const MAX_HISTORY = 10; // alternating user / assistant, last ~5 rounds

function getLabel(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  if (el.placeholder) return el.placeholder.trim();
  if (el.innerText && el.innerText.trim()) return el.innerText.trim().slice(0, 60);
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.innerText.trim();
  }
  return null;
}

function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
  const candidate = `${tag}${classes}`;
  if (document.querySelectorAll(candidate).length === 1) return candidate;
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll(tag));
    const idx = siblings.indexOf(el) + 1;
    const parentSel = getSelector(parent);
    return `${parentSel} > ${tag}:nth-of-type(${idx})`;
  }
  return tag;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function buildDomMap() {
  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const map = [];
  let id = 1;
  for (const el of elements) {
    if (map.length >= MAX_ELEMENTS) break;
    const label = getLabel(el);
    if (!label && !el.id) continue;
    map.push({
      id: id++,
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      label: label || el.id,
      selector: getSelector(el),
      visible: isVisible(el),
    });
  }
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
    right: -380px;
    width: 360px;
    height: 100vh;
    z-index: 2147483645;
    background: white;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
    font-family: system-ui, sans-serif;
    transition: right 0.3s ease;
    display: flex;
    flex-direction: column;
    padding: 24px;
    padding-top: 48px;
    box-sizing: border-box;
    overflow-y: auto;
    gap: 12px;
  }
  #guidely-sidebar.open { right: 0; }
  #guidely-sidebar-title {
    font-size: 20px;
    font-weight: 700;
    color: #FF6B35;
    margin: 0;
  }
  #guidely-ask-label {
    font-size: 13px;
    font-weight: 600;
    color: #444;
    margin: 0;
  }
  #guidely-question {
    width: 100%;
    min-height: 88px;
    padding: 12px;
    font-size: 15px;
    line-height: 1.45;
    border: 1px solid #ddd;
    border-radius: 10px;
    resize: vertical;
    box-sizing: border-box;
    font-family: system-ui, sans-serif;
  }
  #guidely-question:focus {
    outline: none;
    border-color: #FF6B35;
    box-shadow: 0 0 0 2px rgba(255, 107, 53, 0.2);
  }
  #guidely-send {
    width: 100%;
    padding: 12px 16px;
    font-size: 16px;
    font-weight: 600;
    color: white;
    background: #FF6B35;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-family: system-ui, sans-serif;
  }
  #guidely-send:hover:not(:disabled) { background: #e05a28; }
  #guidely-send:disabled { background: #aaa; cursor: not-allowed; }
  #guidely-instruction {
    font-size: 17px;
    line-height: 1.55;
    color: #222;
    background: #FFF5F0;
    border-left: 4px solid #FF6B35;
    padding: 14px 16px;
    border-radius: 8px;
    margin: 0;
    min-height: 48px;
  }
  #guidely-model-badge {
    font-size: 11px;
    color: #999;
    font-family: monospace;
    margin: 0;
  }
  #guidely-status {
    font-size: 13px;
    color: #888;
    margin-top: auto;
    padding-top: 8px;
  }
  #guidely-close {
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    font-size: 22px;
    cursor: pointer;
    color: #aaa;
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

// ─── Highlight Overlay ────────────────────────────────────────────────────────

function clearHighlight() {
  const existing = document.getElementById('guidely-highlight');
  if (existing) existing.remove();
}

function highlightElement(selector) {
  clearHighlight();
  if (!selector) return;
  const el = document.querySelector(selector);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = 'guidely-highlight';
    Object.assign(overlay.style, {
      top:    `${rect.top    - 4}px`,
      left:   `${rect.left  - 4}px`,
      width:  `${rect.width  + 8}px`,
      height: `${rect.height + 8}px`,
    });
    document.body.appendChild(overlay);
  }, 400);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const guidely_history = [];
let guidely_sidebar_wired = false;

function getOrCreateSidebar() {
  let sidebar = document.getElementById('guidely-sidebar');
  if (sidebar) return sidebar;

  sidebar = document.createElement('div');
  sidebar.id = 'guidely-sidebar';
  sidebar.innerHTML = `
    <button type="button" id="guidely-close" title="Close">✕</button>
    <div id="guidely-sidebar-title">💡 Guidely</div>
    <p id="guidely-ask-label">Your question</p>
    <textarea id="guidely-question" rows="4" maxlength="2000"
      placeholder="Ask anything about this page… (or leave blank for a suggested next step)"></textarea>
    <button type="button" id="guidely-send">Ask Guidely</button>
    <div id="guidely-instruction"></div>
    <div id="guidely-model-badge"></div>
    <div id="guidely-status"></div>
  `;
  document.body.appendChild(sidebar);

  document.getElementById('guidely-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
    clearHighlight();
  });

  if (!guidely_sidebar_wired) {
    guidely_sidebar_wired = true;
    document.getElementById('guidely-send').addEventListener('click', submitGuidelyQuestion);
    document.getElementById('guidely-question').addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitGuidelyQuestion();
      }
    });
  }

  return sidebar;
}

function setInstruction(htmlOrText, isPlainText = true) {
  const el = document.getElementById('guidely-instruction');
  if (isPlainText) el.textContent = htmlOrText;
  else el.innerHTML = htmlOrText;
}

function showSidebarOpen() {
  const sidebar = getOrCreateSidebar();
  sidebar.classList.add('open');
}

// ─── Ask flow ─────────────────────────────────────────────────────────────────

function openAskPanel() {
  injectStyles();
  getOrCreateSidebar();
  setInstruction(
    'Type a question above, or leave it empty and tap “Ask Guidely” for a quick suggestion for this page.',
  );
  document.getElementById('guidely-model-badge').textContent = '';
  document.getElementById('guidely-status').textContent = '';
  showSidebarOpen();
  const ta = document.getElementById('guidely-question');
  ta.focus();
}

async function submitGuidelyQuestion() {
  const sendBtn = document.getElementById('guidely-send');
  const floatBtn = document.getElementById('guidely-btn');
  const questionEl = document.getElementById('guidely-question');
  const question = (questionEl.value || '').trim();

  sendBtn.disabled = true;
  if (floatBtn) floatBtn.disabled = true;
  sendBtn.textContent = 'Thinking…';
  clearHighlight();
  document.getElementById('guidely-status').textContent = '';

  const domMap = buildDomMap();

  let screenshot;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
    if (response && response.error) throw new Error(response.error);
    if (!response || !response.screenshot) throw new Error('No screenshot returned');
    screenshot = response.screenshot;
  } catch (err) {
    const detail = err && err.message ? err.message : '';
    const isRestricted =
      /chrome:\/\//i.test(window.location.href) ||
      /^(edge|brave|vivaldi):\/\//i.test(window.location.href);
    const msg = isRestricted
      ? 'Guidely can\'t run on this built-in browser page. Open a normal website instead.'
      : 'Guidely couldn\'t capture a screenshot of this page. Try reloading the tab, or reload the extension in chrome://extensions if you just updated it.';
    setInstruction(msg);
    document.getElementById('guidely-status').textContent = detail ? `Details: ${detail}` : '';
    sendBtn.disabled = false;
    sendBtn.textContent = 'Ask Guidely';
    if (floatBtn) floatBtn.disabled = false;
    showSidebarOpen();
    return;
  }

  const userLine = question || 'What should I do on this page?';

  let data;
  try {
    const res = await fetch('http://localhost:8000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        screenshot,
        dom_map: domMap,
        history: guidely_history,
        question: question || null,
      }),
    });
    if (res.status === 503) {
      setInstruction('Guidely is offline. Please make sure Ollama is running.');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Ask Guidely';
      if (floatBtn) floatBtn.disabled = false;
      return;
    }
    data = await res.json();
  } catch {
    setInstruction('Could not connect to Guidely. Please start the backend.');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Ask Guidely';
    if (floatBtn) floatBtn.disabled = false;
    return;
  }

  setInstruction(data.instruction);
  document.getElementById('guidely-model-badge').textContent = data.model_used ? `Model: ${data.model_used}` : '';
  highlightElement(data.selector);

  guidely_history.push({ role: 'user', content: userLine });
  guidely_history.push({ role: 'assistant', content: data.instruction });
  while (guidely_history.length > MAX_HISTORY) {
    guidely_history.splice(0, guidely_history.length - MAX_HISTORY);
  }

  questionEl.value = '';
  sendBtn.disabled = false;
  sendBtn.textContent = 'Ask Guidely';
  if (floatBtn) floatBtn.disabled = false;
  showSidebarOpen();
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
