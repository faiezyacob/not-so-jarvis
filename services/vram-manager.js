/* ============================================
   JARVIS — VRAM Manager
   Keeps the Ollama chat model and ComfyUI models
   from being loaded at the same time. There are
   no memory-pressure thresholds: before any chat
   (Ollama) work the ComfyUI models are unloaded,
   and before any ComfyUI work every loaded chat
   model is unloaded — one side resident, always.
   Unloading is verified: Ollama's keep_alive 0
   only schedules the eviction, so we poll
   /api/ps and wait for the model to actually
   disappear (plus a short settle) before letting
   the next side load. Loading instantly left
   llama-server holding GBs of RAM while ComfyUI
   loaded on top, freezing the machine.
   ============================================ */

const providers = require('../server/providers');
const providerManager = require('../server/provider-manager');
const comfyui = require('./comfyui');
const activityLog = require('./activity-log');

// Most recently used chat provider/model, used as a fallback when Ollama's
// /api/ps cannot be reached. Refreshed on every chat turn.
let lastChatModel = null; // { provider, model }

// How long to wait for a model to actually leave memory after an unload request.
// Poll `/api/ps` (chat) until the model is gone, then hold a short settle so the
// OS has time to reclaim the process RAM before the other side loads. All three
// are overridable per call (used by tests) and via env.
const RELEASE_TIMEOUT_MS = Number(process.env.JARVIS_MODEL_RELEASE_TIMEOUT_MS) || 30000;
const RELEASE_POLL_MS = Number(process.env.JARVIS_MODEL_RELEASE_POLL_MS) || 500;
const RELEASE_SETTLE_MS = Number(process.env.JARVIS_MODEL_RELEASE_SETTLE_MS) || 1500;

function resolveReleaseTimings(opts) {
    const o = opts || {};
    return {
        timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : RELEASE_TIMEOUT_MS,
        pollMs: Number.isFinite(o.pollMs) ? o.pollMs : RELEASE_POLL_MS,
        settleMs: Number.isFinite(o.settleMs) ? o.settleMs : RELEASE_SETTLE_MS
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Poll Ollama until every unloaded model is gone from /api/ps, then settle.
// `unloadModel` returns as soon as the request is accepted, so without this the
// next ComfyUI job can start while llama-server is still winding down.
async function waitForChatRelease(models, opts) {
    const list = Array.from(new Set((models || []).filter(Boolean)));
    if (!list.length) return { released: true, waitedMs: 0 };

    const { timeoutMs, pollMs, settleMs } = resolveReleaseTimings(opts);
    const startedAt = Date.now();
    const pending = new Set(list);

    while (Date.now() - startedAt < timeoutMs) {
        let status = null;
        try {
            status = await providerManager.getOllamaStatus();
        } catch {
            status = null;
        }
        // If Ollama can't be reached the models are gone with it; release.
        const reachable = Boolean(status && status.online !== false);
        const running = new Set(((status && status.running) || []).map(m => m && m.name).filter(Boolean));
        if (reachable) {
            for (const name of Array.from(pending)) {
                if (!running.has(name)) pending.delete(name);
            }
        } else {
            pending.clear();
        }
        if (!pending.size) {
            if (settleMs > 0) await sleep(settleMs);
            const waitedMs = Date.now() - startedAt;
            if (waitedMs >= pollMs) {
                console.log(`[vram-manager] chat model(s) released after ${Math.round(waitedMs / 100) / 10}s`);
            }
            return { released: true, waitedMs };
        }
        await sleep(pollMs);
    }

    const remaining = Array.from(pending);
    console.warn(`[vram-manager] chat model(s) still resident after ${timeoutMs}ms: ${remaining.join(', ')}`);
    return { released: false, waitedMs: Date.now() - startedAt, remaining };
}

// ComfyUI's /free unloads the models and empties its cache synchronously, but
// the driver can take a moment to hand the memory back. A short settle keeps the
// next Ollama load from racing it. Best-effort and never blocks for long.
async function settleComfyRelease(opts) {
    const { settleMs } = resolveReleaseTimings(opts);
    if (settleMs > 0) await sleep(settleMs);
    return { released: true, waitedMs: settleMs };
}

// Remember the chat model currently being used by the app.
function rememberChatModel(provider, model) {
    if (provider && model) {
        lastChatModel = { provider, model };
    }
}

// Every model Ollama is currently holding in memory (authoritative), with the
// last remembered chat model as a fallback if /api/ps is unavailable.
async function loadedChatModels() {
    const names = new Set();
    try {
        const status = await providerManager.getOllamaStatus();
        for (const model of (status && status.running) || []) {
            if (model && model.name) names.add(model.name);
        }
    } catch (err) {
        console.warn('[vram-manager] Could not read Ollama status:', err.message);
    }
    if (lastChatModel && lastChatModel.model) names.add(lastChatModel.model);
    return Array.from(names);
}

// Unload every loaded chat model before starting a ComfyUI image/video action.
// The chat model is idle during generation, so evicting it is always safe (it
// reloads on the next chat turn) and guarantees the diffusion/video weights
// never load on top of it. Waits for Ollama to actually drop the model(s) so the
// next ComfyUI load never stacks on top of a still-resident llama-server.
async function freeVRAMBeforeImage(opts) {
    const models = await loadedChatModels();
    if (!models.length) return { freed: false, reason: 'no_chat_model' };

    const unloaded = [];
    for (const model of models) {
        try {
            await providers.unloadModel('ollama', model);
            unloaded.push(model);
        } catch (err) {
            console.warn(`[vram-manager] Failed to unload chat model "${model}":`, err.message);
        }
    }
    if (!unloaded.length) return { freed: false, reason: 'unload_failed' };

    lastChatModel = null;
    const release = await waitForChatRelease(unloaded, opts);

    console.log(`[vram-manager] unloaded chat model(s) ${unloaded.join(', ')} before ComfyUI`);
    activityLog.record({
        type: 'unload',
        title: 'Chat model unloaded',
        detail: unloaded.join(', ') + ' \u00B7 before ComfyUI' +
            (release.released ? '' : ' \u00B7 still resident')
    });
    return {
        freed: true,
        unloaded: unloaded.length === 1 ? unloaded[0] : unloaded,
        released: release.released,
        waitedMs: release.waitedMs,
        remaining: release.remaining || []
    };
}

// Unload ComfyUI models before any chat (Ollama) work. ComfyUI keeps its
// weights resident after a generation, so the next Ollama call would otherwise
// load the chat model alongside them. `comfyui.queuePrompt` tracks whether a
// job has been queued since the last unload; when it has not, there is nothing
// of ours to free and we skip the round-trip.
async function freeVRAMBeforeChat(opts) {
    const resident = typeof comfyui.hasResidentModels === 'function' && comfyui.hasResidentModels();
    if (!resident) return { freed: false, reason: 'no_comfy_models' };

    try {
        if (!(await comfyui.isAvailable())) {
            // ComfyUI is down; nothing of its remains resident.
            if (typeof comfyui.forgetResidentModels === 'function') comfyui.forgetResidentModels();
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        const release = await settleComfyRelease(opts);
        console.log('[vram-manager] unloaded ComfyUI models before chat');
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: 'before chat' });
        return { freed: true, unloaded: 'comfyui-models', released: release.released, waitedMs: release.waitedMs };
    } catch (err) {
        console.warn('[vram-manager] Failed to free ComfyUI memory before chat:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

// Unconditionally unload ComfyUI models. Used at the end of a Director stage so
// the next stage (or chat) starts clean, regardless of the residency flag. The
// settle gives the driver time to hand the VRAM back before an Ollama load.
async function freeComfyModels(reason, opts) {
    try {
        if (!(await comfyui.isAvailable())) {
            if (typeof comfyui.forgetResidentModels === 'function') comfyui.forgetResidentModels();
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        const release = await settleComfyRelease(opts);
        console.log(`[vram-manager] unloaded ComfyUI models after ${reason || 'generation'}`);
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: reason ? 'after ' + reason : 'to free memory' });
        return { freed: true, unloaded: 'comfyui-models', released: release.released, waitedMs: release.waitedMs };
    } catch (err) {
        console.warn('[vram-manager] Failed to free ComfyUI memory:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

// Called once at server startup. A previous process can exit while ComfyUI is
// still holding models, and the in-memory residency/chat tracking is gone with
// it, so free ComfyUI now. Loaded Ollama models are discovered on demand by
// freeVRAMBeforeImage, so no seeding is needed.
async function reconcileOnStartup() {
    if (typeof comfyui.forgetResidentModels === 'function') comfyui.forgetResidentModels();
    try {
        if (!(await comfyui.isAvailable())) {
            return { reconciled: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        console.log('[vram-manager] freed ComfyUI models left over from a previous session');
        return { reconciled: true, freed: 'comfyui-models' };
    } catch (err) {
        console.warn('[vram-manager] Startup ComfyUI reconcile failed:', err.message);
        return { reconciled: false, reason: 'unload_failed' };
    }
}

module.exports = {
    rememberChatModel,
    freeVRAMBeforeChat,
    freeVRAMBeforeImage,
    freeComfyModels,
    reconcileOnStartup,
    waitForChatRelease
};
