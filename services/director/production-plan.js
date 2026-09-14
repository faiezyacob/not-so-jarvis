/* ============================================
   JARVIS — Director Production Plan Store
   Per-conversation multi-stage creative job
   state (video productions). The plan survives
   between user messages and server restarts, and
   is the source of truth the Director stages are
   rebuilt from (never the raw prompt history).
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'director-state.json');

// Production status values. "open" productions keep the Director gate active
// between turns; terminal ones let normal chat resume.
const STATUS = Object.freeze({
    AWAITING_MODE_CHOICE: 'awaiting_mode_choice',
    GENERATING_IMAGE: 'generating_image',
    AWAITING_IMAGE_APPROVAL: 'awaiting_image_approval',
    GENERATING_VIDEO: 'generating_video',
    COMPLETED: 'completed',
    FAILED_IMAGE: 'failed_image',
    FAILED_VIDEO: 'failed_video',
    CANCELLED: 'cancelled'
});

const TYPES = Object.freeze({
    VIDEO_PRODUCTION: 'video_production',
    MODE_CHOICE: 'mode_choice'
});

const OPEN_STATUSES = new Set([
    STATUS.AWAITING_MODE_CHOICE,
    STATUS.GENERATING_IMAGE,
    STATUS.AWAITING_IMAGE_APPROVAL,
    STATUS.GENERATING_VIDEO,
    STATUS.FAILED_IMAGE,
    STATUS.FAILED_VIDEO
]);

function loadStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) return {};
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Failed to load director state:', e.message);
        return {};
    }
}

// conversationId -> production plan. One active production per conversation.
const productions = new Map(Object.entries(loadStore()));

function saveStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const obj = {};
        for (const [id, production] of productions) {
            obj[id] = production;
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save director state:', e.message);
    }
}

// Reconcile stale running stages at boot: a generation cannot survive a process
// restart (the queue is in-memory). Mark the in-flight stage failed so the UI
// offers a retry instead of waiting on a job that no longer exists.
(function reconcileRunningProductions() {
    let changed = false;
    for (const production of productions.values()) {
        if (!production || !production.status) continue;
        if (production.status === STATUS.GENERATING_IMAGE) {
            production.status = STATUS.FAILED_IMAGE;
            changed = true;
        } else if (production.status === STATUS.GENERATING_VIDEO) {
            production.status = STATUS.FAILED_VIDEO;
            changed = true;
        }
    }
    if (changed) saveStore();
})();

function makeId() {
    return 'prod-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function emptyBrief() {
    return {
        originalRequest: '',
        subject: '',
        setting: '',
        action: '',
        mood: '',
        visualStyle: '',
        camera: '',
        cameraMovement: '',
        temporal: '',
        sound: '',
        aspectRatio: '',
        shots: '1',
        explicitConstraints: [],
        creativeMode: 'none'
    };
}

function normalizeBrief(brief) {
    const base = emptyBrief();
    if (!brief || typeof brief !== 'object') return base;
    for (const key of Object.keys(base)) {
        if (key === 'explicitConstraints') {
            base.explicitConstraints = Array.isArray(brief.explicitConstraints)
                ? brief.explicitConstraints.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12)
                : [];
        } else {
            base[key] = String(brief[key] === undefined || brief[key] === null ? '' : brief[key]).trim();
        }
    }
    if (!/^\d+$/.test(base.shots) || Number(base.shots) < 1) base.shots = '1';
    return base;
}

// Build a fresh production plan. `sourceImage` (a raw generated filename) may be
// supplied when the production starts from an existing image — its image stage
// is recorded as completed so the Director skips straight to the video stage.
function create({ conversationId, brief, video, sourceImage, originalRequest }) {
    const now = Date.now();
    const normalizedBrief = normalizeBrief(brief);
    if (!normalizedBrief.originalRequest && originalRequest) {
        normalizedBrief.originalRequest = String(originalRequest);
    }
    const duration = Number(video && video.duration);
    const production = {
        id: makeId(),
        conversationId,
        type: TYPES.VIDEO_PRODUCTION,
        status: sourceImage ? STATUS.AWAITING_IMAGE_APPROVAL : STATUS.GENERATING_IMAGE,
        brief: normalizedBrief,
        video: {
            duration: Number.isFinite(duration) && duration > 0 ? duration : null,
            width: (video && video.width) || null,
            height: (video && video.height) || null
        },
        image: null,
        sourceImage: sourceImage || null,
        videoPrompt: '',
        videoUrl: null,
        error: '',
        createdAt: now,
        updatedAt: now,
        stages: [
            { id: 'image', type: 'image_generation', status: sourceImage ? 'completed' : 'pending', assetId: sourceImage || null },
            { id: 'image_approval', type: 'approval', status: sourceImage ? 'approved' : 'pending' },
            { id: 'video', type: 'video_generation', status: 'pending' }
        ],
        currentStage: sourceImage ? 'video' : 'image'
    };
    return production;
}

// Build a pending "which workflow" plan. No generation runs until the user
// picks Direct video or Director mode; the original request is parked here.
function createModeChoice({ conversationId, message, duration, referenceImage }) {
    const now = Date.now();
    const seconds = Number(duration);
    return {
        id: makeId(),
        conversationId,
        type: TYPES.MODE_CHOICE,
        status: STATUS.AWAITING_MODE_CHOICE,
        brief: normalizeBrief({ originalRequest: message }),
        video: {
            duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
            width: null,
            height: null
        },
        image: null,
        sourceImage: null,
        referenceImage: referenceImage || null,
        pendingRequest: String(message || ''),
        videoPrompt: '',
        videoUrl: null,
        error: '',
        createdAt: now,
        updatedAt: now,
        stages: [
            { id: 'mode_choice', type: 'choice', status: 'pending' },
            { id: 'image', type: 'image_generation', status: 'pending' },
            { id: 'image_approval', type: 'approval', status: 'pending' },
            { id: 'video', type: 'video_generation', status: 'pending' }
        ],
        currentStage: 'mode_choice'
    };
}

function get(conversationId) {
    if (!conversationId) return null;
    return productions.get(conversationId) || null;
}

// Shallow merge a patch into the stored production (nested brief/video/image are
// replaced whole; callers pass the full nested object they want to keep).
function set(conversationId, production) {
    if (!conversationId || !production) return null;
    production.updatedAt = Date.now();
    productions.set(conversationId, production);
    saveStore();
    return production;
}

function remove(conversationId) {
    if (!conversationId) return false;
    const had = productions.delete(conversationId);
    if (had) saveStore();
    return had;
}

function stage(production, id) {
    if (!production || !Array.isArray(production.stages)) return null;
    return production.stages.find((s) => s && s.id === id) || null;
}

function setStage(production, id, status, patch) {
    const entry = stage(production, id);
    if (!entry) return null;
    entry.status = status;
    if (patch && typeof patch === 'object') Object.assign(entry, patch);
    return entry;
}

function isOpen(production) {
    return Boolean(production && OPEN_STATUSES.has(production.status));
}

function isAwaitingApproval(production) {
    return Boolean(production && production.status === STATUS.AWAITING_IMAGE_APPROVAL);
}

function isAwaitingModeChoice(production) {
    return Boolean(production && production.status === STATUS.AWAITING_MODE_CHOICE);
}

function isActive(production) {
    return Boolean(production && (
        production.status === STATUS.GENERATING_IMAGE ||
        production.status === STATUS.GENERATING_VIDEO
    ));
}

function createEmptyBrief() {
    return emptyBrief();
}

module.exports = {
    STATUS,
    TYPES,
    create,
    createModeChoice,
    get,
    set,
    remove,
    stage,
    setStage,
    isOpen,
    isAwaitingApproval,
    isAwaitingModeChoice,
    isActive,
    normalizeBrief,
    createEmptyBrief,
    DATA_FILE
};
