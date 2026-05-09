/**
 * agent-sidebar.js — Cursor-style persistent agent panel.
 *
 * Dynamically imported from content.js via chrome.runtime.getURL().
 * Exports: mountSidebar(callbacks) → { open, close, appendLiveMessage }
 *
 * The sidebar survives page reloads by reading from conversation-store.js
 * (which reads chrome.storage.local). Only the DOM is rebuilt on each page;
 * the data is already persisted.
 */

import * as store from '../conversation-store.js';
import { renderPlan } from './plan-view.js';
import { renderThread, appendMessage as appendThreadMessage, showThinking } from './chat-thread.js';
import { mountComposer } from './composer.js';
import { renderConversationList } from './conversation-list.js';

// ── CSS ───────────────────────────────────────────────────────────────────────

const SIDEBAR_CSS = `
  #g-sidebar {
    position: fixed;
    top: 0;
    right: -420px;
    width: 400px;
    height: 100vh;
    z-index: 2147483644;
    background: #fafafa;
    box-shadow: -4px 0 28px rgba(0,0,0,0.18);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 15px;
    transition: right 0.3s ease;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    color: #222;
  }
  #g-sidebar.g-open { right: 0; }

  /* ── Header ── */
  #g-header {
    flex-shrink: 0;
    background: #fff;
    border-bottom: 1px solid #eee;
    padding: 12px 44px 0 14px;
  }
  #g-title {
    font-size: 18px;
    font-weight: 700;
    color: #FF6B35;
    margin: 0 0 8px;
    line-height: 1.2;
  }

  /* ── Conversation list (collapsible) ── */
  #g-conv-toggle {
    background: none;
    border: none;
    font-size: 12px;
    color: #888;
    cursor: pointer;
    padding: 0 0 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: inherit;
  }
  #g-conv-toggle:hover { color: #FF6B35; }
  #g-conv-panel {
    overflow: hidden;
    max-height: 0;
    transition: max-height 0.25s ease;
  }
  #g-conv-panel.g-expanded { max-height: 300px; overflow-y: auto; }

  .g-conv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 4px;
    border-top: 1px solid #f0f0f0;
  }
  .g-conv-label { font-size: 11px; color: #999; flex: 1; }
  .g-conv-new {
    font-size: 12px; color: #FF6B35; background: none; border: none;
    cursor: pointer; font-weight: 600; padding: 2px 6px;
    border-radius: 6px; font-family: inherit;
  }
  .g-conv-new:hover { background: #fff2ed; }
  .g-conv-list { list-style: none; margin: 0; padding: 0; }
  .g-conv-section-label { font-size: 11px; color: #bbb; padding: 6px 0 2px; }
  .g-conv-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 4px;
    border-radius: 8px;
    cursor: pointer;
    border: none;
    user-select: none;
    font-size: 13px;
  }
  .g-conv-item:hover { background: #f5f5f5; }
  .g-conv-item.g-conv-active { background: #fff2ed; }
  .g-conv-archived { opacity: 0.6; }
  .g-conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g-conv-badge {
    font-size: 10px; color: #FF6B35; background: #fff2ed;
    border-radius: 10px; padding: 1px 6px; white-space: nowrap;
  }
  .g-conv-badge-done { background: #eafaf1; color: #27ae60; }
  .g-conv-count { font-size: 10px; color: #bbb; white-space: nowrap; }
  .g-conv-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
  .g-conv-item:hover .g-conv-actions { opacity: 1; }
  .g-conv-actions button {
    background: none; border: none; cursor: pointer;
    font-size: 12px; padding: 2px; border-radius: 4px;
  }
  .g-conv-actions button:hover { background: #eee; }

  /* ── Plan view ── */
  #g-plan-pane {
    flex-shrink: 0;
    border-bottom: 1px solid #eee;
    padding: 0 14px;
    background: #fff;
  }
  .g-plan { padding: 8px 0; }
  .g-plan-header { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
  .g-plan-icon { font-size: 14px; margin-top: 1px; }
  .g-plan-goal { font-size: 13px; font-weight: 600; color: #444; line-height: 1.3; }
  .g-plan-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .g-plan-step { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; color: #666; line-height: 1.35; }
  .g-step-icon { flex-shrink: 0; font-size: 11px; margin-top: 2px; width: 12px; text-align: center; }
  .g-step-done .g-step-icon { color: #27ae60; }
  .g-step-done .g-step-desc { text-decoration: line-through; color: #aaa; }
  .g-step-current { color: #222; font-weight: 600; }
  .g-step-current .g-step-icon { color: #FF6B35; }
  .g-plan-done { font-size: 13px; color: #27ae60; font-weight: 600; margin: 4px 0 0; }

  /* ── Chat thread ── */
  #g-thread {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 12px 6px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .g-msg {
    max-width: 90%;
    padding: 11px 14px;
    border-radius: 16px;
    font-size: 15px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .g-msg-user {
    align-self: flex-end;
    background: #FF6B35;
    color: #fff;
    margin-left: 10%;
    border-bottom-right-radius: 4px;
  }
  .g-msg-assistant {
    align-self: flex-start;
    background: #fff;
    color: #222;
    border: 1px solid #e5e5e5;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    margin-right: 8%;
    border-bottom-left-radius: 4px;
  }
  .g-msg-error {
    align-self: flex-start;
    background: #fff5f5;
    color: #c0392b;
    border: 1px solid #f8c4c4;
    margin-right: 8%;
    font-size: 14px;
  }
  .g-msg-system {
    align-self: center;
    max-width: 100%;
    font-size: 12px;
    color: #999;
    background: transparent;
    padding: 2px 0;
    text-align: center;
  }
  .g-msg-vigilance {
    align-self: flex-start;
    background: #fffbf0;
    color: #8a6400;
    border: 1px solid #ffe680;
    margin-right: 8%;
    font-size: 14px;
  }
  .g-msg-thinking {
    align-self: flex-start;
    font-size: 22px;
    letter-spacing: 4px;
    color: #ccc;
    background: transparent;
    animation: g-dots 1.2s infinite;
    padding: 6px 8px;
  }
  @keyframes g-dots {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* ── Composer ── */
  #g-composer {
    flex-shrink: 0;
    background: #fff;
    border-top: 1px solid #eee;
    padding: 10px 12px 14px;
  }
  .g-mode-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .g-mode-btn {
    font-size: 11px;
    padding: 4px 9px;
    border-radius: 20px;
    border: 1.5px solid #ddd;
    background: #fff;
    cursor: pointer;
    color: #666;
    font-family: inherit;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .g-mode-btn:hover { border-color: #FF6B35; color: #FF6B35; }
  .g-mode-btn.g-mode-active {
    background: #FF6B35;
    border-color: #FF6B35;
    color: #fff;
  }
  .g-composer-row { display: flex; gap: 8px; align-items: flex-end; }
  #g-textarea {
    flex: 1;
    min-height: 56px;
    max-height: 140px;
    padding: 10px 12px;
    font-size: 15px;
    line-height: 1.45;
    border: 1.5px solid #ddd;
    border-radius: 12px;
    resize: vertical;
    box-sizing: border-box;
    font-family: inherit;
  }
  #g-textarea:focus { outline: none; border-color: #FF6B35; box-shadow: 0 0 0 3px rgba(255,107,53,0.12); }
  #g-textarea:disabled { background: #f5f5f5; color: #999; }
  #g-send {
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: #FF6B35;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.15s;
  }
  #g-send:hover:not(:disabled) { background: #e05a28; }
  #g-send:disabled { background: #ccc; cursor: not-allowed; }
  .g-hint { font-size: 11px; color: #bbb; margin: 6px 0 0; text-align: right; }

  /* ── Close button ── */
  #g-close {
    position: absolute;
    top: 10px;
    right: 10px;
    background: none;
    border: none;
    font-size: 22px;
    cursor: pointer;
    color: #bbb;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 6px;
    z-index: 10;
  }
  #g-close:hover { color: #666; background: #f5f5f5; }
`;

// ── Mount ─────────────────────────────────────────────────────────────────────

let _sidebarEl = null;
let _composerCtl = null;
let _unsubscribe = null;
let _convPanelOpen = false;
let _removeThinking = null;

/**
 * Mount the persistent agent sidebar into the current page.
 * Safe to call multiple times (idempotent — reuses existing DOM element).
 *
 * @param {{ onSubmit }} callbacks
 *   onSubmit({ conversationId, text, autonomyLevel }) → called when user sends a message.
 *   The caller is responsible for the actual API call + store updates.
 *
 * @returns {{ open, close, appendLiveMessage, showThinkingIndicator, hideThinkingIndicator }}
 */
export async function mountSidebar({ onSubmit } = {}) {
  if (!document.getElementById('g-sidebar-styles')) {
    const style = document.createElement('style');
    style.id = 'g-sidebar-styles';
    style.textContent = SIDEBAR_CSS;
    document.head.appendChild(style);
  }

  // If the sidebar is already in the DOM from a previous mount, reuse it.
  let sidebar = document.getElementById('g-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('div');
    sidebar.id = 'g-sidebar';
    sidebar.setAttribute('role', 'complementary');
    sidebar.setAttribute('aria-label', 'Guidely agent');
    sidebar.innerHTML = `
      <button type="button" id="g-close" title="Close Guidely" aria-label="Close Guidely">✕</button>
      <header id="g-header">
        <h2 id="g-title">💡 Guidely</h2>
        <button type="button" id="g-conv-toggle" aria-expanded="false">
          <span id="g-conv-toggle-icon">▾</span> Conversations
        </button>
        <div id="g-conv-panel" role="region" aria-label="Conversation list"></div>
      </header>
      <section id="g-plan-pane" aria-label="Workflow plan"></section>
      <section id="g-thread" aria-live="polite" aria-label="Chat messages"></section>
      <footer id="g-composer"></footer>
    `;
    document.body.appendChild(sidebar);
    _sidebarEl = sidebar;

    sidebar.querySelector('#g-close').addEventListener('click', () => sidebar.classList.remove('g-open'));

    // Conversation toggle
    const convToggle = sidebar.querySelector('#g-conv-toggle');
    const convPanel = sidebar.querySelector('#g-conv-panel');
    convToggle.addEventListener('click', () => {
      _convPanelOpen = !_convPanelOpen;
      convPanel.classList.toggle('g-expanded', _convPanelOpen);
      convToggle.setAttribute('aria-expanded', String(_convPanelOpen));
      sidebar.querySelector('#g-conv-toggle-icon').textContent = _convPanelOpen ? '▴' : '▾';
      if (_convPanelOpen) _renderConvList();
    });
  }

  _sidebarEl = sidebar;

  // Init the store
  await store.init();
  let active = await store.getActive();
  if (!active) active = await store.createConversation();

  // Mount composer
  const composerRoot = sidebar.querySelector('#g-composer');
  const settings = await store.getSettings();
  _composerCtl = mountComposer(composerRoot, {
    autonomyLevel: settings.autonomyLevel,
    onAutonomyChange: (level) => store.updateSettings({ autonomyLevel: level }),
    onSend: async (text) => {
      const curActive = await store.getActive();
      if (!curActive) return;
      _composerCtl.setDisabled(true);
      try {
        await onSubmit?.({ conversationId: curActive.id, text, autonomyLevel: settings.autonomyLevel });
      } finally {
        _composerCtl.setDisabled(false);
        _composerCtl.focus();
      }
    },
  });

  // Subscribe to store changes → re-render
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = store.subscribe(async () => {
    active = await store.getActive();
    await _rerender(sidebar, active);
  });

  await _rerender(sidebar, active);

  return {
    open() {
      sidebar.classList.add('g-open');
      _composerCtl?.focus();
    },
    close() { sidebar.classList.remove('g-open'); },

    /** Optimistically append a message bubble without waiting for a full re-render. */
    appendLiveMessage(message) {
      appendThreadMessage(sidebar.querySelector('#g-thread'), message);
    },

    showThinkingIndicator() {
      _removeThinking?.();
      _removeThinking = showThinking(sidebar.querySelector('#g-thread'));
    },
    hideThinkingIndicator() {
      _removeThinking?.();
      _removeThinking = null;
    },
  };
}

// ── Internal render ───────────────────────────────────────────────────────────

async function _rerender(sidebar, active) {
  if (!sidebar || !active) return;

  // Plan view
  renderPlan(sidebar.querySelector('#g-plan-pane'), active.workflow ?? null);

  // Thread
  renderThread(sidebar.querySelector('#g-thread'), active.messages ?? []);

  // Conversation list (only if panel is open — avoids re-querying storage constantly)
  if (_convPanelOpen) _renderConvList();
}

async function _renderConvList() {
  const panel = _sidebarEl?.querySelector('#g-conv-panel');
  if (!panel) return;
  const all = await store.listConversations({ includeArchived: true });
  const active = await store.getActive();
  renderConversationList(panel, all, {
    activeId: active?.id,
    onSelect: async (id) => {
      await store.setActive(id);
      _convPanelOpen = false;
      panel.classList.remove('g-expanded');
      _sidebarEl?.querySelector('#g-conv-toggle')?.setAttribute('aria-expanded', 'false');
      _sidebarEl?.querySelector('#g-conv-toggle-icon') && (_sidebarEl.querySelector('#g-conv-toggle-icon').textContent = '▾');
    },
    onNew: async () => {
      await store.createConversation();
      _convPanelOpen = false;
      panel.classList.remove('g-expanded');
    },
    onArchive: async (id) => {
      await store.archiveConversation(id);
      const newActive = await store.getActive();
      if (!newActive) await store.createConversation();
    },
    onDelete: async (id) => {
      await store.deleteConversation(id);
      const newActive = await store.getActive();
      if (!newActive) await store.createConversation();
    },
  });
}
