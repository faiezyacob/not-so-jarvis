/* ============================================
   JARVIS — Hardware Compatibility Checker
   Compares model VRAM requirements against
   the user's available GPU/system resources.
   ============================================ */

const HardwareCompat = (function () {
    const VRAM_SAFETY_MARGIN = 0.85;

    function toGB(bytes) {
        return Math.round(bytes / (1024 * 1024 * 1024) * 10) / 10;
    }

    function formatBytes(bytes) {
        if (bytes >= 1024 * 1024 * 1024) {
            return toGB(bytes) + ' GB';
        }
        return Math.round(bytes / (1024 * 1024)) + ' MB';
    }

    function fetchLatestStats() {
        return fetch('/api/stats')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
    }

    function checkModelHardwareCompatibility(model, hardware) {
        if (!model || !hardware) {
            return {
                level: 'unknown',
                label: '? Compatibility unknown',
                vramTotal: 0,
                vramFree: 0,
                usableVram: 0,
                estimatedVram: null,
                difference: null,
                ramTotal: 0,
                ramFree: 0,
                gpuName: null,
                message: 'Model or hardware information not available.'
            };
        }

        const gpuName = (hardware.gpu && hardware.gpu.name) || null;
        const vramAvailable = hardware.vram && hardware.vram.available;
        const vramTotalGB = vramAvailable ? (hardware.vram.total || 0) : 0;
        const vramFreeGB = vramAvailable ? (hardware.vram.free || 0) : 0;
        const ramTotalGB = (hardware.ram && hardware.ram.total) || 0;
        const ramFreeGB = (hardware.ram && hardware.ram.free) || 0;

        const estimatedVramBytes = model.estimatedVramBytes;
        if (estimatedVramBytes == null) {
            return {
                level: 'unknown',
                label: '? VRAM compatibility unknown',
                vramTotal: vramTotalGB,
                vramFree: vramFreeGB,
                usableVram: 0,
                estimatedVram: null,
                difference: null,
                ramTotal: ramTotalGB,
                ramFree: ramFreeGB,
                gpuName: gpuName,
                message: 'Estimated VRAM requirement is not available for this model.'
            };
        }

        const estimatedGB = toGB(estimatedVramBytes);

        if (!vramAvailable) {
            return {
                level: 'unknown',
                label: '? No GPU detected',
                vramTotal: 0,
                vramFree: 0,
                usableVram: 0,
                estimatedVram: estimatedGB,
                difference: null,
                ramTotal: ramTotalGB,
                ramFree: ramFreeGB,
                gpuName: null,
                message: 'No compatible GPU detected. The model may run on CPU using system RAM.'
            };
        }

        const usableVramGB = Math.round(vramFreeGB * VRAM_SAFETY_MARGIN * 10) / 10;
        const differenceGB = Math.round((usableVramGB - estimatedGB) * 10) / 10;

        if (estimatedGB <= usableVramGB) {
            let level = 'good';
            let label = '\u2713 Good fit';
            let message = 'This model should run well on your GPU.';

            if (differenceGB < 2 && differenceGB >= 0) {
                level = 'warning';
                label = '\u26A0 High VRAM usage';
                message = 'This model fits but will use most of your available VRAM. '
                    + 'Other GPU applications may be affected.';
            }

            return {
                level: level,
                label: label,
                vramTotal: vramTotalGB,
                vramFree: vramFreeGB,
                usableVram: usableVramGB,
                estimatedVram: estimatedGB,
                difference: differenceGB,
                ramTotal: ramTotalGB,
                ramFree: ramFreeGB,
                gpuName: gpuName,
                message: message
            };
        }

        console.log(estimatedGB, vramTotalGB);
        if (estimatedGB <= vramTotalGB) {
            return {
                level: 'warning',
                label: '\u26A0 May require RAM offloading',
                vramTotal: vramTotalGB,
                vramFree: vramFreeGB,
                usableVram: usableVramGB,
                estimatedVram: estimatedGB,
                difference: differenceGB,
                ramTotal: ramTotalGB,
                ramFree: ramFreeGB,
                gpuName: gpuName,
                message: 'This model exceeds currently available VRAM but fits within total VRAM. '
                    + 'It may use system RAM through offloading. '
                    + 'Performance may be significantly lower than a model that fits entirely in VRAM.'
            };
        }

        return {
            level: 'critical',
            label: '\u26A0 Exceeds GPU VRAM',
            vramTotal: vramTotalGB,
            vramFree: vramFreeGB,
            usableVram: usableVramGB,
            estimatedVram: estimatedGB,
            difference: differenceGB,
            ramTotal: ramTotalGB,
            ramFree: ramFreeGB,
            gpuName: gpuName,
            message: 'This model is estimated to require more VRAM than your GPU has total. '
                + 'It may offload to system RAM, which can significantly impact performance. '
                + 'The model may still work depending on the provider, runtime, '
                + 'quantization, context size and offloading support.'
        };
    }

    function getCompatibilityClass(level) {
        switch (level) {
            case 'good': return 'compat-good';
            case 'warning': return 'compat-warning';
            case 'critical': return 'compat-critical';
            default: return 'compat-unknown';
        }
    }

    return {
        VRAM_SAFETY_MARGIN,
        toGB,
        formatBytes,
        fetchLatestStats,
        checkModelHardwareCompatibility,
        getCompatibilityClass
    };
})();
