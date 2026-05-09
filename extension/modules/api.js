/**
 * api.js — thin fetch wrappers for all Guidely backend endpoints.
 * All functions throw on network error or non-OK status (with a user-friendly message).
 */

const BACKEND = 'http://localhost:8000';
const TIMEOUT_MS = 120_000;

async function _post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json.detail;
      const msg = Array.isArray(detail)
        ? detail.map((e) => e.msg || JSON.stringify(e)).join(' ')
        : (typeof detail === 'string' ? detail : `HTTP ${res.status}`);
      throw new Error(msg);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Ollama may be busy — try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /analyze — main page-understanding call.
 * @param {{ conversationId, questionText, screenshot, domMap, history, workflow, autonomyLevel, pageUrl, pageTitle, trace }} opts
 */
export async function runAnalyze({
  conversationId = null,
  questionText = null,
  screenshot = null,
  domMap = [],
  history = [],
  workflow = null,
  autonomyLevel = 1,
  pageUrl = '',
  pageTitle = '',
  trace = false,
} = {}) {
  const path = trace ? '/analyze?trace=1' : '/analyze';
  const body = {
    dom_map: domMap,
    history,
    question: questionText || null,
    enable_tools: true,
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    conversation_id: conversationId || null,
    autonomy_level: autonomyLevel,
    workflow: workflow || null,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;
  return _post(path, body);
}

/**
 * POST /workflow/plan — generate a step-by-step plan for a goal.
 * @param {{ goal, pageUrl, pageTitle, domSummary }} opts
 * @returns {Promise<{ plan: { goal: string, steps: Array<{id, description}> } }>}
 */
export async function fetchWorkflowPlan({ goal, pageUrl = '', pageTitle = '', domSummary = '' }) {
  return _post('/workflow/plan', {
    goal,
    context: {
      page_url: pageUrl || null,
      page_title: pageTitle || null,
      dom_summary: domSummary || null,
    },
  });
}

/**
 * POST /explain — plain-English explainer for confusing text.
 * @param {{ text, domainHint }} opts
 */
export async function runExplain({ text, domainHint = 'generic' }) {
  return _post('/explain', { text, domain_hint: domainHint });
}

/** GET /health — backend liveness check (30-second version for polling). */
export async function checkHealth() {
  try {
    const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
