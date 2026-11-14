/* ============================================
   JARVIS — Image Arena background queue
   A durable-by-record FIFO: job state lives in the
   benchmark session store, this module only owns
   the in-process execution slots. Local ComfyUI
   engines are serialized to ONE job at a time; a
   future cloud engine can use its own concurrency
   budget without competing for the local GPU.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const CLOUD_CONCURRENCY = Math.max(1, Number(process.env.BENCHMARK_CLOUD_CONCURRENCY) || 2);

let pending = [];
let running = new Map();
let nextId = 1;
let pumping = false;

function entryKey(sessionId, jobId) {
    return String(sessionId) + ':' + String(jobId);
}

function runningFor(locality) {
    let count = 0;
    running.forEach((entry) => {
        if ((entry.locality || 'local') === locality) count += 1;
    });
    return count;
}

function canRun(entry) {
    const locality = entry.locality || 'local';
    if (locality === 'local') return runningFor('local') === 0;
    return runningFor('cloud') < CLOUD_CONCURRENCY;
}

function pickNext() {
    for (let i = 0; i < pending.length; i += 1) {
        if (canRun(pending[i])) {
            return pending.splice(i, 1)[0];
        }
    }
    return null;
}

function pump() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const entry = pickNext();
            if (!entry) break;
            entry.startedAt = Date.now();
            running.set(entry.key, entry);
            Promise.resolve()
                .then(() => entry.run())
                .catch((error) => {
                    console.warn('[benchmark-queue] ' + entry.key + ' failed:', error && error.message);
                })
                .finally(() => {
                    running.delete(entry.key);
                    pump();
                });
        }
    } finally {
        pumping = false;
    }
}

// entry: { sessionId, jobId, locality, run() }
function enqueue(entry) {
    if (!entry || typeof entry.run !== 'function') return false;
    const key = entry.key || entryKey(entry.sessionId, entry.jobId);
    if (running.has(key) || pending.some((item) => item.key === key)) return false;
    pending.push({
        id: nextId++,
        key,
        sessionId: entry.sessionId,
        jobId: entry.jobId,
        locality: entry.locality || 'local',
        enqueuedAt: Date.now(),
        run: entry.run
    });
    pump();
    return true;
}

function cancelPending(key, sessionId) {
    const before = pending.length;
    pending = pending.filter((entry) => {
        if (key && entry.key !== key) return true;
        if (sessionId && entry.sessionId !== String(sessionId)) return true;
        return false;
    });
    return before - pending.length;
}

function isRunning(key) {
    return running.has(String(key));
}

function has(key) {
    const wanted = String(key);
    return running.has(wanted) || pending.some((entry) => entry.key === wanted);
}

function getStatus() {
    return {
        localConcurrency: 1,
        cloudConcurrency: CLOUD_CONCURRENCY,
        running: Array.from(running.values()).map((entry) => ({
            key: entry.key,
            sessionId: entry.sessionId,
            jobId: entry.jobId,
            locality: entry.locality,
            startedAt: entry.startedAt || null
        })),
        pending: pending.map((entry, index) => ({
            key: entry.key,
            sessionId: entry.sessionId,
            jobId: entry.jobId,
            locality: entry.locality,
            position: index + 1,
            enqueuedAt: entry.enqueuedAt
        }))
    };
}

// Test hook: clear all in-memory slots without touching persisted records.
function reset() {
    pending = [];
    running = new Map();
    pumping = false;
}

module.exports = {
    entryKey,
    enqueue,
    cancelPending,
    isRunning,
    has,
    getStatus,
    reset
};
