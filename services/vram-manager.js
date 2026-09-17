/* ============================================
   JARVIS — VRAM Manager
   Keeps the Ollama chat model and ComfyUI models
   from being loaded at the same time. There are
   no memory-pressure thresholds: before any chat
   (Ollama) work the ComfyUI models are unloaded,
   and before any ComfyUI work every loaded chat
   model is unloaded — one side resident, always.
   ============================================ */

const providers = require('../server/providers');
const providerManager = require('../server/provider-manager');
const comfyui = require('./comfyui');
const activityLog = require('./activity-log');

// Most recently used chat provider/model, used as a fallback when Ollama's
// /api/ps cannot be reached. Refreshed on every chat turn.
let lastChatModel = null; // { provider, model }

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
// never load on top of it.
async function freeVRAMBeforeImage() {
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

    console.log(`[vram-manager] unloaded chat model(s) ${unloaded.join(', ')} before ComfyUI`);
    activityLog.record({
        type: 'unload',
        title: 'Chat model unloaded',
        detail: unloaded.join(', ') + ' \u00B7 before ComfyUI'
    });
    lastChatModel = null;
    return { freed: true, unloaded: unloaded.length === 1 ? unloaded[0] : unloaded };
}

// Unload ComfyUI models before any chat (Ollama) work. ComfyUI keeps its
// weights resident after a generation, so the next Ollama call would otherwise
// load the chat model alongside them. `comfyui.queuePrompt` tracks whether a
// job has been queued since the last unload; when it has not, there is nothing
// of ours to free and we skip the round-trip.
async function freeVRAMBeforeChat() {
    const resident = typeof comfyui.hasResidentModels === 'function' && comfyui.hasResidentModels();
    if (!resident) return { freed: false, reason: 'no_comfy_models' };

    try {
        if (!(await comfyui.isAvailable())) {
            // ComfyUI is down; nothing of its remains resident.
            if (typeof comfyui.forgetResidentModels === 'function') comfyui.forgetResidentModels();
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        console.log('[vram-manager] unloaded ComfyUI models before chat');
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: 'before chat' });
        return { freed: true, unloaded: 'comfyui-models' };
    } catch (err) {
        console.warn('[vram-manager] Failed to free ComfyUI memory before chat:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

// Unconditionally unload ComfyUI models. Used at the end of a Director stage so
// the next stage (or chat) starts clean, regardless of the residency flag.
async function freeComfyModels(reason) {
    try {
        if (!(await comfyui.isAvailable())) {
            if (typeof comfyui.forgetResidentModels === 'function') comfyui.forgetResidentModels();
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        console.log(`[vram-manager] unloaded ComfyUI models after ${reason || 'generation'}`);
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: reason ? 'after ' + reason : 'to free memory' });
        return { freed: true, unloaded: 'comfyui-models' };
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
    reconcileOnStartup
};
