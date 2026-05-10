/**
 * composer.js — goal input area for the autonomous agent.
 *
 * UX:
 *   1. User types (or speaks via mic button) their question.
 *   2. User selects a mode: Summarize | Do it for me | Guide me.
 *   3. User clicks Send (or presses Enter) to submit.
 *
 * Speech-to-text: Web Speech API (SpeechRecognition) — Chrome built-in, no deps.
 * Holding the mic button records; releasing sends automatically.
 */

/**
 * Mount the composer into rootEl.
 * @param {HTMLElement} rootEl
 * @param {{ onSend }} opts  onSend receives { text, mode }
 * @returns {{ focus, setDisabled, setWaitingForAnswer }}
 */
export function mountComposer(rootEl, { onSend } = {}) {
  const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  rootEl.innerHTML = `
    <div class="g-composer-row">
      <textarea
        id="g-textarea"
        rows="2"
        maxlength="2000"
        placeholder="What do you need help with? (e.g. renew my license, pay my bill…)"
        aria-label="Message to Guidely"
      ></textarea>
      ${hasSpeech ? '<button type="button" id="g-mic" aria-label="Speak" title="Hold to speak">🎤</button>' : ''}
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
  const micBtn = rootEl.querySelector('#g-mic');
  const modeBtns = rootEl.querySelector('#g-mode-btns');
  const hint = rootEl.querySelector('#g-composer-hint');

  let _selectedMode = 'autonomous';

  function _selectMode(mode) {
    _selectedMode = mode;
    modeBtns.querySelectorAll('.g-mode-btn').forEach((b) => {
      b.classList.toggle('g-mode-active', b.dataset.mode === mode);
    });
  }

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

  // ── Speech-to-text ──────────────────────────────────────────────────────────
  if (micBtn && hasSpeech) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.continuous = true;   // keep recording until explicitly stopped
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let _listening = false;

    function _setMicState(active) {
      _listening = active;
      micBtn.classList.toggle('g-mic-active', active);
      micBtn.title = active ? 'Click to stop recording' : 'Click to start recording';
      micBtn.textContent = active ? '⏹' : '🎤';
      ta.placeholder = active
        ? 'Listening…'
        : 'What do you need help with? (e.g. renew my license, pay my bill…)';
    }

    recognition.onstart = () => _setMicState(true);

    recognition.onresult = (e) => {
      let full = '';
      for (const result of e.results) {
        full += result[0].transcript;
      }
      ta.value = full;
    };

    recognition.onend = () => _setMicState(false);
    recognition.onerror = () => _setMicState(false);

    micBtn.addEventListener('click', () => {
      if (_listening) {
        try { recognition.stop(); } catch { /* ignore */ }
      } else {
        ta.value = '';
        try { recognition.start(); } catch { /* ignore */ }
      }
    });
  }

  return {
    focus() { ta.focus(); },

    setDisabled(v) {
      ta.disabled = v;
      sendBtn.disabled = v;
      sendBtn.textContent = v ? '…' : 'Send';
      if (micBtn) micBtn.disabled = v;
      modeBtns.querySelectorAll('.g-mode-btn').forEach((b) => { b.disabled = v; });
    },

    setWaitingForAnswer(waiting, question = '') {
      hint.dataset.waiting = waiting ? '1' : '';
      if (waiting) {
        ta.placeholder = question || 'Type your answer here…';
        hint.textContent = 'Type your reply and press Enter.';
        sendBtn.textContent = 'Reply';
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
