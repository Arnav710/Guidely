/**
 * composer.js — goal input area for the autonomous agent.
 *
 * UX:
 *   1. User types their question in the textarea.
 *   2. User selects a mode by clicking one of the three toggle buttons
 *      (they act like radio buttons — clicking selects, doesn't submit).
 *      Default selected mode is "autonomous" (Do it for me).
 *   3. User clicks the Send button (or presses Enter) to submit.
 *
 * When the agent is paused waiting for user input (ask_user), the mode buttons
 * are hidden and the composer enters "reply" mode with a plain Send button.
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
      <button type="button" id="g-send" aria-label="Send">Send</button>
    </div>
    <div class="g-mode-btns" id="g-mode-btns" role="group" aria-label="Choose how Guidely should help">
      <button type="button" class="g-mode-btn" data-mode="summarize" title="Read and explain what's on the screen">
        📄 Summarize
      </button>
      <button type="button" class="g-mode-btn g-mode-active" data-mode="autonomous" title="Navigate, click and fill in forms for you">
        ⚡ Do it for me
      </button>
      <button type="button" class="g-mode-btn" data-mode="guide" title="Highlight what you should click — no automation">
        👆 Guide me
      </button>
    </div>
    <p class="g-hint" id="g-composer-hint">Enter to send · Shift+Enter for new line</p>
  `;

  const ta = rootEl.querySelector('#g-textarea');
  const sendBtn = rootEl.querySelector('#g-send');
  const modeBtns = rootEl.querySelector('#g-mode-btns');
  const hint = rootEl.querySelector('#g-composer-hint');

  let _selectedMode = 'autonomous';

  function _selectMode(mode) {
    _selectedMode = mode;
    modeBtns.querySelectorAll('.g-mode-btn').forEach((b) => {
      b.classList.toggle('g-mode-active', b.dataset.mode === mode);
    });
  }

  // Mode buttons only select — they do NOT submit.
  modeBtns.querySelectorAll('.g-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => _selectMode(btn.dataset.mode));
  });

  function fire() {
    const text = (ta.value || '').trim();
    if (ta.disabled) return;
    onSend?.({ text, mode: _selectedMode });
    ta.value = '';
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
      modeBtns.querySelectorAll('.g-mode-btn').forEach((b) => { b.disabled = v; });
    },

    /** Switch the composer into "waiting for your answer" mode when the agent calls ask_user. */
    setWaitingForAnswer(waiting, question = '') {
      hint.dataset.waiting = waiting ? '1' : '';
      if (waiting) {
        ta.placeholder = question || 'Type your answer here…';
        hint.textContent = 'Type your reply and press Enter.';
        sendBtn.textContent = 'Reply';
        // Hide mode selector — user is just answering a question.
        modeBtns.style.display = 'none';
      } else {
        ta.placeholder = 'What do you need help with? (e.g. renew my license, pay my bill…)';
        hint.textContent = 'Enter to send · Shift+Enter for new line';
        sendBtn.textContent = 'Send';
        modeBtns.style.display = '';
      }
    },
  };
}
