// Schema for persistent conversation storage (chrome.storage.local).
// Version bumps trigger migrate() — add new fields with defaults there.
export const SCHEMA_VERSION = 2;
export const STORE_KEY = 'guidely.v1';

/** @returns {import('./conversation-store.js').Store} */
export function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeConversationId: null,
    conversations: {},
    settings: {
      voiceEnabled: false,
      vigilanceEnabled: true,
      motionReduced: false,
      fontScale: 1,
    },
  };
}

/**
 * Default agent session shape injected into every conversation.
 * @returns {AgentSession}
 */
export function emptyAgentSession() {
  return {
    status: 'idle',      // 'idle' | 'running' | 'paused' | 'done' | 'error'
    retryCount: 0,       // consecutive failures on the current step
    toolHistory: [],     // ring buffer of last 3 ToolCall records
    pendingUserQuestion: null,  // set when status === 'paused' (ask_user)
    awaitingPageLoad: false,    // true immediately after a navigate action
    lastNavUrl: null,           // the URL we navigated to (debug / resume hint)
  };
}

/**
 * Forward-migrate any older store shape. Safe to call on fresh stores too.
 * @param {unknown} raw
 * @returns {import('./conversation-store.js').Store}
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const fresh = emptyStore();
  const merged = { ...fresh, ...raw };
  merged.settings = { ...fresh.settings, ...(raw.settings || {}) };
  // Drop legacy autonomyLevel from settings if it was stored there
  delete merged.settings.autonomyLevel;
  merged.conversations = raw.conversations && typeof raw.conversations === 'object'
    ? raw.conversations : {};

  // Migrate each conversation: ensure agentSession field exists
  for (const conv of Object.values(merged.conversations)) {
    if (!conv.agentSession || typeof conv.agentSession !== 'object') {
      conv.agentSession = emptyAgentSession();
    } else {
      // Fill any missing fields added in later schema versions
      conv.agentSession = { ...emptyAgentSession(), ...conv.agentSession };
    }
  }

  return merged;
}
