/* ============================================
   JARVIS — Character Identity System
   One character, one approved base image and ONE
   consolidated Character Identity Sheet image (a
   composite multi-panel reference document), plus
   structured identity metadata.

   This module owns the character identity package
   lifecycle and the scene/identity prompt layer. It
   never builds the final Krea2 prompt and never
   talks to ComfyUI directly: the caller injects the
   existing image generator, so the identity sheet
   reuses the Qwen Image 2.1 edit pipeline with the
   approved base image as the source.

   The single-sheet model is deliberate: expanding a
   character into several separate reference images
   explodes the reference count for multi-character
   scenes. Downstream generation receives exactly one
   identity image per character.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const CHARACTER_IDENTITY_SCHEMA_VERSION = 2;

// Package-level lifecycle (stored on the character preset).
const STATUS = {
    CANDIDATE: 'candidate',
    APPROVED: 'approved',
    GENERATING: 'generating_identity',
    READY: 'ready',
    FAILED: 'failed'
};

// Identity-sheet lifecycle (stored under identitySheet.status).
const SHEET_STATUS = {
    NOT_STARTED: 'not_started',
    GENERATING: 'generating',
    READY: 'ready',
    FAILED: 'failed'
};

const IDENTITY_SHEET_VERSION = 1;

// --- Small helpers ------------------------------------------------------------

function toArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

function uniqueStrings(list) {
    const out = [];
    for (const item of list || []) {
        const value = String(item || '').trim();
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

function basenameOf(url) {
    const raw = String(url || '').split('?')[0];
    const idx = raw.lastIndexOf('/');
    const name = idx === -1 ? raw : raw.slice(idx + 1);
    try { return decodeURIComponent(name); } catch (err) { return name; }
}

// The structured identity behind a value that may be a character record or a
// raw canonical identity.
function identityRecord(value) {
    if (!value) return {};
    if (value.identity && typeof value.identity === 'object') return value.identity;
    return value;
}

function normalizedSheetStatus(value) {
    return Object.values(SHEET_STATUS).includes(value) ? value : SHEET_STATUS.NOT_STARTED;
}

// --- Metadata -----------------------------------------------------------------

// Accessory vocabulary scanned from the structured distinctive feature (and a
// dedicated accessories field when present). Identity-only — clothing lives on
// the Outfit Pack.
const ACCESSORY_KEYWORDS = [
    { re: /\b(?:glasses|spectacles|eyeglasses|sunglasses)\b/i, label: 'glasses' },
    { re: /\b(?:hoop|stud|drop)?\s*earrings?\b/i, label: 'earrings' },
    { re: /\bnecklace\b/i, label: 'necklace' },
    { re: /\bpiercings?\b/i, label: 'piercings' },
    { re: /\btattoos?\b/i, label: 'tattoos' },
    { re: /\b(?:jewelry|jewellery)\b/i, label: 'jewelry' },
    { re: /\bwatch\b/i, label: 'watch' },
    { re: /\bring\b/i, label: 'ring' },
    { re: /\b(?:hat|cap|beanie|headband|scarf)\b/i, label: 'signature headwear' },
    { re: /\bbracelet\b/i, label: 'bracelet' },
    { re: /\b(?:nose|lip|eyebrow)\s+ring\b/i, label: 'piercings' }
];

function inferAccessories(id) {
    if (!id) return [];
    const explicit = toArray(id.accessories || id.signatureAccessories);
    const text = [id.distinctiveFeature, id.distinctiveFeatures].flat().filter(Boolean).join(' ');
    const found = [];
    for (const entry of ACCESSORY_KEYWORDS) {
        if (entry.re.test(text) && !found.includes(entry.label)) found.push(entry.label);
    }
    for (const item of explicit) {
        if (!found.includes(item)) found.push(item);
    }
    return found;
}

function hairLengthFromStyle(style) {
    const s = String(style || '').toLowerCase();
    if (!s) return '';
    if (/\b(?:waist|chest|long|mid-back|midback)\b/.test(s)) return 'long';
    if (/\b(?:shoulder|medium|chin|bob|lob|collar)\b/.test(s)) return 'medium';
    if (/\b(?:pixie|buzz|short|cropped|undercut|fade)\b/.test(s)) return 'short';
    if (/\b(?:bun|ponytail|updo|chignon|topknot|top knot)\b/.test(s)) return 'tied back';
    return '';
}

// Canonical, display-ready metadata derived from the structured identity. Never
// invents values — every field is either present in the identity or empty.
function deriveMetadata(value) {
    const id = identityRecord(value);
    const face = id.face && typeof id.face === 'object' ? id.face : {};
    const eyes = id.eyes && typeof id.eyes === 'object' ? id.eyes : {};
    const hair = id.hair && typeof id.hair === 'object' ? id.hair : {};
    const skin = id.skin && typeof id.skin === 'object' ? id.skin : {};
    const hairStyle = hair.style || id.hairStyle || '';
    const distinctive = uniqueStrings([id.distinctiveFeature].concat(toArray(id.distinctiveFeatures)));
    const eyeText = [eyes.color || id.eyeColor || '', eyes.shape || id.eyeShape || ''].filter(Boolean).join(' ');
    const metadata = {
        face: {
            shape: face.shape || id.faceShape || '',
            eyes: eyeText,
            nose: face.nose || id.nose || '',
            lips: face.lips || id.lips || '',
            distinctiveTraits: []
        },
        hair: {
            color: hair.color || id.hairColor || '',
            length: hairLengthFromStyle(hairStyle),
            style: hairStyle,
            texture: hair.texture || id.hairTexture || ''
        },
        skin: {
            tone: skin.tone || id.skinTone || '',
            undertone: skin.undertone || id.skinUndertone || ''
        },
        body: {
            heightDescription: id.height || '',
            build: id.build || '',
            proportions: id.proportions || ''
        },
        distinctiveFeatures: distinctive,
        signatureAccessories: inferAccessories(id)
    };
    metadata.identityPreservationInstructions = identityPreservationInstructions(metadata);
    return metadata;
}

// A compact natural-language identity summary reused in prompts and UI.
function summary(metadata) {
    const m = metadata || {};
    const parts = [];
    const face = m.face || {};
    const hair = m.hair || {};
    const skin = m.skin || {};
    const body = m.body || {};
    if (skin.tone) parts.push(skin.tone + ' skin');
    if (face.shape) parts.push(face.shape);
    if (face.eyes) parts.push(face.eyes);
    const hairBits = [hair.length, hair.style, hair.texture, hair.color, 'hair'].filter(Boolean);
    if (hairBits.length) parts.push(hairBits.join(' '));
    if (body.build) parts.push(body.build);
    if (m.distinctiveFeatures && m.distinctiveFeatures.length) parts.push(m.distinctiveFeatures.join(', '));
    if (m.signatureAccessories && m.signatureAccessories.length) parts.push(m.signatureAccessories.join(', '));
    return parts.filter(Boolean).join(', ');
}

function identityPreservationInstructions(metadata) {
    const summaryText = summary(metadata);
    return 'Preserve the exact same character as the identity reference' +
        (summaryText ? ' (' + summaryText + ')' : '') +
        ': identical facial identity and facial structure, identical hairstyle, hair colour and hairline, ' +
        'identical skin tone, identical body proportions and the same distinctive features. ' +
        'Do not redesign the character, change the face, or add accessories that are not already present.';
}

// --- Package shape ------------------------------------------------------------

function makeId(prefix) {
    return (prefix || 'ref') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function baseImageFrom(value, options = {}) {
    const src = value && typeof value === 'object' ? value : {};
    const filename = String(src.filename || src.rawFilename || (src.url ? basenameOf(src.url) : '') || '');
    return {
        url: String(src.url || (filename ? '/generated/' + encodeURIComponent(filename) : '')),
        filename,
        generationId: String(src.generationId || ''),
        width: Number(src.width) > 0 ? Number(src.width) : null,
        height: Number(src.height) > 0 ? Number(src.height) : null,
        seed: Number.isFinite(Number(src.seed)) ? Number(src.seed) : null,
        prompt: String(src.prompt || ''),
        createdAt: src.createdAt || new Date().toISOString(),
        approvedAt: options.approved === true ? (src.approvedAt || new Date().toISOString()) : (src.approvedAt || null)
    };
}

function sheetImageFrom(value) {
    const src = value && typeof value === 'object' ? value : {};
    const filename = String(src.filename || src.rawFilename || (src.url || src.imageUrl ? basenameOf(src.url || src.imageUrl) : '') || '');
    return {
        imageUrl: String(src.imageUrl || src.url || (filename ? '/generated/' + encodeURIComponent(filename) : '')),
        filename,
        version: Number(src.version) > 0 ? Number(src.version) : IDENTITY_SHEET_VERSION,
        status: normalizedSheetStatus(src.status),
        error: String(src.error || ''),
        prompt: String(src.prompt || ''),
        seed: Number.isFinite(Number(src.seed)) ? Number(src.seed) : null,
        width: Number(src.width) > 0 ? Number(src.width) : null,
        height: Number(src.height) > 0 ? Number(src.height) : null,
        createdAt: src.createdAt || null,
        generatedAt: src.generatedAt || null
    };
}

function normalizeMetadata(value) {
    const src = value && typeof value === 'object' ? value : {};
    const face = src.face && typeof src.face === 'object' ? src.face : {};
    const hair = src.hair && typeof src.hair === 'object' ? src.hair : {};
    const skin = src.skin && typeof src.skin === 'object' ? src.skin : {};
    const body = src.body && typeof src.body === 'object' ? src.body : {};
    const out = {
        face: {
            shape: String(face.shape || ''),
            eyes: String(face.eyes || ''),
            nose: String(face.nose || ''),
            lips: String(face.lips || ''),
            distinctiveTraits: toArray(face.distinctiveTraits)
        },
        hair: {
            color: String(hair.color || ''),
            length: String(hair.length || ''),
            style: String(hair.style || ''),
            texture: String(hair.texture || '')
        },
        skin: {
            tone: String(skin.tone || ''),
            undertone: String(skin.undertone || '')
        },
        body: {
            heightDescription: String(body.heightDescription || ''),
            build: String(body.build || ''),
            proportions: String(body.proportions || '')
        },
        distinctiveFeatures: toArray(src.distinctiveFeatures),
        signatureAccessories: toArray(src.signatureAccessories)
    };
    out.identityPreservationInstructions = String(src.identityPreservationInstructions || '') ||
        identityPreservationInstructions(out);
    return out;
}

// Derive the canonical package status from the base image and sheet state.
function statusOf(pkg) {
    const sheet = pkg && pkg.identitySheet;
    if (sheet && sheet.status === SHEET_STATUS.READY) return STATUS.READY;
    if (sheet && sheet.status === SHEET_STATUS.GENERATING) return STATUS.GENERATING;
    if (sheet && sheet.status === SHEET_STATUS.FAILED) return STATUS.FAILED;
    if (pkg && pkg.approvedBaseImage) return pkg.approvedBaseImage.approvedAt ? STATUS.APPROVED : STATUS.CANDIDATE;
    return STATUS.CANDIDATE;
}

// Coerce a stored character record (or a package object) into the canonical
// package shape. Never invents identity data.
function normalizePackage(value, options = {}) {
    const src = value && typeof value === 'object' ? value : {};
    const hasBase = Boolean(src.approvedBaseImage && (src.approvedBaseImage.filename || src.approvedBaseImage.url));
    const sheetSrc = src.identitySheet && typeof src.identitySheet === 'object' ? src.identitySheet : null;
    const hasSheet = Boolean(sheetSrc && (sheetSrc.filename || sheetSrc.imageUrl));
    const metadata = src.identityMetadata && typeof src.identityMetadata === 'object' && Object.keys(src.identityMetadata).length
        ? normalizeMetadata(src.identityMetadata)
        : deriveMetadata(src);
    const pkg = {
        schemaVersion: CHARACTER_IDENTITY_SCHEMA_VERSION,
        approvedBaseImage: hasBase ? baseImageFrom(src.approvedBaseImage, { approved: Boolean(src.approvedBaseImage.approvedAt) }) : null,
        identitySheet: hasSheet ? sheetImageFrom(sheetSrc) : null,
        identityMetadata: metadata,
        identityPreservationInstructions: String(src.identityPreservationInstructions || '') || metadata.identityPreservationInstructions,
        source: src.source && typeof src.source === 'object' ? {
            type: src.source.type || 'character-playground',
            configuration: src.source.configuration || {},
            originalPrompt: src.source.originalPrompt || '',
            approvedAt: src.source.approvedAt || null
        } : { type: 'character-playground', configuration: {}, originalPrompt: '', approvedAt: null },
        error: String(src.error || ''),
        createdAt: src.createdAt || null,
        updatedAt: src.updatedAt || null,
        progress: src.progress && typeof src.progress === 'object' ? {
            done: Number(src.progress.done) || 0,
            total: Number(src.progress.total) || 0,
            current: String(src.progress.current || '')
        } : { done: 0, total: 0, current: '' },
        generationHistory: Array.isArray(src.generationHistory) ? src.generationHistory.slice(-50) : []
    };
    // The lifecycle is always derived from the base image + sheet state, so a
    // stale stored status can never contradict the actual assets.
    pkg.status = statusOf(pkg);
    return pkg;
}

// A candidate package created before approval. Base image only, no sheet.
function createPackage({ baseImage, character, configuration, originalPrompt }) {
    const pkg = normalizePackage({
        status: STATUS.CANDIDATE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvedBaseImage: Object.assign({}, baseImage, { approvedAt: null }),
        identityMetadata: deriveMetadata(character),
        source: {
            type: 'character-playground',
            configuration: configuration || {},
            originalPrompt: originalPrompt || '',
            approvedAt: null
        },
        progress: { done: 0, total: 0, current: '' }
    }, { characterId: character && character.id });
    pkg.identitySheet = null;
    pkg.status = STATUS.CANDIDATE;
    return pkg;
}

function setCandidateBase(pkg, image) {
    const next = normalizePackage(pkg);
    next.approvedBaseImage = baseImageFrom(Object.assign({}, next.approvedBaseImage, image), { approved: false });
    next.approvedBaseImage.approvedAt = null;
    next.status = (next.identitySheet && next.identitySheet.status === SHEET_STATUS.READY) ? STATUS.READY : STATUS.CANDIDATE;
    next.updatedAt = new Date().toISOString();
    return next;
}

// Approve the current (candidate) base image. Idempotent for an already
// approved base.
function approveBase(pkg) {
    const next = normalizePackage(pkg);
    if (!next.approvedBaseImage || (!next.approvedBaseImage.filename && !next.approvedBaseImage.url)) return next;
    next.approvedBaseImage.approvedAt = next.approvedBaseImage.approvedAt || new Date().toISOString();
    next.source.approvedAt = next.source.approvedAt || next.approvedBaseImage.approvedAt;
    next.updatedAt = new Date().toISOString();
    if (!(next.identitySheet && next.identitySheet.status === SHEET_STATUS.READY)) next.status = STATUS.APPROVED;
    return next;
}

function markSheetGenerating(pkg) {
    const next = normalizePackage(pkg);
    next.error = '';
    next.status = STATUS.GENERATING;
    if (next.identitySheet && (next.identitySheet.status === SHEET_STATUS.READY || next.identitySheet.status === SHEET_STATUS.FAILED)) {
        // Regeneration: the previous sheet stays visible while the new one is
        // being created.
        next.identitySheet = Object.assign({}, next.identitySheet, { status: SHEET_STATUS.GENERATING, error: '' });
    } else {
        next.identitySheet = {
            imageUrl: '', filename: '', version: IDENTITY_SHEET_VERSION,
            status: SHEET_STATUS.GENERATING, error: '', prompt: '', seed: null,
            width: null, height: null, createdAt: new Date().toISOString(), generatedAt: null
        };
    }
    next.progress = { done: 0, total: 1, current: 'identity-sheet' };
    next.updatedAt = new Date().toISOString();
    return next;
}

function applySheet(pkg, image) {
    const next = normalizePackage(pkg);
    const previousVersion = next.identitySheet && Number(next.identitySheet.version) > 0 ? Number(next.identitySheet.version) : 0;
    const hadSheet = Boolean(next.identitySheet && next.identitySheet.filename);
    next.identitySheet = sheetImageFrom(Object.assign({}, image, {
        version: (hadSheet ? previousVersion : 0) + 1,
        status: SHEET_STATUS.READY,
        createdAt: (next.identitySheet && next.identitySheet.createdAt) || new Date().toISOString(),
        generatedAt: new Date().toISOString()
    }));
    next.identitySheet.error = '';
    next.status = STATUS.READY;
    next.error = '';
    next.progress = { done: 1, total: 1, current: '' };
    next.updatedAt = next.identitySheet.generatedAt;
    next.generationHistory = (next.generationHistory || []).concat([{
        filename: next.identitySheet.filename,
        version: next.identitySheet.version,
        createdAt: next.identitySheet.generatedAt
    }]).slice(-50);
    return next;
}

// A failed generation never overwrites a valid sheet. When a ready sheet
// already exists it is kept and the failure is only recorded.
function markSheetFailed(pkg, error, previous) {
    const prev = previous ? normalizePackage(previous, {}) : null;
    const next = normalizePackage(pkg);
    const message = (error && error.message) || String(error || 'unknown error');
    if (prev && prev.identitySheet && prev.identitySheet.status === SHEET_STATUS.READY && prev.identitySheet.filename) {
        next.identitySheet = Object.assign({}, prev.identitySheet, { status: SHEET_STATUS.READY });
        next.status = STATUS.READY;
        next.error = 'Identity sheet regeneration failed; the previous sheet was kept. (' + message + ')';
        next.progress = { done: prev.progress ? prev.progress.done : 1, total: 1, current: '' };
        next.updatedAt = new Date().toISOString();
        return next;
    }
    next.identitySheet = Object.assign({}, next.identitySheet || {}, {
        status: SHEET_STATUS.FAILED,
        error: message
    });
    next.status = STATUS.FAILED;
    next.error = message;
    next.progress = { done: 0, total: 1, current: '' };
    next.updatedAt = new Date().toISOString();
    return next;
}

// Every generated media filename the package owns (the approved base image plus
// the single identity sheet), de-duplicated.
function mediaFilenames(value) {
    const pkg = normalizePackage(value);
    const names = [];
    if (pkg.approvedBaseImage && pkg.approvedBaseImage.filename) names.push(pkg.approvedBaseImage.filename);
    if (pkg.identitySheet && pkg.identitySheet.filename) names.push(pkg.identitySheet.filename);
    return uniqueStrings(names);
}

// --- Reference selection for generation ---------------------------------------

// The single visual identity reference a character contributes to generation:
// the consolidated identity sheet when ready, otherwise the approved base
// image. NEVER an array of angle views.
function selectIdentityImage(value) {
    const pkg = normalizePackage(value);
    if (pkg.identitySheet && pkg.identitySheet.status === SHEET_STATUS.READY && pkg.identitySheet.filename) {
        return {
            kind: 'identity_sheet',
            filename: pkg.identitySheet.filename,
            url: pkg.identitySheet.imageUrl,
            width: pkg.identitySheet.width,
            height: pkg.identitySheet.height
        };
    }
    if (pkg.approvedBaseImage && pkg.approvedBaseImage.filename) {
        return {
            kind: 'approved_base',
            filename: pkg.approvedBaseImage.filename,
            url: pkg.approvedBaseImage.url,
            width: pkg.approvedBaseImage.width,
            height: pkg.approvedBaseImage.height
        };
    }
    return null;
}

// --- Prompt layer -------------------------------------------------------------

// The composite identity-sheet prompt. One image containing the reference
// panels; it must preserve the approved base identity and stay a neutral
// reference document, never a creative scene.
function buildIdentitySheetPrompt(character) {
    const metadata = deriveMetadata(character);
    const clauses = [
        'Create a single character identity reference sheet of the same person shown in image 1.',
        identityPreservationInstructions(metadata),
        'Render ONE image laid out as a clean grid of clearly separated reference panels on a plain neutral light-grey seamless studio background with soft, even, consistent lighting.',
        'Panel 1 (top left): full-body front view, standing straight and facing the camera, neutral relaxed pose with arms at the sides, full body visible from head to toe.',
        'Panel 2 (top right): full-body three-quarter view, body turned about 45 degrees to the side, face still angled toward the camera, full body visible.',
        'Panel 3 (bottom left): full-body side profile view, standing upright in a pure side view, full body visible.',
        'Panel 4 (bottom right): close-up head-and-shoulders face view, front facing, neutral expression, sharp focus on the facial structure, eyes, nose, lips, jawline and hairline.'
    ];
    const accessories = metadata.signatureAccessories || [];
    const features = metadata.distinctiveFeatures || [];
    const hair = metadata.hair || {};
    if (accessories.length) {
        clauses.push('Add one small detail panel clearly framing the character\'s signature accessory: ' + accessories.join(', ') + '.');
    }
    if (features.length) {
        clauses.push('Add one small detail panel clearly framing this distinctive feature: ' + features.join(', ') + '.');
    } else if (hair.style && /\b(?:braid|locs|dreadlocks|afro|pixie|bob|lob|ponytail|bun|twists|undercut|fade|bangs|fringe|shag|updo)\b/i.test(hair.style)) {
        clauses.push('Add one small detail panel clearly framing the hairstyle.');
    }
    clauses.push('Every panel shows the exact same person, the same simple plain neutral studio clothing, the same skin tone, hair and body proportions.');
    clauses.push('This is a visual identity reference document, not a creative scene: no dramatic cinematic composition, no environmental storytelling, no props, no text, no labels, no complex poses that obscure the face or anatomy.');
    return clauses.join(' ');
}

// The identity constraints appended to a generation prompt (metadata only, no
// scene wording). Permanent identity only.
function buildIdentityConstraints(value) {
    const metadata = normalizePackage(value).identityMetadata || {};
    const constraints = [
        'Preserve the approved character\'s facial identity, hairstyle, skin tone, body proportions and distinctive features'
        + (summary(metadata) ? ': ' + summary(metadata) : '')
    ];
    if (metadata.signatureAccessories && metadata.signatureAccessories.length) {
        constraints.push('Keep the character\'s signature accessories: ' + metadata.signatureAccessories.join(', '));
    }
    constraints.push('Do not redesign the character or change their facial structure or hairstyle');
    return constraints;
}

// Compose the single-character reference-guided instruction used by the Qwen
// editor: image 1 is an identity reference (the consolidated identity sheet or
// the approved base image), and the output is a NEW standalone scene image.
// The reference is never the requested output and is never modified.
function buildSceneEditInstruction(value, scenePrompt, name) {
    const metadata = normalizePackage(value).identityMetadata || {};
    const summaryText = summary(metadata);
    const label = name || 'the character';
    const identity = 'IDENTITY: Keep the exact same approved person shown in image 1' +
        (summaryText ? ' (' + summaryText + ')' : '') +
        '. Image 1 is ' + label + '\'s character identity reference; use it only to preserve their facial identity, ' +
        'face shape, eyes, nose, lips, skin tone, hair colour and length, body proportions and distinctive features. ' +
        'It is reference material, not the requested image.';
    const output = 'OUTPUT: Generate ONE new standalone scene image of ' + label + ' in the requested scene. ' +
        'Never return the identity reference itself, a modified or recreated version of it, a collage, a contact ' +
        'sheet, a multi-panel reference sheet, a character turnaround, or a collection of character views. ' +
        'Do not copy its panel layout, camera angles, framing, background, pose, lighting, composition, text, ' +
        'borders or labels into the new image. Unless the user explicitly asks for a character sheet or ' +
        'turnaround, the output is a single conventional frame.';
    const scene = 'SCENE (change only this): ' + String(scenePrompt || '').trim();
    const dont = 'DO NOT: redesign the character, change facial structure, change the hairstyle unnecessarily, ' +
        'or introduce new accessories unless the scene explicitly asks for them.';
    return identity + ' ' + output + ' ' + scene + ' ' + dont;
}

// The structured context one character contributes to downstream generation.
function buildCharacterContextEntry(character) {
    if (!character) return null;
    const pkg = normalizePackage(character);
    const image = selectIdentityImage(pkg);
    if (!image) return null;
    return {
        id: character.id,
        name: character.name || 'Character',
        approvedBaseImage: pkg.approvedBaseImage ? pkg.approvedBaseImage.filename : '',
        identitySheetImage: pkg.identitySheet && pkg.identitySheet.status === SHEET_STATUS.READY
            ? pkg.identitySheet.filename
            : '',
        identityImage: image.filename,
        identityImageKind: image.kind,
        identityMetadata: pkg.identityMetadata,
        identityPreservationInstructions: pkg.identityPreservationInstructions
    };
}

// --- Generation orchestration -------------------------------------------------

// Pure orchestration: the caller injects `generate` (the existing image
// generator's edit call) and `resolveAbs` (a filename -> absolute path
// resolver), plus an `onProgress` persistence hook. The result is exactly one
// identity-sheet image. A failed regeneration never destroys the previous
// valid sheet or the approved base image.
async function generateSheet(options = {}) {
    const character = options.character || {};
    const generate = options.generate;
    const resolveAbs = typeof options.resolveAbs === 'function' ? options.resolveAbs : (name) => name;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const logger = options.logger || console;
    if (typeof generate !== 'function') {
        throw new Error('Character identity sheet generation requires a generator.');
    }

    let pkg = normalizePackage(options.package || character);
    const previous = options.previousSheet ? normalizePackage(options.previousSheet) : null;
    const base = pkg.approvedBaseImage;
    if (!base || !base.filename) {
        pkg = markSheetFailed(pkg, new Error('The approved base image is missing.'), null);
        return pkg;
    }
    if (!base.approvedAt) {
        pkg = markSheetFailed(pkg, new Error('The character base image has not been approved yet.'), null);
        return pkg;
    }
    const baseAbs = resolveAbs(base.filename);
    const prompt = buildIdentitySheetPrompt(character);

    pkg = markSheetGenerating(pkg);
    await onProgress(pkg);

    try {
        const result = await generate(baseAbs, prompt, {
            references: [],
            conversationId: options.conversationId,
            label: 'character identity sheet',
            kind: 'image_generation',
            // The identity sheet is internal media for the character package,
            // not a gallery item.
            hidden: true
        });
        const filename = String(result.filename || basenameOf(result.url) || '');
        pkg = applySheet(pkg, {
            url: result.url || ('/generated/' + encodeURIComponent(filename)),
            filename,
            prompt,
            seed: result.seed,
            width: result.width,
            height: result.height
        });
    } catch (err) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('[character-identity] identity sheet generation failed: ' + (err && err.message));
        }
        pkg = markSheetFailed(pkg, err, previous);
    }
    await onProgress(pkg);
    return pkg;
}

// --- UI card ------------------------------------------------------------------

// Build a read-only card the UI renders. Never exposes filesystem paths.
function buildCard(character) {
    if (!character) return null;
    const pkg = normalizePackage(character);
    const base = pkg.approvedBaseImage;
    const sheet = pkg.identitySheet;
    return {
        characterId: character.id,
        name: character.name || 'Character',
        description: character.description || character.identityText || summary(pkg.identityMetadata),
        status: pkg.status,
        sheetStatus: sheet ? sheet.status : SHEET_STATUS.NOT_STARTED,
        error: pkg.error || (sheet && sheet.error) || '',
        approvedBaseImage: base ? {
            url: base.url,
            filename: base.filename,
            approved: Boolean(base.approvedAt),
            approvedAt: base.approvedAt,
            width: base.width,
            height: base.height,
            seed: base.seed
        } : null,
        identitySheet: sheet && sheet.filename ? {
            url: sheet.imageUrl,
            filename: sheet.filename,
            version: sheet.version,
            status: sheet.status,
            error: sheet.error || '',
            width: sheet.width,
            height: sheet.height,
            createdAt: sheet.createdAt,
            generatedAt: sheet.generatedAt
        } : null,
        identityMetadata: pkg.identityMetadata,
        identityPreservationInstructions: pkg.identityPreservationInstructions,
        progress: pkg.progress,
        createdAt: character.createdAt || pkg.createdAt,
        updatedAt: character.updatedAt || pkg.updatedAt
    };
}

module.exports = {
    CHARACTER_IDENTITY_SCHEMA_VERSION,
    STATUS,
    SHEET_STATUS,
    IDENTITY_SHEET_VERSION,
    // pure model
    deriveMetadata,
    summary,
    metadataSummary: summary,
    identityPreservationInstructions,
    inferAccessories,
    normalizeMetadata,
    normalizePackage,
    createPackage,
    setCandidateBase,
    approveBase,
    markSheetGenerating,
    applySheet,
    markSheetFailed,
    statusOf,
    mediaFilenames,
    // reference selection / prompts
    selectIdentityImage,
    buildIdentitySheetPrompt,
    buildIdentityConstraints,
    buildSceneEditInstruction,
    buildCharacterContextEntry,
    // UI
    buildCard,
    // orchestration
    generateSheet
};
