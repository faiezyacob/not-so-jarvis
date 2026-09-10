# not-so-jarvis

**JARVIS — Local AI Assistant**

A lightweight, locally-hosted AI assistant dashboard built with **plain Node.js** (zero npm dependencies) and **vanilla HTML/CSS/JS** (no bundler). Runs entirely on your machine with no cloud dependency.

![Dashboard Overview](screenshots/dashboard-overview.png)

## Features

- **Chat** with local [Ollama](https://ollama.com) provider — SSE streaming, markdown rendering, conversation history
- **AI image generation** via Krea2 / ComfyUI — type a prompt and see the result inline in chat
- **Image upscaling** — SeedVR2 (tiled diffusion) or Ultimate SD engines, before/after comparison viewer
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

The task stays active across turns — say *"make the sky darker"* and it modifies the previous generation, preserving unchanged visual attributes.

Only one generation runs at a time. A second request gets a friendly "please wait" message.

### LoRA stack

Attach LoRAs from ComfyUI's available models. Each LoRA has:
- **On/off toggle** — skip without removing
- **Strength slider** — 0 to 2 (default 1)
- **Trigger word** — prepended to the prompt automatically

Active LoRAs compose in order via chained `LoraLoader` nodes.

### Image upscaling

Two engines available in the settings panel:

- **SeedVR2** (default) — tiled diffusion upscaler with Sharp/Balanced profiles, noise control, optional pre-resize
- **Ultimate SD** — prompt-guided tiled upscaler reusing your Krea2 models

Trigger by saying *"upscale this image"* or *"make it higher res"*. The source is automatically resolved from the conversation's last generated image.

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

MIT
