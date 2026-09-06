const http = require('http');
const fs = require('fs');
const path = require('path');

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
    '.map': 'application/json'
};

// --- Services ---

const systemMonitor = require('./services/system-monitor');
const conversationService = require('./server/conversation-service');
const contextBuilder = require('./server/context-builder');
const providers = require('./server/providers');
const models = require('./server/models');
const providerManager = require('./server/provider-manager');
const imageGenerator = require('./services/image-generator');
const generatedHistory = require('./services/generated-history');
const comfyui = require('./services/comfyui');
const vramManager = require('./services/vram-manager');
const GENERATED_DIR = path.join(__dirname, 'data', 'generated');

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
        } else if (provider === 'lmstudio') {
            status = providerManager.downloadModelLMStudio(modelId);
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
            require('./config-manager').setModelConfig(provider, modelId);
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
    // (unet, clip, clipType, vae, width, height, steps, cfg).
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

    // GET /api/generated — all generated image metadata (newest first)
    if (urlPath === '/api/generated' && req.method === 'GET') {
        json(res, 200, { images: generatedHistory.list() });
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
            json(res, 200, { ok: true, freed: 'comfyui-models' });
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

    // Unknown API route
    if (urlPath.startsWith('/api/')) {
        json(res, 404, { error: 'Not found' });
        return true;
    }

    return false;
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
    const removed = conversationService.deleteConversation(id);
    if (!removed) {
        json(res, 404, { error: 'Conversation not found' });
        return;
    }
    json(res, 200, { ok: true });
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
        const summary = await providers.summarize(provider, model, messages);
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
        if (!message || typeof message !== 'string' || !message.trim()) {
            json(res, 400, { error: 'message is required' });
            return;
        }

        if (!conversationService.getConversation(conversationId)) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }

        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        const contextMessages = contextBuilder.buildContext(conversationId, message, provider, model);
        const reply = await providers.chat(provider, contextMessages, model);

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
        if (!message || typeof message !== 'string' || !message.trim()) {
            json(res, 400, { error: 'message is required' });
            return;
        }

        if (!conversationService.getConversation(conversationId)) {
            json(res, 404, { error: 'Conversation not found' });
            return;
        }

        // Set up SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        // Detect whether this request should generate an image. If so, run the
        // Krea2/ComfyUI pipeline and stream a single image event when done.
        const intent = await imageGenerator.detectIntent(message, providers, provider, model);

        if (intent.intent === 'image_generation') {
            // Build the final prompt using the conversational model. This
            // preserves the user's original concept while enriching it based
            // on creative_mode.
            const finalPrompt = await imageGenerator.buildImagePrompt(intent, providers, provider, model);

            // Free VRAM for the image models by unloading the chat model first
            // if the GPU is nearly full.
            await vramManager.freeVRAMBeforeImage();
            await handleImageGenerationStream(req, res, {
                provider, model, conversationId, message,
                imagePrompt: finalPrompt
            });
            return;
        }

        // Chat response — remember this chat model, then free VRAM by unloading
        // ComfyUI's models if the GPU is nearly full.
        vramManager.rememberChatModel(provider, model);
        await vramManager.freeVRAMBeforeChat();

        const contextMessages = contextBuilder.buildContext(conversationId, message, provider, model);

        let fullReply = '';

        try {
            for await (const chunk of providers.chatStream(provider, contextMessages, model)) {
                if (chunk.type === 'content') {
                    fullReply += chunk.text;
                    res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
                } else if (chunk.type === 'stats') {
                    res.write(`data: ${JSON.stringify({ stats: chunk })}\n\n`);
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
// "error" event on failure.
async function handleImageGenerationStream(req, res, opts) {
    const { provider, model, conversationId, message, imagePrompt } = opts;

    try {
        if (!imageGenerator.canStartGeneration()) {
            res.write(`data: ${JSON.stringify({ error: 'An image generation is already in progress. Please wait for it to finish.' })}\n\n`);
            res.end();
            return;
        }

        res.write(`data: ${JSON.stringify({ generating: 'Generating image...' })}\n\n`);

        const result = await imageGenerator.generateImage(imagePrompt, { provider, model });

        const content =
            'Generated image:\n' +
            '**Prompt:** ' + imagePrompt + '\n\n' +
            '![' + 'image' + '](' + result.url + ')';

        res.write(`data: ${JSON.stringify({ image: { url: result.url, content, meta: result.meta || null } })}\n\n`);
        res.end();
    } catch (err) {
        console.error('[image-generator] Generation failed:', err.message, '\n', err.stack);
        res.write(`data: ${JSON.stringify({ error: friendlyImageError(err) })}\n\n`);
        res.end();
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
        case 'comfyui_timeout':
            return 'Image generation timed out. ComfyUI may be overloaded — please try again.';
        case 'comfyui_output_not_found':
            return 'ComfyUI finished but did not produce an image. Check the ComfyUI console, then try again.';
        case 'generation_busy':
            return err.message;
        default:
            return 'Image generation failed: ' + (err.message || 'unknown error');
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
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        process.exit(1);
    }
    console.error('Server error:', err);
});
