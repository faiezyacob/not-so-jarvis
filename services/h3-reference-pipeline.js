/* ============================================
   JARVIS — MiniMax H3 Reference Pipeline
   Plans semantic visual references, caches reusable
   H3 RefMod artifacts, and isolates the evolving
   ComfyUI node API from the generation services.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const comfyui = require('./comfyui');

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(__dirname, '..', 'data');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const CACHE_PATH = process.env.H3_REFERENCE_CACHE_PATH || path.join(DATA_DIR, 'h3-reference-cache.json');
const REF_EXTRACT_NODE = 'MiniMaxH3RefModExtract';
const REF_LOADER_NODE = 'MiniMaxH3RefModsLoader';
const REF_APPLY_NODE = 'MiniMaxH3RefModApply';
const REFMOD_INSTALL_URL = 'https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod';
const SUPPORTED_TYPES = Object.freeze([
    'character', 'image', 'video', 'object', 'product', 'location', 'outfit', 'style', 'environment', 'custom'
]);
const TYPE_DEFAULTS = Object.freeze({
    character: { mode: 'full', strength: 1, priority: 1, required: true, conceptType: 'identity' },
    image: { mode: 'full', strength: 0.95, priority: 2, required: false, conceptType: 'generic' },
    video: { mode: 'compressed', strength: 0.8, priority: 2, required: false, conceptType: 'pose_motion' },
    object: { mode: 'compressed', strength: 0.8, priority: 3, required: false, conceptType: 'generic' },
    product: { mode: 'compressed', strength: 0.85, priority: 3, required: false, conceptType: 'generic' },
    location: { mode: 'compressed', strength: 0.6, priority: 5, required: false, conceptType: 'background' },
    outfit: { mode: 'compressed', strength: 0.7, priority: 4, required: false, conceptType: 'clothing' },
    style: { mode: 'compressed', strength: 0.45, priority: 6, required: false, conceptType: 'style' },
    environment: { mode: 'compressed', strength: 0.55, priority: 5, required: false, conceptType: 'background' },
    custom: { mode: 'compressed', strength: 0.7, priority: 4, required: false, conceptType: 'generic' }
});
const configuredTokenBudget = Number(process.env.H3_REFERENCE_TOKEN_BUDGET);
const DEFAULT_TOKEN_BUDGET = process.env.H3_REFERENCE_TOKEN_BUDGET !== undefined && Number.isFinite(configuredTokenBudget)
    ? Math.max(0, Math.floor(configuredTokenBudget))
    : 5120;
const DEFAULT_COMPRESSED_GRID = 16;
const DEFAULT_VIDEO_FRAMES = 8;
const REF_CACHE_SCHEMA = 1;
let cache = null;

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(filename) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filename);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function debugEnabled() {
    return process.env.JARVIS_H3_REFERENCE_DEBUG === '1';
}

function debug(...args) {
    if (debugEnabled()) console.log('[H3 Reference]', ...args);
}

function cleanType(value) {
    const type = String(value || 'custom').trim().toLowerCase();
    return SUPPORTED_TYPES.includes(type) ? type : 'custom';
}

function normalizeMode(value, fallback) {
    const mode = String(value || fallback || 'compressed').trim().toLowerCase();
    return mode === 'full' || mode === 'full_reference' || mode === 'encode' ? 'full' : 'compressed';
}

function clampStrength(value, fallback) {
    const strength = Number(value);
    return Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : fallback;
}

function readImageDimensions(source) {
    const width = Number(source && source.width);
    const height = Number(source && source.height);
    if (width > 0 && height > 0) return { width, height };
    const filename = toSourcePath(source && source.source);
    if (!filename || !fs.existsSync(filename)) return null;
    let fd;
    try {
        fd = fs.openSync(filename, 'r');
        const head = Buffer.alloc(32);
        const length = fs.readSync(fd, head, 0, head.length, 0);
        if (length >= 24 && head.toString('hex', 0, 8) === '89504e470d0a1a0a') {
            return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
        }
        if (length >= 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP' && head.toString('ascii', 12, 16) === 'VP8X') {
            return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
        }
        if (length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
        let offset = 2;
        const chunk = Buffer.alloc(8);
        while (offset < 8 * 1024 * 1024) {
            if (fs.readSync(fd, chunk, 0, 4, offset) < 4 || chunk[0] !== 0xff) break;
            const marker = chunk[1];
            const size = chunk.readUInt16BE(2);
            if (size < 2) break;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (fs.readSync(fd, chunk, 0, 5, offset + 4) < 5) return null;
                return { height: chunk.readUInt16BE(1), width: chunk.readUInt16BE(3) };
            }
            offset += size + 2;
        }
    } catch (_) {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return null;
}

function toSourcePath(source) {
    const value = String(source || '').trim();
    if (!value) return '';
    if (/^\/generated\//i.test(value)) {
        let name = value.slice('/generated/'.length).split(/[?#]/)[0];
        try { name = decodeURIComponent(name); } catch (_) {}
        return path.join(GENERATED_DIR, path.basename(name));
    }
    if (/^\/images\//i.test(value)) {
        let name = value.slice('/images/'.length).split(/[?#]/)[0];
        try { name = decodeURIComponent(name); } catch (_) {}
        return path.join(IMAGES_DIR, path.basename(name));
    }
    if (path.isAbsolute(value)) return path.resolve(value);
    return path.join(GENERATED_DIR, path.basename(value));
}

function estimateTokens(reference, mode, settings) {
    const type = cleanType(reference.type);
    const budgetSettings = settings || {};
    const resolution = Math.max(256, Number(reference.resolution || budgetSettings.referenceResolution) || 1024);
    const dimensions = readImageDimensions(reference);
    const aspect = dimensions && dimensions.width > 0 && dimensions.height > 0
        ? dimensions.width / dimensions.height
        : (Number(reference.aspectRatio) > 0 ? Number(reference.aspectRatio) : (type === 'video' ? 16 / 9 : 1));
    if (normalizeMode(mode) === 'compressed') {
        const grid = Math.max(4, Number(reference.compressedGrid || budgetSettings.compressedGrid) || DEFAULT_COMPRESSED_GRID);
        const frames = type === 'video' ? Math.max(1, Math.min(DEFAULT_VIDEO_FRAMES, Number(reference.frameCount) || DEFAULT_VIDEO_FRAMES)) : 1;
        const gridW = aspect >= 1 ? Math.max(2, Math.ceil(grid * aspect)) : grid;
        const gridH = aspect >= 1 ? grid : Math.max(2, Math.ceil(grid / aspect));
        return frames * Math.ceil(gridW / 2) * Math.ceil(gridH / 2);
    }
    const scale = dimensions ? Math.min(1, resolution / Math.min(dimensions.width, dimensions.height)) : 1;
    const latentW = dimensions ? Math.max(2, Math.ceil(dimensions.width * scale / 32)) : Math.ceil(resolution / 32);
    const latentH = dimensions ? Math.max(2, Math.ceil(dimensions.height * scale / 32)) : Math.ceil(resolution / 32);
    const frames = type === 'video' ? Math.max(1, Math.min(DEFAULT_VIDEO_FRAMES, Number(reference.frameCount) || DEFAULT_VIDEO_FRAMES)) : 1;
    return frames * latentW * latentH;
}

function normalizedReferences(references, options = {}) {
    const input = Array.isArray(references) ? references : [];
    const out = [];
    for (let index = 0; index < input.length; index += 1) {
        const source = input[index];
        if (!source || typeof source !== 'object') continue;
        if (!source.source && source.required !== true) continue;
        const type = cleanType(source.type);
        const defaults = TYPE_DEFAULTS[type];
        const id = String(source.id || type + ':' + index).trim();
        const mode = normalizeMode(source.mode, defaults.mode);
        out.push(Object.assign({}, source, {
            id,
            type,
            source: String(source.source || '').trim(),
            mode,
            strength: clampStrength(source.strength, defaults.strength),
            priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : defaults.priority,
            required: source.required === undefined ? defaults.required : source.required === true,
            conceptType: String(source.conceptType || defaults.conceptType),
            order: Number.isFinite(Number(source.order)) ? Number(source.order) : index,
            tokenCount: estimateTokens(source, mode, options.settings)
        }));
    }
    return out;
}

function planH3References({ references, mode, settings, generationContext } = {}) {
    const config = settings || {};
    const rawBudget = config.referenceTokenBudget !== undefined
        ? config.referenceTokenBudget
        : (process.env.H3_REFERENCE_TOKEN_BUDGET !== undefined ? process.env.H3_REFERENCE_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET);
    const parsedBudget = Number(rawBudget);
    const tokenBudget = Number.isFinite(parsedBudget) ? Math.max(0, Math.floor(parsedBudget)) : DEFAULT_TOKEN_BUDGET;
    const candidates = normalizedReferences(references, { settings: config })
        .sort((a, b) => a.priority - b.priority || a.order - b.order);
    const seenIds = new Set();
    const seenSources = new Set();
    const unique = [];
    const omitted = [];
    for (const ref of candidates) {
        const sourceKey = ref.sourceHash
            ? String(ref.sourceHash).toLowerCase()
            : (ref.source ? path.resolve(toSourcePath(ref.source)).toLowerCase() : '');
        const duplicateKey = ref.type + '|' + ref.id;
        if (seenIds.has(duplicateKey) || (sourceKey && seenSources.has(sourceKey))) {
            omitted.push({ id: ref.id, type: ref.type, reason: 'duplicate reference' });
            continue;
        }
        seenIds.add(duplicateKey);
        if (sourceKey) seenSources.add(sourceKey);
        unique.push(ref);
    }
    if (unique.length > 8) {
        const retained = unique.slice(0, 8);
        for (const ref of unique.slice(8)) {
            if (ref.required) {
                const error = new Error('The H3 reference loader supports up to 8 visual references, but required reference "' + (ref.name || ref.id) + '" would be omitted. Reduce the required reference set and retry.');
                error.code = 'h3_reference_limit_exceeded';
                throw error;
            }
            omitted.push({ id: ref.id, type: ref.type, reason: 'maximum of 8 H3 references' });
        }
        unique.splice(0, unique.length, ...retained);
    }
    const primary = unique[0] || null;
    let total = unique.reduce((sum, ref) => sum + ref.tokenCount, 0);

    if (tokenBudget > 0 && total > tokenBudget) {
        const secondaries = unique.filter((ref) => ref !== primary && ref.type !== 'character' && ref.mode === 'full')
            .sort((a, b) => b.priority - a.priority || b.order - a.order);
        for (const ref of secondaries) {
            if (total <= tokenBudget) break;
            const old = ref.tokenCount;
            ref.mode = 'compressed';
            ref.strength = Math.min(ref.strength, ref.type === 'style' ? 0.35 : 0.7);
            ref.tokenCount = estimateTokens(ref, ref.mode, config);
            total += ref.tokenCount - old;
            ref.budgetAction = 'compressed';
        }
        const secondaryCharacters = unique.filter((ref) => ref !== primary && ref.type === 'character' && ref.mode === 'full')
            .sort((a, b) => b.order - a.order);
        for (const ref of secondaryCharacters) {
            if (total <= tokenBudget) break;
            const old = ref.tokenCount;
            ref.mode = 'compressed';
            ref.strength = Math.min(ref.strength, 0.8);
            ref.tokenCount = estimateTokens(ref, ref.mode, config);
            total += ref.tokenCount - old;
            ref.budgetAction = 'compressed secondary character reference';
        }
        if (total > tokenBudget && primary && primary.type !== 'character' && primary.mode === 'full') {
            const old = primary.tokenCount;
            primary.mode = 'compressed';
            primary.strength = Math.min(primary.strength, 0.7);
            primary.tokenCount = estimateTokens(primary, primary.mode, config);
            total += primary.tokenCount - old;
            primary.budgetAction = 'compressed';
        }
        const reduce = unique.filter((ref) => ref.type !== 'character' && ref.mode === 'compressed')
            .sort((a, b) => b.priority - a.priority || b.order - a.order);
        for (const ref of reduce) {
            if (total <= tokenBudget) break;
            const old = ref.tokenCount;
            if (ref.type === 'video') ref.frameCount = Math.max(1, Math.floor(Number(ref.frameCount || DEFAULT_VIDEO_FRAMES) / 2));
            else ref.compressedGrid = 8;
            ref.strength = Math.max(0.25, ref.strength * 0.8);
            ref.tokenCount = estimateTokens(ref, ref.mode, config);
            total += ref.tokenCount - old;
            ref.budgetAction = 'reduced';
        }
        const reduceCharacter = unique.filter((ref) => ref !== primary && ref.type === 'character' && ref.mode === 'compressed')
            .sort((a, b) => b.order - a.order);
        for (const ref of reduceCharacter) {
            if (total <= tokenBudget) break;
            const old = ref.tokenCount;
            ref.compressedGrid = 8;
            ref.strength = Math.max(0.5, ref.strength * 0.9);
            ref.tokenCount = estimateTokens(ref, ref.mode, config);
            total += ref.tokenCount - old;
            ref.budgetAction = 'reduced secondary character reference';
        }
        const removable = unique.slice().filter((ref) => ref !== primary && !ref.required)
            .sort((a, b) => b.priority - a.priority || b.order - a.order);
        for (const ref of removable) {
            if (total <= tokenBudget) break;
            unique.splice(unique.indexOf(ref), 1);
            total -= ref.tokenCount;
            omitted.push({ id: ref.id, type: ref.type, reason: 'reference token budget' });
        }
        if (total > tokenBudget) {
            const error = new Error('The required H3 visual references need approximately ' + total +
                ' tokens, exceeding the configured reference budget of ' + tokenBudget + '. Increase H3_REFERENCE_TOKEN_BUDGET or reduce secondary references.');
            error.code = 'h3_reference_budget_exceeded';
            error.referenceTokens = total;
            error.referenceTokenBudget = tokenBudget;
            throw error;
        }
    }

    const planned = unique.slice().sort((a, b) => a.order - b.order || a.priority - b.priority);
    debug('Resolved references:', planned.length, 'mode:', String(mode || 'direct'));
    for (const ref of planned) {
        debug(ref.type + ': ' + ref.id + ', mode=' + ref.mode + ', strength=' + ref.strength.toFixed(2) +
            ', tokens=' + ref.tokenCount + (ref.budgetAction ? ', budget=' + ref.budgetAction : ''));
    }
    debug('Reference tokens:', total + ' / ' + (tokenBudget || 'unlimited'));
    for (const ref of omitted) debug('Omitted reference:', ref.id, 'reason:', ref.reason);
    return {
        references: planned,
        primaryReference: primary && planned.includes(primary) ? primary : (planned[0] || null),
        omittedReferences: omitted,
        reason: planned.length ? 'semantic references supplied' : 'no references supplied',
        tokenCount: total,
        tokenBudget,
        generationMode: String(mode || (generationContext && generationContext.mode) || 'direct')
    };
}

function planReferenceRequest({ prompt, mentions, uploadedReferences, references, studio, generationMode, settings } = {}) {
    const gathered = [];
    const append = (value, fallbackType) => {
        const items = Array.isArray(value) ? value : (value && Array.isArray(value.references) ? value.references : []);
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            gathered.push(Object.assign({}, fallbackType && !item.type ? { type: fallbackType } : {}, item));
        }
    };
    append(references);
    append(mentions);
    append(uploadedReferences, 'image');
    append(studio && (studio.semanticReferences || studio.references));
    return planH3References({
        references: gathered,
        mode: generationMode,
        settings,
        generationContext: {
            prompt: String(prompt || ''),
            studio: typeof studio === 'string' ? studio : (studio && studio.name) || ''
        }
    });
}

function resolveRegistryMentions(text, registries = []) {
    const original = String(text || '');
    const entries = [];
    for (const registry of Array.isArray(registries) ? registries : []) {
        const type = cleanType(registry && registry.type);
        const items = registry && Array.isArray(registry.items) ? registry.items : [];
        for (const item of items) {
            const name = String(item && (item.name || item.label) || '').trim();
            if (!name) continue;
            entries.push({ type, name, item });
        }
    }
    entries.sort((a, b) => b.name.length - a.name.length);
    const spans = [];
    for (const entry of entries) {
        const re = new RegExp('(^|[^\\w@])@' + entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w@])', 'gi');
        let match;
        while ((match = re.exec(original)) !== null) {
            const start = match.index + match[1].length;
            const end = start + 1 + entry.name.length;
            if (spans.some((span) => start < span.end && end > span.start)) continue;
            spans.push({ start, end, entry });
        }
    }
    const matches = spans.slice().sort((a, b) => a.start - b.start);
    const refs = [];
    for (const span of matches) {
        const entry = span.entry;
        if (!refs.some((ref) => ref.id === String(entry.item.id || entry.name))) {
            refs.push({ type: entry.type, id: String(entry.item.id || entry.name), name: entry.name, entity: entry.item });
        }
    }
    spans.sort((a, b) => b.start - a.start);
    let prompt = original;
    for (const span of spans) prompt = prompt.slice(0, span.start) + prompt.slice(span.end);
    return { references: refs, prompt: prompt.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim() };
}

function loadCache() {
    if (cache) return cache;
    try {
        const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        cache = parsed && parsed.version === REF_CACHE_SCHEMA
            ? parsed
            : { version: REF_CACHE_SCHEMA, entries: {}, current: {} };
    } catch (_) {
        cache = { version: REF_CACHE_SCHEMA, entries: {}, current: {} };
    }
    if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};
    if (!cache.current || typeof cache.current !== 'object') cache.current = {};
    return cache;
}

function saveCache() {
    const target = CACHE_PATH;
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const temporary = target + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(temporary, target);
}

function schemaFingerprint(info) {
    const names = [REF_EXTRACT_NODE, REF_LOADER_NODE, REF_APPLY_NODE];
    return sha256(Buffer.from(JSON.stringify(names.map((name) => {
        const node = info && info[name];
        const input = node && node.input || {};
        return {
            name,
            required: Object.keys(input.required || {}).sort(),
            optional: Object.keys(input.optional || {}).sort(),
            output: node && node.output || [],
            outputName: node && node.output_name || [],
            module: node && node.python_module || ''
        };
    })))).slice(0, 16);
}

function requireRefModNodes(info) {
    const missing = [REF_EXTRACT_NODE, REF_LOADER_NODE, REF_APPLY_NODE].filter((name) => !info || !info[name]);
    if (missing.length) {
        const error = new Error('Reusable H3 visual references need the MiniMaxH3Mod ComfyUI nodes (' + missing.join(', ') + '). Install ' + REFMOD_INSTALL_URL + ' and restart ComfyUI. No video was generated without the requested reference.');
        error.code = 'h3_reference_nodes_missing';
        error.missingNodes = missing;
        error.installUrl = REFMOD_INSTALL_URL;
        throw error;
    }
    const loaderInputs = ['show_info'];
    for (let slot = 1; slot <= 8; slot += 1) {
        loaderInputs.push('mod_' + slot, 'strength_' + slot, 'copies_' + slot);
    }
    const contracts = [
        [REF_EXTRACT_NODE, ['name', 'mode', 'vae', 'save', 'background_retention']],
        [REF_LOADER_NODE, loaderInputs.concat('max_total_tokens')],
        [REF_APPLY_NODE, ['conditioning', 'mods', 'override', 'retention', 'curve_direction', 'scramble_seed', 'curve_shape', 'curve_value', 'max_total_tokens']]
    ];
    const unsupported = [];
    for (const [name, required] of contracts) {
        const available = schemaInputs(info, name);
        for (const input of required) {
            if (!Object.prototype.hasOwnProperty.call(available, input)) unsupported.push(name + '.' + input);
        }
    }
    const extractorInputs = schemaInputs(info, REF_EXTRACT_NODE);
    if (!Object.prototype.hasOwnProperty.call(extractorInputs, 'refs_image') &&
        !Object.prototype.hasOwnProperty.call(extractorInputs, 'ref_image_1')) unsupported.push(REF_EXTRACT_NODE + '.refs_image');
    if (unsupported.length) {
        const error = new Error('The installed MiniMaxH3Mod ComfyUI schema is missing required reference inputs: ' + unsupported.join(', ') + '. Update the node pack and restart ComfyUI.');
        error.code = 'h3_reference_schema_unsupported';
        error.missingInputs = unsupported;
        throw error;
    }
}

function schemaInputs(info, nodeName) {
    const node = info && info[nodeName];
    if (!node) return {};
    return Object.assign({}, node.input && node.input.required || {}, node.input && node.input.optional || {});
}

function inputExists(info, nodeName, input) {
    return Object.prototype.hasOwnProperty.call(schemaInputs(info, nodeName), input);
}

function comboOptions(info, nodeName, input) {
    const entry = schemaInputs(info, nodeName)[input];
    if (!Array.isArray(entry)) return [];
    if (Array.isArray(entry[0])) return entry[0].map(String);
    if (entry[1] && Array.isArray(entry[1].options)) return entry[1].options.map(String);
    return [];
}

function referenceSchemaError(message) {
    const error = new Error('The installed MiniMaxH3Mod ComfyUI API is not compatible with this reference adapter: ' + message + '. Update the custom node pack and restart ComfyUI.');
    error.code = 'h3_reference_schema_unsupported';
    return error;
}

function artifactNameFor(reference, key) {
    const kind = cleanType(reference.type).replace(/[^a-z0-9_-]/g, '_');
    const entity = String(reference.entityId || reference.id || kind).replace(/[^a-z0-9_-]/gi, '_').slice(0, 28);
    return (kind + '_' + entity + '_' + key.slice(0, 20)).slice(0, 80);
}

function cacheKey(reference, sourceHash, settings, info) {
    return sha256(Buffer.from(JSON.stringify({
        schema: schemaFingerprint(info),
        id: reference.id,
        type: reference.type,
        sourceHash,
        mode: reference.mode,
        resolution: Number(reference.resolution || settings.referenceResolution) || 1024,
        compressedGrid: Number(reference.compressedGrid || settings.compressedGrid) || DEFAULT_COMPRESSED_GRID,
        frameCount: Number(reference.frameCount) || (reference.type === 'video' ? DEFAULT_VIDEO_FRAMES : 1),
        tokenBudget: Number(settings.referenceTokenBudget) || 0,
        unet: settings.h3Ref2vaUnet || settings.h3Unet || '',
        clip: settings.h3Clip || '',
        vae: settings.h3VideoVae || ''
    })));
}

async function sampleVideoFrames(sourcePath, maxFrames) {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH
        ? path.join(path.dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
        : 'ffprobe');
    let duration = 0;
    try {
        const result = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourcePath], { windowsHide: true, timeout: 30000 });
        duration = Number(String(result.stdout || '').trim());
    } catch (err) {
        const error = new Error('Could not inspect the H3 video reference. Install ffmpeg/ffprobe or use an image reference: ' + err.message);
        error.code = 'h3_reference_video_unavailable';
        throw error;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
        const error = new Error('The H3 video reference has no readable duration.');
        error.code = 'h3_reference_video_invalid';
        throw error;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-h3-ref-'));
    const outputPattern = path.join(dir, 'frame-%02d.png');
    const rate = Math.max(0.1, Math.min(2, maxFrames / duration));
    try {
        await execFileAsync(ffmpeg, ['-v', 'error', '-i', sourcePath, '-vf', 'fps=' + rate.toFixed(6), '-frames:v', String(maxFrames), '-vsync', '0', outputPattern], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
        const files = fs.readdirSync(dir).filter((name) => /^frame-\d+\.png$/i.test(name)).sort().map((name) => path.join(dir, name));
        if (!files.length) {
            const error = new Error('No frames could be sampled from the H3 video reference.');
            error.code = 'h3_reference_video_invalid';
            throw error;
        }
        return { dir, files };
    } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        if (err.code === 'h3_reference_video_invalid') throw err;
        const error = new Error('Could not sample the H3 video reference: ' + err.message);
        error.code = 'h3_reference_video_unavailable';
        throw error;
    }
}

function extractDetails(history) {
    const values = [];
    const visit = (value) => {
        if (typeof value === 'string') values.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(history && history.outputs);
    for (const text of values) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && Array.isArray(parsed.saved_paths) && parsed.saved_paths.length) return parsed;
        } catch (_) {}
    }
    return null;
}

async function createArtifact(reference, sourcePath, sourceHash, settings, info, options = {}) {
    const key = cacheKey(reference, sourceHash, settings, info);
    const store = loadCache();
    const hit = store.entries[key];
    if (hit && hit.artifactPath && fs.existsSync(hit.artifactPath)) {
        const currentChanged = store.current[reference.id] !== key;
        const strengthChanged = hit.strength !== reference.strength;
        store.current[reference.id] = key;
        if (strengthChanged) hit.strength = reference.strength;
        if (currentChanged || strengthChanged) saveCache();
        debug(reference.type + ': ' + (reference.name || reference.id), 'Mode:', reference.mode, 'Strength:', reference.strength.toFixed(2), 'Cache: HIT');
        return Object.assign({}, reference, {
            artifactName: hit.artifactName,
            artifactHash: hit.artifactHash,
            cache: 'HIT',
            tokenCount: hit.tokenCount || reference.tokenCount,
            referenceHash: sourceHash
        });
    }

    const artifactName = artifactNameFor(reference, key);
    let imagePaths = options.imagePaths || [sourcePath];
    let videoSampleDir = '';
    const uploaded = [];
    try {
        if (!options.imagePaths && (reference.type === 'video' || /\.(?:mp4|webm|mov|avi|mkv)$/i.test(sourcePath))) {
            const sampled = await sampleVideoFrames(sourcePath, Math.max(1, Math.min(DEFAULT_VIDEO_FRAMES, Number(reference.frameCount) || DEFAULT_VIDEO_FRAMES)));
            videoSampleDir = sampled.dir;
            imagePaths = sampled.files;
        }
        const refs = [];
        for (let i = 0; i < imagePaths.length; i += 1) {
            const file = imagePaths[i];
            const uploadName = 'jarvis_h3_ref_' + Date.now() + '_' + i + '_' + path.basename(file);
            const result = await comfyui.uploadImage(fs.readFileSync(file), uploadName);
            const name = String(result && result.name || uploadName);
            uploaded.push(name);
            refs.push(name);
        }
        const graph = {
            ref_vae: { class_type: 'VAELoader', inputs: { vae_name: settings.h3VideoVae || 'hunyuan_video_vae.safetensors' } },
            ref_load_1: { class_type: 'LoadImage', inputs: { image: refs[0] } }
        };
        for (let i = 1; i < refs.length; i += 1) {
            const loadId = 'ref_load_' + (i + 1);
            graph[loadId] = { class_type: 'LoadImage', inputs: { image: refs[i] } };
        }
        const supported = schemaInputs(info, REF_EXTRACT_NODE);
        const referenceInputPrefix = Object.prototype.hasOwnProperty.call(supported, 'refs_image')
            ? 'refs_image.ref_image_'
            : (Object.prototype.hasOwnProperty.call(supported, 'ref_image_1') ? 'ref_image_' : '');
        if (!referenceInputPrefix) throw referenceSchemaError('the extractor has no image-reference input');
        if (!Object.prototype.hasOwnProperty.call(supported, 'vae')) throw referenceSchemaError('the extractor has no standard H3 VAE input');
        if (!Object.prototype.hasOwnProperty.call(supported, 'name') || !Object.prototype.hasOwnProperty.call(supported, 'mode')) {
            throw referenceSchemaError('the extractor is missing its artifact-name or reference-mode input');
        }
        const modeOptions = comboOptions(info, REF_EXTRACT_NODE, 'mode');
        const requestedMode = reference.mode === 'full' ? ['Full Reference', 'encode'] : ['Compressed Reference', 'training'];
        const extractMode = requestedMode.find((candidate) => !modeOptions.length || modeOptions.includes(candidate));
        if (!extractMode) throw referenceSchemaError('the extractor exposes no supported full/compressed reference mode');
        const candidateInputs = {
            name: artifactName,
            mode: extractMode,
            concept_type: reference.conceptType || TYPE_DEFAULTS[reference.type].conceptType,
            vae: ['ref_vae', 0],
            ref_resolution: Number(reference.resolution || settings.referenceResolution) || 1024,
            pool_h: Number(reference.compressedGrid || settings.compressedGrid) || DEFAULT_COMPRESSED_GRID,
            pool_w: Number(reference.compressedGrid || settings.compressedGrid) || DEFAULT_COMPRESSED_GRID,
            latent_frames: Math.max(1, Math.min(16, Number(reference.frameCount) || (reference.type === 'video' ? DEFAULT_VIDEO_FRAMES : 1))),
            identity: 0,
            multiplier: 1,
            max_tokens: Math.max(0, Number(settings.referenceTokenBudget)),
            background_retention: 0,
            description: String(reference.name || reference.type),
            save: true,
            subfolder: 'jarvis',
            merge: false,
            motion_only: false,
            extraction_preset: 'manual',
            budget_policy: 'error'
        };
        const inputs = {};
        for (const [input, value] of Object.entries(candidateInputs)) {
            if (Object.prototype.hasOwnProperty.call(supported, input)) inputs[input] = value;
        }
        refs.forEach((name, index) => {
            const slot = index + 1;
            inputs[referenceInputPrefix + slot] = ['ref_load_' + slot, 0];
        });
        graph.refmod_create = { class_type: REF_EXTRACT_NODE, inputs };
        const pid = await comfyui.queuePrompt(graph);
        const history = await comfyui.waitForPrompt(pid, {
            timeoutMs: Number(settings.referenceEncodeTimeoutMs) || 15 * 60 * 1000,
            signal: options.signal
        });
        const details = extractDetails(history);
        const artifactPath = details && details.saved_paths && details.saved_paths[0]
            ? path.resolve(String(details.saved_paths[0]))
            : '';
        if (!artifactPath || !fs.existsSync(artifactPath)) {
            const error = new Error('ComfyUI finished preparing the H3 reference but did not return a readable saved artifact path. Check the MiniMaxH3Mod output and models/refmods folder.');
            error.code = 'h3_reference_artifact_missing';
            throw error;
        }
        const artifactHash = sha256(fs.readFileSync(artifactPath));
        const entry = {
            referenceId: reference.id,
            sourceHash,
            referenceType: reference.type,
            mode: reference.mode,
            strength: reference.strength,
            resolution: Number(reference.resolution || settings.referenceResolution) || 1024,
            modelVersion: String(settings.h3Ref2vaUnet || settings.h3Unet || ''),
            vaeVersion: String(settings.h3VideoVae || ''),
            schemaVersion: schemaFingerprint(info),
            artifactName: 'jarvis/' + artifactName,
            artifactPath,
            artifactHash,
            tokenCount: details && Number(details.tokens) || reference.tokenCount,
            createdAt: new Date().toISOString()
        };
        const previousKey = store.current[reference.id];
        const previous = previousKey && previousKey !== key ? store.entries[previousKey] : null;
        if (previousKey && previousKey !== key) delete store.entries[previousKey];
        store.entries[key] = entry;
        store.current[reference.id] = key;
        saveCache();
        if (previous && previous.artifactPath && previous.artifactPath !== artifactPath) {
            try { fs.unlinkSync(previous.artifactPath); } catch (_) {}
        }
        debug(reference.type + ': ' + (reference.name || reference.id), 'Mode:', reference.mode, 'Strength:', reference.strength.toFixed(2), 'Cache: MISS');
        return Object.assign({}, reference, {
            artifactName: entry.artifactName,
            artifactHash,
            cache: 'MISS',
            tokenCount: entry.tokenCount,
            referenceHash: sourceHash
        });
    } finally {
        for (const name of uploaded) await comfyui.deleteInputFile(name).catch(() => {});
        if (videoSampleDir) fs.rmSync(videoSampleDir, { recursive: true, force: true });
    }
}

function referenceGuidance(references) {
    const refs = Array.isArray(references) ? references : [];
    const kinds = [...new Set(refs.map((ref) => cleanType(ref.type)))];
    const lines = [];
    if (kinds.includes('character')) {
        lines.push('Use the supplied character visual reference to preserve the named character identity. Generate the requested new scene, clothing, action, pose, camera, framing, lighting and motion; do not reproduce the reference portrait or its composition unless explicitly requested.');
    }
    if (kinds.some((type) => ['object', 'product'].includes(type))) {
        lines.push('Preserve the referenced product or object appearance and place it naturally in the requested scene; do not copy the reference image composition.');
    }
    if (kinds.some((type) => ['location', 'environment'].includes(type))) {
        lines.push('Use the referenced environment’s visual characteristics while composing the requested new camera view; do not reproduce its exact framing.');
    }
    if (kinds.some((type) => ['style', 'outfit'].includes(type))) {
        lines.push('Use the supplied style or outfit reference only for its relevant visual qualities; follow the requested scene composition and action.');
    }
    if (!lines.length && refs.length) lines.push('Use the supplied visual references for the requested visual subject only; follow the requested new scene and camera composition.');
    return lines;
}

async function reconcilePreparedBudget(prepared, plan, settings, info, signal) {
    const tokenBudget = Number(plan.tokenBudget) || 0;
    if (!tokenBudget) return { references: prepared, tokenCount: prepared.reduce((sum, ref) => sum + Number(ref.tokenCount || 0), 0), omitted: [] };
    const references = prepared.slice();
    const omitted = [];
    const totalTokens = () => references.reduce((sum, ref) => sum + Number(ref.tokenCount || 0), 0);
    const candidates = references.slice()
        .filter((ref) => ref.type !== 'character')
        .sort((a, b) => b.priority - a.priority || b.order - a.order)
        .concat(references.filter((ref) => ref.type === 'character' && ref.id !== (plan.primaryReference && plan.primaryReference.id)))
        .map((ref) => ref.id);
    let total = totalTokens();
    let changed = true;
    while (total > tokenBudget && changed) {
        changed = false;
        for (const id of candidates) {
            if (total <= tokenBudget) break;
            const ref = references.find((item) => item.id === id);
            if (!ref) continue;
            const smaller = Object.assign({}, ref);
            if (smaller.mode === 'full') {
                smaller.mode = 'compressed';
                smaller.strength = Math.min(smaller.strength, 0.7);
                smaller.budgetAction = 'compressed after measured token count';
            } else if (smaller.type === 'video' && Number(smaller.frameCount || DEFAULT_VIDEO_FRAMES) > 1) {
                smaller.frameCount = Math.max(1, Math.floor(Number(smaller.frameCount || DEFAULT_VIDEO_FRAMES) / 2));
                smaller.strength = Math.max(0.25, smaller.strength * 0.8);
                smaller.budgetAction = 'reduced video frames after measured token count';
            } else if (Number(smaller.compressedGrid || DEFAULT_COMPRESSED_GRID) > 4) {
                smaller.compressedGrid = Math.max(4, Math.floor(Number(smaller.compressedGrid || DEFAULT_COMPRESSED_GRID) / 2));
                smaller.strength = Math.max(0.25, smaller.strength * 0.8);
                smaller.budgetAction = 'reduced grid after measured token count';
            } else {
                continue;
            }
            const sourcePath = toSourcePath(smaller.source);
            if (!sourcePath || !fs.existsSync(sourcePath)) continue;
            const sourceHash = smaller.referenceHash || await hashFile(sourcePath);
            const replacement = await createArtifact(smaller, sourcePath, sourceHash, settings, info, { signal });
            const index = references.findIndex((item) => item.id === id);
            if (index !== -1) references[index] = replacement;
            total = totalTokens();
            changed = true;
        }
    }
    const removable = references.slice()
        .filter((ref) => !ref.required && ref.id !== (plan.primaryReference && plan.primaryReference.id))
        .sort((a, b) => b.priority - a.priority || b.order - a.order);
    for (const ref of removable) {
        if (total <= tokenBudget) break;
        const index = references.indexOf(ref);
        if (index === -1) continue;
        references.splice(index, 1);
        total -= Number(ref.tokenCount || 0);
        omitted.push({ id: ref.id, type: ref.type, reason: 'measured H3 reference token budget' });
    }
    if (total > tokenBudget) {
        const error = new Error('Prepared H3 references require ' + total + ' tokens, exceeding the configured reference budget of ' + tokenBudget + '. The primary character identity was preserved; increase H3_REFERENCE_TOKEN_BUDGET or remove other required references.');
        error.code = 'h3_reference_budget_exceeded';
        error.referenceTokens = total;
        error.referenceTokenBudget = tokenBudget;
        throw error;
    }
    return { references, tokenCount: total, omitted };
}

function applyReferenceGuidance(prompt, guidance) {
    const text = String(prompt || '').trim();
    const lines = Array.isArray(guidance) ? guidance.map((line) => String(line || '').trim()).filter(Boolean) : [];
    if (!text || !lines.length) return text;
    const addition = lines.join(' ');
    const header = /^(detailed_description|integrated_multimodal_description)\s*:\s*\r?\n/im.exec(text);
    if (header) {
        const position = header.index + header[0].length;
        return text.slice(0, position) + addition + '\n' + text.slice(position);
    }
    return addition + '\n' + text;
}

async function prepareH3References({ references, mentions, uploadedReferences, prompt, studio, mode, generationMode, settings, generationContext, signal } = {}) {
    const sourceSettings = Object.assign({}, settings || {});
    const plan = planReferenceRequest({
        references,
        mentions,
        uploadedReferences,
        prompt,
        studio: studio || generationContext && generationContext.studio,
        generationMode: generationMode || mode,
        settings: sourceSettings
    });
    sourceSettings.referenceTokenBudget = plan.tokenBudget;
    if (!plan.references.length) {
        return Object.assign({}, plan, { references: [], guidance: [], applied: false, cache: [] });
    }
    const info = await comfyui.getObjectInfo();
    try {
        requireRefModNodes(info);
    } catch (err) {
        if (plan.references.some((ref) => ref.required)) throw err;
        const unavailable = plan.references.map((ref) => ({ id: ref.id, type: ref.type, reason: err.message }));
        debug('Optional references omitted: RefMod nodes are unavailable.');
        return Object.assign({}, plan, { references: [], omittedReferences: plan.omittedReferences.concat(unavailable), guidance: [], applied: false, cache: [] });
    }
    const prepared = [];
    const skipped = plan.omittedReferences.slice();
    for (const ref of plan.references) {
        const sourcePath = toSourcePath(ref.source);
        try {
            if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                const error = new Error('Visual reference source is missing: ' + (ref.name || ref.id));
                error.code = 'h3_reference_source_missing';
                throw error;
            }
            const sourceHash = await hashFile(sourcePath);
            prepared.push(await createArtifact(ref, sourcePath, sourceHash, sourceSettings, info, { signal }));
        } catch (err) {
            if (ref.required) {
                if (!err.code) err.code = 'h3_reference_prepare_failed';
                err.message = 'Required ' + ref.type + ' reference "' + (ref.name || ref.id) + '" could not be prepared: ' + err.message;
                throw err;
            }
            skipped.push({ id: ref.id, type: ref.type, reason: err.message });
            debug('Optional reference omitted:', ref.id, err.message);
        }
    }
    const fitted = await reconcilePreparedBudget(prepared, plan, sourceSettings, info, signal);
    prepared.splice(0, prepared.length, ...fitted.references);
    skipped.push(...fitted.omitted);
    plan.tokenCount = fitted.tokenCount;
    if (plan.primaryReference && plan.primaryReference.required && !prepared.some((ref) => ref.id === plan.primaryReference.id)) {
        const error = new Error('The primary H3 visual reference could not be prepared; video generation was stopped rather than continuing without it.');
        error.code = 'h3_reference_required_failed';
        throw error;
    }
    const guidance = referenceGuidance(prepared);
    debug('Final references applied:', prepared.length);
    return Object.assign({}, plan, {
        references: prepared,
        omittedReferences: skipped,
        guidance,
        applied: prepared.length > 0,
        cache: prepared.map((ref) => ({ id: ref.id, status: ref.cache }))
    });
}

function resetCacheForTests() {
    cache = null;
}

module.exports = {
    SUPPORTED_TYPES,
    TYPE_DEFAULTS,
    DEFAULT_TOKEN_BUDGET,
    REF_EXTRACT_NODE,
    REF_LOADER_NODE,
    REF_APPLY_NODE,
    REFMOD_INSTALL_URL,
    normalizeMode,
    estimateTokens,
    planH3References,
    planReferenceRequest,
    resolveRegistryMentions,
    prepareH3References,
    referenceGuidance,
    applyReferenceGuidance,
    resetCacheForTests
};
