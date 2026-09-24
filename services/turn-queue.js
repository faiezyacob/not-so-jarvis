/* ============================================
   JARVIS — Turn Queue
   Serializes whole request turns across every
   connected client (chat, image/video/upscale,
   Director, UGC, Long Video, Playground). The
   shared generation-queue already serializes
   ComfyUI jobs, but a chat turn runs outside it
   and every turn swaps the Ollama/ComfyUI model
   sets. On a LAN with several devices one device's
   chat could unload the model another device is
   generating with, so only one turn runs at a time
   and the rest wait their turn (FIFO). Control
   endpoints (cancel / free / status) never acquire
   a turn.
   ============================================ */

let nextId = 1;
let active = null; // { id, label, conversationId, startedAt }
let pending = []; // [{ id, label, conversationId, enqueuedAt, onQueued, resolve, reject }]
const MAX_PENDING = 50;

function getStatus() {
    return {
        max: 1,
        active: active ? Object.assign({}, active) : null,
        pending: pending.map((e, i) => ({
            id: e.id,
            label: e.label,
            conversationId: e.conversationId,
            enqueuedAt: e.enqueuedAt,
            position: i + 1
        }))
    };
}

function notifyPositions() {
    pending.forEach((e, i) => {
        if (typeof e.onQueued === 'function') {
            try { e.onQueued(i + 1, e.id); } catch {}
        }
    });
}

function makeCancelledError() {
    const error = new Error('Turn cancelled while waiting.');
    error.code = 'turn_cancelled';
    return error;
}

function start(entry) {
    active = {
        id: entry.id,
        label: entry.label,
        conversationId: entry.conversationId,
        startedAt: Date.now()
    };
    let released = false;
    return {
        id: entry.id,
        release: () => {
            if (released) return;
            released = true;
            if (active && active.id === entry.id) active = null;
            pump();
        }
    };
}

function pump() {
    if (active) return;
    while (pending.length > 0) {
        const next = pending.shift();
        notifyPositions();
        next.resolve(start(next));
        return;
    }
}

// Acquire the single turn slot. Resolves with { id, release() } when it is this
// turn's turn to run. opts: { label, conversationId, onQueued(position, id) }.
// When the slot is busy the caller waits (FIFO) until the running turn releases.
function acquire(opts = {}) {
    const entry = {
        id: nextId++,
        label: String(opts.label || 'turn'),
        conversationId: opts.conversationId || null,
        enqueuedAt: Date.now(),
        onQueued: typeof opts.onQueued === 'function' ? opts.onQueued : null,
        resolve: null,
        reject: null
    };
    const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
    });
    promise.turnId = entry.id;

    if (!active && pending.length === 0) {
        entry.resolve(start(entry));
        return promise;
    }
    if (pending.length >= MAX_PENDING) {
        const error = new Error('Too many requests are already waiting. Please try again shortly.');
        error.code = 'turn_busy';
        return Promise.reject(error);
    }
    pending.push(entry);
    if (entry.onQueued) {
        try { entry.onQueued(pending.length, entry.id); } catch {}
    }
    return promise;
}

// Cancel a waiting turn (not the running one). Returns true when removed.
function cancelQueued(id) {
    const num = Number(id);
    const idx = pending.findIndex((e) => e.id === num);
    if (idx === -1) return false;
    const entry = pending[idx];
    pending.splice(idx, 1);
    notifyPositions();
    try { entry.reject(makeCancelledError()); } catch {}
    return true;
}

module.exports = {
    acquire,
    cancelQueued,
    getStatus,
    MAX_PENDING
};
