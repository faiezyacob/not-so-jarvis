/* ============================================
   JARVIS — VRAM manager tests
   Covers the memory-pressure gate (VRAM and
   system RAM). system-monitor is stubbed so
   these run offline and fast. Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const systemMonitor = require('../services/system-monitor');
const activityLog = require('../services/activity-log');
const vramManager = require('../services/vram-manager');

const originals = {
    getStats: systemMonitor.getStats,
    record: activityLog.record
};

test.afterEach(() => {
    systemMonitor.getStats = originals.getStats;
    activityLog.record = originals.record;
});

function stats(vram, ram) {
    return {
        cpu: {},
        ram: { usage: ram },
        gpu: {},
        vram: { available: vram !== null, usage: vram === null ? 0 : vram }
    };
}

test('isConstrained: true when VRAM or RAM is over its threshold', () => {
    assert.equal(vramManager.isConstrained({ vram: 95, ram: 10 }), true);
    assert.equal(vramManager.isConstrained({ vram: 10, ram: 95 }), true);
    assert.equal(vramManager.isConstrained({ vram: 40, ram: 40 }), false);
    assert.equal(vramManager.isConstrained({ vram: null, ram: null }), false);
});

test('memoryUsage reads VRAM and RAM from the system monitor', () => {
    systemMonitor.getStats = () => stats(72, 88);
    assert.deepEqual(vramManager.memoryUsage(), { vram: 72, ram: 88 });
});

test('memoryUsage reports null VRAM when no GPU is available', () => {
    systemMonitor.getStats = () => stats(null, 88);
    assert.deepEqual(vramManager.memoryUsage(), { vram: null, ram: 88 });
});

test('freeVRAMBeforeImage unloads the chat model under RAM pressure without VRAM pressure', async () => {
    systemMonitor.getStats = () => stats(10, 99);
    activityLog.record = () => {};
    let unloaded = null;
    const providers = require('../server/providers');
    const originalUnload = providers.unloadModel;
    providers.unloadModel = async (provider, model) => { unloaded = model; };
    try {
        vramManager.rememberChatModel('ollama', 'test-model');
        const result = await vramManager.freeVRAMBeforeImage();
        assert.equal(result.freed, true);
        assert.equal(unloaded, 'test-model');
    } finally {
        providers.unloadModel = originalUnload;
    }
});

test('freeVRAMBeforeImage unloads the chat model even when memory is fine', async () => {
    systemMonitor.getStats = () => stats(10, 10);
    activityLog.record = () => {};
    let unloaded = null;
    const providers = require('../server/providers');
    const originalUnload = providers.unloadModel;
    providers.unloadModel = async (provider, model) => { unloaded = model; };
    try {
        vramManager.rememberChatModel('ollama', 'test-model');
        const result = await vramManager.freeVRAMBeforeImage();
        assert.equal(result.freed, true);
        assert.equal(unloaded, 'test-model');
    } finally {
        providers.unloadModel = originalUnload;
    }
});

test('freeVRAMBeforeImage reports no_chat_model when none is remembered', async () => {
    systemMonitor.getStats = () => stats(10, 10);
    const result = await vramManager.freeVRAMBeforeImage();
    assert.equal(result.freed, false);
    assert.equal(result.reason, 'no_chat_model');
});
