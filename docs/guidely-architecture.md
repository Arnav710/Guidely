# Guidely — Feature Inventory & Extension Architecture

> **Revised 2026-05-06.** Major scope expansion. The feature surface is now organized around **8 named modules** (see §2.0); the chat panel is being upgraded to a **Cursor-IDE-style persistent agent sidebar** with workflows, voice, vigilance, and document/camera understanding. See the design spec for full requirements: [`docs/superpowers/specs/2026-05-03-guidely-design.md`](superpowers/specs/2026-05-03-guidely-design.md) (§§13–21).

This document steps back from the current codebase to list **what we want Guidely to do**, propose a **maintainable architecture** for the Chrome extension (and how it fits the backend), and outline **phased implementation** so we can evolve without painting ourselves into a corner.

---

## 1. Guiding principles

| Principle | Meaning |
|-----------|---------|
| **Local-first** | Primary inference runs on Ollama; no cloud LLM required for core flows. |
| **Least privilege** | Extension requests only permissions it needs; backend validates all inputs. |
| **Single responsibility** | Content script = page UX + DOM; background = privileged APIs; popup = settings/status; backend = orchestration + Ollama. |
| **Explicit failures** | Errors surface in the UI with actionable messages (already partially done). |
| **Testability** | Pure logic in small modules; HTTP/Ollama mocked in tests. |

---

## 2. Feature inventory (current + intended near-term)

### 2.0 Canonical feature modules (2026-05-06)

The product is decomposed into **8 modules**. Each row owns a well-defined slice of the codebase (see §4) and a backend route family (see the design spec §20).

| # | Module | One-liner | Anchor demo |
|---|---|---|---|
| **F1** | Local Conversation Memory | Chat thread survives reloads; only the user can clear it. | Reload mid-task → resume |
| **F2** | Webpage Understanding Engine | DOM map + screenshot → Gemma 4 → page summary. | Already shipped. |
| **F3** | Guided Web Navigation | Pulsing ring on the next button/field. | Already shipped; gets ESC/click clear + a11y. |
| **F4** | Voice Interaction Layer | Push-to-talk in, TTS out — strictly browser mic, never phone calls. | "What does Class C mean?" |
| **F5** | Vigilance Mode | Regex → Gemma 2B triage → Gemma 4 deep-explain cascade. | Phishing link warned before click. |
| **F6** | Assisted Workflow Mode | "Renew my license" → 4-step plan → guides through every page. | The hero demo. |
| **F7** | Senior-Friendly Explainer | Confusing text → "What this means / Why / What to do." | Insurance letter → plain English. |
| **F8** | Document & Camera Understanding | Webcam captures prescriptions, bills, insurance cards. | "Read this for me." |

The detailed status / target tables below (§§2.1–2.6) feed the modules above.

### 2.1 Core user journey (must-have)

| ID | Feature | Status today | Notes |
|----|---------|--------------|--------|
| F1 | **Floating entry point** (“Help me”) on ordinary web pages | ✅ | MV3 content script |
| F2 | **Side panel / drawer** with question box + submit | ✅ | Inline HTML/CSS in `content.js` |
| F3 | **Fresh tab screenshot** per request (`captureVisibleTab`) | ✅ | Background service worker |
| F4 | **DOM map** of interactive elements (labels, selectors, cap ~30) | ✅ | Content script |
| F5 | **POST to local backend** `/analyze` with screenshot + dom_map + history + question | ✅ | `localhost:8000` |
| F6 | **Ollama multimodal** — image + text to Gemma | ✅ | `/api/generate` |
| F7 | **Structured JSON response** — instruction + optional selector + highlight | ✅ | Pulse overlay on element |
| F8 | **Conversation history** (last N turns) for follow-ups | ✅ | Last ~5 rounds pattern |
| F9 | **Toolbar popup** — backend health + model switcher | ✅ | `popup.html` / `popup.js` |
| F10 | **Error surfacing** in-panel (network, Ollama, validation) | ✅ | Improved with API `detail` |

### 2.2 Model & ops

| ID | Feature | Status | Notes |
|----|---------|--------|--------|
| M1 | Default / preferred model (**e4b** over e2b when installed) | ✅ | Detection order in backend |
| M2 | **Switch active model** via API + popup | ✅ | |
| M3 | Optional **trace** (`?trace=1`) for debugging latency/payload sizes | ✅ | |
| M4 | Per-request **`enable_tools`** | ✅ | |

### 2.3 Tools & augmentation

| ID | Feature | Status | Notes |
|----|---------|--------|--------|
| T1 | **Web search tool** (DuckDuckGo text results) when model requests it | ✅ | Second Ollama round |
| T2 | Safe tool contract — query strings only, no arbitrary URL fetch from model | ✅ | `tools/web_search.py` |

### 2.4 Extension platform / maintainability (what we want next)

| ID | Feature | Module | Status | Target |
|----|---------|--------|--------|--------|
| E1 | **Split content script** into modules (config, api, dom-map, ui, highlight, messaging) | infra | ❌ | Single large `content.js` today |
| E2 | **Central config** — backend base URL, debug trace flag, max history | infra | ⚠️ | Hard-coded constants |
| E3 | **`chrome.storage.local`** for settings + chat history + workflows | F1 | ❌ | New: source of truth for conversations |
| E4 | **Single message protocol** between content ↔ background (typed envelopes) | infra | ⚠️ | Ad-hoc `{ type: 'CAPTURE' }` |
| E5 | **Optional devtools / logging** hook (debug flag only) | infra | ⚠️ | Partial (`GUIDELY_DEBUG_TRACE`) |
| E6 | **i18n-ready strings** (or at least string table) | infra | ❌ | English hard-coded |
| E7 | **Styles** isolated (shadow DOM or named CSS prefix — already prefixed `guidely-*`) | infra | ⚠️ | Global `<style>` injection |
| E8 | **Persistent agent sidebar** — Cursor-style: conversation list + active thread + plan view | F1+F6 | ❌ | New, top of P1 backlog |
| E9 | **`MutationObserver` + `webNavigation` listener** for vigilance triggers | F5 | ❌ | New |
| E10 | **`getUserMedia` camera surface** for document capture | F8 | ❌ | New, separate permission prompt |
| E11 | **`SpeechRecognition` / `SpeechSynthesis` bridge** | F4 | ❌ | New, browser-only, never records audio files |
| E12 | **Side Panel API** option (MV3 `sidePanel`) so sidebar is a true browser pane, not an injected `<div>` | F1 | ❌ | Stretch; share state with injected sidebar |

### 2.5 Backend maintainability (aligned with extension)

| ID | Feature | Module | Status | Target |
|----|---------|--------|--------|--------|
| B1 | **`analyze_guidely`** pipeline isolated from FastAPI route handlers | F2 | ⚠️ | Logic in `ollama_client.py` |
| B2 | **Prompt registry** — base / tools / follow-up / explainer / vigilance / vision prompts | F2/F5/F7/F8 | ⚠️ | Single `prompt.py` strings |
| B3 | **Tool registry** — register `web_search`, future tools | infra | ⚠️ | Explicit function + dispatch |
| B4 | **Structured logging** + optional request IDs for support | infra | ⚠️ | Partial |
| B5 | **`/explain` route** — text-in / 3-block plain-English out | F7 | ❌ | New |
| B6 | **`/vigilance/triage` + `/vigilance/explain`** — Gemma 2B + 4B cascade | F5 | ❌ | New |
| B7 | **`/workflow/plan` + `/workflow/step`** — plan generator + step tracker | F6 | ❌ | New |
| B8 | **`/vision/doc`** — doc-aware multimodal endpoint (camera or lasso crop) | F8 | ❌ | New |
| B9 | **Two-tier model strategy** — fast e2b for triage, e4b/26b for reasoning | infra | ⚠️ | Existing model switcher reused |
| B10 | **Optional Redis cache** for workflow state + vigilance triage memoization (Docker, OFF by default) | F6/F5 | ❌ | Phase 8 only; never the source of truth for chat |

### 2.6 Future (not committed — backlog)

- Offline queue when backend down / retry UX
- Per-site opt-out or "snooze" button
- Accessibility: keyboard trap, focus management in panel, screen-reader labels, user-controlled motion-reduce, font scaling 1×/1.25×/1.5×
- Multiple backend profiles (dev/staging URL)
- Rate limiting / payload caps documented for enterprise
- Redis-backed workflow agent (Phase 8): cross-tab state machine that drives multi-page tasks server-side
- Cross-device conversation sync (would require server-side persistence; out of local-first scope today)

---

## 3. Problems with the current extension shape

1. **Monolithic `content.js`** — DOM, styles, API calls, history, and UI are intertwined; hard to test and risky to extend.  
2. **Magic strings** — backend URL and flags duplicated; no sync with popup.  
3. **No shared module bundler** — vanilla ES modules are supported in MV3 service workers and extension pages, but **content scripts** historically needed bundling or single file unless using `"type": "module"` carefully (Chrome supports ES modules in MV3 content scripts when declared). Worth standardizing on **small ES modules + optional esbuild** if we outgrow hand-maintained files.  
4. **Popup vs content duplication** — health check logic exists only in popup; content script could show “backend down” before capture.

---

## 4. Target architecture (extension)

```
extension/
├── manifest.json
├── background.js              # Thin: message router, captureVisibleTab, chrome.alarms (vigilance)
├── popup.html / popup.js      # Settings + health + model
├── sidepanel.html / sidepanel.js  # Optional: same sidebar mounted as a real Side Panel (F1 stretch)
├── styles/
│   └── panel.css              # Bundled into the sidebar shadow root
├── modules/                   # ES modules
│   ├── config.js              # DEFAULT_BACKEND_URL, read overrides from chrome.storage
│   ├── protocol.js            # MESSAGE_TYPES, typed message envelopes
│   ├── api.js                 # analyze / explain / vigilance / workflow / vision clients
│   ├── dom-map.js             # buildDomMap, safe selectors (already implemented in content.js)
│   ├── capture.js             # requestScreenshot() → chrome.runtime.sendMessage
│   ├── conversation-store.js  # F1 — chrome.storage.local CRUD, schema migrations, cross-tab sync
│   ├── workflow-runner.js     # F6 — plan state machine, step transitions
│   ├── vigilance.js           # F5 — regex+DOM scan, debounced MutationObserver
│   ├── vigilance.patterns.js  # F5 — regex/heuristic table (unit-tested)
│   ├── voice.js               # F4 — Web Speech in/out wrapper, mic state machine
│   ├── camera.js              # F8 — getUserMedia, modal capture flow
│   ├── explainer.js           # F7 — context menu + selection bridge
│   ├── highlight.js           # F3 — overlay ring + ESC clear + a11y
│   └── ui/
│       ├── agent-sidebar.js   # F1 — Cursor-style sidebar shell
│       ├── conversation-list.js
│       ├── plan-view.js       # F6 — checklist UI for the active workflow
│       ├── chat-thread.js     # message bubbles
│       ├── composer.js        # textarea + send + mic button + autonomy selector
│       └── floating-button.js
└── assets/
```

**Messaging contract (typed envelopes, content ↔ background):**

```ts
type Msg =
  | { type: 'CAPTURE_SCREENSHOT'; requestId: string }
  | { type: 'VIGILANCE_TICK'; requestId: string; url: string }
  | { type: 'STORE_CHANGED'; key: string }       // broadcast on chrome.storage update
  | { type: 'VOICE_TTS_SAY'; text: string }
  | { type: 'CAMERA_OPEN' };

type Reply<T> = { requestId: string; ok: true; data: T } | { requestId: string; ok: false; error: string };
```

**Persistence (F1 — primary decision):**

- `chrome.storage.local` is the **source of truth** for chat history and workflows. Schema in design spec §14.3.
- `chrome.storage.sync` is used only for small user preferences that should follow the user across machines if Chrome Sync is on (font scale, motion reduce, autonomy default).
- `chrome.storage.onChanged` propagates updates so a sidebar in tab B reflects edits made in tab A.
- An `IndexedDB` fallback is added only if any single conversation grows past the `chrome.storage.local` quota (rare; we don't store screenshots in history).
- **Redis is not used by the extension**, ever. If a Redis cache is enabled on the backend, the extension neither knows nor cares — see §5 for that boundary.

---

## 5. Target architecture (backend — revised for the 8 modules)

```
backend/
├── main.py                    # FastAPI app: includes all routers; thin
├── routers/
│   ├── analyze.py             # F2/F3/F6 — POST /analyze
│   ├── explain.py             # F7    — POST /explain
│   ├── vigilance.py           # F5    — POST /vigilance/triage, /vigilance/explain
│   ├── workflow.py            # F6    — POST /workflow/plan, /workflow/step
│   ├── vision.py              # F8    — POST /vision/doc
│   └── platform.py            # GET /health, /models, POST /models/active
├── services/
│   ├── analyze.py             # validate request → analyze_guidely → response model
│   ├── explain.py             # text-only plain-English transformer
│   ├── vigilance.py           # triage (e2b) + deep explanation (e4b)
│   ├── workflow.py            # plan generator + step state machine; pluggable cache backend
│   └── vision.py              # doc-aware multimodal pipeline (camera / lasso crop)
├── ollama_client.py           # HTTP to Ollama + extract_json (existing)
├── prompt/
│   ├── __init__.py
│   ├── base.py                # SYSTEM_PROMPT (analyze)
│   ├── tools.py               # SYSTEM_PROMPT_WITH_TOOLS
│   ├── explain.py             # explainer system prompt + 3-block formatter
│   ├── vigilance.py           # triage/deep-explain prompts
│   ├── workflow.py            # plan / step prompts
│   ├── vision.py              # per-doc-type prompts (prescription, bill, insurance, medicare)
│   └── builders.py            # build_user_turn (existing)
├── cache/
│   ├── __init__.py            # `get_cache()` returns InMemoryCache or RedisCache
│   ├── memory.py              # default; works out of the box, no infra
│   └── redis.py               # used iff GUIDELY_REDIS_URL is set
├── models.py                  # Pydantic models for all routes
├── tools_bridge.py            # imports ../tools, executes tool_requests
└── tests/
```

**Backend boundary on chat history:** the backend is **stateless on the chat-history axis**. Every request carries its own `conversation_id` + recent messages from the client. The backend never persists chat content. The optional Redis cache stores **only execution metadata** (workflow step state, vigilance triage results keyed by URL hash) with TTLs, and is fully optional.

**Tools at repo root** (`tools/web_search.py`) stay where they are; long-term they move under `backend/tools/` once we have a second tool.

---

## 6. Data flow

### 6.1 Single ask (existing F2/F3 path)

```mermaid
sequenceDiagram
  participant User
  participant Content as Content (UI + DOM)
  participant BG as Background SW
  participant API as FastAPI
  participant Ollama
  participant DDG as tools/web_search

  User->>Content: Ask Guidely
  Content->>Content: buildDomMap()
  Content->>BG: CAPTURE (screenshot)
  BG-->>Content: base64 PNG
  Content->>API: POST /analyze (screenshot, dom_map, history, question, enable_tools, conversation_id)
  API->>Ollama: generate (image + prompt)
  alt Model requests web_search
    API->>DDG: web_search(query)
    DDG-->>API: snippets
    API->>Ollama: generate (image + prompt + snippets)
  end
  API-->>Content: JSON instruction + selector + step_update + optional trace
  Content->>Content: persist message in chrome.storage.local; highlight selector; show answer
```

### 6.2 Persistent conversation across pages (F1 + F6)

```mermaid
sequenceDiagram
  participant Page1 as Tab @ DMV homepage
  participant Page2 as Tab @ Renewal form (after click)
  participant Store as chrome.storage.local
  participant API as FastAPI

  Page1->>Store: read conversations[active_id]
  Page1->>API: POST /workflow/plan (goal=renew license)
  API-->>Page1: { plan: [s1..s4] }
  Page1->>Store: save plan into conversation
  Note over Page1: User clicks "Renew Online"
  Page1-->>Page2: navigation
  Page2->>Store: read conversations[active_id]  // SAME conversation
  Page2->>Store: append PageVisit(url=renewal-form)
  Page2->>API: POST /analyze (with conversation_id, current step=s2)
  API-->>Page2: { instruction, selector, step_update: { s2: "done" } }
  Page2->>Store: mark s2 done; sidebar plan view ticks ✓
```

### 6.3 Vigilance tick (F5)

```mermaid
sequenceDiagram
  participant Page
  participant Vig as modules/vigilance.js
  participant API
  participant E2B as Gemma 4 e2b
  participant E4B as Gemma 4 e4b

  Page->>Vig: webNavigation.onCompleted / MutationObserver batch
  Vig->>Vig: regex + URL heuristic scan
  alt no candidates
    Vig-->>Page: silent
  else candidates found
    Vig->>API: POST /vigilance/triage (url, top_dom_text, matched_patterns)
    API->>E2B: generate (short triage prompt)
    E2B-->>API: { risk, reason }
    alt risk == "high"
      API->>E4B: generate (deep explain prompt)
      E4B-->>API: senior-friendly explanation
      API-->>Vig: { risk: "high", explanation }
      Vig->>Page: surface ribbon + chat message
    else
      API-->>Vig: { risk: "low|medium", reason }
      Vig-->>Page: lightweight chip (only if medium); silent on low
    end
  end
```

---

## 7. Implementation phases (revised)

The original P1–P6 (refactor-only) phases collapse into infra-prep work that runs in parallel with feature delivery. The new phasing is feature-led, hackathon-pragmatic, and aligned with the design spec §21.

| Phase | Scope | Modules | Outcome |
|-------|---------|---------|---------|
| **P0** | Spec + this doc updated. | — | Shared understanding ✅ |
| **P1** | **Persistent conversation memory** in `chrome.storage.local` + Cursor-style sidebar shell with conversation list. Survives reloads + navigations. Extract `conversation-store.js`, `agent-sidebar.js`. | F1 | Reload-resilient chat. The user's #1 pain. |
| **P2** | **Workflow Mode** — `/workflow/plan` + `/workflow/step`, plan view in sidebar, autonomy selector (Levels 0–2). One canonical workflow ("renew license") drives the hero demo. | F6 | The headline product story. |
| **P3** | **Vigilance regex + e2b triage** with non-blocking ribbon. e4b deep-explain if time. | F5 | The "wow, it watches out for me" demo beat. |
| **P4** | **Voice** — push-to-talk in, TTS out via Web Speech. | F4 | Accessibility story. |
| **P5** | **Senior-Friendly Explainer** — `/explain` route + right-click trigger + 3-block formatter. | F7 | Insurance/Medicare demo beats. |
| **P6** | **Document & Camera Understanding** — webcam capture + lasso crop. | F8 | "Read this for me bro" demo. |
| **P7** | Polish — Side Panel API option, full a11y audit (font-scale, motion-reduce, focus management), cross-tab live sync, error/empty states. | infra | Feels finished. |
| **P8** | Refactor sweep — split monolithic `content.js`, central config, typed message protocol, prompt registry, backend router split. | infra | Maintainable code (was old P1–P6). |
| **P9** | Optional Redis cache for workflow state + vigilance memoization. Enabled via `GUIDELY_REDIS_URL`; off by default. | infra | Server-side perf only when needed. |

**Hackathon priority (May 6 → May 18):** P0 ✅ → P1 → P2 → P3, with P4/P5/P6 as parallel demo-bonus slices. P7+ is post-judging polish.

---

## 8. Decision log

### 8.1 Storage: `chrome.storage.local` over Redis (decided 2026-05-06)

The original idea was Redis-on-Docker for chat persistence. We considered four options and chose `chrome.storage.local` as the primary. Full reasoning is in the design spec §14.2; the short version:

| Option | Verdict |
|---|---|
| `chrome.storage.local` | ✅ Primary. MV3-native, durable, ~10 MB+ quota, zero infra, local-first by definition. |
| `IndexedDB` | ⚠️ Fallback only. Used if a single conversation outgrows `chrome.storage.local` (rare; we don't store screenshots). |
| SQLite (file via backend) | ❌ Moves source of truth off the client; conflicts with local-first. |
| Redis on Docker | ⚠️ Server-side cache only, opt-in. Useful for workflow state metadata in Phase 9. **Never** the source of truth for chat. |

If we ever need cross-device sync, that is the moment to revisit Redis (or any server-side store). Until then, the simpler answer wins.

### 8.2 Other open questions

1. **Bundler or native ES modules?** — Native ES modules in MV3 content scripts are supported in modern Chrome; we start native, add esbuild only if load-order issues bite.
2. **Shadow DOM for sidebar?** — Strong style isolation; slightly harder keyboard focus management. **Lean toward yes**, since we'll inject across many host sites and don't want their CSS to bleed in. Decide in P1.
3. **Side Panel API vs injected `<div>`?** — Chrome Side Panel keeps the panel out of the page's DOM (better isolation, doesn't scroll with the page) but is a separate window context. Plan: build the sidebar logic against an interface that supports both backends; ship injected `<div>` first, add Side Panel in P7.
4. **Phone-call listening?** — Out of scope. Not technically possible in MV3 without an OS helper, and recording calls has wiretap-law implications. We listen *to* Guidely (browser mic) only.
5. **Autonomy Level 3 default?** — No. Level 1 (highlight) is the safe default for elderly users. Level 3 stays opt-in with hard rails (§15.5 in spec).

---

## 9. Summary

- **8 feature modules** define the product surface (§2.0): F1 memory, F2 page understanding, F3 guided navigation, F4 voice, F5 vigilance, F6 workflows, F7 explainer, F8 docs/camera.
- **Sidebar becomes a Cursor-style persistent agent panel** with a conversation list + active thread + plan view, all backed by `chrome.storage.local`.
- **Backend stays stateless** on the chat-history axis. Optional Redis cache is execution-metadata only and entirely opt-in.
- **Implementation** follows P1 → P9 (§7), with P1–P3 as the hackathon-critical slice and P4–P6 as parallel demo-bonus work.

Next step: a focused implementation plan for P1 (persistent memory + agent sidebar shell) — see [`docs/superpowers/plans/2026-05-06-guidely-agent-memory.md`](superpowers/plans/2026-05-06-guidely-agent-memory.md) (added in lockstep with this revision).
