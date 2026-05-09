/**
 * chat-thread.js — renders the message bubbles in the scrollable chat area.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const ROLE_CLASS = {
  user:       'g-msg-user',
  assistant:  'g-msg-assistant',
  system:     'g-msg-system',
  error:      'g-msg-error',
  vigilance:  'g-msg-vigilance',
};

/**
 * Full re-render. Used when loading a conversation from the store.
 * @param {HTMLElement} rootEl — the scrollable chat container
 * @param {Array} messages — Message[] from the store
 */
export function renderThread(rootEl, messages) {
  rootEl.innerHTML = '';
  for (const msg of (messages || [])) {
    rootEl.appendChild(_makeBubble(msg));
  }
  rootEl.scrollTop = rootEl.scrollHeight;
}

/**
 * Append a single message bubble without re-rendering the whole thread.
 * Faster for live updates.
 */
export function appendMessage(rootEl, message) {
  if (!rootEl) return;
  rootEl.appendChild(_makeBubble(message));
  rootEl.scrollTop = rootEl.scrollHeight;
}

function _makeBubble(msg) {
  const div = document.createElement('div');
  div.className = `g-msg ${ROLE_CLASS[msg.role] ?? 'g-msg-assistant'}`;
  div.setAttribute('data-msg-id', msg.id || '');
  // Use textContent to safely render — no HTML injection from model output.
  div.textContent = msg.content || '';
  return div;
}

/** Show a temporary "thinking…" indicator; returns a function to remove it. */
export function showThinking(rootEl) {
  if (!rootEl) return () => {};
  const div = document.createElement('div');
  div.className = 'g-msg g-msg-thinking';
  div.id = 'g-thinking';
  div.textContent = '…';
  rootEl.appendChild(div);
  rootEl.scrollTop = rootEl.scrollHeight;
  return () => div.remove();
}
