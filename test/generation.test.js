/* ============================================
   JARVIS — Generation queue + cancellation
   Tests for the shared FIFO's AbortSignal
   plumbing and the ComfyUI wait cancellation.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../services/generation-queue');

function cancelledError() {
    const err = new Error('Generation cancelled.');
    err.code = 'generation_cancelled';
    return err;
}

// A job that rejects as soon as its signal aborts.
function abortableJob(onSignal) {
    return (signal) => {
        if (onSignal) onSignal(signal);
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
        });
    };
}

test('enqueue passes a live AbortSignal to the job function', async () => {
    let received = null;
    const result = await queue.enqueue((signal) => { received = signal; return 'ok'; }, { label: 'probe' });
    assert.equal(result, 'ok');
    assert.ok(received);
    assert.equal(received.aborted, false);
});

test('cancelActive aborts the running job and its promise rejects', async () => {
    let signal = null;
    const p = queue.enqueue(abortableJob((s) => { signal = s; }), { label: 'running' });
    assert.equal(queue.isActive(p.queueId), true);
    assert.equal(queue.cancelActive(p.queueId), true);
    await assert.rejects(p, (err) => err.code === 'generation_cancelled');
    assert.equal(signal.aborted, true);
    assert.equal(queue.isActive(p.queueId), false);
});

test('cancelActive ignores unknown or pending ids', async () => {
    const running = queue.enqueue(abortableJob(), { label: 'running' });
    const pending = queue.enqueue(abortableJob(), { label: 'pending' });
    assert.equal(queue.isActive(pending.queueId), false);
    assert.equal(queue.cancelActive(pending.queueId), false);
    assert.equal(queue.cancelActive(running.queueId + 1000), false);
    // Cancel the queued job before freeing the slot, otherwise it would start.
    assert.equal(queue.cancelQueued(pending.queueId), true);
    await assert.rejects(pending, (err) => err.code === 'generation_cancelled');
    assert.equal(queue.cancelActive(running.queueId), true);
    await assert.rejects(running, (err) => err.code === 'generation_cancelled');
});

test('cancelQueued removes a waiting job and rejects it', async () => {
    const running = queue.enqueue(abortableJob(), { label: 'running' });
    const pending = queue.enqueue(abortableJob(), { label: 'pending' });
    assert.equal(queue.cancelQueued(pending.queueId), true);
    assert.equal(queue.getStatus().pending.some((e) => e.id === pending.queueId), false);
    await assert.rejects(pending, (err) => err.code === 'generation_cancelled');
    queue.cancelActive(running.queueId);
    await assert.rejects(running, (err) => err.code === 'generation_cancelled');
});

test('waitForPrompt rejects promptly when its signal aborts', async () => {
    const comfyui = require('../services/comfyui');
    const originalFetch = global.fetch;
    // A fetch that hangs until its AbortSignal fires, so the only way the wait
    // can finish is via cancellation.
    global.fetch = (url, options) => new Promise((resolve, reject) => {
        const signal = options && options.signal;
        if (signal) {
            signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            }, { once: true });
        }
    });
    try {
        const controller = new AbortController();
        const promise = comfyui.waitForPrompt('pid', { signal: controller.signal, pollMs: 10, timeoutMs: 60000 });
        setTimeout(() => controller.abort(), 25);
        await assert.rejects(promise, (err) => err.code === 'generation_cancelled');
    } finally {
        global.fetch = originalFetch;
    }
});
