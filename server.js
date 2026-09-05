const http = require('http');
const fs = require('fs');
const path = require('path');

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

        const contextMessages = contextBuilder.buildContext(conversationId, message, provider, model);

        // Set up SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

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
