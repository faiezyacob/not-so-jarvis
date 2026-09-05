/* 
    ============================================
    JARVIS — Model Catalog (Server Authoritative)
    Models listed here are what JARVIS knows about.
    Hardware estimates are in MODEL_HARDWARE_ESTIMATES.
    category - lightweight, medium, heavy, very-heavy
    ============================================ 
*/

const MODEL_CATALOG = [
    {
        id: 'qwen3.8:27b',
        provider: 'ollama',
        displayName: 'Qwen 3.8 27B',
        parameterSize: '27B',
        category: 'heavy',
        recommended: false,
        capabilities: ['vision', 'tools', 'thinking'],
        description: 'Qwen3.8 delivers substantial gains across coding, professional work, research, and long-horizon agentic tasks',
        hardwareNotes: 'Best with 16GB+ VRAM; may require RAM offloading on lower-VRAM GPUs'
    },
    {
        id: 'gemma4:12b',
        provider: 'ollama',
        displayName: 'gemma4 12B',
        parameterSize: '12B',
        category: 'medium',
        recommended: false,
        capabilities: ['vision', 'tools', 'thinking', 'audio'],
        description: 'Gemma 4 models are designed to deliver frontier-level performance at each size. They are well-suited for reasoning, agentic workflows, coding, and multimodal understanding.',
        hardwareNotes: 'Best with 16GB+ VRAM; full offloading to GPU'
    },
    {
        id: 'llama3.2:3b',
        provider: 'ollama',
        displayName: 'gemma4 12B',
        parameterSize: '12B',
        category: 'lightweight',
        recommended: false,
        capabilities: ['tools'],
        description: 'Metas Llama 3.2 goes small with 1B and 3B models.',
        hardwareNotes: 'Can run on < 8GB VRAM; full offloading to GPU'
    }
];

/* 
    ============================================ 
    Hardware estimates — keyed by catalog model ID.
    These are approximate; the frontend shows them as ranges/guidelines.    
    ============================================ 
*/
const MODEL_HARDWARE_ESTIMATES = {
    'qwen3.8:27b':              { vramBytes:   18000000000,  ramBytes: null,  downloadSizeBytes:  18000000000 },
    'gemma4:12b':              { vramBytes:   8160892928,  ramBytes: null,  downloadSizeBytes:  8160892928 },
    'llama3.2:3b':              { vramBytes:   2147483648,  ramBytes: null,  downloadSizeBytes:  2147483648 },
};

/* ---------- Accessors ---------- */

function getModelById(id) {
    const model = MODEL_CATALOG.find(m => m.id === id) || null;
    if (!model) return null;
    const hw = MODEL_HARDWARE_ESTIMATES[id] || {};
    return {
        ...model,
        estimatedVramBytes: hw.vramBytes || null,
        estimatedRamBytes: hw.ramBytes || null,
        downloadSizeBytes: hw.downloadSizeBytes || null
    };
}

function getAllModels() {
    return MODEL_CATALOG.map(m => {
        const hw = MODEL_HARDWARE_ESTIMATES[m.id] || {};
        return {
            ...m,
            estimatedVramBytes: hw.vramBytes || null,
            estimatedRamBytes: hw.ramBytes || null,
            downloadSizeBytes: hw.downloadSizeBytes || null
        };
    });
}

function getCatalogIds() {
    return MODEL_CATALOG.map(m => m.id);
}

module.exports = { MODEL_CATALOG, MODEL_HARDWARE_ESTIMATES, getModelById, getAllModels, getCatalogIds };
