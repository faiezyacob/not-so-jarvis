/* ============================================
   JARVIS — VRAM manager tests
   Covers the deterministic eviction rules:
   free every loaded chat model before ComfyUI,
   free ComfyUI before any chat. Ollama/ComfyUI
   are stubbed so these run offline and fast.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');
const providerManager = require('../server/provider-manager');
const activityLog = require('../services/activity-log');
const comfyui = require('../services/comfyui');
const vramManager = require('../services/vram-manager');

const originals = {
    unloadModel: providers.unloadModel,
    getOllamaStatus: providerManager.getOllamaStatus,
    record: activityLog.record,
    isAvailable: comfyui.isAvailable,
    freeModels: comfyui.freeModels,
    hasResidentModels: comfyui.hasResidentModels,
    forgetResidentModels: comfyui.forgetResidentModels
};

test.afterEach(() => {
    providers.unloadModel = originals.unloadModel;
    providerManager.getOllamaStatus = originals.getOllamaStatus;
    activityLog.record = originals.record;
    comfyui.isAvailable = originals.isAvailable;
    comfyui.freeModels = originals.freeModels;
    comfyui.hasResidentModels = originals.hasResidentModels;
    comfyui.forgetResidentModels = originals.forgetResidentModels;
});

function stubComfy({ available = true, resident = true, freed } = {}) {
    comfyui.isAvailable = async () => available;
    comfyui.hasResidentModels = () => resident;
    comfyui.freeModels = async () => { if (freed) freed.called = true; };
}

test('freeVRAMBeforeImage unloads every model Ollama has loaded', async () => {
    activityLog.record = () => {};
    providerManager.getOllamaStatus = async () => ({
        online: true,
        running: [{ name: 'llama3:8b', vramBytes: 100 }, { name: 'qwen2:7b', vramBytes: 90 }]
    });
    const unloaded = [];
    providers.unloadModel = async (provider, model) => { unloaded.push(model); };

    const result = await vramManager.freeVRAMBeforeImage();
    assert.equal(result.freed, true);
    assert.deepEqual(unloaded.sort(), ['llama3:8b', 'qwen2:7b']);
});

test('freeVRAMBeforeImage falls back to the remembered chat model when Ollama is unreachable', async () => {
    activityLog.record = () => {};
    providerManager.getOllamaStatus = async () => { throw new Error('offline'); };
    const unloaded = [];
    providers.unloadModel = async (provider, model) => { unloaded.push(model); };

    vramManager.rememberChatModel('ollama', 'test-model');
    const result = await vramManager.freeVRAMBeforeImage();
    assert.equal(result.freed, true);
    assert.deepEqual(unloaded, ['test-model']);
});

test('freeVRAMBeforeImage reports no_chat_model when nothing is loaded', async () => {
    providerManager.getOllamaStatus = async () => ({ online: true, running: [] });
    const result = await vramManager.freeVRAMBeforeImage();
    assert.equal(result.freed, false);
    assert.equal(result.reason, 'no_chat_model');
});

test('freeVRAMBeforeChat unloads ComfyUI models when they are resident', async () => {
    activityLog.record = () => {};
    const freed = {};
    stubComfy({ resident: true, freed });
    const result = await vramManager.freeVRAMBeforeChat();
    assert.equal(result.freed, true);
    assert.equal(freed.called, true);
});

test('freeVRAMBeforeChat skips ComfyUI when nothing is resident', async () => {
    const freed = {};
    stubComfy({ resident: false, freed });
    const result = await vramManager.freeVRAMBeforeChat();
    assert.equal(result.freed, false);
    assert.equal(result.reason, 'no_comfy_models');
    assert.equal(freed.called, undefined);
});

test('freeVRAMBeforeChat clears residency when ComfyUI is offline', async () => {
    let forgotten = false;
    comfyui.isAvailable = async () => false;
    comfyui.hasResidentModels = () => true;
    comfyui.forgetResidentModels = () => { forgotten = true; };
    const result = await vramManager.freeVRAMBeforeChat();
    assert.equal(result.freed, false);
    assert.equal(result.reason, 'comfy_offline');
    assert.equal(forgotten, true);
});

test('reconcileOnStartup frees ComfyUI models left over from a previous session', async () => {
    const freed = {};
    stubComfy({ available: true, resident: false, freed });
    const result = await vramManager.reconcileOnStartup();
    assert.equal(result.reconciled, true);
    assert.equal(freed.called, true);
});

test('reconcileOnStartup is a no-op when ComfyUI is offline', async () => {
    stubComfy({ available: false });
    const result = await vramManager.reconcileOnStartup();
    assert.equal(result.reconciled, false);
    assert.equal(result.reason, 'comfy_offline');
});
