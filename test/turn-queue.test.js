/* ============================================
   JARVIS — Turn queue
   Tests for the single-slot turn serializer that
   keeps multiple LAN clients from swapping the
   Ollama/ComfyUI models out from under each other.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const turnQueue = require('../services/turn-queue');

function releaseAll(handles) {
    handles.forEach((h) => { if (h) h.release(); });
}

test('acquire resolves immediately when the slot is free', async () => {
    const turn = await turnQueue.acquire({ label: 'chat' });
    assert.ok(turn && typeof turn.release === 'function');
    assert.equal(turnQueue.getStatus().active.label, 'chat');
    turn.release();
    assert.equal(turnQueue.getStatus().active, null);
});

test('a second turn waits until the running one releases (FIFO)', async () => {
    const first = await turnQueue.acquire({ label: 'first' });
    let secondResolved = false;
    const secondPromise = turnQueue.acquire({ label: 'second' }).then((handle) => {
        secondResolved = true;
        return handle;
    });
    // Give the microtask queue a chance; the second must still be waiting.
    await Promise.resolve();
    assert.equal(secondResolved, false);
    assert.equal(turnQueue.getStatus().pending.length, 1);

    first.release();
    const second = await secondPromise;
    assert.equal(secondResolved, true);
    assert.equal(turnQueue.getStatus().active.label, 'second');
    second.release();
    assert.equal(turnQueue.getStatus().active, null);
});

test('onQueued reports the waiting position and a turnId', async () => {
    const first = await turnQueue.acquire({ label: 'first' });
    let queued = null;
    const secondPromise = turnQueue.acquire({
        label: 'second',
        onQueued: (position, id) => { queued = { position, id }; }
    });
    assert.ok(queued);
    assert.equal(queued.position, 1);
    assert.equal(queued.id, secondPromise.turnId);
    first.release();
    const second = await secondPromise;
    second.release();
});

test('cancelQueued rejects a waiting turn and removes it', async () => {
    const first = await turnQueue.acquire({ label: 'first' });
    const secondPromise = turnQueue.acquire({ label: 'second' });
    const turnId = secondPromise.turnId;
    assert.equal(turnQueue.cancelQueued(turnId), true);
    await assert.rejects(secondPromise, (err) => err.code === 'turn_cancelled');
    assert.equal(turnQueue.getStatus().pending.length, 0);
    // Cancelling an unknown id is a no-op.
    assert.equal(turnQueue.cancelQueued(turnId + 1000), false);
    first.release();
});

test('the running turn is never cancelled by cancelQueued', async () => {
    const running = await turnQueue.acquire({ label: 'running' });
    assert.equal(turnQueue.cancelQueued(running.id), false);
    running.release();
});

test('a full queue rejects with turn_busy', async () => {
    const first = await turnQueue.acquire({ label: 'first' });
    const waiters = [];
    for (let i = 0; i < turnQueue.MAX_PENDING; i++) {
        const p = turnQueue.acquire({ label: 'waiter-' + i });
        p.catch(() => {});
        waiters.push(p);
    }
    await assert.rejects(
        turnQueue.acquire({ label: 'overflow' }),
        (err) => err.code === 'turn_busy'
    );
    waiters.forEach((p) => turnQueue.cancelQueued(p.turnId));
    releaseAll([first]);
});
