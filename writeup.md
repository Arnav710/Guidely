#DRAFT WRITE UP


# Lumineer — Local Gemma 4 as a Private Browser Companion for Older Adults

## What we built

Lumineer is a Chrome extension and local FastAPI service that turns Gemma 4, running through Ollama, into a patient browser companion for older adults and new internet users. The goal is simple: help people understand, navigate, and trust the web without sending their private screen, documents, camera frames, or browsing context to a cloud AI service.

Many older adults depend on the internet for insurance documents, appointments, bills, travel, banking, health portals, and government forms. The challenge is not only that these pages are long. The deeper problem is uncertainty: “Is this a bill?”, “Do I owe money?”, “What should I click?”, “Is this email safe?”, “Am I about to make a mistake?” Lumineer is designed around that moment of anxiety. Instead of producing generic summaries, it turns confusing pages into plain-English action cards, highlights the right controls, and explains risk signals in a calm, understandable way.

## Core user experience

Lumineer has four modes.

**Explain / Summarize** converts dense pages into structured action cards. For example, an insurance Explanation of Benefits becomes: what this document is, whether payment is required now, what amount matters, what deadline exists, what to check, and what to avoid. This is more useful than a paragraph summary because it answers the user’s real question: “What do I do next?”

**Guide Me** helps the user learn a task step by step. If the user asks, “Help me book an eye appointment,” Lumineer reads the page, explains the next step, and highlights the correct button. It waits for the user rather than taking control away, because the product goal is confidence and independence, not blind automation.

**Do It For Me** supports more autonomous workflows. Lumineer can plan a task, ask follow-up questions, navigate to relevant pages, and execute browser tools such as clicking, scrolling, filling fields, or capturing a new observation. For safety, it is designed to stop before sensitive actions such as payments, passwords, final submissions, or irreversible changes.

**Vigilance Mode** acts like another pair of eyes. It scans the visible page for suspicious emails, fake-news patterns, misleading AI-generated content, risky links, and unsafe instructions. It does not simply say “scam.” It highlights evidence such as urgency, sender/domain mismatch, requests for private information, unsupported claims, or suspicious links, then gives a safer next step.

## Architecture

Lumineer uses a thin browser client and a thick local server.

The **Chrome extension** is a Manifest V3 extension with a side panel, content script, background script, and local session storage. The content script builds a structured observation of the current tab: visible text, important sections, interactive elements, optional screenshots, and selector candidates. It also executes browser-local tools selected by the model, including highlight, scroll, click, fill field, follow link, and capture screenshot. The extension stores chat, plans, and tool history in `chrome.storage.local`.

The **FastAPI backend** runs on a device inside the home network. It exposes endpoints such as `/explain`, `/summarize`, `/guide`, `/vigilance/scan`, `/agent/start`, and `/agent/step`. The server handles prompt construction, model routing, JSON repair, tool validation, loop budgets, and optional grounded web search. The backend is intentionally stateless and does not require a cloud database.

The **local inference layer** uses Ollama with Gemma 4. All text, screenshots, and camera-derived inputs are sent to the local Ollama API, not to a remote model endpoint. Lumineer can route small, frequent background checks to a faster model and deeper reasoning or workflow planning to a stronger model. This lets one always-on laptop, desktop, or Raspberry Pi-style hub serve multiple Chrome extensions on the same Wi-Fi network.

## How Lumineer uses Gemma 4

Gemma 4 is not used as a decorative chatbot. It is the reasoning layer behind page understanding, structured tool use, and multimodal assistance.

For page comprehension, Lumineer combines DOM-derived structure with screenshots. The DOM tells Gemma what controls exist; the screenshot helps it understand what is visually important, such as banners, buttons, warnings, or confusing page layouts.

For browser control, Gemma produces structured JSON rather than free-form prose. Each agent step asks for exactly one action: explain, ask the user, click, fill, scroll, search, navigate, replan, or stop. The server validates tool names and parameters before the extension executes anything. This makes the system safer and more reliable on compact local models.

For vigilance, Gemma receives visible text, numbered elements, and optional screenshot context, then returns structured flags with reasons and safer alternatives. The output is designed for trust: concise, evidence-based, and proportional. A suspicious email should explain why it is suspicious; an unverified article should identify the claims that need checking rather than pretending to know the absolute truth.

## Technical challenges

The biggest challenge was making a local model behave like a reliable browser agent. Compact models can produce malformed JSON, repeat observations, or ask unnecessary questions. Lumineer addresses this with schema-constrained prompts, robust JSON extraction, strict retries, server-side normalization, and a hard iteration budget. If the agent cannot proceed safely, it ends with a clear summary instead of looping forever.

Another challenge was trust. A tool for older adults must be helpful without being overconfident. Lumineer therefore separates assistance from authority. It can explain an insurance document, but it does not pretend to be a lawyer. It can explain a medical portal message, but it does not make medical decisions. It can flag scam patterns, but it shows the evidence and recommends safer verification steps.

## Roadmap: home hub and camera tools

Today, Lumineer runs on a local machine with Ollama and FastAPI. The target deployment is an always-on home hub: a quiet PC, laptop, or Raspberry Pi-class device on the LAN. Every family device points its extension at `http://<home-hub>:8000`, making data residency a network property rather than a promise.

The same tool pattern also extends to home cameras. A user could ask, “Is there a package at the door?” The server would fetch a still frame from a configured LAN-only RTSP/ONVIF camera, pass it to Gemma for visual question answering, and return a plain-language answer. This keeps the privacy model consistent: tools gather local evidence, Gemma interprets locally, and the browser presents the result.

## Why it matters

Lumineer is built for people who do not want to lose independence just because the internet became complicated. It helps them read what matters, learn what to click, avoid risky pages, and complete everyday tasks with confidence. The project combines multimodal local AI, structured browser agents, and privacy-preserving deployment into one practical tool: a trusted AI companion that stays inside the home.


Images:
<img width="1947" height="280" alt="image" src="https://github.com/user-attachments/assets/84366234-87c2-4094-87dc-90a866334f52" />

<img width="1595" height="750" alt="image" src="https://github.com/user-attachments/assets/3957c2a6-4fe8-4d6d-ba76-226d55479b84" />

<img width="1419" height="796" alt="image" src="https://github.com/user-attachments/assets/aead228e-2fbd-44e8-b3dc-6ee93ed78920" />


