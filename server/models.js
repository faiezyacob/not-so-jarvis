/* 
    ============================================
    JARVIS — Model Catalog (Server Authoritative)
    Models listed here are what JARVIS knows about.
    Hardware estimates are in MODEL_HARDWARE_ESTIMATES.
    category - lightweight, medium, heavy, very-heavy
    sorted by their parameter size (smallest to largest) in the catalog.
    ============================================ 
*/



const MODEL_CATALOG = [
    {
        id: 'llama3.2:3b',
        provider: 'ollama',
        displayName: 'llama3.2 3b',
        parameterSize: '3B',
        category: 'lightweight',
        recommended: false,
        capabilities: ['tools'],
        description: 'Metas Llama 3.2 goes small with 1B and 3B models.',
        hardwareNotes: 'Can run on < 8GB VRAM; full offloading to GPU'
    },
    {
        id: 'qwen3.5:9b',
        provider: 'ollama',
        displayName: 'Qwen 3.5 9B',
        parameterSize: '9B',
        category: 'medium',
        recommended: false,
        capabilities: ['vision', 'tools', 'thinking'],
        description: 'Metas Llama 3.2 goes small with 1B and 3B models.',
        hardwareNotes: 'Can run on < 8GB VRAM; full offloading to GPU'
    },
    {
        id: 'gemma4:12b',
        provider: 'ollama',
        displayName: 'gemma4 12B',
        parameterSize: '12B',
        category: 'medium',
        recommended: false,
        capabilities: ['vision', 'tools', 'thinking', 'audio'],
        description: 'Qwen 3.5 is a family of open-source multimodal models that delivers exceptional utility and performance.',
        hardwareNotes: 'Best with 16GB+ VRAM; full offloading to GPU'
    },
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
        id: 'orcarouter/Qwen3.8-27B-Uncensored:q4_K_M',
        provider: 'ollama',
        displayName: 'Qwen 3.8 27B Uncensored',
        parameterSize: '27B',
        category: 'heavy',
        recommended: false,
        capabilities: ['vision', 'tools', 'thinking'],
        description: 'Qwen3.8-27B tensor-level abliterated, vision tower and MTP head untouched. 0% over-refusal on XSTest, 0-6% refusal across the A/B suite, no measurable capability loss. Full mmproj vision, tool calling and thinking, 262K context.',
        hardwareNotes: 'Best with 16GB+ VRAM; may require RAM offloading on lower-VRAM GPUs'
    }
];

/* 
    ============================================ 
    Hardware estimates — keyed by catalog model ID.
    These are approximate; the frontend shows them as ranges/guidelines.    
    ============================================ 
*/
const MODEL_HARDWARE_ESTIMATES = {
    'llama3.2:3b':                              { vramBytes:   2147483648,  ramBytes: null,  downloadSizeBytes:  2147483648 },
    'qwen3.5:9b':                               { vramBytes:   7086696038,  ramBytes: null,  downloadSizeBytes:  7086696038 },
    'gemma4:12b':                               { vramBytes:   8160892928,  ramBytes: null,  downloadSizeBytes:  8160892928 },
    'qwen3.8:27b':                              { vramBytes:   19327352832,  ramBytes: null,  downloadSizeBytes:  19327352832 },
    'orcarouter/Qwen3.8-27B-Uncensored:q4_K_M': { vramBytes:   19327352832,  ramBytes: null,  downloadSizeBytes:  19327352832 }
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

function modelSupportsThinking(id) {
    const model = MODEL_CATALOG.find(m => m.id === id) || null;
    return Boolean(model && Array.isArray(model.capabilities) && model.capabilities.includes('thinking'));
}

module.exports = { MODEL_CATALOG, MODEL_HARDWARE_ESTIMATES, getModelById, getAllModels, getCatalogIds, modelSupportsThinking };
