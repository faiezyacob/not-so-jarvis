/* ============================================
   JARVIS — Shared Scene / Location Library
   The ONE canonical source of scene / environment
   data used by UGC Studio (labelled "Environment"),
   Creator Studio and the Creative Playground
   (labelled "Scene"). It promotes the original UGC
   environment catalog into a first-class, persisted,
   user-manageable library instead of introducing a
   second environment database.

   A Scene is creative direction only: it describes
   WHERE something happens (architecture, furniture,
   props, materials, colours, lighting, atmosphere,
   reference imagery, suggested activities). It never
   describes who the person is or what they are doing
   — Activity stays a separate dimension — and it
   never builds the final image/video prompt. The
   shared builder `buildSceneContext` turns a Scene
   into consistent natural-language context that the
   existing prompt owners consume.

   No LLM, no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const activities = require('./playground/activities');
const outfitContext = require('./playground/outfit-context');
const ugcState = require('./ugc/state');

const DATA_DIR = path.join(__dirname, '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const SCENES_PATH = process.env.SCENES_PATH || path.join(DATA_DIR, 'scenes.json');

const MAX_FIELD_LENGTH = 1200;
const MAX_NAME_LENGTH = 120;
const MAX_LIST_ITEMS = 24;
const MAX_REFERENCE_IMAGES = 6;

// Canonical location categories. Broad groupings only — a Scene belongs to one.
const CATEGORY_LABELS = Object.freeze({
    home: 'Home',
    social: 'Social',
    work: 'Work',
    urban: 'Urban',
    nature: 'Nature',
    retail: 'Retail',
    wellness: 'Wellness',
    travel: 'Travel',
    studio: 'Studio',
    other: 'Other'
});

const CATEGORY_ORDER = ['home', 'social', 'work', 'urban', 'nature', 'retail', 'wellness', 'travel', 'studio', 'other'];

// --- Built-in scene seeds -----------------------------------------------------
//
// The first nine retain the exact UGC environment ids, names and descriptions so
// existing UGC projects and briefs resolve unchanged. The rest extend the same
// catalog with concrete locations the Creator Studio and Playground can reuse.
// `tags` carry Activity Library environment tokens that are not the scene id
// (for example the `train_station` scene serves the `transit`/`station` tokens).

const BUILTIN_SCENES = [
    // --- Original UGC environments (ids preserved verbatim) -------------------
    { id: 'home', name: 'Home', category: 'home', description: 'a bright, lived-in home interior', tags: ['home', 'living_room', 'indoors'] },
    { id: 'bedroom', name: 'Bedroom', category: 'home', description: 'a soft, natural-light bedroom', tags: ['bedroom', 'sleeping', 'home'] },
    { id: 'bathroom', name: 'Bathroom', category: 'home', description: 'a clean, modern bathroom', tags: ['bathroom', 'home'] },
    { id: 'kitchen', name: 'Kitchen', category: 'home', description: 'a bright home kitchen with natural light', tags: ['kitchen', 'home'] },
    { id: 'modern-apartment', name: 'Modern Apartment', category: 'home', description: 'a modern apartment living space with clean lines', tags: ['living_room', 'home', 'city'] },
    { id: 'outdoor-lifestyle', name: 'Outdoor Lifestyle', category: 'nature', description: 'an outdoor lifestyle setting with natural daylight', tags: ['outdoor', 'park', 'nature'] },
    { id: 'studio', name: 'Studio', category: 'studio', description: 'a clean, minimal studio set', tags: ['studio'] },
    { id: 'office', name: 'Office', category: 'work', description: 'a modern office or desk workspace', tags: ['office', 'work'] },
    { id: 'cafe', name: 'Caf\u00e9', category: 'social', description: 'a warm neighbourhood caf\u00e9', tags: ['cafe', 'coffee'] },

    // --- Extended shared locations -------------------------------------------
    { id: 'living_room', name: 'Living Room', category: 'home', description: 'a relaxed, lived-in living room', tags: ['living_room', 'home'] },
    { id: 'balcony', name: 'Balcony', category: 'home', description: 'a small balcony with an open view', tags: ['balcony', 'home', 'outdoor'] },
    { id: 'restaurant', name: 'Restaurant', category: 'social', description: 'a warm, softly lit restaurant', tags: ['restaurant', 'date_night', 'dinner'] },
    { id: 'bar', name: 'Bar & Lounge', category: 'social', description: 'a moody, atmospheric bar or lounge', tags: ['bar', 'night'] },
    { id: 'party', name: 'Party Venue', category: 'social', description: 'a lively celebration space with ambient party lighting', tags: ['party', 'night', 'celebration'] },
    { id: 'wedding', name: 'Wedding Venue', category: 'social', description: 'an elegant wedding or ceremony setting', tags: ['wedding', 'formal'] },
    { id: 'museum', name: 'Museum', category: 'social', description: 'a quiet gallery or museum interior', tags: ['museum', 'gallery'] },
    { id: 'library', name: 'Library', category: 'work', description: 'a calm library or reading room', tags: ['library', 'study'] },
    { id: 'gym', name: 'Gym', category: 'wellness', description: 'an energetic gym or fitness studio', tags: ['gym', 'workout', 'training'] },
    { id: 'street', name: 'City Street', category: 'urban', description: 'a city street or sidewalk with urban surroundings', tags: ['street', 'city', 'urban'] },
    { id: 'rooftop', name: 'Rooftop', category: 'urban', description: 'a rooftop terrace overlooking the city', tags: ['rooftop', 'city', 'outdoor'] },
    { id: 'beach', name: 'Beach', category: 'nature', description: 'a sunlit beach with open water', tags: ['beach', 'water', 'outdoor'] },
    { id: 'park', name: 'Park', category: 'nature', description: 'a green park with open space and trees', tags: ['park', 'nature', 'outdoor'] },
    { id: 'garden', name: 'Garden', category: 'nature', description: 'a lush garden with natural greenery', tags: ['garden', 'park', 'outdoor'] },
    { id: 'mountain', name: 'Mountain', category: 'nature', description: 'a dramatic mountain landscape', tags: ['mountain', 'hiking', 'outdoor'] },
    { id: 'mall', name: 'Shopping Mall', category: 'retail', description: 'a bright shopping mall interior', tags: ['mall', 'shopping'] },
    { id: 'market', name: 'Market', category: 'retail', description: 'a bustling street market with stalls', tags: ['market', 'shopping', 'outdoor'] },
    { id: 'hotel', name: 'Hotel Room', category: 'travel', description: 'a clean, comfortable hotel room', tags: ['hotel', 'travel'] },
    { id: 'resort', name: 'Resort', category: 'travel', description: 'a relaxed resort setting with warm light', tags: ['resort', 'travel', 'water'] },
    { id: 'train_station', name: 'Train Station', category: 'travel', description: 'a transit station or platform', tags: ['transit', 'station', 'train_platform', 'bus_stop', 'travel'] },
    { id: 'airport', name: 'Airport', category: 'travel', description: 'a bright, modern airport terminal', tags: ['airport', 'transit', 'travel'] },
    { id: 'patio', name: 'Outdoor Patio', category: 'nature', description: 'an open-air patio with natural daylight', tags: ['outdoor', 'park', 'cafe'] }
];

let scenes = null;
let seeded = false;

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || MAX_FIELD_LENGTH);
}

function cleanList(value, maxItems, maxLength) {
    if (Array.isArray(value)) {
        return value.map((v) => clean(v, maxLength || 200)).filter(Boolean).slice(0, maxItems || MAX_LIST_ITEMS);
    }
    return String(value || '')
        .split(/[,;\n]/)
        .map((v) => clean(v, maxLength || 200))
        .filter(Boolean)
        .slice(0, maxItems || MAX_LIST_ITEMS);
}

const CATEGORY_IDS = Object.keys(CATEGORY_LABELS);

function normalizeCategory(value) {
    const key = String(value || '').trim().toLowerCase();
    return CATEGORY_IDS.includes(key) ? key : 'other';
}

// Only image paths already served by the app are accepted, so a Scene can never
// store a remote or traversal URL.
function cleanReferenceImages(value) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    const out = [];
    for (const item of list) {
        const url = clean(item, 500);
        if (!/^\/(?:images|generated)\/[A-Za-z0-9._%-]+$/.test(url)) continue;
        if (!out.includes(url)) out.push(url);
        if (out.length >= MAX_REFERENCE_IMAGES) break;
    }
    return out;
}

// Structured environment description. Empty sub-fields are omitted so the
// composed scene context never contains invented detail.
function normalizeEnvironment(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        architecture: clean(src.architecture, 400),
        furniture: clean(src.furniture, 400),
        props: clean(src.props, 400),
        materials: clean(src.materials, 400),
        colors: clean(src.colors, 400)
    };
}

function normalizeLighting(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        description: clean(src.description, 400),
        timeOfDay: clean(src.timeOfDay, 80)
    };
}

function makeId() {
    return 'scene_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Normalize any Scene-like record (built-in seed or user input) into the
// canonical shape. `name` is canonical; `label` is kept as a legacy/UI alias.
function normalizeSceneRecord(value, options = {}) {
    const src = value && typeof value === 'object' ? value : {};
    const name = clean(src.name || src.label, MAX_NAME_LENGTH);
    const id = clean(src.id, 80) || makeId();
    const environment = normalizeEnvironment(src.environment);
    const lighting = normalizeLighting(src.lighting);
    const referenceImages = cleanReferenceImages(src.referenceImages || src.referenceImage);
    const record = {
        id,
        name,
        label: name,
        category: normalizeCategory(src.category),
        description: clean(src.description),
        environment,
        lighting,
        atmosphere: cleanList(src.atmosphere, 12, 80),
        cameraContext: (src.cameraContext && typeof src.cameraContext === 'object') ? {
            framing: clean(src.cameraContext.framing, 200),
            movement: clean(src.cameraContext.movement, 200),
            notes: clean(src.cameraContext.notes, 300)
        } : {},
        referenceImages,
        referenceImage: referenceImages[0] || '',
        suggestedActivities: cleanList(src.suggestedActivities, MAX_LIST_ITEMS, 80),
        tags: cleanList(src.tags, MAX_LIST_ITEMS, 60),
        source: clean(src.source, 30) || options.source || 'user',
        createdAt: src.createdAt || new Date().toISOString(),
        updatedAt: src.updatedAt || new Date().toISOString()
    };
    if (!record.name && !record.description) return null;
    return record;
}

function seedRecord(seed) {
    return normalizeSceneRecord(Object.assign({}, seed, { source: 'builtin' }), { source: 'builtin' });
}

function loadScenes() {
    if (scenes) return scenes;
    try {
        const raw = fs.readFileSync(SCENES_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        scenes = Array.isArray(parsed.scenes)
            ? parsed.scenes.map((s) => normalizeSceneRecord(s)).filter(Boolean)
            : [];
        seeded = parsed.seeded === true;
    } catch (err) {
        scenes = [];
        seeded = false;
    }
    return scenes;
}

function saveScenes() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    seeded = true;
    fs.writeFileSync(SCENES_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        seeded: true,
        scenes
    }, null, 2), 'utf-8');
}

// Migrate any environment/ scene already stored on an existing UGC project into
// the shared library, retaining its id, name and description. Idempotent, and
// never deletes or resets anything.
function migrateUgcEnvironments() {
    let changed = false;
    let projects = [];
    try {
        projects = ugcState.listProjects();
    } catch (err) {
        projects = [];
    }
    const add = (env) => {
        if (!env || typeof env !== 'object') return;
        const id = clean(env.id, 80);
        if (!id || id === 'custom' || scenes.some((s) => s.id === id)) return;
        const label = clean(env.label || env.name, MAX_NAME_LENGTH) || id;
        const record = normalizeSceneRecord({
            id,
            name: label,
            description: clean(env.description),
            referenceImages: env.referenceImages || env.referenceImage
        }, { source: 'ugc' });
        if (!record) return;
        record.source = 'ugc';
        scenes.push(record);
        changed = true;
    };
    for (const project of projects) {
        if (!project || typeof project !== 'object') continue;
        add(project.environment);
        for (const scene of (Array.isArray(project.scenes) ? project.scenes : [])) {
            // A scene's environment is prose, not an id; only migrate a clearly
            // labelled environment object (never invent an id from prose).
            if (scene && scene.environmentId) add({ id: scene.environmentId, label: scene.environmentLabel || scene.environmentId, description: scene.environment });
        }
    }
    return changed;
}

// Seed the built-in scenes and migrate existing UGC environments ONCE, when the
// store is first created. After that the user is in full control: a deleted
// scene stays deleted instead of being silently re-seeded.
function ensureSeeded() {
    loadScenes();
    if (seeded) return scenes;
    for (const seed of BUILTIN_SCENES) {
        if (!scenes.some((s) => s.id === seed.id)) {
            const record = seedRecord(seed);
            if (record) scenes.push(record);
        }
    }
    migrateUgcEnvironments();
    saveScenes();
    return scenes;
}

// --- Lookup -------------------------------------------------------------------

function list() {
    return ensureSeeded().slice();
}

function get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return ensureSeeded().find((s) => s.id === key) || null;
}

function getByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return ensureSeeded().find((s) => String(s.name || '').toLowerCase() === key
        || String(s.label || '').toLowerCase() === key) || null;
}

// Resolve an id, name or free-text mention to a scene. A free-text mention is
// resolved by the app's own environment classifier first, then by matching the
// scene id/name/tags.
function resolve(value) {
    if (value && typeof value === 'object') return get(value.id) || value;
    const key = String(value || '').trim();
    if (!key) return null;
    return get(key) || getByName(key) || detectFromText(key);
}

// Resolve a free-text environment/scene mention to a built-in or user scene.
// The central outfit resolver classifies the place first (bedroom, cafe, gym…);
// explicit names/tags then fill any gap.
function detectFromText(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    const ctx = outfitContext.classifyEnvironment(value);
    if (ctx && ctx.id) {
        const byContext = get(ctx.id);
        if (byContext) return byContext;
    }
    for (const scene of ensureSeeded()) {
        if (scene.name && value.toLowerCase().includes(scene.name.toLowerCase())) return scene;
    }
    const tokens = activities.environmentTokens(value);
    if (tokens && tokens.size) {
        for (const scene of ensureSeeded()) {
            if (tokens.has(scene.id)) return scene;
            if ((scene.tags || []).some((tag) => tokens.has(tag))) return scene;
        }
    }
    return null;
}

// --- Compaction ---------------------------------------------------------------

// A compact record safe to hand to the UI / embed in a project snapshot.
function snapshot(scene) {
    if (!scene) return null;
    const record = normalizeSceneRecord(scene);
    if (!record) return null;
    return {
        id: record.id,
        name: record.name,
        label: record.name,
        category: record.category,
        description: record.description,
        environment: record.environment,
        lighting: record.lighting,
        atmosphere: record.atmosphere,
        cameraContext: record.cameraContext,
        referenceImages: record.referenceImages,
        referenceImage: record.referenceImage,
        suggestedActivities: record.suggestedActivities,
        tags: record.tags,
        source: record.source
    };
}

function listOptions() {
    return list().map((scene) => ({
        id: scene.id,
        name: scene.name,
        label: scene.name,
        category: scene.category,
        categoryLabel: CATEGORY_LABELS[scene.category] || scene.category,
        description: scene.description,
        referenceImage: scene.referenceImage || '',
        tags: (scene.tags || []).slice(),
        source: scene.source || 'user'
    }));
}

function listCategories() {
    return CATEGORY_ORDER
        .filter((id) => list().some((scene) => scene.category === id))
        .map((id) => ({ id, label: CATEGORY_LABELS[id] || id }));
}

// --- Shared scene context builder ---------------------------------------------
//
// ONE builder for every generation surface (UGC Studio, Creator Studio, the
// Creative Playground and Chat). It returns a consistent natural-language
// description of a Scene plus its structured metadata. It never invents detail:
// only fields the Scene actually carries are composed.

function phraseList(value) {
    if (Array.isArray(value)) return value.map((v) => clean(v, 200)).filter(Boolean);
    const text = clean(value, 400);
    return text ? [text] : [];
}

function buildSceneContext(scene, options = {}) {
    const optionsObj = options && typeof options === 'object' ? options : {};
    if (!scene) {
        return {
            id: '', name: '', label: '', category: '', summary: '', description: '',
            prompt: '', environment: normalizeEnvironment({}), lighting: normalizeLighting({}),
            atmosphere: [], cameraContext: {}, referenceImages: [], referenceImage: '',
            tags: [], context: null
        };
    }
    if (typeof scene === 'string' || typeof scene === 'number') {
        const text = clean(scene);
        const ctx = text ? outfitContext.classifyEnvironment(text) : null;
        return {
            id: '', name: '', label: '', category: '', summary: text, description: text,
            prompt: text, environment: normalizeEnvironment({}), lighting: normalizeLighting({}),
            atmosphere: [], cameraContext: {}, referenceImages: [], referenceImage: '',
            tags: [], context: ctx || null
        };
    }
    const record = normalizeSceneRecord(scene) || {};
    const name = record.name || record.label || '';
    const summary = record.description || name;
    const environment = record.environment || {};
    const lighting = record.lighting || {};
    const details = [];
    const envBits = [
        ['architecture', environment.architecture],
        ['furniture', environment.furniture],
        ['props', environment.props],
        ['materials', environment.materials],
        ['colors', environment.colors]
    ];
    for (const pair of envBits) {
        if (pair[1]) details.push(pair[0] + ': ' + pair[1]);
    }
    if (lighting.description) {
        details.push('lighting: ' + lighting.description + (lighting.timeOfDay ? ' (' + lighting.timeOfDay + ')' : ''));
    } else if (lighting.timeOfDay) {
        details.push('lighting: ' + lighting.timeOfDay);
    }
    const atmosphere = Array.isArray(record.atmosphere) ? record.atmosphere : [];
    if (atmosphere.length) details.push('atmosphere: ' + atmosphere.join(', '));
    const camera = record.cameraContext || {};
    if (camera.framing) details.push('camera framing: ' + camera.framing);
    if (camera.movement) details.push('camera movement: ' + camera.movement);
    if (camera.notes) details.push(camera.notes);

    const prompt = [summary].concat(details).filter(Boolean).join('. ');
    const context = (summary || name) ? outfitContext.classifyEnvironment(summary || name) : null;

    return {
        id: record.id || '',
        name,
        label: name,
        category: record.category || '',
        summary,
        description: prompt,
        prompt,
        environment,
        lighting,
        atmosphere: atmosphere.slice(),
        cameraContext: camera,
        referenceImages: (record.referenceImages || []).slice(),
        referenceImage: record.referenceImage || (record.referenceImages || [])[0] || '',
        tags: (record.tags || []).slice(),
        context: context || null
    };
}

// Prompt-ready scene sentence. Empty string for an absent scene so callers can
// safely filter it out.
function scenePrompt(scene, options) {
    return buildSceneContext(scene, options).prompt;
}

// --- Activity -> Scene recommendations ----------------------------------------
//
// Activities already declare environment compatibility tokens (preferred /
// compatible). This maps those tokens onto concrete Scenes so the library can
// recommend where an activity happens. Recommendations only — an explicit Scene
// selection always wins.

function sceneTokenScore(scene, preferred, compatible) {
    let score = 0;
    const id = scene.id;
    const tags = scene.tags || [];
    if (preferred.has(id)) score += 5;
    else if (compatible.has(id)) score += 3;
    if (tags.some((tag) => preferred.has(tag))) score += 3;
    else if (tags.some((tag) => compatible.has(tag))) score += 1.5;
    if (scene.category === 'other') score -= 0.5;
    return score;
}

function recommendForActivity(activityId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Number(opts.limit)) : 6;
    const activity = activities.getActivity(activityId);
    const pool = list();
    if (!activity) return pool.slice(0, limit).map(snapshot);
    const preferred = new Set((activity.environments && activity.environments.preferred) || []);
    const compatible = new Set((activity.environments && activity.environments.compatible) || []);
    const scored = pool.map((scene) => {
        let score = sceneTokenScore(scene, preferred, compatible);
        if ((scene.suggestedActivities || []).includes(activity.id)) score += 4;
        return { scene, score };
    }).filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || String(a.scene.name).localeCompare(String(b.scene.name)));
    const list_ = (scored.length ? scored.map((entry) => entry.scene) : pool).slice(0, limit);
    return list_.map(snapshot);
}

// Deterministically pick one recommended Scene for an activity. Honors an
// explicit avoid list so a Surprise re-roll does not immediately repeat.
function selectSceneForActivity(activityId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    const recommended = recommendForActivity(activityId, { limit: 12 });
    const avoid = new Set(Array.isArray(opts.avoidSceneIds) ? opts.avoidSceneIds : []);
    const filtered = recommended.filter((scene) => !avoid.has(scene.id));
    const pool = filtered.length ? filtered : recommended;
    if (!pool.length) return null;
    const roll = Number(rng());
    const index = Number.isFinite(roll) ? Math.floor(((roll % 1) + 1) % 1 * pool.length) : 0;
    return pool[Math.min(index, pool.length - 1)];
}

function selectRandomScene(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    const pool = list();
    if (!pool.length) return null;
    const roll = Number(rng());
    const index = Number.isFinite(roll) ? Math.floor(((roll % 1) + 1) % 1 * pool.length) : 0;
    return snapshot(pool[Math.min(index, pool.length - 1)]);
}

// --- Mutation -----------------------------------------------------------------

function create(value) {
    const record = normalizeSceneRecord(value, { source: 'user' });
    if (!record) {
        const err = new Error('A Scene needs at least a name.');
        err.code = 'scene_invalid';
        throw err;
    }
    loadScenes();
    record.source = record.source || 'user';
    const now = new Date().toISOString();
    record.createdAt = now;
    record.updatedAt = now;
    scenes.push(record);
    saveScenes();
    return record;
}

function update(id, patch) {
    const scene = get(id);
    if (!scene) return null;
    const merged = normalizeSceneRecord(Object.assign({}, scene, patch || {}), { source: scene.source });
    if (!merged) {
        const err = new Error('A Scene needs at least a name.');
        err.code = 'scene_invalid';
        throw err;
    }
    Object.assign(scene, merged, { id: scene.id, updatedAt: new Date().toISOString() });
    saveScenes();
    return scene;
}

function remove(id) {
    const key = String(id || '').trim();
    const index = loadScenes().findIndex((s) => s.id === key);
    if (index === -1) return false;
    scenes.splice(index, 1);
    saveScenes();
    return true;
}

function duplicate(id) {
    const source = get(id);
    if (!source) return null;
    const copy = normalizeSceneRecord(Object.assign({}, source, {
        id: makeId(),
        name: (source.name || 'Scene') + ' copy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }), { source: source.source === 'builtin' ? 'user' : source.source });
    if (!copy) return null;
    loadScenes();
    scenes.push(copy);
    saveScenes();
    return copy;
}

// UGC-compatibility aliases: a project stores/consumes a scene as
// `{ id, label, description }`. `getEnvironment` mirrors that legacy catalog
// lookup so an old id resolves to the shared Scene's name/description.
function getEnvironment(id) {
    const scene = get(id);
    if (!scene) return null;
    return { id: scene.id, label: scene.name, description: scene.description };
}

module.exports = {
    SCENES_PATH,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    MAX_REFERENCE_IMAGES,
    BUILTIN_SCENES,
    list,
    listOptions,
    listCategories,
    get,
    getByName,
    getEnvironment,
    resolve,
    detectFromText,
    snapshot,
    buildSceneContext,
    scenePrompt,
    recommendForActivity,
    selectSceneForActivity,
    selectRandomScene,
    create,
    update,
    remove,
    duplicate,
    ensureSeeded,
    resetForTests: () => { scenes = null; seeded = false; }
};
