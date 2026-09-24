/* ============================================
   JARVIS — Character Presets
   JSON store for reusable characters used by the
   Creative Playground and the Character Identity
   System. A preset is the canonical character
   record: the structured identity that generated
   the person, the one approved base image, the one
   consolidated identity-sheet image and structured
   identity metadata.

   One character = one approved base image + one
   identity sheet. There is no per-angle reference
   array.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const characterModel = require('./playground/character');
const characterIdentity = require('./character-identity');

const DATA_DIR = path.join(__dirname, '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const PRESETS_PATH = process.env.CHARACTER_PRESETS_PATH || path.join(DATA_DIR, 'character-presets.json');

const CHARACTER_SCHEMA_VERSION = 2;

// Fields that live on the character record in addition to the identity package.
const CHARACTER_FIELDS = [
    'identityText', 'identitySignature', 'appearance', 'hair', 'style',
    'appearanceCategory', 'appearanceCategoryLabel',
    'outfitPack', 'outfitPackCustom', 'provenance'
];

const MAX_FIELD_LENGTH = 600;
const MAX_NAME_LENGTH = 80;

let presets = null;

function loadPresets() {
    if (presets) return presets;
    try {
        const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        presets = Array.isArray(parsed.presets) ? parsed.presets.map(migratePreset) : [];
    } catch (err) {
        presets = [];
    }
    return presets;
}

function savePresets() {
    const parent = path.dirname(PRESETS_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), presets };
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

function clean(value) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, MAX_FIELD_LENGTH);
}

// Coerce any stored/legacy value into the canonical character record. Backward
// compatibility is intentionally not preserved: a record that predates the
// single-sheet model simply has no identity package.
function migratePreset(value) {
    const src = value && typeof value === 'object' ? value : {};
    const structured = characterModel.canonicalIdentity(src.identity, src);
    const normalized = characterModel.normalizeCharacter(src);
    const pkg = characterIdentity.normalizePackage(src, { characterId: src.id });
    const out = Object.assign({}, src, normalized, {
        id: String(src.id || ''),
        name: clean(src.name).slice(0, MAX_NAME_LENGTH),
        schemaVersion: CHARACTER_SCHEMA_VERSION,
        description: clean(src.description),
        identity: structured || (typeof src.identity === 'string' ? clean(src.identity) : null),
        identityText: clean(src.identityText || (typeof src.identity === 'string' ? src.identity : normalized.identityText)),
        identitySignature: clean(src.identitySignature || (structured && structured.identitySignature) || ''),
        appearance: clean(src.appearance),
        hair: clean(src.hair),
        style: clean(src.style || (normalized.visualPreferences && normalized.visualPreferences.preferredStyle)),
        appearanceCategory: clean(src.appearanceCategory || (structured && structured.appearanceCategory)),
        appearanceCategoryLabel: clean(src.appearanceCategoryLabel || (structured && structured.appearanceCategoryLabel)),
        outfitPack: clean(src.outfitPack || (normalized.wardrobePreference && normalized.wardrobePreference.packId)),
        outfitPackCustom: clean(src.outfitPackCustom || (normalized.wardrobePreference && normalized.wardrobePreference.customText)),
        // The single-sheet Character Identity package (one base image, one sheet).
        approvedBaseImage: pkg.approvedBaseImage,
        identitySheet: pkg.identitySheet,
        identityMetadata: pkg.identityMetadata,
        identityPreservationInstructions: pkg.identityPreservationInstructions,
        provenance: src.provenance && typeof src.provenance === 'object' ? Object.assign({}, src.provenance) : null,
        revision: Number(src.revision) > 0 ? Number(src.revision) : 1,
        createdAt: src.createdAt || null,
        updatedAt: src.updatedAt || null
    });
    if (!structured) out.warning = 'This character has no structured identity data; create a new character to enable identity locking.';
    return out;
}

// Coerce arbitrary input into the canonical preset shape. Returns null when
// the preset has neither a name nor any identity detail.
function sanitizePreset(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = migratePreset(src);
    return (out.name || out.identityText || out.identity) ? out : null;
}

function makeId() {
    return 'char_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function list() {
    return loadPresets().slice();
}

function get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return loadPresets().find((p) => p.id === key) || null;
}

function create(value) {
    const cleanPreset = sanitizePreset(value);
    if (!cleanPreset) {
        const err = new Error('A character preset needs a name or some identity detail.');
        err.code = 'character_invalid';
        throw err;
    }
    loadPresets();
    const now = new Date().toISOString();
    const preset = Object.assign({}, cleanPreset, { id: makeId(), createdAt: now, updatedAt: now, revision: 1 });
    presets.push(preset);
    savePresets();
    return preset;
}

function update(id, patch) {
    const preset = get(id);
    if (!preset) return null;
    const merged = sanitizePreset(Object.assign({}, preset, patch || {}));
    if (!merged) {
        const err = new Error('A character preset needs a name or some identity detail.');
        err.code = 'character_invalid';
        throw err;
    }
    Object.assign(preset, merged, { updatedAt: new Date().toISOString(), revision: (Number(preset.revision) || 1) + 1 });
    savePresets();
    return preset;
}

function remove(id) {
    const key = String(id || '').trim();
    const index = loadPresets().findIndex((p) => p.id === key);
    if (index === -1) return false;
    presets.splice(index, 1);
    savePresets();
    return true;
}

function duplicate(id, patch = {}) {
    const source = get(id);
    if (!source) return null;
    const copy = Object.assign({}, source, patch, { id: undefined, name: patch.name || source.name + ' Copy' });
    return create(copy);
}

// --- Identity package ---------------------------------------------------------

// The canonical identity package (approved base image + single identity sheet +
// metadata) for a preset, normalized.
function getIdentityPackage(id) {
    const preset = get(id);
    if (!preset) return null;
    return characterIdentity.normalizePackage(preset, { characterId: preset.id });
}

// Persist the identity package fields onto a preset. Never touches the
// identity/wardrobe/name fields.
function setIdentityPackage(id, pkg) {
    const preset = get(id);
    if (!preset) return null;
    const next = characterIdentity.normalizePackage(pkg, { characterId: preset.id });
    preset.approvedBaseImage = next.approvedBaseImage;
    preset.identitySheet = next.identitySheet;
    preset.identityMetadata = next.identityMetadata;
    preset.identityPreservationInstructions = next.identityPreservationInstructions;
    preset.updatedAt = new Date().toISOString();
    savePresets();
    return preset;
}

// Set/replace just the candidate base image (never approves it).
function setCandidateBaseImage(id, image) {
    const preset = get(id);
    if (!preset) return null;
    const pkg = characterIdentity.setCandidateBase(getIdentityPackage(id), image);
    return setIdentityPackage(id, pkg);
}

// Approve the current candidate base image.
function approveBaseImage(id) {
    const preset = get(id);
    if (!preset) return null;
    const pkg = characterIdentity.approveBase(getIdentityPackage(id));
    return setIdentityPackage(id, pkg);
}

// Remove the identity sheet only (the approved base image and the character are
// kept). Used by the viewer's "Delete Identity Sheet" action.
function clearIdentitySheet(id) {
    const preset = get(id);
    if (!preset) return null;
    preset.identitySheet = null;
    preset.updatedAt = new Date().toISOString();
    savePresets();
    return preset;
}

module.exports = {
    CHARACTER_SCHEMA_VERSION,
    CHARACTER_FIELDS,
    sanitizePreset,
    list,
    get,
    create,
    update,
    duplicate,
    remove,
    getIdentityPackage,
    setIdentityPackage,
    setCandidateBaseImage,
    approveBaseImage,
    clearIdentitySheet
};
