/* ============================================
   JARVIS — Provider Manager
   Handles provider detection, installed model
   discovery, download, load/unload.
   ============================================ */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234';

const downloads = new Map();
let nextDownloadId = 1;

/* ---------- Provider Detection ---------- */

async function checkOllama() {
    try {
        const res = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { online: false };
        const data = await res.json();
        return { online: true, models: (data.models || []).length };
    } catch {
        return { online: false };
    }
}

async function checkLMStudio() {
    try {
        const res = await fetch(LMSTUDIO_URL + '/v1/models', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { online: false };
        const data = await res.json();
        const models = Array.isArray(data.data) ? data.data : [];
        const running = models.filter(m => m.state === 'running' || m.state === 'loaded');
        return { online: true, models: models.length, running: running.length };
    } catch {
        return { online: false };
    }
}

async function getProviders() {
    const [ollama, lmstudio] = await Promise.all([checkOllama(), checkLMStudio()]);
    return [
        { id: 'ollama', name: 'Ollama', ...ollama },
        { id: 'lmstudio', name: 'LM Studio', ...lmstudio }
    ];
}

/* ---------- Installed Model Discovery ---------- */

async function getInstalledModelsOllama() {
    try {
        const res = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map(m => ({
            id: m.name || m.model,
            displayName: m.name || m.model,
            provider: 'ollama',
            sizeBytes: m.size || 0,
            sizeDisplay: formatBytes(m.size || 0),
            modifiedAt: m.modified_at || null,
            details: m.details || {}
        }));
    } catch {
        return [];
    }
}

async function getInstalledModelsLMStudio() {
    try {
        const res = await fetch(LMSTUDIO_URL + '/v1/models', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.data || []).map(m => ({
            id: m.id,
            displayName: m.id,
            provider: 'lmstudio',
            sizeBytes: 0,
            sizeDisplay: 'Unknown',
            state: m.state || 'unknown',
            details: m
        }));
    } catch {
        return [];
    }
}

async function getAllInstalledModels() {
    const [ollama, lmstudio] = await Promise.all([
        getInstalledModelsOllama(),
        getInstalledModelsLMStudio()
    ]);
    return [...ollama, ...lmstudio];
}

/* ---------- Download (Ollama pull) ---------- */

function downloadModelOllama(catalogModelId) {
    const downloadId = nextDownloadId++;
    const status = {
        id: downloadId,
        modelId: catalogModelId,
        provider: 'ollama',
        state: 'starting',
        progress: 0,
        status: 'Queued...',
        startedAt: Date.now(),
        error: null
    };
    downloads.set(downloadId, status);
    runOllamaPull(downloadId, catalogModelId);
    return status;
}

async function runOllamaPull(downloadId, modelId) {
    const status = downloads.get(downloadId);
    if (!status) return;

    try {
        status.state = 'downloading';
        status.status = 'Connecting to Ollama...';

        const res = await fetch(OLLAMA_URL + '/api/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId, stream: true })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error('Ollama pull failed: ' + res.status + ' ' + err);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const chunk = JSON.parse(line);
                    updateDownloadStatus(status, chunk);
                } catch {}
            }
        }

        if (buffer.trim()) {
            try {
                const chunk = JSON.parse(buffer);
                updateDownloadStatus(status, chunk);
            } catch {}
        }

        if (status.state !== 'error') {
            status.state = 'completed';
            status.progress = 100;
            status.status = 'Download complete';
        }
    } catch (err) {
        status.state = 'error';
        status.error = err.message;
        status.status = 'Error: ' + err.message;
    }
}

function updateDownloadStatus(status, chunk) {
    if (chunk.status) {
        status.status = chunk.status;
    }

    if (chunk.total && chunk.completed != null) {
        status.progress = Math.round((chunk.completed / chunk.total) * 100);
        status.downloadedBytes = chunk.completed;
        status.totalBytes = chunk.total;
    }

    if (chunk.error) {
        status.state = 'error';
        status.error = chunk.error;
        status.status = 'Error: ' + chunk.error;
    }
}

function getDownloadStatus(downloadId) {
    return downloads.get(downloadId) || null;
}

function getActiveDownloads() {
    return Array.from(downloads.values()).filter(d => d.state === 'downloading' || d.state === 'starting');
}

/* ---------- Download (LM Studio — not natively supported) ---------- */

function downloadModelLMStudio(catalogModelId) {
    const downloadId = nextDownloadId++;
    const status = {
        id: downloadId,
        modelId: catalogModelId,
        provider: 'lmstudio',
        state: 'error',
        progress: 0,
        status: 'LM Studio does not support programmatic downloads. Please download the model in LM Studio directly.',
        startedAt: Date.now(),
        error: 'LM Studio API does not support model downloads'
    };
    downloads.set(downloadId, status);
    return status;
}

/* ---------- Remove (Uninstall) ---------- */

async function removeModel(provider, model) {
    const providerStatus = await getProviders();
    const isOnline = providerStatus.find(p => p.id === provider);

    if (provider === 'ollama') {
        if (!isOnline.online) throw new Error('Ollama is not running');
        if (!model) throw new Error('Model name is required');
        const res = await fetch(OLLAMA_URL + '/api/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error('Ollama remove error ' + res.status + ': ' + err);
        }
        return { removed: true, model };
    }
    if (provider === 'lmstudio') {
        throw new Error('LM Studio does not support programmatic model removal. Please delete the model in LM Studio directly.');
    }
    throw new Error('Unknown provider: ' + provider);
}

/* ---------- Load / Unload ---------- */

async function loadModel(provider, model) {
    if (provider === 'ollama') {
        const res = await fetch(OLLAMA_URL + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: '', keep_alive: -1 })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error('Ollama load error ' + res.status + ': ' + err);
        }
        return { loaded: true, model };
    }
    if (provider === 'lmstudio') {
        const res = await fetch(LMSTUDIO_URL + '/v1/models/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error('LM Studio load error ' + res.status + ': ' + err);
        }
        return { loaded: true, model };
    }
    throw new Error('Unknown provider: ' + provider);
}

async function unloadModel(provider, model) {
    if (provider === 'ollama') {
        if (!model) throw new Error('Model name is required');
        const res = await fetch(OLLAMA_URL + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: '', keep_alive: 0 })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error('Ollama unload error ' + res.status + ': ' + err);
        }
        return { unloaded: true, model };
    }
    if (provider === 'lmstudio') {
        if (!model) throw new Error('Model name is required');
        const res = await fetch(LMSTUDIO_URL + '/api/v1/models/unload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: model })
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error('LM Studio unload error ' + res.status + ': ' + err);
        }
        let data = {};
        try { data = await res.json(); } catch {}
        return { unloaded: true, model, instance_id: data.instance_id };
    }
    throw new Error('Unknown provider: ' + provider);
}

/* ---------- Helpers ---------- */

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

module.exports = {
    getProviders,
    getAllInstalledModels,
    downloadModelOllama,
    downloadModelLMStudio,
    getDownloadStatus,
    getActiveDownloads,
    loadModel,
    unloadModel,
    removeModel
};
