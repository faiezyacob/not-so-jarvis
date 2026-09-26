const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Minimal .env loader (no external dependencies). Reads KEY=VALUE lines from
// a `.env` file next to server.js into process.env, without overwriting
// variables already set by the shell.
(function loadEnvFile() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && process.env[key] === undefined) process.env[key] = value;
        }
    } catch (err) {
        console.warn('[env] Could not load .env:', err.message);
    }
})();

const PORT = process.env.PORT || 3001;
// Bind to every interface by default so other devices on the same WiFi can
// reach the dashboard. Set HOST=127.0.0.1 to keep it local-only.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Exit code used to signal the start.bat wrapper to restart in the same terminal.
const RESTART_EXIT_CODE = 100;

// When this process came up. Exposed by GET /api/activity and used to note the
// lifecycle event in the activity feed.
const serverStartedAt = new Date().toISOString();

// --- MIME Types ---

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime'
};

// --- Services ---

const systemMonitor = require('./services/system-monitor');
const conversationService = require('./server/conversation-service');
const contextBuilder = require('./server/context-builder');
const configManager = require('./server/config-manager');
const providers = require('./server/providers');
const models = require('./server/models');
const providerManager = require('./server/provider-manager');
const imageGenerator = require('./services/image-generator');
const videoGenerator = require('./services/video-generator');
const faceRefine = require('./services/face-refine');
const fbcache = require('./services/fbcache');
const modelSetup = require('./services/model-setup');
const generatedHistory = require('./services/generated-history');
const thumbnail = require('./services/thumbnail');
const activityLog = require('./services/activity-log');
const comfyui = require('./services/comfyui');
const comfyuiLauncher = require('./services/comfyui-launcher');
const vramManager = require('./services/vram-manager');
const weather = require('./services/weather');
const news = require('./services/news');
const taskRouter = require('./services/task-router');
const taskState = require('./services/task-state');
const generationQueue = require('./services/generation-queue');
const turnQueue = require('./services/turn-queue');
const director = require('./services/director/director');
const longVideoDirector = require('./services/long-video/director');
const playground = require('./services/playground/playground');
const ugcStudio = require('./services/ugc/studio');
const ugcProducts = require('./services/ugc/products');
const characterPresets = require('./services/character-presets');
const characterStudio = require('./services/character-studio');
const characterIdentity = require('./services/character-identity');
const characterContext = require('./services/character-context');
const GENERATED_DIR = path.join(__dirname, 'data', 'generated');
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
const UPLOAD_MIME_TO_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
};
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGES_MAX = 3;
// The @ picker can reference more than one generated image per turn (e.g.
// "make @image1 hold @image2 in @image3"). image_1 is the edit source and the
// rest become Qwen edit references; cap the total so a prompt can't wire an
// unbounded chain of LoadImage nodes.
const REFERENCE_IMAGES_MAX = 4;

// --- Device sessions ---
// Each browser gets a long-lived session cookie so its conversations, gallery
// and activity feed stay private to that device (a second device on the same
// WiFi is a different session). The cookie is set on the first response —
// including the HTML document, so it exists before any API call runs.
const SESSION_COOKIE = 'jarvis_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // one year
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        if (!key) continue;
        let value = part.slice(idx + 1).trim();
        try { value = decodeURIComponent(value); } catch (err) { /* keep raw */ }
        out[key] = value;
    }
    return out;
}

// Resolve this request's device session, minting and setting a cookie when it
// is missing or malformed. Returns the session id.
function resolveSession(req, res) {
    const cookies = parseCookies(req.headers && req.headers.cookie);
    const existing = cookies[SESSION_COOKIE];
    if (existing && SESSION_RE.test(existing)) return existing;
    const id = crypto.randomUUID();
    res.setHeader('Set-Cookie',
        SESSION_COOKIE + '=' + id + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE);
    return id;
}

// Hand pre-session conversations and generated media to the first device that
// asks, so an upgrade keeps the existing history on that device.
function adoptLegacyState(sessionId) {
    conversationService.adoptLegacyConversations(sessionId);
    generatedHistory.adoptLegacy(sessionId);
}

// Guard a conversation-scoped request: writes 404 and returns false when the
// current session does not own the conversation.
function requireConversationAccess(req, res, conversationId) {
    if (conversationService.canAccessConversation(conversationId, req.jarvisSession)) return true;
    json(res, 404, { error: 'Conversation not found' });
    return false;
}


// Share the single-generation lock between image and video pipelines.
videoGenerator.registerGenerationLock(imageGenerator);

// Resolve the Ollama `think` flag for a chat request. An explicit per-request
// boolean wins; otherwise the persisted global setting applies (on by
// default). Returns true/false (never undefined) so callers can forward it.
function resolveChatThink(body) {
    if (body && typeof body.think === 'boolean') return body.think;
    try {
        return configManager.getReasoningEnabled();
    } catch {
        return true;
    }
}

// Sampling for creative chat replies. Explicit per-request numbers win;
// otherwise the persisted Settings > Chat values apply (null = model
// default). Classification calls always pass temperature 0 explicitly and
// never read the user setting.
function resolveChatSampling(body) {
    const out = {};
    const pick = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    let explicitTemp = body ? pick(body.temperature) : NaN;
    let explicitTopP = body ? pick(body.topP !== undefined ? body.topP : body.top_p) : NaN;
    if (!Number.isFinite(explicitTemp) || !Number.isFinite(explicitTopP)) {
        try {
            const cfg = configManager.getChatSettings();
            if (!Number.isFinite(explicitTemp) && cfg.temperature !== null && cfg.temperature !== undefined) {
                const n = Number(cfg.temperature);
                if (Number.isFinite(n)) explicitTemp = n;
            }
            if (!Number.isFinite(explicitTopP) && cfg.topP !== null && cfg.topP !== undefined) {
                const n = Number(cfg.topP);
                if (Number.isFinite(n)) explicitTopP = n;
            }
        } catch {
            // fall through to model defaults
        }
    }
    if (Number.isFinite(explicitTemp)) out.temperature = explicitTemp;
    if (Number.isFinite(explicitTopP)) out.topP = explicitTopP;
    return out;
}

// Safe SSE write that never throws after the client detached.
function sseWrite(res, obj) {
    try {
        if (res.writableEnded || res.destroyed) return false;
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        return true;
    } catch {
        return false;
    }
}

// Relay ComfyUI step progress to a chat stream for the duration of a job. Only
// one generation runs at a time, so progress observed while a handler awaits
// its job belongs to that job. Returns an unsubscribe function.
function forwardComfyProgress(res) {
    const onProgress = (update) => {
        if (!update) return;
        if (update.idle) {
            sseWrite(res, { progress: { idle: true } });
        } else if (typeof update.value === 'number' && typeof update.max === 'number' && update.max > 0) {
            sseWrite(res, { progress: { value: update.value, max: update.max } });
        }
    };
    comfyui.subscribeProgress(onProgress);
    return () => comfyui.unsubscribeProgress(onProgress);
}

// Detect a hallucinated tool-call JSON blob in a plain chat reply, e.g.
// {"action": "image_generation", "action_input": "{ \"prompt\": \"...\" }"}
// or {"intent": "image_generation", "prompt": "..."}. Small chat models emit
// these when a follow-up tweak slips through to chat instead of the image
// pipeline. Returns the extracted image prompt, or null when the reply is
// ordinary chat text.
function extractLeakedImagePrompt(fullReply) {
    const text = String(fullReply || '');
    if (!text.includes('{') || !text.includes('}')) return null;
    if (!/["']?(?:action|intent)["']?\s*:\s*["']image_generation["']/i.test(text)) return null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            const input = parsed.action_input ?? parsed.input ?? '';
            if (typeof input === 'string' && input.trim()) {
                try {
                    const inner = JSON.parse(input);
                    if (inner && typeof inner.prompt === 'string' && inner.prompt.trim()) {
                        return inner.prompt.trim();
                    }
                } catch {
                    // input is a raw prompt string, not nested JSON
                }
                const m = String(input).match(/["']?prompt["']?\s*:\s*["']([^"']{3,2000})["']/i);
                if (m) return m[1].trim();
                const cleaned = String(input).replace(/^[{\s"']+|[}\s"']+$/g, '').trim();
                if (cleaned && cleaned.length < 2000) return cleaned;
            }
            if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) return parsed.prompt.trim();
            if (typeof parsed.user_prompt === 'string' && parsed.user_prompt.trim()) {
                return parsed.user_prompt.trim();
            }
        } catch {
            // Not parseable as a whole — fall through to the regex below.
        }
    }
    const m = text.match(/["']?prompt["']?\s*:\s*["']([^"']{3,2000})["']/i);
    return m ? m[1].trim() : '';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

async function handleAPI(req, res, urlPath) {
    // GET /api/health
    if (urlPath === '/api/health' && req.method === 'GET') {
        json(res, 200, {
            status: 'online',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
        return true;
    }

    // GET /api/stats
    if (urlPath === '/api/stats' && req.method === 'GET') {
        const stats = systemMonitor.getStats();
        json(res, 200, stats);
        return true;
    }

    // GET /api/weather — current weather for the stored location (if any).
    if (urlPath === '/api/weather' && req.method === 'GET') {
        const location = weather.getLocation();
        const current = await weather.fetchCurrent();
        json(res, 200, { location, current });
        return true;
    }

    // POST /api/weather/location — the dashboard weather widget reports the
    // browser's geolocation so the chat assistant can answer weather questions.
    if (urlPath === '/api/weather/location' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const saved = weather.setLocation(body);
            json(res, 200, { location: { lat: saved.lat, lon: saved.lon, label: saved.label || '' } });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    // GET /api/news — headlines for the configured feeds (scope + topic
    // filters), used by the dashboard NEWS widget.
    if (urlPath === '/api/news' && req.method === 'GET') {
        try {
            const query = new URL(req.url, 'http://localhost').searchParams;
            const data = await news.fetchNews({
                category: query.get('category') || 'all',
                topic: query.get('topic') || '',
                limit: query.get('limit') || undefined,
                refresh: query.get('refresh') === '1'
            });
            json(res, 200, {
                ...data,
                configuredFeeds: news.getFeeds(),
                feedsCustom: news.hasCustomFeeds(),
                localArea: news.getLocalArea()
            });
        } catch (err) {
            json(res, 502, { error: err.message });
        }
        return true;
    }

    // POST /api/news/settings — replace feeds (empty resets to defaults) and/or
    // set the local area used by the "local" news scope.
    if (urlPath === '/api/news/settings' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (body.feeds !== undefined) {
                if (Array.isArray(body.feeds) && body.feeds.length === 0) news.resetFeeds();
                else news.setFeeds(body.feeds);
            }
            if (body.localArea !== undefined) news.setLocalArea(body.localArea);
            json(res, 200, {
                feeds: news.getFeeds(),
                feedsCustom: news.hasCustomFeeds(),
                localArea: news.getLocalArea()
            });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    // GET /api/models
    if (urlPath === '/api/models' && req.method === 'GET') {
        json(res, 200, { models: models.getAllModels() });
        return true;
    }

    // GET /api/models/:id/hardware-check
    const hwCheckMatch = urlPath.match(/^\/api\/models\/([^/]+)\/hardware-check$/);
    if (hwCheckMatch && req.method === 'GET') {
        const modelId = decodeURIComponent(hwCheckMatch[1]);
        const model = models.getModelById(modelId);
        if (!model) {
            json(res, 404, { error: 'Model not found' });
            return true;
        }
        const stats = systemMonitor.getStats();
        json(res, 200, { model, hardware: stats });
        return true;
    }

    // --- AI Model Management ---

    // GET /api/ai/providers — detect which providers are running
    if (urlPath === '/api/ai/providers' && req.method === 'GET') {
        const providersStatus = await providerManager.getProviders();
        json(res, 200, { providers: providersStatus });
        return true;
    }

    // GET /api/ollama/status — Ollama dashboard widget: active chat model,
    // installed count and the models currently loaded in memory.
    if (urlPath === '/api/ollama/status' && req.method === 'GET') {
        try {
            const status = await providerManager.getOllamaStatus();
            const config = configManager.getConfig();
            json(res, 200, {
                ...status,
                provider: config.provider || 'ollama',
                model: config.model || null
            });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // GET /api/ai/models — catalog + install status merged
    if (urlPath === '/api/ai/models' && req.method === 'GET') {
        const catalog = models.getAllModels();
        const installed = await providerManager.getAllInstalledModels();
        const installedIds = new Set(installed.map(m => m.id));
        const merged = catalog.map(m => ({
            ...m,
            installed: installedIds.has(m.id),
            installedInfo: installed.find(i => i.id === m.id) || null
        }));
        const extraInstalled = installed.filter(m => !models.getCatalogIds().includes(m.id));
        json(res, 200, { models: merged, extraInstalled });
        return true;
    }

    // POST /api/ai/models/download — start a download
    if (urlPath === '/api/ai/models/download' && req.method === 'POST') {
        const body = await readBody(req);
        const modelId = (body.modelId || '').trim();
        const provider = (body.provider || 'ollama').trim();
        if (!modelId) { json(res, 400, { error: 'modelId is required' }); return true; }
        let status;
        if (provider === 'ollama') {
            status = providerManager.downloadModelOllama(modelId);
        } else {
            json(res, 400, { error: 'Unknown provider' });
            return true;
        }
        json(res, 200, status);
        return true;
    }

    // GET /api/ai/models/download/:id — poll download status
    const dlMatch = urlPath.match(/^\/api\/ai\/models\/download\/(\d+)$/);
    if (dlMatch && req.method === 'GET') {
        const dlId = parseInt(dlMatch[1], 10);
        const status = providerManager.getDownloadStatus(dlId);
        if (!status) { json(res, 404, { error: 'Download not found' }); return true; }
        json(res, 200, status);
        return true;
    }

    // POST /api/ai/models/use — set active model in config
    if (urlPath === '/api/ai/models/use' && req.method === 'POST') {
        const body = await readBody(req);
        const modelId = (body.modelId || '').trim();
        const provider = (body.provider || 'ollama').trim();
        if (!modelId) { json(res, 400, { error: 'modelId is required' }); return true; }
        try {
            configManager.setModelConfig(provider, modelId);
            json(res, 200, { ok: true, provider, model: modelId });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/ai/models/unload — unload model from memory
    if (urlPath === '/api/ai/models/unload' && req.method === 'POST') {
        const body = await readBody(req);
        const model = (body.model || '').trim();
        const provider = (body.provider || 'ollama').trim();
        if (!model) { json(res, 400, { error: 'model is required' }); return true; }
        try {
            const result = await providerManager.unloadModel(provider, model);
            activityLog.record({ type: 'unload', title: 'Model unloaded', detail: model });
            json(res, 200, result);
        } catch (err) {
            json(res, 502, { error: err.message });
        }
        return true;
    }

    // POST /api/ai/models/remove — uninstall a downloaded model
    if (urlPath === '/api/ai/models/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const modelId = (body.modelId || '').trim();
        const provider = (body.provider || 'ollama').trim();
        if (!modelId) { json(res, 400, { error: 'modelId is required' }); return true; }
        try {
            const result = await providerManager.removeModel(provider, modelId);
            json(res, 200, result);
        } catch (err) {
            json(res, 502, { error: err.message });
        }
        return true;
    }

    // POST /api/chat
    if (urlPath === '/api/chat' && req.method === 'POST') {
        handleChat(req, res);
        return true;
    }

    // POST /api/chat/stream
    if (urlPath === '/api/chat/stream' && req.method === 'POST') {
        handleChatStream(req, res);
        return true;
    }

    // GET /api/settings/chat — global chat settings (reasoning toggle,
    // persona/system prompt, sampling). reasoningEnabled is kept top-level
    // for backwards compatibility with older clients.
    if (urlPath === '/api/settings/chat' && req.method === 'GET') {
        try {
            const settings = configManager.getChatSettings();
            json(res, 200, { reasoningEnabled: settings.reasoningEnabled, settings });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/settings/chat — persist global chat settings
    // ({ reasoningEnabled, systemPrompt, persona, temperature, topP }).
    if (urlPath === '/api/settings/chat' && req.method === 'POST') {
        try {
            const body = await readBody(req) || {};
            const settings = configManager.setChatSettings({
                reasoningEnabled: body.reasoningEnabled,
                systemPrompt: body.systemPrompt,
                persona: body.persona,
                temperature: body.temperature,
                topP: body.topP !== undefined ? body.topP : body.top_p
            });
            json(res, 200, { ok: true, reasoningEnabled: settings.reasoningEnabled, settings });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    // GET /api/settings/image — current + default image generation settings
    // for the active text-to-image pipeline (Krea2 or Qwen Image 2.1), plus
    // the UNET/CLIP/VAE models ComfyUI has available (null when unreachable).
    if (urlPath === '/api/settings/image' && req.method === 'GET') {
        try {
            const settings = imageGenerator.effectiveSettings();
            const defaults = imageGenerator.getDefaults();
            const choices = await imageGenerator.getModelChoices();
            const comfyAvailable = choices !== null;
            json(res, 200, { settings, defaults, choices, comfyAvailable });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/settings/image — persist global image generation overrides
    // (unet, clip, clipType, vae, aspectRatio, imageSize, steps, cfg, loras).
    if (urlPath === '/api/settings/image' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const settings = imageGenerator.saveSettings(body || {});
            json(res, 200, { ok: true, settings });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    // GET /api/settings/video — current H3 video generation settings
    if (urlPath === '/api/settings/video' && req.method === 'GET') {
        try {
            const settings = videoGenerator.effectiveVideoSettings();
            const defaults = videoGenerator.getVideoDefaults();
            const choices = await videoGenerator.getVideoModelChoices();
            const comfyAvailable = choices !== null;
            json(res, 200, { settings, defaults, choices, comfyAvailable });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/settings/video — persist H3 video generation overrides
    if (urlPath === '/api/settings/video' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            // Capture the previous state so the FBCache auto-install only fires
            // on a genuine off→on transition (not on every custom-field save).
            const previous = videoGenerator.effectiveVideoSettings();
            const settings = videoGenerator.saveVideoSettings(body || {});
            // First-enable auto-install: turning FaceRefine on kicks off the
            // background ComfyUI-side install (custom nodes + pip packages +
            // face detector). Non-blocking; the VIDEO panel polls its progress.
            let faceRefineInstall = null;
            if (body && (body.faceRefineEnabled === true || body.faceRefineEnabled === 1 ||
                    String(body.faceRefineEnabled).toLowerCase() === 'true' || String(body.faceRefineEnabled) === '1')) {
                faceRefineInstall = faceRefine.ensureAutoInstall();
            }
            // Same for First Block Cache: a genuine off→on transition clones the
            // node pack in the background when it is missing. Non-blocking; the
            // VIDEO panel polls GET /api/video/fbcache/status.
            let firstBlockCacheInstall = null;
            const fbcWasEnabled = Boolean(previous.firstBlockCache && previous.firstBlockCache.enabled);
            const fbcNowEnabled = Boolean(settings.firstBlockCache && settings.firstBlockCache.enabled);
            if (!fbcWasEnabled && fbcNowEnabled) {
                firstBlockCacheInstall = fbcache.ensureAutoInstall();
            }
            json(res, 200, { ok: true, settings, faceRefineInstall, firstBlockCacheInstall });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    // GET /api/video/face-refine/status — ComfyUI readiness for FaceRefine
    // (custom nodes loaded, detector model present) + install job state.
    if (urlPath === '/api/video/face-refine/status' && req.method === 'GET') {
        try {
            json(res, 200, await faceRefine.getStatus());
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/video/face-refine/install — (re)run the ComfyUI-side
    // FaceRefine install in the background. Returns immediately; poll the
    // status endpoint for progress. Restart ComfyUI when it finishes.
    if (urlPath === '/api/video/face-refine/install' && req.method === 'POST') {
        try {
            const started = faceRefine.startInstall();
            json(res, 200, { ok: true, install: started });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // GET /api/video/fbcache/status — ComfyUI readiness for the MiniMax H3
    // First Block Cache node (loaded in /object_info) + install job state.
    if (urlPath === '/api/video/fbcache/status' && req.method === 'GET') {
        try {
            json(res, 200, await fbcache.getStatus());
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/video/fbcache/install — clone the First Block Cache node pack
    // into ComfyUI/custom_nodes in the background. Returns immediately; poll
    // the status endpoint for progress. Restart ComfyUI when it finishes.
    if (urlPath === '/api/video/fbcache/install' && req.method === 'POST') {
        try {
            const started = fbcache.startInstall();
            json(res, 200, { ok: true, install: started });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // GET /api/setup/status — first-run setup guide state: ComfyUI paths,
    // Hugging Face token state, per-model install status, per-pack custom
    // node status, readiness flags, and the background download job.
    if (urlPath === '/api/setup/status' && req.method === 'GET') {
        try {
            const status = await modelSetup.getStatus();
            try { status.tools = [await thumbnail.getFfmpegStatus()]; } catch { status.tools = []; }
            json(res, 200, status);
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/setup/install-ffmpeg — best-effort install of the optional
    // ffmpeg binary used for gallery video posters (winget/brew/apt). Runs in
    // the background; poll GET /api/setup/status (status.tools[].job).
    if (urlPath === '/api/setup/install-ffmpeg' && req.method === 'POST') {
        try {
            const started = thumbnail.startFfmpegInstall();
            json(res, started.started ? 200 : 409, { ok: started.started, job: started.job, reason: started.reason || null });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/setup/token — save the Hugging Face token ({ token }).
    // Best-effort verification via /api/whoami; the token is stored even
    // when verification is inconclusive (offline), with a warning.
    if (urlPath === '/api/setup/token' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const token = String((body && body.token) || '').trim();
            if (!token) {
                json(res, 400, { error: 'token is required' });
                return true;
            }
            const check = await modelSetup.verifyToken(token);
            const stored = configManager.setHuggingFace({
                token,
                user: check.user || null,
                verifiedAt: check.valid ? new Date().toISOString() : null
            });
            json(res, 200, {
                ok: true,
                valid: check.valid,
                user: check.user || null,
                warning: check.valid ? null : check.error,
                source: 'settings',
                masked: token.length > 7 ? token.slice(0, 3) + '…' + token.slice(-4) : '•••',
                storedUser: stored.user || null
            });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // DELETE /api/setup/token — forget the stored Hugging Face token
    // (env-provided tokens are unaffected).
    if (urlPath === '/api/setup/token' && req.method === 'DELETE') {
        try {
            configManager.setHuggingFace({ token: null, user: null, verifiedAt: null });
            json(res, 200, { ok: true });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/setup/download — download missing models from Hugging Face
    // ({ ids: [...] }, or omit for all missing required). Runs in the
    // background; poll GET /api/setup/status for progress.
    if (urlPath === '/api/setup/download' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            let ids = Array.isArray(body && body.ids) ? body.ids.map(String) : null;
            if (!ids) {
                const status = await modelSetup.getStatus();
                ids = status.models.filter((m) => !m.installed && (m.required || m.id === 'h3_unet_i2va')).map((m) => m.id);
            }
            const started = modelSetup.startDownload(ids);
            json(res, started.started ? 200 : 409, { ok: started.started, job: started.job, reason: started.reason || null });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/setup/install-nodes — git-clone missing custom-node packs
    // ({ ids: [...] }). Runs in the background; poll GET /api/setup/status.
    // Restart ComfyUI when it finishes.
    if (urlPath === '/api/setup/install-nodes' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
            if (!ids.length) {
                json(res, 400, { error: 'ids is required' });
                return true;
            }
            const started = modelSetup.startNodeInstall(ids);
            json(res, started.started ? 200 : 409, { ok: started.started, job: started.job, reason: started.reason || null });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // GET /api/generated — all generated image metadata (newest first) owned by
    // this device session, excluding media produced in private (locked)
    // conversations.
    if (urlPath === '/api/generated' && req.method === 'GET') {
        adoptLegacyState(req.jarvisSession);
        json(res, 200, { images: generatedHistory.listPublic(req.jarvisSession) });
        return true;
    }

    // GET /api/director/state — the active production for a conversation, so
    // the chat UI can restore approval-card interactivity after a reload.
    if (urlPath === '/api/director/state' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const conversationId = query.get('conversationId') || '';
        const production = conversationService.canAccessConversation(conversationId, req.jarvisSession)
            ? director.getProduction(conversationId)
            : null;
        json(res, 200, {
            production: production ? {
                id: production.id,
                status: production.status,
                duration: (production.video && production.video.duration) || null,
                image: (production.image && production.image.url) || null,
                video: production.videoUrl || null,
                brief: production.brief || null,
                error: production.error || ''
            } : null
        });
        return true;
    }

    // GET /api/longvideo/state — the active Long Video Director plan for a
    // conversation, so the storyboard card keeps working after a reload.
    if (urlPath === '/api/longvideo/state' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const conversationId = query.get('conversationId') || '';
        const plan = conversationService.canAccessConversation(conversationId, req.jarvisSession)
            ? longVideoDirector.getPlan(conversationId)
            : null;
        json(res, 200, { plan: plan || null });
        return true;
    }

    // GET /api/playground/themes — the Creative Playground theme catalog
    // (id + label only; the UI never hardcodes the catalog).
    if (urlPath === '/api/playground/themes' && req.method === 'GET') {
        json(res, 200, {
            themes: playground.listThemes().map((t) => ({
                id: t.id,
                label: t.label,
                description: t.description,
                categories: Array.isArray(t.categories)
                    ? t.categories.map((c) => ({ id: c.id, label: c.label }))
                    : []
            }))
        });
        return true;
    }

    // GET /api/playground/options — the independent character controls
    // (appearance / age / gender) the generator understands. The UI never
    // hardcodes the catalog.
    if (urlPath === '/api/playground/options' && req.method === 'GET') {
        json(res, 200, playground.listCharacterOptions());
        return true;
    }

    // GET /api/playground/outfits — the Outfit Pack catalog (wardrobe
    // personalities). The UI never hardcodes the catalog.
    if (urlPath === '/api/playground/outfits' && req.method === 'GET') {
        json(res, 200, { packs: playground.listOutfitPacks() });
        return true;
    }

    // GET /api/playground/state — the active concept for a conversation, so the
    // concept card keeps working after a reload.
    if (urlPath === '/api/playground/state' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const conversationId = query.get('conversationId') || '';
        const session = conversationService.canAccessConversation(conversationId, req.jarvisSession)
            ? playground.getSession(conversationId)
            : null;
        json(res, 200, {
            concept: session
                ? playground.buildCard(session, playground.resolveCharacter(session.characterId))
                : null
        });
        return true;
    }

    // GET /api/ugc/state — the active UGC Studio project for a conversation, so
    // the card and the "UGC Studio · Active" indicator keep working after a reload.
    if (urlPath === '/api/ugc/state' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const conversationId = query.get('conversationId') || '';
        const canAccess = conversationService.canAccessConversation(conversationId, req.jarvisSession);
        const project = canAccess ? ugcStudio.getProject(conversationId) : null;
        json(res, 200, {
            project: project ? ugcStudio.buildCard(project) : null,
            drafts: ugcStudio.listProjects().filter((p) => p.status === ugcStudio.STATUS.DRAFT &&
                conversationService.canAccessConversation(p.conversationId, req.jarvisSession))
                .map((p) => ({ id: p.id, stage: p.stage, updatedAt: p.updatedAt, product: p.product ? p.product.name : '' }))
        });
        return true;
    }

    // GET /api/ugc/options — the UGC Studio catalogs (content types, environments,
    // platforms, outfit packs, saved characters). The UI never hardcodes them.
    if (urlPath === '/api/ugc/options' && req.method === 'GET') {
        json(res, 200, {
            contentTypes: ugcStudio.listContentTypes(),
            environments: ugcStudio.listEnvironments(),
            platforms: ugcStudio.listPlatforms(),
            outfitPacks: ugcStudio.listOutfitPacks().map((p) => ({ id: p.id, label: p.label, description: p.description })),
            characters: ugcStudio.listCharacters().map((c) => ({ id: c.id, name: c.name || 'Character' }))
        });
        return true;
    }

    // GET /api/ugc/products — the reusable product library.
    if (urlPath === '/api/ugc/products' && req.method === 'GET') {
        json(res, 200, { products: ugcProducts.list() });
        return true;
    }

    // POST /api/ugc/products — create or update a product ({ id } for update).
    if (urlPath === '/api/ugc/products' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const product = body && body.id
                ? ugcProducts.update(body.id, body)
                : ugcProducts.create(body);
            if (!product) {
                json(res, 404, { error: 'Product not found' });
                return true;
            }
            json(res, 200, { ok: true, product });
        } catch (err) {
            json(res, err.code === 'product_invalid' ? 400 : 500, { error: err.message });
        }
        return true;
    }

    // DELETE /api/ugc/products/:id — remove a product from the library.
    const ugcProductDeleteMatch = urlPath.match(/^\/api\/ugc\/products\/([^/]+)$/);
    if (ugcProductDeleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(ugcProductDeleteMatch[1]);
        const removed = ugcProducts.remove(id);
        json(res, removed ? 200 : 404, { ok: removed });
        return true;
    }

    // GET /api/characters — saved character presets for the playground picker.
    if (urlPath === '/api/characters' && req.method === 'GET') {
        json(res, 200, { characters: characterPresets.list() });
        return true;
    }

    // GET /api/characters/options — lightweight character list for the chat @
    // picker: name, identity status and primary image only (never paths). This
    // must stay ahead of the /api/characters/:id route below.
    if (urlPath === '/api/characters/options' && req.method === 'GET') {
        json(res, 200, { characters: characterContext.listCharacterOptions() });
        return true;
    }

    // POST /api/characters — create ({ name, identity, appearance, hair, outfit,
    // style }) or update ({ id, ... }) a character preset.
    if (urlPath === '/api/characters' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const preset = body && body.id
                ? characterPresets.update(body.id, body)
                : characterPresets.create(body);
            if (!preset) {
                json(res, 404, { error: 'Character preset not found' });
                return true;
            }
            json(res, 200, { ok: true, character: preset });
        } catch (err) {
            json(res, 400, { error: err.message });
        }
        return true;
    }

    if (urlPath === '/api/playground/scenes' && req.method === 'GET') {
        json(res, 200, { scenes: playground.listScenes() });
        return true;
    }
    if (urlPath === '/api/playground/scenes' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const record = Object.assign({}, body || {}, { id: body && body.id || 'scene_' + Date.now().toString(36) });
            const saved = playground.saveScene(Object.assign({}, record, {
                themeId: record.themeId || (record.scene && record.scene.themeId) || 'anything',
                scene: record.scene || record.concept || {}, concept: record.scene || record.concept || {}
            }));
            json(res, 200, { ok: true, scene: saved });
        } catch (err) {
            json(res, 400, { error: err.message, code: err.code || 'scene_invalid' });
        }
        return true;
    }
    const compositionMatch = urlPath.match(/^\/api\/playground\/compositions\/([^/]+)$/);
    if (compositionMatch && req.method === 'GET') {
        const composition = playground.getComposition(decodeURIComponent(compositionMatch[1]));
        json(res, composition ? 200 : 404, composition ? { composition } : { error: 'Composition not found' });
        return true;
    }
    const compositionCloneMatch = urlPath.match(/^\/api\/playground\/compositions\/([^/]+)\/clone$/);
    if (compositionCloneMatch && req.method === 'POST') {
        const composition = playground.cloneComposition(decodeURIComponent(compositionCloneMatch[1]));
        json(res, composition ? 200 : 404, composition ? { ok: true, composition } : { error: 'Composition not found' });
        return true;
    }

    const characterResourceMatch = urlPath.match(/^\/api\/characters\/([^/]+)$/);
    if (characterResourceMatch && req.method === 'GET') {
        const character = characterPresets.get(decodeURIComponent(characterResourceMatch[1]));
        json(res, character ? 200 : 404, character ? { character } : { error: 'Character not found' });
        return true;
    }
    if (characterResourceMatch && req.method === 'PATCH') {
        try {
            const body = await readBody(req);
            const character = characterStudio.updateCharacter(
                decodeURIComponent(characterResourceMatch[1]), body, body && body.expectedRevision
            );
            json(res, character ? 200 : 404, character ? { ok: true, character } : { error: 'Character not found' });
        } catch (err) {
            json(res, err.code === 'stale_revision' ? 409 : 400, { error: err.message, code: err.code || 'character_invalid' });
        }
        return true;
    }
    const characterDuplicateMatch = urlPath.match(/^\/api\/characters\/([^/]+)\/duplicate$/);
    if (characterDuplicateMatch && req.method === 'POST') {
        const body = await readBody(req);
        const character = characterPresets.duplicate(decodeURIComponent(characterDuplicateMatch[1]), body || {});
        json(res, character ? 200 : 404, character ? { ok: true, character } : { error: 'Character not found' });
        return true;
    }
    const characterPortraitMatch = urlPath.match(/^\/api\/characters\/([^/]+)\/portrait$/);
    if (characterPortraitMatch && req.method === 'POST') {
        // The character preview is the candidate base image: it lives on the
        // identity package now (one approved base image per character).
        let body = {};
        try { body = await readBody(req); } catch (err) { body = {}; }
        const character = characterPresets.setCandidateBaseImage(
            decodeURIComponent(characterPortraitMatch[1]), body && (body.portrait || body)
        );
        json(res, character ? 200 : 404, character ? { ok: true, character } : { error: 'Character not found' });
        return true;
    }

    // --- Character Identity System -------------------------------------------
    // GET /api/characters/:id/identity — the identity package card (the one
    // approved base image, the one consolidated identity sheet, structured
    // metadata and status). Never exposes paths.
    const characterIdentityMatch = urlPath.match(/^\/api\/characters\/([^/]+)\/identity$/);
    if (characterIdentityMatch && req.method === 'GET') {
        const character = characterPresets.get(decodeURIComponent(characterIdentityMatch[1]));
        if (!character) {
            json(res, 404, { error: 'Character not found' });
            return true;
        }
        json(res, 200, { card: characterIdentity.buildCard(character) });
        return true;
    }
    if (characterIdentityMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(characterIdentityMatch[1]);
        const existing = characterPresets.get(id);
        if (!existing) {
            json(res, 404, { error: 'Character not found' });
            return true;
        }
        // Remove only the consolidated identity sheet (and its file). The
        // approved base image and the character itself are kept.
        const pkg = characterPresets.getIdentityPackage(id);
        const sheetFilename = pkg && pkg.identitySheet ? pkg.identitySheet.filename : '';
        characterPresets.clearIdentitySheet(id);
        if (sheetFilename) generatedHistory.removeByFilename(sheetFilename);
        json(res, 200, { ok: true });
        return true;
    }

    // POST /api/characters/:id/identity/approve — approve the current candidate
    // base image and generate the consolidated identity sheet in one turn. SSE
    // stream: `generating` / `identityProgress`, then an `identity` card.
    const characterIdentityApproveMatch = urlPath.match(/^\/api\/characters\/([^/]+)\/identity\/approve$/);
    if (characterIdentityApproveMatch && req.method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch (err) { body = {}; }
        const character = characterPresets.get(decodeURIComponent(characterIdentityApproveMatch[1]));
        if (!character) {
            json(res, 404, { error: 'Character not found' });
            return true;
        }
        const pkg = characterPresets.getIdentityPackage(character.id);
        if (!pkg || !pkg.approvedBaseImage || !pkg.approvedBaseImage.filename) {
            json(res, 400, { error: 'Generate a candidate character image before approving it.' });
            return true;
        }
        const turn = await acquireTurn(res, { label: 'character identity', conversationId: null });
        if (!turn) return true;
        const stopProgress = forwardComfyProgress(res);
        try {
            characterPresets.approveBaseImage(character.id);
            await runIdentitySheetStream(req, res, character, {
                conversationId: null,
                provider: body.provider || 'ollama',
                model: body.model || ''
            });
            emitIdentityCardEvent(res, character.id);
        } catch (err) {
            console.error('[character-identity] approval failed:', err.message);
            sseWrite(res, { error: friendlyImageError(err) });
            res.end();
        } finally {
            stopProgress();
        }
        return true;
    }

    // POST /api/characters/:id/identity/sheet — (re)generate the consolidated
    // identity sheet from the approved base image. Never overwrites a valid
    // sheet with failed output.
    const characterIdentitySheetMatch = urlPath.match(/^\/api\/characters\/([^/]+)\/identity\/sheet$/);
    if (characterIdentitySheetMatch && req.method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch (err) { body = {}; }
        const character = characterPresets.get(decodeURIComponent(characterIdentitySheetMatch[1]));
        if (!character) {
            json(res, 404, { error: 'Character not found' });
            return true;
        }
        const pkg = characterPresets.getIdentityPackage(character.id);
        if (!pkg || !pkg.approvedBaseImage || !pkg.approvedBaseImage.filename) {
            json(res, 400, { error: 'Approve a character image before creating its identity sheet.' });
            return true;
        }
        const turn = await acquireTurn(res, { label: 'character identity', conversationId: null });
        if (!turn) return true;
        const stopProgress = forwardComfyProgress(res);
        try {
            await runIdentitySheetStream(req, res, character, {
                conversationId: null,
                provider: body.provider || 'ollama',
                model: body.model || ''
            });
            emitIdentityCardEvent(res, character.id);
        } catch (err) {
            console.error('[character-identity] sheet generation failed:', err.message);
            sseWrite(res, { error: friendlyImageError(err) });
            res.end();
        } finally {
            stopProgress();
        }
        return true;
    }

    // DELETE /api/characters/:id — remove a saved character and the files its
    // identity package owns (the approved base image + the identity sheet).
    const characterDeleteMatch = urlPath.match(/^\/api\/characters\/([^/]+)$/);
    if (characterDeleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(characterDeleteMatch[1]);
        const character = characterPresets.get(id);
        if (!character) {
            json(res, 404, { ok: false });
            return true;
        }
        const pkg = characterPresets.getIdentityPackage(id);
        const media = pkg ? characterIdentity.mediaFilenames(pkg) : [];
        const removed = characterPresets.remove(id);
        if (removed) {
            for (const name of Array.from(new Set(media))) {
                generatedHistory.removeByFilename(name);
            }
        }
        json(res, removed ? 200 : 404, { ok: removed });
        return true;
    }

    // GET /api/activity — recent activity feed for the dashboard widget,
    // scoped to this device session. Generation events carry a conversationId
    // and are hidden from other devices; system/VRAM events stay shared.
    if (urlPath === '/api/activity' && req.method === 'GET') {
        adoptLegacyState(req.jarvisSession);
        const entries = activityLog.list(30).filter((entry) => {
            if (!entry.conversationId) return true;
            return conversationService.canAccessConversation(entry.conversationId, req.jarvisSession);
        });
        json(res, 200, {
            entries,
            uptime: process.uptime(),
            startedAt: serverStartedAt
        });
        return true;
    }

    // DELETE /api/generated/:id — delete a generated image (history + file)
    const genDeleteMatch = urlPath.match(/^\/api\/generated\/([^/]+)$/);
    if (genDeleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(genDeleteMatch[1]);
        const removed = generatedHistory.remove(id, req.jarvisSession);
        if (!removed) {
            json(res, 404, { error: 'Image not found' });
            return true;
        }
        json(res, 200, { ok: true });
        return true;
    }

    // POST /api/upscale — upscale the last generated image in a conversation
    // (or an explicit data/generated filename). Used by the chat pipeline and
    // available for the gallery. Optional body overrides: engine, profile,
    // noise, mode, resolution, multiplier, prompt.
    if (urlPath === '/api/upscale' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (body.conversationId && !conversationService.canAccessConversation(body.conversationId, req.jarvisSession)) {
                json(res, 404, { error: 'Conversation not found' });
                return true;
            }
            const source = resolveUpscaleSource(body.conversationId, body.filename);
            if (!source) {
                json(res, 404, { error: 'No generated image found to upscale. Generate an image first, then upscale it.' });
                return true;
            }
            if (source.meta && source.meta.sessionId && source.meta.sessionId !== req.jarvisSession) {
                json(res, 404, { error: 'Image not found' });
                return true;
            }
            const turn = await acquireTurn(res, { label: 'image upscale', conversationId: body.conversationId });
            if (!turn) return true;
            await vramManager.freeVRAMBeforeImage();
            const result = await imageGenerator.upscaleImage(source.rawFilename, {
                engine: body.engine,
                profile: body.profile,
                noise: body.noise,
                mode: body.mode,
                resolution: body.resolution,
                multiplier: body.multiplier,
                preScale: body.preScale,
                prompt: body.prompt,
                conversationId: body.conversationId || (source.meta && source.meta.conversationId) || null,
                label: 'image upscale', kind: 'image_upscale'
            });
            json(res, 200, { ok: true, image: result });
        } catch (err) {
            json(res, 502, { error: friendlyImageError(err) });
        }
        return true;
    }

    // POST /api/video/upscale — upscale the last generated video in a conversation
    // (or an explicit data/generated filename). Used by the chat pipeline and
    // available for the gallery. Reads the shared upscale settings (same as
    // image upscale); optional body overrides: engine (seedvr2|rtx), resolution,
    // profile, noise, preScale (SeedVR2), scale, quality, fps (RTX).
    if (urlPath === '/api/video/upscale' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (body.conversationId && !conversationService.canAccessConversation(body.conversationId, req.jarvisSession)) {
                json(res, 404, { error: 'Conversation not found' });
                return true;
            }
            const source = resolveVideoUpscaleSource(body.conversationId, body.filename);
            if (!source) {
                json(res, 404, { error: 'No generated video found to upscale. Generate a video first, then upscale it.' });
                return true;
            }
            if (source.meta && source.meta.sessionId && source.meta.sessionId !== req.jarvisSession) {
                json(res, 404, { error: 'Video not found' });
                return true;
            }
            const turn = await acquireTurn(res, { label: 'video upscale', conversationId: body.conversationId });
            if (!turn) return true;
            await vramManager.freeVRAMBeforeImage();
            const result = await videoGenerator.upscaleVideo(source.rawFilename, {
                engine: body.engine,
                resolution: body.resolution,
                profile: body.profile,
                noise: body.noise,
                preScale: body.preScale,
                scale: body.scale,
                quality: body.quality,
                fps: body.fps,
                conversationId: body.conversationId || (source.meta && source.meta.conversationId) || null,
                label: 'video upscale', kind: 'video_upscale'
            });
            json(res, 200, { ok: true, video: result });
        } catch (err) {
            json(res, 502, { error: friendlyVideoError(err) });
        }
        return true;
    }

    // POST /api/comfyui/free — unload all ComfyUI models and free cached memory
    if (urlPath === '/api/comfyui/free' && req.method === 'POST') {
        try {
            if (!(await comfyui.isAvailable())) {
                json(res, 409, { error: 'ComfyUI is unreachable' });
                return true;
            }
            await comfyui.freeModels();
            activityLog.record({ type: 'unload', title: 'VRAM freed', detail: 'ComfyUI models unloaded' });
            json(res, 200, { ok: true, freed: 'comfyui-models' });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/comfyui/cancel — interrupt the running ComfyUI prompt and
    // clear its native pending queue so the GPU goes idle. Used by the
    // ComfyUI widget's Cancel button. The JARVIS-side job waiting in
    // waitForPrompt is aborted explicitly so it releases the shared
    // generation slot immediately instead of waiting for a ComfyUI error.
    if (urlPath === '/api/comfyui/cancel' && req.method === 'POST') {
        try {
            if (!(await comfyui.isAvailable())) {
                json(res, 409, { error: 'ComfyUI is unreachable' });
                return true;
            }
            const result = await comfyui.cancelCurrentJob();
            const queueStatus = generationQueue.getStatus();
            if (queueStatus.active) imageGenerator.cancelActive(queueStatus.active.id);
            json(res, 200, { ok: true, interrupted: result.interrupted, cleared: result.cleared });
        } catch (err) {
            json(res, 502, { error: 'Cancel failed: ' + err.message });
        }
        return true;
    }

    // POST /api/comfyui/start — launch a local ComfyUI server (Desktop
    // standalone or portable) as a detached background process and wait for
    // its API to come online. Powers the COMFYUI widget's Start button.
    if (urlPath === '/api/comfyui/start' && req.method === 'POST') {
        try {
            const result = await comfyuiLauncher.start();
            if (result.alreadyRunning) {
                json(res, 200, { ok: true, alreadyRunning: true });
            } else {
                activityLog.record({
                    type: 'system',
                    title: 'ComfyUI started',
                    detail: result.label ? 'Launched via ' + result.label : 'Launched'
                });
                json(res, 200, { ok: true, started: true, method: result.method || null });
            }
        } catch (err) {
            json(res, 502, { error: err.message });
        }
        return true;
    }

    // GET /api/comfyui/status — ComfyUI availability, queue and device stats
    if (urlPath === '/api/comfyui/status' && req.method === 'GET') {
        try {
            const available = await comfyui.isAvailable();
            if (!available) {
                const launchStatus = await comfyuiLauncher.getLaunchInfo().catch(() => ({ canStart: false }));
                json(res, 200, {
                    available: false, queue: null, system_stats: null,
                    canStart: !!launchStatus.canStart, startMethod: launchStatus.method || null
                });
                return true;
            }
            const [queue, systemStats] = await Promise.all([
                comfyui.getQueue(),
                comfyui.getSystemStats()
            ]);
            json(res, 200, { available: true, queue, system_stats: systemStats });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // GET /api/comfyui/events — Server-Sent Events streaming live generation
    // progress. The JARVIS server keeps a WebSocket to ComfyUI and relays the
    // step/total progress here; the browser never talks to ComfyUI directly.
    if (urlPath === '/api/comfyui/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        const send = (event, data) => {
            try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch {}
        };
        const onProgress = (update) => {
            if (update && update.idle) {
                send('idle', {});
            } else {
                send('progress', { value: update.value, max: update.max });
            }
        };
        comfyui.subscribeProgress(onProgress);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => {
            clearInterval(ping);
            comfyui.unsubscribeProgress(onProgress);
        });
        return true;
    }

    // GET /api/queue — shared generation queue status (active + pending)
    if (urlPath === '/api/queue' && req.method === 'GET') {
        json(res, 200, Object.assign(generationQueue.getStatus(), { turn: turnQueue.getStatus() }));
        return true;
    }

    // POST /api/queue/cancel — cancel a turn waiting for the single turn slot
    // ({ turnId }), a queued generation ({ queueId }), or the active job
    // ({ queueId, active: true } aborts via ComfyUI /interrupt).
    if (urlPath === '/api/queue/cancel' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            if (body.turnId !== undefined && turnQueue.cancelQueued(body.turnId)) {
                json(res, 200, { ok: true, cancelled: Number(body.turnId), turn: true });
                return true;
            }
            const queueId = Number(body.queueId);
            if (!Number.isFinite(queueId)) {
                json(res, 400, { error: 'queueId is required' });
                return true;
            }
            if (imageGenerator.cancelQueued(queueId)) {
                json(res, 200, { ok: true, cancelled: queueId });
                return true;
            }
            const status = generationQueue.getStatus();
            if (body.active && status.active && status.active.id === queueId) {
                // Abort the waiter first so it stops polling even if the
                // ComfyUI interrupt is slow or fails.
                imageGenerator.cancelActive(queueId);
                let interrupted = false;
                try { await comfyui.interrupt(); interrupted = true; } catch (err) {
                    console.warn('[queue] ComfyUI interrupt failed:', err.message);
                }
                json(res, 200, { ok: true, cancelled: queueId, interrupted });
                return true;
            }
            json(res, 404, { error: 'Job not found in queue. It may have already started or finished.' });
        } catch (err) {
            json(res, 500, { error: err.message });
        }
        return true;
    }

    // POST /api/models/unload (legacy)
    if (urlPath === '/api/models/unload' && req.method === 'POST') {
        handleUnloadModel(req, res);
        return true;
    }

    // POST /api/restart — exit with a code that start.bat catches to relaunch
    if (urlPath === '/api/restart' && req.method === 'POST') {
        json(res, 200, { restarting: true });
        res.on('finish', () => {
            setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
        });
        return true;
    }

    // POST /api/uploads — store a user-attached image for vision chat.
    // Body: { filename, mime, data (base64) }. Returns { url, filename, mime, size }.
    if (urlPath === '/api/uploads' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const result = saveUpload(body);
            json(res, 201, result);
        } catch (err) {
            json(res, err.status || 400, { error: err.message });
        }
        return true;
    }

    // GET /api/conversations
    if (urlPath === '/api/conversations' && req.method === 'GET') {
        adoptLegacyState(req.jarvisSession);
        json(res, 200, { conversations: conversationService.getAllConversations(req.jarvisSession) });
        return true;
    }

    // POST /api/conversations
    if (urlPath === '/api/conversations' && req.method === 'POST') {
        handleCreateConversation(req, res);
        return true;
    }

    // GET /api/conversations/:id
    const convMatch = urlPath.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch && req.method === 'GET') {
        handleGetConversation(req, res, decodeURIComponent(convMatch[1]));
        return true;
    }

    // PATCH /api/conversations/:id (rename and/or toggle private)
    if (convMatch && req.method === 'PATCH') {
        handleUpdateConversation(req, res, decodeURIComponent(convMatch[1]));
        return true;
    }

    // DELETE /api/conversations/:id
    if (convMatch && req.method === 'DELETE') {
        handleDeleteConversation(req, res, decodeURIComponent(convMatch[1]));
        return true;
    }

    // GET /api/conversations/:id/messages
    const msgMatch = urlPath.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (msgMatch && req.method === 'GET') {
        handleGetMessages(req, res, decodeURIComponent(msgMatch[1]));
        return true;
    }

    // POST /api/conversations/:id/messages
    if (msgMatch && req.method === 'POST') {
        handleAddMessage(req, res, decodeURIComponent(msgMatch[1]));
        return true;
    }

    // POST /api/conversations/:id/summarize
    const sumMatch = urlPath.match(/^\/api\/conversations\/([^/]+)\/summarize$/);
    if (sumMatch && req.method === 'POST') {
        handleSummarize(req, res, decodeURIComponent(sumMatch[1]));
        return true;
    }

    // GET /generated/thumb/:file — serve the cached gallery thumbnail. Thumbs
    // are produced in the background; until one exists we return 404 (no-store)
    // and the frontend falls back to the full image for that tile.
    const thumbMatch = urlPath.match(/^\/generated\/thumb\/([^/]+)$/);
    if (thumbMatch && req.method === 'GET') {
        const rawName = path.basename(decodeURIComponent(thumbMatch[1]));
        const buffer = thumbnail.read(rawName);
        if (!buffer) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('No thumbnail');
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(buffer);
        return true;
    }

    // GET /generated/:file — serve generated images/videos
    const generatedMatch = urlPath.match(/^\/generated\/([^/]+)$/);
    if (generatedMatch && req.method === 'GET') {
        const filename = decodeURIComponent(generatedMatch[1]);
        const safeName = path.basename(filename);
        const fullPath = path.join(GENERATED_DIR, safeName);
        if (!fullPath.startsWith(GENERATED_DIR) || !fs.existsSync(fullPath)) {
            send404(res);
            return true;
        }
        sendMediaFile(req, res, fullPath);
        return true;
    }

    // GET /images/:file — serve user-uploaded vision images
    const imagesMatch = urlPath.match(/^\/images\/([^/]+)$/);
    if (imagesMatch && req.method === 'GET') {
        const filename = decodeURIComponent(imagesMatch[1]);
        const safeName = path.basename(filename);
        const fullPath = path.join(IMAGES_DIR, safeName);
        if (!fullPath.startsWith(IMAGES_DIR) || !fs.existsSync(fullPath)) {
            send404(res);
            return true;
        }
        sendMediaFile(req, res, fullPath);
        return true;
    }

    // Unknown API route
    if (urlPath.startsWith('/api/')) {
        json(res, 404, { error: 'Not found' });
        return true;
    }

    return false;
}

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function saveUpload(body) {
    const mime = String((body && body.mime) || '').toLowerCase();
    const ext = UPLOAD_MIME_TO_EXT[mime];
    if (!ext) throw badRequest('Unsupported image type. Use PNG, JPEG, or WebP.');
    let data = String((body && body.data) || '');
    const dataPrefix = data.match(/^data:[^;]+;base64,/);
    if (dataPrefix) data = data.slice(dataPrefix[0].length);
    data = data.trim();
    if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw badRequest('Invalid base64 image data.');
    let buffer;
    try {
        buffer = Buffer.from(data, 'base64');
    } catch {
        throw badRequest('Invalid base64 image data.');
    }
    if (!buffer.length) throw badRequest('Empty image upload.');
    if (buffer.length > UPLOAD_MAX_BYTES) throw badRequest('Image is too large. Max 10 MB.');
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const filename = crypto.randomUUID() + ext;
    const fullPath = path.join(IMAGES_DIR, filename);
    if (!fullPath.startsWith(IMAGES_DIR)) throw badRequest('Invalid upload path.');
    fs.writeFileSync(fullPath, buffer);
    return {
        url: '/images/' + encodeURIComponent(filename),
        filename,
        mime,
        size: buffer.length
    };
}

function sanitizeChatImages(images) {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw badRequest('images must be an array.');
    if (images.length > CHAT_IMAGES_MAX) throw badRequest('Too many images. Max 3 per message.');
    return images.map((item) => {
        let data = String(item || '');
        const prefix = data.match(/^data:[^;]+;base64,/);
        if (prefix) data = data.slice(prefix[0].length);
        data = data.trim();
        if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw badRequest('Invalid base64 image data.');
        const size = Buffer.byteLength(data, 'base64');
        if (size > UPLOAD_MAX_BYTES) throw badRequest('Image is too large. Max 10 MB.');
        return data.replace(/\s+/g, '');
    });
}

// Validate an @-picker reference: an image filename inside data/generated.
// Returns the bare safe filename, or null when it is missing/not an image.
function sanitizeReferenceImage(value) {
    const safeName = path.basename(String(value || '').split('?')[0]);
    if (!safeName || !/\.(?:png|jpe?g|webp)$/i.test(safeName)) return null;
    const fullPath = path.join(GENERATED_DIR, safeName);
    if (!fullPath.startsWith(GENERATED_DIR) || !fs.existsSync(fullPath)) return null;
    return safeName;
}

// Validate an ordered list of @-picker references, dropping invalid entries
// while preserving order and position. Order is meaningful: the first is the
// edit source and each subsequent entry maps to the matching "image N" wording
// in the instruction, so entries are NOT de-duplicated.
function sanitizeReferenceImages(value) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    const out = [];
    for (const item of list) {
        const safeName = sanitizeReferenceImage(item);
        if (!safeName) continue;
        out.push(safeName);
        if (out.length >= REFERENCE_IMAGES_MAX) break;
    }
    return out;
}

// Resolve a reference to the edit-source shape (absPath/kind/rawFilename).
function resolveReferenceSource(rawFilename) {
    const safeName = sanitizeReferenceImage(rawFilename);
    if (!safeName) return null;
    return {
        absPath: path.join(GENERATED_DIR, safeName),
        kind: 'generated',
        rawFilename: safeName
    };
}

// Resolve an ordered list of references to edit-source shapes.
function resolveReferenceSources(list) {
    const names = Array.isArray(list) ? list : (list ? [list] : []);
    return names.map(resolveReferenceSource).filter(Boolean);
}

// Read referenced generated image(s) as vision base64 (best-effort) so chat can
// answer questions about them. Oversized or unreadable files are skipped.
function referenceVisionImages(referenceImage) {
    const list = Array.isArray(referenceImage) ? referenceImage : (referenceImage ? [referenceImage] : []);
    const out = [];
    for (const item of list) {
        const source = resolveReferenceSource(item);
        if (!source) continue;
        try {
            const buffer = fs.readFileSync(source.absPath);
            if (!buffer.length || buffer.length > UPLOAD_MAX_BYTES) continue;
            out.push(buffer.toString('base64'));
        } catch (err) {
            /* skip unreadable reference */
        }
    }
    return out;
}

// --- Conversation handlers ---

async function handleCreateConversation(req, res) {
    try {
        const body = await readBody(req);
        const conversation = conversationService.createConversation(body, req.jarvisSession);
        json(res, 201, conversation);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}

function handleGetConversation(req, res, id) {
    if (!requireConversationAccess(req, res, id)) return;
    const conversation = conversationService.getConversation(id);
    if (!conversation) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    json(res, 200, conversation);
}

async function handleUpdateConversation(req, res, id) {
    try {
        if (!requireConversationAccess(req, res, id)) return;
        const body = await readBody(req);
        let conversation = conversationService.getConversation(id);
        if (!conversation) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }
        if (body.title !== undefined) {
            conversation = conversationService.renameConversation(id, body.title) || conversation;
        }
        if (body.private !== undefined) {
            conversation = conversationService.setConversationPrivate(id, body.private) || conversation;
        }
        json(res, 200, conversation);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}

function handleDeleteConversation(req, res, id) {
    if (!requireConversationAccess(req, res, id)) return;
    const messages = conversationService.getMessages(id);
    const removed = conversationService.deleteConversation(id);
    if (!removed) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    removeConversationImages(messages, id);
    taskState.clearTask(id);
    director.removeProduction(id);
    json(res, 200, { ok: true });
}

// Remove generated media files (images and videos) that were linked from a
// deleted conversation's messages, keeping the gallery in sync with what the
// chat actually references.
function removeConversationImages(messages, conversationId) {
    const wanted = new Set();
    // Character identity media is protected: it belongs to the character
    // package, not the conversation, and must survive a conversation delete.
    const protectedNames = characterContext.characterMediaFilenames();
    // Same character exclusions as resolveUpscaleSource /
    // resolveVideoUpscaleSource — video embeds use quoted src attributes
    // (<video ... src="/generated/<file>">), so quotes must terminate the
    // match or the captured name keeps a trailing quote and never matches.
    const urlRe = /\/generated\/([^\s)\]}"']+)/g;
    const collect = (value) => {
        if (!value) return;
        let name = String(value).split('?')[0];
        name = name.slice(name.lastIndexOf('/') + 1);
        try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
        if (name) wanted.add(name);
    };
    (messages || []).forEach((m) => {
        const content = (m && m.content) || '';
        let match;
        urlRe.lastIndex = 0;
        while ((match = urlRe.exec(content))) {
            collect(match[1]);
        }
    });
    // Fall back to the conversation's bound task asset (e.g. a video upscale
    // reply only embeds the upscaled output, not its source).
    if (conversationId) {
        try {
            collect(taskState.getTask(conversationId).generatedAsset);
        } catch (err) { /* ignore — messages already scanned */ }
    }
    if (!wanted.size) return;

    const entries = generatedHistory.list();
    const basenameOf = (entry) => {
        const raw = entry.rawFilename || String(entry.file || '').split('/').pop() || '';
        try { return decodeURIComponent(raw); } catch (err) { return raw; }
    };
    const idsToDelete = new Set();
    entries.forEach((entry) => {
        const name = basenameOf(entry);
        if (protectedNames.has(name)) return;
        if (wanted.has(name)) idsToDelete.add(entry.id);
    });
    // Also drop the other half of any upscale pair (the original whose file
    // is an entry's upscale.source, or the upscaled child pointing at a
    // deleted original) so no orphaned partner survives in the gallery.
    entries.forEach((entry) => {
        const source = entry.upscale && entry.upscale.source
            ? String(entry.upscale.source).split('/').pop()
            : null;
        if (!source) return;
        let decoded = source;
        try { decoded = decodeURIComponent(source); } catch (err) { /* keep raw */ }
        const childName = basenameOf(entry);
        if (wanted.has(decoded) || idsToDelete.has(entry.id)) {
            entries.forEach((other) => {
                const otherName = basenameOf(other);
                if (protectedNames.has(otherName)) return;
                if (otherName === decoded || otherName === childName) idsToDelete.add(other.id);
            });
        }
    });
    idsToDelete.forEach((entryId) => generatedHistory.remove(entryId));
}

function handleGetMessages(req, res, id) {
    if (!requireConversationAccess(req, res, id)) return;
    if (!conversationService.getConversation(id)) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    json(res, 200, { messages: conversationService.getMessages(id) });
}

async function handleAddMessage(req, res, id) {
    try {
        if (!requireConversationAccess(req, res, id)) return;
        const body = await readBody(req);
        if (!body.content || !body.role) {
            json(res, 400, { error: 'role and content are required' });
            return;
        }
        const message = conversationService.addMessage(id, body.role, body.content);
        if (!message) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }
        json(res, 201, message);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}

async function handleSummarize(req, res, id) {
    try {
        if (!requireConversationAccess(req, res, id)) return;
        const body = await readBody(req);
        const provider = body.provider || 'ollama';
        const model = body.model || '';
        const messages = conversationService.getMessages(id).map((m) => Object.assign({}, m, {
            content: contextBuilder.stripDirectorMarkers(m.content)
        }));
        if (messages.length === 0) {
            json(res, 200, { summary: '' });
            return;
        }
        const summary = await providers.summarize(provider, model, messages, { think: resolveChatThink(body) });
        conversationService.setSummary(id, summary);
        json(res, 200, { summary });
    } catch (err) {
        json(res, 502, { error: err.message });
    }
}

// Build the live environment block injected into a chat turn: machine
// telemetry (gated on a stats question), weather (gated on a weather
// question, with an Open-Meteo lookup), and news (gated on a news question,
// with an RSS lookup). All are no-ops when irrelevant.
async function buildEnvironmentContext(message) {
    const parts = [];
    const statsContext = contextBuilder.buildSystemStatsContext(message, systemMonitor.getStats());
    if (statsContext) parts.push(statsContext);
    try {
        const weatherContext = await weather.buildWeatherContext(message);
        if (weatherContext) parts.push(weatherContext);
    } catch (err) {
        console.warn('[weather] context lookup failed:', err.message);
    }
    try {
        const newsContext = await news.buildNewsContext(message);
        if (newsContext) parts.push(newsContext);
    } catch (err) {
        console.warn('[news] context lookup failed:', err.message);
    }
    return parts.join('\n\n');
}

// --- Turn serialization ---
// Every GPU-touching turn (chat, image/video/upscale, Director, UGC, Long
// Video, Playground) acquires the single turn slot so several clients on the
// same WiFi can never swap the Ollama/ComfyUI model sets out from under each
// other. The slot is released when the response finishes or the client
// disconnects. Control endpoints (cancel/free/status) deliberately bypass this.
// Returns a handle ({ id, release }) or null when the turn could not start
// (queue full or cancelled while waiting), in which case the response is
// already settled.
async function acquireTurn(res, opts) {
    let handle;
    try {
        handle = await turnQueue.acquire(opts);
    } catch (err) {
        if (err && err.code === 'turn_cancelled') {
            if (res.headersSent && !res.writableEnded) {
                sseWrite(res, { error: 'Cancelled while waiting for another request.' });
                sseWrite(res, { done: true, fullReply: '' });
                res.end();
            } else if (!res.writableEnded) {
                json(res, 499, { error: 'Cancelled while waiting.' });
            }
            return null;
        }
        if (res.headersSent && !res.writableEnded) {
            sseWrite(res, { error: err.message });
            res.end();
        } else if (!res.writableEnded) {
            json(res, 503, { error: err.message });
        }
        return null;
    }
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        handle.release();
    };
    res.on('finish', release);
    res.on('close', release);
    return { id: handle.id, release };
}

async function handleChat(req, res) {
    try {
        const body = await readBody(req);

        const provider = body.provider || 'ollama';
        const model = body.model || '';
        const conversationId = body.conversationId;
        const message = body.message;

        if (!conversationId) {
            json(res, 400, { error: 'conversationId is required' });
            return;
        }
        let chatImages = [];
        try {
            chatImages = sanitizeChatImages(body.images);
        } catch (err) {
            json(res, 400, { error: err.message });
            return;
        }
        if ((!message || typeof message !== 'string' || !message.trim()) && chatImages.length === 0) {
            json(res, 400, { error: 'message is required' });
            return;
        }

        if (!conversationService.canAccessConversation(conversationId, req.jarvisSession)) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }

        const turn = await acquireTurn(res, { label: 'chat', conversationId });
        if (!turn) return;

        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        const sampling = resolveChatSampling(body);
        const environmentContext = await buildEnvironmentContext(message);
        const contextMessages = contextBuilder.buildContext(conversationId, message, provider, model, '', chatImages, environmentContext);
        const reply = await providers.chat(provider, contextMessages, model, { think: resolveChatThink(body), ...sampling });

        json(res, 200, { reply });
    } catch (err) {
        json(res, 502, { error: err.message });
    }
}

async function handleChatStream(req, res) {
    try {
        const body = await readBody(req);

        const provider = body.provider || 'ollama';
        const model = body.model || '';
        const conversationId = body.conversationId;
        const message = body.message;

        if (!conversationId) {
            json(res, 400, { error: 'conversationId is required' });
            return;
        }
        let chatImages = [];
        try {
            chatImages = sanitizeChatImages(body.images);
        } catch (err) {
            json(res, 400, { error: err.message });
            return;
        }
        // Optional generated-image references selected from the @ picker. The
        // first becomes the source for an image edit (or an I2VA first frame);
        // any others are positional references for the Qwen editor.
        const referenceImages = sanitizeReferenceImages(body.references);
        const legacyReference = sanitizeReferenceImage(body.reference || body.referenceImage);
        if (legacyReference && !referenceImages.includes(legacyReference)) {
            referenceImages.unshift(legacyReference);
            if (referenceImages.length > REFERENCE_IMAGES_MAX) referenceImages.length = REFERENCE_IMAGES_MAX;
        }
        const referenceImage = referenceImages[0] || null;
        // Character context is parsed once, here, and passed structured to every
        // media pipeline — no subsystem parses `@Maya` itself. `@Name` mentions
        // are stripped from the working message (the persisted user message keeps
        // them) so the prompt builder receives scene direction, not the token.
        const explicitCharacterIds = sanitizeCharacterIds(
            Array.isArray(body.characters) && body.characters.length ? body.characters : body.characterId
        );
        const parsedCharacters = characterContext.parseCharacterMessage(message, { explicitIds: explicitCharacterIds });
        const routingMessage = parsedCharacters.prompt && parsedCharacters.prompt.trim()
            ? parsedCharacters.prompt
            : message;
        // `@Name` / picker selection (never a bare name or a continuation). An
        // explicit invocation must be described by the character's identity
        // sheet alone — it must not inherit the Creative Playground concept or
        // the previous prompt's character description.
        const explicitCharacterReference = characterContext.hasExplicitCharacterReference(message, explicitCharacterIds);
        // Composer "Director Mode" toggle: pre-selects the Director workflow so
        // a fresh video request skips the Direct-vs-Director question.
        const forceDirector = body.forceDirector === true;
        // A card action (UGC / Director / Long Video / Playground) is a
        // self-contained turn and may carry no message text of its own.
        const hasCardAction = Boolean(body && (body.ugcAction || body.directorAction ||
            body.longVideoAction || body.playgroundAction));
        if ((!message || typeof message !== 'string' || !message.trim()) && chatImages.length === 0 && !referenceImage && !hasCardAction) {
            json(res, 400, { error: 'message is required' });
            return;
        }

        if (!conversationService.canAccessConversation(conversationId, req.jarvisSession)) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }

        // Reasoning flag for thinking-capable chat models (on by default).
        // Threaded through the router, prompt builders, and chat replies so
        // the whole turn honors one setting.
        const think = resolveChatThink(body);

        // Set up SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        // One turn at a time across every connected client. A turn that arrives
        // while another device is running waits its turn (FIFO) and is told so
        // over SSE; the slot is freed when this response ends.
        const turn = await acquireTurn(res, {
            label: 'chat',
            conversationId,
            onQueued: (position, id) => sseWrite(res, { queued: { position, turnId: id } })
        });
        if (!turn) return;

        // Deterministic "start ComfyUI" command. Handled before the router so a
        // small chat model can never downgrade it to a chat reply.
        if (comfyuiLauncher.isStartComfyRequest(message)) {
            await handleStartComfyUIChat(req, res, { conversationId, message });
            return;
        }

        // UGC Studio. A conversational workflow layer inside chat: an explicit
        // card action, a typed follow-up to the open project, or a new UGC
        // request is handled here — before the duration router and the task
        // router — so a UGC brief never becomes a normal image/video generation
        // (and a >15s UGC request is not captured by the Long Video Director).
        // Unrelated turns fall through to the gates below.
        const ugcCtx = { conversationId, message: routingMessage, provider, model, think, characters: parsedCharacters.characters };
        const requestedUgcAction = ugcStudio.normalizeAction(body.ugcAction);
        let activeUgcProject = ugcStudio.getProject(conversationId);
        if (requestedUgcAction) {
            await handleUGCAction(req, res, ugcCtx, activeUgcProject, requestedUgcAction);
            return;
        }
        if (activeUgcProject && ugcStudio.isActive(activeUgcProject)) {
            const ugcDecision = ugcStudio.classifyMessage(routingMessage, activeUgcProject);
            if (ugcDecision) {
                await handleUGCAction(req, res, ugcCtx, activeUgcProject, ugcDecision);
                return;
            }
            // A fresh explicit UGC request while a project is open restarts the
            // workflow with the new request (the previous project is replaced).
            if (ugcStudio.detectUgcIntent(routingMessage)) {
                activeUgcProject = null;
            }
        }
        // A completed project no longer intercepts ordinary chat or blocks a new
        // UGC request; the next explicit UGC request starts a fresh project.
        if (activeUgcProject && activeUgcProject.status === ugcStudio.STATUS.COMPLETED) {
            activeUgcProject = null;
        }
        // Resume a saved draft (never auto-discarded).
        if (activeUgcProject && activeUgcProject.status === ugcStudio.STATUS.DRAFT &&
            /\b(?:resume|continue|reopen)\b/i.test(routingMessage) && /\bugc\b/i.test(routingMessage)) {
            await handleUGCAction(req, res, ugcCtx, activeUgcProject, { type: UGC_ACTION.RESUME });
            return;
        }
        if (!activeUgcProject && ugcStudio.detectUgcIntent(routingMessage)) {
            await handleUGCStart(req, res, ugcCtx);
            return;
        }

        // Long Video Director (duration router). Requests longer than H3's
        // 15-second ceiling are planned before any GPU time is spent: the
        // storyboard is shown once for approval, then the installed H3
        // LongVideos node renders it and chains the beats internally. Requests
        // at or below 15 seconds never reach this branch — the existing H3
        // workflow is untouched.
        const longVideoCtx = { conversationId, message: routingMessage, provider, model, think, referenceImage, characters: parsedCharacters.characters };
        const requestedLongVideoAction = longVideoDirector.normalizeAction(body.longVideoAction);
        const activeLongPlan = longVideoDirector.getPlan(conversationId);
        if (requestedLongVideoAction) {
            if (!activeLongPlan) {
                const text = 'Long Video Director \u2014 There is no planned long video to act on.';
                sseWrite(res, { chunk: text });
                sseWrite(res, { done: true, fullReply: text });
                res.end();
                return;
            }
            await handleLongVideoAction(req, res, longVideoCtx, activeLongPlan, requestedLongVideoAction);
            return;
        }
        if (activeLongPlan && longVideoDirector.isOpen(activeLongPlan)) {
            const classified = longVideoDirector.classifyMessage(routingMessage, activeLongPlan);
            if (classified) {
                await handleLongVideoAction(req, res, longVideoCtx, activeLongPlan, classified);
                return;
            }
        }
        // A new explicit long-video request supersedes a parked storyboard. While
        // a long video is actively rendering, only cancel is honored above, and
        // a fresh request is left to the normal router (the shared generation
        // queue serializes it) so the running plan's state is never clobbered.
        const longVideoBusy = Boolean(activeLongPlan && longVideoDirector.isActive(activeLongPlan));
        // The composer Director Mode toggle wins over the duration router: a
        // >15s request with the toggle on goes to the Director, not the Long
        // Video Director. Explicit "just generate the video" and an actively
        // rendering long video are still left alone.
        const forceDirectorOverLongVideo = director.shouldForceDirectorOverLongVideo(routingMessage, {
            forceDirector,
            longVideoBusy
        });
        if (!forceDirectorOverLongVideo && !longVideoBusy && longVideoDirector.isLongVideoRequest(routingMessage)) {
            if (activeLongPlan) longVideoDirector.removePlan(conversationId);
            await handleLongVideoStart(req, res, longVideoCtx);
            return;
        }

        // Director Mode. The Director owns multi-stage productions before the
        // generic router so an approval card action or a brief change is never
        // misread as chat. Ordinary requests fall through untouched.
        const directorCtx = { conversationId, message: routingMessage, provider, model, think, referenceImage, characters: parsedCharacters.characters };
        const requestedDirectorAction = director.normalizeAction(body.directorAction);
        let activeProduction = director.getProduction(conversationId);
        if (requestedDirectorAction) {
            if (!activeProduction) {
                const text = 'Director \u2014 There is no active production to act on.';
                sseWrite(res, { chunk: text });
                sseWrite(res, { done: true, fullReply: text });
                res.end();
                return;
            }
            await handleDirectorAction(req, res, directorCtx, activeProduction, requestedDirectorAction);
            return;
        }
        if (activeProduction && director.isOpen(activeProduction)) {
            const classified = director.classifyMessage(routingMessage, activeProduction);
            if (classified) {
                await handleDirectorAction(req, res, directorCtx, activeProduction, classified);
                return;
            }
            // The message did not answer or continue the open production. A
            // stale one (a failed stage after a restart, or a card the user has
            // moved on from) must not suppress a fresh explicit director start.
            // Everything else flows to the Intent Resolver below, which decides
            // whether the turn continues, supersedes, or is unrelated chat — so
            // a parked request is never silently lost.
            if (!director.isActive(activeProduction)) {
                if (director.wantsDirectorMode(routingMessage)) {
                    director.removeProduction(conversationId);
                    // A rendering long video owns its plan; only a parked one is
                    // superseded so its approval can't capture the production.
                    if (!longVideoBusy) longVideoDirector.removePlan(conversationId);
                    await handleDirectorStart(req, res, directorCtx);
                    return;
                }
                if (director.wantsDirectMode(routingMessage)) {
                    director.removeProduction(conversationId);
                    activeProduction = null;
                }
            }
        }
        if ((!activeProduction || !director.isOpen(activeProduction)) &&
            director.wantsDirectorMode(routingMessage)) {
            if (!longVideoBusy) longVideoDirector.removePlan(conversationId);
            await handleDirectorStart(req, res, directorCtx);
            return;
        }

        // Creative Playground. Concept generation is deterministic (no LLM, no
        // GPU), so a Surprise/Again/Modify/Save/Use-as-context action or a typed
        // follow-up to an open concept is handled before any model loads. The
        // Generate action hands the concept to the existing prompt builder and
        // image pipeline below.
        const requestedPlaygroundAction = playground.normalizeAction(body.playgroundAction);
        if (requestedPlaygroundAction) {
            await handlePlaygroundAction(req, res, { conversationId, provider, model, think }, requestedPlaygroundAction, routingMessage);
            return;
        }
        const activePlayground = playground.getSession(conversationId);
        if (activePlayground && playground.isOpen(activePlayground) && !explicitCharacterReference) {
            const playgroundDecision = playground.classifyMessage(routingMessage, activePlayground);
            if (playgroundDecision) {
                await handlePlaygroundAction(req, res, { conversationId, provider, model, think }, {
                    type: playgroundDecision.action,
                    locks: playgroundDecision.locks,
                    changes: playgroundDecision.changes,
                    reroll: playgroundDecision.reroll,
                    conceptId: activePlayground.id
                }, routingMessage);
                return;
            }
        }

        // One side resident, always. Routing consults the Ollama chat model and
        // so does prompt building later in the turn, so free ComfyUI up front
        // before any of it runs. If the turn turns out to be a generation, the
        // image/video branch below unloads Ollama again before ComfyUI loads.
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        // Route the message through the context-aware task router. The router
        // decides (before any tool runs) whether this message should start a new
        // task, continue/modify the active task, answer a question about it, or
        // is just unrelated conversation. The LLM's natural-language reply never
        // decides whether a tool executes — that decision lives here.
        const decision = await taskRouter.routeMessage({
            message: routingMessage,
            provider,
            model,
            conversationId,
            hasAttachedImage: chatImages.length > 0,
            referenceImage,
            referenceImages,
            think
        });

        // Character context for this turn, now that the action is known. An
        // explicit mention/picker selection switches the active character; a
        // continuation ("make her …") inherits it; a fresh characterless
        // generation does not.
        const requestCharacters = resolveRequestCharacters(
            message,
            conversationId,
            explicitCharacterIds,
            decision.intent
        );

        // Composer "Director Mode" toggle. A fresh video request runs through
        // the Director instead of the normal H3 pipeline. Explicit "just
        // generate the video" still wins, and tweaks of an active video task
        // keep their normal pipeline. A stage that is actively rendering is
        // never clobbered.
        if (forceDirector && director.shouldForceDirector(routingMessage, decision) &&
            !(activeProduction && director.isActive(activeProduction))) {
            if (activeProduction) director.removeProduction(conversationId);
            // The toggle superseded the duration router above; drop a parked
            // long-video storyboard so a later "approve" can't capture the
            // Director production instead. A rendering long video owns its plan.
            if (!longVideoBusy) longVideoDirector.removePlan(conversationId);
            await handleDirectorStart(req, res, directorCtx);
            return;
        }

        // Upscale the last generated image in this conversation. Only the
        // deterministic "upscale" intent routes here, so the user-facing reply
        // can reference the exact before/after it produced.
        if (decision.shouldExecuteTool && decision.task === 'image_upscale') {
            await vramManager.freeVRAMBeforeImage();
            await handleImageUpscaleStream(req, res, {
                provider, model, conversationId, message
            });
            return;
        }

        // Upscale the last generated video in this conversation. Manual-only,
        // just like image upscale — the user must ask ("upscale this video").
        // There is no automatic 4K pass after generation.
        if (decision.shouldExecuteTool && decision.task === 'video_upscale') {
            await vramManager.freeVRAMBeforeImage();
            await handleVideoUpscaleStream(req, res, {
                provider, model, conversationId, message
            });
            return;
        }

        // Image edit: an attached upload or an explicit "edit this image"
        // edits a source image from a plain-language instruction while
        // preserving the rest (Qwen Image 2.1 native editor, not a from-scratch
        // regen).
        //
        // When a character is active and the user's @-picker image references
        // are present, the turn is NOT a plain edit of that image: the character
        // is the subject, so the approved character base is the edit source and
        // the user's image(s) become positional scene references. This is a
        // character-aware generation (reference-guided), never a bare edit that
        // would drop the character.
        if (decision.shouldExecuteTool && decision.task === 'image_edit') {
            const activeTask = taskState.getTask(conversationId);
            const action = (decision.intent === 'new_task' || decision.intent === 'switch_task') ? 'generate' : 'modify';
            const identity = requestCharacters.length
                ? resolveIdentityConditioning(requestCharacters, routingMessage, {
                    userReferences: referenceImages,
                    rawPrompt: message,
                    seed: creativeDefaultSeed(conversationId, routingMessage),
                    // A follow-up edit preserves the established clothing/style
                    // unless the user explicitly asks to change them.
                    continuity: action === 'modify',
                    previousClothing: activeTask.parameters && activeTask.parameters.clothing,
                    previousStyle: activeTask.parameters && activeTask.parameters.imageStyle
                })
                : null;
            if (identity) {
                debugResolvedPrompt('image_edit', identity);
                if (referenceImages.length) {
                    identity.instruction = addUserReferencesToInstruction(identity.instruction, identity);
                }
                // The instruction is the scene direction (references already
                // materialized), so the editor changes the scene around the
                // character rather than editing the referenced image's subject.
                const sceneInstruction = imageGenerator.cleanEditInstruction(
                    materializeEditInstruction(decision.updatedPrompt || routingMessage)
                );
                // The displayed/stored prompt is the clean scene request (the
                // character is implied by @Name, and the positional "image N"
                // reference wording is an editor detail); the long
                // IDENTITY/SCENE/DO NOT instruction stays internal only.
                const displayScene = sceneInstruction
                    .replace(/\bimage\s*\d+\b/gi, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim() || sceneInstruction;
                identity.instruction = identity.instruction + ' ' + sceneInstruction;
                taskState.setTask(conversationId, {
                    type: 'image',
                    operation: action,
                    prompt: displayScene,
                    lastAction: action,
                    status: 'running',
                    parameters: Object.assign({}, activeTask.parameters, {
                        characterId: requestCharacters[0] ? requestCharacters[0].id : null,
                        characterIds: requestCharacters.map((c) => c.id),
                        clothing: persistedClothing(identity),
                        imageStyle: persistedImageStyle(identity)
                    })
                });
                if (action === 'generate') {
                    taskState.setTask(conversationId, { originalPrompt: displayScene });
                }
                await vramManager.freeVRAMBeforeImage();
                await handleImageGenerationStream(req, res, {
                    provider, model, conversationId, message,
                    imagePrompt: identity.instruction,
                    displayPrompt: displayScene,
                    action,
                    previousPrompt: activeTask.prompt || null,
                    identity,
                    think
                });
                return;
            }
            const referenceSources = resolveReferenceSources(referenceImages);
            const instruction = imageGenerator.cleanEditInstruction(
                materializeEditInstruction(decision.updatedPrompt || message)
            );
            taskState.setTask(conversationId, {
                type: 'image',
                operation: 'edit',
                prompt: instruction,
                lastAction: action,
                status: 'running'
            });
            if (action === 'generate') {
                taskState.setTask(conversationId, { originalPrompt: instruction });
            }
            await vramManager.freeVRAMBeforeImage();
            await handleImageEditStream(req, res, {
                provider, model, conversationId, message,
                instruction,
                action,
                previousPrompt: activeTask.prompt || null,
                sourceOverride: referenceSources[0] || undefined,
                referenceSources,
                think
            });
            return;
        }

        if (decision.shouldExecuteTool && decision.task === 'image_generation') {
            const activeTask = taskState.getTask(conversationId);
            const isNew = decision.intent === 'new_task' || decision.intent === 'switch_task';
            // Regenerate insight: "generate the image again" re-runs the SAME
            // prompt (new seed); "... again but <change>" edits with ONLY the
            // change as the delta so "again" never leaks into the prompt.
            const regenInfo = typeof taskRouter.parseRegenerateRequest === 'function'
                ? taskRouter.parseRegenerateRequest(message, activeTask.type)
                : null;
            const isBareRegen = !isNew && regenInfo && regenInfo.bare && !regenInfo.crossModal && activeTask.prompt;
            const modifyDelta = !isNew
                ? (String(decision.updatedPrompt || '').trim() || (regenInfo && regenInfo.delta) || message)
                : message;

            // Follow-up tweaks of the active image task always run as a full
            // regen of the rewritten prompt (see below). Edits only run through
            // the explicit image_edit branch above — i.e. when the user attaches
            // an upload or explicitly asks to "edit this image". Vague
            // follow-ups ("make her ...", "change her top ...") must not
            // trigger an edit of the pixels.

            // Determine the effective prompt for this generation run.
            let imagePrompt;
            let structuredRequest;
            let attributes;
            let enhanced;

            if (isNew && decision.structuredRequest) {
                // Brand-new task detected through the intent pipeline.
                structuredRequest = decision.structuredRequest;
                // A new image requested while a video task is active must not
                // inherit the H3 video prompt as its style context — rebase
                // onto the conversation's image lineage instead.
                if (activeTask.type === 'video') {
                    const lineagePrompt = (activeTask.lastImage && activeTask.lastImage.prompt) ||
                        (findLastImagePromptInHistory(conversationId) || {}).prompt || '';
                    if (lineagePrompt) structuredRequest.previous_prompt = lineagePrompt;
                } else if (activeTask.type === 'image' && !structuredRequest.previous_prompt) {
                    // Same-task follow-up: pass the current prompt as style
                    // context (the builder ignores it for new subjects).
                    structuredRequest.previous_prompt = activeTask.prompt || '';
                }
                // An explicitly invoked character is described by its identity
                // sheet, never by the previous prompt's/playground's character
                // description.
                if (explicitCharacterReference) structuredRequest.previous_prompt = '';
                // "generate me another image" carries no subject of its own:
                // resolve the anaphora to the lineage concept (same style,
                // fresh subject) instead of sending the literal "an image"
                // to the prompt builder, which would invent an unrelated one.
                if (imageGenerator.isVagueImageConcept(structuredRequest.user_prompt) &&
                    /\b(?:another|one more|one-more|new one)\b/i.test(message)) {
                    const lineage = resolveAnotherImageConcept(conversationId, activeTask);
                    if (lineage) {
                        structuredRequest.user_prompt = lineage.userPrompt;
                        structuredRequest.previous_prompt = lineage.previousPrompt;
                        if (!structuredRequest.creative_mode || structuredRequest.creative_mode === 'none') {
                            structuredRequest.creative_mode = lineage.creativeMode;
                        }
                        if ((!structuredRequest.explicit_constraints || !structuredRequest.explicit_constraints.length) && lineage.explicitConstraints.length) {
                            structuredRequest.explicit_constraints = lineage.explicitConstraints;
                        }
                    }
                }
                enhanced = await imageGenerator.buildImagePrompt(structuredRequest, providers, provider, model, think);
            } else if (isNew && decision.updatedPrompt) {
                // Brand-new / switched task reported by the router. Pass the
                // active task's prompt as context so a tweak the router treats
                // as a new task can still continue the same subject.
                structuredRequest = {
                    intent: 'image_generation',
                    user_prompt: decision.updatedPrompt,
                    previous_prompt: activeTask.type === 'video'
                        ? ((activeTask.lastImage && activeTask.lastImage.prompt) ||
                            (findLastImagePromptInHistory(conversationId) || {}).prompt || '')
                        : (activeTask.prompt || ''),
                    creative_mode: 'none',
                    explicit_constraints: []
                };
                // An explicitly invoked character is described by its identity
                // sheet, never by the previous prompt's character context.
                if (explicitCharacterReference) structuredRequest.previous_prompt = '';
                enhanced = await imageGenerator.buildImagePrompt(structuredRequest, providers, provider, model, think);
            } else if (isBareRegen) {
                // Bare "generate the image again": reuse the stored full
                // prompt verbatim (new random seed at generation time gives
                // the fresh variation). No LLM rewrite — rewriting would
                // append "again" into the prompt or drift the subject.
                imagePrompt = activeTask.prompt;
                attributes = (activeTask.parameters && activeTask.parameters.attributes) || null;
                structuredRequest = {
                    intent: 'image_generation',
                    user_prompt: imagePrompt,
                    previous_prompt: activeTask.prompt || '',
                    creative_mode: (activeTask.parameters && activeTask.parameters.creative_mode) || 'none',
                    explicit_constraints: (activeTask.parameters && activeTask.parameters.explicit_constraints) || []
                };
                enhanced = null;
            } else {
                // Continue / modify the active task. The stored full prompt is
                // the source of truth. The dedicated prompt editor rewrites it
                // into a new full prompt (plain-text editing survives smaller
                // local chat models that struggle with structured JSON rewrites),
                // then the enhancer refreshes the attribute breakdown using the
                // previous prompt as context so untouched details are preserved.
                // modifyDelta is the stripped change ("make her ..."), never
                // the "generate ... again" preamble.
                const rewrittenPrompt = await taskRouter.applyPromptModification(
                    activeTask.prompt || '',
                    modifyDelta,
                    provider,
                    model,
                    think
                );
                structuredRequest = {
                    intent: 'image_generation',
                    user_prompt: rewrittenPrompt,
                    previous_prompt: activeTask.prompt || '',
                    creative_mode: (activeTask.parameters && activeTask.parameters.creative_mode) || 'none',
                    explicit_constraints: (activeTask.parameters && activeTask.parameters.explicit_constraints) || []
                };
                enhanced = await imageGenerator.buildImagePrompt(structuredRequest, providers, provider, model, think);
            }

            imagePrompt = enhanced ? enhanced.prompt : imagePrompt;
            attributes = enhanced ? enhanced.attributes : attributes;

            // Bare regenerate re-runs the same prompt — report it as a fresh
            // generation (new seed variation), not a modification.
            const action = (isNew || isBareRegen) ? 'generate' : 'modify';

            // A named / mentioned / active character conditions the generation
            // through its approved identity package (reference-guided edit, not
            // a text-only "same character" hint). Any @-picker image references
            // the user supplied ride along as positional scene references so a
            // character + image request conditions on both. Characterless
            // requests leave the pipeline completely untouched.
            const identity = resolveIdentityConditioning(requestCharacters, imagePrompt, {
                userReferences: referenceImages,
                rawPrompt: message,
                // A per-turn seed keeps the automatic clothing/style stable
                // across the prompt build while still varying between requests.
                seed: creativeDefaultSeed(conversationId, imagePrompt),
                // A follow-up tweak preserves the established clothing/style
                // unless the user explicitly asks to change them. A fresh
                // standalone image generates new defaults.
                continuity: action === 'modify',
                previousClothing: activeTask.parameters && activeTask.parameters.clothing,
                previousStyle: activeTask.parameters && activeTask.parameters.imageStyle
            });
            if (identity && referenceImages.length) {
                identity.instruction = addUserReferencesToInstruction(identity.instruction, identity);
            }
            debugResolvedPrompt('image_generation', identity);

            // Track the task as running, then free VRAM and execute.
            const ctxPreviousPrompt = activeTask.prompt || null;
            taskState.setTask(conversationId, {
                type: 'image',
                operation: action,
                prompt: imagePrompt,
                lastAction: action,
                status: 'running'
            });
            // The resolved automatic clothing/style are persisted so the next
            // follow-up preserves them instead of re-rolling the outfit.
            const resolvedClothing = persistedClothing(identity);
            const resolvedStyle = persistedImageStyle(identity);
            if (action === 'generate') {
                taskState.setTask(conversationId, {
                    originalPrompt: structuredRequest ? structuredRequest.user_prompt : message,
                    parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
                        creative_mode: structuredRequest ? structuredRequest.creative_mode : 'none',
                        explicit_constraints: structuredRequest ? structuredRequest.explicit_constraints : [],
                        attributes: attributes || null,
                        characterId: requestCharacters[0] ? requestCharacters[0].id : null,
                        characterIds: requestCharacters.map((c) => c.id),
                        clothing: resolvedClothing,
                        imageStyle: resolvedStyle
                    })
                });
            } else if (attributes || resolvedClothing || resolvedStyle) {
                const patch = {};
                if (attributes) patch.attributes = attributes;
                if (resolvedClothing) patch.clothing = resolvedClothing;
                if (resolvedStyle) patch.imageStyle = resolvedStyle;
                taskState.setTask(conversationId, {
                    parameters: Object.assign({}, taskState.getTask(conversationId).parameters, patch)
                });
            }

            await vramManager.freeVRAMBeforeImage();
            await handleImageGenerationStream(req, res, {
                provider, model, conversationId, message,
                imagePrompt,
                action,
                previousPrompt: ctxPreviousPrompt,
                identity,
                think
            });
            return;
        }

        // Video generation via MiniMax H3. Follows the same pattern as image
        // generation but routes through the video pipeline and emits a 'video'
        // SSE event instead of 'image'.
        if (decision.shouldExecuteTool && decision.task === 'video_generation') {
            const activeTask = taskState.getTask(conversationId);
            const isNew = decision.intent === 'new_task' || decision.intent === 'switch_task';
            // Same regenerate insight as images: bare "again" reuses the
            // stored H3 prompt verbatim; "... again but <change>" rewrites it
            // from the stripped delta with the I2VA source image in context.
            const videoRegenInfo = typeof taskRouter.parseRegenerateRequest === 'function'
                ? taskRouter.parseRegenerateRequest(message, activeTask.type)
                : null;
            const isVideoBareRegen = !isNew && videoRegenInfo && videoRegenInfo.bare && !videoRegenInfo.crossModal && activeTask.prompt;
            const videoModifier = !isNew
                ? (String(decision.updatedPrompt || '').trim() || (videoRegenInfo && videoRegenInfo.delta) || message)
                : message;

            let videoPrompt;
            let structuredRequest;
            let parameters;
            let videoMode;
            let sourceImageRawFilename;
            let directorDimensions;

            if (isNew && decision.structuredRequest) {
                structuredRequest = decision.structuredRequest;
                // Deterministic duration parse wins when the classifier dropped it.
                if ((structuredRequest.requested_duration === undefined || structuredRequest.requested_duration === null) &&
                    typeof videoGenerator.parseRequestedVideoDuration === 'function') {
                    structuredRequest.requested_duration = videoGenerator.parseRequestedVideoDuration(message);
                }
                const defaults = videoGenerator.getVideoDefaults();
                parameters = Object.assign({}, defaults, structuredRequest.parameters || {});
            } else if (isNew && decision.updatedPrompt) {
                structuredRequest = {
                    action: 'generate',
                    user_prompt: decision.updatedPrompt,
                    previous_prompt: activeTask.prompt || '',
                    creative_mode: 'none',
                    has_reference_image: false,
                    requested_duration: typeof videoGenerator.parseRequestedVideoDuration === 'function'
                        ? videoGenerator.parseRequestedVideoDuration(message)
                        : null,
                    explicit_constraints: [],
                    parameters: {}
                };
                const defaults = videoGenerator.getVideoDefaults();
                parameters = Object.assign({}, defaults, structuredRequest.parameters || {});
            } else {
                // Continue / modify: pass the user's modification instruction
                // as a modifier prompt; the video director handles the rewrite.
                // Uses the stripped delta so "generate ... again" never leaks
                // into the H3 prompt.
                structuredRequest = {
                    action: 'modify',
                    modifier: videoModifier,
                    previous_prompt: activeTask.prompt || '',
                    parameters: activeTask.parameters || {}
                };
                parameters = structuredRequest.parameters;
            }

            const action = (isNew || isVideoBareRegen) ? 'generate' : 'modify';

            if (action === 'generate') {
                // Decide I2VA vs T2VA BEFORE the H3 workflow is selected. I2VA
                // requires BOTH image-referencing wording AND a resolvable image;
                // otherwise the request is plain T2VA. The mode decision is based
                // on the previously resolved generated image (never a re-upload).
                const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, structuredRequest, referenceImage);
                videoMode = modeInfo.videoMode;
                sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;

                console.log('[video] source image:', sourceImageRawFilename);
                console.log('[video] mode:', videoMode);
                console.log('[video] user request:', message);

                // Always run the H3 Video Director LLM so the text sent to H3 is
                // a real H3-compliant I2VA/T2VA prompt (with the <Picture 1>
                // first-frame alignment for I2VA), never the raw user request or
                // the original image prompt.
                // An explicit per-request length ("in 10 seconds") wins over the
                // configured default; otherwise the setting applies (max 15s).
                const messageDuration = typeof videoGenerator.parseRequestedVideoDuration === 'function'
                    ? videoGenerator.parseRequestedVideoDuration(message)
                    : null;
                if (messageDuration !== null && messageDuration !== undefined) {
                    structuredRequest.requested_duration = messageDuration;
                }
                const director = await videoGenerator.buildH3VideoPrompt(
                    Object.assign({}, structuredRequest, {
                        has_reference_image: videoMode === 'i2va'
                    }),
                    providers,
                    provider,
                    model,
                    sourceImageRawFilename,
                    conversationId,
                    think
                );
                videoPrompt = director.prompt;
                directorDimensions = { duration: director.duration, width: director.width, height: director.height };

                console.log('[video] H3 director prompt generated:', videoPrompt);
            } else if (isVideoBareRegen) {
                // Bare "generate the video again": reuse the stored H3 prompt
                // verbatim with the same I2VA source image (new seed at
                // generation time gives the fresh variation). No LLM rewrite.
                // Keeps the previous duration unless the message names a new one.
                videoMode = activeTask.videoMode ||
                    (activeTask.parameters && activeTask.parameters.videoMode) || 't2va';
                sourceImageRawFilename = activeTask.sourceImage ||
                    (activeTask.parameters && activeTask.parameters.sourceImage) || null;
                videoPrompt = activeTask.prompt;
                const regenDuration = typeof videoGenerator.parseRequestedVideoDuration === 'function'
                    ? videoGenerator.parseRequestedVideoDuration(message)
                    : null;
                const prevDuration = activeTask.parameters && activeTask.parameters.duration;
                directorDimensions = {
                    duration: (regenDuration !== null && regenDuration !== undefined)
                        ? regenDuration
                        : (Number.isFinite(Number(prevDuration)) ? Number(prevDuration) : undefined),
                    width: activeTask.parameters && activeTask.parameters.width,
                    height: activeTask.parameters && activeTask.parameters.height
                };
            } else {
                // Continue / modify the active video task. Preserve the I2VA
                // source image and let the H3 prompt modifier rewrite the whole
                // H3 prompt from the stored one (never the raw modifier text).
                // videoModifier is the stripped change, and the last generated
                // image travels along so the LLM edits with eyes on the frame.
                // A duration named in the modification ("make it 10 seconds")
                // applies; otherwise the previous duration is kept.
                videoMode = activeTask.videoMode ||
                    (activeTask.parameters && activeTask.parameters.videoMode) || 't2va';
                sourceImageRawFilename = activeTask.sourceImage ||
                    (activeTask.parameters && activeTask.parameters.sourceImage) || null;
                videoPrompt = await videoGenerator.modifyH3VideoPrompt(
                    activeTask.prompt || '',
                    videoModifier,
                    providers,
                    provider,
                    model,
                    { sourceImageRawFilename, think }
                );
                const modifyDuration = typeof videoGenerator.parseRequestedVideoDuration === 'function'
                    ? videoGenerator.parseRequestedVideoDuration(message)
                    : null;
                const prevDuration = activeTask.parameters && activeTask.parameters.duration;
                directorDimensions = {
                    duration: (modifyDuration !== null && modifyDuration !== undefined)
                        ? modifyDuration
                        : (Number.isFinite(Number(prevDuration)) ? Number(prevDuration) : undefined),
                    width: activeTask.parameters && activeTask.parameters.width,
                    height: activeTask.parameters && activeTask.parameters.height
                };
            }

            // A character (mentioned, picked, or inherited by a continuation)
            // conditions the H3 render on its approved identity references
            // (reference-to-video) so identity persists across the clip. A
            // user-provided starting frame is never replaced: when the request
            // already has an I2VA source, that frame stays the first frame and
            // identity is not forced into ref2va.
            let identityReferences;
            if (requestCharacters.length && videoMode !== 'i2va') {
                // User @-picker references are kept alongside the character
                // portraits so a character + image request conditions on both.
                const conditioning = resolveIdentityConditioning(requestCharacters, message, {
                    userReferences: referenceImages,
                    // Video only consumes the identity references; the prompt's
                    // creative-defaults section is never used.
                    defaults: false
                });
                if (conditioning) {
                    identityReferences = conditioning.references.map((p) => path.basename(p));
                    const baseName = path.basename(conditioning.sourceAbs);
                    if (baseName && !identityReferences.includes(baseName)) identityReferences.unshift(baseName);
                    identityReferences = identityReferences.slice(0, 9);
                }
            }

            // Set ActiveTask to running, then free VRAM for ComfyUI.
            const ctxPreviousPrompt = activeTask.prompt || null;
            taskState.setTask(conversationId, {
                type: 'video',
                operation: action,
                prompt: videoPrompt,
                videoMode,
                sourceImage: sourceImageRawFilename,
                lastAction: message || action,
                status: 'running'
            });
            if (action === 'generate') {
                taskState.setTask(conversationId, {
                    originalPrompt: videoPrompt,
                    parameters: Object.assign({}, taskState.getTask(conversationId).parameters, parameters, {
                        videoMode,
                        sourceImage: sourceImageRawFilename,
                        characterId: requestCharacters[0] ? requestCharacters[0].id : null,
                        characterIds: requestCharacters.map((c) => c.id),
                        duration: directorDimensions ? directorDimensions.duration : undefined,
                        width: directorDimensions ? directorDimensions.width : undefined,
                        height: directorDimensions ? directorDimensions.height : undefined
                    })
                });
            } else if (directorDimensions && directorDimensions.duration !== undefined) {
                // Modify runs keep the stored prompt lineage but adopt a newly
                // named duration so follow-up regens inherit it.
                taskState.setTask(conversationId, {
                    parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
                        duration: directorDimensions.duration
                    })
                });
            }

            await vramManager.freeVRAMBeforeImage();
            await handleVideoGenerationStream(req, res, {
                provider, model, conversationId, message,
                videoPrompt,
                structuredRequest,
                action,
                previousPrompt: ctxPreviousPrompt,
                videoMode,
                sourceImageRawFilename,
                // Reference-to-video: the character's approved identity frames
                // condition every shot (identity continuity across the clip).
                referenceImages: identityReferences && identityReferences.length
                    ? identityReferences
                    : undefined,
                duration: directorDimensions ? directorDimensions.duration : undefined,
                width: directorDimensions ? directorDimensions.width : undefined,
                height: directorDimensions ? directorDimensions.height : undefined,
                think
            });
            return;
        }

        // Chat response — remember this chat model, then free VRAM by unloading
        // ComfyUI's models if the GPU is nearly full.
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        // The active task stays alive across chat/question turns so the user can
        // resume it later. It is only cleared when the user explicitly starts a
        // different, non-tool task (new_task/switch_task that is not a
        // generation), which replaces the active task.
        if ((decision.intent === 'new_task' || decision.intent === 'switch_task') && !decision.shouldExecuteTool) {
            taskState.clearTask(conversationId);
        }

        // A referenced generated image is exposed to the chat model as vision
        // so questions about it ("what do you think of this?") are answered
        // with the actual pixels in view.
        const chatVision = chatImages.concat(referenceVisionImages(referenceImages)).slice(0, CHAT_IMAGES_MAX);

        const contextMessages = contextBuilder.buildContext(
            conversationId,
            message,
            provider,
            model,
            // Always expose the active task to the chat model (not only for
            // task_question) so it understands what the conversation is working
            // on and can resolve pronouns/follow-ups. renderActiveTaskContext
            // returns '' when there is no active task.
            taskRouter.renderActiveTaskContext(taskState.getTask(conversationId)),
            chatVision,
            await buildEnvironmentContext(message)
        );

        let fullReply = '';
        const sampling = resolveChatSampling(body);

        // Prompt meta-requests (write / brainstorm a prompt) render the suggested
        // prompt in a fenced code block. Mark the reply so the UI can offer quick
        // "Generate Image / Generate Video" actions beneath that block. The
        // marker is UI state and is stripped before the message reaches the
        // model again.
        const resolvedIntentName = decision && decision.resolvedIntent
            ? decision.resolvedIntent.intent
            : null;
        const isPromptSuggestion = resolvedIntentName === 'prompt_writing' ||
            resolvedIntentName === 'prompt_ideation';

        try {
            for await (const chunk of providers.chatStream(provider, contextMessages, model, { think, ...sampling })) {
                if (chunk.type === 'content') {
                    fullReply += chunk.text;
                    res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
                } else if (chunk.type === 'stats') {
                    res.write(`data: ${JSON.stringify({ stats: chunk })}\n\n`);
                }
            }

            // Defense-in-depth: the chat model sometimes hallucinates a
            // tool-call JSON blob ({"action": "image_generation", ...})
            // instead of natural language when a follow-up tweak slipped
            // through to chat. Never leak that JSON to the user — execute
            // the intended image modification for real. The frontend
            // replaces the streamed chunks when the image event arrives,
            // so the final saved message is the generated image, not JSON.
            const leakedPrompt = extractLeakedImagePrompt(fullReply);
            if (leakedPrompt !== null) {
                const leakTask = taskState.getTask(conversationId);
                if (leakTask && leakTask.type === 'image' && leakTask.prompt) {
                    console.warn('[chat] Hallucinated tool-call JSON detected; executing as image modify.');
                    const basePrompt = leakedPrompt || message;
                    const leakParams = leakTask.parameters || {};
                    let imagePrompt = basePrompt;
                    let attributes = leakParams.attributes || null;
                    try {
                        const structuredRequest = {
                            intent: 'image_generation',
                            user_prompt: basePrompt,
                            previous_prompt: leakTask.prompt || '',
                            creative_mode: leakParams.creative_mode || 'none',
                            explicit_constraints: leakParams.explicit_constraints || []
                        };
                        const enhanced = await imageGenerator.buildImagePrompt(
                            structuredRequest, providers, provider, model, think
                        );
                        if (enhanced && enhanced.prompt) {
                            imagePrompt = enhanced.prompt;
                            attributes = enhanced.attributes;
                        }
                    } catch (err) {
                        console.warn('[chat] Leak recovery prompt build failed, using raw prompt:', err.message);
                    }
                    const ctxPreviousPrompt = leakTask.prompt || null;
                    taskState.setTask(conversationId, {
                        type: 'image',
                        operation: 'modify',
                        prompt: imagePrompt,
                        lastAction: 'modify',
                        status: 'running'
                    });
                    if (attributes) {
                        taskState.setTask(conversationId, {
                            parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
                                attributes
                            })
                        });
                    }
                    await vramManager.freeVRAMBeforeImage();
                    await handleImageGenerationStream(req, res, {
                        provider, model, conversationId, message,
                        imagePrompt,
                        action: 'modify',
                        previousPrompt: ctxPreviousPrompt,
                        think
                    });
                    return;
                }
            }

            // Send completion event with full reply for saving
            if (isPromptSuggestion && fullReply && /```/.test(fullReply)) {
                fullReply = fullReply.replace(/\s+$/, '') + '\n\n[[prompt-suggestion]]';
            }
            res.write(`data: ${JSON.stringify({ done: true, fullReply })}\n\n`);
        } catch (streamErr) {
            res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
        }

        res.end();
    } catch (err) {
        // If headers not sent yet, send error response
        if (!res.headersSent) {
            json(res, 502, { error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
}

// --- UGC Studio --------------------------------------------------------------
//
// A conversational workflow layer inside chat: brief -> product -> creator ->
// outfit -> environment -> script -> scenes -> reference frames -> Director Mode.
// The studio owns the stage machine; image and video execution reuse the
// existing pipelines and Director Mode.

const UGC_STAGE = ugcStudio.STAGES;
const UGC_ACTION = ugcStudio.ACTIONS;

// Stream the persisted UGC card and end the turn.
function emitUGCCard(res, project) {
    sseWrite(res, {
        ugc: {
            content: ugcStudio.renderContent(project),
            card: ugcStudio.buildCard(project),
            status: project.status,
            stage: project.stage
        }
    });
    res.end();
}

function ugcRawFilename(url) {
    let name = String(url || '').split('?')[0].split('/').pop();
    try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
    return name;
}

// Start a fresh UGC project from a natural-language request.
async function handleUGCStart(req, res, ctx) {
    const { conversationId, message, provider, model, think } = ctx;
    sseWrite(res, { generating: 'UGC Studio \u2014 building your brief\u2026' });
    try {
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();
        let project = await ugcStudio.createProject({ conversationId, message, provider, model, think });
        // A character mentioned in the brief (`@Maya`) becomes the UGC creator
        // through the same Character Identity Package the image/video pipelines
        // use — never a separate UGC character system.
        const mentioned = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (mentioned.length) {
            project = ugcStudio.selectCreator(project, mentioned[0].id) || project;
            characterContext.setActiveCharacter(conversationId, [{ id: mentioned[0].id, name: mentioned[0].name }]);
        }
        activityLog.record({
            type: 'generation',
            title: 'UGC project started',
            detail: (project.product && project.product.name) || message,
            conversationId
        });
        emitUGCCard(res, project);
    } catch (err) {
        console.error('[ugc] start failed:', err.message);
        sseWrite(res, { error: 'UGC Studio could not start this project: ' + err.message });
        res.end();
    }
}

// Execute a UGC workflow action (card button or a typed decision). The server —
// never the UI — enforces workflow order: every action is validated against the
// project's stage, a stale card is rejected by version, and overlapping actions
// for the same conversation are serialized.
const ugcActionLocks = new Set();

async function handleUGCAction(req, res, ctx, project, action) {
    const { conversationId, message, provider, model, think } = ctx;
    if (!project) {
        sseWrite(res, { error: 'UGC Studio \u2014 There is no active project. Describe the UGC content you want to create.' });
        res.end();
        return;
    }
    if (action.projectId && action.projectId !== project.id) {
        const text = 'UGC Studio \u2014 That card belongs to an earlier project. Use the newest UGC card.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }
    // A stale card (from an older project version) must not mutate the current
    // project. Typed decisions carry no version and are always evaluated against
    // the live project.
    if (ugcStudio.isStaleAction(project, action)) {
        const text = 'UGC Studio \u2014 That card is out of date. Use the latest UGC card.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }
    // A typed follow-up classified by studio.classifyMessage returns
    // { action: '...' }; map it onto the button action space so the same switch
    // executes it. 'edit' is the only classified result with no button twin.
    if (!action.type && action.action && Object.values(UGC_ACTION).includes(action.action)) {
        action = Object.assign({}, action, { type: action.action });
    }

    if (ugcActionLocks.has(conversationId)) {
        sseWrite(res, { error: 'UGC Studio \u2014 Another action is still running. Try again in a moment.' });
        res.end();
        return;
    }
    // Validate the action against the live stage before any work runs.
    const validation = ugcStudio.validateAction(project, action.type);
    if (!validation.ok) {
        sseWrite(res, { error: 'UGC Studio \u2014 ' + validation.error });
        res.end();
        return;
    }
    ugcActionLocks.add(conversationId);
    try {
        await dispatchUGCAction(req, res, ctx, project, action);
    } finally {
        ugcActionLocks.delete(conversationId);
    }
}

async function dispatchUGCAction(req, res, ctx, project, action) {
    const { conversationId, message, provider, model, think } = ctx;
    try {
        // --- selection stages ---
        if (action.type === UGC_ACTION.SELECT_PRODUCT) {
            if (action.productId) {
                ugcStudio.selectProduct(project, action.productId);
            } else {
                // No product named: this is the "Select product" navigation cue.
                project.stage = UGC_STAGE.PRODUCT_SELECTION;
                ugcStudio.save(project);
            }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.CREATE_PRODUCT) {
            ugcStudio.createProduct(project, action.product || {});
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.DELETE_PRODUCT) {
            const removed = ugcStudio.deleteProduct(project, action.productId);
            if (!removed.ok) {
                sseWrite(res, { error: 'UGC Studio \u2014 ' + removed.error });
                res.end();
                return;
            }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.SELECT_CREATOR) {
            if (action.characterId) ugcStudio.selectCreator(project, action.characterId);
            else { project.stage = UGC_STAGE.CREATOR_SELECTION; ugcStudio.save(project); }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.CREATE_CREATOR) {
            const preset = characterPresets.create(action.creator || {});
            ugcStudio.selectCreator(project, preset.id);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.RANDOM_CREATOR) {
            ugcStudio.randomCreator(project, action.creator && action.creator.profile);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.SKIP_CREATOR) {
            ugcStudio.skipCreator(project);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.SELECT_OUTFIT) {
            if (action.outfitPack) ugcStudio.selectOutfit(project, action.outfitPack, action.outfitPackCustom);
            else { project.stage = UGC_STAGE.CREATIVE_DIRECTION; ugcStudio.save(project); }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.SELECT_ENVIRONMENT) {
            if (action.environmentId) ugcStudio.selectEnvironment(project, action.environmentId, action.direction || action.value || '');
            else { project.stage = UGC_STAGE.CREATIVE_DIRECTION; ugcStudio.save(project); }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.SELECT_CONTENT_TYPE) {
            if (action.contentTypeId) ugcStudio.selectContentType(project, action.contentTypeId);
            else { project.stage = UGC_STAGE.CREATIVE_DIRECTION; ugcStudio.save(project); }
            emitUGCCard(res, project);
            return;
        }

        // --- brief ---
        if (action.type === UGC_ACTION.EDIT_BRIEF) {
            const result = ugcStudio.editBrief(project, action.brief || {});
            if (result && result.durationInvalid) {
                sseWrite(res, { error: 'UGC Studio \u2014 Duration must be between 1 and ' + ugcStudio.DURATION_LIMITS.max + ' seconds.' });
                res.end();
                return;
            }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.REGENERATE_BRIEF) {
            sseWrite(res, { generating: 'UGC Studio \u2014 regenerating the brief\u2026' });
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await ugcStudio.regenerateBrief(project, { provider, model, think });
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.APPROVE_BRIEF) {
            const nextStage = ugcStudio.nextSetupStage(project);
            if (nextStage !== UGC_STAGE.BRIEF) {
                project.stage = nextStage;
                ugcStudio.save(project);
                emitUGCCard(res, project);
                return;
            }
            sseWrite(res, { generating: 'UGC Studio \u2014 writing the script\u2026' });
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await ugcStudio.generateScript(project, { provider, model, think });
            emitUGCCard(res, project);
            return;
        }

        // --- script ---
        if (action.type === UGC_ACTION.EDIT_SCRIPT) {
            if (action.script && typeof action.script === 'object') {
                for (const key of Object.keys(action.script)) {
                    if (['hook', 'main', 'productInteraction', 'closing'].includes(key)) {
                        ugcStudio.editScriptField(project, key, action.script[key]);
                    }
                }
            } else {
                ugcStudio.editScriptField(project, action.field, action.value);
            }
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.REGENERATE_SCRIPT ||
            action.type === UGC_ACTION.CHANGE_TONE || action.type === UGC_ACTION.CHANGE_HOOK) {
            const isTone = action.type === UGC_ACTION.CHANGE_TONE;
            const isHook = action.type === UGC_ACTION.CHANGE_HOOK;
            const feedback = String(action.direction || action.value || '').trim();
            const field = isHook ? 'hook' : null;
            const note = feedback
                || (isTone ? 'Change the overall tone.' : (isHook ? 'Rewrite the hook.' : ''));
            sseWrite(res, { generating: 'UGC Studio \u2014 rewriting the script\u2026' });
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await ugcStudio.generateScript(project, { provider, model, think, feedback: note, field });
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.APPROVE_SCRIPT) {
            ugcStudio.approveScript(project);
            sseWrite(res, { generating: 'UGC Studio \u2014 planning the scenes\u2026' });
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await ugcStudio.generateScenes(project, { provider, model, think });
            emitUGCCard(res, project);
            return;
        }

        // --- scenes ---
        if (action.type === UGC_ACTION.EDIT_SCENE) {
            ugcStudio.editScene(project, action.sceneId, action.scene || {});
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.ADD_SCENE) {
            ugcStudio.addScene(project, action.sceneId);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.DELETE_SCENE) {
            ugcStudio.deleteScene(project, action.sceneId);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.MOVE_SCENE) {
            ugcStudio.moveScene(project, action.sceneId, action.moveDirection || 'down');
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.REGENERATE_SCENE) {
            let sceneId = action.sceneId || null;
            if (!sceneId && action.sceneNumber) {
                const scene = (project.scenes || []).find((s) => s.order === Number(action.sceneNumber));
                sceneId = scene ? scene.id : null;
            }
            const scene = (project.scenes || []).find((s) => s.id === sceneId);
            if (!scene) {
                sseWrite(res, { error: 'UGC Studio \u2014 That scene no longer exists.' });
                res.end();
                return;
            }
            sseWrite(res, { generating: 'UGC Studio \u2014 regenerating scene ' + scene.order + '\u2026' });
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await ugcStudio.regenerateScene(project, sceneId, {
                provider, model, think,
                direction: action.direction || action.message || ''
            });
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.APPROVE_SCENES) {
            ugcStudio.approveScenes(project);
            await handleUGCGenerateReferences(req, res, ctx, project, null);
            return;
        }

        // --- references ---
        if (action.type === UGC_ACTION.GENERATE_REFERENCES || action.type === UGC_ACTION.REGENERATE_REFERENCES) {
            await handleUGCGenerateReferences(req, res, ctx, project, null, { fresh: true });
            return;
        }
        if (action.type === UGC_ACTION.REGENERATE_REFERENCE) {
            let sceneId = action.sceneId || null;
            if (!sceneId && action.sceneNumber) {
                const scene = (project.scenes || []).find((s) => s.order === Number(action.sceneNumber));
                sceneId = scene ? scene.id : null;
            }
            await handleUGCGenerateReferences(req, res, ctx, project, sceneId ? [sceneId] : null);
            return;
        }
        if (action.type === UGC_ACTION.RETRY_FAILED) {
            const pending = ugcStudio.pendingReferenceSceneIds(project);
            if (!pending.length) {
                sseWrite(res, { error: 'UGC Studio \u2014 Every scene already has a current reference frame.' });
                res.end();
                return;
            }
            await handleUGCGenerateReferences(req, res, ctx, project, pending);
            return;
        }
        if (action.type === UGC_ACTION.EDIT_DIRECTION) {
            const direction = String(action.direction || action.message || '').trim();
            if (!direction) {
                sseWrite(res, { error: 'Tell me how the direction should change.' });
                res.end();
                return;
            }
            await ugcStudio.applyNaturalEdit(project, direction, { provider, model, think });
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.CONFIRM_DURATION) {
            ugcStudio.confirmDuration(project);
            const approval = ugcStudio.approveReferences(project);
            if (!approval.ok) {
                sseWrite(res, { error: 'UGC Studio \u2014 ' + approval.error });
                res.end();
                return;
            }
            await handleUGCDirectorHandoff(req, res, ctx, project);
            return;
        }
        if (action.type === UGC_ACTION.APPROVE_REFERENCES || action.type === UGC_ACTION.CONTINUE_DIRECTOR) {
            const approval = ugcStudio.approveReferences(project);
            if (!approval.ok) {
                sseWrite(res, { error: 'UGC Studio \u2014 ' + approval.error });
                res.end();
                return;
            }
            await handleUGCDirectorHandoff(req, res, ctx, project);
            return;
        }

        // --- natural-language typed decisions ---
        if (action.action === 'edit') {
            await ugcStudio.applyNaturalEdit(project, action.message || message, { provider, model, think });
            emitUGCCard(res, project);
            return;
        }

        // --- lifecycle ---
        if (action.type === UGC_ACTION.SAVE_DRAFT || action.type === UGC_ACTION.EXIT) {
            ugcStudio.exitProject(project);
            const text = 'UGC Studio \u2014 project saved as a draft. Say "resume the UGC project" or use the UGC Studio bar to continue.';
            sseWrite(res, { chunk: text });
            sseWrite(res, { done: true, fullReply: text });
            res.end();
            return;
        }
        if (action.type === UGC_ACTION.RESUME) {
            ugcStudio.resumeProject(project);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.VIEW_BRIEF) {
            project.stage = project.script ? (project.scenes && project.scenes.length ? UGC_STAGE.SCENE_REVIEW : UGC_STAGE.SCRIPT_REVIEW) : UGC_STAGE.BRIEF;
            if (project.references && project.references.length) project.stage = UGC_STAGE.REFERENCE_APPROVAL;
            ugcStudio.save(project);
            emitUGCCard(res, project);
            return;
        }
        if (action.type === UGC_ACTION.DISCARD) {
            ugcStudio.removeProject(conversationId);
            const text = 'UGC Studio \u2014 project discarded.';
            sseWrite(res, { chunk: text });
            sseWrite(res, { done: true, fullReply: text });
            res.end();
            return;
        }
        if (action.type === UGC_ACTION.NEW_PROJECT) {
            // Clearing a finished project so a fresh one can start. The generated
            // video stays in the gallery; only the studio project record is removed.
            ugcStudio.removeProject(conversationId);
            const text = 'UGC Studio \u2014 ready for a new project. Tell me the product and the kind of video you want to make.';
            sseWrite(res, { chunk: text });
            sseWrite(res, { done: true, fullReply: text });
            res.end();
            return;
        }

        sseWrite(res, { error: 'Unknown UGC Studio action.' });
        res.end();
    } catch (err) {
        console.error('[ugc] action failed:', err.message);
        sseWrite(res, { error: 'UGC Studio \u2014 ' + err.message });
        res.end();
    }
}

// Generate (or regenerate) the reference frame for every approved scene — or a
// single scene when `sceneIds` is given. Reuses the existing image pipeline: the
// studio builds direction, imageGenerator.buildImagePrompt owns the final prompt,
// and imageGenerator.generateImage renders + records it in the gallery.
async function handleUGCGenerateReferences(req, res, ctx, project, sceneIds, options) {
    const { conversationId, provider, model, think } = ctx;
    const opts = options || {};
    const scenes = (project.scenes || []).slice();
    const targets = Array.isArray(sceneIds) && sceneIds.length
        ? scenes.filter((s) => sceneIds.includes(s.id))
        : scenes;
    if (!targets.length) {
        sseWrite(res, { error: 'UGC Studio \u2014 There is no scene plan yet. Approve the scenes first.' });
        res.end();
        return;
    }

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };

    try {
        // A fresh full regeneration must not mix new frames with old ones: drop
        // the existing set (and any approval) before generating.
        if (opts.fresh && !sceneIds) {
            project.references = [];
            project.approvedReferences = [];
        }
        project.stage = UGC_STAGE.REFERENCE_GENERATION;
        ugcStudio.save(project);
        sseWrite(res, { generating: 'UGC Studio \u2014 building ' + targets.length + ' reference prompt(s)\u2026' });

        // Prompt building needs the chat model; render needs ComfyUI. Keep the
        // one-side-resident rule: build every prompt first, then free Ollama once
        // and render the whole batch on ComfyUI (no per-image ping-pong).
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();
        const jobs = [];
        for (const scene of targets) {
            const request = ugcStudio.buildReferenceRequest(project, scene);
            let imagePrompt = request.user_prompt;
            let attributes = null;
            try {
                const enhanced = await imageGenerator.buildImagePrompt(request, providers, provider, model, think);
                if (enhanced && enhanced.prompt) {
                    imagePrompt = enhanced.prompt;
                    attributes = enhanced.attributes || null;
                }
            } catch (err) {
                console.warn('[ugc] reference prompt build failed, using concept:', err.message);
            }
            jobs.push({ scene, imagePrompt, attributes, request });
        }

        await vramManager.freeVRAMBeforeImage();
        // The creator's single consolidated identity image conditions every
        // reference frame (reference-guided edit), so the same person appears
        // across all scenes. A project with no on-camera creator stays a plain
        // text generation.
        const creatorIdentityName = (project.creator && project.creator.identityBaseImage)
            || (project.creator && Array.isArray(project.creator.identityReferences) &&
                project.creator.identityReferences[0])
            || '';
        const creatorIdentityAbs = creatorIdentityName
            ? path.join(GENERATED_DIR, path.basename(String(creatorIdentityName)))
            : '';
        const hasCreatorIdentity = Boolean(creatorIdentityAbs && fs.existsSync(creatorIdentityAbs));
        const creatorIdentityInstruction = (project.creator && project.creator.identityPreservationInstructions)
            ? 'IDENTITY: ' + project.creator.identityPreservationInstructions + ' SCENE (change only this): '
            : '';
        let failed = 0;
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            sseWrite(res, {
                generating: 'UGC Studio \u2014 reference ' + (i + 1) + ' of ' + jobs.length +
                    ' (scene ' + job.scene.order + ')\u2026'
            });
            try {
                const onStart = () => sseWrite(res, { generating: 'UGC Studio \u2014 rendering scene ' + job.scene.order + '\u2026' });
                const promise = hasCreatorIdentity
                    ? imageGenerator.editImage(creatorIdentityAbs, creatorIdentityInstruction + job.imagePrompt, {
                        provider, model, conversationId, onQueued, onStart,
                        references: [],
                        label: 'ugc reference', kind: 'image_generation'
                    })
                    : imageGenerator.generateImage(job.imagePrompt, {
                        provider, model, conversationId, onQueued,
                        // Product reference images travel on their own channel; they
                        // are never merged with the scene reference frames.
                        productReferences: job.request.product_references || [],
                        onStart,
                        label: 'ugc reference', kind: 'image_generation'
                    });
                queueId = promise.queueId || null;
                const result = await promise;
                ugcStudio.recordReference(project, job.scene.id, {
                    url: result.url,
                    filename: ugcRawFilename(result.url),
                    prompt: job.imagePrompt
                });
            } catch (err) {
                // Cancellation aborts the batch; any other per-scene failure is
                // recorded so the successful frames are preserved and the failed
                // scene can be retried on its own.
                if (err && err.code === 'generation_cancelled') throw err;
                failed += 1;
                console.warn('[ugc] reference for scene ' + job.scene.order + ' failed:', err.message);
                ugcStudio.recordReferenceFailure(project, job.scene.id, friendlyImageError(err));
                sseWrite(res, { generating: 'UGC Studio \u2014 scene ' + job.scene.order + ' failed, continuing\u2026' });
            }
        }
        ugcStudio.markReferencesReady(project);
        activityLog.record({
            type: 'generation',
            title: 'UGC reference frames',
            detail: (jobs.length - failed) + ' of ' + jobs.length + ' frame(s) for ' +
                ((project.product && project.product.name) || 'project'),
            conversationId
        });
        await vramManager.freeComfyModels('ugc references');
        emitUGCCard(res, project);
    } catch (err) {
        console.error('[ugc] reference generation failed:', err.message);
        // Recover the stage so the card stays actionable: back to reference
        // approval when some frames exist, otherwise back to the scene plan.
        try {
            project.stage = (project.references && project.references.length)
                ? UGC_STAGE.REFERENCE_APPROVAL
                : UGC_STAGE.SCENE_REVIEW;
            ugcStudio.save(project);
        } catch (e) { /* keep the original error */ }
        const friendly = (err && (err.code === 'generation_cancelled'))
            ? 'Reference generation cancelled.'
            : friendlyImageError(err);
        sseWrite(res, { error: 'UGC Studio \u2014 ' + friendly });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

// Hand the approved UGC project to Director Mode. The structured brief + scene
// plan travel as the Director's own shot list; the approved opening frame becomes
// the production's first frame. The existing H3 video stage renders the result.
async function handleUGCDirectorHandoff(req, res, ctx, project) {
    const { conversationId, message, provider, model, think } = ctx;
    const input = ugcStudio.directorProductionInput(project);
    if (!input.openingFrame) {
        sseWrite(res, { error: 'UGC Studio \u2014 There is no approved reference frame to animate. Generate and approve the references first.' });
        res.end();
        return;
    }
    // A brief longer than the H3 ceiling is never silently clamped. Explain the
    // limit and ask the user to confirm the 15-second render explicitly.
    if (input.durationCapped && !project.durationConfirmed) {
        // Stay at the approval checkpoint so the confirm action is valid.
        project.stage = UGC_STAGE.REFERENCE_APPROVAL;
        ugcStudio.save(project);
        const text = 'UGC Studio \u2014 This brief is ' + input.requestedDuration +
            ' seconds, but the Director\u2019s H3 stage renders at most ' +
            ugcStudio.DURATION_LIMITS.renderMax + ' seconds. I can render the first ' +
            ugcStudio.DURATION_LIMITS.renderMax + ' seconds, or shorten the brief. ' +
            'Reply "continue at 15 seconds" to render the capped cut.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }
    try {
        sseWrite(res, { generating: 'UGC Studio \u2014 handing off to Director Mode\u2026' });
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();
        const production = director.createUgcProduction({
            conversationId,
            brief: input.brief,
            duration: input.duration,
            openingFrame: input.openingFrame,
            originalRequest: input.originalRequest,
            references: input.references,
            // The approved creator's single consolidated identity image travels
            // with the production so every shot inherits the same person.
            identityReferences: input.identityReferences
        });
        ugcStudio.setDirectorProduction(project, production.id);
        activityLog.record({
            type: 'generation',
            title: 'UGC handed to Director',
            detail: (project.product && project.product.name) || project.request,
            conversationId
        });
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: production.brief.subject || project.request,
            originalPrompt: project.request,
            status: 'running',
            lastAction: 'ugc production'
        });
        await runDirectorVideoStage(req, res, ctx, production);
    } catch (err) {
        console.error('[ugc] director handoff failed:', err.message);
        sseWrite(res, { error: 'UGC Studio could not start the Director production: ' + err.message });
        res.end();
    }
}

// --- Creative Playground -----------------------------------------------------
//
// Concept discovery built on the existing image pipeline. Concept generation is
// deterministic (theme catalog + character preset + locks); the final Krea2
// prompt is still produced by imageGenerator.buildImagePrompt, so the concept is
// creative direction, never a competing prompt builder.

// --- Character Identity System ------------------------------------------------
//
// The identity package lives on the character preset. An initial character
// image is generated as a candidate, shown for approval, and only after the
// user approves it does the Character Identity Sheet get generated (reusing the
// Qwen edit pipeline with the approved base image as the source).

// The approved base image / identity references are full renders, not the 256px
// playground face thumbnail, so they are generated at a fixed square size.
const IDENTITY_BASE_SIZE = 1024;

function identityCard(characterId) {
    const character = characterPresets.get(characterId);
    if (!character) return null;
    return characterIdentity.buildCard(character);
}

function emitIdentityCardEvent(res, characterId) {
    const card = identityCard(characterId);
    if (!card) {
        sseWrite(res, { error: 'That character no longer exists.' });
        res.end();
        return;
    }
    sseWrite(res, { identity: { card } });
    res.end();
}

// Normalize the ordered character ids a request carries (the @ picker sends
// `body.characters`; older callers may send a single `body.characterId`).
function sanitizeCharacterIds(value) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    const out = [];
    for (const item of list) {
        const id = String((item && typeof item === 'object' ? (item.id || item.characterId) : item) || '').trim();
        if (!id || out.includes(id)) continue;
        if (characterPresets.get(id)) out.push(id);
    }
    return out;
}

// Find the saved characters an image/video request refers to: an explicit
// picker selection, a `@Name` mention, a bare character name, or (for a
// continuation) the conversation's active character. Conservative — a
// characterless request never inherits one. Delegates to the shared
// character-context layer so every media pipeline resolves identically.
function resolveRequestCharacters(message, conversationId, explicitIds, action) {
    const parsed = characterContext.parseCharacterMessage(message, { explicitIds });
    const resolution = characterContext.resolveActiveCharacters({
        conversationId,
        explicit: parsed.characters,
        message,
        action
    });
    return resolution.characters.map((ref) => characterPresets.get(ref.id)).filter(Boolean);
}

// Resolve (or create) the character a playground identity action operates on.
// A saved session character wins; otherwise the concept is materialized into a
// candidate preset so the identity package has a durable home. Returns the
// character record or null when the concept has no identity to save.
function materializeIdentityCharacter(session, options = {}) {
    const saved = playground.resolveCharacter(session.characterId)
        || playground.identityCharacterSource(session, null);
    // An explicitly named save always creates a fresh preset (the user is
    // saving this concept as a new character), even if a character is bound.
    if (saved && !options.name) return saved;
    const concept = session.concept || {};
    const snapshot = session.characterSnapshot || {};
    const identity = concept.identity || snapshot.identity || null;
    if (!identity && !concept.subject && !snapshot.identityText) return null;
    const character = characterPresets.create({
        name: options.name || concept.name || snapshot.name || 'Character',
        identity,
        identityText: concept.subject || snapshot.identityText || '',
        identitySignature: concept.identitySignature || snapshot.identitySignature || '',
        appearance: concept.appearance || '',
        hair: concept.hair || '',
        appearanceCategory: concept.appearanceCategory || '',
        appearanceCategoryLabel: concept.appearanceCategoryLabel || '',
        outfitPack: concept.outfitPack || '',
        outfitPackCustom: concept.outfitPackCustom || '',
        provenance: { type: 'playground-identity', seed: concept.characterSeed || null }
    });
    playground.setIdentityCharacter(session, character.id);
    return character;
}

// Build the reference-guided edit conditioning for one or more characters, or
// null when none has a usable identity image. The shared character-context layer
// leads with ONE approved base portrait per character; multi-panel identity
// sheets are excluded from generation, and identity stays separate from scene.
//
// `options.userReferences` are the ordered @-picker image references the user
// supplied. They are positional references the user explicitly asked for, so
// they are ALWAYS kept: the first character's approved portrait is the edit
// source (image_1) and the other characters' portraits and user's images follow
// as image_2..N. A sheet can leak its layout even as a secondary reference, so
// it is excluded from every generation path.
// A stable per-turn seed for the creative-defaults layer. Keyed on the
// conversation + resolved prompt so a retry of the same request keeps the same
// automatic clothing/style, while a genuinely new request varies.
function creativeDefaultSeed(conversationId, scenePrompt) {
    const creativeDefaults = require('./services/creative-defaults');
    return creativeDefaults.hashString(String(conversationId || '') + '|' + String(scenePrompt || ''));
}

// The resolved per-character clothing from the creative-defaults layer, in the
// shape persisted on the task so a follow-up can preserve it. Null when the
// user specified clothing or there is nothing to carry.
function persistedClothing(identity) {
    const clothing = identity && identity.creativeDefaults && identity.creativeDefaults.clothing;
    if (!Array.isArray(clothing) || !clothing.length) return null;
    if (identity.creativeDefaults.hasExplicitClothing) return null;
    return clothing.map((item) => ({
        name: item.name,
        outfit: item.outfit,
        source: item.source,
        packId: item.packId || ''
    }));
}

// The resolved style package, in the shape persisted for continuity.
function persistedImageStyle(identity) {
    const style = identity && identity.creativeDefaults && identity.creativeDefaults.style;
    if (!style || !style.id || !style.package) return null;
    return { id: style.id, label: style.package.label, source: style.source };
}

// Development-only (JARVIS_PROMPT_DEBUG=1): print the resolved prompt so it is
// easy to verify explicit clothing/style survives, automatic defaults appear,
// phone photography is used when appropriate, and identity is untouched.
function debugResolvedPrompt(stage, identity) {
    if (String(process.env.JARVIS_PROMPT_DEBUG || '') !== '1') return;
    if (!identity || !identity.instruction) return;
    const defaults = identity.creativeDefaults || {};
    console.log('[prompt-debug] ' + stage +
        ' characters=' + (identity.characterName || '') +
        ' explicitClothing=' + Boolean(defaults.hasExplicitClothing) +
        ' automaticClothing=' + ((defaults.clothing || []).map((c) => c.name + ': ' + c.outfit).join(' | ') || '(none)') +
        ' style=' + ((defaults.style && defaults.style.package && defaults.style.package.label) || '(explicit/none)') +
        '\n' + identity.instruction);
}

function resolveIdentityConditioning(characters, scenePrompt, options = {}) {
    const list = Array.isArray(characters) ? characters : (characters ? [characters] : []);
    if (!list.length) return null;
    const conditioning = characterContext.buildConditioning(list, scenePrompt, {
        rawPrompt: options.rawPrompt,
        environment: options.environment,
        activity: options.activity,
        seed: options.seed,
        outfitPack: options.outfitPack,
        defaults: options.defaults,
        continuity: options.continuity,
        previousClothing: options.previousClothing,
        previousStyle: options.previousStyle,
        newOccasion: options.newOccasion
    });
    if (!conditioning) return null;
    const sourceAbs = path.join(GENERATED_DIR, path.basename(conditioning.sourceFilename));
    if (!fs.existsSync(sourceAbs)) return null;
    const combined = characterContext.combineReferenceFilenames(conditioning, {
        userReferences: options.userReferences,
        sourceImages: options.sourceImages
    });
    const references = combined.references
        .map((name) => path.join(GENERATED_DIR, path.basename(name)))
        .filter((abs) => fs.existsSync(abs));
    return {
        characterId: conditioning.characters[0] && conditioning.characters[0].id,
        characterIds: conditioning.characters.map((c) => c.id),
        characterName: conditioning.names,
        sourceAbs,
        references,
        // The @-picker references the user supplied, by image_N position, so the
        // instruction can address them (image 1 is the character's identity image).
        userReferenceIndexes: combined.userIndexes,
        instruction: conditioning.instruction,
        constraints: conditioning.constraints,
        entries: conditioning.entries,
        multiCharacter: conditioning.multiCharacter || null,
        creativeDefaults: conditioning.creativeDefaults || null
    };
}

// A random Playground character has a pre-rendered face before it has a saved
// preset. Use that portrait with the same identity-vs-scene prompt layer as a
// saved @Character, so Playground never falls back to text-only character
// generation. The multi-panel sheet is deliberately not part of this path.
function resolvePlaygroundIdentityConditioning(session, scenePrompt) {
    const savedCharacter = playground.identityCharacterSource(session, null);
    if (savedCharacter) {
        const saved = resolveIdentityConditioning(savedCharacter, scenePrompt);
        if (saved) return saved;
    }

    const portrait = session && (session.characterImage ||
        (session.characterSnapshot && session.characterSnapshot.portraitReference));
    if (!portrait || !portrait.filename) return null;
    const character = session.characterSnapshot || {
        name: session.concept && session.concept.name,
        identity: session.concept && session.concept.identity
    };
    const conditioning = characterIdentity.buildStandaloneConditioning(character, portrait, scenePrompt);
    if (!conditioning) return null;
    const sourceAbs = path.join(GENERATED_DIR, path.basename(conditioning.sourceFilename));
    if (!fs.existsSync(sourceAbs)) return null;
    return Object.assign({}, conditioning, {
        characterId: null,
        characterIds: [],
        characterName: conditioning.characterName,
        sourceAbs
    });
}

// Fold the user's @-picker image references into the character edit
// instruction as explicit positional SCENE anchors. The base image (image 1) is
// the approved character; each user reference that follows is named by its
// image_N position so the editor keeps it instead of dropping it.
function addUserReferencesToInstruction(instruction, conditioning) {
    const indexes = Array.isArray(conditioning.userReferenceIndexes) ? conditioning.userReferenceIndexes : [];
    if (!indexes.length) return instruction;
    const labels = indexes.map((idx) => (idx < 0 ? null : 'image ' + (idx + 1))).filter(Boolean);
    if (!labels.length) return instruction;
    return instruction + ' Additional scene reference images are supplied (' + labels.join(', ') +
        '), conditioned on the weights below the character base image. Use them for the requested ' +
        'object, pose, environment or style while keeping the character\'s identity; do not discard them.';
}

// The character's preview image, used as the candidate base when the user saves
// a concept as a character. Prefers the preview already shown on the card
// (session.characterImage), then a saved character's approved base image.
function baseImageFromSession(session) {
    const preview = session && session.characterImage;
    if (preview && preview.url) return preview;
    const character = session && session.characterId ? characterPresets.get(session.characterId) : null;
    if (!character) return null;
    const pkg = characterPresets.getIdentityPackage(character.id);
    const base = pkg && pkg.approvedBaseImage;
    if (base && base.url) return base;
    return null;
}

// Generate the candidate base image for a character from a portrait request.
// Same one-side-resident dance as the playground face stage, but at full size.
async function generateIdentityBaseImage(req, res, ctx, request) {
    const { conversationId, provider, model, think } = ctx;
    vramManager.rememberChatModel(provider, model);
    await vramManager.freeVRAMBeforeChat();
    const enhanced = await imageGenerator.buildImagePrompt(request, providers, provider, model, think);
    const imagePrompt = enhanced ? enhanced.prompt : request.user_prompt;
    await vramManager.freeVRAMBeforeImage();
    const result = await imageGenerator.generateImage(imagePrompt, {
        provider, model, conversationId,
        width: IDENTITY_BASE_SIZE,
        height: IDENTITY_BASE_SIZE,
        label: 'character identity base', kind: 'image_generation',
        // The identity base image is internal media for the character package,
        // not a gallery item.
        hidden: true
    });
    return {
        url: result.url,
        filename: result.filename,
        prompt: imagePrompt,
        seed: result.seed,
        width: result.width,
        height: result.height,
        generationId: (result.meta && result.meta.id) || ''
    };
}

// Run identity-sheet generation over SSE, persisting progress to the character
// preset so a reload (or the viewer polling) sees live progress. The result is
// ONE consolidated identity sheet. A failed regeneration never destroys the
// approved base image or the previous valid sheet.
async function runIdentitySheetStream(req, res, character, ctx) {
    const characterId = character.id;
    const { conversationId, provider, model } = ctx;
    const pkg = characterPresets.getIdentityPackage(characterId) || {};
    const previous = JSON.parse(JSON.stringify(pkg));
    sseWrite(res, { generating: 'Creating Character Identity Sheet\u2026 Rendering the reference sheet.' });
    vramManager.rememberChatModel(provider, model);
    await vramManager.freeVRAMBeforeImage();
    const result = await characterIdentity.generateSheet({
        character,
        package: pkg,
        previousSheet: previous,
        conversationId,
        generate: (abs, instruction, options) => imageGenerator.editImage(abs, instruction, options),
        resolveAbs: (name) => path.join(GENERATED_DIR, path.basename(name)),
        onProgress: (progressPkg) => {
            characterPresets.setIdentityPackage(characterId, progressPkg);
            sseWrite(res, {
                identityProgress: {
                    characterId,
                    done: progressPkg.progress.done,
                    total: progressPkg.progress.total,
                    current: progressPkg.progress.current,
                    status: progressPkg.identitySheet ? progressPkg.identitySheet.status : ''
                }
            });
        },
        logger: console
    });
    characterPresets.setIdentityPackage(characterId, result);
    activityLog.record({
        type: 'generation',
        title: 'Character Identity Sheet',
        detail: (character.name || 'Character') + ' \u2014 ' + result.status,
        conversationId
    });
    await vramManager.freeComfyModels('character identity sheet');
    return result;
}

// Stream the persisted concept card and end the turn. `fullReply` carries the
// marker so the client saves it and the card survives a reload.
function emitPlaygroundCard(res, session) {
    const character = playground.resolveCharacter(session.characterId)
        || playground.identityCharacterSource(session, null);
    const content = playground.renderContent(session, character);
    sseWrite(res, {
        playground: {
            content,
            status: session.status,
            card: playground.buildCard(session, character)
        }
    });
    res.end();
}

// The character preview overrides the global IMAGE settings with a fixed 1:1
// render at the identity base size: this preview becomes the approved base image
// for the character identity sheet, so it is a full render, not a thumbnail.
const PLAYGROUND_FACE_SIZE = IDENTITY_BASE_SIZE;

// Pre-render the face of a freshly cast random character so the user sees who
// the concept is about before the full scene. Fail-open: a failure leaves the
// text concept fully usable (the user can still Generate).
async function runPlaygroundFaceStage(req, res, ctx, session) {
    if (!playground.needsCharacterImage(session)) return;
    const { conversationId, provider, model, think } = ctx;
    const request = playground.buildPortraitRequest(session);
    if (!request) return;
    try {
        sseWrite(res, { generating: 'Creative Playground \u2014 Creating the character\u2026' });
        // Prompt building needs the chat model, generation needs ComfyUI — the
        // same one-side-resident dance as the concept image.
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();
        const enhanced = await imageGenerator.buildImagePrompt(request, providers, provider, model, think);
        const imagePrompt = enhanced ? enhanced.prompt : request.user_prompt;
        await vramManager.freeVRAMBeforeImage();
        const result = await imageGenerator.generateImage(imagePrompt, {
            provider, model, conversationId,
            width: PLAYGROUND_FACE_SIZE,
            height: PLAYGROUND_FACE_SIZE,
            label: 'playground character', kind: 'image_generation',
            // The character preview is shown on the concept card (and becomes
            // the approved identity base), not in the shared gallery.
            hidden: true
        });
        playground.setCharacterImage(session, {
            url: result.url,
            filename: result.filename,
            prompt: imagePrompt,
            seed: result.seed,
            width: result.width,
            height: result.height
        });
    } catch (err) {
        console.error('[playground] face stage failed:', err.message);
    }
}

// Hand a concept to the existing prompt builder and image pipeline. Shared by
// the card's Generate action and a Surprise that already has a known (saved)
// character — the latter skips the preview card and generates in one step.
async function runPlaygroundGenerate(req, res, ctx, session, rawMessage) {
    const { conversationId, provider, model, think } = ctx;
    if (playground.needsCharacterImage(session)) {
        await runPlaygroundFaceStage(req, res, ctx, session);
    }
    if (session.mode === 'random_character' && playground.needsCharacterImage(session)) {
        sseWrite(res, { error: 'Creative Playground \u2014 I could not establish the character portrait needed to keep this person consistent. Retry the character portrait, then generate the scene.' });
        res.end();
        return;
    }
    const request = playground.buildImageRequest(session);
    if (!request) {
        sseWrite(res, { error: 'Creative Playground \u2014 The concept is no longer available.' });
        res.end();
        return;
    }
    sseWrite(res, { generating: 'Creating the concept image\u2026' });
    vramManager.rememberChatModel(provider, model);
    await vramManager.freeVRAMBeforeChat();
    const enhanced = await imageGenerator.buildImagePrompt(request, providers, provider, model, think);
    const imagePrompt = enhanced ? enhanced.prompt : request.user_prompt;
    const attributes = enhanced ? enhanced.attributes : null;
    session.generatedPrompt = {
        prompt: imagePrompt,
        attributes: attributes || null,
        builderVersion: enhanced && enhanced.builderVersion || 'legacy',
        characterRevision: session.characterRef && session.characterRef.revision,
        sceneRevision: session.revision
    };
    session.composition = Object.assign({}, session.composition, {
        generatedPrompt: session.generatedPrompt,
        updatedAt: new Date().toISOString()
    });
    // An approved character conditions the scene as a reference-guided
    // edit (identity preserved, scene/setting changed). It also becomes
    // the conversation's active character so a later "make her …"
    // continuation resolves to the same person.
    const identity = resolvePlaygroundIdentityConditioning(session, imagePrompt);
    if (session.mode === 'random_character' && !identity) {
        sseWrite(res, { error: 'Creative Playground \u2014 The character portrait is unavailable, so I could not preserve this character in the scene.' });
        res.end();
        return;
    }
    if (identity && identity.characterId) {
        characterContext.setActiveCharacter(conversationId, [{ id: identity.characterId, name: identity.characterName }]);
    }
    taskState.setTask(conversationId, {
        type: 'image',
        operation: 'generate',
        prompt: imagePrompt,
        originalPrompt: request.user_prompt,
        lastAction: 'generate',
        status: 'running',
        parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
            creative_mode: request.creative_mode,
            explicit_constraints: request.explicit_constraints,
            attributes: attributes || null,
            playgroundId: session.id,
            characterId: identity ? identity.characterId : null,
            characterIds: identity && identity.characterIds ? identity.characterIds : []
        })
    });
    playground.markUsed(session);
    activityLog.record({
        type: 'generation',
        title: 'Creative Playground',
        detail: session.concept && session.concept.title ? session.concept.title : 'Concept generated',
        conversationId
    });
    await vramManager.freeVRAMBeforeImage();
    await handleImageGenerationStream(req, res, {
        provider, model, conversationId, message: rawMessage,
        imagePrompt,
        action: 'generate',
        previousPrompt: null,
        identity,
        think
    });
}

async function handlePlaygroundAction(req, res, ctx, action, rawMessage) {
    const { conversationId, provider, model, think } = ctx;
    let session = playground.getSession(conversationId);
    try {
        if (action.type === playground.ACTIONS.SURPRISE) {
            session = playground.start({
                conversationId,
                themeId: action.themeId,
                category: action.category,
                characterId: action.characterId,
                mode: action.mode,
                locks: action.locks,
                profile: action.profile,
                outfitPack: action.outfitPack,
                outfitPackCustom: action.outfitPackCustom,
                // The user's own prompt, used verbatim with the chosen character.
                customPrompt: action.customPrompt
            });
            await runPlaygroundFaceStage(req, res, ctx, session);
            // A saved character already has a known identity, so there is nothing
            // to preview — generate the scene in one step. A random new character
            // still stops at the card (its pre-rendered face is what the user
            // reviews) and a no-character concept stays general exploration.
            if (session.mode === 'character') {
                await runPlaygroundGenerate(req, res, ctx, session, rawMessage);
                return;
            }
            emitPlaygroundCard(res, session);
            return;
        }

        if (!session) {
            sseWrite(res, { error: 'Creative Playground \u2014 There is no active concept. Use Surprise Me to start one.' });
            res.end();
            return;
        }
        if (action.conceptId && action.conceptId !== session.id) {
            sseWrite(res, { error: 'Creative Playground \u2014 That card belongs to an earlier concept. Use the newest one.' });
            res.end();
            return;
        }
        if (action.expectedRevision !== undefined && Number(action.expectedRevision) !== Number(session.revision || 1)) {
            sseWrite(res, { error: 'Creative Playground — This card is stale. Refresh the current composition.' });
            res.end();
            return;
        }

        if (action.type === playground.ACTIONS.AGAIN) {
            session = playground.again(session);
            await runPlaygroundFaceStage(req, res, ctx, session);
            emitPlaygroundCard(res, session);
            return;
        }

        if (action.type === playground.ACTIONS.RETRY_PORTRAIT) {
            await runPlaygroundFaceStage(req, res, ctx, session);
            emitPlaygroundCard(res, session);
            return;
        }

        // --- Character Identity System ---------------------------------------
        // Approval gate: saving a concept as a character creates a CANDIDATE
        // base image only. The consolidated identity sheet is generated only
        // after the user explicitly approves the candidate.
        if (action.type === playground.ACTIONS.SAVE_CHARACTER || action.type === playground.ACTIONS.IDENTITY_START) {
            const character = materializeIdentityCharacter(session,
                action.type === playground.ACTIONS.SAVE_CHARACTER && action.name ? { name: action.name } : {});
            if (!character) {
                sseWrite(res, { error: 'Creative Playground \u2014 This concept has no character to save.' });
                res.end();
                return;
            }
            // Persist the concept record too, so the saved scene is available.
            try { session = playground.save(session, character); } catch (err) { /* saving the concept is best-effort */ }
            playground.setIdentityCharacter(session, character.id);

            let base = baseImageFromSession(session);
            if (!base || !base.filename) {
                const request = playground.buildPortraitRequest(session)
                    || characterStudio.generatePortraitRequest(character);
                if (!request) {
                    sseWrite(res, { error: 'Creative Playground \u2014 This concept has no character details to render.' });
                    res.end();
                    return;
                }
                sseWrite(res, { generating: 'Creating the character\u2026' });
                base = await generateIdentityBaseImage(req, res, ctx, request);
            }
            if (base.url) {
                session.characterImage = {
                    url: base.url, filename: base.filename,
                    width: base.width, height: base.height, seed: base.seed
                };
            }
            // Saving a character goes straight to the identity sheet: the
            // preview is locked as the approved base image and the consolidated
            // sheet is generated in the same turn (no separate approval step).
            characterPresets.setCandidateBaseImage(character.id, base);
            characterPresets.approveBaseImage(character.id);
            activityLog.record({
                type: 'generation',
                title: 'Character saved',
                detail: character.name || 'Character',
                conversationId
            });
            await runIdentitySheetStream(req, res, character, ctx);
            emitPlaygroundCard(res, session);
            return;
        }

        // Discard the candidate and generate another initial character image.
        // Never creates an identity sheet and never touches an approved base.
        if (action.type === playground.ACTIONS.IDENTITY_REGENERATE) {
            const character = playground.identityCharacterSource(session, null)
                || materializeIdentityCharacter(session, {});
            if (!character) {
                sseWrite(res, { error: 'Creative Playground \u2014 There is no candidate character to regenerate.' });
                res.end();
                return;
            }
            const pkg = characterPresets.getIdentityPackage(character.id);
            if (pkg && pkg.approvedBaseImage && pkg.approvedBaseImage.approvedAt &&
                pkg.identitySheet && pkg.identitySheet.status === characterIdentity.SHEET_STATUS.READY) {
                sseWrite(res, { error: 'Creative Playground \u2014 This character already has an approved identity. Use "Regenerate Identity Sheet" instead.' });
                res.end();
                return;
            }
            const request = playground.buildPortraitRequest(session)
                || characterStudio.generatePortraitRequest(character);
            if (!request) {
                sseWrite(res, { error: 'Creative Playground \u2014 This concept has no character details to render.' });
                res.end();
                return;
            }
            sseWrite(res, { generating: 'Regenerating the character\u2026' });
            const base = await generateIdentityBaseImage(req, res, ctx, request);
            characterPresets.setCandidateBaseImage(character.id, base);
            session.characterImage = {
                url: base.url, filename: base.filename,
                width: base.width, height: base.height, seed: base.seed
            };
            playground.setIdentityCharacter(session, character.id);
            emitPlaygroundCard(res, session);
            return;
        }

        // Approve the candidate base image, then generate the ONE consolidated
        // identity sheet. The approved base image is never overwritten by a
        // regeneration.
        if (action.type === playground.ACTIONS.IDENTITY_APPROVE) {
            const character = playground.identityCharacterSource(session, null);
            if (!character) {
                sseWrite(res, { error: 'Creative Playground \u2014 There is no character to approve.' });
                res.end();
                return;
            }
            const pkg = characterPresets.getIdentityPackage(character.id);
            if (!pkg || !pkg.approvedBaseImage || !pkg.approvedBaseImage.filename) {
                sseWrite(res, { error: 'Creative Playground \u2014 Generate the initial character image before approving.' });
                res.end();
                return;
            }
            if (pkg.approvedBaseImage.approvedAt && pkg.identitySheet && pkg.identitySheet.status === characterIdentity.SHEET_STATUS.READY) {
                sseWrite(res, { error: 'Creative Playground \u2014 This character identity is already created.' });
                res.end();
                return;
            }
            characterPresets.approveBaseImage(character.id);
            await runIdentitySheetStream(req, res, character, ctx);
            emitPlaygroundCard(res, session);
            return;
        }

        // Regenerate the identity sheet, preserving the approved base image. The
        // previous sheet is kept until the new one is proven (see generateSheet).
        if (action.type === playground.ACTIONS.IDENTITY_SHEET_REGENERATE) {
            const character = playground.identityCharacterSource(session, null);
            if (!character) {
                sseWrite(res, { error: 'Creative Playground \u2014 There is no character to regenerate.' });
                res.end();
                return;
            }
            const pkg = characterPresets.getIdentityPackage(character.id);
            if (!pkg || !pkg.approvedBaseImage || !pkg.approvedBaseImage.filename) {
                sseWrite(res, { error: 'Creative Playground \u2014 Approve a character image before regenerating its identity sheet.' });
                res.end();
                return;
            }
            await runIdentitySheetStream(req, res, character, ctx);
            emitPlaygroundCard(res, session);
            return;
        }

        // Use the character in the conversation: bind it as the active character
        // so a following generation (or a typed follow-up) resolves to it.
        if (action.type === playground.ACTIONS.USE_CHARACTER) {
            const character = playground.identityCharacterSource(session, null);
            if (!character) {
                sseWrite(res, { error: 'Creative Playground \u2014 There is no character to use.' });
                res.end();
                return;
            }
            characterContext.setActiveCharacter(conversationId, [{ id: character.id, name: character.name }]);
            playground.setIdentityCharacter(session, character.id);
            sseWrite(res, {
                chunk: 'Using ' + (character.name || 'the character') + ' for this conversation. Mention ' +
                    '@' + (character.name || 'Character') + ' in a request to generate a scene.',
                done: true
            });
            res.end();
            return;
        }


        if (action.type === playground.ACTIONS.MODIFY) {
            const direction = String(action.direction || rawMessage || '').trim();
            if (!direction) {
                sseWrite(res, { error: 'Tell me how the concept should change.' });
                res.end();
                return;
            }
            // Structured UI edits are already precise: a field re-roll (the
            // card's per-attribute dice) or an explicit field change (inline
            // edit). They bypass the free-text interpretation.
            const isRerollField = String(action.rerollField || '').trim();
            const isRerollIdentity = String(action.rerollIdentity || '').trim();
            const uiChanges = (action.changes && typeof action.changes === 'object'
                && Object.keys(action.changes).length) ? action.changes : null;
            let payload;
            if (isRerollField) {
                payload = { locks: session.locks || {}, changes: {}, rerollField: isRerollField, reroll: false };
            } else if (isRerollIdentity) {
                payload = { locks: session.locks || {}, changes: {}, rerollIdentity: isRerollIdentity, reroll: false };
            } else if (uiChanges) {
                payload = { locks: session.locks || {}, changes: uiChanges, reroll: false };
            } else {
                const interpreted = playground.classifyMessage(direction, session);
                payload = (interpreted && interpreted.action === 'modify')
                    ? interpreted
                    : { locks: {}, changes: { customDirection: direction }, reroll: false };
            }
            // An explicit pack selection from the popover wins over interpretation.
            if (action.outfitPack !== undefined) payload.outfitPack = action.outfitPack;
            if (action.outfitPackCustom !== undefined) payload.outfitPackCustom = action.outfitPackCustom;
            payload.direction = direction;
            session = playground.modify(session, payload);
            await runPlaygroundFaceStage(req, res, ctx, session);
            emitPlaygroundCard(res, session);
            return;
        }

        if (action.type === playground.ACTIONS.SAVE) {
            const character = playground.resolveCharacter(session.characterId);
            session = playground.save(session, character);
            emitPlaygroundCard(res, session);
            return;
        }

        if (action.type === playground.ACTIONS.USE_CONTEXT) {
            const character = playground.resolveCharacter(session.characterId);
            const text = playground.conceptText(session, character);
            playground.markUsed(session);
            sseWrite(res, { chunk: text });
            sseWrite(res, { done: true, fullReply: text });
            res.end();
            return;
        }

        if (action.type === playground.ACTIONS.GENERATE) {
            await runPlaygroundGenerate(req, res, ctx, session, rawMessage);
            return;
        }

        sseWrite(res, { error: 'Unknown Creative Playground action.' });
        res.end();
    } catch (err) {
        console.error('[playground] action failed:', err.message);
        sseWrite(res, { error: 'Creative Playground \u2014 ' + err.message });
        res.end();
    }
}

// --- Director Mode -----------------------------------------------------------
//
// The Director coordinates multi-stage productions (opening frame -> approval
// -> H3 video). It decides WHAT to run; the existing image/video pipelines run
// it. These helpers only wire the SSE stream and the production state.

// Stage names accepted by the activity feed / card renderer.
function directorStageLabel(stage) {
    if (stage === 'video') return 'Creating video';
    if (stage === 'upscale') return 'Upscaling opening frame';
    if (stage === 'image') return 'Creating opening frame';
    return 'Directing';
}

// Director stages interleave chat-model planning with ComfyUI generations. The
// normal workflow frees ComfyUI before any Ollama work and unloads Ollama before
// any ComfyUI work; the Director must do the same or both models stay resident.
async function prepareDirectorLlm(provider, model) {
    vramManager.rememberChatModel(provider, model);
    await vramManager.freeVRAMBeforeChat();
}

// Start a fresh production. From-scratch requests generate an opening frame and
// stop for approval; requests that reference an existing image skip straight to
// the video stage with that image as the approved first frame.
async function handleDirectorStart(req, res, ctx) {
    const { conversationId, message, provider, model, think, referenceImage } = ctx;
    sseWrite(res, { generating: 'Director \u2014 Planning production\u2026' });
    try {
        await prepareDirectorLlm(provider, model);
        // A mentioned / picked character contributes its approved identity
        // package so identity persists across every shot. The character is
        // resolved through the shared layer; a characterless production is
        // unchanged.
        const contextCharacters = Array.isArray(ctx.characters) && ctx.characters.length
            ? ctx.characters
            : characterContext.parseCharacterMessage(message).characters;
        const characterRecords = contextCharacters.map((ref) => characterPresets.get(ref.id)).filter(Boolean);
        // The Director builds its own image prompt; only the identity
        // references are consumed here, not the creative-defaults section.
        const identity = resolveIdentityConditioning(characterRecords, message, { defaults: false });
        if (contextCharacters.length) characterContext.setActiveCharacter(conversationId, contextCharacters);
        const production = await director.createProduction({
            conversationId, message, provider, model, think, referenceImage,
            character: identity ? { identityReferences: [identity.sourceAbs && path.basename(identity.sourceAbs)].concat(identity.references.map((p) => path.basename(p))) } : null
        });
        activityLog.record({
            type: 'generation',
            title: 'Production started',
            detail: production.brief && production.brief.subject
                ? production.brief.subject
                : message,
            conversationId
        });
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: production.brief.originalRequest || message,
            originalPrompt: production.brief.originalRequest || message,
            status: 'running',
            lastAction: 'director production'
        });
        if (production.sourceImage) {
            await runDirectorVideoStage(req, res, ctx, production);
            return;
        }
        await runDirectorImageStage(req, res, ctx, production, {});
    } catch (err) {
        console.error('[director] start failed:', err.message);
        sseWrite(res, { error: 'Director could not plan this production: ' + err.message });
        res.end();
    }
}

// Generate (or regenerate) the opening frame from the canonical brief.
async function runDirectorImageStage(req, res, ctx, production, options) {
    const { provider, model, conversationId, message, think } = ctx;
    const regenerate = Boolean(options && options.regenerate);
    let imagePrompt = options && options.prompt ? options.prompt : null;
    try {
        if (!imagePrompt) {
            if (regenerate && production.image && production.image.prompt) {
                // Same brief, same prompt, fresh seed — the requested new frame.
                imagePrompt = production.image.prompt;
            } else {
                await prepareDirectorLlm(provider, model);
                imagePrompt = await director.buildImageStagePrompt(production, { provider, model, think });
            }
        }
        director.markImageRunning(production);
        taskState.setTask(conversationId, {
            type: 'image',
            operation: 'generate',
            prompt: imagePrompt,
            lastAction: 'director opening frame',
            status: 'running'
        });
        sseWrite(res, {
            generating: 'Director \u2014 ' + directorStageLabel('image') + '\u2026'
        });
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeImage();
        const seed = regenerate ? Math.floor(Math.random() * 2 ** 32) : undefined;
        await handleImageGenerationStream(req, res, {
            provider, model, conversationId, message,
            imagePrompt,
            action: 'generate',
            previousPrompt: null,
            think,
            seed,
            director: { productionId: production.id }
        });
    } catch (err) {
        console.error('[director] image stage failed:', err.message);
        const friendly = friendlyImageError(err);
        director.markImageFailed(production, friendly);
        sseWrite(res, { director: director.buildCard(production, director.renderFailureContent(production, 'image', friendly)) });
        res.end();
    }
}

// Upscale the opening frame awaiting approval with the shared UPSCALE settings
// (SeedVR2 or Ultimate SD). The production stays at the approval checkpoint but
// its image now points at the upscaled file, so the video stage animates the
// higher-resolution frame. Non-terminal: a failure keeps the original frame and
// leaves the card actionable.
async function runDirectorUpscaleStage(req, res, ctx, production) {
    const { provider, model, conversationId } = ctx;
    const frame = (production.image && production.image.rawFilename)
        || production.sourceImage
        || null;
    if (!frame) {
        const friendly = 'There is no opening frame to upscale.';
        sseWrite(res, { director: director.buildCard(production, director.renderFailureContent(production, 'upscale', friendly)) });
        res.end();
        return;
    }
    try {
        sseWrite(res, { generating: 'Director \u2014 ' + directorStageLabel('upscale') + '\u2026' });
        // Upscaling is a pure ComfyUI job (no LLM step), so ensure Ollama is not
        // resident before ComfyUI loads its models.
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeImage();
        const result = await imageGenerator.upscaleImage(frame, {
            provider,
            model,
            conversationId,
            label: 'director frame upscale',
            kind: 'image_upscale'
        });
        director.markImageUpscaled(production, {
            url: result.url,
            rawFilename: result.filename,
            width: result.width,
            height: result.height,
            source: result.source
        });
        const before = (result.sourceWidth || '?') + '\u00d7' + (result.sourceHeight || '?');
        const after = result.width + '\u00d7' + result.height;
        const engineLabel = result.engine === 'ultimate' ? 'Ultimate SD' : 'SeedVR2';
        const detail = 'Now ' + after + ' (from ' + before + ', ' + engineLabel + ').';
        const content = director.renderUpscaledContent(
            production,
            '![opening frame](' + result.url + ')',
            detail
        );
        sseWrite(res, { director: director.buildCard(production, content) });
        res.end();
    } catch (err) {
        console.error('[director] upscale stage failed:', err.message);
        const friendly = friendlyImageError(err);
        director.markUpscaleFailed(production, friendly);
        sseWrite(res, { director: director.buildCard(production, director.renderFailureContent(production, 'upscale', friendly)) });
        res.end();
    }
}

// Generate the H3 video from the approved frame + canonical brief + duration.
async function runDirectorVideoStage(req, res, ctx, production) {
    const { provider, model, conversationId, message, think } = ctx;
    try {
        director.markVideoRunning(production);
        sseWrite(res, {
            generating: 'Director \u2014 ' + directorStageLabel('video') + '\u2026'
        });
        await prepareDirectorLlm(provider, model);
        const stage = await director.buildVideoStageRequest(production, { provider, model, think });
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: stage.videoPrompt,
            videoMode: stage.videoMode,
            sourceImage: stage.sourceImageRawFilename,
            parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
                duration: stage.duration,
                width: stage.width,
                height: stage.height
            }),
            lastAction: 'director video',
            status: 'running'
        });
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeImage();
        await handleVideoGenerationStream(req, res, {
            provider, model, conversationId, message,
            videoPrompt: stage.videoPrompt,
            structuredRequest: stage.structuredRequest,
            action: 'generate',
            previousPrompt: null,
            videoMode: stage.videoMode,
            sourceImageRawFilename: stage.sourceImageRawFilename,
            referenceImages: stage.referenceImages,
            duration: stage.duration,
            width: stage.width,
            height: stage.height,
            think,
            director: { productionId: production.id }
        });
    } catch (err) {
        console.error('[director] video stage failed:', err.message);
        const friendly = friendlyVideoError(err);
        director.markVideoFailed(production, friendly);
        ugcStudio.syncDirectorOutcome(production.conversationId, production.id, 'failed', { message: friendly });
        sseWrite(res, { director: director.buildCard(production, director.renderFailureContent(production, 'video', friendly)) });
        res.end();
    }
}

// --- Long Video Director -----------------------------------------------------
//
// Videos longer than H3's 15-second ceiling. The director plans the story and
// beats, the user approves the storyboard once, and the installed H3 LongVideos
// ComfyUI node renders one continuous video — it owns the frame-to-frame
// temporal chaining. JARVIS never extracts frames or concatenates clips here.

// Plan a fresh long video and stop at the storyboard approval checkpoint.
async function handleLongVideoStart(req, res, ctx) {
    const { conversationId, message, provider, model, think, referenceImage } = ctx;
    sseWrite(res, { generating: 'Long Video Director \u2014 Planning story\u2026' });
    try {
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();
        // A mentioned character becomes the conversation's active character so
        // a later continuation resolves to the same person. (The long-video
        // pipeline is single-job H3 and does not take identity references.)
        const mentioned = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (mentioned.length) characterContext.setActiveCharacter(conversationId, mentioned);
        const plan = await longVideoDirector.createFromRequest({
            conversationId, message, provider, model, think, referenceImage
        });
        activityLog.record({
            type: 'generation',
            title: 'Long video planned',
            detail: plan.duration + 's \u00b7 ' + (plan.beats || []).length + ' beats',
            conversationId
        });
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: plan.prompt,
            originalPrompt: message,
            status: 'running',
            lastAction: 'long video storyboard'
        });
        sseWrite(res, {
            longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderStoryboardContent(plan))
        });
        res.end();
    } catch (err) {
        console.error('[long-video] planning failed:', err.message);
        sseWrite(res, { error: 'Long Video Director could not plan this video: ' + err.message });
        res.end();
    }
}

// Handle a storyboard card action (button click or a typed decision).
async function handleLongVideoAction(req, res, ctx, plan, action) {
    const { conversationId, message, provider, model, think } = ctx;
    if (action.planId && action.planId !== plan.id) {
        const text = 'Long Video Director \u2014 That card belongs to an earlier plan. ' +
            'Use the newest storyboard card.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }

    if (action.type === longVideoDirector.ACTIONS.CANCEL) {
        const status = generationQueue.getStatus();
        if (status.active && (!conversationId || status.active.conversationId === conversationId)) {
            imageGenerator.cancelActive(status.active.id);
            comfyui.interrupt().catch(() => {});
        }
        longVideoDirector.patchPlan(conversationId, {
            status: longVideoDirector.STATUS.CANCELLED,
            error: ''
        });
        taskState.clearTask(conversationId);
        sseWrite(res, {
            longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderCancelledContent(plan))
        });
        res.end();
        return;
    }

    if (action.type === longVideoDirector.ACTIONS.MODIFY_PLAN) {
        const feedback = String(action.direction || message || '').trim();
        if (!feedback) {
            sseWrite(res, { error: 'Tell me how the plan should change.' });
            res.end();
            return;
        }
        sseWrite(res, { generating: 'Long Video Director \u2014 Updating storyboard\u2026' });
        try {
            vramManager.rememberChatModel(provider, model);
            await vramManager.freeVRAMBeforeChat();
            await longVideoDirector.applyStoryboardUpdate(plan, feedback, { provider, model, think });
            sseWrite(res, {
                longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderStoryboardContent(plan))
            });
        } catch (err) {
            console.error('[long-video] storyboard update failed:', err.message);
            sseWrite(res, { error: 'Could not update the storyboard: ' + err.message });
        }
        res.end();
        return;
    }

    if (action.type === longVideoDirector.ACTIONS.APPROVE ||
        action.type === longVideoDirector.ACTIONS.RETRY) {
        await handleLongVideoStream(req, res, { plan, conversationId, provider, model, message, think });
        return;
    }

    sseWrite(res, { error: 'Unknown long video action.' });
    res.end();
}

// Submit the approved storyboard to the H3 LongVideos node and stream the
// stage-based progress. One ComfyUI job — the node chains every beat itself.
async function handleLongVideoStream(req, res, opts) {
    const plan = opts.plan;
    const { conversationId, provider, model, message } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Long Video Director \u2014 Generating sequence\u2026' });
    };

    // Persist a stage transition and re-render the checklist on the card.
    const stage = (id, label) => {
        longVideoDirector.advanceStage(plan, id);
        longVideoDirector.patchPlan(conversationId, {
            stages: plan.stages,
            error: ''
        });
        sseWrite(res, { generating: 'Long Video Director \u2014 ' + label + '\u2026' });
        sseWrite(res, {
            longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderGeneratingContent(plan))
        });
    };

    try {
        longVideoDirector.patchPlan(conversationId, {
            status: longVideoDirector.STATUS.GENERATING,
            error: ''
        });
        longVideoDirector.advanceStage(plan, 'preparing');
        longVideoDirector.patchPlan(conversationId, { stages: plan.stages });
        sseWrite(res, { generating: 'Long Video Director \u2014 Preparing H3 LongVideos\u2026' });

        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: plan.prompt,
            videoMode: plan.sourceImage ? 'i2va' : 't2va',
            sourceImage: plan.sourceImage || null,
            status: 'running',
            lastAction: 'long video'
        });

        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeImage();

        const promise = longVideoDirector.generateLongVideo(plan, {
            conversationId,
            message,
            onQueued,
            onStart,
            onProgress: (value) => {
                if (value === 'preparing') stage('preparing', 'Preparing H3 LongVideos');
                else if (value === 'generating') stage('generating', 'Generating sequence');
                else if (value === 'finalizing') stage('finalizing', 'Finalizing');
            }
        });
        queueId = promise.queueId || null;
        const result = await promise;

        longVideoDirector.completeStages(plan);
        longVideoDirector.patchPlan(conversationId, {
            status: longVideoDirector.STATUS.COMPLETED,
            videoUrl: result.url,
            videoFilename: result.filename,
            promptId: result.promptId || null,
            generationMs: result.generationMs || null,
            actualSeconds: result.duration || plan.duration,
            error: ''
        });
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'generate',
            prompt: plan.prompt,
            generatedAsset: result.url,
            videoMode: plan.sourceImage ? 'i2va' : 't2va',
            sourceImage: plan.sourceImage || null,
            status: 'completed',
            lastAction: 'long video'
        });

        const videoMarkdown =
            '<video class="md-video" preload="metadata" playsinline src="' + result.url + '"></video>';
        sseWrite(res, {
            longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderCompleteContent(plan, videoMarkdown))
        });
        await vramManager.freeComfyModels('long video run');
        res.end();
    } catch (err) {
        console.error('[long-video] generation failed:', err.message, '\n', err.stack);
        const friendly = friendlyLongVideoError(err);
        if (err.code === 'generation_cancelled') {
            longVideoDirector.patchPlan(conversationId, {
                status: longVideoDirector.STATUS.CANCELLED,
                error: ''
            });
            sseWrite(res, {
                longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderCancelledContent(plan))
            });
        } else {
            longVideoDirector.patchPlan(conversationId, {
                status: longVideoDirector.STATUS.FAILED,
                error: friendly
            });
            taskState.setTask(conversationId, { status: 'failed' });
            sseWrite(res, {
                longvideo: longVideoDirector.buildCard(plan, longVideoDirector.renderFailureContent(plan, friendly))
            });
        }
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

function friendlyLongVideoError(err) {
    switch (err.code) {
        case 'longvideo_node_missing':
        case 'longvideo_prompt_missing':
            return err.message;
        case 'comfyui_unavailable':
            return 'ComfyUI is not running. Start ComfyUI, then retry the long video.';
        case 'comfyui_timeout':
            return 'The long video generation timed out. ComfyUI may still be rendering it \u2014 ' +
                'retry, or split the story into fewer beats.';
        case 'comfyui_output_not_found':
            return 'ComfyUI finished but the LongVideos workflow produced no video. ' +
                'Check the ComfyUI console, then retry.';
        case 'generation_cancelled':
            return 'Long video generation cancelled.';
        case 'generation_busy':
            return err.message;
        case 'comfyui_missing_model':
        case 'comfyui_missing_node':
        case 'comfyui_oom':
        case 'comfyui_validation_error':
        case 'comfyui_api_error':
        case 'comfyui_empty_output':
            return err.message;
        default:
            return 'Long video generation failed: ' + (err.message || 'unknown error');
    }
}

// Execute an approval-card action (button click or a typed decision).
async function handleDirectorAction(req, res, ctx, production, action) {
    const { conversationId, message, provider, model, think } = ctx;
    if (action.productionId && production && action.productionId !== production.id) {
        const text = 'Director \u2014 That card belongs to an earlier production. ' +
            'Use the newest Director card, or start a new production.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }
    const validation = director.validateAction(production, action);
    if (!validation.ok) {
        sseWrite(res, { chunk: 'Director \u2014 ' + validation.reason });
        sseWrite(res, { done: true, fullReply: 'Director \u2014 ' + validation.reason });
        res.end();
        return;
    }

    if (action.type === director.ACTIONS.CANCEL) {
        const status = generationQueue.getStatus();
        if (status.active && (!conversationId || status.active.conversationId === conversationId)) {
            imageGenerator.cancelActive(status.active.id);
            comfyui.interrupt().catch(() => {});
        }
        director.cancel(production);
        ugcStudio.syncDirectorOutcome(production.conversationId, production.id, 'cancelled', { message: 'Production cancelled.' });
        taskState.clearTask(conversationId);
        const text = 'Director \u2014 Production cancelled.';
        sseWrite(res, { chunk: text });
        sseWrite(res, { done: true, fullReply: text });
        res.end();
        return;
    }

    if (action.type === director.ACTIONS.APPROVE || action.type === director.ACTIONS.GENERATE_VIDEO) {
        await runDirectorVideoStage(req, res, ctx, production);
        return;
    }

    if (action.type === director.ACTIONS.UPSCALE_IMAGE) {
        await runDirectorUpscaleStage(req, res, ctx, production);
        return;
    }

    if (action.type === director.ACTIONS.MODIFY_DIRECTION) {
        const feedback = String(action.direction || message || '').trim();
        await prepareDirectorLlm(provider, model);
        const prompt = await director.applyDirectionUpdate(production, feedback, { provider, model, think });
        await runDirectorImageStage(req, res, ctx, production, { regenerate: true, prompt });
        return;
    }

    // regenerate_image
    await runDirectorImageStage(req, res, ctx, production, { regenerate: true });
}

// Handle a "start ComfyUI" chat command over the already-open SSE stream.
// Shows a status line while the process boots, then streams a short result
// reply (which the client persists like any other assistant message).
async function handleStartComfyUIChat(req, res, opts) {
    const { conversationId, message } = opts;
    try {
        if (await comfyui.isAvailable()) {
            const reply = 'ComfyUI is already running.';
            sseWrite(res, { chunk: reply });
            sseWrite(res, { done: true, fullReply: reply });
            res.end();
            return;
        }

        sseWrite(res, { generating: 'Starting ComfyUI...' });
        console.log('[comfyui] Start requested from chat:', conversationId);
        const result = await comfyuiLauncher.start();
        activityLog.record({
            type: 'system',
            title: 'ComfyUI started',
            detail: result.label ? 'Launched via ' + result.label : 'Launched'
        });
        const reply = 'ComfyUI is up and reachable now. You can generate images and videos.';
        sseWrite(res, { chunk: reply });
        sseWrite(res, { done: true, fullReply: reply });
        res.end();
    } catch (err) {
        console.error('[comfyui] Start failed:', err.message);
        sseWrite(res, { error: 'I could not start ComfyUI. ' + err.message });
        res.end();
    }
}

// Handle an image-generation chat request over SSE. Emits a "generating"
// status event, then an "image" event with the chat-ready payload, or an
// "error" event on failure. The active task is only marked completed after the
// tool actually finishes — never before.
async function handleImageGenerationStream(req, res, opts) {
    const { provider, model, conversationId, message, imagePrompt, action, previousPrompt, think } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        // Pending job: drop it from the queue. Running job: abort the waiter
        // and interrupt ComfyUI so an abandoned client doesn't leave a
        // generation churning and then writing an orphan file + history entry.
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Generating image...' });
    };

    try {
        // Variations: generate 1-4 images in one turn. A fixed seed gives a
        // reproducible set (seed, seed+1, ...); random mode picks a fresh base.
        // A Director frame is always a single image from one seed. An
        // identity-guided generation is always a single reference-guided edit.
        const identity = opts.identity && opts.identity.sourceAbs ? opts.identity : null;
        const genSettings = imageGenerator.effectiveSettings();
        const variations = (opts.director || identity)
            ? 1
            : Math.max(1, Math.min(4, Number(genSettings.variations) || 1));
        const baseSeed = imageGenerator.resolveSeed(
            genSettings,
            opts.director ? opts.seed : null
        );

        sseWrite(res, {
            generating: identity
                ? 'Generating image of ' + identity.characterName + '...'
                : (variations > 1 ? 'Generating ' + variations + ' images...' : 'Generating image...')
        });

        const results = [];
        for (let i = 0; i < variations; i++) {
            if (i > 0) sseWrite(res, { generating: 'Generating image ' + (i + 1) + ' of ' + variations + '...' });
            // Reference-guided generation: the approved base image is the edit
            // source and the selected identity references condition the result,
            // so the character's identity is preserved while the scene changes.
            // The output is pinned to the global image settings (aspect ratio +
            // size), never the identity sheet's dimensions.
            const promise = identity
                ? imageGenerator.editImage(identity.sourceAbs, identity.instruction, {
                    references: identity.references,
                    width: genSettings.width,
                    height: genSettings.height,
                    provider, model, conversationId, onQueued, onStart,
                    seed: baseSeed + i,
                    label: 'identity image generation', kind: 'image_generation'
                })
                : imageGenerator.generateImage(imagePrompt, {
                    provider, model, conversationId, onQueued, onStart,
                    seed: baseSeed + i,
                    label: 'image generation', kind: 'image_generation'
                });
            queueId = promise.queueId || null;
            results.push(await promise);
        }
        const result = results[0];

        // Director opening frame: record it on the production and stop at the
        // approval checkpoint. The video stage only runs after the user approves.
        if (opts.director && opts.director.productionId) {
            const production = director.getProduction(conversationId);
            if (production) {
                let rawFilename = String(result.url || '').split('?')[0].split('/').pop();
                try { rawFilename = decodeURIComponent(rawFilename); } catch (err) { /* keep raw */ }
                director.markImageReady(production, {
                    url: result.url,
                    rawFilename,
                    prompt: imagePrompt,
                    seed: result.seed
                });
                const existingDirectorParams = taskState.getTask(conversationId).parameters || {};
                taskState.setTask(conversationId, {
                    type: 'image',
                    operation: 'generate',
                    prompt: imagePrompt,
                    generatedAsset: result.url,
                    parameters: Object.assign({}, existingDirectorParams, {
                        width: result.width,
                        height: result.height,
                        seed: result.seed
                    }),
                    lastImage: {
                        prompt: imagePrompt,
                        originalPrompt: taskState.getTask(conversationId).originalPrompt || imagePrompt,
                        creative_mode: 'none',
                        explicit_constraints: production.brief.explicitConstraints || [],
                        attributes: production.image ? production.image.attributes : null
                    },
                    status: 'completed',
                    lastAction: 'director opening frame'
                });
                const imageMarkdown = results
                    .map((r) => '![' + 'opening frame' + '](' + r.url + ')')
                    .join('\n\n');
                sseWrite(res, {
                    director: director.buildCard(
                        production,
                        director.renderImageApprovalContent(production, imageMarkdown)
                    )
                });
                await vramManager.freeComfyModels('director image stage');
                res.end();
                return;
            }
        }

        // Tool succeeded — now update task context and generate the user-facing
        // response based on the actual result.
        const existingParams = taskState.getTask(conversationId).parameters || {};
        taskState.setTask(conversationId, {
            prompt: imagePrompt,
            generatedAsset: result.url,
            parameters: Object.assign({}, existingParams, {
                width: result.width,
                height: result.height,
                seed: result.seed,
                variations: results.length
            }),
            // Image lineage survives later video tasks so "another image"
            // keeps the style context even after a video was generated.
            lastImage: {
                prompt: imagePrompt,
                originalPrompt: taskState.getTask(conversationId).originalPrompt || imagePrompt,
                creative_mode: existingParams.creative_mode || 'none',
                explicit_constraints: existingParams.explicit_constraints || [],
                attributes: existingParams.attributes || null
            },
            status: 'completed',
            lastAction: action || 'generate'
        });

        // The user-facing prompt: a character-aware generation carries a long
        // internal IDENTITY/SCENE/DO NOT instruction that must never be shown.
        // `displayPrompt` (when supplied) is the clean scene request.
        const showPrompt = opts.displayPrompt || imagePrompt;
        const summary = await taskRouter.buildSuccessReply({
            action: action || 'generate',
            prompt: showPrompt,
            previousPrompt: previousPrompt || null,
            provider,
            model,
            think,
            // ComfyUI still holds the image weights here; do not reload the chat
            // model on top of them (see buildSuccessReply).
            deterministic: true
        });

        const content =
            summary + '\n\n' +
            '**Prompt:** ' + showPrompt + '\n\n' +
            results.map((r) => '![' + 'image' + '](' + r.url + ')').join('\n\n');

        sseWrite(res, {
            image: {
                url: result.url,
                content,
                meta: result.meta || null,
                images: results.map((r) => ({ url: r.url, seed: r.seed, meta: r.meta || null }))
            }
        });
        res.end();
    } catch (err) {
        console.error('[image-generator] Generation failed:', err.message, '\n', err.stack);
        if (opts.director && opts.director.productionId) {
            const production = director.getProduction(conversationId);
            if (production) {
                if (err.code === 'generation_cancelled') {
                    director.cancel(production);
                    sseWrite(res, {
                        director: director.buildCard(
                            production,
                            director.renderCancelledContent(production)
                        )
                    });
                } else {
                    taskState.setTask(conversationId, { status: 'failed' });
                    const friendly = friendlyImageError(err);
                    director.markImageFailed(production, friendly);
                    sseWrite(res, {
                        director: director.buildCard(
                            production,
                            director.renderFailureContent(production, 'image', friendly)
                        )
                    });
                }
                res.end();
                return;
            }
        }
        if (err.code !== 'generation_cancelled') {
            taskState.setTask(conversationId, { status: 'failed' });
        }
        sseWrite(res, { error: friendlyImageError(err) });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

// @-picker references reach the edit pipeline in one of two shapes: numbered
// markdown images persisted for display (![reference N](/generated/file)) or
// inline @imageN tokens typed/picked in the composer. Both carry the reference
// position, which the Qwen editor addresses as "image 1", "image 2", … — so
// "make @image1 hold @image2 at @image3" becomes
// "make image 1 hold image 2 at image 3". Unnumbered upload/generated markdown
// is dropped like before.
const REFERENCE_TOKEN_RE = /@image\s*(\d+)\b/gi;
const NUMBERED_REFERENCE_RE = /!\[[^\]]*?reference\s*(\d+)[^\]]*?\]\(\/(?:generated|images)\/[^)]+\)/gi;

function materializeEditInstruction(text) {
    const out = String(text || '')
        .replace(NUMBERED_REFERENCE_RE, (match, n) => ' image ' + n + ' ')
        .replace(REFERENCE_TOKEN_RE, (match, n) => ' image ' + n + ' ')
        .replace(/!\[[^\]]*\]\(\/images\/[^)]+\)/g, ' ')
        .replace(/!\[[^\]]*\]\(\/generated\/[^)]+\)/g, ' ');
    return out.replace(/\s{2,}/g, ' ').trim();
}

// Resolve the source image for an edit: a fresh /images/ upload
// referenced in the message wins, otherwise the conversation's latest
// generated image. Returns { absPath, kind, rawFilename } or null.
function resolveEditSource(userText, conversationId) {
    const uploadMatch = String(userText || '').match(/\/images\/([^\s)\]}"']+)/);
    if (uploadMatch) {
        const safeName = path.basename(decodeURIComponent(uploadMatch[1]).split('?')[0]);
        const fullPath = path.join(IMAGES_DIR, safeName);
        if (safeName && fullPath.startsWith(IMAGES_DIR) && fs.existsSync(fullPath)) {
            return { absPath: fullPath, kind: 'upload', rawFilename: safeName };
        }
    }
    // A generated-image reference embedded in the message (the @ picker) wins
    // over the conversation's latest output so the edit targets that exact file.
    const reference = resolveReferenceSource((String(userText || '').match(/\/generated\/([^\s)\]}"']+)/) || [])[1]);
    if (reference) return reference;
    return resolveGeneratedEditSource(conversationId);
}

function resolveGeneratedEditSource(conversationId) {
    const found = resolveUpscaleSource(conversationId);
    if (!found) return null;
    if (!/\.(?:png|jpe?g|webp)$/i.test(found.rawFilename)) return null;
    const fullPath = path.join(GENERATED_DIR, path.basename(found.rawFilename));
    if (!fullPath.startsWith(GENERATED_DIR) || !fs.existsSync(fullPath)) return null;
    return { absPath: fullPath, kind: 'generated', rawFilename: path.basename(found.rawFilename) };
}

// Handle an edit chat request over SSE. Emits a "generating" status
// event, then an "image" event with the edited result, or an "error" event.
async function handleImageEditStream(req, res, opts) {
    const { provider, model, conversationId, message, instruction, action, previousPrompt, sourceOverride, referenceSources, think } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        // Pending job: drop it from the queue. Running job: abort the waiter
        // and interrupt ComfyUI so an abandoned client doesn't leave a
        // generation churning and then writing an orphan file + history entry.
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Editing image...' });
    };

    try {
        const resolvedRefs = (Array.isArray(referenceSources) ? referenceSources : []).filter(Boolean);
        const source = resolvedRefs[0] || sourceOverride || resolveEditSource(message, conversationId);
        if (!source) {
            taskState.setTask(conversationId, { status: 'failed' });
            sseWrite(res, { error: "I couldn't find an image to edit. Attach a photo or generate an image first, then describe the change." });
            res.end();
            return;
        }
        if (!instruction || !instruction.trim()) {
            taskState.setTask(conversationId, { status: 'failed' });
            sseWrite(res, { error: 'Describe what to change in the image.' });
            res.end();
            return;
        }

        sseWrite(res, { generating: 'Editing image...' });

        const referencePaths = resolvedRefs.slice(1).map((s) => s.absPath);
        const promise = imageGenerator.editImage(source.absPath, instruction, {
            provider, model, conversationId, onQueued, onStart,
            label: 'image edit', kind: 'image_edit',
            references: referencePaths
        });
        queueId = promise.queueId || null;
        const result = await promise;

        const existingParams = taskState.getTask(conversationId).parameters || {};
        taskState.setTask(conversationId, {
            prompt: instruction,
            generatedAsset: result.url,
            parameters: Object.assign({}, existingParams, {
                width: result.width,
                height: result.height,
                edit: {
                    source: source.rawFilename,
                    references: resolvedRefs.slice(1).map((s) => s.rawFilename)
                }
            }),
            // An edit supersedes the prior image lineage so "generate another
            // image" after an edit rebases onto the edited result, not the
            // pre-edit prompt.
            lastImage: {
                prompt: instruction,
                originalPrompt: taskState.getTask(conversationId).originalPrompt || instruction,
                creative_mode: existingParams.creative_mode || 'none',
                explicit_constraints: existingParams.explicit_constraints || [],
                attributes: existingParams.attributes || null
            },
            status: 'completed',
            lastAction: action || 'edit'
        });

        const summary = await taskRouter.buildSuccessReply({
            action: action || 'generate',
            prompt: instruction,
            previousPrompt: previousPrompt || null,
            provider,
            model,
            think,
            // ComfyUI still holds the edit weights here; keep the chat model out.
            deterministic: true
        });

        const content =
            summary + '\n\n' +
            '**Edit:** ' + instruction + '\n\n' +
            '![' + 'edited image' + '](' + result.url + ')';

        sseWrite(res, { image: { url: result.url, content, meta: result.meta || null } });
        res.end();
    } catch (err) {
        console.error('[image-generator] Edit failed:', err.message, '\n', err.stack);
        if (err.code !== 'generation_cancelled') {
            taskState.setTask(conversationId, { status: 'failed' });
        }
        sseWrite(res, { error: friendlyImageError(err) });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

function friendlyImageError(err) {
    switch (err.code) {
        case 'comfyui_unavailable':
            return 'ComfyUI is not running. Start ComfyUI, then try again.';
        case 'comfyui_missing_nodes':
            return err.message;
        case 'comfyui_krea2_clip_unsupported':
            return err.message;
        case 'comfyui_clip_type_unsupported':
            return err.message;
        case 'comfyui_validation_error':
            return err.message;
        case 'comfyui_generation_error':
            return err.message;
        case 'comfyui_oom':
        case 'comfyui_missing_model':
        case 'comfyui_missing_node':
        case 'comfyui_empty_output':
        case 'comfyui_api_error':
            return err.message;
        case 'comfyui_timeout':
            return 'Image generation timed out. ComfyUI may be overloaded — please try again.';
        case 'comfyui_output_not_found':
            return 'ComfyUI finished but did not produce an image. Check the ComfyUI console, then try again.';
        case 'generation_busy':
            return err.message;
        case 'generation_cancelled':
            return 'Generation cancelled. It was removed from the queue before it started.';
        case 'edit_source_missing':
            return err.message;
        case 'upscale_source_missing':
            return 'The image to upscale could not be found on disk. It may have been deleted.';
        default:
            return 'Image generation failed: ' + (err.message || 'unknown error');
    }
}

async function handleVideoGenerationStream(req, res, opts) {
    const {
        provider, model, conversationId, message, videoPrompt,
        structuredRequest, action, previousPrompt, videoMode, sourceImageRawFilename,
        referenceImages, duration, width, height, think
    } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        // Pending job: drop it from the queue. Running job: abort the waiter
        // and interrupt ComfyUI so an abandoned client doesn't leave a
        // generation churning and then writing an orphan file + history entry.
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Generating video...' });
    };

    try {
        sseWrite(res, { generating: 'Generating video...' });

        const opts2 = { provider, model, conversationId, onQueued, onStart, label: 'video generation', kind: 'video_generation' };
        if (structuredRequest) {
            if (structuredRequest.parameters) opts2.parameters = structuredRequest.parameters;
            if (structuredRequest.modifier) opts2.modifier = structuredRequest.modifier;
            if (previousPrompt) opts2.previousPrompt = previousPrompt;
        }
        if (videoMode) opts2.mode = videoMode;
        if (sourceImageRawFilename) opts2.sourceImageRawFilename = sourceImageRawFilename;
        if (Array.isArray(referenceImages) && referenceImages.length) opts2.referenceImages = referenceImages;
        if (duration) opts2.duration = duration;
        if (width) opts2.width = width;
        if (height) opts2.height = height;
        opts2.onProgress = (stage) => {
            if (stage === 'face-refine') sseWrite(res, { generating: 'Refining faces...' });
        };

        console.log('[video] source image:', opts2.sourceImageRawFilename || null);
        console.log('[video] mode:', opts2.mode || 't2va');
        console.log('[video] user request:', message);
        console.log('[video] H3 director prompt generated:', videoPrompt);

        const promise = videoGenerator.generateVideo(videoPrompt, opts2);
        queueId = promise.queueId || null;
        const result = await promise;

        // Manual-only upscale: the RTX 4K pass runs only when the user asks
        // ("upscale this video" -> handleVideoUpscaleStream), just like image
        // upscale. No automatic pass here.
        const finalResult = result;

        // Director production: the approved frame is now a finished video.
        if (opts.director && opts.director.productionId) {
            const production = director.getProduction(conversationId);
            if (production) {
                director.markVideoReady(production, {
                    url: finalResult.url,
                    prompt: videoPrompt
                });
                // If this production came from a UGC handoff, mark the linked
                // project complete so it stops being an active workflow.
                ugcStudio.syncDirectorOutcome(conversationId, production.id, 'completed', { url: finalResult.url });
                const existingDirectorParams = taskState.getTask(conversationId).parameters || {};
                taskState.setTask(conversationId, {
                    type: 'video',
                    operation: 'generate',
                    prompt: videoPrompt,
                    generatedAsset: finalResult.url,
                    videoMode: finalResult.mode || opts2.mode || 'i2va',
                    sourceImage: opts2.sourceImageRawFilename || null,
                    parameters: Object.assign({}, existingDirectorParams, {
                        width: finalResult.width || existingDirectorParams.width || null,
                        height: finalResult.height || existingDirectorParams.height || null,
                        duration: (production.video && production.video.duration) || null,
                        video: (finalResult.meta && finalResult.meta.video) || existingDirectorParams.video || null
                    }),
                    status: 'completed',
                    lastAction: 'director video'
                });
                const videoMarkdown =
                    '<video class="md-video" preload="metadata" playsinline src="' +
                    finalResult.url + '"></video>';
                sseWrite(res, {
                    director: director.buildCard(
                        production,
                        director.renderVideoCompleteContent(production, videoMarkdown)
                    )
                });
                await vramManager.freeComfyModels('director run');
                res.end();
                return;
            }
        }

        // Mark the task completed with the video result.
        const existingParams = taskState.getTask(conversationId).parameters || {};
        taskState.setTask(conversationId, {
            prompt: videoPrompt,
            generatedAsset: finalResult.url,
            videoMode: finalResult.mode || opts2.mode || 't2va',
            sourceImage: opts2.sourceImageRawFilename || null,
            parameters: Object.assign({}, existingParams, {
                width: finalResult.width || existingParams.width || null,
                height: finalResult.height || existingParams.height || null,
                video: (finalResult.meta && finalResult.meta.video) || existingParams.video || null,
                refined: Boolean(finalResult.refined),
                refineError: finalResult.refineError || null
            }),
            status: 'completed',
            lastAction: message || action || 'generate'
        });

        const summary = await taskRouter.buildSuccessReply({
            action: action || 'generate',
            prompt: videoPrompt,
            previousPrompt: previousPrompt || null,
            provider,
            model,
            taskType: 'video',
            think,
            // ComfyUI still holds the video weights here; reloading the 6GB chat
            // model on top of them is what made the machine unresponsive.
            deterministic: true
        });

        // Compact acceleration note, only when First Block Cache is active. The
        // full breakdown lives in the generated-history metadata + server log.
        const accel = (finalResult.meta && finalResult.meta.video && finalResult.meta.video.acceleration)
            || finalResult.acceleration || null;
        const accelLine = (accel && accel.firstBlockCache)
            ? '\n\n**Acceleration:** First Block Cache ' + accel.firstBlockCache +
              ' · Attention ' + accel.attention +
              ' · Turbo LoRA ' + (accel.turbo ? 'on' : 'off')
            : '';
        const content =
            summary + '\n\n' +
            '**Prompt:** ' + videoPrompt + accelLine + '\n\n' +
            '<video class="md-video" preload="metadata" playsinline src="' + finalResult.url + '"></video>';

        sseWrite(res, {
            video: {
                url: finalResult.url,
                content,
                meta: finalResult.meta || null,
                refined: Boolean(finalResult.refined),
                refineError: finalResult.refineError || null,
                upscale: null
            }
        });
        res.end();
    } catch (err) {
        console.error('[video-generator] Generation failed:', err.message, '\n', err.stack);
        if (opts.director && opts.director.productionId) {
            const production = director.getProduction(conversationId);
            if (production) {
                if (err.code === 'generation_cancelled') {
                    director.cancel(production);
                    ugcStudio.syncDirectorOutcome(conversationId, production.id, 'cancelled', { message: 'Production cancelled.' });
                    sseWrite(res, {
                        director: director.buildCard(
                            production,
                            director.renderCancelledContent(production)
                        )
                    });
                } else {
                    taskState.setTask(conversationId, { status: 'failed' });
                    const friendly = friendlyVideoError(err);
                    director.markVideoFailed(production, friendly);
                    ugcStudio.syncDirectorOutcome(conversationId, production.id, 'failed', { message: friendly });
                    sseWrite(res, {
                        director: director.buildCard(
                            production,
                            director.renderFailureContent(production, 'video', friendly)
                        )
                    });
                }
                res.end();
                return;
            }
        }
        if (err.code !== 'generation_cancelled') {
            taskState.setTask(conversationId, { status: 'failed' });
        }
        sseWrite(res, { error: friendlyVideoError(err) });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

// Handle a manual video-upscale chat request over SSE. Mirrors
// handleImageUpscaleStream: the conversation's previously generated video is
// always the source; runs only when the user asks for it. Engine comes from
// the shared upscale settings (RTX fast path by default for video).
async function handleVideoUpscaleStream(req, res, opts) {
    const { provider, model, conversationId, message } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        // Pending job: drop it from the queue. Running job: abort the waiter
        // and interrupt ComfyUI so an abandoned client doesn't leave a
        // generation churning and then writing an orphan file + history entry.
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Upscaling video...' });
    };

    try {
        const source = resolveVideoUpscaleSource(conversationId);
        if (!source) {
            taskState.setTask(conversationId, { status: 'failed' });
            res.write(`data: ${JSON.stringify({ error: "I couldn't find a generated video in this conversation to upscale. Generate a video first, then ask me to upscale it." })}\n\n`);
            res.end();
            return;
        }

        const prevTask = taskState.getTask(conversationId);
        const basePrompt = videoGenerator.stripVideoLoraTriggerWords(
            (source.meta && source.meta.prompt) || prevTask.prompt || message
        );
        taskState.setTask(conversationId, {
            type: 'video',
            operation: 'upscale',
            prompt: basePrompt,
            originalPrompt: prevTask.originalPrompt || basePrompt,
            lastAction: 'upscale',
            status: 'running'
        });

        sseWrite(res, { generating: 'Upscaling video...' });

        const promise = videoGenerator.upscaleVideo(source.rawFilename, {
            conversationId, onQueued, onStart, label: 'video upscale', kind: 'video_upscale'
        });
        queueId = promise.queueId || null;
        const result = await promise;

        const existingParams = taskState.getTask(conversationId).parameters || {};
        const upscaleInfo = {
            originalUrl: '/generated/' + encodeURIComponent(source.rawFilename),
            originalFilename: source.rawFilename,
            upscaledUrl: result.url,
            upscaledFilename: result.filename,
            engine: result.engine,
            resolution: result.resolution,
            scale: result.scale,
            quality: result.quality,
            profile: result.profile,
            noise: result.noise,
            sourceWidth: result.sourceWidth || null,
            sourceHeight: result.sourceHeight || null,
            width: result.width || null,
            height: result.height || null
        };
        taskState.setTask(conversationId, {
            prompt: basePrompt,
            generatedAsset: result.url,
            parameters: Object.assign({}, existingParams, {
                upscale: upscaleInfo
            }),
            status: 'completed',
            lastAction: 'upscale'
        });

        const dimPart = (result.sourceWidth && result.sourceHeight && result.width && result.height)
            ? ' from ' + result.sourceWidth + 'x' + result.sourceHeight +
              ' to **' + result.width + 'x' + result.height + '**'
            : (result.width && result.height
                ? ' to **' + result.width + 'x' + result.height + '**'
                : '');
        const content =
            result.engine === 'seedvr2'
                ? 'Upscaled your video' + dimPart + ' (**' + result.resolution + 'p** target, ' + result.profile + ', noise: ' + result.noise + ').\n\n' +
                  '**SeedVR2 Pass:** diffusion detail restoration.\n\n' +
                  '<video class="md-video" preload="metadata" playsinline src="' + result.url + '"></video>'
                : 'Upscaled your video' + dimPart + ' (**' + result.scale + 'x** RTX super-resolution, ' + result.quality + ').\n\n' +
                  '**RTX Pass:** fast single-pass upscale.\n\n' +
                  '<video class="md-video" preload="metadata" playsinline src="' + result.url + '"></video>';

        console.log('[video] Manual upscale (' + result.engine + '):', result.filename);
        sseWrite(res, { video: { url: result.url, content, meta: result.meta || null, upscale: upscaleInfo } });
        res.end();
    } catch (err) {
        console.error('[video-generator] Upscale failed:', err.message, '\n', err.stack);
        if (err.code !== 'generation_cancelled') {
            taskState.setTask(conversationId, { status: 'failed' });
        }
        sseWrite(res, { error: friendlyVideoError(err) });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

function friendlyVideoError(err) {
    switch (err.code) {
        case 'upscale_source_missing':
            return 'The video to upscale could not be found on disk. It may have been deleted.';
        case 'comfyui_unavailable':
            return 'ComfyUI is not running. Start ComfyUI, then try again.';
        case 'comfyui_missing_nodes':
            return err.message;
        case 'rtx_video_upscale_setup_required':
            return err.message;
        case 'facerefine_failed':
            return err.message;
        case 'h3_turbo_lora_missing':
        case 'h3_turbo_nodes_missing':
            return err.message;
        case 'h3_fbcache_node_missing':
        case 'h3_fbcache_invalid':
        case 'h3_fbcache_duplicate':
        case 'h3_fbcache_input_missing':
        case 'h3_fbcache_output_unconnected':
        case 'h3_fbcache_not_h3':
        case 'h3_fbcache_cache_conflict':
            return err.message;
        case 'comfyui_generation_error':
        case 'comfyui_oom':
        case 'comfyui_missing_model':
        case 'comfyui_missing_node':
        case 'comfyui_empty_output':
        case 'comfyui_api_error':
        case 'comfyui_validation_error':
            return err.message;
        case 'comfyui_timeout':
            return 'Video generation timed out. ComfyUI may be overloaded — please try again.';
        case 'comfyui_output_not_found':
            return 'ComfyUI finished but did not produce a video. Check the ComfyUI console, then try again.';
        case 'generation_busy':
            return err.message;
        case 'generation_cancelled':
            return 'Generation cancelled. It was removed from the queue before it started.';
        default:
            return 'Video generation failed: ' + (err.message || 'unknown error');
    }
}

// True when a data/generated filename actually exists on disk. Chat replies
// can hallucinate /generated/ links (e.g. after a typo'd upscale request
// falls through to chat); resolvers must skip those so the next real upscale
// still finds the last genuine asset instead of the fake one.
function generatedFileExists(rawFilename) {
    try {
        const safeName = path.basename(String(rawFilename || '').split('?')[0]);
        if (!safeName) return false;
        let decoded = safeName;
        try { decoded = decodeURIComponent(safeName); } catch (err) { /* keep raw */ }
        const fullPath = path.join(GENERATED_DIR, path.basename(decoded));
        if (!fullPath.startsWith(GENERATED_DIR)) return false;
        return fs.existsSync(fullPath);
    } catch (err) {
        return false;
    }
}

// Find the generated image to upscale for a conversation: the last
// /generated/<file> link in the assistant messages (so consecutive upscales
// chain), falling back to the active task's latest generated asset. An explicit
// filename short-circuits the scan. Returns { rawFilename, meta } or null.
function resolveUpscaleSource(conversationId, explicitFilename) {
    if (explicitFilename) {
        const safeName = path.basename(String(explicitFilename || '').split('?')[0]);
        if (!safeName) return null;
        return { rawFilename: safeName, meta: findGeneratedMeta(safeName) };
    }
    if (!conversationId) return null;

    const messages = conversationService.getMessages(conversationId) || [];
    const urlRe = /\/generated\/([^\s)\]}"']+)/g;
    const candidates = [];
    for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const content = String(m.content || '');
        let match;
        urlRe.lastIndex = 0;
        while ((match = urlRe.exec(content))) candidates.push(match[1]);
    }
    // Walk newest-first so hallucinated / deleted links are skipped in favor
    // of the last genuine file still on disk. This is what lets a conversation
    // recover after a chat reply invents a /generated/ URL.
    for (let i = candidates.length - 1; i >= 0; i--) {
        let rawFilename = candidates[i];
        try { rawFilename = decodeURIComponent(rawFilename); } catch (err) { /* keep raw */ }
        if (generatedFileExists(rawFilename)) {
            return { rawFilename: path.basename(rawFilename), meta: findGeneratedMeta(rawFilename) };
        }
    }
    // No on-disk match in history: fall back to the active task asset (the
    // caller reports a clear source-missing error when that is gone too).
    const asset = taskState.getTask(conversationId).generatedAsset;
    if (asset) {
        const rawFilename = String(asset).split('/').pop();
        return { rawFilename, meta: findGeneratedMeta(rawFilename) };
    }
    return null;
}

function findGeneratedMeta(rawFilename) {
    const name = decodeURIComponent(String(rawFilename || '')).split('/').pop();
    return generatedHistory.list().find((e) =>
        e.rawFilename === name || String(e.file).split('/').pop() === name) || null;
}

// Last image lineage for a conversation: the most recent assistant message
// that produced an image (not a video), with its stored "**Prompt:**".
// Used when a new image is requested while a video task is active (the
// ActiveTask prompt is then the H3 video prompt, not the image style), and
// when "another image" needs the previous style context. Returns
// { prompt } or null.
function findLastImagePromptInHistory(conversationId) {
    if (!conversationId) return null;
    const messages = conversationService.getMessages(conversationId) || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== 'assistant') continue;
        const content = String(m.content || '');
        if (!/\/generated\//.test(content)) continue;
        if (/<video[\s>]/i.test(content)) continue;
        if (/\.(?:mp4|webm|avi|mov)(\?.*)?(?:[\s)\]}"']|$)/i.test(content)) continue;
        const promptMatch = content.match(/\*\*Prompt:\*\*\s*([\s\S]*?)(?:\n\s*\n|\n\s*![\[]|$)/);
        if (promptMatch && promptMatch[1].trim()) {
            // Skip degenerate prompts left by earlier vague requests
            // ("Prompt: an image") so lineage keeps the last concrete style.
            const candidate = promptMatch[1].trim();
            try {
                if (imageGenerator.isVagueImageConcept(candidate)) continue;
            } catch (err) { /* fall through — accept the candidate */ }
            return { prompt: candidate };
        }
    }
    return null;
}

// Resolve an anaphoric new-image request ("generate me another image") to the
// conversation's image lineage. A vague concept with an "another / one more"
// marker means a fresh subject in the SAME style — never the literal words
// "an image". Returns the lineage concept { userPrompt, creativeMode,
// previousPrompt } or null when there is no lineage to continue.
function resolveAnotherImageConcept(conversationId, activeTask) {
    const task = activeTask || taskState.getTask(conversationId);
    const lineage = (task && task.lastImage) || null;
    const historyPrompt = findLastImagePromptInHistory(conversationId);
    const lineagePrompt = (lineage && lineage.prompt && !imageGenerator.isVagueImageConcept(lineage.prompt))
        ? lineage.prompt : null;
    const previousPrompt = lineagePrompt || (historyPrompt && historyPrompt.prompt) || (task && task.type === 'image' && !imageGenerator.isVagueImageConcept(task.prompt) ? task.prompt : '') || '';
    if (!previousPrompt) return null;
    const lineageConcept = (lineage && (lineage.originalPrompt || lineage.prompt)) || '';
    const userPrompt = (!imageGenerator.isVagueImageConcept(lineageConcept) && lineageConcept) || previousPrompt;
    const creativeMode = (lineage && lineage.creative_mode) ||
        (task && task.parameters && task.parameters.creative_mode) || 'none';
    const explicitConstraints = (lineage && lineage.explicit_constraints) ||
        (task && task.parameters && task.parameters.explicit_constraints) || [];
    return { userPrompt, creativeMode, explicitConstraints, previousPrompt };
}

// Find the generated video to upscale for a conversation: the last
// /generated/<file> link in the assistant messages that points to a video file
// (mp4, webm, avi, mov), falling back to the active task's latest generated
// asset. An explicit filename short-circuits the scan. Returns { rawFilename, meta } or null.
function resolveVideoUpscaleSource(conversationId, explicitFilename) {
    if (explicitFilename) {
        const safeName = path.basename(String(explicitFilename || '').split('?')[0]);
        if (!safeName) return null;
        return { rawFilename: safeName, meta: findGeneratedMeta(safeName) };
    }
    if (!conversationId) return null;

    const messages = conversationService.getMessages(conversationId) || [];
    const urlRe = /\/generated\/([^\s)\]}"']+)/g;
    const candidates = [];
    for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const content = String(m.content || '');
        let match;
        urlRe.lastIndex = 0;
        while ((match = urlRe.exec(content))) {
            const filename = match[1];
            if (/\.(?:mp4|webm|avi|mov)(\?.*)?$/i.test(filename)) {
                candidates.push(filename);
            }
        }
    }
    // Newest-first with an on-disk check, mirroring resolveUpscaleSource: a
    // hallucinated or since-replaced video link never blocks the real source.
    for (let i = candidates.length - 1; i >= 0; i--) {
        let rawFilename = candidates[i];
        try { rawFilename = decodeURIComponent(rawFilename); } catch (err) { /* keep raw */ }
        rawFilename = String(rawFilename).split('?')[0];
        if (generatedFileExists(rawFilename)) {
            return { rawFilename: path.basename(rawFilename), meta: findGeneratedMeta(rawFilename) };
        }
    }
    const asset = taskState.getTask(conversationId).generatedAsset;
    if (asset && /\.(?:mp4|webm|avi|mov)(\?.*)?$/i.test(String(asset))) {
        const rawFilename = String(asset).split('/').pop().split('?')[0];
        return { rawFilename, meta: findGeneratedMeta(rawFilename) };
    }
    return null;
}

// Handle an upscale chat request over SSE. Emits a "generating" status event,
// an "image" event with the before/after payload, or an "error" event. The
// conversation's previously generated image is always the source.
async function handleImageUpscaleStream(req, res, opts) {
    const { provider, model, conversationId, message } = opts;

    let queueId = null;
    const onClose = () => {
        if (!queueId) return;
        // Pending job: drop it from the queue. Running job: abort the waiter
        // and interrupt ComfyUI so an abandoned client doesn't leave a
        // generation churning and then writing an orphan file + history entry.
        if (imageGenerator.cancelQueued(queueId)) return;
        if (imageGenerator.isActive(queueId)) {
            imageGenerator.cancelActive(queueId);
            comfyui.interrupt().catch(() => {});
        }
    };
    req.on('close', onClose);
    const stopProgress = forwardComfyProgress(res);
    const onQueued = (position, id) => {
        queueId = id;
        sseWrite(res, { queued: { position, queueId: id } });
    };
    const onStart = () => {
        sseWrite(res, { generating: 'Upscaling image...' });
    };

    try {
        const source = resolveUpscaleSource(conversationId);
        if (!source) {
            taskState.setTask(conversationId, { status: 'failed' });
            res.write(`data: ${JSON.stringify({ error: "I couldn't find a generated image in this conversation to upscale. Generate an image first, then ask me to upscale it." })}\n\n`);
            res.end();
            return;
        }

        const prevTask = taskState.getTask(conversationId);
        // The metadata prompt is the final prompt sent to ComfyUI, which
        // includes the auto-prepended LoRA trigger words. Trigger words are
        // re-added at generation time, so store the clean version — otherwise
        // a follow-up modification prepends them again and they duplicate.
        const basePrompt = imageGenerator.stripLoraTriggerWords(
            (source.meta && source.meta.prompt) || prevTask.prompt || message
        );
        taskState.setTask(conversationId, {
            type: 'image',
            operation: 'upscale',
            prompt: basePrompt,
            originalPrompt: prevTask.originalPrompt || basePrompt,
            lastAction: 'upscale',
            status: 'running'
        });

        sseWrite(res, { generating: 'Upscaling image...' });

        const promise = imageGenerator.upscaleImage(source.rawFilename, {
            provider, model, conversationId, onQueued, onStart,
            label: 'image upscale', kind: 'image_upscale'
        });
        queueId = promise.queueId || null;
        const result = await promise;

        // The effective prompt stays the source image's generation prompt so a
        // follow-up modification builds on the same visual concept.
        const existingParams = taskState.getTask(conversationId).parameters || {};
        taskState.setTask(conversationId, {
            prompt: basePrompt,
            generatedAsset: result.url,
            parameters: Object.assign({}, existingParams, {
                width: result.width,
                height: result.height,
                upscale: {
                    engine: result.engine,
                    profile: result.profile,
                    noise: result.noise,
                    resolution: result.resolution,
                    source: source.rawFilename
                }
            }),
            lastImage: {
                prompt: basePrompt,
                originalPrompt: taskState.getTask(conversationId).originalPrompt || basePrompt,
                creative_mode: existingParams.creative_mode || 'none',
                explicit_constraints: existingParams.explicit_constraints || [],
                attributes: existingParams.attributes || null
            },
            status: 'completed',
            lastAction: 'upscale'
        });

        const sourceUrl = '/generated/' + encodeURIComponent(source.rawFilename);
        const engineLabel = result.engine === 'ultimate' ? 'Ultimate SD' : 'SeedVR2';
        const content =
            'Upscaled your image from ' + (result.sourceWidth || '?') + 'x' + (result.sourceHeight || '?') +
            ' to **' + result.width + 'x' + result.height + '** (' + engineLabel + ').\n\n' +
            '**Original:**\n![original](' + sourceUrl + ')\n\n' +
            '**Upscaled:**\n![upscaled](' + result.url + ')';

        sseWrite(res, { image: { url: result.url, content, meta: result.meta || null } });
        res.end();
    } catch (err) {
        console.error('[image-generator] Upscale failed:', err.message, '\n', err.stack);
        if (err.code !== 'generation_cancelled') {
            taskState.setTask(conversationId, { status: 'failed' });
        }
        sseWrite(res, { error: friendlyImageError(err) });
        res.end();
    } finally {
        req.removeListener('close', onClose);
        stopProgress();
    }
}

async function handleUnloadModel(req, res) {
    try {
        const body = await readBody(req);
        const provider = body.provider || 'ollama';
        const model = (body.model || '').trim();

        if (!model) {
            json(res, 400, { error: 'model is required' });
            return;
        }

        const result = await providers.unloadModel(provider, model);
        activityLog.record({ type: 'unload', title: 'Model unloaded', detail: model });
        json(res, 200, result);
    } catch (err) {
        json(res, 502, { error: err.message });
    }
}

// --- Static File Serving ---

function serveStatic(req, res, urlPath) {
    // Default to index.html for root
    let filePath = urlPath === '/' ? '/index.html' : urlPath;

    // Security: prevent directory traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');

    const fullPath = path.join(PUBLIC_DIR, filePath);

    // Ensure the resolved path is within PUBLIC_DIR
    if (!fullPath.startsWith(PUBLIC_DIR)) {
        send404(res);
        return;
    }

    fs.stat(fullPath, (err, stats) => {
        if (err || !stats.isFile()) {
            send404(res);
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(fullPath).pipe(res);
    });
}

// --- Helpers ---

function json(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function send404(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
}

// Stream a generated/uploaded media file, honouring HTTP Range requests.
// Without Range support a `<video preload="metadata">` makes the browser
// download the entire clip, which is what made the gallery so heavy; with it
// the browser fetches just the moov atom/seeked ranges.
function sendMediaFile(req, res, fullPath) {
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    let size;
    try {
        size = fs.statSync(fullPath).size;
    } catch (err) {
        send404(res);
        return;
    }
    const baseHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable'
    };
    const range = req.headers.range;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (match) {
            let start = match[1] === '' ? null : parseInt(match[1], 10);
            let end = match[2] === '' ? null : parseInt(match[2], 10);
            if (start === null && end !== null) {
                start = Math.max(0, size - end);
                end = size - 1;
            } else if (start !== null && end === null) {
                end = size - 1;
            }
            if (start !== null && end !== null && start <= end && start < size) {
                end = Math.min(end, size - 1);
                res.writeHead(206, Object.assign({}, baseHeaders, {
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
                    'Content-Length': end - start + 1
                }));
                fs.createReadStream(fullPath, { start, end }).pipe(res);
                return;
            }
            res.writeHead(416, { 'Content-Range': 'bytes */' + size });
            res.end();
            return;
        }
    }
    res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': size }));
    fs.createReadStream(fullPath).pipe(res);
}

// --- Server ---

// IPv4 addresses this machine exposes on the local network, used to print the
// LAN URL(s) at startup so other devices on the same WiFi can reach JARVIS.
function lanIPv4Addresses() {
    const addresses = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net && net.family === 'IPv4' && !net.internal) addresses.push(net.address);
        }
    }
    return addresses;
}

systemMonitor.init();
systemMonitor.start(2000);

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const urlPath = parsedUrl.pathname;

    // Resolve (and if needed set) the per-device session cookie before any
    // routing so handlers can scope data to this device.
    req.jarvisSession = resolveSession(req, res);

    // API routes take precedence
    if (await handleAPI(req, res, urlPath)) return;

    // Serve static files from public/
    serveStatic(req, res, urlPath);
});

server.listen(PORT, HOST, () => {
    console.log(`JARVIS server running at http://localhost:${PORT}`);
    const localOnly = HOST === '127.0.0.1' || HOST === 'localhost';
    const lan = localOnly ? [] : lanIPv4Addresses();
    if (!localOnly) {
        if (lan.length) {
            console.log('On your network (same WiFi): ' + lan.map((ip) => `http://${ip}:${PORT}`).join(', '));
        } else {
            console.log('On your network: no external IPv4 interface detected.');
        }
    }
    thumbnail.warm();
    activityLog.record({
        type: 'system',
        title: 'Server started',
        detail: 'http://localhost:' + PORT + (lan.length ? ' \u00B7 LAN ' + lan.map((ip) => `http://${ip}:${PORT}`).join(', ') : '')
    });
    vramManager.reconcileOnStartup().catch((err) => {
        console.warn('[vram-manager] Startup reconcile failed:', err.message);
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        process.exit(1);
    }
    console.error('Server error:', err);
});
