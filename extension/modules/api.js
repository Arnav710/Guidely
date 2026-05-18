/**
 * api.js — thin fetch wrappers for all Lumineer backend endpoints.
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

// ── Agent endpoints (new autonomous mode) ────────────────────────────────────

/**
 * POST /agent/start — interpret goal + page context, return a step plan.
 */
export async function agentStart({ goal, pageUrl = '', pageTitle = '', domSummary = '' }) {
  return _post('/agent/start', {
    goal,
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    dom_summary: domSummary || null,
  });
}

/**
 * POST /agent/step — non-streaming version (kept as fallback).
 */
export async function agentStep({
  goal,
  plan,
  lastToolCalls = [],
  pageUrl = '',
  pageTitle = '',
  screenshot = null,
  observation = null,
  retryCount = 0,
  loopIteration = 0,
  chatHistory = [],
} = {}) {
  const body = {
    goal,
    plan,
    last_tool_calls: lastToolCalls,
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    observation: observation || null,
    retry_count: retryCount,
    loop_iteration: loopIteration,
    chat_history: chatHistory,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;
  return _post('/agent/step', body);
}

/**
 * POST /agent/step/stream — streaming SSE version.
 *
 * Calls callbacks as SSE frames arrive:
 *   onThinking()                       — model started generating
 *   onThought(text)                    — partial thought text (progressive)
 *   onSearching(query)                 — web_search triggered
 *   onReplanning(reason)               — replan triggered
 *   onDone({ tool, params, display, thought, new_steps })
 *   onError(message)                   — unrecoverable error
 *
 * Returns a Promise that resolves once the stream is complete (or on error).
 */
export async function agentStepStream(
  { goal, plan, conversationId = null, lastToolCalls = [], pageUrl = '', pageTitle = '', screenshot = null, observation = null, retryCount = 0, loopIteration = 0, chatHistory = [] } = {},
  { onThinking, onThought, onSearching, onReplanning, onDone, onError } = {},
) {
  const body = {
    goal,
    plan,
    last_tool_calls: lastToolCalls,
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    observation: observation || null,
    retry_count: retryCount,
    conversation_id: conversationId || null,
    loop_iteration: loopIteration,
    chat_history: chatHistory,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000); // 4 min ceiling

  try {
    const res = await fetch(`${BACKEND}/agent/step/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.detail ?? `HTTP ${res.status}`;
      onError?.(typeof msg === 'string' ? msg : JSON.stringify(msg));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = leftover + decoder.decode(value, { stream: true });
      const lines = text.split('\n');
      // Keep any incomplete last line for the next iteration.
      leftover = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }

        switch (event.type) {
          case 'thinking':   onThinking?.(); break;
          case 'thought':    onThought?.(event.text ?? ''); break;
          case 'searching':  onSearching?.(event.query ?? ''); break;
          case 'replanning': onReplanning?.(event.reason ?? ''); break;
          case 'done':       onDone?.(event); break;
          case 'error':      onError?.(event.message ?? 'Unknown error'); break;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      onError?.('Request timed out. Ollama may be busy — try again.');
    } else {
      onError?.(err.message ?? 'Connection failed');
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Legacy endpoints (kept for backward compatibility) ────────────────────────

/**
 * POST /workflow/plan — generate the first 2-3 steps for a goal.
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
 * POST /workflow/extend — given the goal + completed steps + current page,
 * get the next 2-3 steps or a "done" signal.
 */
export async function extendWorkflow({
  goal,
  completedSteps = [],
  existingStepCount = 0,
  pageUrl = '',
  pageTitle = '',
  domSummary = '',
}) {
  return _post('/workflow/extend', {
    goal,
    completed_steps: completedSteps,
    existing_step_count: existingStepCount,
    context: {
      page_url: pageUrl || null,
      page_title: pageTitle || null,
      dom_summary: domSummary || null,
    },
  });
}

/**
 * POST /analyze — original page-understanding call (no longer used by the sidebar,
 * kept so popup.js health checks and any external tooling still work).
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
 * POST /explain — plain-English explainer for confusing text.
 */
export async function runExplain({ text, domainHint = 'generic' }) {
  return _post('/explain', { text, domain_hint: domainHint });
}

/**
 * POST /summarize — one-shot: take screenshot + visible text → plain-English summary.
 */
export async function summarizePage({
  screenshot = null,
  pageText = '',
  pageUrl = '',
  pageTitle = '',
  userQuestion = '',
} = {}) {
  const body = {
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    page_text: pageText ? pageText.slice(0, 8000) : null,
    user_question: userQuestion || null,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;
  return _post('/summarize', body);
}

/**
 * POST /camera/describe — demo: one RTSP frame + optional question → plain-English description.
 */
export async function describeCameraDemo({ question = '' } = {}) {
  return _post('/camera/describe', {
    question: question ? String(question).slice(0, 500) : null,
  });
}

/**
 * POST /guide — guide mode: identify the one thing the user should click.
 */
export async function guideMode({
  screenshot = null,
  pageUrl = '',
  pageTitle = '',
  domSummary = '',
  userQuestion = '',
} = {}) {
  const body = {
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    dom_summary: domSummary || null,
    user_question: userQuestion,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;
  return _post('/guide', body);
}

/**
 * POST /vigilance/scan — scam / manipulation triage for visible DOM + screenshot.
 */
export async function vigilanceScan({
  screenshot = null,
  pageUrl = '',
  pageTitle = '',
  domSummary = '',
  pageText = null,
} = {}) {
  const body = {
    page_url: pageUrl || null,
    page_title: pageTitle || null,
    dom_summary: domSummary || null,
    page_text: pageText || null,
  };
  if (screenshot && screenshot.length >= 80) body.screenshot = screenshot;
  return _post('/vigilance/scan', body);
}

/** GET /health — backend liveness check. */
export async function checkHealth() {
  try {
    const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
