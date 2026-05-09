/**
 * conversation-store.js
 *
 * Single source of truth for all persistent Guidely state.
 * Reads/writes chrome.storage.local. Broadcasts to all subscribers when the
 * store changes — including changes made in other tabs (via chrome.storage.onChanged).
 *
 * All public functions are async and return the latest data.
 * Call store.init() once before using any other function.
 */

import { STORE_KEY, emptyStore, migrate } from './conversation-schema.js';

const listeners = new Set();
let cache = null;
let initPromise = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for edge cases: RFC 4122 v4 via Math.random (non-secret IDs only).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function _load() {
  const result = await chrome.storage.local.get(STORE_KEY);
  cache = migrate(result[STORE_KEY]);
  return cache;
}

async function _save() {
  if (!cache) return;
  await chrome.storage.local.set({ [STORE_KEY]: cache });
}

function _broadcast() {
  for (const fn of listeners) {
    try { fn(cache); } catch { /* listener errors must not break the store */ }
  }
}

// Listen for changes made by other tabs / extension contexts.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORE_KEY]) return;
    cache = migrate(changes[STORE_KEY].newValue);
    _broadcast();
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Must be called once before using any other store function. Safe to call multiple times. */
export async function init() {
  if (!initPromise) initPromise = _load();
  return initPromise;
}

/**
 * Subscribe to store changes. Returns an unsubscribe function.
 * @param {(store: object) => void} fn
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Conversations ─────────────────────────────────────────────────────────────

/** @param {{ includeArchived?: boolean }} opts */
export async function listConversations({ includeArchived = false } = {}) {
  await init();
  return Object.values(cache.conversations)
    .filter((c) => includeArchived || c.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getActive() {
  await init();
  const id = cache.activeConversationId;
  return (id && cache.conversations[id]) || null;
}

export async function setActive(conversationId) {
  await init();
  if (conversationId !== null && !cache.conversations[conversationId]) return;
  cache.activeConversationId = conversationId;
  await _save();
  _broadcast();
}

/** Create a new conversation and make it the active one. */
export async function createConversation({ title = 'New conversation' } = {}) {
  await init();
  const id = uuid();
  const now = Date.now();
  cache.conversations[id] = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    messages: [],
    pages: [],
    workflow: null,
  };
  cache.activeConversationId = id;
  await _save();
  _broadcast();
  return cache.conversations[id];
}

export async function updateConversation(id, patch) {
  await init();
  const c = cache.conversations[id];
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: Date.now() });
  await _save();
  _broadcast();
  return c;
}

export async function archiveConversation(id) {
  return updateConversation(id, { status: 'archived' });
}

export async function deleteConversation(id) {
  await init();
  delete cache.conversations[id];
  if (cache.activeConversationId === id) {
    // Activate the most recent remaining active conversation, or null.
    const remaining = Object.values(cache.conversations)
      .filter((c) => c.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    cache.activeConversationId = remaining[0]?.id || null;
  }
  await _save();
  _broadcast();
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function appendMessage(conversationId, message) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c) return null;
  const msg = { id: uuid(), createdAt: Date.now(), ...message };
  c.messages.push(msg);
  c.updatedAt = msg.createdAt;
  // Auto-title: use first user message text, truncated.
  if (c.title === 'New conversation' && msg.role === 'user' && msg.content) {
    c.title = msg.content.slice(0, 60);
  }
  await _save();
  _broadcast();
  return msg;
}

/** Record a page visit in the conversation (deduplicated by URL). */
export async function recordPageVisit(conversationId, { url, title }) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c) return;
  const last = c.pages[c.pages.length - 1];
  if (last && last.url === url) return;
  c.pages.push({ url, title: title || '', visitedAt: Date.now() });
  c.updatedAt = Date.now();
  await _save();
  // No broadcast — page visits are background metadata; no UI reaction needed.
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export async function attachWorkflow(conversationId, plan) {
  const steps = (plan.steps || []).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    description: s.description,
    status: 'pending',
  }));
  return updateConversation(conversationId, {
    workflow: {
      goal: plan.goal,
      steps,
      currentStepIdx: 0,
      startedAt: Date.now(),
      completedAt: null,
    },
  });
}

/** Apply a step_update from the backend response. */
export async function applyStepUpdate(conversationId, stepUpdate) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c?.workflow) return;
  const step = c.workflow.steps.find((s) => s.id === stepUpdate.step_id);
  if (!step) return;
  step.status = stepUpdate.status;
  if (step.status === 'done') {
    // Advance currentStepIdx to the next non-done step.
    const nextIdx = c.workflow.steps.findIndex((s) => s.status === 'pending');
    c.workflow.currentStepIdx = nextIdx >= 0 ? nextIdx : c.workflow.steps.length;
    if (c.workflow.steps.every((s) => s.status === 'done' || s.status === 'skipped')) {
      c.workflow.completedAt = Date.now();
    }
  }
  c.updatedAt = Date.now();
  await _save();
  _broadcast();
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings() {
  await init();
  return { ...cache.settings };
}

export async function updateSettings(patch) {
  await init();
  cache.settings = { ...cache.settings, ...patch };
  await _save();
  _broadcast();
  return { ...cache.settings };
}
