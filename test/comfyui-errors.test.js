/* ============================================
   JARVIS — ComfyUI error classification + retry
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const comfyui = require('../services/comfyui');

test('classifyComfyError: OOM', () => {
    assert.equal(comfyui.classifyComfyError('CUDA out of memory. Tried to allocate 2.00 GiB').code, 'comfyui_oom');
    assert.equal(comfyui.classifyComfyError('torch.OutOfMemoryError: CUDA error: out of memory').code, 'comfyui_oom');
});

test('classifyComfyError: missing model file', () => {
    assert.equal(
        comfyui.classifyComfyError("Value not in list: unet_name: 'flux.safetensors' not in ['krea2.safetensors']").code,
        'comfyui_missing_model'
    );
    assert.equal(comfyui.classifyComfyError('Failed to load lora file example.safetensors').code, 'comfyui_missing_model');
});

test('classifyComfyError: missing custom node', () => {
    assert.equal(comfyui.classifyComfyError("ModuleNotFoundError: No module named 'krea2nodes'").code, 'comfyui_missing_node');
    assert.equal(comfyui.classifyComfyError('Cannot import Krea2EditModelPatch').code, 'comfyui_missing_node');
});

test('classifyComfyError: unknown validation error is null', () => {
    assert.equal(comfyui.classifyComfyError('Prompt outputs failed validation'), null);
});

test('summarizeComfyErrorBody: extracts error + node_errors', () => {
    const body = JSON.stringify({
        error: { message: 'Prompt outputs failed validation', details: 'first line\nsecond line' },
        node_errors: { '4': { errors: [{ message: 'value not in list', details: 'extra' }] } }
    });
    const summary = comfyui.summarizeComfyErrorBody(body);
    assert.match(summary, /Prompt outputs failed validation/);
    assert.match(summary, /first line/);
    assert.match(summary, /value not in list/);
});

test('summarizeComfyErrorBody: non-JSON falls back to text', () => {
    assert.equal(comfyui.summarizeComfyErrorBody('plain failure text'), 'plain failure text');
});

test('isRetryableComfyError: transient only', () => {
    assert.equal(comfyui.isRetryableComfyError({ code: 'comfyui_unavailable' }), true);
    assert.equal(comfyui.isRetryableComfyError({ code: 'comfyui_api_error', status: 500 }), true);
    assert.equal(comfyui.isRetryableComfyError({ code: 'comfyui_api_error', status: 400 }), false);
    assert.equal(comfyui.isRetryableComfyError({ code: 'comfyui_oom' }), false);
    assert.equal(comfyui.isRetryableComfyError(null), false);
});

test('withRetry: retries a transient failure then succeeds', async () => {
    let calls = 0;
    const result = await comfyui.withRetry(async () => {
        calls++;
        if (calls < 3) {
            const err = new Error('offline');
            err.code = 'comfyui_unavailable';
            throw err;
        }
        return 'ok';
    }, { retries: 3, baseDelayMs: 1 });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('withRetry: does not retry a deterministic failure', async () => {
    let calls = 0;
    await assert.rejects(async () => {
        await comfyui.withRetry(async () => {
            calls++;
            const err = new Error('bad prompt');
            err.code = 'comfyui_api_error';
            err.status = 400;
            throw err;
        }, { retries: 3, baseDelayMs: 1 });
    }, /bad prompt/);
    assert.equal(calls, 1);
});

test('queuePrompt: classifies a missing-model 400 instead of blaming nodes', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
            error: {
                message: 'Prompt outputs failed validation',
                details: "Value not in list: unet_name: 'flux.safetensors' not in ['krea2.safetensors']"
            }
        })
    });
    try {
        await assert.rejects(
            comfyui.queuePrompt({}),
            (err) => err.code === 'comfyui_missing_model'
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('waitForPrompt: classifies an OOM history error', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            pid: { status: { status_str: 'error', messages: [[null, { message: 'CUDA out of memory' }]] } }
        })
    });
    try {
        await assert.rejects(
            comfyui.waitForPrompt('pid', { pollMs: 5, timeoutMs: 1000 }),
            (err) => err.code === 'comfyui_oom'
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('downloadImage: retries a transient empty response', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls++;
        if (calls === 1) {
            return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    };
    try {
        const buf = await comfyui.downloadImage({ filename: 'a.png' });
        assert.equal(calls, 2);
        assert.equal(buf.length, 3);
    } finally {
        global.fetch = originalFetch;
    }
});
