/* ============================================
   JARVIS — Character Swap generation metrics
   Samples ComfyUI /system_stats while a render
   runs so peak VRAM/RAM can be reported.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const comfyui = require('../comfyui');

const INTERVAL_MS = 2000;

function startSampler(options = {}) {
    const intervalMs = Math.max(500, Number(options.intervalMs) || INTERVAL_MS);
    const startedAt = Date.now();
    const state = {
        peakVramBytes: 0,
        peakRamBytes: 0,
        firstVramBytes: null,
        lastVramBytes: null,
        samples: 0
    };
    let timer = null;
    let stopped = false;

    async function sample() {
        try {
            const stats = await comfyui.getSystemStats();
            const total = Number(stats && stats.devices && stats.devices[0] && stats.devices[0].vram_total) || 0;
            const free = Number(stats && stats.devices && stats.devices[0] && stats.devices[0].vram_free) || 0;
            const used = Math.max(0, total - free);
            const ramTotal = Number(stats && stats.system && stats.system.ram_total) || 0;
            const ramFree = Number(stats && stats.system && stats.system.ram_free) || 0;
            const ramUsed = Math.max(0, ramTotal - ramFree);
            if (used > state.peakVramBytes) state.peakVramBytes = used;
            if (ramUsed > state.peakRamBytes) state.peakRamBytes = ramUsed;
            if (state.firstVramBytes === null) state.firstVramBytes = used;
            state.lastVramBytes = used;
            state.samples += 1;
        } catch {
            // Metrics are best-effort; never fail a render over them.
        }
    }

    sample();
    timer = setInterval(sample, intervalMs);
    if (timer.unref) timer.unref();

    return {
        async stop() {
            if (stopped) return snapshot();
            stopped = true;
            if (timer) clearInterval(timer);
            await sample();
            return snapshot();
        },
        async snapshot() {
            return snapshot();
        }
    };

    function snapshot() {
        return {
            peakVramMB: Math.round(state.peakVramBytes / (1024 * 1024)),
            peakRamMB: Math.round(state.peakRamBytes / (1024 * 1024)),
            firstVramMB: state.firstVramBytes === null ? null : Math.round(state.firstVramBytes / (1024 * 1024)),
            lastVramMB: state.lastVramBytes === null ? null : Math.round(state.lastVramBytes / (1024 * 1024)),
            samples: state.samples,
            durationMs: Date.now() - startedAt
        };
    }
}

module.exports = { startSampler };
