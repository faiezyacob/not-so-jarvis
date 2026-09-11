# not-so-jarvis

**JARVIS — Local AI Assistant**

A lightweight, locally-hosted AI assistant dashboard built with **plain Node.js** (zero npm dependencies) and **vanilla HTML/CSS/JS** (no bundler). Runs entirely on your machine with no cloud dependency.

![Dashboard Overview](screenshots/dashboard-overview.png)

## Features

- **Chat** with local [Ollama](https://ollama.com) provider — SSE streaming, markdown rendering, conversation history
- **AI image generation** via Krea2 / ComfyUI — type a prompt and see the result inline in chat
- **Identity edit** — attach a photo (or say *"edit this image"*) and describe the change; the Krea2 Identity Edit LoRA re-stages, recolors, adds/removes objects while preserving the rest
- **Image upscaling** — SeedVR2 (tiled diffusion) or Ultimate SD engines, before/after comparison viewer
- **Video upscaling** — fast RTX super-resolution (default) or SeedVR2 quality path, audio-preserving
- **LoRA stack** — attach multiple LoRAs with per-model strength, on/off toggle, and trigger words
- **Task router** — context-aware intent detection that continues/modifies active image sessions across turns
- **System monitoring** — live CPU, RAM, VRAM/GPU widgets with canvas history charts (draggable, reorderable)
- **Model library** — browse, download, and manage models with hardware compatibility detection
- **Generated image gallery** — thumbnails, full-grid view, preview lightbox with zoom/pan, before/after compare
- **ComfyUI widget** — live generation status, progress bar, queue info
- **Weather widget** — browser geolocation + Open-Meteo (no API key needed)
- **Settings panel** — provider selection, image generation config, upscale engine tuning, widget visibility
- **Zero dependencies** — even .env loading, markdown parsing, and PNG dimension reading are hand-rolled

## Project structure

```
server.js                 Entry point — raw HTTP server, all API routing, static file serving
start.bat                 Windows launcher with exit-code-100 restart loop
package.json              Zero dependencies

server/                   Backend services
  config-manager.js         Load/save data/config.json, active provider/model, image settings
  context-builder.js        Assembles bounded chat context (system prompt + summary + recent msgs)
  conversation-service.js   Conversation + message persistence to data/conversations.json
  models.js                 Static model catalog + hardware estimates
  provider-manager.js       Detects providers, discovers/downloads/loads/unloads models
  providers.js              Ollama chat/stream/summarize implementation

services/                 Independent / cross-cutting services
  system-monitor.js         CPU/RAM/VRAM/GPU telemetry (nvidia-smi), live polling
  comfyui.js                All ComfyUI HTTP communication (health, queue, wait, download)
  image-generator.js        Image intent detection, prompt building, Krea2 workflow graph
  task-router.js            Context-aware intent/action router (ActiveTask continuation)
  task-state.js             Per-conversation ActiveTask/TaskContext store (persisted to data/task-state.json)
  generated-history.js      Metadata store for generated images
  vram-manager.js           Orchestrates unloading chat <-> image models based on VRAM pressure

public/                   Frontend
  index.html                Single-page dashboard UI
  app.js                    Main application logic (settings, LoRA stack, widgets, charts)
  style.css                 All styles
  js/                       Feature modules: chat, conversations, db, gallery, hardware-compat,
                            markdown, model-library

data/                     Runtime data (persisted JSON + generated media)
  config.json
  conversations.json
  generated-history.json
  generated/                Generated image files, served at /generated/<file>
  images/
```

## Getting started

```bash
npm start
```

Or on Windows, double-click `start.bat` (handles auto-restart on code changes).

Then open `http://localhost:3001` in your browser.

### Requirements

- **Node.js** (no npm install needed — zero dependencies)
- **[Ollama](https://ollama.com)** running at `localhost:11434`
- **For image generation** (optional): [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with the Krea2 custom nodes and models

## Environment variables

Copy `.env.example` to `.env` and configure as needed:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Server port |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI instance |
| `COMFYUI_OUTPUT_DIR` | auto-detected | ComfyUI output folder (for cleanup) |
| `COMFYUI_TIMEOUT_MS` | `900000` | Generation timeout (15 min) |
| `KREA2_UNET` | `krea2_turbo_fp8_scaled.safetensors` | UNET model |
| `KREA2_CLIP` | *(see .env.example)* | CLIP model |
| `KREA2_VAE` | `wan_2.1_vae.safetensors` | VAE model |
| `KREA2_EDIT_LORA` | `krea2_identity_edit_v1_2.safetensors` | Identity Edit LoRA |
| `KREA2_ASPECT_RATIO` | `4:5` | Default aspect ratio |
| `KREA2_IMAGE_SIZE` | `M` | Default size (S/M/L) |
| `KREA2_STEPS` | `8` | Ksampler steps |
| `KREA2_CFG` | `1` | Ksampler CFG |
| `VRAM_UNLOAD_THRESHOLD` | `80` | % VRAM to trigger model unloading |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |

## Image generation

When you send a message like *"Generate an image of a futuristic city"*, JARVIS:

1. Detects the image-generation intent (two-level: fast regex signal → structured LLM classifier)
2. Enhances the prompt using the chat LLM as a "visual director"
3. Builds the Krea2 text-to-image workflow (UNET + CLIP + VAE + KSampler)
4. Submits it to ComfyUI and waits for completion
5. Downloads the output to `data/generated/`
6. Shows the image inline in the chat

The task stays active across turns — say *"make the sky darker"* and it edits the previous image's pixels via the Identity Edit LoRA (falls back to full regeneration when the edit nodes/LoRA are unavailable), preserving unchanged visual attributes.

Only one generation runs at a time — extra requests queue and can be cancelled from chat.

### Identity edit

Attach a photo and describe the change (*"remove the car"*), or say *"edit this image, make it night"* to edit the last generated image. JARVIS:

1. Resolves the source (fresh `/images/` upload wins, else the latest `/generated/` image)
2. Builds the Krea2 identity-edit workflow (UNET + Identity Edit LoRA + user LoRAs, `Krea2EditModelPatch` with fit geometry and `ref_boost` 4, Euler/simple, ≤2MP)
3. Submits it to ComfyUI (requires the `comfyui-krea2edit` custom nodes and `krea2_identity_edit_v1_2.safetensors` in ComfyUI's loras, configurable via Edit LoRA setting or `KREA2_EDIT_LORA`)
4. Shows the edit inline; follow-up tweaks chain onto the latest output

Edited files carry an `_edit_` filename marker, like upscales carry `_up_`.

### LoRA stack

Attach LoRAs from ComfyUI's available models. Each LoRA has:
- **On/off toggle** — skip without removing
- **Strength slider** — 0 to 2 (default 1)
- **Trigger word** — prepended to the prompt automatically

Active LoRAs compose in order via chained `LoraLoader` nodes.

### Upscaling (image + video)

One shared upscale configuration in the settings panel applies to both:

- **SeedVR2** — tiled diffusion upscaler with Sharp/Balanced profiles, noise control, optional pre-resize (slow quality path)
- **RTX** (default, videos) — fast single-pass super-resolution at the multiplier scale factor, adapted from Mix Studio
- **Ultimate SD** (images only) — prompt-guided tiled upscaler reusing your Krea2 models

Trigger by saying *"upscale this image"* or *"upscale this video"* (also *"make it higher res"*). The source is automatically resolved from the conversation's last generated image or video. Video runs SeedVR2 at the target resolution or fast RTX at the multiplier (Ultimate SD falls back to RTX for video; RTX falls back to SeedVR2 for images).

Upscaled images are grouped with their original in the gallery — click the original to preview, then use the **Compare** button for a before/after slider.

## Architecture highlights

- **Zero dependencies** — intentional constraint; everything is hand-rolled
- **No framework** — Node `http` server + vanilla JS frontend, no bundler
- **SSE streaming** — chat, image generation events, and ComfyUI progress relay all use Server-Sent Events
- **Dual persistence** — conversations stored on both server (JSON) and client (IndexedDB)
- **VRAM orchestration** — automatically unloads chat models before image generation (and vice versa) when GPU memory is tight
- **ActiveTask lifecycle** — task state persists across conversation turns for multi-step image sessions
- **Single generation lock** — only one image generation or upscale at a time
- **Auto-cleanup** — ComfyUI originals deleted after download; upscale inputs cleaned up; conversation delete prunes gallery

## License

This project is free software licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). See [LICENSE](LICENSE) or <https://www.gnu.org/licenses/gpl-3.0.html>.

Copyright (c) 2025 not-so-jarvis contributors.

It includes adaptations from **Mix Studio** (https://github.com/BlackMixture/Mix-Studio), which is also licensed under GPL-3.0. Adapted components include the Krea2 text-to-image workflow graph, SeedVR2 / Ultimate SD / RTX upscale pipelines, and MiniMax H3 video workflow in `services/image-generator.js` and `services/video-generator.js` (plus related resolution-tier, LoRA-chain, and compare-viewer logic). The original Mix Studio copyright notices are preserved in the adapted source files. Changes vs. upstream: simplified to plain text-to-image / first-frame video paths (no region/edit/outpaint modes, no turbo/long-context/reference-video paths), chat-driven intent routing, and `not-so-jarvis/` output prefixes.
