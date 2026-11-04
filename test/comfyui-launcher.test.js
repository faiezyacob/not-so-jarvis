/* ============================================
   JARVIS — ComfyUI launcher tests
   Covers the deterministic "start ComfyUI"
   command detection used by the chat gate.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');

const launcher = require('../services/comfyui-launcher');

test('detects explicit start ComfyUI requests', () => {
    const positives = [
        'start comfyui',
        'Start ComfyUI',
        'can you start comfyui for me',
        'please launch comfy ui',
        'boot up comfyui',
        'run comfyui',
        'fire up comfy',
        'turn on comfyui',
        'comfyui is offline, start it',
        'wake comfyui up'
    ];
    for (const phrase of positives) {
        assert.equal(launcher.isStartComfyRequest(phrase), true, phrase);
    }
});

test('leaves questions and unrelated turns alone', () => {
    const negatives = [
        'how do I start comfyui?',
        'what is comfyui',
        'why is comfyui not running',
        'comfyui is not running',
        'start an image of a comfy sofa',
        'generate an image of a cozy comfy chair',
        'start generating a picture',
        ''
    ];
    for (const phrase of negatives) {
        assert.equal(launcher.isStartComfyRequest(phrase), false, phrase);
    }
});

test('portInUse sees a process already holding the ComfyUI port', async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    try {
        assert.equal(await launcher.portInUse(500, { host: '127.0.0.1', port }), true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(await launcher.portInUse(300, { host: '127.0.0.1', port }), false);
});

test('comfyHostPort derives the host and port from COMFYUI_URL', () => {
    const address = launcher.comfyHostPort();
    assert.equal(typeof address.host, 'string');
    assert.ok(Number.isInteger(address.port) && address.port > 0);
});
