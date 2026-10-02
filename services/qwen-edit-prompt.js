/* ============================================
   JARVIS — Qwen Image Edit Prompt Strategy
   The ONE shared edit-first prompt layer for every
   workflow that sends a character reference image
   into Qwen Image Edit (Chat @Character generations,
   the Creative Playground, UGC Studio reference
   frames and any future caller).

   Core principle: the supplied reference image is the
   primary source of truth for the subject's identity.
   The text prompt therefore describes what CHANGES —
   never who the person is. Identity is protected by
   exactly ONE concise instruction; it is never dumped
   again afterwards, and metadata-like labels
   ("Social-media category:", "Mood:", "Outfit pack:",
   "Suggested aspect ratio:") are never emitted.

   This module is deterministic and dependency-light: it
   composes natural-language prompt text from structured
   inputs. It never talks to a model and never builds
   the TEXT-TO-IMAGE prompt (imageGenerator.buildImagePrompt
   owns that path).
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const outfitContext = require('./playground/outfit-context');

// The identity attributes the reference image owns. Stated ONCE in the
// reference/identity section; nothing re-describes the subject afterwards.
const IDENTITY_PRESERVATION_CLAUSE =
    'identity, facial structure, facial proportions, skin tone, eye shape and ' +
    'colour, nose, lips, eyebrows, hairstyle, hair colour, age, body proportions ' +
    'and distinctive facial features';

// Mirror wording is ambiguous: a mirror in the environment (a vanity, a bedroom)
// must not accidentally become a through-the-mirror composition, while an
// explicit mirror-selfie request must be rendered as one. The relationship is
// always stated explicitly.
const MIRROR_RE = /\bmirrors?\b/i;
const MIRROR_SELFIE_RE =
    /\bmirror\s+(?:selfie|photo(?:graph)?|shot|picture)\b|\b(?:selfie|photo(?:graph)?|shot|picture)\b[^.!?]{0,40}\bmirror\b|\b(?:through|via)\s+the\s+mirror\b|\breflect(?:ion|ed)\s+in\s+the\s+mirror\b/i;

// A capture-medium / camera cue in the scene text. When the scene already names
// one, the automatic style package is not appended again (consolidated camera
// instructions, never the same idea twice).
const STYLE_CUE_RE = new RegExp(
    '\\b(?:photo(?:graph(?:y|er|ic)?)?|camera|selfie|smartphone|phone|shot|framing|' +
    'composition|lens|depth\\s+of\\s+field|film|cinematic|editorial|studio|portrait|' +
    '35mm|dslr|mirrorless|softbox|lighting|natural\\s+light|golden\\s+hour|' +
    'colour\\s+grade|color\\s+grade|grain|bokeh|exposure)\\b', 'i'
);

function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

// Capitalize a fragment and terminate it, so composed paragraphs read naturally
// no matter what shape the caller's text arrived in.
function sentence(text) {
    const value = clean(text);
    if (!value) return '';
    const capped = value.charAt(0).toUpperCase() + value.slice(1);
    return /[.!?]$/.test(capped) ? capped : capped + '.';
}

function pronounFor(gender) {
    const key = String(gender || '').toLowerCase();
    if (key === 'woman' || key === 'female' || key === 'girl') {
        return { subject: 'She', possessive: 'her', object: 'her' };
    }
    if (key === 'man' || key === 'male' || key === 'boy') {
        return { subject: 'He', possessive: 'his', object: 'him' };
    }
    return { subject: 'They', possessive: 'their', object: 'them' };
}

// Accept a character-identity metadata object, an identity package, a character
// record, or a raw structured identity and return the metadata shape.
function identityMetadataOf(value) {
    const v = value && typeof value === 'object' ? value : {};
    if (v.identityMetadata && typeof v.identityMetadata === 'object') return v.identityMetadata;
    if (v.identity && typeof v.identity === 'object') return v.identity;
    return v;
}

function genderOf(value, explicit) {
    if (explicit) return explicit;
    const v = value && typeof value === 'object' ? value : {};
    if (v.gender) return v.gender;
    if (v.identity && typeof v.identity === 'object' && v.identity.gender) return v.identity.gender;
    if (v.identity && typeof v.identity === 'string') return '';
    return (v.identityMetadata && v.identityMetadata.gender) || '';
}

// The few identity details a reference portrait might not carry clearly (marks,
// tattoos, glasses). Included once, concisely; never the full description.
function detailClause(metadata, possessive) {
    const m = metadata || {};
    const features = (Array.isArray(m.distinctiveFeatures) ? m.distinctiveFeatures : [])
        .map((f) => clean(f)).filter(Boolean);
    const accessories = (Array.isArray(m.signatureAccessories) ? m.signatureAccessories : [])
        .map((a) => clean(a)).filter(Boolean);
    if (!features.length && !accessories.length) return '';
    const bits = [];
    if (features.length) bits.push('distinctive features (' + features.join(', ') + ')');
    if (accessories.length) bits.push('signature accessories (' + accessories.join(', ') + ')');
    return 'Keep ' + possessive + ' ' + bits.join(' and ') + '.';
}

// --- Sections -----------------------------------------------------------------

// Section 1 (REFERENCE / IDENTITY). One concise instruction; the complete
// character description is deliberately absent because the reference image
// already establishes it.
function referenceIdentitySection(options = {}) {
    const metadata = identityMetadataOf(options.metadata);
    const name = clean(options.name);
    const voice = pronounFor(genderOf(metadata, options.gender));
    const who = name || 'the subject';
    const possessive = name || voice.possessive;
    const owner = name ? possessive + '\'s' : possessive;
    let text = 'Use the supplied reference image as the identity source for ' + who + '. ' +
        'Preserve ' + owner + ' ' + IDENTITY_PRESERVATION_CLAUSE + '. ' +
        'Do not redesign, beautify, age, de-age or reinterpret ' + owner + ' appearance.';
    const detail = detailClause(metadata, possessive);
    if (detail) text += ' ' + detail;
    return text;
}

// The shared identity sentence for multi-character scenes: every reference maps
// to exactly one named person and attributes never transfer.
function multiCharacterIdentitySection(characters = [], options = {}) {
    const list = (Array.isArray(characters) ? characters : []).filter(Boolean);
    if (!list.length) return '';
    const rows = list.map((character, index) => {
        const name = clean(character.name) || ('Character ' + (index + 1));
        return 'reference image ' + (index + 1) + ' is ' + name;
    });
    const names = list.map((character, index) => clean(character.name) || ('Character ' + (index + 1)));
    const owners = names.map((name) => name + '\'s');
    const ownerList = owners.length === 2
        ? owners[0] + ' and ' + owners[1]
        : owners.slice(0, -1).join(', ') + ' and ' + owners[owners.length - 1];
    let text = 'Use the supplied reference images as identity sources: ' + rows.join('; ') + '. ' +
        'Preserve each person\'s own ' + IDENTITY_PRESERVATION_CLAUSE + '. ' +
        'Each person is a separate individual: never transfer, merge, swap or blend their faces, hair, ' +
        'skin tone, body proportions or complexion, and never cross-assign one person\'s attributes to another. ' +
        'Do not redesign, beautify, age, de-age or reinterpret ' + ownerList + ' appearance. ' +
        'Each reference is an identity source only — never copy its composition, pose, background, lighting or framing.';
    if (options.distinctive && options.distinctive.length) {
        for (const entry of options.distinctive) {
            if (entry && entry.name && entry.text) text += ' ' + entry.name + ': ' + sentence(entry.text);
        }
    }
    return text;
}

// Section 2 (TRANSFORMATION). Always tells Qwen what is changing before
// describing the new state; never phrased as a from-scratch generation.
function transformationSection(scene) {
    const text = clean(scene);
    if (!text) return '';
    if (/^transform\b/i.test(text)) return sentence(text);
    if (/^(?:a|an|the)\s+[^.!?]{2,90}$/i.test(text)) {
        const fragment = text.charAt(0).toLowerCase() + text.slice(1);
        return 'Transform the reference subject into ' + fragment + '.';
    }
    return 'Transform the reference subject into the requested scene. ' + sentence(text);
}

// Mirror relationship made explicit. A mirror in the environment stays in the
// background; only an explicit mirror-selfie request renders through the mirror.
function mirrorClause(scene) {
    const text = clean(scene);
    if (!text || !MIRROR_RE.test(text)) return '';
    if (MIRROR_SELFIE_RE.test(text)) {
        return 'This is a mirror selfie: the subject holds the camera and is seen through the mirror\'s reflection.';
    }
    return 'The mirror is part of the environment and appears in the background; the subject is primarily visible directly rather than only through the mirror reflection.';
}

function actionSection(text) {
    return sentence(text);
}

function expressionSection(text) {
    return sentence(text);
}

// Section 5 (OUTFIT). A concrete visual sentence, not a "wardrobe personality".
function outfitSentence(options = {}) {
    const outfit = clean(options.outfit);
    if (!outfit) return '';
    const name = clean(options.name);
    const voice = pronounFor(options.gender);
    const subject = name || voice.subject;
    return sentence(subject + ' wears ' + outfit);
}

function styleSection(text) {
    return sentence(text);
}

function environmentSection(text) {
    return sentence(text);
}

function lightingSection(text) {
    return sentence(text);
}

function cameraSection(text) {
    return sentence(text);
}

// True when the scene text already names clothing, so an automatic outfit must
// not be appended again.
function sceneContainsClothing(scene) {
    return outfitContext.detectClothingSlots(String(scene || '')).any;
}

// True when the scene text already names a capture medium / camera treatment,
// so the automatic style package must not repeat it.
function sceneContainsStyle(scene) {
    return STYLE_CUE_RE.test(String(scene || ''));
}

// --- Composition --------------------------------------------------------------

function joinSentences(parts) {
    return (parts || []).map((part) => clean(part)).filter(Boolean).join(' ');
}

// Normalize a paragraph to its sentence set for lightweight duplicate
// suppression (a sentence already written is never written again).
function sentenceSet(text) {
    return new Set(
        clean(text).split(/(?<=[.!?])\s+/).map((s) => s.toLowerCase()).filter(Boolean)
    );
}

// Compose an edit-first prompt in the canonical order:
// REFERENCE/IDENTITY -> TRANSFORMATION/ACTION/EXPRESSION -> OUTFIT ->
// ENVIRONMENT/LIGHTING -> CAMERA/STYLE. One natural-language paragraph each;
// empty parts disappear and exact duplicate paragraphs/sentences are dropped.
function composeEditPrompt(parts = {}) {
    const paragraphs = [];
    const known = new Set();
    const push = (value) => {
        const text = clean(value);
        if (!text) return;
        if (known.has(text.toLowerCase())) return;
        known.add(text.toLowerCase());
        paragraphs.push(text);
    };
    push(parts.reference);
    push(joinSentences([parts.transformation, parts.action, parts.expression]));
    push(parts.outfit);
    push(joinSentences([parts.environment, parts.lighting]));
    push(joinSentences([parts.camera, parts.style]));
    if (Array.isArray(parts.extra)) {
        for (const extra of parts.extra) push(extra);
    }
    // Drop exact duplicate sentences inside a paragraph (e.g. an expression the
    // scene already described). Conservative: only verbatim duplicates.
    const seenSentences = new Set();
    const output = [];
    for (const paragraph of paragraphs) {
        const kept = clean(paragraph).split(/(?<=[.!?])\s+/).filter((line) => {
            const key = line.toLowerCase();
            if (seenSentences.has(key)) return false;
            seenSentences.add(key);
            return true;
        }).join(' ');
        if (kept) output.push(kept);
    }
    return output.join('\n\n');
}

// The full single-character edit prompt. The caller supplies structured,
// already-resolved values; this function never invents identity detail.
function buildCharacterEditPrompt(options = {}) {
    const scene = clean(options.scene);
    const style = clean(options.style);
    const outfit = clean(options.outfit);
    const reference = clean(options.reference) || referenceIdentitySection(options);
    const mirror = mirrorClause(scene);
    return composeEditPrompt({
        reference,
        transformation: transformationSection(scene),
        action: options.action,
        expression: options.expression,
        outfit: (outfit && !sceneContainsClothing(scene))
            ? (options.outfitIsSentence ? outfit : outfitSentence({
                outfit,
                name: options.name,
                gender: options.gender
            }))
            : '',
        environment: options.environment,
        lighting: options.lighting,
        camera: joinSentences([options.camera, mirror]),
        style: (style && !sceneContainsStyle(scene)) ? style : '',
        extra: options.extra
    });
}

// The full multi-character edit prompt. Character order must match the
// reference image order (image_1..N).
function buildMultiCharacterEditPrompt(options = {}) {
    const characters = (Array.isArray(options.characters) ? options.characters : []).filter(Boolean);
    if (!characters.length) return buildCharacterEditPrompt(options);
    const scene = clean(options.scene);
    const style = clean(options.style);
    const mirror = mirrorClause(scene);
    const clothing = (Array.isArray(options.clothing) ? options.clothing : [])
        .map((entry) => {
            if (!entry) return '';
            if (typeof entry === 'string') return sentence(entry);
            if (entry.name && entry.outfit) return sentence(entry.name + ' wears ' + entry.outfit);
            return sentence(entry.outfit || '');
        })
        .filter(Boolean);
    const extra = [];
    if (options.action) extra.push(sentence(options.action));
    if (options.expression) extra.push(sentence(options.expression));
    if (clothing.length && !sceneContainsClothing(scene)) extra.push(clothing.join(' '));
    return composeEditPrompt({
        reference: clean(options.reference) || multiCharacterIdentitySection(characters),
        transformation: transformationSection(scene),
        camera: joinSentences([options.camera, mirror]),
        style: (style && !sceneContainsStyle(scene)) ? style : '',
        extra
    });
}

module.exports = {
    IDENTITY_PRESERVATION_CLAUSE,
    MIRROR_RE,
    MIRROR_SELFIE_RE,
    STYLE_CUE_RE,
    clean,
    sentence,
    pronounFor,
    identityMetadataOf,
    genderOf,
    referenceIdentitySection,
    multiCharacterIdentitySection,
    transformationSection,
    mirrorClause,
    actionSection,
    expressionSection,
    outfitSentence,
    styleSection,
    environmentSection,
    lightingSection,
    cameraSection,
    sceneContainsClothing,
    sceneContainsStyle,
    composeEditPrompt,
    buildCharacterEditPrompt,
    buildMultiCharacterEditPrompt
};