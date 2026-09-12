/* ============================================
   JARVIS — Shared Generation Queue
   Single-slot FIFO for all ComfyUI jobs (image,
   video, upscale). Replaces the immediate
   "already in progress" error: extra requests
   wait their turn and can be cancelled while
   queued. Only one job runs at a time.
   ============================================ */

let nextId = 1;
let active = null; // { id, label, kind, conversationId, startedAt }
let pending = []; // [{ id, label, kind, conversationId, enqueuedAt, run, resolve, reject, onQueued, onStart }]
const MAX_PENDING = 10;

function canStartGeneration() {
    return !active && pending.length === 0;
}

// True when the given queue id is the job currently holding the slot.
function isActive(id) {
    return Boolean(active && active.id === Number(id));
}

function getStatus() {
    return {
        max: 1,
        active: active ? Object.assign({}, active) : null,
        pending: pending.map((e, i) => ({
            id: e.id,
            label: e.label,
            kind: e.kind,
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

async function runEntry(entry) {
    active = {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        conversationId: entry.conversationId,
        startedAt: Date.now()
    };
    // A job that waited in the queue emits a fresh "generating" status when it
    // actually starts, so the client knows it is now the running job (and
    // Cancel should interrupt it rather than try to dequeue it).
    if (entry.queued && typeof entry.onStart === 'function') {
        try { entry.onStart(entry.id); } catch {}
    }
    try {
        const result = await entry.run();
        entry.resolve(result);
        return result;
    } catch (err) {
        entry.reject(err);
        throw err;
    } finally {
        active = null;
        pump();
    }
}

function pump() {
    if (active) return;
    while (pending.length > 0) {
        const next = pending.shift();
        if (next.cancelled) continue;
        notifyPositions();
        runEntry(next).catch(() => {});
        return;
    }
}

// Enqueue an async job. Resolves/rejects with the job result.
// opts: { label, kind, conversationId, onQueued(position, id) }.
// The returned promise carries .queueId for cancel-on-disconnect.
function enqueue(fn, opts = {}) {
    if (typeof fn !== 'function') return Promise.reject(new Error('enqueue requires a function'));
    if (pending.length >= MAX_PENDING) {
        const error = new Error('Generation queue is full. Please wait for pending jobs to finish.');
        error.code = 'generation_busy';
        return Promise.reject(error);
    }
    const entry = {
        id: nextId++,
        label: String(opts.label || 'generation'),
        kind: String(opts.kind || 'image'),
        conversationId: opts.conversationId || null,
        enqueuedAt: Date.now(),
        run: fn,
        onQueued: typeof opts.onQueued === 'function' ? opts.onQueued : null,
        onStart: typeof opts.onStart === 'function' ? opts.onStart : null,
        cancelled: false,
        queued: false,
        resolve: null,
        reject: null
    };
    const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
    });
    promise.queueId = entry.id;

    if (!active && pending.length === 0) {
        runEntry(entry).catch(() => {});
    } else {
        entry.queued = true;
        pending.push(entry);
        if (entry.onQueued) {
            try { entry.onQueued(pending.length, entry.id); } catch {}
        }
    }
    return promise;
}

// Cancel a queued (not yet running) job. Returns true when removed.
function cancelQueued(id) {
    const num = Number(id);
    const idx = pending.findIndex((e) => e.id === num);
    if (idx === -1) return false;
    const entry = pending[idx];
    pending.splice(idx, 1);
    entry.cancelled = true;
    const error = new Error('Generation cancelled while queued.');
    error.code = 'generation_cancelled';
    try { entry.reject(error); } catch {}
    entry.promise && entry.promise.catch && entry.promise.catch(() => {});
    notifyPositions();
    return true;
}

function queuedIdOf(promise) {
    return promise && promise.queueId ? promise.queueId : null;
}

module.exports = {
    enqueue,
    cancelQueued,
    canStartGeneration,
    isActive,
    getStatus,
    queuedIdOf,
    MAX_PENDING
};
