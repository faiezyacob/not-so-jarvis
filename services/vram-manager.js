/* ============================================
   JARVIS — VRAM Manager
   Checks GPU VRAM before loading/using a model
   and unloads the other model first when VRAM
   is getting full, so the next action fits.
   ============================================ */

const systemMonitor = require('./system-monitor');
const providers = require('../server/providers');
const comfyui = require('./comfyui');
const activityLog = require('./activity-log');

// Percentage of VRAM memory used above which we unload the other model before
// starting the next action. Configurable via VRAM_UNLOAD_THRESHOLD.
const UNLOAD_THRESHOLD = Number(process.env.VRAM_UNLOAD_THRESHOLD) || 80;

// System RAM is the other pressure signal: a diffusion/video model can hold
// most of its weights in RAM while the chat model is still resident, which
// shows up as a near-full system and heavy swapping (not always as high VRAM).
// Configurable via RAM_UNLOAD_THRESHOLD.
const RAM_UNLOAD_THRESHOLD = Number(process.env.RAM_UNLOAD_THRESHOLD) || 90;

// Track the most recently used chat model so we can unload it before an image
// generation. Set whenever a chat request uses a model.
let lastChatModel = null; // { provider, model }

// Remember the chat model currently being used by the app.
function rememberChatModel(provider, model) {
    if (provider && model) {
        lastChatModel = { provider, model };
    }
}

function getThreshold() {
    return UNLOAD_THRESHOLD;
}

function getRamThreshold() {
    return RAM_UNLOAD_THRESHOLD;
}

// Returns true when a VRAM value exceeds the configured threshold.
function isVRAMConstrained(usagePercent) {
    return Number.isFinite(usagePercent) && usagePercent > UNLOAD_THRESHOLD;
}

// Returns true when a RAM value exceeds the configured threshold.
function isRAMConstrained(usagePercent) {
    return Number.isFinite(usagePercent) && usagePercent > RAM_UNLOAD_THRESHOLD;
}

// Snapshot the two memory-pressure signals, tolerating errors/absence.
function memoryUsage() {
    try {
        const stats = systemMonitor.getStats();
        const vram = stats && stats.vram && stats.vram.available ? stats.vram.usage : null;
        const ram = stats && stats.ram ? stats.ram.usage : null;
        return { vram, ram };
    } catch {
        return { vram: null, ram: null };
    }
}

// True when either VRAM or system RAM is over its threshold.
function isConstrained(usage) {
    return isVRAMConstrained(usage.vram) || isRAMConstrained(usage.ram);
}

function pressureDetail(usage) {
    const parts = [];
    if (isVRAMConstrained(usage.vram)) parts.push('VRAM ' + usage.vram + '%');
    if (isRAMConstrained(usage.ram)) parts.push('RAM ' + usage.ram + '%');
    return parts.join(' & ');
}

// Before starting a ComfyUI image/video generation, unload the chat model so
// its weights are not resident while the diffusion/video models load. This is
// deliberately NOT gated on a memory-pressure threshold: the spike happens
// *after* the ComfyUI models load, so a pre-generation check can see a healthy
// machine and leave the chat model resident — then both footprints stack and
// RAM/VRAM blows past the limit. The chat model is idle during generation, so
// evicting it up front is always safe (it reloads on the next chat turn).
async function freeVRAMBeforeImage() {
    const usage = memoryUsage();

    if (!lastChatModel) {
        return { freed: false, reason: 'no_chat_model' };
    }

    const { provider, model } = lastChatModel;
    try {
        await providers.unloadModel(provider, model);
        const detail = pressureDetail(usage);
        console.log(`[vram-manager] unloaded chat model "${model}" before image generation${detail ? ' (' + detail + ')' : ''}`);
        activityLog.record({ type: 'unload', title: 'Chat model unloaded', detail: model + ' \u00B7 to free memory' });
        lastChatModel = null;
        return { freed: true, unloaded: model, usage };
    } catch (err) {
        console.warn('[vram-manager] Failed to unload chat model before image generation:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

// Unconditionally unload ComfyUI models. Unlike freeVRAMBeforeChat this does
// not wait for memory pressure to cross a threshold: multi-stage Director runs
// pile image and video models into VRAM/RAM, and a single metric often stays
// under the threshold while the combined footprint keeps growing. Called at the
// end of each Director stage so the next stage (or chat) starts clean.
async function freeComfyModels(reason) {
    try {
        if (!(await comfyui.isAvailable())) {
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

// Before using the chat model, free memory by unloading ComfyUI models (the
// other model) when VRAM or system RAM is too full.
async function freeVRAMBeforeChat() {
    const usage = memoryUsage();
    if (!isConstrained(usage)) return { freed: false, reason: 'memory_ok' };

    try {
        if (!(await comfyui.isAvailable())) {
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        console.log(`[vram-manager] ${pressureDetail(usage)}; unloaded ComfyUI models before chat`);
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: 'to free memory before chat' });
        return { freed: true, unloaded: 'comfyui-models', usage };
    } catch (err) {
        console.warn('[vram-manager] Failed to free ComfyUI memory before chat:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

module.exports = {
    UNLOAD_THRESHOLD,
    RAM_UNLOAD_THRESHOLD,
    getThreshold,
    getRamThreshold,
    isConstrained,
    memoryUsage,
    rememberChatModel,
    freeVRAMBeforeChat,
    freeVRAMBeforeImage,
    freeComfyModels
};
