# not-so-jarvis

**JARVIS — Local AI Assistant**

A lightweight, locally-hosted AI assistant dashboard built with Node.js and vanilla JavaScript. Runs entirely on your machine with no cloud dependency.

## Features

- Clean, dashboard-style web UI
- Chat interface with its own lightweight Markdown renderer
- Local conversation history with persistence
- Live system monitoring widgets (CPU, RAM, VRAM)
- Built-in model library with hardware compatibility detection
- Provider manager to plug in different AI backends
- **AI image generation** via Krea2 / ComfyUI — type something like
  *"Generate an image of a futuristic Tokyo street at night"* and the resulting
  image is displayed directly in the chat.

## Project structure

```
server.js               Entry point
server/
  config-manager.js     Configuration handling
  context-builder.js    Builds conversation context
  conversation-service.js  Conversation persistence
  models.js             Model definitions
  provider-manager.js   AI provider routing
  providers.js          Provider implementations
services/
  system-monitor.js     CPU/RAM/VRAM metrics
  comfyui.js            ComfyUI communication (submit, track, download)
  image-generator.js    Image intent detection + Krea2 workflow
public/
  index.html            Dashboard UI
  style.css
  app.js
  js/                   chat, conversations, db, markdown, etc.
data/
  conversations.json    Stored conversations
  generated/            Generated images served at /generated/<file>
```

## Getting started

```bash
npm install
npm start
```

Then open the dashboard in your browser (default port is defined in `server.js`).

## Image generation (Krea2 / ComfyUI)

Image generation requires a locally running **ComfyUI** with the Krea2 custom
nodes and models installed (the same setup Mix Studio uses). Place the workflow
models in ComfyUI and point JARVIS at it:

```env
COMFYUI_URL=http://127.0.0.1:8188
```

See `.env.example` for the full list of environment variables, including the
Krea2 model filenames and generation defaults.

When you send a message like *"Generate an image of ..."*, JARVIS:

1. Detects that it is an image-generation request (using the configured chat LLM).
2. Builds the Krea2 text-to-image workflow.
3. Submits it to ComfyUI and waits for it to finish.
4. Saves the output to `data/generated/`.
5. Shows the image inline in the chat.

Only one image generation runs at a time. If you request another while one is
in progress, JARVIS asks you to wait.

## License

MIT
