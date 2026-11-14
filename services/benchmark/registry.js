/* ============================================
   JARVIS — Image Arena model discovery
   Builds the benchmarkable model list from the live
   provider registry and the actual ComfyUI install.
   No model list is maintained here: providers come
   from services/image-providers.js and every graph,
   default and availability check comes from the
   existing image-generator pipeline.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const imageProviders = require('../image-providers');
const adapterRegistry = require('./adapters');

const DEFAULT_TTL_MS = Number(process.env.BENCHMARK_DISCOVERY_TTL_MS) || 15000;

let deps = {
    comfyui: require('../comfyui'),
    imageGenerator: require('../image-generator'),
    adapters: adapterRegistry
};

let cache = null;
let cacheAt = 0;
let cacheSignature = '';

function configure(overrides) {
    deps = Object.assign({}, deps, overrides || {});
    reset();
}

function reset() {
    cache = null;
    cacheAt = 0;
    cacheSignature = '';
}

function settingsSignature(settings) {
    try {
        return JSON.stringify(settings || {});
    } catch (err) {
        return '';
    }
}

function sizeTiers(modelId, settings) {
    const ig = deps.imageGenerator;
    const ladder = ig.normalizeImageModel(modelId) === 'minimax_h3_image'
        ? ig.MINIMAX_IMAGE_MEGAPIXELS
        : ig.IMAGE_MEGAPIXELS;
    return Object.keys(ladder).map((size) => {
        const dims = ig.resolveDimensions(Object.assign({}, settings, {
            model: modelId,
            imageSize: size
        }));
        const label = size + ' · ' + ladder[size] + ' MP · ' + dims.width + '×' + dims.height;
        return { id: size, label, megapixels: ladder[size], width: dims.width, height: dims.height };
    });
}

function publicModel(adapter, inspected, settings) {
    const native = inspected.native || null;
    return {
        id: adapter.id,
        label: inspected.label || adapter.label,
        engine: inspected.engine || adapter.engine,
        locality: inspected.locality || adapter.locality || 'local',
        type: inspected.type || 'Text-to-image',
        available: inspected.available === true,
        reason: inspected.reason || null,
        errorCode: inspected.errorCode || null,
        capabilities: inspected.capabilities || adapter.capabilities || {},
        native: native ? {
            width: native.width,
            height: native.height,
            steps: native.steps,
            cfg: native.cfg,
            sampler: native.sampler,
            scheduler: native.scheduler
        } : null,
        resolution: native && native.width && native.height
            ? {
                width: native.width,
                height: native.height,
                label: native.width + '×' + native.height
            }
            : null,
        baseModels: inspected.baseModels || null,
        supportedResolutions: inspected.available === true ? sizeTiers(adapter.id, settings) : [],
        resolutionLimits: inspected.available === true ? deps.imageGenerator.imageModelResolutionLimits(adapter.id) : null,
        promptEnhancement: Boolean(adapter.capabilities && adapter.capabilities.promptEnhancement),
        notes: inspected.standardizationNotes || []
    };
}

function unavailableModel(provider, reason) {
    return {
        id: provider.id,
        label: provider.label,
        engine: 'ComfyUI',
        locality: 'local',
        type: 'Text-to-image',
        available: false,
        reason,
        errorCode: 'comfyui_unavailable',
        capabilities: Object.assign({}, provider.capabilities),
        native: null,
        resolution: null,
        supportedResolutions: [],
        resolutionLimits: null,
        promptEnhancement: Boolean(provider.capabilities && provider.capabilities.promptEnhancement),
        notes: []
    };
}

function offlineModels(reason) {
    return imageProviders.listImageProviders()
        .filter((provider) => provider.capabilities && provider.capabilities.textToImage)
        .map((provider) => unavailableModel(provider, reason));
}

async function listModels(options) {
    const opts = options || {};
    const settings = deps.imageGenerator.effectiveSettings();
    const signature = settingsSignature(settings);
    if (!opts.refresh && cache && cacheSignature === signature && (Date.now() - cacheAt) < DEFAULT_TTL_MS) {
        return cache.slice();
    }

    const providers = deps.adapters.listAdapters();
    const comfyAvailable = await deps.comfyui.isAvailable();
    if (!comfyAvailable) {
        const reason = 'ComfyUI is not reachable. Start ComfyUI, then recheck the models.';
        cache = offlineModels(reason);
        cacheAt = Date.now();
        cacheSignature = signature;
        return cache.slice();
    }

    let info = null;
    try {
        info = await deps.comfyui.getObjectInfo(30000);
    } catch (err) {
        const reason = 'ComfyUI did not return its node/model list: ' + (err.message || 'unknown error');
        cache = offlineModels(reason);
        cacheAt = Date.now();
        cacheSignature = signature;
        return cache.slice();
    }

    const models = [];
    for (const adapter of providers) {
        let inspected;
        try {
            inspected = await adapter.inspect({ settings, info });
        } catch (err) {
            inspected = {
                available: false,
                reason: err.message || 'Discovery failed',
                errorCode: err.code || 'engine_unavailable'
            };
        }
        models.push(publicModel(adapter, inspected, settings));
    }

    cache = models;
    cacheAt = Date.now();
    cacheSignature = signature;
    return cache.slice();
}

async function getModel(id) {
    const models = await listModels();
    return models.find((model) => model.id === String(id)) || null;
}

module.exports = {
    configure,
    reset,
    listModels,
    getModel
};
