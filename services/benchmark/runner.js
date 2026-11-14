/* ============================================
   JARVIS — Image Arena job runner
   Executes ONE benchmark job through its adapter.
   It owns job state transitions, VRAM hand-off,
   ComfyUI progress relay and error capture; it never
   submits a workflow itself.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const path = require('path');

let deps = {
    imageGenerator: require('../image-generator'),
    vramManager: require('../vram-manager'),
    comfyui: require('../comfyui')
};

function configure(overrides) {
    deps = Object.assign({}, deps, overrides || {});
}

function nowIso() {
    return new Date().toISOString();
}

function statusOrder(status) {
    return ['pending', 'queued', 'initializing', 'generating', 'saving', 'completed', 'failed', 'cancelled'].indexOf(status);
}

function updateJob(job, patch) {
    Object.assign(job, patch);
    job.updatedAt = nowIso();
}

async function runJob(session, job, options) {
    const opts = options || {};
    const adapter = opts.adapter;
    const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
    const freeVRAM = opts.freeVRAM || (() => deps.vramManager.freeVRAMBeforeImage());
    const subscribe = opts.subscribeProgress || ((cb) => deps.comfyui.subscribeProgress(cb));
    const unsubscribe = opts.unsubscribeProgress || ((cb) => deps.comfyui.unsubscribeProgress(cb));

    if (!adapter) {
        updateJob(job, {
            status: 'failed',
            completedAt: nowIso(),
            error: { code: 'engine_unavailable', message: 'No adapter is registered for this model.' }
        });
        onUpdate(session, job, { persist: true });
        return job;
    }

    job.attempts = (Number(job.attempts) || 0) + 1;
    job.startedAt = nowIso();
    job.completedAt = null;
    job.error = null;
    job.progress = null;
    job.queueId = null;
    job.queuePosition = null;
    job.result = null;
    updateJob(job, { status: 'initializing' });
    onUpdate(session, job, { persist: true });

    if (job.cancelRequested) {
        updateJob(job, {
            status: 'cancelled',
            completedAt: nowIso(),
            error: { code: 'benchmark_cancelled', message: 'Cancelled before generation started.' }
        });
        onUpdate(session, job, { persist: true });
        return job;
    }

    // One side resident: evict every loaded chat model before ComfyUI loads
    // this engine's weights. Repeated per job so a chat turn between two jobs
    // cannot stack an Ollama model under the next diffusion model.
    try {
        await freeVRAM();
    } catch (err) {
        console.warn('[benchmark] VRAM hand-off failed:', err.message);
    }

    if (job.cancelRequested) {
        updateJob(job, {
            status: 'cancelled',
            completedAt: nowIso(),
            error: { code: 'benchmark_cancelled', message: 'Cancelled before generation started.' }
        });
        onUpdate(session, job, { persist: true });
        return job;
    }

    let progressHandler = null;
    let progressAttached = false;
    let queued = false;
    const startedAtMs = Date.now();

    const detachProgress = () => {
        if (!progressAttached || !progressHandler) return;
        progressAttached = false;
        try { unsubscribe(progressHandler); } catch (err) { /* best-effort */ }
        progressHandler = null;
    };

    const attachProgress = () => {
        if (progressAttached) return;
        progressAttached = true;
        progressHandler = (update) => {
            if (!update || update.idle) return;
            if (typeof update.value !== 'number' || typeof update.max !== 'number' || update.max <= 0) return;
            job.progress = { value: update.value, max: update.max };
            onUpdate(session, job, { persist: false });
        };
        subscribe(progressHandler);
    };

    const markGenerating = () => {
        if (job.status === 'generating' || job.status === 'saving') return;
        updateJob(job, { status: 'generating' });
        attachProgress();
        onUpdate(session, job, { persist: true });
    };

    let result = null;
    try {
        const promise = adapter.run(job, {
            onQueued: (position, id) => {
                queued = true;
                updateJob(job, {
                    status: 'queued',
                    queueId: id || job.queueId,
                    queuePosition: position
                });
                onUpdate(session, job, { persist: true });
            },
            onStart: (id) => {
                if (id) job.queueId = id;
                markGenerating();
            },
            onQueueId: (id) => {
                if (id) job.queueId = id;
            }
        });

        // generation-queue only calls onStart for jobs that actually waited;
        // an immediately-started job is already running, so mark it now.
        if (!queued) markGenerating();

        result = await promise;
    } catch (err) {
        detachProgress();
        const cancelled = job.cancelRequested === true ||
            (err && err.code === 'generation_cancelled') ||
            (err && err.code === 'benchmark_cancelled');
        if (cancelled) {
            updateJob(job, {
                status: 'cancelled',
                completedAt: nowIso(),
                durationMs: Date.now() - startedAtMs,
                progress: null,
                error: { code: 'benchmark_cancelled', message: 'Generation cancelled.' }
            });
        } else {
            const code = (err && err.code) || 'benchmark_job_failed';
            updateJob(job, {
                status: 'failed',
                completedAt: nowIso(),
                durationMs: Date.now() - startedAtMs,
                progress: null,
                error: {
                    code,
                    message: (err && err.message) || 'Generation failed.'
                }
            });
        }
        onUpdate(session, job, { persist: true });
        return job;
    }

    detachProgress();

    // The image is already on disk (generateImage wrote it before resolving).
    // "Saving" covers the benchmark's own finalisation: real dimensions,
    // effective prompt and result metadata.
    updateJob(job, { status: 'saving' });
    onUpdate(session, job, { persist: false });

    let width = Number(result.width) || job.config.width;
    let height = Number(result.height) || job.config.height;
    try {
        const abs = path.join(deps.imageGenerator.GENERATED_DIR, path.basename(String(result.filename || '')));
        const probed = deps.imageGenerator.readImageDimensions(abs);
        if (probed && probed.width && probed.height) {
            width = probed.width;
            height = probed.height;
        }
    } catch (err) { /* keep the configured dimensions */ }

    const effectivePrompt = result.prompt || job.prompt;
    const promptChanged = String(effectivePrompt || '') !== String(job.prompt || '');
    updateJob(job, {
        status: 'completed',
        completedAt: nowIso(),
        durationMs: Date.now() - startedAtMs,
        progress: null,
        effectivePrompt,
        effectivePromptReason: promptChanged
            ? 'Active LoRA trigger words are prepended by the existing image pipeline.'
            : null,
        result: {
            url: result.url,
            filename: result.filename,
            historyId: result.meta && result.meta.id ? result.meta.id : null,
            width,
            height,
            seed: Number.isFinite(Number(result.seed)) ? Number(result.seed) : job.config.seed,
            generationMs: Number(result.generationMs) || (Date.now() - startedAtMs),
            model: result.model || job.modelId
        }
    });
    onUpdate(session, job, { persist: true });
    return job;
}

module.exports = {
    configure,
    runJob,
    statusOrder
};
