/* ============================================
   JARVIS — Character Identity System
   Turns an approved character into a reusable
   identity package: a locked base image plus a
   Character Identity Sheet of role-tagged reference
   images (full-body turnaround, face angles and
   conditional accessory / distinctive-feature
   details) and structured identity metadata.

   This module owns the package lifecycle and the
   reference plan. It never builds the final Krea2
   prompt and never talks to ComfyUI directly: the
   caller injects the existing image generator, so
   the identity sheet reuses the Qwen Image 2.1 edit
   pipeline (approved base image as the source).

   Identity improves consistency but cannot guarantee
   identical facial reproduction — the system is
   reference-guided, not face-locked.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const path = require('path');
const characterModel = require('./playground/character');

const CHARACTER_IDENTITY_SCHEMA_VERSION = 1;

// Package-level lifecycle (stored on the character preset).
const STATUS = {
    CANDIDATE: 'candidate',
    APPROVED: 'approved',
    GENERATING: 'generating_identity',
    READY: 'ready',
    FAILED: 'failed'
};

// Identity-sheet lifecycle (stored under identitySheet.identity.status).
const SHEET_STATUS = {
    NOT_STARTED: 'not_started',
    GENERATING: 'generating',
    READY: 'ready',
    FAILED: 'failed'
};

// The fixed reference categories an identity sheet can contain. Each entry is
// the primary storage bucket for a role (no reference is stored twice).
const CATEGORY = {
    FULL_BODY: 'fullBody',
    FACE: 'face',
    PROFILE: 'profile',
    ACCESSORIES: 'accessories',
    DISTINCTIVE: 'distinctiveFeatures'
};

const EMPTY_REFERENCES = () => ({
    fullBody: [],
    face: [],
    profile: [],
    accessories: [],
    distinctiveFeatures: []
});

// --- Reference plan -----------------------------------------------------------
//
// A plan is deterministic for a character: the required roles are always the
// same seven views; accessory / distinctive-feature / hair details are added
// only when the identity actually carries that detail, so a plain character
// never pays for reference images it does not need.

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

// Hair colours/styles that read as a signature look worth a dedicated detail.
const DISTINCTIVE_HAIR_COLORS = /\b(?:teal|lavender|pink|rose gold|burgundy|cherry|platinum|blue|green|purple|violet|mermaid|ombre|balayage)\b/i;
const DISTINCTIVE_HAIR_STYLES = /\b(?:braid|locs|dreadlocks|afro|pixie|bob|lob|ponytail|bun|chignon|twists|undercut|fade|bangs|fringe|shag|hime|updo)\b/i;

function toArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

function identityOf(character) {
    if (!character) return null;
    if (character.identity && typeof character.identity === 'object') return character.identity;
    return characterModel.canonicalIdentity(character.identity, character);
}

function inferAccessories(identity) {
    if (!identity) return [];
    const explicit = toArray(identity.accessories || identity.signatureAccessories);
    const text = [identity.distinctiveFeature, identity.distinctiveFeatures].flat().filter(Boolean).join(' ');
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
function deriveMetadata(identity) {
    const id = identity || {};
    const hair = id.hair && typeof id.hair === 'object' ? id.hair : {};
    const skin = id.skin && typeof id.skin === 'object' ? id.skin : {};
    const face = id.face && typeof id.face === 'object' ? id.face : {};
    const eyes = id.eyes && typeof id.eyes === 'object' ? id.eyes : {};
    const hairStyle = hair.style || id.hairStyle || '';
    const distinctive = [id.distinctiveFeature].concat(toArray(id.distinctiveFeatures)).filter(Boolean);
    return {
        ageRange: id.age || '',
        genderPresentation: id.gender || id.presentation || '',
        skinTone: skin.tone || id.skinTone || '',
        faceShape: face.shape || id.faceShape || '',
        eyeColor: eyes.color || id.eyeColor || '',
        hair: {
            color: hair.color || id.hairColor || '',
            length: hairLengthFromStyle(hairStyle),
            style: hairStyle
        },
        bodyProportions: id.build || '',
        distinctiveFeatures: Array.from(new Set(distinctive)),
        signatureAccessories: inferAccessories(id)
    };
}

// A compact natural-language identity summary reused in prompts and UI.
function metadataSummary(metadata) {
    const m = metadata || {};
    const parts = [];
    if (m.ageRange) parts.push(m.ageRange);
    if (m.genderPresentation) parts.push(m.genderPresentation);
    if (m.skinTone) parts.push(m.skinTone + ' skin');
    if (m.faceShape) parts.push(m.faceShape);
    if (m.eyeColor) parts.push(m.eyeColor + ' eyes');
    const hair = m.hair || {};
    const hairBits = [hair.length, hair.style, hair.color, 'hair'].filter(Boolean);
    if (hairBits.length) parts.push(hairBits.join(' '));
    if (m.bodyProportions) parts.push(m.bodyProportions);
    if (m.distinctiveFeatures && m.distinctiveFeatures.length) parts.push(m.distinctiveFeatures.join(', '));
    if (m.signatureAccessories && m.signatureAccessories.length) parts.push(m.signatureAccessories.join(', '));
    return parts.filter(Boolean).join(', ');
}

function hasDistinctiveHair(identity) {
    const hairStyle = (identity && (identity.hairStyle || (identity.hair && identity.hair.style))) || '';
    const hairColor = (identity && (identity.hairColor || (identity.hair && identity.hair.color))) || '';
    const styleType = identity && identity.hairStyleType;
    return styleType === 'noun' || DISTINCTIVE_HAIR_STYLES.test(hairStyle) || DISTINCTIVE_HAIR_COLORS.test(hairColor);
}

function makePlanEntry(role, label, category, instruction, options = {}) {
    return {
        role,
        label,
        category,
        instruction,
        required: options.required !== false,
        dependsOn: Array.isArray(options.dependsOn) ? options.dependsOn.slice() : []
    };
}

const IDENTITY_CLAUSE = 'Keep the exact same person as image 1: identical face and facial structure, ' +
    'identical hairstyle, hair colour and hairline, identical skin tone, identical body proportions and ' +
    'the same distinctive features. Do not redesign the character, do not change the face, and do not add ' +
    'accessories that are not already present.';

// Build the ordered reference plan for a character. Pure and deterministic.
function planReferences(character) {
    const identity = identityOf(character);
    const metadata = deriveMetadata(identity);
    const plan = [
        makePlanEntry('full_body_front', 'Full body — front', CATEGORY.FULL_BODY,
            'Show the same person in a full-body front view, standing straight and facing the camera, ' +
            'neutral relaxed pose with arms at the sides, full body visible from head to toe. ' +
            'Simple plain neutral studio clothing, plain light grey seamless studio background, soft even lighting.'),
        makePlanEntry('full_body_three_quarter', 'Full body — three-quarter', CATEGORY.FULL_BODY,
            'Show the same person in a full-body three-quarter view, body turned about 45 degrees to the side, ' +
            'face still angled toward the camera, full body visible head to toe. Neutral studio presentation, ' +
            'plain light grey seamless background.',
            { dependsOn: ['full_body_front'] }),
        makePlanEntry('full_body_side', 'Full body — side profile', CATEGORY.FULL_BODY,
            'Show the same person in a full-body side profile view, standing upright in a pure side view, ' +
            'full body visible head to toe. Neutral studio presentation, plain light grey seamless background.',
            { dependsOn: ['full_body_front'] }),
        makePlanEntry('full_body_back', 'Full body — back', CATEGORY.FULL_BODY,
            'Show the same person in a full-body back view, standing upright facing away from the camera, ' +
            'full body visible head to toe. Neutral studio presentation, plain light grey seamless background.',
            { dependsOn: ['full_body_front'] }),
        makePlanEntry('face_front', 'Face — front', CATEGORY.FACE,
            'Show a close-up head-and-shoulders portrait of the same person facing the camera directly with a ' +
            'neutral relaxed expression. Focus on the facial structure, eyes, nose, lips, jawline, hairline and ' +
            'skin tone. Plain neutral studio background, soft even lighting, sharp focus on the face.'),
        makePlanEntry('face_three_quarter', 'Face — three-quarter', CATEGORY.FACE,
            'Show a close-up head-and-shoulders portrait of the same person turned about 45 degrees to the side, ' +
            'face still toward the camera. Focus on the facial structure, eyes, nose, lips and jawline. ' +
            'Plain neutral studio background, soft even lighting.',
            { dependsOn: ['face_front'] }),
        makePlanEntry('face_profile', 'Face — side profile', CATEGORY.PROFILE,
            'Show a close-up side profile portrait of the same person, pure side view. Focus on the profile of ' +
            'the face, nose, lips, jawline and hairline. Plain neutral studio background, soft even lighting.',
            { dependsOn: ['face_front'] })
    ];

    if (metadata.signatureAccessories.length) {
        plan.push(makePlanEntry('accessory_detail', 'Accessory — ' + metadata.signatureAccessories[0], CATEGORY.ACCESSORIES,
            'Show a close-up detail of the same person wearing their ' + metadata.signatureAccessories[0] +
            '. Keep the person and everything else identical; only frame the accessory clearly. ' +
            'Neutral studio background, soft even lighting.'));
    }
    if (metadata.distinctiveFeatures.length) {
        plan.push(makePlanEntry('distinctive_feature_detail', 'Distinctive feature', CATEGORY.DISTINCTIVE,
            'Show a close-up detail of the same person highlighting this distinctive feature: ' +
            metadata.distinctiveFeatures.join(', ') + '. Keep the person identical; only frame the feature clearly. ' +
            'Neutral studio background, soft even lighting.'));
    }
    if (hasDistinctiveHair(identity)) {
        plan.push(makePlanEntry('hair_detail', 'Hair detail', CATEGORY.DISTINCTIVE,
            'Show a close-up detail of the same person\'s hairstyle: ' + [metadata.hair.style, metadata.hair.color].filter(Boolean).join(', ') +
            '. Keep the person identical; only frame the hair clearly. Neutral studio background, soft even lighting.'));
    }

    return plan.map((entry) => Object.assign({}, entry, {
        instruction: IDENTITY_CLAUSE + ' ' + entry.instruction
    }));
}

// --- Identity sheet shape -----------------------------------------------------

function makeId(prefix) {
    return (prefix || 'ref') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function baseImageFrom(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        url: String(src.url || ''),
        filename: String(src.filename || src.rawFilename || ''),
        generationId: String(src.generationId || ''),
        approved: src.approved === true,
        width: Number(src.width) > 0 ? Number(src.width) : null,
        height: Number(src.height) > 0 ? Number(src.height) : null,
        seed: Number.isFinite(Number(src.seed)) ? Number(src.seed) : null,
        prompt: String(src.prompt || ''),
        createdAt: src.createdAt || null,
        approvedAt: src.approvedAt || null
    };
}

function normalizeReference(value, characterId) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        id: String(src.id || makeId('ref')),
        characterId: String(src.characterId || characterId || ''),
        role: String(src.role || '').trim(),
        label: String(src.label || '').trim(),
        imageUrl: String(src.imageUrl || src.url || ''),
        imagePath: String(src.imagePath || src.filename || ''),
        prompt: String(src.prompt || ''),
        sourceBaseImage: String(src.sourceBaseImage || ''),
        createdAt: src.createdAt || new Date().toISOString(),
        approved: src.approved === true
    };
}

function normalizeReferences(value, characterId) {
    const src = value && typeof value === 'object' ? value : {};
    const out = EMPTY_REFERENCES();
    for (const key of Object.keys(out)) {
        out[key] = toArrayRaw(src[key]).map((r) => normalizeReference(r, characterId)).filter((r) => r.imageUrl || r.imagePath);
    }
    return out;
}

function toArrayRaw(value) {
    return Array.isArray(value) ? value : [];
}

// Coerce any stored/legacy value into the canonical identity sheet shape.
function normalizeSheet(value, options = {}) {
    const src = value && typeof value === 'object' ? value : {};
    const identity = src.identity && typeof src.identity === 'object' ? src.identity : {};
    const status = Object.values(STATUS).includes(src.status) ? src.status : STATUS.CANDIDATE;
    const sheetStatus = Object.values(SHEET_STATUS).includes(identity.status) ? identity.status : SHEET_STATUS.NOT_STARTED;
    return {
        schemaVersion: CHARACTER_IDENTITY_SCHEMA_VERSION,
        status,
        error: String(src.error || ''),
        createdAt: src.createdAt || null,
        updatedAt: src.updatedAt || null,
        source: {
            type: (src.source && src.source.type) || 'character-playground',
            configuration: (src.source && src.source.configuration) || {},
            originalPrompt: (src.source && src.source.originalPrompt) || '',
            approvedAt: (src.source && src.source.approvedAt) || null
        },
        baseImage: baseImageFrom(src.baseImage),
        identity: {
            status: sheetStatus,
            metadata: identity.metadata && typeof identity.metadata === 'object' ? identity.metadata : {},
            references: normalizeReferences(identity.references, options.characterId),
            identityPrompt: String(identity.identityPrompt || src.identityPrompt || ''),
            consistencyNotes: toArray(identity.consistencyNotes),
            generatedAt: identity.generatedAt || null,
            error: String(identity.error || '')
        },
        outfitPack: src.outfitPack || null,
        generationHistory: Array.isArray(src.generationHistory) ? src.generationHistory.slice(-50) : [],
        approvedReferences: Array.isArray(src.approvedReferences) ? src.approvedReferences.slice() : [],
        progress: src.progress && typeof src.progress === 'object' ? {
            done: Number(src.progress.done) || 0,
            total: Number(src.progress.total) || 0,
            current: String(src.progress.current || '')
        } : { done: 0, total: 0, current: '' }
    };
}

// A candidate package created before approval. Base image only, no sheet yet.
function createSheet({ baseImage, character, configuration, originalPrompt }) {
    const identity = identityOf(character);
    const sheet = normalizeSheet({
        status: STATUS.CANDIDATE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: {
            type: 'character-playground',
            configuration: configuration || {},
            originalPrompt: originalPrompt || '',
            approvedAt: null
        },
        baseImage: Object.assign({}, baseImage, { approved: false }),
        identity: {
            status: SHEET_STATUS.NOT_STARTED,
            metadata: deriveMetadata(identity),
            references: EMPTY_REFERENCES(),
            identityPrompt: '',
            consistencyNotes: [],
            generatedAt: null
        },
        progress: { done: 0, total: 0, current: '' }
    }, { characterId: character && character.id });
    return sheet;
}

function applyBaseImage(sheet, image, { approved } = {}) {
    const next = normalizeSheet(sheet);
    next.baseImage = baseImageFrom(Object.assign({}, next.baseImage, image, {
        approved: approved === undefined ? next.baseImage.approved : approved === true,
        approvedAt: approved === true ? new Date().toISOString() : next.baseImage.approvedAt
    }));
    next.updatedAt = new Date().toISOString();
    return next;
}

function markGenerating(sheet, { plan } = {}) {
    const next = normalizeSheet(sheet);
    next.status = STATUS.GENERATING;
    next.error = '';
    next.identity.status = SHEET_STATUS.GENERATING;
    next.identity.error = '';
    next.identity.references = EMPTY_REFERENCES();
    next.identity.generatedAt = null;
    const entries = Array.isArray(plan) ? plan : [];
    next.progress = { done: 0, total: entries.length, current: entries.length ? entries[0].role : '' };
    next.updatedAt = new Date().toISOString();
    return next;
}

function recordReference(sheet, role, category, reference) {
    const next = normalizeSheet(sheet);
    const ref = normalizeReference(reference, reference && reference.characterId);
    const key = Object.values(CATEGORY).includes(category) ? category : CATEGORY.FACE;
    next.identity.references[key] = next.identity.references[key].filter((r) => r.role !== role);
    next.identity.references[key].push(ref);
    next.updatedAt = new Date().toISOString();
    return next;
}

function markReferenceProgress(sheet, { done, total, current } = {}) {
    const next = normalizeSheet(sheet);
    next.progress = {
        done: Number(done) || next.progress.done,
        total: Number(total) || next.progress.total,
        current: current === undefined ? next.progress.current : String(current || '')
    };
    next.updatedAt = new Date().toISOString();
    return next;
}

function completeSheet(sheet, plan) {
    const next = normalizeSheet(sheet);
    const entries = Array.isArray(plan) ? plan : [];
    const required = entries.filter((e) => e.required !== false).map((e) => e.role);
    const present = allReferences(next).map((r) => r.role);
    const missing = required.filter((role) => !present.includes(role));
    next.identity.generatedAt = new Date().toISOString();
    next.updatedAt = next.identity.generatedAt;
    if (!missing.length) {
        // Ready only when every required reference is present. Optional details
        // (accessories/hair/feature) may be absent without blocking readiness.
        next.status = STATUS.READY;
        next.identity.status = SHEET_STATUS.READY;
        next.identity.error = '';
        next.approvedReferences = allReferences(next).map((r) => r.id);
        next.progress = { done: next.progress.done, total: next.progress.total, current: '' };
    } else {
        next.status = STATUS.FAILED;
        next.identity.status = SHEET_STATUS.FAILED;
        next.identity.error = 'Missing required references: ' + missing.join(', ');
        next.identity.consistencyNotes = next.identity.consistencyNotes.concat(
            'Generation did not finish for: ' + missing.join(', ') + '. You can regenerate the sheet.'
        );
    }
    return next;
}

function allReferences(sheet) {
    const refs = normalizeSheet(sheet).identity.references;
    return Object.values(refs).reduce((acc, list) => acc.concat(list), []);
}

// Every generated media filename the package owns (the approved base image plus
// every reference), de-duplicated. Used to clean up the character's files when
// the character or its identity sheet is deleted.
function mediaFilenames(sheet) {
    const s = normalizeSheet(sheet);
    const names = [];
    if (s.baseImage && s.baseImage.filename) names.push(s.baseImage.filename);
    for (const ref of allReferences(s)) {
        if (ref.imagePath) names.push(ref.imagePath);
    }
    return Array.from(new Set(names.filter(Boolean).map((n) => String(n))));
}

// --- Reference selection for generation ---------------------------------------
//
// Pick the strongest relevant references for a request instead of attaching the
// whole sheet. Returns { source, references } where `source` is the base image
// filename (image_1) and `references` are additional filenames (image_2..N).

function findByRole(sheet, role) {
    return allReferences(sheet).find((r) => r.role === role) || null;
}

function filenamesFor(sheet, roles) {
    return roles.map((role) => findByRole(sheet, role))
        .filter(Boolean)
        .map((r) => r.imagePath)
        .filter(Boolean);
}

function baseFilename(sheet) {
    return (normalizeSheet(sheet).baseImage || {}).filename || '';
}

function selectReferencesForRequest(sheet, options = {}) {
    const kind = String(options.kind || inferRequestKind(options)).toLowerCase();
    const base = baseFilename(sheet);
    let roles = [];
    switch (kind) {
        case 'portrait':
        case 'face':
            roles = ['face_front', 'face_three_quarter'];
            break;
        case 'full_body':
        case 'fullbody':
            roles = ['full_body_front', 'full_body_three_quarter'];
            break;
        case 'profile':
        case 'side':
            roles = ['face_profile', 'full_body_side'];
            break;
        case 'accessory':
            roles = ['face_front', 'accessory_detail', 'distinctive_feature_detail'];
            break;
        case 'complex':
            roles = ['face_front', 'full_body_front', 'distinctive_feature_detail'];
            break;
        default:
            roles = ['face_front'];
    }
    const references = filenamesFor(sheet, roles);
    return { source: base, references };
}

// Infer a reference kind from the scene wording (best-effort; the prompt layer
// still owns the actual request).
function inferRequestKind(options = {}) {
    const text = String(options.text || options.scenePrompt || '').toLowerCase();
    if (/\b(?:full[- ]?body|head to toe|outfit|fashion|standing)\b/.test(text)) return 'full_body';
    if (/\b(?:profile|side view|side profile)\b/.test(text)) return 'portrait';
    if (/\b(?:close[- ]?up|portrait|headshot|face)\b/.test(text)) return 'portrait';
    if (/\b(?:earrings?|necklace|glasses|jewell?ery|tattoo|piercing)\b/.test(text)) return 'accessory';
    return 'complex';
}

// --- Prompt layer -------------------------------------------------------------
//
// The identity context layer keeps permanent identity separate from changeable
// appearance (outfit / environment / pose / lighting / camera). It is composed
// on top of the existing scene prompt; it never replaces the prompt builder.

function buildIdentityConstraints(sheet) {
    const meta = normalizeSheet(sheet).identity.metadata || {};
    const summary = metadataSummary(meta);
    const constraints = [
        'Preserve the approved character\'s facial identity, hairstyle, skin tone, body proportions and distinctive features'
        + (summary ? ': ' + summary : '')
    ];
    if (meta.signatureAccessories && meta.signatureAccessories.length) {
        constraints.push('Keep the character\'s signature accessories: ' + meta.signatureAccessories.join(', '));
    }
    constraints.push('Do not redesign the character or change their facial structure or hairstyle');
    return constraints;
}

// Compose the Qwen edit instruction used for reference-guided generation: the
// approved base image (image 1) plus the selected identity references keep the
// person, while the scene prompt changes. Explicit IDENTITY / SCENE / DO NOT
// sections keep the two domains from bleeding into each other.
function buildSceneEditInstruction(sheet, scenePrompt) {
    const meta = normalizeSheet(sheet).identity.metadata || {};
    const summary = metadataSummary(meta);
    const identity = 'IDENTITY: Keep the exact same approved person shown in image 1' +
        (summary ? ' (' + summary + ')' : '') +
        '. Preserve their facial identity, hairstyle, skin tone, body proportions and distinctive features.';
    const scene = 'SCENE (change only this): ' + String(scenePrompt || '').trim();
    const dont = 'DO NOT: redesign the character, change facial structure, change the hairstyle unnecessarily, ' +
        'or introduce new accessories unless the scene explicitly asks for them.';
    return identity + ' ' + scene + ' ' + dont;
}

// --- Generation orchestration -------------------------------------------------
//
// Pure orchestration: the caller injects `generate` (the existing image
// generator's edit call) and `resolveAbs` (a filename -> absolute path
// resolver), plus an `onProgress` persistence hook. Partial failures never
// destroy the approved base image or existing references — they are recorded
// and the sheet is marked ready only when every required reference succeeded.

async function generateSheet(options = {}) {
    const character = options.character || {};
    const characterId = character.id || options.characterId || '';
    const generate = options.generate;
    const resolveAbs = typeof options.resolveAbs === 'function' ? options.resolveAbs : (name) => name;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const logger = options.logger || console;
    if (typeof generate !== 'function') {
        throw new Error('Character identity sheet generation requires a generator.');
    }

    const plan = Array.isArray(options.plan) && options.plan.length ? options.plan : planReferences(character);
    let sheet = normalizeSheet(options.sheet, { characterId });
    const previous = options.previousSheet ? normalizeSheet(options.previousSheet, { characterId }) : null;
    const baseName = baseFilename(sheet);
    if (!baseName) {
        sheet.error = 'The approved base image is missing.';
        sheet.status = STATUS.FAILED;
        sheet.identity.status = SHEET_STATUS.FAILED;
        sheet.identity.error = 'The approved base image is missing.';
        return sheet;
    }
    const baseAbs = resolveAbs(baseName);

    // A regeneration preserves the existing package until the new one is
    // proven: we start from a fresh reference set only now, after the plan is
    // known, and keep the previous references on the character preset via the
    // caller (which stores this sheet only as it progresses).
    sheet = markGenerating(sheet, { plan });
    await onProgress(sheet);

    const byRole = {};
    let done = 0;
    for (const entry of plan) {
        sheet = markReferenceProgress(sheet, { done, total: plan.length, current: entry.role });
        await onProgress(sheet);
        const dependencyPaths = (entry.dependsOn || [])
            .map((role) => byRole[role] && byRole[role].imagePath)
            .filter(Boolean)
            .map(resolveAbs);
        try {
            const result = await generate(baseAbs, entry.instruction, {
                references: dependencyPaths,
                conversationId: options.conversationId,
                label: 'identity reference',
                kind: 'image_edit',
                // Identity references belong to the character package, not the
                // shared gallery, so they are recorded as hidden media.
                hidden: true
            });
            const filename = String(result.filename || basenameOf(result.url) || '');
            const ref = {
                id: makeId('ref'),
                characterId,
                role: entry.role,
                label: entry.label,
                imageUrl: result.url || ('/generated/' + encodeURIComponent(filename)),
                imagePath: filename,
                prompt: entry.instruction,
                sourceBaseImage: baseName,
                createdAt: new Date().toISOString(),
                approved: true
            };
            byRole[entry.role] = ref;
            sheet = recordReference(sheet, entry.role, entry.category, ref);
            sheet.generationHistory = (sheet.generationHistory || []).concat([{
                role: entry.role,
                filename,
                createdAt: ref.createdAt
            }]).slice(-50);
        } catch (err) {
            // Partial failure: record it and keep going so one failed view does
            // not discard the references that did succeed.
            if (logger && typeof logger.warn === 'function') {
                logger.warn('[character-identity] reference "' + entry.role + '" failed: ' + (err && err.message));
            }
            sheet.identity.consistencyNotes = sheet.identity.consistencyNotes.concat([
                'Could not generate ' + entry.label + ': ' + ((err && err.message) || 'unknown error')
            ]);
        }
        done += 1;
        sheet = markReferenceProgress(sheet, { done, total: plan.length, current: entry.role });
        await onProgress(sheet);
    }

    sheet = completeSheet(sheet, plan);
    // Regeneration safety: if the new sheet failed but a previous package was
    // valid, restore its references for every missing role and keep the package
    // ready. Existing approved data is never destroyed by a failed retry.
    if (sheet.status === STATUS.FAILED && previous && previous.identity.status === SHEET_STATUS.READY) {
        const restored = normalizeSheet(sheet, { characterId });
        for (const entry of plan) {
            if (findIn(restored, entry.role)) continue;
            const old = findIn(previous, entry.role);
            if (old) {
                restored.identity.references[entry.category] =
                    restored.identity.references[entry.category].concat([old]);
            }
        }
        const stillMissing = plan.filter((e) => e.required !== false).map((e) => e.role)
            .filter((role) => !findIn(restored, role));
        if (!stillMissing.length) {
            restored.status = STATUS.READY;
            restored.identity.status = SHEET_STATUS.READY;
            restored.identity.error = '';
            restored.identity.consistencyNotes = restored.identity.consistencyNotes.concat(
                ['Some references could not be regenerated; the previous working references were kept.']
            );
            restored.approvedReferences = allReferences(restored).map((r) => r.id);
            sheet = restored;
        }
    }
    await onProgress(sheet);
    return sheet;
}

function findIn(sheet, role) {
    const refs = normalizeSheet(sheet).identity.references;
    for (const list of Object.values(refs)) {
        const hit = list.find((r) => r.role === role);
        if (hit) return hit;
    }
    return null;
}

function basenameOf(url) {
    const raw = String(url || '').split('?')[0];
    const idx = raw.lastIndexOf('/');
    const name = idx === -1 ? raw : raw.slice(idx + 1);
    try { return decodeURIComponent(name); } catch (err) { return name; }
}

// --- Legacy compatibility -----------------------------------------------------

// The base image an identity operation should start from: the approved base
// image when one exists, otherwise the character's existing portrait, so a
// legacy character can generate a sheet without being recreated.
function effectiveBaseImage(character, sheet) {
    const s = normalizeSheet(sheet || (character && character.identitySheet), { characterId: character && character.id });
    if (s.baseImage && s.baseImage.filename) return s.baseImage;
    const portrait = character && character.portraitReference;
    if (portrait && (portrait.filename || portrait.url)) {
        return baseImageFrom({
            url: portrait.url,
            filename: portrait.filename,
            width: portrait.width,
            height: portrait.height,
            seed: portrait.seed,
            prompt: portrait.prompt,
            approved: false,
            createdAt: portrait.createdAt
        });
    }
    return null;
}

// True when the character has no identity sheet yet but could build one from an
// existing portrait (the "Basic Reference" legacy state).
function hasLegacyBase(character, sheet) {
    const s = normalizeSheet(sheet || (character && character.identitySheet));
    if (s.baseImage && s.baseImage.filename) return false;
    return Boolean(character && character.portraitReference && (character.portraitReference.filename || character.portraitReference.url));
}

// Build a read-only card the UI renders. Never exposes filesystem paths.
function buildCard(character, sheet) {
    const s = normalizeSheet(sheet || (character && character.identitySheet), { characterId: character && character.id });
    const refs = s.identity.references;
    const flatten = (list) => list.map((r) => ({
        id: r.id,
        role: r.role,
        label: r.label,
        url: r.imageUrl,
        approved: r.approved,
        createdAt: r.createdAt
    }));
    const base = effectiveBaseImage(character, s);
    return {
        characterId: character && character.id,
        name: (character && character.name) || 'Character',
        status: s.status,
        identityStatus: s.identity.status,
        error: s.error || s.identity.error || '',
        createdAt: (character && character.createdAt) || s.createdAt,
        updatedAt: s.updatedAt,
        progress: s.progress,
        baseImage: base ? {
            url: base.url,
            filename: base.filename,
            approved: Boolean((s.baseImage || {}).approved),
            width: base.width,
            height: base.height
        } : null,
        hasLegacyBase: hasLegacyBase(character, s),
        metadata: s.identity.metadata || {},
        categories: {
            fullBody: flatten(refs.fullBody),
            face: flatten(refs.face),
            profile: flatten(refs.profile),
            accessories: flatten(refs.accessories),
            distinctiveFeatures: flatten(refs.distinctiveFeatures)
        },
        referenceCount: allReferences(s).length,
        requiredTotal: planReferences(character).filter((e) => e.required !== false).length,
        identityPrompt: s.identity.identityPrompt || '',
        consistencyNotes: s.identity.consistencyNotes || [],
        generatedAt: s.identity.generatedAt
    };
}

module.exports = {
    CHARACTER_IDENTITY_SCHEMA_VERSION,
    STATUS,
    SHEET_STATUS,
    CATEGORY,
    // pure model
    deriveMetadata,
    metadataSummary,
    inferAccessories,
    planReferences,
    createSheet,
    normalizeSheet,
    applyBaseImage,
    markGenerating,
    recordReference,
    markReferenceProgress,
    completeSheet,
    allReferences,
    mediaFilenames,
    // reference selection / prompts
    selectReferencesForRequest,
    inferRequestKind,
    buildIdentityConstraints,
    buildSceneEditInstruction,
    // legacy
    effectiveBaseImage,
    hasLegacyBase,
    buildCard,
    // orchestration
    generateSheet
};
