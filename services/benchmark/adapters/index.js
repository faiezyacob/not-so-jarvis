/* ============================================
   JARVIS — Image Arena adapter registry
   One adapter per enabled text-to-image provider.
   The benchmark manager only talks to this
   interface; it never learns a provider's graph,
   node names or HTTP shape.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const imageProviders = require('../../image-providers');
const { createComfyAdapter } = require('./comfyui');

// A future non-ComfyUI provider registers its own adapter here. Everything
// currently installed runs through the shared ComfyUI pipeline, so the default
// factory is the ComfyUI adapter.
const CUSTOM_FACTORIES = {};

let cache = null;

function buildAdapters() {
    const adapters = [];
    imageProviders.listImageProviders().forEach((provider) => {
        if (!provider.capabilities || !provider.capabilities.textToImage) return;
        const factory = CUSTOM_FACTORIES[provider.id];
        adapters.push(factory ? factory(provider) : createComfyAdapter(provider));
    });
    return adapters;
}

function listAdapters() {
    if (!cache) cache = buildAdapters();
    return cache.slice();
}

function getAdapter(id) {
    const wanted = String(id || '').trim();
    return listAdapters().find((adapter) => adapter.id === wanted) || null;
}

function registerAdapter(id, factory) {
    if (!id || typeof factory !== 'function') return false;
    CUSTOM_FACTORIES[String(id)] = factory;
    cache = null;
    return true;
}

module.exports = {
    listAdapters,
    getAdapter,
    registerAdapter
};
