/**
 * conversation-list.js — collapsible list of conversations in the sidebar header area.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _stepBadge(conv) {
  if (!conv.workflow) return '';
  const done = conv.workflow.steps.filter((s) => s.status === 'done').length;
  const total = conv.workflow.steps.length;
  const all = done === total;
  return `<span class="g-conv-badge${all ? ' g-conv-badge-done' : ''}">${done}/${total} steps</span>`;
}

/**
 * Render the conversation list into rootEl.
 * @param {HTMLElement} rootEl
 * @param {object[]} conversations — sorted list from the store
 * @param {{ activeId, onSelect, onNew, onArchive, onDelete }} cbs
 */
export function renderConversationList(rootEl, conversations, { activeId, onSelect, onNew, onArchive, onDelete } = {}) {
  if (!rootEl) return;

  const active = conversations.filter((c) => c.status === 'active');
  const archived = conversations.filter((c) => c.status === 'archived');

  rootEl.innerHTML = `
    <div class="g-conv-toolbar">
      <span class="g-conv-label">Chats</span>
      <button type="button" class="g-conv-new" title="New conversation" aria-label="New conversation">＋ New</button>
    </div>
    <ul class="g-conv-list" role="listbox" aria-label="Conversations">
      ${active.map((c) => _convItem(c, activeId)).join('')}
      ${archived.length ? `
        <li class="g-conv-section-label">Archived</li>
        ${archived.slice(0, 5).map((c) => _convItem(c, activeId, true)).join('')}
      ` : ''}
    </ul>
  `;

  rootEl.querySelector('.g-conv-new')?.addEventListener('click', () => onNew?.());

  rootEl.querySelectorAll('.g-conv-item').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.g-conv-actions')) return;
      onSelect?.(li.dataset.convId);
    });
    li.querySelector('.g-conv-archive')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = li.dataset.convId;
      if (confirm('Archive this conversation?')) onArchive?.(id);
    });
    li.querySelector('.g-conv-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = li.dataset.convId;
      if (confirm('Delete this conversation permanently? This cannot be undone.')) onDelete?.(id);
    });
  });
}

function _convItem(conv, activeId, isArchived = false) {
  const isActive = conv.id === activeId;
  const msgCount = conv.messages?.length ?? 0;
  const badge = _stepBadge(conv);
  return `
    <li class="g-conv-item${isActive ? ' g-conv-active' : ''}${isArchived ? ' g-conv-archived' : ''}"
        data-conv-id="${esc(conv.id)}"
        role="option"
        aria-selected="${isActive}"
        tabindex="0">
      <span class="g-conv-title">${esc(conv.title)}</span>
      ${badge}
      ${msgCount > 0 ? `<span class="g-conv-count">${msgCount} msg${msgCount !== 1 ? 's' : ''}</span>` : ''}
      <span class="g-conv-actions">
        ${!isArchived ? `<button type="button" class="g-conv-archive" title="Archive">🗂</button>` : ''}
        <button type="button" class="g-conv-delete" title="Delete forever">🗑</button>
      </span>
    </li>
  `;
}
