const http = require('http');
const fs = require('fs');
const path = require('path');
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
const modelSetup = require('./services/model-setup');
const generatedHistory = require('./services/generated-history');
const activityLog = require('./services/activity-log');
const comfyui = require('./services/comfyui');
const vramManager = require('./services/vram-manager');
const taskRouter = require('./services/task-router');
const taskState = require('./services/task-state');
const generationQueue = require('./services/generation-queue');
const GENERATED_DIR = path.join(__dirname, 'data', 'generated');
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
const UPLOAD_MIME_TO_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
};
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGES_MAX = 3;

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
    // for the Krea2 pipeline, plus the UNET/CLIP/VAE models ComfyUI has
    // available (null when ComfyUI is unreachable).
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
            const settings = videoGenerator.saveVideoSettings(body || {});
            // First-enable auto-install: turning FaceRefine on kicks off the
            // background ComfyUI-side install (custom nodes + pip packages +
            // face detector). Non-blocking; the VIDEO panel polls its progress.
            let faceRefineInstall = null;
            if (body && (body.faceRefineEnabled === true || body.faceRefineEnabled === 1 ||
                    String(body.faceRefineEnabled).toLowerCase() === 'true' || String(body.faceRefineEnabled) === '1')) {
                faceRefineInstall = faceRefine.ensureAutoInstall();
            }
            json(res, 200, { ok: true, settings, faceRefineInstall });
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

    // GET /api/setup/status — first-run setup guide state: ComfyUI paths,
    // Hugging Face token state, per-model install status, per-pack custom
    // node status, readiness flags, and the background download job.
    if (urlPath === '/api/setup/status' && req.method === 'GET') {
        try {
            json(res, 200, await modelSetup.getStatus());
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

    // GET /api/generated — all generated image metadata (newest first)
    if (urlPath === '/api/generated' && req.method === 'GET') {
        json(res, 200, { images: generatedHistory.list() });
        return true;
    }

    // GET /api/activity — recent activity feed for the dashboard widget
    if (urlPath === '/api/activity' && req.method === 'GET') {
        json(res, 200, {
            entries: activityLog.list(30),
            uptime: process.uptime(),
            startedAt: serverStartedAt
        });
        return true;
    }

    // DELETE /api/generated/:id — delete a generated image (history + file)
    const genDeleteMatch = urlPath.match(/^\/api\/generated\/([^/]+)$/);
    if (genDeleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(genDeleteMatch[1]);
        const removed = generatedHistory.remove(id);
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
            const source = resolveUpscaleSource(body.conversationId, body.filename);
            if (!source) {
                json(res, 404, { error: 'No generated image found to upscale. Generate an image first, then upscale it.' });
                return true;
            }
            const result = await imageGenerator.upscaleImage(source.rawFilename, {
                engine: body.engine,
                profile: body.profile,
                noise: body.noise,
                mode: body.mode,
                resolution: body.resolution,
                multiplier: body.multiplier,
                preScale: body.preScale,
                prompt: body.prompt,
                conversationId: body.conversationId || null,
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
            const source = resolveVideoUpscaleSource(body.conversationId, body.filename);
            if (!source) {
                json(res, 404, { error: 'No generated video found to upscale. Generate a video first, then upscale it.' });
                return true;
            }
            const result = await videoGenerator.upscaleVideo(source.rawFilename, {
                engine: body.engine,
                resolution: body.resolution,
                profile: body.profile,
                noise: body.noise,
                preScale: body.preScale,
                scale: body.scale,
                quality: body.quality,
                fps: body.fps,
                conversationId: body.conversationId || null,
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

    // GET /api/comfyui/status — ComfyUI availability, queue and device stats
    if (urlPath === '/api/comfyui/status' && req.method === 'GET') {
        try {
            const available = await comfyui.isAvailable();
            if (!available) {
                json(res, 200, { available: false, queue: null, system_stats: null });
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
        json(res, 200, generationQueue.getStatus());
        return true;
    }

    // POST /api/queue/cancel — cancel a queued job ({ queueId }), or the
    // active job ({ queueId, active: true } aborts via ComfyUI /interrupt).
    if (urlPath === '/api/queue/cancel' && req.method === 'POST') {
        try {
            const body = await readBody(req);
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
        json(res, 200, { conversations: conversationService.getAllConversations() });
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

    // PATCH /api/conversations/:id (rename)
    if (convMatch && req.method === 'PATCH') {
        handleRenameConversation(req, res, decodeURIComponent(convMatch[1]));
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

    // GET /generated/:file — serve generated images
    const generatedMatch = urlPath.match(/^\/generated\/([^/]+)$/);
    if (generatedMatch && req.method === 'GET') {
        const filename = decodeURIComponent(generatedMatch[1]);
        const safeName = path.basename(filename);
        const fullPath = path.join(GENERATED_DIR, safeName);
        if (!fullPath.startsWith(GENERATED_DIR) || !fs.existsSync(fullPath)) {
            send404(res);
            return true;
        }
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
        fs.createReadStream(fullPath).pipe(res);
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
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
        fs.createReadStream(fullPath).pipe(res);
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

// Read a referenced generated image as vision base64 (best-effort) so chat can
// answer questions about it. Oversized or unreadable files are skipped.
function referenceVisionImages(referenceImage) {
    const source = resolveReferenceSource(referenceImage);
    if (!source) return [];
    try {
        const buffer = fs.readFileSync(source.absPath);
        if (!buffer.length || buffer.length > UPLOAD_MAX_BYTES) return [];
        return [buffer.toString('base64')];
    } catch (err) {
        return [];
    }
}

// --- Conversation handlers ---

async function handleCreateConversation(req, res) {
    try {
        const body = await readBody(req);
        const conversation = conversationService.createConversation(body);
        json(res, 201, conversation);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}

function handleGetConversation(req, res, id) {
    const conversation = conversationService.getConversation(id);
    if (!conversation) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    json(res, 200, conversation);
}

async function handleRenameConversation(req, res, id) {
    try {
        const body = await readBody(req);
        const conversation = conversationService.renameConversation(id, body.title);
        if (!conversation) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }
        json(res, 200, conversation);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}

function handleDeleteConversation(req, res, id) {
    const messages = conversationService.getMessages(id);
    const removed = conversationService.deleteConversation(id);
    if (!removed) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    removeConversationImages(messages, id);
    taskState.clearTask(id);
    json(res, 200, { ok: true });
}

// Remove generated media files (images and videos) that were linked from a
// deleted conversation's messages, keeping the gallery in sync with what the
// chat actually references.
function removeConversationImages(messages, conversationId) {
    const wanted = new Set();
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
        if (wanted.has(basenameOf(entry))) idsToDelete.add(entry.id);
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
                if (otherName === decoded || otherName === childName) idsToDelete.add(other.id);
            });
        }
    });
    idsToDelete.forEach((entryId) => generatedHistory.remove(entryId));
}

function handleGetMessages(req, res, id) {
    if (!conversationService.getConversation(id)) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    json(res, 200, { messages: conversationService.getMessages(id) });
}

async function handleAddMessage(req, res, id) {
    try {
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
        const body = await readBody(req);
        const provider = body.provider || 'ollama';
        const model = body.model || '';
        const messages = conversationService.getMessages(id);
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

        if (!conversationService.getConversation(conversationId)) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }

        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        const sampling = resolveChatSampling(body);
        const contextMessages = contextBuilder.buildContext(conversationId, message, provider, model, '', chatImages);
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
        // Optional generated-image reference selected from the @ picker. It
        // becomes the source for an identity edit or an I2VA first frame.
        const referenceImage = sanitizeReferenceImage(body.reference || body.referenceImage || (Array.isArray(body.references) ? body.references[0] : null));
        if ((!message || typeof message !== 'string' || !message.trim()) && chatImages.length === 0 && !referenceImage) {
            json(res, 400, { error: 'message is required' });
            return;
        }

        if (!conversationService.getConversation(conversationId)) {
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

        // Route the message through the context-aware task router. The router
        // decides (before any tool runs) whether this message should start a new
        // task, continue/modify the active task, answer a question about it, or
        // is just unrelated conversation. The LLM's natural-language reply never
        // decides whether a tool executes — that decision lives here.
        const decision = await taskRouter.routeMessage({
            message,
            provider,
            model,
            conversationId,
            hasAttachedImage: chatImages.length > 0,
            referenceImage,
            think
        });

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

        // Krea2 identity edit: an attached upload or an explicit "edit this
        // image" edits a source image from a plain-language instruction while
        // preserving the rest (identity-edit LoRA, not a from-scratch regen).
        if (decision.shouldExecuteTool && decision.task === 'image_edit') {
            const instruction = imageGenerator.cleanEditInstruction(stripImageRefs(decision.updatedPrompt || message));
            const activeTask = taskState.getTask(conversationId);
            const action = (decision.intent === 'new_task' || decision.intent === 'switch_task') ? 'generate' : 'modify';
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
                sourceOverride: referenceImage ? resolveReferenceSource(referenceImage) : undefined,
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
            // regen of the rewritten prompt (see below). Identity edits only
            // run through the explicit image_edit branch above — i.e. when the
            // user attaches an upload or explicitly asks to "edit this image".
            // Vague follow-ups ("make her ...", "change her top ...") must not
            // trigger an edit: the edit LoRA returns the source unchanged for
            // such instructions, which looks like "the same exact image".

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

            // Track the task as running, then free VRAM and execute.
            const ctxPreviousPrompt = activeTask.prompt || null;
            taskState.setTask(conversationId, {
                type: 'image',
                operation: action,
                prompt: imagePrompt,
                lastAction: action,
                status: 'running'
            });
            if (action === 'generate') {
                taskState.setTask(conversationId, {
                    originalPrompt: structuredRequest ? structuredRequest.user_prompt : message,
                    parameters: Object.assign({}, taskState.getTask(conversationId).parameters, {
                        creative_mode: structuredRequest ? structuredRequest.creative_mode : 'none',
                        explicit_constraints: structuredRequest ? structuredRequest.explicit_constraints : [],
                        attributes: attributes || null
                    })
                });
            } else if (attributes) {
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
                action,
                previousPrompt: ctxPreviousPrompt,
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
        const chatVision = chatImages.concat(referenceVisionImages(referenceImage)).slice(0, CHAT_IMAGES_MAX);

        const contextMessages = contextBuilder.buildContext(
            conversationId,
            message,
            provider,
            model,
            decision.intent === 'task_question'
                ? taskRouter.renderActiveTaskContext(taskState.getTask(conversationId))
                : '',
            chatVision
        );

        let fullReply = '';
        const sampling = resolveChatSampling(body);

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
        const genSettings = imageGenerator.effectiveSettings();
        const variations = Math.max(1, Math.min(4, Number(genSettings.variations) || 1));
        const baseSeed = imageGenerator.resolveSeed(genSettings, null);

        sseWrite(res, { generating: variations > 1 ? 'Generating ' + variations + ' images...' : 'Generating image...' });

        const results = [];
        for (let i = 0; i < variations; i++) {
            if (i > 0) sseWrite(res, { generating: 'Generating image ' + (i + 1) + ' of ' + variations + '...' });
            const promise = imageGenerator.generateImage(imagePrompt, {
                provider, model, conversationId, onQueued, onStart,
                seed: baseSeed + i,
                label: 'image generation', kind: 'image_generation'
            });
            queueId = promise.queueId || null;
            results.push(await promise);
        }
        const result = results[0];

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

        const summary = await taskRouter.buildSuccessReply({
            action: action || 'generate',
            prompt: imagePrompt,
            previousPrompt: previousPrompt || null,
            provider,
            model,
            think
        });

        const content =
            summary + '\n\n' +
            '**Prompt:** ' + imagePrompt + '\n\n' +
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

// Strip attached-upload markdown refs from the user text so the edit
// instruction is clean prose, not image markup.
function stripImageRefs(text) {
    return String(text || '')
        .replace(/!\[[^\]]*\]\(\/images\/[^)]+\)/g, '')
        .replace(/!\[[^\]]*\]\(\/generated\/[^)]+\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Resolve the source image for an identity edit: a fresh /images/ upload
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

// Handle an identity-edit chat request over SSE. Emits a "generating" status
// event, then an "image" event with the edited result, or an "error" event.
async function handleImageEditStream(req, res, opts) {
    const { provider, model, conversationId, message, instruction, action, previousPrompt, sourceOverride, think } = opts;

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
        const source = sourceOverride || resolveEditSource(message, conversationId);
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

        const promise = imageGenerator.editImage(source.absPath, instruction, {
            provider, model, conversationId, onQueued, onStart,
            label: 'image edit', kind: 'image_edit'
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
                edit: { source: source.rawFilename }
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
            think
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
        case 'comfyui_edit_lora_missing':
            return err.message;
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
        duration, width, height, think
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
            think
        });

        const content =
            summary + '\n\n' +
            '**Prompt:** ' + videoPrompt + '\n\n' +
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
// the shared upscale settings (RTX fast path by default, like Mix Studio).
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

// --- Server ---

systemMonitor.init();
systemMonitor.start(2000);

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const urlPath = parsedUrl.pathname;

    // API routes take precedence
    if (await handleAPI(req, res, urlPath)) return;

    // Serve static files from public/
    serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
    console.log(`JARVIS server running at http://localhost:${PORT}`);
    activityLog.record({
        type: 'system',
        title: 'Server started',
        detail: 'http://localhost:' + PORT
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        process.exit(1);
    }
    console.error('Server error:', err);
});
