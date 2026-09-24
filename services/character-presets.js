/* ============================================
   JARVIS — Character Presets
   Small JSON store for reusable character
   identities used by the Creative Playground.
   A preset is the canonical identity data
   ({ identity, appearance, hair, outfit, style })
   so playground concepts never duplicate a
   character's attributes in their own records.
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

// Identity fields a preset carries. These map 1:1 onto the playground's
// lockable attribute groups, so locking reuses the same values verbatim.
// `appearanceCategory`/`appearanceCategoryLabel` preserve the demographic
// appearance the person was drawn from so reusing the preset renders them.
// `outfitPack`/`outfitPackCustom` preserve the character's wardrobe
// personality (an Outfit Pack id, or the custom outfit text) so a saved
// character keeps its wardrobe independently of its identity.
const CHARACTER_FIELDS = [
    'identityText', 'identitySignature', 'appearance', 'hair', 'outfit', 'style',
    'appearanceCategory', 'appearanceCategoryLabel',
    'outfitPack', 'outfitPackCustom', 'referenceImages', 'portraitReference',
    'wardrobePreference', 'visualPreferences', 'provenance'
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

function migratePreset(value) {
    const src = value && typeof value === 'object' ? value : {};
    const structured = characterModel.canonicalIdentity(src.identity, src);
    const normalized = characterModel.normalizeCharacter(src);
    const out = Object.assign({}, src, normalized, {
        id: String(src.id || ''),
        name: clean(src.name).slice(0, MAX_NAME_LENGTH),
        schemaVersion: characterModel.CHARACTER_SCHEMA_VERSION,
        identity: structured || (typeof src.identity === 'string' ? clean(src.identity) : null),
        identityText: clean(src.identityText || (typeof src.identity === 'string' ? src.identity : normalized.identityText)),
        identitySignature: clean(src.identitySignature || (structured && structured.identitySignature) || ''),
        appearance: clean(src.appearance),
        hair: clean(src.hair),
        outfit: clean(src.outfit),
        style: clean(src.style || (normalized.visualPreferences && normalized.visualPreferences.preferredStyle)),
        appearanceCategory: clean(src.appearanceCategory || (structured && structured.appearanceCategory)),
        appearanceCategoryLabel: clean(src.appearanceCategoryLabel || (structured && structured.appearanceCategoryLabel)),
        outfitPack: clean(src.outfitPack || (normalized.wardrobePreference && normalized.wardrobePreference.packId)),
        outfitPackCustom: clean(src.outfitPackCustom || (normalized.wardrobePreference && normalized.wardrobePreference.customText)),
        // The Character Identity System package (base image + identity sheet).
        // Stored on the preset so identity data is never duplicated elsewhere.
        // A legacy preset has no sheet and is surfaced as "Basic Reference".
        identitySheet: src.identitySheet ? characterIdentity.normalizeSheet(src.identitySheet, { characterId: src.id }) : null,
        revision: Number(src.revision) > 0 ? Number(src.revision) : 1
    });
    if (!structured) out.warning = 'Legacy character has no structured identity data; create a new character to enable identity locking.';
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
    return create(Object.assign({}, source, patch, { id: undefined, name: patch.name || source.name + ' Copy' }));
}

function setPortrait(id, portrait) {
    const preset = get(id);
    if (!preset) return null;
    preset.portraitReference = portrait && typeof portrait === 'object'
        ? Object.assign({}, portrait, { identitySignature: preset.identitySignature, characterRevision: preset.revision })
        : null;
    preset.updatedAt = new Date().toISOString();
    savePresets();
    return preset;
}

// The stored Character Identity package for a preset, normalized. Returns the
// canonical (empty) shape even when the preset never had a sheet.
function getIdentitySheet(id) {
    const preset = get(id);
    if (!preset) return null;
    if (!preset.identitySheet) return null;
    return characterIdentity.normalizeSheet(preset.identitySheet, { characterId: preset.id });
}

// Persist an updated Character Identity package on a preset without touching
// the identity/wardrobe fields. Always bumped and saved.
function setIdentitySheet(id, sheet) {
    const preset = get(id);
    if (!preset) return null;
    preset.identitySheet = characterIdentity.normalizeSheet(sheet, { characterId: preset.id });
    preset.updatedAt = new Date().toISOString();
    savePresets();
    return preset;
}

// Remove the Character Identity package from a preset (the character itself is
// kept). Used by the viewer's "Delete identity" action.
function clearIdentitySheet(id) {
    const preset = get(id);
    if (!preset) return null;
    preset.identitySheet = null;
    preset.updatedAt = new Date().toISOString();
    savePresets();
    return preset;
}

module.exports = {
    CHARACTER_FIELDS,
    sanitizePreset,
    list,
    get,
    create,
    update,
    duplicate,
    setPortrait,
    getIdentitySheet,
    setIdentitySheet,
    clearIdentitySheet,
    remove
};
