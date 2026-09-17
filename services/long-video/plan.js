/* ============================================
   JARVIS — Long Video Production Store
   Per-conversation Long Video Director state:
   the Story Bible, the planned beats and the
   composed LongVideos prompt. Persisted to
   data/long-video-state.json so a storyboard
   approval survives a reload or a restart.
   ============================================ */

const fs = require('fs');
const path = require('path');

const motion = require('./motion');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'long-video-state.json');

const STATUS = Object.freeze({
    AWAITING_STORYBOARD_APPROVAL: 'awaiting_storyboard_approval',
    GENERATING: 'generating_long_video',
    COMPLETED: 'completed',
    FAILED: 'failed_long_video',
    CANCELLED: 'cancelled'
});

const OPEN_STATUSES = new Set([
    STATUS.AWAITING_STORYBOARD_APPROVAL,
    STATUS.GENERATING,
    STATUS.FAILED
]);

const STAGE_DEFS = Object.freeze([
    { id: 'planning', label: 'Planning' },
    { id: 'storyboard', label: 'Storyboard approved' },
    { id: 'preparing', label: 'Preparing H3 LongVideos' },
    { id: 'generating', label: 'Generating sequence' },
    { id: 'finalizing', label: 'Finalizing' }
]);

function loadStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) return {};
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Failed to load long-video state:', e.message);
        return {};
    }
}

// conversationId -> long video plan. One active plan per conversation.
const plans = new Map(Object.entries(loadStore()));

function saveStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const obj = {};
        for (const [id, plan] of plans) {
            obj[id] = plan;
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save long-video state:', e.message);
    }
}

// A generation cannot survive a process restart (the queue is in-memory).
// Mark the in-flight stage failed at boot so the card offers a retry with the
// approved storyboard intact instead of waiting on a dead job.
(function reconcileRunningPlans() {
    let changed = false;
    for (const plan of plans.values()) {
        if (plan && plan.status === STATUS.GENERATING) {
            plan.status = STATUS.FAILED;
            plan.error = plan.error || 'The server restarted while the long video was rendering.';
            changed = true;
        }
    }
    if (changed) saveStore();
})();

function makeId() {
    return 'lv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function emptyBible() {
    return {
        characters: [],
        environment: { location: '', timeOfDay: '', weather: '', lighting: '' },
        props: [],
        objectStates: [],
        completedActions: [],
        visualStyle: '',
        cameraStyle: '',
        continuityRules: [],
        storySummary: ''
    };
}

function normalizeCharacter(character) {
    if (!character || typeof character !== 'object') return null;
    return {
        id: String(character.id || character.name || '').trim(),
        name: String(character.name || '').trim(),
        appearance: String(character.appearance || '').trim(),
        clothing: String(character.clothing || '').trim(),
        persistentAttributes: Array.isArray(character.persistentAttributes)
            ? character.persistentAttributes.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12)
            : []
    };
}

function normalizeBible(bible) {
    const base = emptyBible();
    if (!bible || typeof bible !== 'object') return base;
    if (Array.isArray(bible.characters)) {
        base.characters = bible.characters.map(normalizeCharacter).filter(Boolean).slice(0, 8);
    }
    if (bible.environment && typeof bible.environment === 'object') {
        for (const key of Object.keys(base.environment)) {
            base.environment[key] = String(bible.environment[key] || '').trim();
        }
    }
    for (const key of ['props', 'continuityRules', 'objectStates', 'completedActions']) {
        if (Array.isArray(bible[key])) {
            base[key] = bible[key].map((s) => String(s || '').trim()).filter(Boolean).slice(0, 16);
        }
    }
    for (const key of ['visualStyle', 'cameraStyle', 'storySummary']) {
        base[key] = String(bible[key] || '').trim();
    }
    return base;
}

function normalizeBeats(beats) {
    if (!Array.isArray(beats)) return [];
    const out = [];
    let cursor = 0;
    for (const beat of beats) {
        if (!beat || typeof beat !== 'object') continue;
        const duration = Number(beat.duration);
        const safeDuration = Number.isFinite(duration) && duration > 0
            ? Math.min(15, Math.round(duration * 10) / 10)
            : null;
        if (safeDuration === null) continue;
        const startTime = Number.isFinite(Number(beat.startTime)) ? Number(beat.startTime) : cursor;
        const endTime = Number.isFinite(Number(beat.endTime)) ? Number(beat.endTime) : startTime + safeDuration;
        out.push({
            id: out.length + 1,
            startTime,
            endTime,
            duration: safeDuration,
            purpose: String(beat.purpose || '').trim(),
            action: String(beat.action || '').trim(),
            camera: String(beat.camera || '').trim(),
            continuity: String(beat.continuity || '').trim(),
            // Motion/world continuity: the ending state this beat leaves for the
            // next one, and the explicit transition from the previous beat.
            transition_mode: motion.TRANSITION_MODES.includes(String(beat.transition_mode || '').toLowerCase())
                ? String(beat.transition_mode).toLowerCase()
                : 'continuous_transition',
            ending_motion_state: motion.normalizeMotionState(beat.ending_motion_state),
            ending_world_state: motion.normalizeWorldState(beat.ending_world_state),
            transition_from_previous: beat.transition_from_previous
                ? motion.normalizeTransition(beat.transition_from_previous)
                : null
        });
        cursor = endTime;
    }
    return out.slice(0, 12);
}

function normalizeStages(stages) {
    if (!Array.isArray(stages) || !stages.length) {
        return STAGE_DEFS.map((s) => ({ id: s.id, label: s.label, status: 'pending' }));
    }
    return STAGE_DEFS.map((def) => {
        const found = stages.find((s) => s && s.id === def.id);
        return {
            id: def.id,
            label: def.label,
            status: found && found.status ? found.status : 'pending'
        };
    });
}

// Build a fresh plan. The storyboard starts pending approval.
function create({ conversationId, request, duration, bible, beats, prompt, composer, sourceImage, referenceMode }) {
    const now = Date.now();
    return {
        id: makeId(),
        conversationId,
        status: STATUS.AWAITING_STORYBOARD_APPROVAL,
        request: String(request || ''),
        duration: Number(duration) > 0 ? Number(duration) : null,
        storyBible: normalizeBible(bible),
        beats: normalizeBeats(beats),
        prompt: String(prompt || ''),
        composer: composer === 'llm' ? 'llm' : 'fallback',
        sourceImage: sourceImage ? path.basename(String(sourceImage)) : null,
        referenceMode: referenceMode === 'first_frame' ? 'first_frame' : 'none',
        graph: null,
        promptId: null,
        videoUrl: null,
        videoFilename: null,
        error: '',
        actualSeconds: null,
        generationMs: null,
        stages: normalizeStages(null),
        createdAt: now,
        updatedAt: now
    };
}

function get(conversationId) {
    if (!conversationId) return null;
    return plans.get(conversationId) || null;
}

// Store a plan (one per conversation) and persist it.
function set(conversationId, plan) {
    if (!conversationId || !plan) return null;
    plan.updatedAt = Date.now();
    plans.set(conversationId, plan);
    saveStore();
    return plan;
}

// Shallow merge a patch into the stored plan. Nested storyBible/beats/graph are
// replaced whole (callers pass the full object they want to keep).
function patch(conversationId, changes) {
    const plan = get(conversationId);
    if (!plan || !changes || typeof changes !== 'object') return plan;
    if (Object.prototype.hasOwnProperty.call(changes, 'storyBible')) {
        changes.storyBible = normalizeBible(changes.storyBible);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'beats')) {
        changes.beats = normalizeBeats(changes.beats);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'stages')) {
        changes.stages = normalizeStages(changes.stages);
    }
    Object.assign(plan, changes);
    plan.updatedAt = Date.now();
    plans.set(conversationId, plan);
    saveStore();
    return plan;
}

function remove(conversationId) {
    if (!conversationId) return false;
    const had = plans.delete(conversationId);
    if (had) saveStore();
    return had;
}

function setStage(plan, id, status) {
    if (!plan || !Array.isArray(plan.stages)) return plan;
    const entry = plan.stages.find((s) => s && s.id === id);
    if (entry) entry.status = status;
    return plan;
}

// Mark every stage before `id` complete and `id` running, so the checklist
// reflects a single monotonic pipeline (no fake per-beat progress).
function advanceStage(plan, id) {
    if (!plan || !Array.isArray(plan.stages)) return plan;
    let reached = false;
    for (const entry of plan.stages) {
        if (entry.id === id) {
            entry.status = 'running';
            reached = true;
        } else if (!reached) {
            entry.status = 'completed';
        } else if (entry.status === 'running') {
            entry.status = 'pending';
        }
    }
    return plan;
}

function completeStages(plan) {
    if (!plan || !Array.isArray(plan.stages)) return plan;
    for (const entry of plan.stages) entry.status = 'completed';
    return plan;
}

function isOpen(plan) {
    return Boolean(plan && OPEN_STATUSES.has(plan.status));
}

function isAwaitingStoryboard(plan) {
    return Boolean(plan && plan.status === STATUS.AWAITING_STORYBOARD_APPROVAL);
}

function isActive(plan) {
    return Boolean(plan && plan.status === STATUS.GENERATING);
}

module.exports = {
    STATUS,
    STAGE_DEFS,
    create,
    get,
    set,
    patch,
    remove,
    setStage,
    advanceStage,
    completeStages,
    isOpen,
    isAwaitingStoryboard,
    isActive,
    normalizeBible,
    normalizeBeats,
    emptyBible,
    DATA_FILE
};
