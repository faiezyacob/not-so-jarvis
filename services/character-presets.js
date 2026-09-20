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

const DATA_DIR = path.join(__dirname, '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const PRESETS_PATH = process.env.CHARACTER_PRESETS_PATH || path.join(DATA_DIR, 'character-presets.json');

// Identity fields a preset carries. These map 1:1 onto the playground's
// lockable attribute groups, so locking reuses the same values verbatim.
// `appearanceCategory`/`appearanceCategoryLabel` preserve the demographic
// appearance the person was drawn from so reusing the preset renders them.
const CHARACTER_FIELDS = [
    'identity', 'appearance', 'hair', 'outfit', 'style',
    'appearanceCategory', 'appearanceCategoryLabel'
];

const MAX_FIELD_LENGTH = 600;
const MAX_NAME_LENGTH = 80;

let presets = null;

function loadPresets() {
    if (presets) return presets;
    try {
        const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        presets = Array.isArray(parsed.presets) ? parsed.presets : [];
    } catch (err) {
        presets = [];
    }
    return presets;
}

function savePresets() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), presets };
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

function clean(value) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, MAX_FIELD_LENGTH);
}

// Coerce arbitrary input into the canonical preset shape. Returns null when
// the preset has neither a name nor any identity detail.
function sanitizePreset(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = { name: clean(src.name).slice(0, MAX_NAME_LENGTH) };
    let any = Boolean(out.name);
    for (const field of CHARACTER_FIELDS) {
        out[field] = clean(src[field]);
        if (out[field]) any = true;
    }
    return any ? out : null;
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
    const preset = Object.assign({ id: makeId(), createdAt: now, updatedAt: now }, cleanPreset);
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
    Object.assign(preset, merged, { updatedAt: new Date().toISOString() });
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

module.exports = {
    CHARACTER_FIELDS,
    sanitizePreset,
    list,
    get,
    create,
    update,
    remove
};
