/* ============================================
   JARVIS — VRAM manager tests
   Covers the deterministic eviction rules:
   free every loaded chat model before ComfyUI,
   free ComfyUI before any chat, and wait for
   Ollama to actually drop a model before the
   next side loads. Ollama/ComfyUI are stubbed
   so these run offline and fast.
   Run with: npm test
   ============================================ */

// Tests pass fast release timings so the polling/settle never slows the suite.
const FAST = { pollMs: 1, settleMs: 0, timeoutMs: 500 };

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
    let running = [{ name: 'llama3:8b' }, { name: 'qwen2:7b' }];
    providerManager.getOllamaStatus = async () => ({ online: true, running });
    const unloaded = [];
    providers.unloadModel = async (provider, model) => {
        unloaded.push(model);
        running = running.filter(m => m.name !== model);
    };

    const result = await vramManager.freeVRAMBeforeImage(FAST);
    assert.equal(result.freed, true);
    assert.equal(result.released, true);
    assert.deepEqual(unloaded.sort(), ['llama3:8b', 'qwen2:7b']);
});

test('freeVRAMBeforeImage waits until Ollama actually drops the model', async () => {
    activityLog.record = () => {};
    // The model stays in /api/ps for two polls after the unload request.
    let polls = 0;
    providerManager.getOllamaStatus = async () => {
        polls++;
        return { online: true, running: polls <= 2 ? [{ name: 'llama3:8b' }] : [] };
    };
    providers.unloadModel = async () => {};

    const result = await vramManager.freeVRAMBeforeImage({ pollMs: 5, settleMs: 0, timeoutMs: 500 });
    assert.equal(result.released, true);
    assert.ok(polls >= 3, 'should have polled until the model was gone');
});

test('freeVRAMBeforeImage reports released:false when the model never drops', async () => {
    activityLog.record = () => {};
    providerManager.getOllamaStatus = async () => ({ online: true, running: [{ name: 'llama3:8b' }] });
    providers.unloadModel = async () => {};

    const result = await vramManager.freeVRAMBeforeImage({ pollMs: 5, settleMs: 0, timeoutMs: 30 });
    assert.equal(result.freed, true);
    assert.equal(result.released, false);
    assert.deepEqual(result.remaining, ['llama3:8b']);
});

test('freeVRAMBeforeImage falls back to the remembered chat model when Ollama is unreachable', async () => {
    activityLog.record = () => {};
    providerManager.getOllamaStatus = async () => { throw new Error('offline'); };
    const unloaded = [];
    providers.unloadModel = async (provider, model) => { unloaded.push(model); };

    vramManager.rememberChatModel('ollama', 'test-model');
    const result = await vramManager.freeVRAMBeforeImage(FAST);
    assert.equal(result.freed, true);
    assert.deepEqual(unloaded, ['test-model']);
});

test('freeVRAMBeforeImage reports no_chat_model when nothing is loaded', async () => {
    providerManager.getOllamaStatus = async () => ({ online: true, running: [] });
    const result = await vramManager.freeVRAMBeforeImage(FAST);
    assert.equal(result.freed, false);
    assert.equal(result.reason, 'no_chat_model');
});

test('freeVRAMBeforeChat unloads ComfyUI models when they are resident', async () => {
    activityLog.record = () => {};
    const freed = {};
    stubComfy({ resident: true, freed });
    const result = await vramManager.freeVRAMBeforeChat({ settleMs: 0 });
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
