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
  const nonSystem = (messages || []).filter((m) => m.role !== 'system');
  if (nonSystem.length === 0) {
    rootEl.appendChild(_makeEmptyState(rootEl));
    return;
  }
  // Find the index of the last assistant message to mark it as the final answer.
  let lastAssistantIdx = -1;
  (messages || []).forEach((m, i) => { if (m.role === 'assistant') lastAssistantIdx = i; });
  for (let i = 0; i < (messages || []).length; i++) {
    const bubble = _makeBubble(messages[i]);
    if (i === lastAssistantIdx) bubble.setAttribute('data-final', 'true');
    rootEl.appendChild(bubble);
  }
  rootEl.scrollTop = rootEl.scrollHeight;
}

/**
 * Append a single message bubble without re-rendering the whole thread.
 */
export function appendMessage(rootEl, message) {
  if (!rootEl) return;
  const bubble = _makeBubble(message);
  if (message.role === 'assistant') {
    // Clear any previous final marker — this new one is now the last answer.
    rootEl.querySelectorAll('.g-msg-assistant[data-final="true"]').forEach((el) => {
      el.removeAttribute('data-final');
    });
    bubble.setAttribute('data-final', 'true');
  }
  rootEl.appendChild(bubble);
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
  div.innerHTML = '<span class="g-thinking-dot"></span><span class="g-thinking-dot"></span><span class="g-thinking-dot"></span>';
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

/**
 * Render an ask_action choice card: assistant question text + two buttons.
 *
 * Returns { dismiss } so the caller can remove the card once the user picks.
 *
 * onChoice(choice) is called with 'do_it' or 'guide_me'.
 */
export function appendActionChoice(rootEl, { question, onChoice }) {
  if (!rootEl) return { dismiss() {} };

  const card = document.createElement('div');
  card.className = 'g-msg g-msg-assistant g-action-choice';
  card.innerHTML = `
    <p class="g-action-question">${esc(question)}</p>
    <div class="g-action-btns">
      <button class="g-action-btn g-action-do" data-choice="do_it">✅ Do it for me</button>
      <button class="g-action-btn g-action-guide" data-choice="guide_me">👆 Show me where</button>
    </div>
  `;

  card.querySelectorAll('.g-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-choice');
      // Disable both buttons immediately to prevent double-tap.
      card.querySelectorAll('.g-action-btn').forEach((b) => { b.disabled = true; });
      onChoice?.(choice);
    });
  });

  rootEl.appendChild(card);
  rootEl.scrollTop = rootEl.scrollHeight;

  return {
    dismiss() { card.remove(); },
  };
}

function _makeBubble(msg) {
  const div = document.createElement('div');
  div.className = `g-msg ${ROLE_CLASS[msg.role] ?? 'g-msg-assistant'}`;
  div.setAttribute('data-msg-id', msg.id || '');
  div.textContent = msg.content || '';
  return div;
}

const EXAMPLE_PROMPTS = [
  { emoji: '📄', text: 'Explain what I\'m seeing on my screen' },
  { emoji: '🔄', text: 'Help me renew my driver\'s license' },
  { emoji: '🛡', text: 'Check if this website is safe' },
];

function _makeEmptyState(rootEl) {
  const wrap = document.createElement('div');
  wrap.className = 'g-empty-state';
  wrap.innerHTML = `
    <div class="g-empty-icon">👋</div>
    <p class="g-empty-greeting">Hi! I'm Lumineer.</p>
    <p class="g-empty-sub">I can help you navigate websites,<br>understand what you're looking at,<br>and get things done online.</p>
    <div class="g-empty-chips">
      ${EXAMPLE_PROMPTS.map((p) => `<button class="g-empty-chip" type="button">${p.emoji} ${esc(p.text)}</button>`).join('')}
    </div>
  `;
  wrap.querySelectorAll('.g-empty-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('g-textarea');
      if (textarea) {
        textarea.value = btn.textContent.trim().replace(/^[\p{Emoji}\s]+/u, '').trim();
        textarea.focus();
      }
    });
  });
  return wrap;
}
