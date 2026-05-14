# Lumineer Implementation Plan — Persistent Agent Memory + Workflow Mode (P1 + P2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Lumineer's right-side panel from a per-page chat into a **persistent, Cursor-IDE-style agent sidebar** that retains every conversation across page reloads, navigations, and browser restarts, and that can drive a user end-to-end through a multi-page workflow (the canonical example: "renew my driver's license"). The conversation only ends when the user explicitly clears or archives it.

This plan implements **Phase P1 (persistent memory)** and a usable slice of **Phase P2 (workflow mode)** from the architecture doc. Vigilance, voice, explainer, and document/camera modules are separate plans.

**Architecture refs:** [`docs/superpowers/specs/2026-05-03-guidely-design.md`](../specs/2026-05-03-guidely-design.md) §§13–15, [`docs/guidely-architecture.md`](../../guidely-architecture.md) §§2.0, 4, 5, 6.2.

**Tech stack:** Chrome MV3 (vanilla JS + ES modules), `chrome.storage.local`, `chrome.storage.onChanged`, FastAPI (Python 3.11+), Pydantic v2, pytest, pytest-asyncio. **No new infra dependencies.** Redis is *not* added in this plan.

---

## File map (delta against current repo)

```
extension/
├── modules/                           # NEW directory
│   ├── conversation-store.js          # NEW — chrome.storage.local CRUD + cross-tab sync
│   ├── conversation-schema.js         # NEW — schema constants + migrate()
│   ├── workflow-runner.js             # NEW — plan state machine
│   ├── api.js                         # NEW — fetch wrapper for /analyze, /workflow/*
│   └── ui/
│       ├── agent-sidebar.js           # NEW — Cursor-style sidebar shell
│       ├── conversation-list.js       # NEW — recent + archived lists
│       ├── plan-view.js               # NEW — checklist for active workflow
│       ├── chat-thread.js             # NEW — message bubble renderer
│       └── composer.js                # NEW — textarea + send + autonomy selector
├── content.js                         # MODIFY — strip chat logic; import modules
└── manifest.json                      # MODIFY — add "storage" permission

backend/
├── routers/                           # NEW directory
│   ├── __init__.py                    # NEW
│   └── workflow.py                    # NEW — /workflow/plan, /workflow/step
├── services/
│   ├── __init__.py                    # NEW (if missing)
│   └── workflow.py                    # NEW — plan generation + step state
├── prompt/
│   └── workflow.py                    # NEW — plan/step prompt builders
├── models.py                          # MODIFY — add WorkflowPlanRequest/Response, etc.
└── tests/
    ├── test_conversation_store.spec.js  # NEW (jsdom unit tests via vitest, optional)
    ├── test_workflow_router.py        # NEW
    └── test_workflow_service.py       # NEW
```

---

## Task 1: Add `chrome.storage.local` schema + storage permission

**Files:**
- Modify: `extension/manifest.json`
- Create: `extension/modules/conversation-schema.js`

- [ ] **Step 1: Add `storage` permission to manifest**

In `extension/manifest.json`, add `"storage"` to the `permissions` array (alongside `activeTab`, `tabs`, `scripting`).

- [ ] **Step 2: Define the schema module**

Create `extension/modules/conversation-schema.js`:

```javascript
// Schema versioning lets us evolve the store without breaking existing users.
export const SCHEMA_VERSION = 1;
export const STORE_KEY = 'lumineer.v1';

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {'user'|'assistant'|'system'|'vigilance'} role
 * @property {string} content
 * @property {number} createdAt
 * @property {string=} pageUrl
 * @property {string=} pageTitle
 * @property {string=} suggestedSelector
 * @property {string=} suggestedLabel
 * @property {Object=} trace
 */

/**
 * @typedef {Object} WorkflowStep
 * @property {string} id
 * @property {string} description
 * @property {'pending'|'in_progress'|'done'|'skipped'|'blocked'} status
 * @property {Object=} evidence
 */

/**
 * @typedef {Object} Workflow
 * @property {string} goal
 * @property {WorkflowStep[]} steps
 * @property {number} currentStepIdx
 * @property {number} startedAt
 * @property {number=} completedAt
 */

/**
 * @typedef {Object} PageVisit
 * @property {string} url
 * @property {string} title
 * @property {number} visitedAt
 * @property {string=} summary
 */

/**
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {'active'|'archived'} status
 * @property {Message[]} messages
 * @property {Workflow=} workflow
 * @property {PageVisit[]} pages
 */

/**
 * @typedef {Object} Settings
 * @property {0|1|2|3} autonomyLevel
 * @property {boolean} voiceEnabled
 * @property {boolean} vigilanceEnabled
 * @property {boolean} motionReduced
 * @property {1|1.25|1.5} fontScale
 */

/**
 * @typedef {Object} Store
 * @property {1} schemaVersion
 * @property {string|null} activeConversationId
 * @property {Object<string, Conversation>} conversations
 * @property {Settings} settings
 */

/** @returns {Store} */
export function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeConversationId: null,
    conversations: {},
    settings: {
      autonomyLevel: 1,           // highlight-only is the safe default
      voiceEnabled: false,
      vigilanceEnabled: true,
      motionReduced: false,
      fontScale: 1,
    },
  };
}

/**
 * Migrate any older store shape forward. The current implementation just
 * fills missing fields; future versions add real migration logic.
 * @param {unknown} raw
 * @returns {Store}
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const fresh = emptyStore();
  return { ...fresh, ...raw, settings: { ...fresh.settings, ...(raw.settings || {}) } };
}
```

- [ ] **Step 3: Reload the extension and verify `chrome.storage` permission was granted**

```
1. chrome://extensions → click reload on Lumineer
2. Open the toolbar popup → DevTools → console:
     chrome.storage.local.get(null, console.log)
   Expected: {} (no error about missing permission).
```

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension/modules/conversation-schema.js
git commit -m "feat(extension): add storage permission + conversation schema scaffold"
```

---

## Task 2: `conversation-store.js` — CRUD + cross-tab sync

**Files:**
- Create: `extension/modules/conversation-store.js`

This module is the **single point of truth** for chat history. Every read or write to `chrome.storage.local` goes through it.

- [ ] **Step 1: Create the store module**

```javascript
import { STORE_KEY, emptyStore, migrate } from './conversation-schema.js';

const listeners = new Set();
let cache = null;
let initPromise = null;

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (older Chrome): RFC 4122 v4 via Math.random — fine for non-secret IDs only.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function load() {
  const result = await chrome.storage.local.get(STORE_KEY);
  cache = migrate(result[STORE_KEY]);
  return cache;
}

async function save() {
  if (!cache) return;
  await chrome.storage.local.set({ [STORE_KEY]: cache });
}

export async function init() {
  if (!initPromise) {
    initPromise = load();
  }
  return initPromise;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast() {
  for (const fn of listeners) {
    try { fn(cache); } catch { /* listener bug — ignore */ }
  }
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORE_KEY]) return;
    cache = migrate(changes[STORE_KEY].newValue);
    broadcast();
  });
}

// ── Conversations ───────────────────────────────────────────────────────────

export async function listConversations({ includeArchived = false } = {}) {
  await init();
  const all = Object.values(cache.conversations);
  return all
    .filter((c) => includeArchived || c.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getActive() {
  await init();
  if (!cache.activeConversationId) return null;
  return cache.conversations[cache.activeConversationId] || null;
}

export async function setActive(conversationId) {
  await init();
  if (conversationId !== null && !cache.conversations[conversationId]) return;
  cache.activeConversationId = conversationId;
  await save();
  broadcast();
}

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
  };
  cache.activeConversationId = id;
  await save();
  broadcast();
  return cache.conversations[id];
}

export async function updateConversation(id, patch) {
  await init();
  const c = cache.conversations[id];
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: Date.now() });
  await save();
  broadcast();
  return c;
}

export async function archiveConversation(id) {
  return updateConversation(id, { status: 'archived' });
}

export async function deleteConversation(id) {
  await init();
  delete cache.conversations[id];
  if (cache.activeConversationId === id) cache.activeConversationId = null;
  await save();
  broadcast();
}

// ── Messages ────────────────────────────────────────────────────────────────

export async function appendMessage(conversationId, message) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c) return null;
  const msg = { id: uuid(), createdAt: Date.now(), ...message };
  c.messages.push(msg);
  c.updatedAt = msg.createdAt;
  // Auto-set the conversation title from the first user message
  if (c.title === 'New conversation' && msg.role === 'user' && msg.content) {
    c.title = msg.content.slice(0, 60);
  }
  await save();
  broadcast();
  return msg;
}

export async function recordPageVisit(conversationId, { url, title, summary }) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c) return;
  const last = c.pages[c.pages.length - 1];
  if (last && last.url === url) return; // dedupe consecutive visits
  c.pages.push({ url, title: title || '', visitedAt: Date.now(), summary });
  c.updatedAt = Date.now();
  await save();
  broadcast();
}

// ── Workflow ────────────────────────────────────────────────────────────────

export async function attachWorkflow(conversationId, plan) {
  return updateConversation(conversationId, {
    workflow: {
      goal: plan.goal,
      steps: plan.steps.map((s) => ({ ...s, status: s.status || 'pending' })),
      currentStepIdx: 0,
      startedAt: Date.now(),
    },
  });
}

export async function applyStepUpdate(conversationId, stepUpdate) {
  await init();
  const c = cache.conversations[conversationId];
  if (!c?.workflow) return;
  const step = c.workflow.steps.find((s) => s.id === stepUpdate.step_id);
  if (!step) return;
  step.status = stepUpdate.status;
  if (stepUpdate.evidence) step.evidence = stepUpdate.evidence;
  if (step.status === 'done') {
    const nextIdx = c.workflow.steps.findIndex((s) => s.status === 'pending');
    c.workflow.currentStepIdx = nextIdx >= 0 ? nextIdx : c.workflow.steps.length;
    if (c.workflow.steps.every((s) => s.status === 'done' || s.status === 'skipped')) {
      c.workflow.completedAt = Date.now();
    }
  }
  c.updatedAt = Date.now();
  await save();
  broadcast();
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSettings() {
  await init();
  return { ...cache.settings };
}

export async function updateSettings(patch) {
  await init();
  cache.settings = { ...cache.settings, ...patch };
  await save();
  broadcast();
  return { ...cache.settings };
}
```

- [ ] **Step 2: Smoke-test in DevTools**

Reload the extension, open any normal webpage, then in the page DevTools console:

```javascript
const store = await import(chrome.runtime.getURL('modules/conversation-store.js'));
const c = await store.createConversation({ title: 'Test' });
await store.appendMessage(c.id, { role: 'user', content: 'hi' });
console.log(await store.listConversations());
// reload the page → re-run listConversations() → conversation is still there
```

- [ ] **Step 3: Commit**

```bash
git add extension/modules/conversation-store.js
git commit -m "feat(extension): conversation store with cross-tab sync"
```

---

## Task 3: Sidebar shell — `agent-sidebar.js` + `conversation-list.js` + `chat-thread.js` + `composer.js`

**Files:**
- Create: `extension/modules/ui/agent-sidebar.js`
- Create: `extension/modules/ui/conversation-list.js`
- Create: `extension/modules/ui/chat-thread.js`
- Create: `extension/modules/ui/composer.js`

These four files split the existing inline sidebar in `content.js` into named modules. Each is a small render function that takes the current conversation + a callbacks object.

- [ ] **Step 1: `chat-thread.js` — render messages**

```javascript
export function renderThread(rootEl, messages, opts = {}) {
  rootEl.innerHTML = '';
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = `lumineer-msg lumineer-msg-${m.role}`;
    div.textContent = m.content;
    rootEl.appendChild(div);
  }
  if (opts.autoscroll !== false) rootEl.scrollTop = rootEl.scrollHeight;
}
```

- [ ] **Step 2: `composer.js` — textarea + send + autonomy selector**

```javascript
export function mountComposer(rootEl, { onSend, onAutonomyChange, autonomyLevel }) {
  rootEl.innerHTML = `
    <div class="lumineer-composer">
      <div class="lumineer-mode-row">
        <label><input type="radio" name="lumineer-mode" value="0"> Explain</label>
        <label><input type="radio" name="lumineer-mode" value="1"> Highlight</label>
        <label><input type="radio" name="lumineer-mode" value="2"> Fill+Ask</label>
        <label><input type="radio" name="lumineer-mode" value="3"> Auto+Confirm</label>
      </div>
      <textarea id="lumineer-question" rows="3" maxlength="2000"
        placeholder="Message Lumineer… (Enter to send, Shift+Enter for new line)"
        aria-label="Message to Lumineer"></textarea>
      <div class="lumineer-send-row">
        <span class="lumineer-send-hint">Enter send · Shift+Enter newline</span>
        <button type="button" id="lumineer-send">Send</button>
      </div>
    </div>
  `;
  const ta = rootEl.querySelector('#lumineer-question');
  const send = rootEl.querySelector('#lumineer-send');
  const radios = rootEl.querySelectorAll('input[name="lumineer-mode"]');
  for (const r of radios) {
    if (Number(r.value) === autonomyLevel) r.checked = true;
    r.addEventListener('change', () => onAutonomyChange?.(Number(r.value)));
  }
  send.addEventListener('click', () => fire());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fire();
    }
  });
  function fire() {
    const text = (ta.value || '').trim();
    onSend?.(text);
    ta.value = '';
    ta.focus();
  }
  return { focus: () => ta.focus(), setDisabled: (v) => { ta.disabled = v; send.disabled = v; } };
}
```

- [ ] **Step 3: `conversation-list.js` — recent + archived**

```javascript
export function renderConversationList(rootEl, conversations, { activeId, onSelect, onNew }) {
  rootEl.innerHTML = `
    <div class="lumineer-conv-header">
      <span>Conversations</span>
      <button type="button" id="lumineer-new-conv" title="New conversation">＋</button>
    </div>
    <ul class="lumineer-conv-list" role="list"></ul>
  `;
  rootEl.querySelector('#lumineer-new-conv').addEventListener('click', () => onNew?.());
  const ul = rootEl.querySelector('.lumineer-conv-list');
  for (const c of conversations) {
    const li = document.createElement('li');
    li.className = 'lumineer-conv-item' + (c.id === activeId ? ' active' : '');
    const stepsDone = c.workflow ? c.workflow.steps.filter((s) => s.status === 'done').length : 0;
    const stepsTotal = c.workflow ? c.workflow.steps.length : 0;
    const stepBadge = c.workflow ? ` · ${stepsDone}/${stepsTotal}` : '';
    li.innerHTML = `
      <span class="lumineer-conv-title">${escapeHtml(c.title)}</span>
      <span class="lumineer-conv-meta">${c.status === 'archived' ? 'archived' : ''}${stepBadge}</span>
    `;
    li.addEventListener('click', () => onSelect?.(c.id));
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

- [ ] **Step 4: `agent-sidebar.js` — wires it all together**

```javascript
import * as store from '../conversation-store.js';
import { renderConversationList } from './conversation-list.js';
import { renderThread } from './chat-thread.js';
import { mountComposer } from './composer.js';

export async function mountSidebar({ onSubmit }) {
  if (document.getElementById('lumineer-sidebar')) return;
  const sidebar = document.createElement('div');
  sidebar.id = 'lumineer-sidebar';
  sidebar.setAttribute('role', 'complementary');
  sidebar.setAttribute('aria-label', 'Lumineer agent');
  sidebar.innerHTML = `
    <button type="button" id="lumineer-close" title="Close">✕</button>
    <header id="lumineer-sidebar-header">
      <h1>💡 Lumineer</h1>
    </header>
    <section id="lumineer-conv-pane"></section>
    <section id="lumineer-plan-pane"></section>
    <section id="lumineer-thread-pane" aria-live="polite"></section>
    <footer id="lumineer-composer-pane"></footer>
  `;
  document.body.appendChild(sidebar);
  sidebar.querySelector('#lumineer-close').addEventListener('click', () =>
    sidebar.classList.remove('open')
  );

  await store.init();

  let active = await store.getActive();
  if (!active) active = await store.createConversation();

  const composerCtl = mountComposer(sidebar.querySelector('#lumineer-composer-pane'), {
    autonomyLevel: (await store.getSettings()).autonomyLevel,
    onAutonomyChange: (level) => store.updateSettings({ autonomyLevel: level }),
    onSend: async (text) => {
      composerCtl.setDisabled(true);
      try {
        await onSubmit({ text, conversationId: active.id });
      } finally {
        composerCtl.setDisabled(false);
      }
    },
  });

  async function rerender() {
    const list = await store.listConversations({ includeArchived: true });
    renderConversationList(sidebar.querySelector('#lumineer-conv-pane'), list, {
      activeId: active?.id,
      onSelect: async (id) => {
        await store.setActive(id);
        active = await store.getActive();
        rerender();
      },
      onNew: async () => {
        active = await store.createConversation();
        rerender();
      },
    });
    renderThread(sidebar.querySelector('#lumineer-thread-pane'), active?.messages || []);
    // plan-view.js will be wired in Task 6.
  }

  store.subscribe(async () => {
    active = await store.getActive();
    rerender();
  });

  await rerender();
  return {
    open: () => { sidebar.classList.add('open'); composerCtl.focus(); },
    close: () => sidebar.classList.remove('open'),
  };
}
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/ui/
git commit -m "feat(extension): split sidebar into agent-sidebar + thread + composer + conversation list"
```

---

## Task 4: Rewire `content.js` to use the new sidebar

**Files:**
- Modify: `extension/content.js`

The existing `content.js` becomes a thin entry point. Its DOM serializer, highlight overlay, and capture flow stay; the inline chat UI is replaced by a call to `mountSidebar`.

- [ ] **Step 1: Move existing chat-state references behind the new store**

In `submitLumineerMessage`, replace the in-memory `lumineer_history` with `store.appendMessage(conversationId, {...})` for both user and assistant turns. Replace welcome message with the first message of a freshly created conversation.

- [ ] **Step 2: Add a new entry-point `init()` that mounts the sidebar**

```javascript
import { mountSidebar } from './modules/ui/agent-sidebar.js';
import * as store from './modules/conversation-store.js';
import { runAnalyze } from './modules/api.js';        // see Task 5

let sidebarCtl;

async function init() {
  injectStyles();
  await store.init();
  sidebarCtl = await mountSidebar({
    onSubmit: async ({ text, conversationId }) => {
      await store.appendMessage(conversationId, {
        role: 'user',
        content: text || '(Suggested next step for this page)',
        pageUrl: window.location.href,
        pageTitle: document.title,
      });
      const result = await runAnalyze({ conversationId, text });
      await store.appendMessage(conversationId, {
        role: 'assistant',
        content: result.instruction,
        suggestedSelector: result.selector,
        suggestedLabel: result.element_label,
        trace: result.trace,
      });
      highlightElement(result.selector, result.element_label);
    },
  });

  await store.recordPageVisit(
    (await store.getActive()).id,
    { url: window.location.href, title: document.title }
  );

  const btn = getOrCreateButton();
  btn.addEventListener('click', () => sidebarCtl.open());
}
```

- [ ] **Step 3: Add manifest content-script support for ES modules**

In `manifest.json`, add:

```jsonc
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "type": "module",
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    { "resources": ["modules/*.js", "modules/ui/*.js"], "matches": ["<all_urls>"] }
  ]
}
```

> Note: Chrome MV3 supports `"type": "module"` content scripts in stable for some time now; if your target Chrome version is older, fall back to dynamic `import(chrome.runtime.getURL(...))` from a non-module entry point.

- [ ] **Step 4: Manual verification**

1. Reload extension. Visit `https://example.com`. Click the "💡 Help me" button.
2. Type a message, click Send. Confirm it appears in the thread.
3. **Reload the page** → the sidebar reopens, the conversation is still there.
4. Open a second tab on a different site, click Help me, send a message in conversation B. Switch back to tab 1: the conversation list should now show **two** conversations.
5. Close the browser; reopen; the conversations are still there.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js extension/manifest.json
git commit -m "feat(extension): rewire content script onto persistent agent sidebar"
```

---

## Task 5: Backend — `api.js` client + `conversation_id` plumbing on `/analyze`

**Files:**
- Create: `extension/modules/api.js`
- Modify: `backend/models.py`
- Modify: `backend/routers/analyze.py` (or `backend/main.py` if not yet split)

- [ ] **Step 1: Add a thin extension-side fetch wrapper**

```javascript
const BACKEND_DEFAULT = 'http://localhost:8000';

export async function runAnalyze({ conversationId, text, screenshot, domMap, history, autonomyLevel, workflow }) {
  const res = await fetch(`${BACKEND_DEFAULT}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversationId,
      question: text || null,
      screenshot,
      dom_map: domMap || [],
      history: history || [],
      autonomy_level: autonomyLevel ?? 1,
      workflow: workflow || null,
      page_url: location.href,
      page_title: document.title || null,
      enable_tools: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `HTTP ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Add new optional fields to `AnalyzeRequest` in `backend/models.py`**

```python
class AnalyzeRequest(BaseModel):
    screenshot: str | None = None
    dom_map: list[DomElement] = []
    history: list[HistoryEntry] = []
    question: str | None = None
    enable_tools: bool = True
    page_url: str | None = None
    page_title: str | None = None
    # New (P1/P2)
    conversation_id: str | None = None
    autonomy_level: int = 1
    workflow: WorkflowSnapshot | None = None


class WorkflowSnapshot(BaseModel):
    goal: str
    steps: list[WorkflowStep]
    current_step_idx: int


class WorkflowStep(BaseModel):
    id: str
    description: str
    status: Literal["pending", "in_progress", "done", "skipped", "blocked"]


class StepUpdate(BaseModel):
    step_id: str
    status: Literal["pending", "in_progress", "done", "skipped", "blocked"]
    evidence: dict | None = None


class AnalyzeResponse(BaseModel):
    instruction: str
    element_label: str | None = None
    selector: str | None = None
    model_used: str | None = None
    trace: dict | None = None
    # New (P2)
    step_update: StepUpdate | None = None
```

Validate `autonomy_level` ∈ {0, 1, 2, 3} via `Field(ge=0, le=3)`.

- [ ] **Step 3: Use these fields in the prompt**

In `backend/prompt.py` (or `prompt/builders.py`), include the workflow snapshot and current step description in the user-turn text whenever present, so Gemma can reason about progress and propose `step_update`.

- [ ] **Step 4: Add a unit test**

```python
def test_user_turn_includes_workflow_step():
    elements = [DomElement(id=1, tag="a", label="Renew Online", selector="a.renew", visible=True)]
    workflow = WorkflowSnapshot(
        goal="Renew California driver's license",
        current_step_idx=1,
        steps=[
            WorkflowStep(id="s1", description="Sign in", status="done"),
            WorkflowStep(id="s2", description="Open Renew Online section", status="in_progress"),
        ],
    )
    turn = build_user_turn(elements, history=[], workflow=workflow)
    assert "Renew Online" in turn
    assert "Open Renew Online section" in turn
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/api.js backend/models.py backend/prompt*.py backend/tests/
git commit -m "feat(backend): conversation_id + workflow on /analyze; thin extension api client"
```

---

## Task 6: Workflow router + plan view

**Files:**
- Create: `backend/services/workflow.py`
- Create: `backend/routers/workflow.py`
- Create: `backend/prompt/workflow.py`
- Modify: `backend/main.py` (include the new router)
- Create: `extension/modules/ui/plan-view.js`
- Create: `backend/tests/test_workflow_router.py`

- [ ] **Step 1: Plan generation prompt**

In `backend/prompt/workflow.py`:

```python
PLAN_SYSTEM_PROMPT = """You are Lumineer's workflow planner. Given a senior user's goal
and a snippet of the current webpage, produce a 3-8 step plan that will accomplish
the goal end-to-end. Each step is one short imperative sentence describing a
single user-facing action ("Sign in", "Open the renewal form", "Pay the fee").

Respond with ONLY valid JSON:
{
  "goal": "<echo the user's goal in one sentence>",
  "steps": [
    { "id": "s1", "description": "..." },
    ...
  ]
}
"""
```

- [ ] **Step 2: Service**

```python
# backend/services/workflow.py
from models import WorkflowPlanRequest, WorkflowPlanResponse, WorkflowStep
from ollama_client import call_ollama_text
from prompt.workflow import PLAN_SYSTEM_PROMPT
import json, uuid

async def generate_plan(req: WorkflowPlanRequest) -> WorkflowPlanResponse:
    user_text = (
        f"Goal: {req.goal}\n"
        f"Current page: {req.context.page_url}\n"
        f"Page title: {req.context.page_title}\n"
        f"Top interactive elements:\n{req.context.dom_summary}\n"
    )
    raw = await call_ollama_text(PLAN_SYSTEM_PROMPT, user_text, format_json=True)
    parsed = json.loads(raw)
    steps = [
        WorkflowStep(id=s.get("id") or f"s{idx+1}", description=s["description"], status="pending")
        for idx, s in enumerate(parsed["steps"][:8])
    ]
    return WorkflowPlanResponse(plan={"goal": parsed.get("goal", req.goal), "steps": steps})
```

- [ ] **Step 3: Router**

```python
# backend/routers/workflow.py
from fastapi import APIRouter, HTTPException
from models import WorkflowPlanRequest, WorkflowPlanResponse
from services.workflow import generate_plan
from ollama_client import OllamaUnavailableError

router = APIRouter(prefix="/workflow", tags=["workflow"])


@router.post("/plan", response_model=WorkflowPlanResponse)
async def plan(req: WorkflowPlanRequest):
    try:
        return await generate_plan(req)
    except OllamaUnavailableError:
        raise HTTPException(503, "Lumineer is offline. Please make sure Ollama is running.")
```

Wire this router in `backend/main.py`:

```python
from routers.workflow import router as workflow_router
app.include_router(workflow_router)
```

- [ ] **Step 4: Plan view in the sidebar**

```javascript
// extension/modules/ui/plan-view.js
export function renderPlan(rootEl, workflow) {
  if (!workflow) { rootEl.innerHTML = ''; return; }
  const itemsHtml = workflow.steps.map((s, idx) => {
    const isCurrent = idx === workflow.currentStepIdx;
    const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '◉' : '○';
    return `<li class="step status-${s.status}${isCurrent ? ' current' : ''}">
      <span class="icon">${icon}</span>
      <span class="desc">${escapeHtml(s.description)}</span>
    </li>`;
  }).join('');
  rootEl.innerHTML = `
    <div class="lumineer-plan">
      <h3>Plan: ${escapeHtml(workflow.goal)}</h3>
      <ol class="steps">${itemsHtml}</ol>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

Then call `renderPlan(sidebar.querySelector('#lumineer-plan-pane'), active.workflow)` in `agent-sidebar.js`'s `rerender`.

- [ ] **Step 5: Trigger plan generation on goal-style messages**

In `content.js`'s `onSubmit`, before calling `/analyze`, detect goal phrasing (rough heuristic: starts with "help me", "how do i", "i want to", "renew", "appeal", "set up", etc.). If matched and the conversation has no existing workflow, call `POST /workflow/plan` first, attach the plan via `store.attachWorkflow`, then proceed to `/analyze` for the immediate next-step instruction.

A simple regex set is enough for the demo:

```javascript
const GOAL_PATTERNS = [
  /^help me /i,
  /^how (do|can) i /i,
  /^i (want|need) to /i,
  /^renew /i,
  /^appeal /i,
  /^set up /i,
  /^cancel /i,
  /^pay /i,
];

function isGoalLike(text) {
  return GOAL_PATTERNS.some((re) => re.test(text || ''));
}
```

- [ ] **Step 6: Integration test**

```python
# backend/tests/test_workflow_router.py
import pytest
from unittest.mock import patch
from httpx import AsyncClient, ASGITransport
from main import app


@pytest.mark.asyncio
async def test_plan_returns_steps():
    fake = '{"goal":"Renew California driver\'s license","steps":[{"id":"s1","description":"Sign in"}]}'
    with patch("services.workflow.call_ollama_text", return_value=fake):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            res = await c.post("/workflow/plan", json={
                "goal": "renew my license",
                "context": {"page_url": "https://dmv.example", "page_title": "DMV", "dom_summary": "[]"},
            })
    assert res.status_code == 200
    assert res.json()["plan"]["steps"][0]["id"] == "s1"
```

- [ ] **Step 7: Commit**

```bash
git add backend/ extension/modules/ui/plan-view.js extension/content.js
git commit -m "feat(workflow): /workflow/plan + plan view + goal-detection trigger"
```

---

## Task 7: Step completion via `/analyze`

**Files:**
- Modify: `backend/services/analyze.py` (or `backend/ollama_client.py`)
- Modify: `backend/prompt.py`
- Modify: `extension/content.js`

- [ ] **Step 1: Tell the model about the active step**

When `workflow` is present in `AnalyzeRequest`, include this block in the user turn:

```
Active workflow:
  Goal: <goal>
  Current step (id=<id>): <description>
  Previous steps: [...done...]
  Remaining steps: [...pending...]

After answering, if you can confirm from the page that the current step is complete,
include a `step_update` field in the JSON: {"step_id": "...", "status": "done"}.
```

- [ ] **Step 2: Surface step_update in the response**

The response model already has `step_update` (Task 5). The JSON-extraction routine in `ollama_client.py` should pass it through unchanged.

- [ ] **Step 3: Apply step updates client-side**

In `content.js`'s `onSubmit`, after the `/analyze` response, call:

```javascript
if (result.step_update) {
  await store.applyStepUpdate(conversationId, result.step_update);
}
```

- [ ] **Step 4: Manual end-to-end test**

1. On any 2-page mock workflow (a fake DMV homepage + form), say "renew my license."
2. Plan appears with 4 steps.
3. Click the highlighted "Renew Online" link → page navigates → click Help me again → step 2 ticks ✓.
4. Reload the form page → step 2 stays ✓ (proves `chrome.storage.local` persistence).

- [ ] **Step 5: Commit**

```bash
git add backend/ extension/content.js
git commit -m "feat(workflow): step_update propagation from /analyze through to plan view"
```

---

## Task 8: Clear / archive UX + safety rails

**Files:**
- Modify: `extension/modules/ui/conversation-list.js`
- Modify: `extension/modules/ui/agent-sidebar.js`
- Modify: `extension/modules/conversation-store.js` (if needed)

- [ ] **Step 1: Add a kebab menu per conversation**

Each item in the conversation list gets a small ⋯ menu with "Rename", "Archive", "Delete forever". Both destructive actions show a `confirm()` (or a styled in-panel confirm) before firing.

- [ ] **Step 2: Add a top-level "Clear all" guarded by double-confirm**

```javascript
async function clearAll() {
  const ok1 = confirm('Clear all conversations? This cannot be undone.');
  if (!ok1) return;
  const ok2 = confirm('Are you absolutely sure? Type-confirm in next dialog.');
  if (!ok2) return;
  await chrome.storage.local.remove(STORE_KEY);
  location.reload();
}
```

- [ ] **Step 3: Auto-archive completed workflows**

When a workflow's `completedAt` is set, append a final assistant message: *"This task is complete. I'll archive this chat — you can find it under Archived."* and call `archiveConversation(id)`. The user can restore from the Archived list.

- [ ] **Step 4: Commit**

```bash
git add extension/
git commit -m "feat(memory): clear/archive flows, auto-archive completed workflows"
```

---

## Task 9: Smoke test the whole hero demo

Manual, end-to-end. Ollama running, backend running, extension loaded.

- [ ] **Step 1: Goal capture**

1. Visit a fake DMV homepage. Sidebar shows empty conversation list.
2. Click "💡 Help me", type "Help me renew my license", Send.
3. Assert: a new conversation appears in the list; a 4-step plan appears in the plan view; an assistant message gives the first step.

- [ ] **Step 2: Persistence**

1. Reload the page. Confirm the sidebar reopens and shows the same thread + plan.
2. Close the browser. Reopen. Confirm the conversation is still active.

- [ ] **Step 3: Cross-page workflow**

1. Click the highlighted "Renew Online" link.
2. On the new page, open the sidebar; the same conversation is the active one.
3. Click Help me again on the form; the next step's instruction appears; the plan ticks ✓ on step 2.

- [ ] **Step 4: Multiple conversations**

1. Click ＋ in the sidebar; start a new conversation: "Explain my insurance bill."
2. Switch back to the renew-license conversation via the list.
3. Both threads are intact.

- [ ] **Step 5: Clear and verify**

1. Use the kebab menu → Archive on the renew-license conversation.
2. Confirm it moves to the Archived section.
3. Restore from archived → conversation is active again.

- [ ] **Step 6: Commit & wrap**

```bash
git add .
git commit -m "test: hero demo smoke verified end-to-end"
```

---

## Self-review checklist

| Spec section | Covered by |
|---|---|
| §13 F1 Local Conversation Memory | Tasks 1–4, 8 |
| §13 F6 Assisted Workflow Mode | Tasks 5–7 |
| §14.3 Schema | Tasks 1, 2 |
| §14.5 Persistence lifecycle (reload, navigation, restart, clear) | Tasks 4, 8, 9 |
| §14.6 Sidebar UX (Cursor-style) | Tasks 3, 6, 8 |
| §15 Workflow Mode (plan + step + autonomy) | Tasks 5–7 |
| §15.4 Autonomy levels (selector in composer) | Task 3 |
| §15.5 Safety rails (no auto-fill of sensitive fields) | Backend prompt + Task 7 |
| §20 API surface (new `/workflow/*` endpoints) | Tasks 5, 6 |

**Out of scope for this plan (separate PRs / plans):** F4 Voice, F5 Vigilance, F7 Explainer, F8 Document/Camera. They share the persistent-conversation infra built here — each can be added as an additional message role and an additional backend route without touching the schema.
