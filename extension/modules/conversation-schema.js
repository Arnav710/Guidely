// Schema for persistent conversation storage (chrome.storage.local).
// Version bumps trigger migrate() — add new fields with defaults there.
export const SCHEMA_VERSION = 1;
export const STORE_KEY = 'guidely.v1';

// Goal-detection patterns — if the user's first message matches, we offer a workflow plan.
export const GOAL_PATTERNS = [
  /^help me /i,
  /^how (do|can) i /i,
  /^i (want|need) to /i,
  /^renew /i,
  /^appeal /i,
  /^set up /i,
  /^apply for /i,
  /^cancel /i,
  /^pay /i,
  /^file /i,
  /^sign up/i,
  /^register /i,
  /^schedule /i,
  /^book /i,
  /^change my /i,
  /^update my /i,
];

/** @returns {boolean} */
export function isGoalLike(text) {
  if (!text || text.length < 6) return false;
  return GOAL_PATTERNS.some((re) => re.test(text.trim()));
}

/** @returns {import('./conversation-store.js').Store} */
export function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeConversationId: null,
    conversations: {},
    settings: {
      autonomyLevel: 1,
      voiceEnabled: false,
      vigilanceEnabled: true,
      motionReduced: false,
      fontScale: 1,
    },
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
  merged.conversations = raw.conversations && typeof raw.conversations === 'object'
    ? raw.conversations : {};
  return merged;
}
