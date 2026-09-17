/* ============================================
   JARVIS — H3 LongVideos Workflow
   Loads the dedicated ComfyUI workflow
   configuration (workflows/h3-longvideos.json)
   and fills its placeholders with the JARVIS
   H3 model stack, LoRA chain and prompt.

   This module is the ONLY bridge between the
   Long Video Director and ComfyUI. The director
   plans a story; this file knows HOW to run it.
   It never extracts frames and never concatenates
   clips — the installed LongVideos node does the
   temporal chaining internally.
   ============================================ */

const WORKFLOW = require('./workflows/h3-longvideos.json');
const videoGenerator = require('../video-generator');

const REQUIRED_NODE = WORKFLOW.requiredNode || 'H3LongVideos';
const OUTPUT_NODE = WORKFLOW.outputNode || 'save';

// The resolution presets the installed node accepts, with their ratios.
const RESOLUTION_RATIOS = Object.freeze({
    '16:9': 16 / 9,
    '9:16': 9 / 16,
    '4:3': 4 / 3,
    '3:4': 3 / 4,
    '1:1': 1,
    '21:9': 21 / 9,
    '9:21': 9 / 21
});

// Pick the node's aspect preset. An explicit JARVIS aspect ratio wins; a source
// image's real dimensions come next; the H3 16:9 default is the fallback.
function pickResolution({ aspectRatio, sourceWidth, sourceHeight } = {}) {
    const requested = String(aspectRatio || '').trim();
    if (Object.prototype.hasOwnProperty.call(RESOLUTION_RATIOS, requested)) return requested;

    const w = Number(sourceWidth);
    const h = Number(sourceHeight);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        const ratio = w / h;
        let best = '16:9';
        let bestDelta = Infinity;
        for (const [name, value] of Object.entries(RESOLUTION_RATIOS)) {
            const delta = Math.abs(Math.log(value) - Math.log(ratio));
            if (delta < bestDelta) {
                bestDelta = delta;
                best = name;
            }
        }
        return best;
    }
    return '16:9';
}

// megapixels mirrors the H3 size tiers used by the normal video pipeline:
// S (0.5), M (0.75), L (1.0, the node's own native budget).
function megapixelsForSize(size) {
    const scale = videoGenerator.h3SizeScale(size);
    if (!Number.isFinite(scale) || scale <= 0) return 1.0;
    return Math.max(0.1, Math.min(2.0, scale));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Resolve every `$placeholder` in the workflow template. `$optional:<key>` is
// removed entirely when the wire is absent so the node keeps its own default.
function resolvePlaceholders(value, wires) {
    if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, wires));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            if (inner === undefined) continue;
            if (typeof inner === 'string' && inner.startsWith('$optional:')) {
                const wireKey = inner.slice('$optional:'.length);
                const wire = wires[wireKey];
                if (wire === undefined || wire === null) continue;
                out[key] = wire;
                continue;
            }
            out[key] = resolvePlaceholders(inner, wires);
        }
        return out;
    }
    if (typeof value === 'string' && value.startsWith('$')) {
        const wireKey = value.slice(1);
        return wires[wireKey];
    }
    return value;
}

// Build the LongVideos ComfyUI graph. The director supplies the planned prompt
// and scalar settings; this function wires the model stack, LoRA chain,
// attention patch and optional first-frame reference.
function buildLongVideoGraph(opts = {}) {
    const {
        prompt,
        seed = 0,
        settings = {},
        resolution = '16:9',
        megapixels = 1.0,
        shotSeconds = 15,
        steps = videoGenerator.H3_DEFAULT_STEPS,
        firstImageName = null
    } = opts;

    const graph = clone(WORKFLOW.nodes);

    // Base H3 stack (same checkpoints as the normal pipeline).
    graph.model = {
        class_type: 'UNETLoader',
        inputs: {
            unet_name: settings.h3Unet || videoGenerator.H3_DEFAULTS.h3Unet,
            weight_dtype: 'default'
        }
    };
    graph.clip = {
        class_type: 'CLIPLoader',
        inputs: {
            clip_name: settings.h3Clip || videoGenerator.H3_DEFAULTS.h3Clip,
            type: 'minimax',
            device: 'default'
        }
    };
    graph.video_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3VideoVae || videoGenerator.H3_DEFAULTS.h3VideoVae }
    };
    graph.audio_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3AudioVae || videoGenerator.H3_DEFAULTS.h3AudioVae }
    };

    // Chain the active video LoRAs onto the base model, exactly like the normal
    // H3 graph (model-only adapters; CLIP is left untouched).
    const loras = (Array.isArray(settings.loras) ? settings.loras : [])
        .filter((l) => l && l.on !== false && l.name);
    let modelNode = 'model';
    let loraIndex = 0;
    for (const lora of loras) {
        const name = String(lora.name).trim();
        if (!name) continue;
        const strength = Number.isFinite(Number(lora.strength)) ? Number(lora.strength) : 1;
        loraIndex += 1;
        const key = 'lora' + loraIndex;
        graph[key] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: { model: [modelNode, 0], lora_name: name, strength_model: strength }
        };
        modelNode = key;
    }

    // Attention backend patch, matching the normal H3 pipeline.
    const attention = videoGenerator.normalizeH3AttentionBackend(settings.attentionBackend);
    if (attention === 'sageattention') {
        graph.sage_attention = {
            class_type: 'PathchSageAttentionKJ',
            inputs: { model: [modelNode, 0], sage_attention: 'auto', allow_compile: false }
        };
        modelNode = 'sage_attention';
    } else if (attention === 'sla') {
        graph.sla_attention = {
            class_type: 'H3SLAAttention',
            inputs: {
                model: [modelNode, 0],
                sparsity_ratio: 0.85,
                block_size: '64',
                min_seq_len: 8192,
                dense_last_steps: 0,
                protect_audio: true,
                enabled: true
            }
        };
        modelNode = 'sla_attention';
    }

    // Optional first frame (an existing generated image the user referenced).
    const firstFrameWire = firstImageName
        ? (graph.first_image = { class_type: 'LoadImage', inputs: { image: firstImageName } }, ['first_image', 0])
        : undefined;

    const wires = {
        model: [modelNode, 0],
        clip: ['clip', 0],
        video_vae: ['video_vae', 0],
        audio_vae: ['audio_vae', 0],
        prompt: String(prompt || ''),
        resolution,
        megapixels: Number(megapixels),
        shot_seconds: Number(shotSeconds),
        steps: Math.max(1, Math.min(100, Math.round(Number(steps) || videoGenerator.H3_DEFAULT_STEPS))),
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        seed: Number.isFinite(Number(seed)) ? Math.max(0, Math.floor(Number(seed))) : 0,
        first_frame: firstFrameWire
    };

    return resolvePlaceholders(graph, wires);
}

// ComfyUI must know the LongVideos node. Returns a friendly, actionable error
// when it does not, so the chat reply can tell the user what to install.
async function validateLongVideoGraph(info, graph) {
    const missingNodes = [];
    for (const node of Object.values(graph)) {
        if (!node || !node.class_type) continue;
        if (!info[node.class_type]) missingNodes.push(node.class_type);
    }
    if (missingNodes.length) {
        const error = new Error(
            'ComfyUI is missing the H3 LongVideos node' +
            (missingNodes.length > 1 ? 's' : '') + ': ' + Array.from(new Set(missingNodes)).join(', ') +
            '. Install Smite79/MiniMax-H3-LongVideos into ComfyUI/custom_nodes and restart ComfyUI.'
        );
        error.code = 'longvideo_node_missing';
        error.missingNodes = Array.from(new Set(missingNodes));
        throw error;
    }
    return true;
}

// True when the installed ComfyUI exposes the LongVideos node.
function graphHasLongVideoNode(info) {
    return Boolean(info && info[REQUIRED_NODE]);
}

module.exports = {
    WORKFLOW,
    REQUIRED_NODE,
    OUTPUT_NODE,
    RESOLUTION_RATIOS,
    pickResolution,
    megapixelsForSize,
    buildLongVideoGraph,
    validateLongVideoGraph,
    graphHasLongVideoNode
};
