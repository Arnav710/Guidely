/**
 * plan-view.js — renders the workflow step checklist inside the sidebar.
 * Pure render function; caller owns the root element.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const STATUS_ICON = {
  done:        '✓',
  in_progress: '◉',
  skipped:     '–',
  blocked:     '⚠',
  pending:     '○',
};

/**
 * Render the active workflow plan into rootEl.
 * @param {HTMLElement} rootEl
 * @param {object|null} workflow — the Conversation.workflow object from the store
 */
export function renderPlan(rootEl, workflow) {
  if (!workflow || !workflow.steps?.length) {
    rootEl.style.display = 'none';
    rootEl.innerHTML = '';
    return;
  }
  rootEl.style.display = 'block';

  const allDone = workflow.steps.every((s) => s.status === 'done' || s.status === 'skipped');

  rootEl.innerHTML = `
    <div class="g-plan">
      <div class="g-plan-header">
        <span class="g-plan-icon">${allDone ? '✓' : '📋'}</span>
        <span class="g-plan-goal">${esc(workflow.goal)}</span>
      </div>
      <ol class="g-plan-steps">
        ${workflow.steps.map((s, i) => {
          const isCurrent = i === workflow.currentStepIdx && !allDone;
          return `<li class="g-plan-step g-step-${esc(s.status)}${isCurrent ? ' g-step-current' : ''}">
            <span class="g-step-icon">${STATUS_ICON[s.status] ?? '○'}</span>
            <span class="g-step-desc">${esc(s.description)}</span>
          </li>`;
        }).join('')}
      </ol>
      ${allDone ? '<p class="g-plan-done">Task complete! 🎉</p>' : ''}
    </div>
  `;
}
