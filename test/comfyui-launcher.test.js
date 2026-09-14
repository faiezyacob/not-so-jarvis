/* ============================================
   JARVIS — ComfyUI launcher tests
   Covers the deterministic "start ComfyUI"
   command detection used by the chat gate.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

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
