/**
 * composer.js — goal input area for the autonomous agent.
 *
 * Three modes available via buttons that appear when text is typed:
 *   summarize  — one-shot: tell me what I'm looking at
 *   autonomous — do it for me: navigate, click, fill forms
 *   guide      — show me where: highlight what to click, no automation
 *
 * When the agent is paused waiting for user input (ask_user), the mode buttons
 * are hidden and the composer enters "reply" mode.
 */

/**
 * Mount the composer into rootEl.
 * @param {HTMLElement} rootEl
 * @param {{ onSend }} opts  onSend receives { text, mode } where mode is 'summarize'|'autonomous'|'guide'
 * @returns {{ focus, setDisabled, setWaitingForAnswer }}
 */
export function mountComposer(rootEl, { onSend } = {}) {
  rootEl.innerHTML = `
    <div class="g-composer-row">
      <textarea
        id="g-textarea"
        rows="2"
        maxlength="2000"
        placeholder="What do you need help with? (e.g. renew my license, pay my bill…)"
        aria-label="Message to Guidely"
      ></textarea>
    </div>
    <div class="g-mode-btns" id="g-mode-btns" aria-label="Choose how Guidely should help">
      <button type="button" class="g-mode-btn" data-mode="summarize" title="Read and explain what's on the screen">
        📄 Summarize
      </button>
      <button type="button" class="g-mode-btn g-mode-primary" data-mode="autonomous" title="Navigate, click and fill in forms for you">
        ⚡ Do it for me
      </button>
      <button type="button" class="g-mode-btn" data-mode="guide" title="Highlight what you should click — no automation">
        👆 Guide me
      </button>
    </div>
    <p class="g-hint" id="g-composer-hint">Choose how you'd like help above</p>
  `;

  const ta = rootEl.querySelector('#g-textarea');
  const modeBtns = rootEl.querySelector('#g-mode-btns');
  const hint = rootEl.querySelector('#g-composer-hint');

  function fire(mode) {
    const text = (ta.value || '').trim();
    if (ta.disabled) return;
    onSend?.({ text, mode });
    ta.value = '';
  }

  modeBtns.querySelectorAll('.g-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => fire(btn.dataset.mode));
  });

  // Allow Enter key to trigger 'autonomous' mode (the default action).
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fire('autonomous');
    }
  });

  return {
    focus() { ta.focus(); },

    setDisabled(v) {
      ta.disabled = v;
      modeBtns.querySelectorAll('.g-mode-btn').forEach((b) => { b.disabled = v; });
      if (hint && !hint.dataset.waiting) {
        hint.textContent = v ? '…' : "Choose how you'd like help above";
      }
    },

    /** Switch the composer into "waiting for your answer" mode when the agent calls ask_user. */
    setWaitingForAnswer(waiting, question = '') {
      hint.dataset.waiting = waiting ? '1' : '';
      if (waiting) {
        ta.placeholder = question || 'Type your answer here…';
        hint.textContent = 'Type your reply and press Enter.';
        // Hide mode buttons — the user is just replying to a question.
        modeBtns.style.display = 'none';
        // Override Enter to send reply in autonomous mode.
        ta.onkeydown_reply = (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire('autonomous'); }
        };
      } else {
        ta.placeholder = 'What do you need help with? (e.g. renew my license, pay my bill…)';
        hint.textContent = "Choose how you'd like help above";
        modeBtns.style.display = '';
        ta.onkeydown_reply = null;
      }
    },
  };
}
