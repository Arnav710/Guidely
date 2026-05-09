/**
 * chat-thread.js — renders the message bubbles in the scrollable chat area.
 *
 * Message roles: user | assistant | system | error | vigilance | tool-call
 * The "tool-call" role is a special bubble showing the agent's current action
 * with a spinning activity indicator.
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
  'tool-call': 'g-msg-tool-call',
};

// Map tool names to a short friendly icon.
const TOOL_ICON = {
  get_sections:     '🗂',
  get_elements:     '🔍',
  search_page:      '🔎',
  get_page_text:    '📄',
  screenshot:       '📸',
  web_search:       '🌐',
  find_and_click:   '👆',
  fill_field:       '✏️',
  navigate_and_read:'🧭',
  click:            '👆',
  type_text:        '⌨️',
  scroll:           '↕️',
  navigate:         '🧭',
  complete_step:    '✅',
  replan:           '🔄',
  ask_user:         '💬',
  done:             '🎉',
};

/**
 * Full re-render. Used when loading a conversation from the store.
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
 */
export function appendMessage(rootEl, message) {
  if (!rootEl) return;
  rootEl.appendChild(_makeBubble(message));
  rootEl.scrollTop = rootEl.scrollHeight;
}

/**
 * Append an agent tool-call activity bubble.
 * Returns a function to mark it "done" (replaces spinner with a checkmark).
 */
export function appendToolCallBubble(rootEl, { tool, display }) {
  if (!rootEl) return () => {};
  const icon = TOOL_ICON[tool] || '⚙️';
  const text = esc(display || `Running ${tool}…`);

  const div = document.createElement('div');
  div.className = 'g-msg g-msg-tool-call';
  div.setAttribute('data-pending', 'true');
  div.setAttribute('data-tool', tool || '');
  div.innerHTML = `
    <span class="g-tool-icon">${icon}</span>
    <span class="g-tool-text">${text}</span>
    <span class="g-tool-spinner" aria-label="Working">⋯</span>
  `;
  rootEl.appendChild(div);
  rootEl.scrollTop = rootEl.scrollHeight;

  return function markDone() {
    div.setAttribute('data-pending', 'false');
    const spinner = div.querySelector('.g-tool-spinner');
    if (spinner) spinner.textContent = '✓';
  };
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

/**
 * Show a live "Thinking…" bubble that updates with partial thought text as the
 * model streams tokens. Mimics Cursor's real-time reasoning display.
 *
 * Returns a control object:
 *   updateThought(text)  — replace the thought text with new partial content
 *   markSearching(query) — show "Searching the web for '...'" message
 *   markReplanning()     — show "Replanning…" message
 *   dismiss()            — remove the bubble entirely (call before showing tool-call bubble)
 */
export function showStreamingThought(rootEl) {
  if (!rootEl) {
    return { updateThought() {}, markSearching() {}, markReplanning() {}, dismiss() {} };
  }

  const bubble = document.createElement('div');
  bubble.className = 'g-msg g-msg-streaming-thought';
  bubble.innerHTML = `
    <span class="g-stream-icon">💭</span>
    <span class="g-stream-body">
      <span class="g-stream-label">Thinking</span>
      <span class="g-stream-text"></span>
      <span class="g-stream-cursor" aria-hidden="true"></span>
    </span>
  `;
  rootEl.appendChild(bubble);
  rootEl.scrollTop = rootEl.scrollHeight;

  const textEl = bubble.querySelector('.g-stream-text');
  const labelEl = bubble.querySelector('.g-stream-label');

  return {
    updateThought(text) {
      if (!text) return;
      textEl.textContent = text;
      rootEl.scrollTop = rootEl.scrollHeight;
    },
    markSearching(query) {
      labelEl.textContent = 'Searching the web';
      textEl.textContent = query ? `"${query}"` : '';
      bubble.querySelector('.g-stream-icon').textContent = '🌐';
      rootEl.scrollTop = rootEl.scrollHeight;
    },
    markReplanning() {
      labelEl.textContent = 'Replanning';
      textEl.textContent = '';
      bubble.querySelector('.g-stream-icon').textContent = '🔄';
      rootEl.scrollTop = rootEl.scrollHeight;
    },
    dismiss() {
      bubble.remove();
    },
  };
}

function _makeBubble(msg) {
  const div = document.createElement('div');
  div.className = `g-msg ${ROLE_CLASS[msg.role] ?? 'g-msg-assistant'}`;
  div.setAttribute('data-msg-id', msg.id || '');
  div.textContent = msg.content || '';
  return div;
}
