// ─── DOM Serializer ───────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]';
const MAX_ELEMENTS = 30;

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

// Exposed for manual devtools testing
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
    right: -360px;
    width: 340px;
    height: 100vh;
    z-index: 2147483645;
    background: white;
    box-shadow: -4px 0 24px rgba(0,0,0,0.15);
    font-family: system-ui, sans-serif;
    transition: right 0.3s ease;
    display: flex;
    flex-direction: column;
    padding: 24px;
    box-sizing: border-box;
    overflow-y: auto;
  }
  #guidely-sidebar.open { right: 0; }
  #guidely-sidebar-title {
    font-size: 20px;
    font-weight: 700;
    color: #FF6B35;
    margin-bottom: 16px;
  }
  #guidely-instruction {
    font-size: 18px;
    line-height: 1.6;
    color: #222;
    background: #FFF5F0;
    border-left: 4px solid #FF6B35;
    padding: 16px;
    border-radius: 8px;
    margin-bottom: 16px;
  }
  #guidely-model-badge {
    font-size: 11px;
    color: #999;
    margin-bottom: 12px;
    font-family: monospace;
  }
  #guidely-status {
    font-size: 14px;
    color: #888;
    margin-top: auto;
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

function getOrCreateSidebar() {
  let sidebar = document.getElementById('guidely-sidebar');
  if (sidebar) return sidebar;
  sidebar = document.createElement('div');
  sidebar.id = 'guidely-sidebar';
  sidebar.innerHTML = `
    <button id="guidely-close" title="Close">✕</button>
    <div id="guidely-sidebar-title">💡 Guidely</div>
    <div id="guidely-instruction"></div>
    <div id="guidely-model-badge"></div>
    <div id="guidely-status"></div>
  `;
  document.body.appendChild(sidebar);
  document.getElementById('guidely-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
    clearHighlight();
  });
  return sidebar;
}

function showSidebar(instruction, modelUsed = '', status = '') {
  const sidebar = getOrCreateSidebar();
  document.getElementById('guidely-instruction').textContent = instruction;
  document.getElementById('guidely-model-badge').textContent = modelUsed ? `Model: ${modelUsed}` : '';
  document.getElementById('guidely-status').textContent = status;
  sidebar.classList.add('open');
}

// ─── Help Button ──────────────────────────────────────────────────────────────

const guidely_history = [];

function getOrCreateButton() {
  let btn = document.getElementById('guidely-btn');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = 'guidely-btn';
  btn.textContent = '💡 Help me';
  document.body.appendChild(btn);
  return btn;
}

async function onHelpClick() {
  const btn = document.getElementById('guidely-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking…';
  clearHighlight();

  const domMap = buildDomMap();

  let screenshot;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE' });
    if (response.error) throw new Error(response.error);
    screenshot = response.screenshot;
  } catch (err) {
    showSidebar('This page type isn\'t supported by Guidely.');
    btn.disabled = false;
    btn.textContent = '💡 Help me';
    return;
  }

  let data;
  try {
    const res = await fetch('http://localhost:8000/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot, dom_map: domMap, history: guidely_history }),
    });
    if (res.status === 503) {
      showSidebar('Guidely is offline. Please make sure Ollama is running.');
      btn.disabled = false;
      btn.textContent = '💡 Help me';
      return;
    }
    data = await res.json();
  } catch {
    showSidebar('Could not connect to Guidely. Please start the backend.');
    btn.disabled = false;
    btn.textContent = '💡 Help me';
    return;
  }

  showSidebar(data.instruction, data.model_used || '');
  highlightElement(data.selector);

  // Keep last 5 turns of history
  guidely_history.push({ role: 'assistant', content: data.instruction });
  if (guidely_history.length > 5) guidely_history.shift();

  btn.disabled = false;
  btn.textContent = '💡 Help me';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  injectStyles();
  const btn = getOrCreateButton();
  btn.addEventListener('click', onHelpClick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
