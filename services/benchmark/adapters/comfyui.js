/* ============================================
   JARVIS — Image Arena ComfyUI adapter
   Translates one benchmark job into the existing
   image-generator pipeline. It never builds its own
   workflow: the graph probe, the model settings and
   the real generation all come from image-generator.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const imageGenerator = require('../../image-generator');
const comfyui = require('../../comfyui');

const CLIP_TYPES = {
    qwen_image_2_1: imageGenerator.QWEN_IMAGE_CLIP_TYPE,
    minimax_h3_image: imageGenerator.MINIMAX_IMAGE_CLIP_TYPE,
    moss: imageGenerator.MOSS_IMAGE_CLIP_TYPE,
    krea2: imageGenerator.KREA2_CLIP_TYPE
};

const LOADER_FIELDS = {
    UNETLoader: { field: 'unet_name', folder: 'models/diffusion_models' },
    CLIPLoader: { field: 'clip_name', folder: 'models/text_encoders' },
    VAELoader: { field: 'vae_name', folder: 'models/vae' },
    LoraLoader: { field: 'lora_name', folder: 'models/loras' },
    LoraLoaderModelOnly: { field: 'lora_name', folder: 'models/loras' }
};

function settingsFor(providerId) {
    const settings = imageGenerator.effectiveSettings();
    settings.model = providerId;
    return settings;
}

function graphFor(providerId, settings, info, overrides) {
    const opts = overrides || {};
    const model = imageGenerator.normalizeImageModel(providerId) || providerId;
    const merged = Object.assign({}, settings, { model });
    // Mirror the real generation path: resolve `auto` attention and the Qwen
    // scheduler against this ComfyUI build so discovery validates the graph
    // that will actually be queued.
    merged.attentionBackend = imageGenerator.resolveImageAttentionBackend(info, merged.attentionBackend);
    if (model === 'qwen_image_2_1') {
        merged.qwenScheduler = imageGenerator.resolveQwenScheduler(info, merged.qwenScheduler);
    }
    const dims = imageGenerator.resolveDimensions(merged);
    const width = Number.isInteger(opts.width) && opts.width > 0 ? opts.width : dims.width;
    const height = Number.isInteger(opts.height) && opts.height > 0 ? opts.height : dims.height;
    const seed = Number.isInteger(opts.seed) && opts.seed >= 0 ? opts.seed : 0;
    let conditioningNode = null;
    if (model === 'minimax_h3_image') {
        conditioningNode = imageGenerator.resolveMiniMaxConditioningNode(info, merged.minimaxConditioningNode);
    }
    const base = imageGenerator.resolveBaseModels(merged);
    const modelSettings = Object.assign({}, merged, base);
    const graph = imageGenerator.buildT2IGraphForModel(model, opts.prompt || 'a photographic test image', {
        seed,
        width,
        height,
        settings: modelSettings,
        conditioningNode,
        // Discovery probes never require the optional MOSS enhancer node.
        enhancerNode: null,
        promptEnhancer: false
    });
    return { graph, conditioningNode, width, height };
}

function samplerConfig(graph) {
    const sampler = (graph && graph.sampler && graph.sampler.inputs) || {};
    const canvas = (graph && graph.canvas && graph.canvas.inputs) ||
        (graph && graph.conditioning && graph.conditioning.inputs) || {};
    return {
        width: Number(canvas.width) || null,
        height: Number(canvas.height) || null,
        seed: Number.isFinite(Number(sampler.seed)) ? Number(sampler.seed) : null,
        steps: Number.isFinite(Number(sampler.steps)) ? Number(sampler.steps) : null,
        cfg: Number.isFinite(Number(sampler.cfg)) ? Number(sampler.cfg) : null,
        sampler: sampler.sampler_name ? String(sampler.sampler_name) : null,
        scheduler: sampler.scheduler ? String(sampler.scheduler) : null
    };
}

// The exact loader filenames the probe graph will use, recorded on every job so
// history shows which configuration actually ran.
function loaderConfig(graph) {
    const out = { unet: null, clip: null, clipType: null, vae: null, loras: [] };
    Object.values(graph || {}).forEach((node) => {
        if (!node || !node.inputs) return;
        if (node.class_type === 'UNETLoader') out.unet = node.inputs.unet_name || null;
        if (node.class_type === 'CLIPLoader') {
            out.clip = node.inputs.clip_name || null;
            out.clipType = node.inputs.type || null;
        }
        if (node.class_type === 'VAELoader') out.vae = node.inputs.vae_name || null;
        if (node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly') {
            if (node.inputs.lora_name) out.loras.push(node.inputs.lora_name);
        }
    });
    return out;
}

// Compare every loader node in the graph against ComfyUI's own loader choices.
// This is authoritative: a file that exists but is not reported by ComfyUI
// cannot be loaded either. The check uses the graph's actual filenames, so no
// engine-specific model list is duplicated here.
function missingModelFiles(info, graph) {
    const missing = [];
    Object.values(graph || {}).forEach((node) => {
        const rule = node && LOADER_FIELDS[node.class_type];
        if (!rule) return;
        const value = node.inputs && node.inputs[rule.field];
        if (!value) return;
        const choices = imageGenerator.objectInfoChoices(info, node.class_type, rule.field);
        if (!Array.isArray(choices) || !choices.includes(value)) {
            missing.push({ value: String(value), folder: rule.folder, field: rule.field });
        }
    });
    return missing;
}

function describeUnavailable(error) {
    if (!error) return 'Unavailable';
    return error.message || 'Unavailable';
}

function standardizationNotes(providerId) {
    const notes = ['Sampler and scheduler are fixed by the engine.'];
    if (providerId === 'minimax_h3_image') {
        notes.push('MiniMax H3 Image renders on a 4–16 MP canvas; smaller requested tiers are raised to its 4 MP minimum.');
    }
    if (providerId === 'moss') {
        notes.push('MOSS-Image snaps the canvas to a multiple of 16 pixels.');
    }
    return notes;
}

function createComfyAdapter(provider) {
    const providerId = provider.id;
    const adapter = {
        id: providerId,
        label: provider.label,
        engine: 'ComfyUI',
        locality: 'local',
        capabilities: Object.assign({}, provider.capabilities),
        family: provider.capabilities.promptEnhancement ? 'Prompt-enhancer capable' : 'Text-to-image',
        standardizationNotes: () => standardizationNotes(providerId),

        // Inspect one engine without generating anything. Returns its native
        // configuration (extracted from the real graph) and an availability
        // verdict with an actionable reason when something is missing.
        async inspect(options) {
            const opts = options || {};
            const info = opts.info;
            const settings = opts.settings || settingsFor(providerId);
            const result = {
                id: providerId,
                label: provider.label,
                engine: 'ComfyUI',
                locality: 'local',
                type: 'Text-to-image',
                capabilities: Object.assign({}, provider.capabilities),
                available: true,
                reason: null,
                native: null,
                standardizationNotes: standardizationNotes(providerId)
            };

            try {
                const probe = graphFor(providerId, settings, info, {});
                result.native = samplerConfig(probe.graph);
                result.baseModels = loaderConfig(probe.graph);
                await imageGenerator.validateGraphAgainstComfy(info, probe.graph, CLIP_TYPES[providerId]);
                if (providerId === 'minimax_h3_image') {
                    imageGenerator.assertMiniMaxConditioningSupported(
                        info, probe.conditioningNode, settings.minimaxConditioningNode
                    );
                }
                const missing = missingModelFiles(info, probe.graph);
                if (missing.length) {
                    const detail = missing
                        .map((m) => '"' + m.value + '" (' + m.folder + ')')
                        .join(', ');
                    const error = new Error('Missing model file' + (missing.length > 1 ? 's' : '') + ': ' + detail +
                        '. Download them from Settings > Setup, then recheck.');
                    error.code = 'comfyui_missing_model';
                    error.missingModels = missing.map((m) => m.value);
                    throw error;
                }
            } catch (error) {
                result.available = false;
                result.reason = describeUnavailable(error);
                result.errorCode = error.code || 'engine_unavailable';
            }

            return result;
        },

        // Translate a benchmark job into the existing generateImage call.
        run(job, hooks) {
            const h = hooks || {};
            const config = job.config || {};
            const options = {
                imageModel: providerId,
                seed: config.seed,
                width: config.width,
                height: config.height,
                promptEnhancer: config.promptEnhancer === true,
                baseModels: config.baseModels || null,
                // Own the generated file with the benchmark device so the
                // gallery's legacy adoption can never reassign it.
                sessionId: job.ownerSessionId || null,
                hidden: true,
                conversationId: null,
                label: 'Image Arena — ' + provider.label,
                kind: 'image_generation',
                onQueued: h.onQueued,
                onStart: h.onStart,
                onQueueId: h.onQueueId
            };
            if (Number.isFinite(Number(config.steps)) && config.steps > 0) options.steps = Number(config.steps);
            if (Number.isFinite(Number(config.cfg)) && config.cfg >= 0) options.cfg = Number(config.cfg);
            if (config.sampler) options.sampler = String(config.sampler);
            if (config.scheduler) options.scheduler = String(config.scheduler);
            return imageGenerator.generateImage(job.prompt, options);
        },

        async cancel(job) {
            const queueId = Number(job && job.queueId);
            if (!Number.isFinite(queueId) || queueId <= 0) return false;
            if (imageGenerator.cancelQueued(queueId)) return true;
            if (imageGenerator.isActive(queueId)) {
                imageGenerator.cancelActive(queueId);
                try { await comfyui.interrupt(); } catch (err) { /* the waiter is already aborted */ }
                return true;
            }
            return false;
        }
    };
    return adapter;
}

module.exports = {
    createComfyAdapter,
    graphFor,
    samplerConfig,
    loaderConfig,
    missingModelFiles
};
