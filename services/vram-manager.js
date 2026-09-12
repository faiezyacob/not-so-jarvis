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

// Returns true when a VRAM value exceeds the configured threshold.
function isVRAMConstrained(usagePercent) {
    return Number.isFinite(usagePercent) && usagePercent > UNLOAD_THRESHOLD;
}

// Async helper: refresh VRAM percentage, tolerating errors/absence.
async function currentVRAMPercent() {
    try {
        return await systemMonitor.getVRAMUsagePercent();
    } catch {
        return null;
    }
}

// Before starting an image generation, free VRAM by unloading the chat model
// (if one is loaded and VRAM is too full) so the image models fit.
async function freeVRAMBeforeImage() {
    const usage = await currentVRAMPercent();
    if (!isVRAMConstrained(usage)) return { freed: false, reason: 'vram_ok' };

    if (!lastChatModel) {
        return { freed: false, reason: 'no_chat_model' };
    }

    const { provider, model } = lastChatModel;
    try {
        await providers.unloadModel(provider, model);
        console.log(`[vram-manager] VRAM ${usage}% > ${UNLOAD_THRESHOLD}%; unloaded chat model "${model}" before image generation`);
        activityLog.record({ type: 'unload', title: 'Chat model unloaded', detail: model + ' \u00B7 to free VRAM' });
        lastChatModel = null;
        return { freed: true, unloaded: model, usage };
    } catch (err) {
        console.warn('[vram-manager] Failed to unload chat model before image generation:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

// Before using the chat model, free VRAM by unloading ComfyUI models (the
// other model) when VRAM is too full.
async function freeVRAMBeforeChat() {
    const usage = await currentVRAMPercent();
    if (!isVRAMConstrained(usage)) return { freed: false, reason: 'vram_ok' };

    try {
        if (!(await comfyui.isAvailable())) {
            return { freed: false, reason: 'comfy_offline' };
        }
        await comfyui.freeModels();
        console.log(`[vram-manager] VRAM ${usage}% > ${UNLOAD_THRESHOLD}%; unloaded ComfyUI models before chat`);
        activityLog.record({ type: 'unload', title: 'ComfyUI models unloaded', detail: 'to free VRAM before chat' });
        return { freed: true, unloaded: 'comfyui-models', usage };
    } catch (err) {
        console.warn('[vram-manager] Failed to free ComfyUI VRAM before chat:', err.message);
        return { freed: false, reason: 'unload_failed' };
    }
}

module.exports = {
    UNLOAD_THRESHOLD,
    getThreshold,
    rememberChatModel,
    freeVRAMBeforeChat,
    freeVRAMBeforeImage
};
