/* ============================================
   JARVIS — H3 Recast engine adapter
   One-pass BFS character swap on MiniMax H3
   (scene reference + trained body_swap caption
   + guide video) and the optional lip-repair
   pass. Reuses the app's generation queue,
   ComfyUI transport, history and metrics.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const comfyui = require('../../comfyui');
const generationQueue = require('../../generation-queue');
const generatedHistory = require('../../generated-history');
const videoGenerator = require('../../video-generator');
const videoReplacement = require('../../video-replacement');

const metrics = require('../metrics');
const graphBuilder = require('./h3-recast-graph');

const ID = 'h3';
const LABEL = 'MiniMax H3 Recast';
const MAX_SECONDS = 15;
const FPS = graphBuilder.FPS;

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(DATA_DIR, 'generated');

function ensureGeneratedDir() {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    return GENERATED_DIR;
}

function safeFilename(value) {
    return String(value || 'recast').replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'recast';
}

function mimeFor(file) {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    return 'video/mp4';
}

function normalizeSettings(settings, info) {
    return graphBuilder.normalizeSettings(settings, info || null);
}

function resolveModels(info, settings) {
    return graphBuilder.resolveModels(info, settings);
}

function dimensionsFor(width, height, size) {
    return videoGenerator.h3Dimensions(width, height, size);
}

function largestValidFrames(available) {
    const cap = Math.floor(Number(available) || 0);
    if (cap < 5) return 0;
    let best = 5;
    for (let n = 5; n <= cap; n += 17) best = n;
    return best;
}

function framesFor(seconds, availableFrames) {
    const requested = videoGenerator.h3FramesForSeconds(seconds);
    const available = Math.floor(Number(availableFrames) || 0);
    if (available > 0) {
        if (requested <= available) return requested;
        const capped = largestValidFrames(available);
        if (capped >= 5) return capped;
        return 0;
    }
    return requested;
}

function availability(info, settings = {}) {
    const missing = [];
    const warnings = [];
    const refineOnly = Boolean(settings && settings.refineOnly);
    const resolved = normalizeSettings(settings, info);
    missing.push(...graphBuilder.missingNodes(info, refineOnly ? graphBuilder.LIP_NODES : graphBuilder.SWAP_NODES));
    const models = resolveModels(info, settings);
    missing.push(...(refineOnly ? models.missingLip : models.missingSwap));
    if (!refineOnly && !resolved.attention) missing.push('an attention backend (Comfy Kitchen or PyTorch)');
    if (refineOnly || resolved.lip.enabled) {
        if (!models.faceDetectorAvailable) missing.push('the face detector (face_yolov8m.pt)');
    }
    if (!info || typeof info !== 'object') {
        return { id: ID, label: LABEL, available: false, missing: ['ComfyUI is not reachable.'], warnings };
    }
    return {
        id: ID,
        label: LABEL,
        available: missing.length === 0,
        missing: Array.from(new Set(missing)),
        warnings
    };
}

async function uploadFile(absPath, prefix) {
    const buffer = fs.readFileSync(absPath);
    const name = prefix + '_' + Date.now() + '_' + path.basename(absPath);
    const uploaded = await comfyui.uploadFile(buffer, name, { mime: mimeFor(absPath) });
    return { name: (uploaded && uploaded.name) || name, buffer };
}

function saveVideoBuffer(buffer, marker) {
    ensureGeneratedDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_' + marker + '_' + stamp + '.mp4';
    fs.writeFileSync(path.join(GENERATED_DIR, basename), buffer);
    return basename;
}

async function renderSwap(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'H3 Recast character swap',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        const startedAt = Date.now();
        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);
        const info = await comfyui.getObjectInfo();
        const settings = normalizeSettings(plan.settings, info);
        const models = resolveModels(info, plan.settings);
        if (models.missingSwap.length) {
            const error = new Error('H3 Recast is not ready: ' + models.missingSwap.join('; '));
            error.code = 'h3_recast_model_missing';
            throw error;
        }
        const sourceBuffer = fs.readFileSync(plan.sourceVideo.absPath);
        const sourceHasAudio = videoReplacement.hasLikelyAudioTrack(sourceBuffer);
        const graph = graphBuilder.buildSwapGraph({
            prompt: plan.caption,
            W: plan.width,
            H: plan.height,
            frames: plan.frames,
            seed,
            settings,
            models,
            sceneRefName: '__pending__',
            sourceName: '__pending__',
            sourceHasAudio,
            filenamePrefix: 'video/h3-recast'
        });
        const sampler = metrics.startSampler();
        const uploaded = [];
        try {
            if (typeof options.onStart === 'function') {
                try { options.onStart(); } catch { /* best-effort */ }
            }
            const sourceUpload = await uploadFile(plan.sourceVideo.absPath, 'jarvis_recast_src');
            uploaded.push(sourceUpload.name);
            const sceneUpload = await uploadFile(plan.sceneReference.absPath, 'jarvis_recast_scene');
            uploaded.push(sceneUpload.name);
            graph.scene_ref.inputs.image = sceneUpload.name;
            graph.video.inputs.video = sourceUpload.name;

            graphBuilder.validateGraph(info, graph, { lip: false });
            const pid = await comfyui.queuePrompt(graph);
            console.log('[h3-recast] queued swap:', pid,
                '(' + plan.frames + 'f @' + FPS + 'fps, ' + plan.width + 'x' + plan.height +
                ', people=' + (plan.people ? plan.people.length : '?') +
                ', audio=' + sourceHasAudio + ')');

            const timeoutMs = options.timeoutMs || Number(process.env.H3_RECAST_TIMEOUT_MS) || 180 * 60 * 1000;
            const history = await comfyui.waitForPrompt(pid, { timeoutMs, signal });
            const files = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|mov|mkv)$/i);
            if (!files.length) {
                const error = new Error('ComfyUI finished but produced no H3 Recast video.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }
            const entry = files[files.length - 1];
            const buffer = await comfyui.downloadImage(entry);
            await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
            const basename = saveVideoBuffer(buffer, 'recast');
            const duration = plan.frames / FPS;
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: plan.caption,
                model: 'MiniMax H3 Recast',
                width: plan.width,
                height: plan.height,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration,
                    frames: plan.frames,
                    fps: FPS,
                    mode: 'recast',
                    source: plan.sourceVideo.filename,
                    sceneReference: plan.sceneReference.filename,
                    people: plan.people || [],
                    preserveAudio: sourceHasAudio,
                    audioPolicy: sourceHasAudio ? 'fully_copy' : 'none',
                    audioTrimSeconds: sourceHasAudio ? plan.frames / FPS : null,
                    replaceCount: (plan.people || []).filter((person) => person.replaced).length,
                    lora: models.swapLora,
                    attention: settings.attention,
                    steps: settings.steps,
                    denoise: settings.denoise,
                    resolution: { width: plan.width, height: plan.height },
                    videoPipeline: 'minimax-h3-recast'
                }
            });
            return {
                url: meta.file,
                filename: basename,
                width: plan.width,
                height: plan.height,
                duration,
                frames: plan.frames,
                fps: FPS,
                prompt: plan.caption,
                generationMs: meta.generationMs,
                metrics: await sampler.stop(),
                meta
            };
        } finally {
            await sampler.stop().catch(() => {});
            for (const name of uploaded) {
                await comfyui.deleteInputFile(name).catch(() => {});
            }
        }
    }, queueOpts);
}

async function renderLipRepair(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'H3 Recast lip repair',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        const startedAt = Date.now();
        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);
        const info = await comfyui.getObjectInfo();
        const settings = normalizeSettings(plan.settings, info);
        const models = resolveModels(info, plan.settings);
        if (models.missingLip.length) {
            const error = new Error('H3 Recast lip repair is not ready: ' + models.missingLip.join('; '));
            error.code = 'h3_recast_model_missing';
            throw error;
        }
        const sourceBuffer = fs.readFileSync(plan.baseVideoAbsPath);
        const sourceHasAudio = videoReplacement.hasLikelyAudioTrack(sourceBuffer);
        const graph = graphBuilder.buildLipGraph({
            prompt: plan.prompt,
            frames: plan.frames,
            seed,
            settings,
            models,
            baseVideoName: '__pending__',
            faceRefName: '__pending__',
            personIndex: plan.personIndex,
            sourceHasAudio,
            filenamePrefix: 'video/h3-recast-lip'
        });
        const sampler = metrics.startSampler();
        const uploaded = [];
        try {
            if (typeof options.onStart === 'function') {
                try { options.onStart(); } catch { /* best-effort */ }
            }
            const baseUpload = await uploadFile(plan.baseVideoAbsPath, 'jarvis_recast_base');
            uploaded.push(baseUpload.name);
            const faceUpload = await uploadFile(plan.faceReferenceAbsPath, 'jarvis_recast_face');
            uploaded.push(faceUpload.name);
            graph.base_video.inputs.video = baseUpload.name;
            graph.face_ref.inputs.image = faceUpload.name;

            graphBuilder.validateGraph(info, graph, { lip: true });
            const pid = await comfyui.queuePrompt(graph);
            console.log('[h3-recast] queued lip repair:', pid,
                '(' + plan.frames + 'f, person=' + (plan.personIndex + 1) +
                ', denoise=' + settings.lip.denoise + ', steps=' + settings.lip.steps + ')');

            const timeoutMs = options.timeoutMs || Number(process.env.H3_RECAST_LIP_TIMEOUT_MS) || 90 * 60 * 1000;
            const history = await comfyui.waitForPrompt(pid, { timeoutMs, signal });
            const files = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|mov|mkv)$/i);
            if (!files.length) {
                const error = new Error('ComfyUI finished but produced no lip-repaired video.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }
            const entry = files[files.length - 1];
            const buffer = await comfyui.downloadImage(entry);
            await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
            const basename = saveVideoBuffer(buffer, 'lip');
            const duration = plan.frames / FPS;
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: plan.prompt,
                model: 'MiniMax H3 Recast Lip Repair',
                width: plan.width,
                height: plan.height,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration,
                    frames: plan.frames,
                    fps: FPS,
                    mode: 'recast-lip',
                    source: plan.baseVideoFilename,
                    sceneReference: plan.sceneReference ? plan.sceneReference.filename : null,
                    person: plan.personIndex + 1,
                    replaceCount: 1,
                    preserveAudio: sourceHasAudio,
                    audioPolicy: sourceHasAudio ? 'fully_copy' : 'none',
                    lipRepair: {
                        person: plan.personIndex + 1,
                        denoise: settings.lip.denoise,
                        steps: settings.lip.steps,
                        facePick: settings.lip.facePick,
                        cachedSource: true
                    },
                    lipSyncGuaranteed: false,
                    resolution: { width: plan.width, height: plan.height },
                    videoPipeline: 'minimax-h3-recast-lip'
                }
            });
            return {
                url: meta.file,
                filename: basename,
                width: plan.width,
                height: plan.height,
                duration,
                frames: plan.frames,
                fps: FPS,
                prompt: plan.prompt,
                generationMs: meta.generationMs,
                metrics: await sampler.stop(),
                lipRepair: {
                    person: plan.personIndex + 1,
                    sourceUrl: plan.baseVideoUrl || null,
                    sourceFilename: plan.baseVideoFilename,
                    denoise: settings.lip.denoise,
                    steps: settings.lip.steps,
                    facePick: settings.lip.facePick,
                    createdAt: new Date().toISOString()
                },
                meta
            };
        } finally {
            await sampler.stop().catch(() => {});
            for (const name of uploaded) {
                await comfyui.deleteInputFile(name).catch(() => {});
            }
        }
    }, queueOpts);
}

module.exports = {
    id: ID,
    ID,
    label: LABEL,
    LABEL,
    MAX_SECONDS,
    FPS,
    normalizeSettings,
    resolveModels,
    availability,
    dimensionsFor,
    framesFor,
    render: renderSwap,
    renderSwap,
    renderLipRepair
};
