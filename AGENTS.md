# AGENTS.md

## Instructions for AI coding agents

- **Read this file first** when starting a new session.
- Use it to determine which part of the project is relevant to your task.
- **Do NOT perform a full repository scan by default.** Only inspect files related to the current task.
- Search for existing implementations before creating new ones.
- Do not load large generated-media/output directories (`data/generated`, `data/images`) unless explicitly needed.
- Treat the actual source code as the source of truth if this file becomes outdated.
- Update this file when significant architectural or structural changes are made.

## Project overview

`not-so-jarvis` is a local AI assistant dashboard ("JARVIS") built with **plain Node.js** (no framework, zero npm dependencies) and **vanilla HTML/CSS/JS** (no bundler). It runs entirely on the user's machine with no cloud dependency. It provides:

- Chat with local AI providers (Ollama)
- System monitoring widgets (CPU, RAM, VRAM/GPU)
- A model library with hardware-compatibility detection
- AI image generation via a local ComfyUI instance using the **Krea2** text-to-image workflow

Version 0.1.0, GPL-3.0-only license. Entry point is `server.js`.

## Directory structure

```
server.js             Entry point — raw HTTP server, all API routing, static file serving
server/               Backend services (server-side logic, not an HTTP framework)
  config-manager.js     Load/save data/config.json, active provider/model, image settings
  context-builder.js    Assembles bounded chat context (system prompt + summary + recent msgs)
  conversation-service.js  Conversation + message persistence to data/conversations.json
  models.js             Static model catalog + hardware estimates
  provider-manager.js   Detects providers, discovers/downloads/loads/unloads models
  providers.js          Ollama chat/stream/summarize implementations
services/             Independent services (monitoring, image generation, ComfyUI)
  system-monitor.js     CPU/RAM/VRAM/GPU telemetry (nvidia-smi), live polling
  comfyui.js            All ComfyUI HTTP communication (health, queue, wait, download)
  image-generator.js    Image intent detection, prompt building, Krea2 workflow graph
  task-router.js        Context-aware intent/action router (ActiveTask continuation routing)
  task-state.js         Per-conversation ActiveTask/TaskContext store (persisted to data/task-state.json)
  generated-history.js  Metadata store for generated images (data/generated-history.json)
  vram-manager.js       Orchestrates unloading chat<->image models based on VRAM pressure
public/               Frontend
  index.html            Single-page dashboard UI
  app.js                Main application logic (settings, LoRA stack, image settings, etc.)
  style.css             All styles
  js/                   Feature modules: chat, conversations, db (IndexedDB), gallery,
                        hardware-compat, markdown, model-library
data/                 Runtime data (persisted JSON + generated media)
  config.json
  conversations.json
  generated-history.json
  generated/            Generated image files, served at /generated/<file>
  images/
.kilo/                Milestone/tooling worktrees (not part of active codebase)
```

## Purpose of each important directory

- **`server/`** — Server-side application logic. These modules are required by `server.js` and do the actual work: chat, conversations, providers, config, model catalog.
- **`services/`** — Cross-cutting / independent services. `image-generator.js`, `comfyui.js`, and `vram-manager.js` together form the image generation pipeline. `system-monitor.js` provides telemetry. `generated-history.js` persists image metadata.
- **`public/`** — Everything served to the browser. `app.js` is the main entry; `public/js/*` are feature modules loaded as plain scripts (no modules/bundler).
- **`data/`** — Runtime persistence. JSON files are the source of truth for config/conversations/history; generated images land in `data/generated/`.

## Important services and integrations

- **Ollama** (`http://localhost:11434`) — chat provider via `server/providers.js`.
- **ComfyUI** (`http://127.0.0.1:8188`, overridable via `COMFYUI_URL`) — image generation via `services/comfyui.js`.
- **Krea2 workflow** — assembled in `services/image-generator.js` (`buildKrea2T2IGraph`), using UNET/CLIP/VAE models configured through settings or env vars (`KREA2_*` in `.env.example`).
- **VRAM manager** — `services/vram-manager.js` unloads the chat model before image generation (and vice versa) when GPU VRAM exceeds a threshold (`VRAM_UNLOAD_THRESHOLD`, default 80%).

## Important architectural patterns

- **No framework on either side.** Node `http` server + vanilla JS frontend. `server.js` has all routing defined as a sequence of path+method checks inside `handleAPI()`.
- **Service modules exported as plain objects** with named functions; no classes (except `system-monitor.js` which uses a class).
- **Persistence is simple JSON files** in `data/`, rewritten in full on mutation. No ORM/schema library.
- **Frontend mirrors backend persistence**: conversations are also stored client-side in IndexedDB (`public/js/db.js`) for UI durability.
- **Image generation idempotency/locking**: only one image generation at a time, enforced by `withGenerationLock` in `image-generator.js`.
- **Two-level intent detection** (when no active task, in `services/image-generator.js`): a fast Level 1 regex SIGNAL (`imageRequestStrength` → `definite`/`likely`/`null`) decides whether to ask a structured LLM classifier (`detectIntent`); the LLM's structured JSON is the final authority on tool execution, the chat model's free-text reply never is. The signal is **not** position-dependent (generation verbs can appear anywhere) and `isConceptQuestion` keeps "What is image generation?"-style questions as chat.
- **Extended intent schema**: `detectIntent`/`IMAGE_INTENT_SYSTEM_PROMPT` return/expect `action` (`generate`|`modify`), `creative_mode` (`none`|`light`|`full`), `explicit_constraints`, and chat `related_task`. `CREATIVE_FREEDOM_RE` detects "be creative"/"surprise me"; a creative request with no subject gets `DEFAULT_CREATIVE_PROMPT`. These fields flow to `buildImagePrompt` and into the ActiveTask `parameters`.
- **SSE streaming** for chat (`/api/chat/stream`) — text chunks, stats, then a final `done` event; image generations emit a single `image` event.
- **Restart mechanism**: `POST /api/restart` exits with code `100`, which `start.bat` catches to relaunch in the same terminal.

## State-management patterns

- **Server config**: `data/config.json`, managed by `server/config-manager.js` (`getConfig`, `setModelConfig`, `getImageSettings`, `setImageSettings`). The `imageGeneration` key stores global image settings overrides (unet, clip, vae, aspectRatio, imageSize, steps, cfg, loras; width/height are derived from aspectRatio + imageSize via `resolveDimensions`).
- **Conversations/messages**: `data/conversations.json`, managed by `server/conversation-service.js`. In-memory cache reloaded at startup.
- **Active task state**: `data/task-state.json`, managed by `services/task-state.js`. Per-conversation task context (type, prompt, generatedAsset, parameters), reloaded at startup.
- **Generated image metadata**: `data/generated-history.json`, managed by `services/generated-history.js` (cached in memory, flushed on change).
- **LoRA stack**: part of global image settings (`imageGeneration.loras`). Each entry is `{ name, strength, on, triggerWord }`. Trigger words from active LoRAs are prepended to the image prompt at generation time.
- **Frontend settings**: `localStorage` for widget visibility and device settings; IndexedDB for conversations/messages.

## Development conventions

- **No dependencies.** Do not add npm packages without strong justification; the app is intentionally dependency-free.
- **No comments policy for AI-written code** unless the existing style of the surrounding file includes them (existing code uses `/* === */` block header comments and inline explanations — match that style).
- Follow existing naming and structure patterns when adding features.
- Match the existing "plain functions + `module.exports`" module style on the backend.
- The frontend uses plain global functions and DOM manipulation, not a framework. Feature modules in `public/js/` interact with shared state in `app.js` (e.g., the LoRA stack helpers).

## Rules / constraints future agents must follow

- Do not modify source code unless explicitly asked.
- Never break the zero-dependency constraint.
- `data/` is runtime state — never commit or rely on its contents; it may be empty.
- The `.kilo/` directory contains worktrees and is **not** part of the active codebase — ignore it.
- When adding a new API endpoint, add it inside `handleAPI()` in `server.js` following the existing path-match pattern.
- When changing persisted settings shapes, update `sanitize*` functions (e.g., `sanitizeLoras`, `sanitizeSettings` in `image-generator.js`) accordingly.
- Keep `.env.example` in sync with any new environment variables.
- Preserve the single-generation lock semantics for image generation.

## Directories/files that generally should NOT be scanned unless relevant

- `data/generated/`, `data/images/` — large generated media; skip unless the task is about generated images.
- `.kilo/` — worktrees of another branch, not active code.
- `package-lock.json` — generated.
- `data/*.json` — runtime state; only relevant when investigating persistence/settings.

## Current major features and their locations

- **Chat** — `server.js` `handleChat`/`handleChatStream`, `server/providers.js`, `server/context-builder.js`, `server/conversation-service.js`; UI in `public/js/chat.js`, `public/js/conversations.js`, `public/js/db.js`. When an upscaled pair is found, the original image is dropped and only the upscaled image remains (`collapseUpscalePairs`/`setAiContent`), rendered identically to any other chat image (no extra compare container). The original is accessible via the Compare button inside the image's preview lightbox; pair detection keys on the `_up_` filename marker.
- **Image generation (Krea2/ComfyUI)** — `server.js` image intent branch + `handleImageGenerationStream`; `services/image-generator.js`, `services/comfyui.js`, `services/vram-manager.js`.
- **Upscaling (shared image + video)** — "upscale this image" routes through `task-router` (`image_upscale` intent) to `handleImageUpscaleStream` → `imageGenerator.upscaleImage`; "upscale this video" routes (`video_upscale` intent via `videoGenerator.detectVideoUpscaleIntent`, checked first) to `handleVideoUpscaleStream` → `videoGenerator.upscaleVideo` (both share the single-generation lock). Image: two engines (SeedVR2 default, Ultimate SD); source is the last generated image (`resolveUpscaleSource` scans assistant messages for `/generated/<file>`). Video: SeedVR2 only (`SeedVR2VideoUpscaler` node); source is the last generated video (`resolveVideoUpscaleSource` filters for video extensions). Both read the ONE shared upscale config (engine, mode, resolution/multiplier, profile, noise, pre-resize, seedvr2 DiT/VAE/attention) in `imageGeneration.*` via `imageGenerator.effectiveSettings()` (`sharedUpscaleSettings()` on the video side); mode/multiplier/Ultimate SD are image-only and ignored by video. Single UPSCALE tab in the settings panel; `POST /api/upscale` (image) and `POST /api/video/upscale` (video) expose the same paths for the gallery. Legacy `videoGeneration.videoUpscale*` keys are no longer stored; `saveVideoSettings` maps them once onto the shared keys.
- **LoRA stack** (attach, strength, on/off, trigger word) — backend `image-generator.js` (`DEFAULT_SETTINGS`, `sanitizeLoras`, `buildLoraChain`); frontend `public/app.js` (`initLoraStack`, `loraRow`, `renderLoraStack`, `saveLoraStack`, `initLoraSettings`); styles in `public/style.css` (`.lora-*`); settings API at `/api/settings/image` (GET/POST).
- **System monitoring widgets** — `services/system-monitor.js`, `public/app.js` (system stats section), `public/style.css`.
- **Model library / hardware compatibility** — `server/models.js`, `server/provider-manager.js`; UI in `public/js/model-library.js`, `public/js/hardware-compat.js`; API `/api/ai/*`.
- **Generated image gallery** — `services/generated-history.js`; UI in `public/js/gallery.js`; API `/api/generated`. Upscaled outputs are grouped with their original (child tile hidden, `⇋` badge on the parent, grouped delete) in both the widget and View-All gallery; clicking the original opens a preview with a Compare button, and `Gallery.openCompare` shows the before/after slider overlay (draggable divider + wheel/button zoom).
- **Settings panel** — `public/index.html` settings markup; `public/app.js` `initSettings` / `initImageGenSettings` / `initUpscaleSettings` / `initLoraSettings`.

## Important relationships between components

- **Chat → Image**: In `handleChatStream`, `task-router.routeMessage()` decides (before any tool runs) whether the message should start a new task, continue/modify the active image task, answer a question about the active task, or is unrelated. Only when the router says `shouldExecuteTool` does the app build a prompt, free VRAM via `vram-manager.freeVRAMBeforeImage()`, and run the pipeline. Otherwise it streams a normal chat reply (after `freeVRAMBeforeChat()`).
- **ActiveTask lifecycle**: per-conversation task state lives in `services/task-state.js` (typed as `image`/`video`/`audio`), persisted to `data/task-state.json`. It stays active across turns and survives server restarts. It is only cleared when the user starts a different non-tool task or the application clears it. Tool execution sets `status: running` before running and `completed`/`failed` only after the tool actually finishes.
- **Image pipeline**: `generateImage()` reads global settings (`effectiveSettings`), prepends active LoRA trigger words to the prompt, builds the Krea2 graph, validates against ComfyUI's object info, queues it, waits, downloads the output, saves to `data/generated/`, and records metadata in `generated-history`.
- **Config flow**: Settings UI → `POST /api/settings/image` → `imageGenerator.saveSettings` → `sanitizeSettings`/`sanitizeLoras` → `config-manager.setImageSettings` → `data/config.json`. At generation time `effectiveSettings()` merges defaults with stored overrides.
- **VRAM orchestration**: `vram-manager` connects chat providers and ComfyUI, unloading whichever model isn't needed to fit the next one in GPU memory.
- **Conversation duplication**: stores exist on both server (`conversations.json`) and client (IndexedDB); they mirror each other for durability.

## Common entry points for different types of tasks

- **Add/change an API endpoint** — `server.js` `handleAPI()`.
- **Change chat behavior/providers** — `server/providers.js`, `server/context-builder.js`, `server/conversation-service.js`.
- **Change task/intent routing or ActiveTask lifecycle** — `services/task-router.js`, `services/task-state.js`, `server.js` `handleChatStream` + `handleImageGenerationStream`.
- **Change image generation / prompt / LoRA logic** — `services/image-generator.js`.
- **Change ComfyUI communication** — `services/comfyui.js`.
- **Change VRAM/unload orchestration** — `services/vram-manager.js`.
- **Change system telemetry** — `services/system-monitor.js`.
- **Change UI/UI logic** — `public/index.html`, `public/app.js`, `public/js/*`, `public/style.css`.
- **Change persisted settings schema** — `server/config-manager.js` (storage) + the relevant `sanitize*` in `services/image-generator.js` (or other service).
- **Add/remove a catalog model** — `server/models.js`.
