# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single solo creator working on their own machine with a local GPU. One technical operator who already runs local models (Ollama, ComfyUI) and wants to turn an idea into finished media — a chat answer, an image, an edit, a video with sound, a character-consistent scene, a UGC-style ad — from one place instead of stitching several tools together.

The same person may open the dashboard from a second device on the same WiFi, but it is still one operator and one machine; there are no accounts, teams, or roles.

## Product Purpose

JARVIS is a local AI assistant dashboard: chat, image generation, image editing, video generation with synchronized audio, upscaling, character creation, companion chats, and short-form video production, all driven from one conversational surface on the user's own hardware.

It exists because cloud generation services require uploading private media, and local model stacks are otherwise a pile of separate scripts and UIs. Success means one conversational turn produces the asset the user asked for, and the next turn can change it ("make her outfit a golden silk dress", "another one", "now animate it") without restating the brief.

## Positioning

One conversation, every media pipeline. Chat, image, edit, video, upscale, character and production work all resolve from the same chat surface through intent routing and a shared active-task state — there are no separate tool pages to move between. Neighbouring local-AI UIs front a single pipeline; here the conversation is the product, and it remembers what it is working on across turns and restarts.

## Operating Context

- Runs on the user's own machine next to two local services: Ollama for chat (`localhost:11434`) and a ComfyUI instance for image/video work (`127.0.0.1:8188`).
- VRAM is the scarce resource. Only one model family is resident at a time; Ollama and ComfyUI are swapped in and out around each turn, and turns from all connected clients are serialized one at a time for that reason.
- Model weights and ComfyUI custom node packs are downloaded and installed locally through the app's Setup panel; Hugging Face and Civitai tokens are optional, and only used to fetch files.
- Long generations are the normal case, not the exception: jobs stream progress, can be cancelled, and are queued rather than raced.
- All state is local JSON under `data/` (config, conversations, generated-media history, character and production records). No server-side database service.
- The dashboard is viewed in a browser on the same machine or over the LAN, and includes its own system/GPU telemetry, weather, news, and gallery widgets.

## Capabilities and Constraints

Confirmed, non-negotiable:

- **Fully local.** No cloud inference, no accounts, no telemetry. Nothing leaves the machine unless the user explicitly installs a model or asks for weather/news.
- **Zero npm dependencies.** A plain Node.js HTTP server and a vanilla HTML/CSS/JS frontend, with no bundler and no build step. This is an auditability and durability commitment, not just an implementation detail.
- **MIT-compatible license hygiene.** The project stays MIT; no GPL-derived code or expression is copied into it.

Other confirmed constraints:

- Single operator, single machine. LAN access exists for convenience, not multi-tenancy.
- Generation requires locally installed models and ComfyUI node packs; the app can report what is missing and install it, but it cannot generate without those pieces.

Enumerated capability (confirmed by the working product): streaming chat with conversation memory; text-to-image, instruction editing with multiple references, upscaling with before/after compare; image-to-video and text-to-video with audio; Director Mode productions; videos longer than the 15-second single-render ceiling; UGC ad workflow with a product library; recurring creator-content sessions; a character identity system that keeps a saved person consistent across image, video, and production work; persistent companions with long-term memory and a fictional daily life; a conversational agent for local diagnostics and approved cleanup.

Deliberately undecided or out of scope: deployment beyond the user's own machine, hosted or shared multi-user operation, and any cloud fallback.

## Brand Commitments

- Name and identity: **JARVIS** (repository `not-so-jarvis`).
- Voice observed in the product's own copy: technical, direct, concrete, first-person about what the tool actually does. No superlatives, no invented benchmarks, no marketing claims that the code cannot back.
- Local-only, dependency-free, MIT-licensed is part of the brand promise, not just a technical fact.
- No logo system or brand asset beyond the dashboard UI itself.

## Evidence on Hand

- Real product screenshots in `screenshots/`: `dashboard-overview.png`, `image-gen.png`, `image-gen-upscale.png`, `image-gen-before-and-after.png`, `image-edit-before.png`, `image-edit-after.png`, `creative-playground.png`, `creator-studio.png`, `ugc-studio.png`, `companions.png`, and `video.mp4`.
- Working implementation in `server.js`, `server/`, `services/`, and `public/` — the source of truth for what the product actually does.
- `README.md` documents the shipped feature set; `AGENTS.md` documents architecture and product rules.
- Absent, and must not be fabricated by future work: customers, testimonials, benchmarks, performance numbers, pricing, download counts, or press coverage.

## Product Principles

1. **The conversation is the interface.** New capability should arrive as something the user can ask for, not another panel, page, or mode switch.
2. **Local first, auditable always.** Any feature that needs a cloud service, an npm package, or a build step is a product change, not an implementation choice.
3. **Remember the work.** State (active task, characters, memories, productions) is the difference between a demo and a tool; persistence and follow-ups outrank adding features.
4. **Respect the hardware.** One resident model family, visible progress, cancellable jobs, and a queue that never lets two clients fight over VRAM.
5. **Never bluff capability.** If a model, node pack, or tool is missing, say so with a real reason and a real fix; never fake a result.
