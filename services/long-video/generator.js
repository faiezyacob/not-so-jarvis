/* ============================================
   JARVIS — Long Video Generator
   Submits an approved storyboard to the
   installed H3 LongVideos ComfyUI node and
   returns the finished video through the normal
   generated-media pipeline (data/generated +
   generated-history + gallery thumbnails).

   The node performs the temporal chaining
   internally. This module never extracts a
   frame and never concatenates clips.
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('../comfyui');
const generatedHistory = require('../generated-history');
const generationQueue = require('../generation-queue');
const videoGenerator = require('../video-generator');
const workflow = require('./h3-longvideos-workflow');

const GENERATED_DIR = path.join(__dirname, '..', '..', 'data', 'generated');

const LONG_VIDEO_TIMEOUT_MS = Number(process.env.H3_LONGVIDEO_TIMEOUT_MS) || 90 * 60 * 1000;
const LONG_VIDEO_STEPS = Number(process.env.H3_LONGVIDEO_STEPS) || videoGenerator.H3_DEFAULT_STEPS;

function ensureGeneratedDir() {
    if (!fs.existsSync(GENERATED_DIR)) {
        fs.mkdirSync(GENERATED_DIR, { recursive: true });
    }
}

function safeFilename(name) {
    return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// Minimal PNG/JPEG header reader — only used to pick the closest aspect preset
// from a referenced first frame. Returns { width, height } or null.
function readImageDimensions(filePath) {
    let buffer;
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            buffer = Buffer.alloc(65536);
            const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
            buffer = buffer.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    } catch (err) {
        return null;
    }
    return readPngSize(buffer) || readJpegSize(buffer);
}

function readPngSize(buffer) {
    const signature = [0x89, 0x50, 0x4e, 0x47];
    if (buffer.length < 24) return null;
    if (!signature.every((byte, i) => buffer[i] === byte)) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegSize(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let pos = 2;
    while (pos + 9 < buffer.length) {
        if (buffer[pos] !== 0xff) return null;
        const marker = buffer[pos + 1];
        const startOfFrame = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (startOfFrame) {
            const height = buffer.readUInt16BE(pos + 5);
            const width = buffer.readUInt16BE(pos + 7);
            return width > 0 && height > 0 ? { width, height } : null;
        }
        const segmentLength = buffer.readUInt16BE(pos + 2);
        if (segmentLength < 2) return null;
        pos += 2 + segmentLength;
    }
    return null;
}

// The maximum planned beat length, which becomes the node's shot_seconds cap.
function maxBeatSeconds(plan) {
    const durations = (plan && Array.isArray(plan.beats) ? plan.beats : [])
        .map((b) => Number(b && b.duration))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (!durations.length) return Math.min(15, Math.max(1, Number(plan && plan.duration) || 15));
    return Math.max(1, Math.min(15, Math.max.apply(null, durations)));
}

// Submit an approved long-video plan. Runs inside the shared single-generation
// lock, so it queues behind / ahead of image and short-video jobs like any
// other ComfyUI generation.
async function generateLongVideo(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'long video generation',
        kind: options.kind || 'long_video_generation',
        conversationId: options.conversationId || (plan && plan.conversationId) || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    const report = (stage) => {
        if (typeof options.onProgress === 'function') {
            try { options.onProgress(stage); } catch (err) { /* progress is best-effort */ }
        }
    };

    return generationQueue.enqueue(async (signal) => {
        await ensureGeneratedDir();
        const startedAt = Date.now();
        const settings = videoGenerator.effectiveVideoSettings();
        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);

        const sourceRaw = (plan && plan.sourceImage) || options.sourceImageRawFilename || null;
        const sourcePath = sourceRaw ? path.join(GENERATED_DIR, path.basename(sourceRaw)) : null;
        const sourceDims = sourcePath && fs.existsSync(sourcePath) ? readImageDimensions(sourcePath) : null;
        // A referenced first frame drives the aspect ratio; T2VA uses the node's
        // own 16:9 default (the image-generation aspect setting does not apply
        // to video, matching the normal H3 pipeline).
        const resolution = sourceDims
            ? workflow.pickResolution({ sourceWidth: sourceDims.width, sourceHeight: sourceDims.height })
            : workflow.pickResolution({});
        const megapixels = workflow.megapixelsForSize(settings.h3Size);
        const shotSeconds = maxBeatSeconds(plan);
        const prompt = String((plan && plan.prompt) || options.prompt || '').trim();
        if (!prompt) {
            const error = new Error('The long video storyboard has no prompt to render.');
            error.code = 'longvideo_prompt_missing';
            throw error;
        }

        report('preparing');

        let firstImageName = null;
        if (sourcePath && fs.existsSync(sourcePath)) {
            const buffer = fs.readFileSync(sourcePath);
            const uploadName = 'jarvis_longvideo_' + Date.now() + '_' + path.basename(sourceRaw);
            const uploaded = await comfyui.uploadImage(buffer, uploadName);
            firstImageName = (uploaded && uploaded.name) || uploadName;
        }

        try {
            const info = await comfyui.getObjectInfo();
            // Resolve `auto` against ComfyUI before building, matching the
            // normal H3 pipeline's attention selection.
            settings.attentionBackend = videoGenerator.resolveH3AttentionBackend(
                info, settings.attentionBackend
            );
            // First Block Cache composes with the attention backend. It is never
            // silently skipped: a missing node fails the render with install
            // instructions. Each job gets a fresh graph, and the node resets its
            // cache per sampling pass, so no state leaks across segments or runs.
            const acceleration = videoGenerator.videoAccelerationInfo(settings, settings.attentionBackend);
            if (acceleration.firstBlockCache) {
                videoGenerator.assertFirstBlockCacheReady(info, settings);
                console.log('[long-video] H3 First Block Cache enabled (' +
                    acceleration.firstBlockCache + ')');
            }
            console.log('[long-video] acceleration:',
                videoGenerator.formatAccelerationDiagnostics(acceleration).replace(/\n/g, ' | '));
            const graph = workflow.buildLongVideoGraph({
                prompt,
                seed,
                settings,
                resolution,
                megapixels,
                shotSeconds,
                steps: options.steps || LONG_VIDEO_STEPS,
                firstImageName,
                // Match the installed node's exact input names so required-input
                // validation passes even if the node pack renames a field.
                firstBlockCacheInputs: videoGenerator.resolveFirstBlockCacheInputNames(info)
            });

            await workflow.validateLongVideoGraph(info, graph);

            const pid = await comfyui.queuePrompt(graph);
            console.log('[long-video] queued H3 LongVideos workflow:', pid,
                '(' + resolution + ', ' + megapixels + 'MP, cap ' + shotSeconds + 's, ' +
                ((plan && plan.beats && plan.beats.length) || 0) + ' beats)');

            report('generating');
            const history = await comfyui.waitForPrompt(pid, { timeoutMs: LONG_VIDEO_TIMEOUT_MS, signal });

            const videoFiles = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|avi|mov)$/i);
            if (!videoFiles.length) {
                const error = new Error('ComfyUI finished but the LongVideos workflow produced no video file.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }

            report('finalizing');
            const entry = videoFiles[videoFiles.length - 1];
            const buffer = await comfyui.downloadImage(entry);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.mp4';
            const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_longvid_' + stamp + extension;
            const filePath = path.join(GENERATED_DIR, basename);
            fs.writeFileSync(filePath, buffer);

            const dims = videoGenerator.probeVideoBuffer(buffer, extension) || {};
            console.log('[long-video] saved video:', basename, '(' + buffer.length + ' bytes)');

            await comfyui.deleteOutputFile(entry, { history: pid });

            const activeLoras = (settings.loras || [])
                .filter((l) => l && l.on !== false && l.name)
                .map((l) => ({ name: l.name, strength: Number(l.strength) || 0, triggerWord: l.triggerWord || '' }));
            const beatCount = (plan && plan.beats && plan.beats.length) || 0;
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || (plan && plan.conversationId) || null,
                prompt,
                model: 'MiniMax H3 LongVideos',
                width: dims.width || null,
                height: dims.height || null,
                loras: activeLoras,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration: (plan && plan.duration) || null,
                    frames: null,
                    fps: videoGenerator.H3_FPS,
                    mode: 'long',
                    long: true,
                    shots: beatCount,
                    source: sourceRaw || null,
                    acceleration
                }
            });

            return {
                url: meta.file,
                filename: basename,
                width: dims.width || null,
                height: dims.height || null,
                duration: (plan && plan.duration) || null,
                shots: beatCount,
                fps: videoGenerator.H3_FPS,
                mode: 'long',
                prompt,
                generationMs: meta.generationMs,
                acceleration,
                promptId: pid,
                meta
            };
        } finally {
            if (firstImageName) {
                await comfyui.deleteInputFile(firstImageName).catch(() => {});
            }
        }
    }, queueOpts);
}

module.exports = {
    generateLongVideo,
    LONG_VIDEO_TIMEOUT_MS,
    LONG_VIDEO_STEPS
};
