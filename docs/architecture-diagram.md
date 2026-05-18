# Guidely — architecture diagrams

Use these for README, Kaggle attachments, or slides. **Mermaid** renders on GitHub and in many Markdown viewers. To export **PNG/SVG**: paste into [mermaid.live](https://mermaid.live) or use the Mermaid CLI.

---

## 1. System context (who talks to whom)

```mermaid
flowchart LR
  subgraph User["User"]
    U[Older adult / caregiver]
  end

  subgraph Chrome["Google Chrome"]
    EXT[Guidely extension\nMV3]
  end

  subgraph Home["Home machine (today)"]
    API[FastAPI backend\n:8000]
    OLL[Ollama\n:11434]
    GEM[Gemma 4\nmultimodal]
  end

  subgraph Optional["Optional outbound"]
    DDG[DuckDuckGo\ntext search]
  end

  U --> EXT
  EXT <-->|"HTTPS/HTTP\nDOM · screenshots · goals"| API
  API <-->|"localhost"| OLL
  OLL --> GEM
  API -.->|"web_search tool only"| DDG
```

---

## 2. Component view (extension + server + model)

```mermaid
flowchart TB
  subgraph Browser["Chrome extension (Manifest V3)"]
    direction TB
    CS[content.js\nDOM map · sections · sidebar · highlights · tool execution]
    BG[background.js\nvisible tab screenshot]
    POP[popup.html / popup.js\nhealth · model switch]
    ST[(chrome.storage.local\nchat · plan · tool history)]
    CS <--> ST
    BG --> CS
    POP --> API
    CS --> API
  end

  subgraph Backend["Python backend (FastAPI)"]
    direction TB
    FA[FastAPI :8000]
    R1["/analyze · /guide · /explain\n/summarize · /workflow/*"]
    R2["/agent/start · /agent/step\n/agent/step/stream SSE"]
    R3["/vigilance/scan"]
    R4["/models · /health"]
    TOOLS[Tool runners\nweb_search + result cache\nJSON repair · loop budget]
    FA --> R1
    FA --> R2
    FA --> R3
    FA --> R4
    R1 --> TOOLS
    R2 --> TOOLS
    R3 --> TOOLS
  end

  subgraph Infra["Local inference"]
    OLL[Ollama API]
    M[Gemma 4\nvision + JSON tools]
    OLL --> M
  end

  CS --> FA
  POP --> FA
  TOOLS --> OLL
```

---

## 3. Autonomous agent — one step (request/response)

```mermaid
sequenceDiagram
  participant Tab as Content script
  participant API as FastAPI
  participant Oll as Ollama / Gemma 4

  Tab->>Tab: Build observation\nsections · elements · optional screenshot
  Tab->>API: POST /agent/step or /agent/step/stream\n+ plan · history · last tool results
  API->>Oll: Generate one JSON tool call\n(constrained schema)
  Oll-->>API: thought · tool · params · display
  API-->>Tab: SSE partial thought, then tool + params
  Tab->>Tab: Execute tool\n(click · scroll · navigate · capture …)
  Tab->>API: Next request with tool outcome\n(loop)
```

---

## 4. “Help me” analyze path (guided mode)

```mermaid
flowchart LR
  A[User asks in sidebar] --> B[DOM map + optional screenshot]
  B --> C["POST /analyze"]
  C --> D{enable_tools?}
  D -->|yes + web_search| E[DDG snippets]
  E --> F[Second Gemma call\ngrounded answer]
  D -->|no| G[Gemma once]
  G --> H[JSON instruction + selector]
  F --> H
  H --> I[Highlight + message in UI]
```

---

## 5. Target deployment — LAN hub + cameras *(roadmap)*

Solid lines = shipped pattern. Dashed = planned.

```mermaid
flowchart TB
  subgraph LAN["Home LAN / WAN — user data stays here"]
    subgraph Devices["Family devices"]
      D1[Laptop Chrome + extension]
      D2[Desktop Chrome + extension]
    end

    subgraph Hub["Home hub e.g. Raspberry Pi 5 + NVMe\n(or any always-on PC)"]
      API2[FastAPI :8000]
      OLL2[Ollama :11434]
      GEM2[Gemma 4]
      CAM[camera tool layer\nRTSP / ONVIF stills — planned]
    end

    subgraph Edge["Property edge"]
      CAMHW[Security cameras\nLAN only]
    end

    D1 -->|HTTP to hub IP| API2
    D2 -->|HTTP to hub IP| API2
    API2 <--> OLL2
    OLL2 --> GEM2
    CAM -.->|planned| CAMHW
    API2 -.->|planned| CAM
  end

  style CAM stroke-dasharray: 5 5
  style CAMHW stroke-dasharray: 5 5
```

---

## 6. Logical containers (compact, judge-friendly)

Same idea as a C4 container sketch—works in any Mermaid 9+ renderer.

```mermaid
flowchart TB
  subgraph People[" "]
    U["👤 User\n(senior / caregiver)"]
  end

  subgraph EXT["Guidely — Chrome extension"]
    CS["Content + UI\nDOM · tools · chat · highlights"]
  end

  subgraph SRV["Guidely — backend"]
    API["FastAPI\nprompts · JSON · SSE agent · vigilance"]
  end

  subgraph EXT_SYS["External — minimal"]
    OLL["Ollama\nGemma 4"]
    DDG["DuckDuckGo\n(web_search only)"]
  end

  U --> CS
  CS <-->|"HTTP · configurable\nhub URL"| API
  API <-->|"localhost :11434"| OLL
  API -.->|"optional"| DDG
```

---

### Quick export for Kaggle

1. Open [mermaid.live](https://mermaid.live).  
2. Paste diagram **1** or **2** + **5** side by side in the editor (or export separately).  
3. **Actions → PNG/SVG** for the writeup attachment.
