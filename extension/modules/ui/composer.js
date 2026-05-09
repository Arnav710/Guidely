/**
 * composer.js — text input area + send button + autonomy level selector.
 */

const AUTONOMY_LABELS = [
  { value: 0, label: 'Explain only', title: 'I will just explain what the page is about.' },
  { value: 1, label: 'Highlight', title: 'I will point to the next button or field.' },
  { value: 2, label: 'Fill + Ask', title: 'I will fill forms but ask before clicking Submit.' },
  { value: 3, label: 'Auto + Confirm', title: 'I will act, with a 3-second hold-to-confirm.' },
];

/**
 * Mount the composer into rootEl.
 * @param {HTMLElement} rootEl
 * @param {{ autonomyLevel, onSend, onAutonomyChange }} opts
 * @returns {{ focus, setDisabled, setAutonomyLevel }}
 */
export function mountComposer(rootEl, { autonomyLevel = 1, onSend, onAutonomyChange } = {}) {
  rootEl.innerHTML = `
    <div class="g-mode-row" role="group" aria-label="Assistance level">
      ${AUTONOMY_LABELS.map((a) => `
        <button type="button"
          class="g-mode-btn${a.value === autonomyLevel ? ' g-mode-active' : ''}"
          data-level="${a.value}"
          title="${a.title}"
          aria-pressed="${a.value === autonomyLevel}"
        >${a.label}</button>
      `).join('')}
    </div>
    <div class="g-composer-row">
      <textarea
        id="g-textarea"
        rows="2"
        maxlength="2000"
        placeholder="Ask anything about this page… (Enter to send)"
        aria-label="Message to Guidely"
      ></textarea>
      <button type="button" id="g-send" aria-label="Send">Send</button>
    </div>
    <p class="g-hint">Enter send &nbsp;·&nbsp; Shift+Enter new line</p>
  `;

  const ta = rootEl.querySelector('#g-textarea');
  const sendBtn = rootEl.querySelector('#g-send');
  const modeBtns = rootEl.querySelectorAll('.g-mode-btn');

  // Autonomy buttons
  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const level = Number(btn.dataset.level);
      modeBtns.forEach((b) => {
        b.classList.toggle('g-mode-active', Number(b.dataset.level) === level);
        b.setAttribute('aria-pressed', String(Number(b.dataset.level) === level));
      });
      onAutonomyChange?.(level);
    });
  });

  function fire() {
    const text = (ta.value || '').trim();
    if (!ta.disabled) {
      onSend?.(text);
      ta.value = '';
    }
  }

  sendBtn.addEventListener('click', fire);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fire();
    }
  });

  return {
    focus() { ta.focus(); },
    setDisabled(v) {
      ta.disabled = v;
      sendBtn.disabled = v;
      sendBtn.textContent = v ? '…' : 'Send';
    },
    setAutonomyLevel(level) {
      modeBtns.forEach((btn) => {
        const match = Number(btn.dataset.level) === level;
        btn.classList.toggle('g-mode-active', match);
        btn.setAttribute('aria-pressed', String(match));
      });
    },
  };
}
