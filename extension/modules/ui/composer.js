/**
 * composer.js — goal input area for the autonomous agent.
 *
 * Single mode only: the user describes what they want to accomplish.
 * The mode/autonomy selector is gone — the agent handles everything automatically.
 *
 * When the agent is paused waiting for user input (ask_user), the placeholder
 * and hint text update to reflect that the agent is waiting for a reply.
 */

/**
 * Mount the composer into rootEl.
 * @param {HTMLElement} rootEl
 * @param {{ onSend }} opts
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
    <p class="g-hint" id="g-composer-hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</p>
  `;

  const ta = rootEl.querySelector('#g-textarea');
  const sendBtn = rootEl.querySelector('#g-send');
  const hint = rootEl.querySelector('#g-composer-hint');

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

    /** Switch the composer into "waiting for your answer" mode when the agent calls ask_user. */
    setWaitingForAnswer(waiting, question = '') {
      if (waiting) {
        ta.placeholder = question || 'Type your answer here…';
        if (hint) hint.textContent = 'The agent is waiting for your reply — type it and press Enter.';
        sendBtn.textContent = 'Reply';
      } else {
        ta.placeholder = 'What do you need help with? (e.g. renew my license, pay my bill…)';
        if (hint) hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line';
        sendBtn.textContent = 'Send';
      }
    },
  };
}
