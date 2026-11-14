/* ============================================
   JARVIS — Image Arena manager
   Owns the benchmark session lifecycle: model
   discovery, one job per selected model, the
   persistent queue, background execution, live
   snapshots, history, retry, cancel and deletion.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const crypto = require('crypto');

const imageGenerator = require('../image-generator');

let deps = {
    registry: require('./registry'),
    adapters: require('./adapters'),
    queue: require('./queue'),
    runner: require('./runner'),
    store: require('./store'),
    generatedHistory: require('../generated-history')
};

const MODES = Object.freeze({ NATIVE: 'native', CONTROLLED: 'controlled' });
const JOB_STATUS = Object.freeze({
    PENDING: 'pending',
    QUEUED: 'queued',
    INITIALIZING: 'initializing',
    GENERATING: 'generating',
    SAVING: 'saving',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
});
const BUSY_STATUSES = new Set([
    JOB_STATUS.PENDING, JOB_STATUS.QUEUED, JOB_STATUS.INITIALIZING,
    JOB_STATUS.GENERATING, JOB_STATUS.SAVING
]);
const TERMINAL_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);
const MAX_PROMPT = 4000;
const MAX_MODELS = 12;
const DEFAULT_HISTORY_LIMIT = 30;

const subscribers = new Map();

const AUTO_RESUME = process.env.BENCHMARK_AUTORESUME !== 'false';

function configure(overrides) {
    deps = Object.assign({}, deps, overrides || {});
}

function nowIso() {
    return new Date().toISOString();
}

function newId(prefix) {
    return prefix + '_' + crypto.randomUUID();
}

function randomSeed() {
    return Math.floor(Math.random() * 2 ** 32);
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function httpError(status, message, extra) {
    const error = new Error(message);
    error.status = status;
    Object.assign(error, extra || {});
    return error;
}

function normalizeMode(value) {
    return String(value || '').trim().toLowerCase() === MODES.CONTROLLED ? MODES.CONTROLLED : MODES.NATIVE;
}

// Matched resolution: one explicit canvas shared by every job so results can be
// compared pixel-for-pixel. `auto` picks the smallest canvas every selected
// engine supports (MiniMax H3 Image's floor dominates when it is selected).
const MATCH_SIZES = ['auto', '0.75', '1', '1.25', '1.75', '4', '6', '10', '16', 'custom'];

function normalizeMatchSize(value) {
    const clean = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return MATCH_SIZES.indexOf(clean) === -1 ? 'auto' : clean;
}

function formatMegapixels(value) {
    const mp = Math.round((Number(value) || 0) * 100) / 100;
    return mp + ' MP';
}

function normalizeModels(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    value.forEach((id) => {
        const clean = String(id || '').trim();
        if (clean && out.indexOf(clean) === -1) out.push(clean);
    });
    return out.slice(0, MAX_MODELS);
}

function normalizeSettings(raw) {
    const request = raw && typeof raw === 'object' ? raw : {};
    const defaults = imageGenerator.effectiveSettings();
    const aspectRatio = imageGenerator.normalizeAspectRatio(request.aspectRatio) || defaults.aspectRatio;
    const imageSize = imageGenerator.normalizeImageSize(request.imageSize) || defaults.imageSize;
    const seedMode = String(request.seedMode || '').toLowerCase() === 'fixed' ? 'fixed' : 'random';
    const seed = imageGenerator.normalizeSeed(request.seed);
    const steps = request.steps === undefined || request.steps === null || request.steps === ''
        ? null
        : clampInt(request.steps, 1, 100, null);
    const cfg = request.cfg === undefined || request.cfg === null || request.cfg === ''
        ? null
        : Math.max(0, Math.min(30, Number(request.cfg)));
    const matchResolution = request.matchResolution === true;
    const matchSize = normalizeMatchSize(request.matchSize);
    const customCanvas = imageSize === 'CUSTOM' || (matchResolution && matchSize === 'custom');
    const width = customCanvas ? clampInt(request.width, 64, imageGenerator.MINIMAX_MAX_EDGE, defaults.width || 1024) : null;
    const height = customCanvas ? clampInt(request.height, 64, imageGenerator.MINIMAX_MAX_EDGE, defaults.height || 1024) : null;
    return {
        aspectRatio,
        imageSize,
        matchResolution,
        matchSize,
        width,
        height,
        seedMode,
        seed: seed === null ? null : seed,
        steps: Number.isFinite(steps) ? steps : null,
        cfg: Number.isFinite(cfg) ? cfg : null,
        allowPromptEnhancement: request.allowPromptEnhancement === true
    };
}

// Resolve the ONE canvas shared by every job in a matched session, or null when
// the session keeps each engine's own sizing. Every engine renders exactly this
// width/height (all of them accept an explicit canvas on a 32 px grid), so a
// mismatch is impossible by construction. Engines are never silently bent past
// their limits: MiniMax H3 Image refuses anything below 4 MP, and a canvas
// beyond an engine's maximum edge is rejected with an actionable message.
function resolveMatchedResolution(settings, sessionModels) {
    if (!settings || settings.matchResolution !== true) return null;
    const list = Array.isArray(sessionModels) ? sessionModels.filter(Boolean) : [];
    if (!list.length) return null;

    const limits = (model) => imageGenerator.imageModelResolutionLimits(model.id);
    const floor = list.reduce((value, model) => Math.max(value, limits(model).minMegapixels), 0) ||
        imageGenerator.IMAGE_MEGAPIXELS.S;

    let dims;
    let megapixels;
    if (settings.matchSize === 'custom') {
        dims = imageGenerator.resolveDimensions({
            aspectRatio: settings.aspectRatio,
            imageSize: 'CUSTOM',
            width: settings.width,
            height: settings.height
        });
        megapixels = (dims.width * dims.height) / 1e6;
    } else {
        megapixels = settings.matchSize === 'auto' ? floor : Number(settings.matchSize);
        dims = imageGenerator.dimensionsForMegapixels(settings.aspectRatio, megapixels);
    }

    list.forEach((model) => {
        const limit = limits(model);
        const canvas = dims.width + '×' + dims.height;
        if (limit.strictMinimum && megapixels < limit.minMegapixels - 0.001) {
            throw httpError(400, model.label + ' cannot render ' + canvas + ' (' + formatMegapixels(megapixels) +
                '): it needs at least ' + formatMegapixels(limit.minMegapixels) +
                '. Raise the matched resolution or deselect ' + model.label + '.');
        }
        if (limit.strictMinimum && megapixels > limit.maxMegapixels + 0.001) {
            throw httpError(400, model.label + ' cannot render ' + canvas + ' (' + formatMegapixels(megapixels) +
                '): it tops out at ' + formatMegapixels(limit.maxMegapixels) +
                '. Lower the matched resolution or deselect ' + model.label + '.');
        }
        if (dims.width > limit.maxEdge || dims.height > limit.maxEdge) {
            throw httpError(400, model.label + ' cannot render ' + canvas + ' (max ' + limit.maxEdge +
                ' px per edge). Choose a smaller matched resolution or deselect ' + model.label + '.');
        }
    });

    const notes = [];
    list.forEach((model) => {
        const limit = limits(model);
        if (limit.strictMinimum) return;
        if (megapixels < limit.minMegapixels - 0.001 || megapixels > limit.maxMegapixels + 0.001) {
            notes.push(model.label + ' renders at ' + formatMegapixels(megapixels) + ', outside its ' +
                limit.minMegapixels + '–' + limit.maxMegapixels + ' MP tier range.');
        }
    });

    return {
        width: dims.width,
        height: dims.height,
        megapixels: Math.round(megapixels * 100) / 100,
        matchSize: settings.matchSize,
        aspectRatio: dims.aspectRatio,
        autoMegapixels: floor,
        notes
    };
}

function resolveDims(model, mode, settings, matched) {
    if (matched && matched.width && matched.height) {
        return { width: matched.width, height: matched.height };
    }
    const native = model.native || {};
    if (mode === MODES.CONTROLLED) {
        return imageGenerator.resolveDimensions({
            model: model.id,
            aspectRatio: settings.aspectRatio,
            imageSize: settings.imageSize,
            width: settings.width || undefined,
            height: settings.height || undefined
        });
    }
    if (native.width && native.height) {
        return { width: native.width, height: native.height };
    }
    return imageGenerator.resolveDimensions({
        model: model.id,
        aspectRatio: settings.aspectRatio,
        imageSize: settings.imageSize
    });
}

// Build one job's fully-resolved generation settings from the discovered model
// defaults and the session mode. Nothing here rewrites the user prompt.
function resolveJobConfig(model, mode, settings, seed, matched) {
    const native = model.native || {};
    const dims = resolveDims(model, mode, settings, matched);
    let width = dims.width;
    let height = dims.height;
    if (model.id === 'moss') {
        width = imageGenerator.snapMossDimension(width);
        height = imageGenerator.snapMossDimension(height);
    }
    const controlled = mode === MODES.CONTROLLED;
    const matchedCanvas = Boolean(matched && matched.width && matched.height);
    const steps = controlled && settings.steps != null ? settings.steps : native.steps;
    const cfg = controlled && settings.cfg != null ? settings.cfg : native.cfg;
    const promptEnhancer = settings.allowPromptEnhancement === true && model.promptEnhancement === true;
    const unsupported = [];
    if (controlled) {
        if (settings.steps == null) unsupported.push('Steps use each model\'s default.');
        if (settings.cfg == null) unsupported.push('CFG uses each model\'s default.');
        (model.notes || []).forEach((note) => unsupported.push(note));
    }
    return {
        width,
        height,
        seed,
        steps: Number.isFinite(Number(steps)) ? Number(steps) : null,
        cfg: Number.isFinite(Number(cfg)) ? Number(cfg) : null,
        sampler: native.sampler || null,
        scheduler: native.scheduler || null,
        promptEnhancer,
        baseModels: model.baseModels || null,
        standardized: {
            prompt: true,
            resolution: controlled || matchedCanvas,
            matchedResolution: matchedCanvas,
            seed: controlled,
            steps: controlled && settings.steps != null,
            cfg: controlled && settings.cfg != null,
            sampler: false
        },
        unsupported
    };
}

function failedJob(modelId, reason, prompt) {
    return {
        id: newId('job'),
        modelId,
        modelLabel: modelId,
        engine: 'ComfyUI',
        type: 'Text-to-image',
        prompt,
        status: JOB_STATUS.FAILED,
        createdAt: nowIso(),
        completedAt: nowIso(),
        attempts: 0,
        favorite: false,
        progress: null,
        error: { code: 'engine_unavailable', message: reason },
        result: null,
        effectivePrompt: null,
        config: null
    };
}

function makeJob(model, mode, settings, prompt, seed, ownerSessionId, matched) {
    if (!model) return failedJob('unknown', 'This model is no longer registered.', prompt);
    const job = {
        id: newId('job'),
        modelId: model.id,
        modelLabel: model.label,
        engine: model.engine || 'ComfyUI',
        type: model.type || 'Text-to-image',
        prompt,
        ownerSessionId: ownerSessionId || null,
        status: JOB_STATUS.PENDING,
        createdAt: nowIso(),
        startedAt: null,
        completedAt: null,
        attempts: 0,
        favorite: false,
        progress: null,
        queueId: null,
        queuePosition: null,
        error: null,
        result: null,
        effectivePrompt: null,
        effectivePromptReason: null,
        engineConfig: model.baseModels || null,
        config: null
    };
    if (!model.available) {
        job.status = JOB_STATUS.FAILED;
        job.completedAt = job.createdAt;
        job.error = { code: model.errorCode || 'engine_unavailable', message: model.reason || 'This model is unavailable.' };
        return job;
    }
    if (!model.native) {
        job.status = JOB_STATUS.FAILED;
        job.completedAt = job.createdAt;
        job.error = { code: 'engine_config_unavailable', message: 'The engine did not report a usable generation configuration.' };
        return job;
    }
    job.config = resolveJobConfig(model, mode, settings, seed, matched);
    return job;
}

function countJobs(session) {
    const counts = {
        total: session.jobs.length,
        pending: 0, queued: 0, initializing: 0, generating: 0, saving: 0,
        completed: 0, failed: 0, cancelled: 0, active: 0
    };
    session.jobs.forEach((job) => {
        if (Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status] += 1;
        if (BUSY_STATUSES.has(job.status)) counts.active += 1;
    });
    return counts;
}

function standardizationSummary(session) {
    const mode = session.mode || MODES.NATIVE;
    const matched = session.matchedResolution || null;
    const notes = [];
    (matched && Array.isArray(matched.notes) ? matched.notes : []).forEach((note) => {
        if (notes.indexOf(note) === -1) notes.push(note);
    });
    session.jobs.forEach((job) => {
        (job.config && job.config.unsupported ? job.config.unsupported : []).forEach((note) => {
            if (notes.indexOf(note) === -1) notes.push(note);
        });
    });
    return {
        mode,
        prompt: true,
        resolution: mode === MODES.CONTROLLED || Boolean(matched),
        matched: Boolean(matched),
        matchedResolution: matched
            ? {
                width: matched.width,
                height: matched.height,
                label: matched.width + '×' + matched.height,
                megapixels: matched.megapixels,
                matchSize: matched.matchSize
            }
            : null,
        seed: mode === MODES.CONTROLLED,
        steps: mode === MODES.CONTROLLED && session.settings && session.settings.steps != null,
        cfg: mode === MODES.CONTROLLED && session.settings && session.settings.cfg != null,
        sampler: false,
        notes
    };
}

function queuePositions(session) {
    const positions = {};
    try {
        const status = deps.queue.getStatus();
        status.pending.forEach((entry) => {
            if (String(entry.sessionId) === String(session.id)) positions[entry.jobId] = entry.position;
        });
    } catch (err) { /* queue status is advisory */ }
    return positions;
}

function publicSnapshot(session) {
    if (!session) return null;
    const copy = JSON.parse(JSON.stringify(session));
    delete copy.sessionId;
    delete copy.cancelRequested;
    copy.counts = countJobs(session);
    copy.standardization = standardizationSummary(session);
    const positions = queuePositions(session);
    copy.jobs.forEach((job) => {
        delete job.ownerSessionId;
        if (positions[job.id]) job.queuePosition = positions[job.id];
    });
    return copy;
}

function sessionSummary(session) {
    const counts = countJobs(session);
    const first = session.jobs.find((job) => job.status === JOB_STATUS.COMPLETED && job.result && job.result.url);
    const prompt = String(session.prompt || '');
    return {
        id: session.id,
        prompt: prompt.length > 180 ? prompt.slice(0, 177) + '…' : prompt,
        mode: session.mode,
        status: session.status,
        total: counts.total,
        completed: counts.completed,
        failed: counts.failed,
        cancelled: counts.cancelled,
        active: counts.active,
        modelLabels: session.jobs.map((job) => job.modelLabel),
        createdAt: session.createdAt,
        completedAt: session.completedAt || null,
        durationMs: session.completedAt ? Math.max(0, Date.parse(session.completedAt) - Date.parse(session.createdAt)) : null,
        thumbnail: first ? first.result.url : null,
        favoriteCount: session.jobs.filter((job) => job.favorite).length
    };
}

function publish(session, extra) {
    if (!session) return;
    const set = subscribers.get(session.id);
    if (!set || !set.size) return;
    const payload = extra && extra.deleted
        ? { deleted: true, sessionId: session.id }
        : Object.assign({ session: publicSnapshot(session) }, extra || {});
    Array.from(set).forEach((cb) => {
        try { cb(payload); } catch (err) { /* a detached client never breaks a job */ }
    });
}

function subscribe(sessionId, cb) {
    const id = String(sessionId || '');
    if (!id || typeof cb !== 'function') return () => {};
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(cb);
    return () => {
        const set = subscribers.get(id);
        if (!set) return;
        set.delete(cb);
        if (!set.size) subscribers.delete(id);
    };
}

function finalizeSession(session, options) {
    if (!session) return null;
    const opts = options || {};
    const counts = countJobs(session);
    if (!session.startedAt && counts.completed + counts.failed + counts.cancelled > 0) {
        session.startedAt = session.createdAt;
    }
    if (counts.active > 0) {
        session.status = 'running';
        session.completedAt = null;
    } else if (counts.cancelled === counts.total) {
        session.status = 'cancelled';
        session.completedAt = session.completedAt || nowIso();
    } else if (counts.failed === 0 && counts.cancelled === 0 && counts.completed === counts.total) {
        session.status = 'completed';
        session.completedAt = session.completedAt || nowIso();
    } else if (counts.cancelled > 0 && counts.failed === 0 && counts.completed === 0) {
        session.status = 'cancelled';
        session.completedAt = session.completedAt || nowIso();
    } else if (counts.completed > 0) {
        session.status = 'completed_with_errors';
        session.completedAt = session.completedAt || nowIso();
    } else {
        session.status = 'failed';
        session.completedAt = session.completedAt || nowIso();
    }
    session.updatedAt = nowIso();
    if (opts.persist !== false) deps.store.upsert(session);
    if (opts.publish !== false) publish(session);
    return session;
}

function handleJobUpdate(session, job, meta) {
    const opts = meta || {};
    if (opts.persist) deps.store.upsert(session);
    publish(session);
}

function enqueueJob(session, job) {
    if (!session || !job) return false;
    if (job.status !== JOB_STATUS.PENDING) return false;
    const adapter = deps.adapters.getAdapter(job.modelId);
    if (!adapter) {
        job.status = JOB_STATUS.FAILED;
        job.completedAt = nowIso();
        job.error = { code: 'engine_unavailable', message: 'No adapter is registered for this model.' };
        deps.store.upsert(session);
        publish(session);
        return false;
    }
    job.status = JOB_STATUS.QUEUED;
    job.ownerSessionId = job.ownerSessionId || session.sessionId || null;
    job.updatedAt = nowIso();
    const key = deps.queue.entryKey(session.id, job.id);
    const accepted = deps.queue.enqueue({
        sessionId: session.id,
        jobId: job.id,
        locality: adapter.locality || 'local',
        run: async () => {
            const live = deps.store.get(session.id);
            if (!live) return;
            const liveJob = live.jobs.find((entry) => entry.id === job.id);
            if (!liveJob || liveJob.status === JOB_STATUS.CANCELLED || liveJob.cancelRequested) {
                if (liveJob) {
                    liveJob.status = JOB_STATUS.CANCELLED;
                    liveJob.completedAt = liveJob.completedAt || nowIso();
                    liveJob.error = liveJob.error || { code: 'benchmark_cancelled', message: 'Cancelled before generation started.' };
                }
                finalizeSession(live);
                return;
            }
            await deps.runner.runJob(live, liveJob, {
                adapter,
                onUpdate: handleJobUpdate
            });
            finalizeSession(live);
        }
    });
    if (!accepted) {
        // Already queued/running (e.g. a duplicate recovery pass).
        return false;
    }
    deps.store.upsert(session);
    publish(session);
    return true;
}

async function createSession(input) {
    const request = input || {};
    const prompt = String(request.prompt || '').trim();
    if (!prompt) throw httpError(400, 'A prompt is required.');
    if (prompt.length > MAX_PROMPT) throw httpError(400, 'The prompt is too long (max ' + MAX_PROMPT + ' characters).');
    const models = normalizeModels(request.models);
    if (!models.length) throw httpError(400, 'Select at least one image model.');
    const mode = normalizeMode(request.mode);
    const settings = normalizeSettings(request.settings);

    const discovered = await deps.registry.listModels({ refresh: true });
    const byId = new Map(discovered.map((model) => [model.id, model]));
    const known = models.filter((id) => byId.has(id));
    if (!known.length) throw httpError(400, 'None of the selected image models are registered.');
    const available = known.filter((id) => byId.get(id).available);
    if (!available.length) {
        const reasons = known.map((id) => {
            const model = byId.get(id);
            return model.label + ': ' + (model.reason || 'unavailable');
        });
        throw httpError(400, 'None of the selected models are ready. ' + reasons.join(' · '));
    }

    const sessionSeed = mode === MODES.CONTROLLED
        ? (settings.seedMode === 'fixed' && settings.seed !== null
            ? settings.seed
            : (settings.seed !== null ? settings.seed : randomSeed()))
        : null;
    const availableModels = models.map((id) => byId.get(id)).filter((model) => model && model.available);
    const matched = resolveMatchedResolution(settings, availableModels);
    const jobs = models.map((id) => {
        const model = byId.get(id);
        if (!model) return failedJob(id, 'This model is no longer registered.', prompt);
        const seed = mode === MODES.CONTROLLED
            ? sessionSeed
            : (settings.seedMode === 'fixed' && settings.seed !== null ? settings.seed : randomSeed());
        return makeJob(model, mode, settings, prompt, seed, request.sessionId || null, matched);
    });

    const session = {
        id: newId('bm'),
        sessionId: request.sessionId || null,
        prompt,
        mode,
        requestedModels: models,
        settings: Object.assign({}, settings, { seedUsed: sessionSeed }),
        matchedResolution: matched,
        jobs,
        status: 'running',
        cancelRequested: false,
        concurrency: 1,
        createdAt: nowIso(),
        startedAt: null,
        completedAt: null,
        updatedAt: nowIso()
    };

    deps.store.upsert(session);
    jobs.filter((job) => job.status === JOB_STATUS.PENDING).forEach((job) => enqueueJob(session, job));
    finalizeSession(session);
    return publicSnapshot(session);
}

function ownedSession(id, sessionId) {
    const session = deps.store.get(id);
    if (!session) return null;
    if (sessionId && session.sessionId && session.sessionId !== sessionId) return null;
    return session;
}

function getSession(id, sessionId) {
    return publicSnapshot(ownedSession(id, sessionId));
}

function getActive(sessionId) {
    const sessions = deps.store.list()
        .filter((session) => !sessionId || !session.sessionId || session.sessionId === sessionId)
        .filter((session) => session.status === 'running' || countJobs(session).active > 0);
    return sessions.length ? publicSnapshot(sessions[0]) : null;
}

function listHistory(sessionId, limit) {
    const max = clampInt(limit, 1, 100, DEFAULT_HISTORY_LIMIT);
    return deps.store.list()
        .filter((session) => !sessionId || !session.sessionId || session.sessionId === sessionId)
        .slice(0, max)
        .map(sessionSummary);
}

async function cancelSession(id, sessionId) {
    const session = ownedSession(id, sessionId);
    if (!session) throw httpError(404, 'Benchmark session not found.');
    session.cancelRequested = true;
    let changed = false;
    const running = [];
    session.jobs.forEach((job) => {
        if (job.status === JOB_STATUS.CANCELLED || TERMINAL_STATUSES.has(job.status)) return;
        const key = deps.queue.entryKey(session.id, job.id);
        if (deps.queue.isRunning(key)) {
            job.cancelRequested = true;
            running.push(job);
            changed = true;
            return;
        }
        // Pending or queued in the benchmark queue: remove it and mark the job
        // cancelled immediately. A running ComfyUI job is aborted separately.
        deps.queue.cancelPending(key);
        job.status = JOB_STATUS.CANCELLED;
        job.completedAt = nowIso();
        job.cancelRequested = true;
        job.error = { code: 'benchmark_cancelled', message: 'Cancelled before generation started.' };
        changed = true;
    });
    if (changed) deps.store.upsert(session);

    for (const job of running) {
        const adapter = deps.adapters.getAdapter(job.modelId);
        if (adapter && typeof adapter.cancel === 'function') {
            try { await adapter.cancel(job); } catch (err) { /* waiter still aborts */ }
        }
    }

    finalizeSession(session);
    return publicSnapshot(session);
}

async function retrySession(id, sessionId, jobId) {
    const session = ownedSession(id, sessionId);
    if (!session) throw httpError(404, 'Benchmark session not found.');
    const counts = countJobs(session);
    if (counts.active > 0) throw httpError(409, 'Wait for the running benchmark to finish, or cancel it, before retrying.');

    const discovered = await deps.registry.listModels({ refresh: true });
    const byId = new Map(discovered.map((model) => [model.id, model]));
    const wanted = jobId ? [String(jobId)] : null;
    const retryable = session.jobs.filter((job) => {
        if (wanted && job.id !== wanted[0]) return false;
        return job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.CANCELLED;
    });
    if (!retryable.length) throw httpError(400, 'There are no failed or cancelled jobs to retry.');

    retryable.forEach((job) => {
        const model = byId.get(job.modelId);
        // Controlled mode keeps the benchmark's shared seed; native mode keeps
        // the job's original seed so a retry reproduces the same conditions.
        const seed = session.mode === MODES.CONTROLLED
            ? (session.settings.seedUsed !== undefined && session.settings.seedUsed !== null
                ? session.settings.seedUsed
                : (session.settings.seed !== null ? session.settings.seed : randomSeed()))
            : (job.config && Number.isFinite(Number(job.config.seed)) ? Number(job.config.seed) : randomSeed());
        if (!model || !model.available || !model.native) {
            job.status = JOB_STATUS.FAILED;
            job.completedAt = nowIso();
            job.error = {
                code: (model && model.errorCode) || 'engine_unavailable',
                message: (model && model.reason) || 'This model is no longer available.'
            };
            job.cancelRequested = false;
            return;
        }
        job.status = JOB_STATUS.PENDING;
        job.cancelRequested = false;
        job.startedAt = null;
        job.completedAt = null;
        job.error = null;
        job.progress = null;
        job.result = null;
        job.effectivePrompt = null;
        job.effectivePromptReason = null;
        job.queueId = null;
        job.queuePosition = null;
        job.ownerSessionId = job.ownerSessionId || session.sessionId || null;
        job.engineConfig = model.baseModels || null;
        job.config = resolveJobConfig(model, session.mode, session.settings, seed, session.matchedResolution);
        job.updatedAt = nowIso();
    });

    session.cancelRequested = false;
    session.completedAt = null;
    session.status = 'running';
    deps.store.upsert(session);
    retryable.filter((job) => job.status === JOB_STATUS.PENDING).forEach((job) => enqueueJob(session, job));
    finalizeSession(session);
    return publicSnapshot(session);
}

function setFavorite(id, sessionId, jobId, favorite) {
    const session = ownedSession(id, sessionId);
    if (!session) throw httpError(404, 'Benchmark session not found.');
    const job = session.jobs.find((entry) => entry.id === String(jobId));
    if (!job) throw httpError(404, 'Benchmark result not found.');
    job.favorite = favorite === true;
    job.updatedAt = nowIso();
    deps.store.upsert(session);
    publish(session);
    return publicSnapshot(session);
}

function deleteSession(id, sessionId) {
    const session = ownedSession(id, sessionId);
    if (!session) throw httpError(404, 'Benchmark session not found.');
    const counts = countJobs(session);
    if (counts.active > 0) {
        throw httpError(409, 'Cancel or wait for the running benchmark before deleting it.');
    }
    session.jobs.forEach((job) => {
        if (job.result && job.result.filename) {
            // The benchmark session already passed the device ownership check,
            // and a result filename is produced by this job (never client
            // input), so delete by filename without a second session filter.
            // This also cleans media that the legacy-gallery adoption stamped
            // with another device id before this fix.
            try { deps.generatedHistory.removeByFilename(job.result.filename); } catch (err) {
                console.warn('[benchmark] Could not remove generated file:', err.message);
            }
        }
    });
    deps.store.remove(session.id);
    publish(session, { deleted: true });
    return { ok: true, deleted: session.id, filesRemoved: session.jobs.filter((job) => job.result && job.result.filename).length };
}

function getQueueStatus() {
    return deps.queue.getStatus();
}

async function listModels(options) {
    return deps.registry.listModels(options || {});
}

// Restart recovery. A job that was queued/running when the process died is
// marked failed with an `interrupted` code — never silently completed — so the
// user can retry it. Jobs that had not started yet are resumed (opt out with
// BENCHMARK_AUTORESUME=false). This prevents duplicate ComfyUI submissions for
// work that may still be running on the ComfyUI side.
function recoverSessions() {
    let recovered = 0;
    let resumed = 0;
    deps.store.list().slice().forEach((session) => {
        let changed = false;
        let sessionResumed = 0;
        session.jobs.forEach((job) => {
            if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.INITIALIZING ||
                job.status === JOB_STATUS.GENERATING || job.status === JOB_STATUS.SAVING) {
                job.status = JOB_STATUS.FAILED;
                job.interrupted = true;
                job.completedAt = nowIso();
                job.progress = null;
                job.queueId = null;
                job.queuePosition = null;
                job.error = {
                    code: 'interrupted',
                    message: 'JARVIS restarted while this job was running. It was not completed; retry it to generate again.'
                };
                changed = true;
                recovered += 1;
            }
        });
        if (changed || session.status === 'running') finalizeSession(session, { publish: false });
        const pending = session.jobs.filter((job) => job.status === JOB_STATUS.PENDING);
        if (AUTO_RESUME && pending.length && !session.deleted) {
            pending.forEach((job) => {
                if (enqueueJob(session, job)) sessionResumed += 1;
            });
        }
        if (changed || sessionResumed) deps.store.upsert(session);
        resumed += sessionResumed;
    });
    if (recovered || resumed) {
        console.log('[benchmark] recovered ' + recovered + ' interrupted job(s), resumed ' + resumed + ' pending job(s)');
    }
    return { recovered, resumed };
}

module.exports = {
    MODES,
    JOB_STATUS,
    configure,
    createSession,
    getSession,
    getActive,
    listHistory,
    subscribe,
    cancelSession,
    retrySession,
    setFavorite,
    deleteSession,
    getQueueStatus,
    listModels,
    recoverSessions,
    publicSnapshot,
    // exported for tests
    normalizeSettings,
    resolveJobConfig,
    resolveMatchedResolution,
    countJobs
};
