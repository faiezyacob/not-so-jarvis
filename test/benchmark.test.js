/* ============================================
   JARVIS — Image Arena tests
   Discovery adaptation, the persistent queue,
   failure isolation, retry, cancellation, restart
   recovery and session deletion. No GPU/ComfyUI
   call is made: adapters are stubbed.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-benchmark-'));
process.env.BENCHMARK_PATH = path.join(TMP, 'benchmark-sessions.json');
process.env.BENCHMARK_AUTORESUME = 'false';

const store = require('../services/benchmark/store');
const queue = require('../services/benchmark/queue');
const runner = require('../services/benchmark/runner');
const registry = require('../services/benchmark/registry');
const manager = require('../services/benchmark/manager');
const imageGenerator = require('../services/image-generator');
const { graphFor, samplerConfig } = require('../services/benchmark/adapters/comfyui');

function waitFor(check, timeoutMs) {
    const limit = timeoutMs || 4000;
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            try {
                const value = check();
                if (value) return resolve(value);
            } catch (err) {
                return reject(err);
            }
            if (Date.now() - started > limit) return reject(new Error('Timed out waiting for condition'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

function fakeModel(id, overrides = {}) {
    return Object.assign({
        id,
        label: id === 'good' ? 'Good Model' : (id === 'bad' ? 'Bad Model' : id),
        engine: 'ComfyUI',
        locality: 'local',
        type: 'Text-to-image',
        available: true,
        reason: null,
        errorCode: null,
        capabilities: { promptEnhancement: false },
        native: { width: 512, height: 512, steps: 10, cfg: 2, sampler: 'euler', scheduler: 'simple' },
        resolution: { width: 512, height: 512, label: '512×512' },
        baseModels: { unet: 'unet.safetensors', clip: 'clip.safetensors', clipType: 'krea2', vae: 'vae.safetensors', loras: [] },
        promptEnhancement: false,
        notes: []
    }, overrides);
}

function successResult(job) {
    return {
        url: '/generated/' + job.modelId + '.png',
        filename: job.modelId + '.png',
        width: 512,
        height: 512,
        seed: job.config.seed,
        model: job.modelId,
        prompt: job.prompt,
        generationMs: 12,
        meta: { id: 'hist-' + job.modelId }
    };
}

function adapterFor(id, run, cancel) {
    return {
        id,
        label: id,
        engine: 'ComfyUI',
        locality: 'local',
        run: run || (async (job, hooks) => {
            if (hooks && hooks.onQueued) hooks.onQueued(1, 11);
            if (hooks && hooks.onStart) hooks.onStart(11);
            return successResult(job);
        }),
        cancel: cancel || (async () => true)
    };
}

function configureFixture(options) {
    const opts = options || {};
    const adapters = opts.adapters || new Map();
    const history = opts.generatedHistory || { removeByFilename: () => 1 };
    queue.reset();
    manager.configure({
        store,
        registry: {
            listModels: async () => opts.models || [fakeModel('good'), fakeModel('bad')]
        },
        adapters: {
            getAdapter: (id) => adapters.get(id) || null
        },
        queue,
        runner,
        generatedHistory: history
    });
    runner.configure({
        imageGenerator: {
            GENERATED_DIR: TMP,
            readImageDimensions: () => ({ width: 512, height: 512 })
        },
        vramManager: { freeVRAMBeforeImage: async () => ({ freed: false }) },
        comfyui: {
            subscribeProgress: () => {},
            unsubscribeProgress: () => {}
        }
    });
    store.reset();
}

// --- Queue -----------------------------------------------------------------

test('queue serializes local jobs and keeps going after a failure', async () => {
    queue.reset();
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    let done;
    const finished = new Promise((resolve) => { done = resolve; });

    const run = (key, fail) => ({
        sessionId: 's',
        jobId: key,
        locality: 'local',
        run: async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            order.push(key);
            await new Promise((resolve) => setTimeout(resolve, 8));
            concurrent -= 1;
            if (order.length === 2) done();
            if (fail) throw new Error('boom');
        }
    });

    queue.enqueue(run('a', true));
    queue.enqueue(run('b', false));
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(maxConcurrent, 1);
    assert.equal(queue.getStatus().running.length, 0);
});

test('queue cancels a pending entry before it runs', async () => {
    queue.reset();
    let ran = false;
    const key = queue.entryKey('s', 'pending-job');
    queue.enqueue({
        sessionId: 's',
        jobId: 'hold',
        locality: 'local',
        run: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }
    });
    queue.enqueue({
        sessionId: 's',
        jobId: 'pending-job',
        locality: 'local',
        run: async () => { ran = true; }
    });
    assert.equal(queue.cancelPending(key), 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ran, false);
});

// --- Store -----------------------------------------------------------------

test('store persists a session across an in-memory reset', () => {
    store.reset();
    const record = { id: 'bm_store_test', sessionId: 'device-a', prompt: 'p', jobs: [] };
    store.upsert(record);
    store.reset();
    const loaded = store.get('bm_store_test');
    assert.ok(loaded);
    assert.equal(loaded.sessionId, 'device-a');
    const raw = JSON.parse(fs.readFileSync(process.env.BENCHMARK_PATH, 'utf-8'));
    assert.ok(raw.sessions.some((entry) => entry.id === 'bm_store_test'));
    store.remove('bm_store_test');
    assert.equal(store.get('bm_store_test'), null);
});

// --- Discovery adaptation --------------------------------------------------

test('registry exposes real size tiers and availability from adapter inspection', async () => {
    const fakeAdapters = [{
        id: 'qwen_image_2_1',
        label: 'Qwen Image 2.1',
        engine: 'ComfyUI',
        locality: 'local',
        capabilities: { promptEnhancement: false },
        inspect: async () => ({
            available: true,
            native: { width: 864, height: 1152, steps: 24, cfg: 3, sampler: 'euler', scheduler: 'bong_tangent' },
            baseModels: { unet: 'q.safetensors', clip: 'c.safetensors', vae: 'v.safetensors', clipType: 'qwen_image', loras: [] },
            standardizationNotes: ['note']
        })
    }, {
        id: 'moss',
        label: 'MOSS-Image',
        engine: 'ComfyUI',
        locality: 'local',
        capabilities: { promptEnhancement: true },
        inspect: async () => ({
            available: false,
            reason: 'Missing model file',
            errorCode: 'comfyui_missing_model'
        })
    }];
    registry.configure({
        comfyui: {
            isAvailable: async () => true,
            getObjectInfo: async () => ({})
        },
        adapters: { listAdapters: () => fakeAdapters },
        imageGenerator
    });
    const models = await registry.listModels({ refresh: true });
    const qwen = models.find((model) => model.id === 'qwen_image_2_1');
    assert.equal(qwen.available, true);
    assert.equal(qwen.native.steps, 24);
    assert.equal(qwen.supportedResolutions.length, 4);
    assert.match(qwen.supportedResolutions[0].label, /0\.75 MP/);
    const moss = models.find((model) => model.id === 'moss');
    assert.equal(moss.available, false);
    assert.match(moss.reason, /Missing model file/);
    registry.reset();
});

test('adapter graph probe reads the real image-generator defaults', () => {
    const info = { MiniMaxH3ImageConditioning: {} };
    const settings = imageGenerator.effectiveSettings();
    const probe = graphFor('moss', settings, info, {});
    const config = samplerConfig(probe.graph);
    assert.equal(config.sampler, 'er_sde');
    assert.equal(config.scheduler, 'simple');
    assert.ok(config.steps > 0);
    assert.ok(config.width > 0 && config.height > 0);
});

// --- Manager lifecycle -----------------------------------------------------

test('a failed model never stops the remaining benchmark jobs', async () => {
    const adapters = new Map([
        ['good', adapterFor('good')],
        ['bad', adapterFor('bad', async () => {
            const error = new Error('Engine exploded');
            error.code = 'test_engine_error';
            throw error;
        })]
    ]);
    configureFixture({ adapters });
    const snapshot = await manager.createSession({
        sessionId: 'device-a',
        prompt: 'A single prompt',
        models: ['good', 'bad'],
        mode: 'native',
        settings: {}
    });
    assert.ok(snapshot.id);
    const done = await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-a');
        return current && current.status !== 'running' ? current : null;
    });
    assert.equal(done.status, 'completed_with_errors');
    assert.equal(done.counts.completed, 1);
    assert.equal(done.counts.failed, 1);
    const good = done.jobs.find((job) => job.modelId === 'good');
    const bad = done.jobs.find((job) => job.modelId === 'bad');
    assert.equal(good.status, 'completed');
    assert.equal(good.result.width, 512);
    assert.equal(bad.status, 'failed');
    assert.match(bad.error.message, /Engine exploded/);
    // The prompt is passed unchanged (no rewrite/expansion).
    assert.equal(good.effectivePrompt, 'A single prompt');

    // Persisted record survived a cache reset.
    store.reset();
    assert.equal(store.get(snapshot.id).status, 'completed_with_errors');
});

test('retry requeues only a failed job and completes the session', async () => {
    let badShouldFail = true;
    const adapters = new Map([
        ['good', adapterFor('good')],
        ['bad', adapterFor('bad', async (job, hooks) => {
            if (hooks.onQueued) hooks.onQueued(1, 12);
            if (hooks.onStart) hooks.onStart(12);
            if (badShouldFail) {
                const error = new Error('first attempt failed');
                error.code = 'test_engine_error';
                throw error;
            }
            return successResult(job);
        })]
    ]);
    configureFixture({ adapters });
    const snapshot = await manager.createSession({
        sessionId: 'device-b', prompt: 'retry me', models: ['good', 'bad'], mode: 'native', settings: {}
    });
    const first = await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-b');
        return current && current.status !== 'running' ? current : null;
    });
    assert.equal(first.counts.failed, 1);
    const badJob = first.jobs.find((job) => job.modelId === 'bad');

    badShouldFail = false;
    await manager.retrySession(snapshot.id, 'device-b', badJob.id);
    const retried = await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-b');
        return current && current.status !== 'running' ? current : null;
    });
    assert.equal(retried.status, 'completed');
    const badAfter = retried.jobs.find((job) => job.modelId === 'bad');
    assert.equal(badAfter.status, 'completed');
    assert.equal(badAfter.attempts >= 2, true);
});

test('cancelling a running benchmark interrupts the active adapter', async () => {
    let rejectActive = null;
    const adapters = new Map([['slow', adapterFor('slow',
        () => new Promise((resolve, reject) => { rejectActive = reject; }),
        async () => {
            if (rejectActive) {
                const error = new Error('Generation cancelled.');
                error.code = 'generation_cancelled';
                rejectActive(error);
            }
            return true;
        }
    )]]);
    configureFixture({ adapters, models: [fakeModel('slow', { label: 'Slow Model' })] });
    const snapshot = await manager.createSession({
        sessionId: 'device-c', prompt: 'slow prompt', models: ['slow'], mode: 'native', settings: {}
    });
    await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-c');
        const job = current && current.jobs[0];
        return job && job.status === 'generating' ? current : null;
    });
    const cancelled = await manager.cancelSession(snapshot.id, 'device-c');
    assert.equal(cancelled.status, 'cancelled');
    const final = await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-c');
        return current && current.status !== 'running' ? current : null;
    });
    assert.equal(final.status, 'cancelled');
    assert.equal(final.jobs[0].status, 'cancelled');
});

test('deleting a session removes its generated files and record', async () => {
    let removed = 0;
    const adapters = new Map([['good', adapterFor('good')]]);
    configureFixture({
        adapters,
        models: [fakeModel('good')],
        generatedHistory: { removeByFilename: (name) => { removed += 1; return 1; } }
    });
    const snapshot = await manager.createSession({
        sessionId: 'device-d', prompt: 'delete me', models: ['good'], mode: 'native', settings: {}
    });
    await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-d');
        return current && current.status === 'completed' ? current : null;
    });
    const result = manager.deleteSession(snapshot.id, 'device-d');
    assert.equal(result.ok, true);
    assert.equal(removed, 1);
    assert.equal(store.get(snapshot.id), null);
});

test('restart recovery marks an in-flight job interrupted, never completed', () => {
    const record = {
        id: 'bm_interrupted',
        sessionId: 'device-e',
        prompt: 'was running',
        mode: 'native',
        settings: { seedUsed: 1 },
        jobs: [{
            id: 'job_interrupted',
            modelId: 'good',
            modelLabel: 'Good Model',
            status: 'generating',
            attempts: 1,
            config: { width: 512, height: 512, seed: 1, steps: 10, cfg: 2 },
            result: null
        }],
        status: 'running',
        createdAt: new Date().toISOString()
    };
    store.upsert(record);
    manager.recoverSessions();
    const recovered = store.get('bm_interrupted');
    assert.equal(recovered.jobs[0].status, 'failed');
    assert.equal(recovered.jobs[0].interrupted, true);
    assert.equal(recovered.jobs[0].error.code, 'interrupted');
    assert.equal(recovered.jobs[0].result, null);
    assert.notEqual(recovered.status, 'completed');
});

test('sessions are scoped to their device session', async () => {
    const adapters = new Map([['good', adapterFor('good')]]);
    configureFixture({ adapters, models: [fakeModel('good')] });
    const snapshot = await manager.createSession({
        sessionId: 'owner-device', prompt: 'private', models: ['good'], mode: 'native', settings: {}
    });
    assert.equal(manager.getSession(snapshot.id, 'other-device'), null);
    assert.ok(manager.getSession(snapshot.id, 'owner-device'));
    await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'owner-device');
        return current && current.status !== 'running' ? current : null;
    });
});

// --- Matched output resolution ---------------------------------------------

test('a matched size resolves one shared canvas for every engine', () => {
    const settings = manager.normalizeSettings({ aspectRatio: '1:1', matchResolution: true, matchSize: '1' });
    const matched = manager.resolveMatchedResolution(settings, [
        { id: 'qwen_image_2_1' }, { id: 'moss' }, { id: 'krea2' }
    ]);
    assert.deepEqual([matched.width, matched.height], [992, 992]);
    assert.equal(matched.megapixels, 1);
    assert.equal(matched.notes.length, 0);
});

test('auto matching uses the strictest engine floor', () => {
    const settings = manager.normalizeSettings({ aspectRatio: '1:1', matchResolution: true, matchSize: 'auto' });
    const withoutMiniMax = manager.resolveMatchedResolution(settings, [{ id: 'qwen_image_2_1' }]);
    assert.equal(withoutMiniMax.megapixels, 0.75);
    const withMiniMax = manager.resolveMatchedResolution(settings, [
        { id: 'qwen_image_2_1' }, { id: 'minimax_h3_image' }
    ]);
    assert.equal(withMiniMax.megapixels, 4);
    assert.deepEqual([withMiniMax.width, withMiniMax.height], [2016, 2016]);
});

test('matching below an engine floor is rejected, never silently raised', () => {
    const settings = manager.normalizeSettings({ aspectRatio: '1:1', matchResolution: true, matchSize: '1' });
    assert.throws(
        () => manager.resolveMatchedResolution(settings, [{ id: 'minimax_h3_image' }]),
        /at least 4 MP/
    );
});

test('a canvas beyond an engine max edge or ceiling is rejected', () => {
    const tall = manager.normalizeSettings({ aspectRatio: '3:4', matchResolution: true, matchSize: '16' });
    assert.throws(
        () => manager.resolveMatchedResolution(tall, [{ id: 'qwen_image_2_1' }]),
        /4096/
    );
    const oversized = manager.normalizeSettings({
        matchResolution: true, matchSize: 'custom', width: 4096, height: 4096
    });
    assert.throws(
        () => manager.resolveMatchedResolution(oversized, [{ id: 'minimax_h3_image' }]),
        /tops out at 16 MP/
    );
    // 16 MP 16:9 is inside MiniMax's ceiling and needs no notes.
    const wide = manager.normalizeSettings({ aspectRatio: '16:9', matchResolution: true, matchSize: '16' });
    const matched = manager.resolveMatchedResolution(wide, [{ id: 'minimax_h3_image' }]);
    assert.deepEqual([matched.width, matched.height], [5344, 3008]);
});

test('a custom matched canvas is snapped to the 32 px grid', () => {
    const settings = manager.normalizeSettings({
        matchResolution: true, matchSize: 'custom', width: 1000, height: 1500
    });
    const matched = manager.resolveMatchedResolution(settings, [{ id: 'qwen_image_2_1' }]);
    assert.deepEqual([matched.width, matched.height], [992, 1504]);
});

test('an engine outside its tier range is reported, not blocked', () => {
    const settings = manager.normalizeSettings({ aspectRatio: '1:1', matchResolution: true, matchSize: '4' });
    const matched = manager.resolveMatchedResolution(settings, [{ id: 'qwen_image_2_1' }]);
    assert.equal(matched.megapixels, 4);
    assert.match(matched.notes.join(' '), /outside its 0.75–1.75 MP tier range/);
});

test('a matched benchmark gives every job the exact same canvas', async () => {
    const ids = ['qwen_image_2_1', 'minimax_h3_image', 'moss'];
    const models = ids.map((id) => fakeModel(id));
    const adapters = new Map(ids.map((id) => [id, adapterFor(id)]));
    configureFixture({ adapters, models });
    const snapshot = await manager.createSession({
        sessionId: 'device-matched',
        prompt: 'same canvas',
        models: ids,
        mode: 'native',
        settings: { aspectRatio: '1:1', matchResolution: true, matchSize: '4' }
    });
    const dims = snapshot.jobs.map((job) => job.config.width + '×' + job.config.height);
    assert.equal(new Set(dims).size, 1);
    assert.equal(dims[0], '2016×2016');
    assert.equal(snapshot.standardization.matched, true);
    assert.equal(snapshot.standardization.resolution, true);
    assert.equal(snapshot.standardization.matchedResolution.label, '2016×2016');
    await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-matched');
        return current && current.status !== 'running' ? current : null;
    });
});

test('without matching, native jobs keep their own canvas', async () => {
    const models = [
        fakeModel('qwen_image_2_1'),
        fakeModel('minimax_h3_image', { native: { width: 2752, height: 3648, steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple' } })
    ];
    const adapters = new Map([['qwen_image_2_1', adapterFor('qwen_image_2_1')], ['minimax_h3_image', adapterFor('minimax_h3_image')]]);
    configureFixture({ adapters, models });
    const snapshot = await manager.createSession({
        sessionId: 'device-native', prompt: 'native', models: ['qwen_image_2_1', 'minimax_h3_image'], mode: 'native', settings: {}
    });
    const dims = new Set(snapshot.jobs.map((job) => job.config.width + '×' + job.config.height));
    assert.equal(dims.size, 2);
    assert.equal(snapshot.standardization.matched, false);
    await waitFor(() => {
        const current = manager.getSession(snapshot.id, 'device-native');
        return current && current.status !== 'running' ? current : null;
    });
});

test('a retry reuses the session canvas instead of the engine default', () => {
    const settings = manager.normalizeSettings({ matchResolution: true, matchSize: '4', aspectRatio: '1:1' });
    const config = manager.resolveJobConfig(fakeModel('qwen_image_2_1'), 'native', settings, 7, {
        width: 2016, height: 2016, megapixels: 4
    });
    assert.deepEqual([config.width, config.height], [2016, 2016]);
    assert.equal(config.standardized.matchedResolution, true);
    assert.equal(config.standardized.resolution, true);
});
