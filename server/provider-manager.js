/* ============================================
   JARVIS — Provider Manager
   Handles provider detection, installed model
   discovery, download, load/unload.
   ============================================ */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

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

async function getProviders() {
    const ollama = await checkOllama();
    return [
        { id: 'ollama', name: 'Ollama', ...ollama }
    ];
}

// Detailed Ollama status for the dashboard widget: installed model count plus
// the models currently loaded into memory (`/api/ps`) with their VRAM use.
async function getOllamaStatus() {
    try {
        const [tagsRes, psRes] = await Promise.all([
            fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(3000) }),
            fetch(OLLAMA_URL + '/api/ps', { signal: AbortSignal.timeout(3000) }).catch(() => null)
        ]);
        if (!tagsRes.ok) return { online: false, installed: 0, running: [] };
        const tags = await tagsRes.json();

        let running = [];
        if (psRes && psRes.ok) {
            const ps = await psRes.json();
            running = (ps.models || []).map(m => ({
                name: m.name || m.model || '',
                sizeBytes: m.size || 0,
                vramBytes: m.size_vram || 0,
                expiresAt: m.expires_at || null
            }));
        }

        return {
            online: true,
            installed: (tags.models || []).length,
            running
        };
    } catch {
        return { online: false, installed: 0, running: [] };
    }
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

async function getAllInstalledModels() {
    return getInstalledModelsOllama();
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
    getOllamaStatus,
    getAllInstalledModels,
    downloadModelOllama,
    getDownloadStatus,
    getActiveDownloads,
    loadModel,
    unloadModel,
    removeModel
};
