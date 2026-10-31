/* ============================================
   JARVIS — Character Swap project store
   Per-conversation replacement projects, their
   people, anchors, masks, references and takes.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = process.env.CHARACTER_SWAP_PATH || path.join(DATA_DIR, 'character-swap.json');
const PROJECTS_DIR = process.env.CHARACTER_SWAP_DIR || path.join(DATA_DIR, 'character-swap');

const TINTS = ['#6CFF9A', '#5FC8FF', '#FFB56B'];
const MAX_PEOPLE = 3;
const MAX_REFERENCES = 9;
const FPS = 24;
const MAX_SIDE = 1280;
const H3_MAX_SECONDS = 15;
const WAN_MAX_SECONDS = Math.max(1, Number(process.env.WAN_ANIMATE_MAX_SECONDS) || 15);
const DEFAULT_ENGINE = 'wan_animate';
const ENGINES = ['wan_animate', 'h3'];

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function defaultEngineSettings() {
    return {
        wanAnimate: {
            preset: 'standard',
            resolution: '480p',
            width: 0,
            height: 0,
            steps: 6,
            cfg: 1,
            shift: 5,
            length: 81,
            overlap: 1,
            blockify: 0,
            relight: false,
            identityStrength: 1,
            motionStrength: 1,
            seedMode: 'random',
            seed: null,
            durationMode: 'match',
            durationSeconds: null,
            positive: '',
            negative: '',
            maxSeconds: WAN_MAX_SECONDS
        },
        h3: {
            quality: 'full',
            h3Size: 'L'
        }
    };
}

function normalizeEngineName(value) {
    const name = String(value || '').trim().toLowerCase();
    if (name === 'wan' || name === 'wan_animate' || name === 'wan22' || name === 'wan-animate') return 'wan_animate';
    if (name === 'h3' || name === 'minimax' || name === 'minimax_h3') return 'h3';
    return DEFAULT_ENGINE;
}

function normalizeWanLength(value, fallback = 81) {
    const n = Math.round(clampNumber(value, 33, 161, fallback));
    const snapped = Math.max(33, Math.min(161, Math.round((n - 1) / 4) * 4 + 1));
    return snapped;
}

function normalizeWanOverlap(value, fallback = 1) {
    const n = Math.round(clampNumber(value, 1, 13, fallback));
    return [1, 5, 9, 13].includes(n) ? n : fallback;
}

function normalizeEngineSettings(source) {
    const base = defaultEngineSettings();
    const input = source && typeof source === 'object' ? source : {};
    const wan = input.wanAnimate && typeof input.wanAnimate === 'object' ? input.wanAnimate : {};
    const h3 = input.h3 && typeof input.h3 === 'object' ? input.h3 : {};
    base.wanAnimate.preset = ['draft', 'standard', 'quality'].includes(String(wan.preset)) ? String(wan.preset) : base.wanAnimate.preset;
    base.wanAnimate.resolution = ['480p', '720p'].includes(String(wan.resolution)) ? String(wan.resolution) : base.wanAnimate.resolution;
    base.wanAnimate.width = Math.max(0, Math.min(2048, Math.round(Number(wan.width) || 0)));
    base.wanAnimate.height = Math.max(0, Math.min(2048, Math.round(Number(wan.height) || 0)));
    base.wanAnimate.steps = Math.round(clampNumber(wan.steps, 1, 30, base.wanAnimate.steps));
    base.wanAnimate.cfg = clampNumber(wan.cfg, 1, 10, base.wanAnimate.cfg);
    base.wanAnimate.shift = clampNumber(wan.shift, 1, 20, base.wanAnimate.shift);
    base.wanAnimate.length = normalizeWanLength(wan.length, base.wanAnimate.length);
    base.wanAnimate.overlap = normalizeWanOverlap(wan.overlap, base.wanAnimate.overlap);
    base.wanAnimate.blockify = Math.round(clampNumber(wan.blockify, 8, 128, base.wanAnimate.blockify));
    base.wanAnimate.relight = wan.relight === true;
    base.wanAnimate.identityStrength = clampNumber(wan.identityStrength, 0, 2, base.wanAnimate.identityStrength);
    base.wanAnimate.motionStrength = clampNumber(wan.motionStrength, 0, 2, base.wanAnimate.motionStrength);
    base.wanAnimate.seedMode = wan.seedMode === 'fixed' ? 'fixed' : 'random';
    base.wanAnimate.seed = wan.seed === null || wan.seed === undefined || wan.seed === ''
        ? null
        : Math.max(0, Math.round(Number(wan.seed) || 0));
    base.wanAnimate.durationMode = wan.durationMode === 'fixed' ? 'fixed' : 'match';
    base.wanAnimate.durationSeconds = wan.durationSeconds === null || wan.durationSeconds === undefined || wan.durationSeconds === ''
        ? null
        : Math.round(clampNumber(wan.durationSeconds, 1, WAN_MAX_SECONDS, WAN_MAX_SECONDS) * 10) / 10;
    base.wanAnimate.positive = String(wan.positive || '').slice(0, 4000);
    base.wanAnimate.negative = String(wan.negative || '').slice(0, 4000);
    base.wanAnimate.maxSeconds = Math.round(clampNumber(wan.maxSeconds, H3_MAX_SECONDS, WAN_MAX_SECONDS, WAN_MAX_SECONDS));
    base.h3.quality = h3.quality === 'draft' ? 'draft' : 'full';
    base.h3.h3Size = ['S', 'M', 'L', 'XL'].includes(String(h3.h3Size).toUpperCase())
        ? String(h3.h3Size).toUpperCase()
        : base.h3.h3Size;
    return base;
}

let cache = null;

function now() {
    return new Date().toISOString();
}

function projectDir(id) {
    return path.join(PROJECTS_DIR, String(id));
}

function ensureProjectDir(id) {
    const dir = projectDir(id);
    fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'masks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'takes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wan'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'selection'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'segmentation'), { recursive: true });
    return dir;
}

function load() {
    if (cache) return cache;
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        cache = {
            version: 1,
            projects: parsed && parsed.projects && typeof parsed.projects === 'object'
                ? parsed.projects
                : {}
        };
    } catch {
        cache = { version: 1, projects: {} };
    }
    return cache;
}

function save() {
    const data = load();
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STORE_PATH);
}

function newPerson(index) {
    return {
        id: 'person_' + (index + 1) + '_' + crypto.randomBytes(4).toString('hex'),
        label: 'Person ' + (index + 1),
        tint: TINTS[index % TINTS.length],
        selectionId: null,
        anchors: [],
        masks: null,
        refs: [],
        referenceOrder: [],
        x: 0.5,
        facing: 'front',
        look: '',
        description: null,
        identitySummary: '',
        status: 'new'
    };
}

function createProject(input = {}) {
    const id = 'cs_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    const project = {
        id,
        sessionId: String(input.sessionId || ''),
        conversationId: input.conversationId ? String(input.conversationId) : null,
        createdAt: now(),
        updatedAt: now(),
        status: 'preparing',
        activity: 'Preparing footage',
        error: null,
        warnings: [],
        provider: String(input.provider || ''),
        model: String(input.model || ''),
        engine: normalizeEngineName(input.engine),
        engineSettings: normalizeEngineSettings(input.engineSettings),
        title: String(input.title || input.filename || 'Character Swap').slice(0, 120),
        source: {
            filename: String(input.filename || ''),
            stored: String(input.stored || ''),
            duration: Number(input.duration) || 0,
            fps: Number(input.fps) || 0,
            width: Number(input.width) || 0,
            height: Number(input.height) || 0
        },
        footage: null,
        part: null,
        trim: { start: 0, end: 0 },
        people: [newPerson(0)],
        maskSettings: {
            grow: 12,
            feather: 2,
            temporal: 3,
            opacity: 0.55,
            compositeTuned: true
        },
        maskExport: null,
        maskExports: { union: null, people: {}, settings: null, createdAt: null },
        selection: { method: null, version: null, tracks: [], corrections: [], keypointsFile: null, createdAt: null },
        segmentation: { method: null, people: {}, createdAt: null },
        wan: { preprocess: null, cacheKey: null },
        sceneDescription: null,
        takes: [],
        bestTake: null
    };
    const data = load();
    data.projects[id] = project;
    ensureProjectDir(id);
    save();
    return project;
}

// The first workspace build grew the composite mask by 64 px, borrowed from
// Rigless's masked-latent pipeline. JARVIS composites H3's full-frame output,
// so that much growth paints a generated halo around the subject. Keep old
// projects usable by moving them to the tighter composite default once.
function normalizeProject(project) {
    if (!project) return project;
    if (!project.maskSettings) project.maskSettings = {};
    if (!project.maskSettings.compositeTuned && project.maskSettings.grow === 64) {
        project.maskSettings.grow = 12;
    }
    if (!project.maskSettings.compositeTuned) project.maskSettings.compositeTuned = true;
    project.maskSettings.grow = Math.round(clampNumber(project.maskSettings.grow, -128, 128, 12));
    project.maskSettings.feather = Math.round(clampNumber(project.maskSettings.feather, 0, 32, 2));
    project.maskSettings.temporal = Math.round(clampNumber(project.maskSettings.temporal, 0, 9, 3));
    project.maskSettings.opacity = clampNumber(project.maskSettings.opacity, 0.1, 1, 0.55);

    project.engine = normalizeEngineName(project.engine);
    project.engineSettings = normalizeEngineSettings(project.engineSettings);

    if (!project.maskExports || typeof project.maskExports !== 'object') {
        project.maskExports = { union: null, people: {}, settings: null, createdAt: null };
    }
    if (!project.maskExports.people || typeof project.maskExports.people !== 'object') {
        project.maskExports.people = {};
    }
    if (!project.maskExports.union && project.maskExport) project.maskExports.union = project.maskExport;
    if (!project.maskExport && project.maskExports.union) project.maskExport = project.maskExports.union;

    if (!project.wan || typeof project.wan !== 'object') {
        project.wan = { preprocess: null, cacheKey: null };
    }
    if (project.sceneDescription && typeof project.sceneDescription !== 'object') {
        project.sceneDescription = null;
    }

    if (!project.selection || typeof project.selection !== 'object') {
        project.selection = { method: null, version: null, tracks: [], corrections: [], keypointsFile: null, createdAt: null };
    }
    if (!Array.isArray(project.selection.tracks)) project.selection.tracks = [];
    if (!Array.isArray(project.selection.corrections)) project.selection.corrections = [];
    if (!project.segmentation || typeof project.segmentation !== 'object') {
        project.segmentation = { method: null, people: {}, createdAt: null };
    }
    if (!project.segmentation.people || typeof project.segmentation.people !== 'object') {
        project.segmentation.people = {};
    }

    (project.people || []).forEach((person, index) => {
        person.tint = TINTS[index % TINTS.length];
        if (!Array.isArray(person.refs)) person.refs = [];
        if (!Array.isArray(person.anchors)) person.anchors = [];
        if (person.selectionId === undefined) person.selectionId = null;
    });

    (project.takes || []).forEach((take) => {
        if (!take.engine) {
            take.engine = take.windows || take.wan ? 'wan_animate' : 'h3';
        }
        if (!Array.isArray(take.windows)) take.windows = [];
    });
    return project;
}

function get(id) {
    const data = load();
    const project = data.projects[String(id || '')] || null;
    return normalizeProject(project);
}

function requireProject(id) {
    const project = get(id);
    if (!project) {
        const err = new Error('Character swap project not found.');
        err.status = 404;
        throw err;
    }
    return project;
}

function update(id, mutate) {
    const project = requireProject(id);
    mutate(project);
    project.updatedAt = now();
    save();
    return project;
}

function remove(id) {
    const project = get(id);
    if (!project) return false;
    delete load().projects[String(id)];
    save();
    try {
        fs.rmSync(projectDir(id), { recursive: true, force: true });
    } catch {
        // A file still held open on Windows is retried on the next cleanup.
    }
    return true;
}

function list(sessionId) {
    const data = load();
    return Object.values(data.projects)
        .filter((project) => !sessionId || project.sessionId === sessionId)
        .map(normalizeProject)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function recover() {
    const data = load();
    let changed = false;
    for (const project of Object.values(data.projects)) {
        if (project.status !== 'tracking' && project.status !== 'preparing') continue;
        project.status = 'failed';
        project.activity = null;
        project.error = 'JARVIS stopped while this Character Swap was working.';
        project.updatedAt = now();
        changed = true;
    }
    if (changed) save();
}

function setEngine(id, engine, settings) {
    return update(id, (project) => {
        const next = normalizeEngineName(engine);
        const changed = project.engine !== next;
        project.engine = next;
        project.engineSettings = normalizeEngineSettings(Object.assign({}, project.engineSettings, settings || {}));
        project.engineChangedAt = changed ? now() : project.engineChangedAt || null;
    });
}

function addPerson(id) {
    return update(id, (project) => {
        if (project.people.length >= MAX_PEOPLE) {
            const err = new Error('Character Swap supports up to ' + MAX_PEOPLE + ' people per video.');
            err.status = 400;
            throw err;
        }
        project.people.push(newPerson(project.people.length));
    });
}

function getPerson(project, personId) {
    const person = (project.people || []).find((item) => item.id === personId);
    if (!person) {
        const err = new Error('Person not found in this project.');
        err.status = 404;
        throw err;
    }
    return person;
}

function removePerson(id, personId) {
    return update(id, (project) => {
        if (project.people.length <= 1) {
            const err = new Error('Keep at least one person in the project.');
            err.status = 400;
            throw err;
        }
        project.people = project.people.filter((item) => item.id !== personId);
        for (const folder of ['masks', 'refs', 'describe', 'mask-export', 'segmentation']) {
            try { fs.rmSync(path.join(projectDir(id), folder, personId), { recursive: true, force: true }); } catch { /* next cleanup */ }
        }
        try { fs.unlinkSync(path.join(projectDir(id), 'mask-export', personId + '-mask.mp4')); } catch { /* next cleanup */ }
        project.people.forEach((person, index) => {
            person.label = 'Person ' + (index + 1);
            person.tint = TINTS[index % TINTS.length];
        });
        project.takes = [];
        project.maskExport = null;
        project.maskExports = { union: null, people: {}, settings: null, createdAt: null };
        project.segmentation = { method: null, people: {}, createdAt: null };
        project.wan = { preprocess: null, cacheKey: null };
    });
}

function relative(id, file) {
    return path.relative(projectDir(id), file).split(path.sep).join('/');
}

function absolute(id, rel) {
    if (!rel) return '';
    const root = path.resolve(projectDir(id));
    const full = path.resolve(root, String(rel));
    if (full !== root && !full.startsWith(root + path.sep)) return '';
    return full;
}

module.exports = {
    STORE_PATH,
    PROJECTS_DIR,
    TINTS,
    MAX_PEOPLE,
    MAX_REFERENCES,
    FPS,
    MAX_SIDE,
    H3_MAX_SECONDS,
    WAN_MAX_SECONDS,
    DEFAULT_ENGINE,
    ENGINES,
    defaultEngineSettings,
    normalizeEngineName,
    normalizeEngineSettings,
    normalizeWanLength,
    normalizeWanOverlap,
    newPerson,
    projectDir,
    ensureProjectDir,
    createProject,
    get,
    requireProject,
    update,
    remove,
    list,
    recover,
    setEngine,
    addPerson,
    getPerson,
    removePerson,
    relative,
    absolute,
    save
};
