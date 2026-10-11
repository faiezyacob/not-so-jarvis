/* ============================================
   JARVIS — Character Life facade
   One entry point over the life-state store, the
   deterministic life logic and the Camera Director.
   Server code never reaches into the submodules
   directly. Fictional life is keyed by characterId
   so two characters never share a life.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const store = require('./store');
const life = require('./life');
const camera = require('./camera-director');

function cleanId(characterId) {
    return String(characterId || '').trim();
}

function getProfile(characterId) {
    if (!cleanId(characterId)) return null;
    return {
        life: store.getLife(characterId),
        recentActivities: store.getRecentActivities(characterId),
        sceneHistory: store.getSceneHistory(characterId)
    };
}

function getLife(characterId) {
    return store.getLife(characterId);
}

function setLife(characterId, patch, provenance) {
    return store.setLife(characterId, patch, provenance || 'user');
}

function currentScene(characterId) {
    return store.currentScene(characterId);
}

function listSceneHistory(characterId, limit) {
    return store.getSceneHistory(characterId, limit);
}

function clearSceneHistory(characterId) {
    return store.clearSceneHistory(characterId);
}

// --- Photo intent + plan -------------------------------------------------------

// The photo intent for a message, or NONE. Never throws.
function detectPhotoIntent(message, options) {
    try {
        return camera.detectPhotoIntent(message, options);
    } catch (err) {
        return { intent: camera.INTENT.NONE, confidence: 'none', subject: '', groupSize: 0 };
    }
}

// Build the structured photo plan for a resolved intent. Returns
// { spec, request, summary } where `request` is { mode, instruction, prompt }.
function planPhoto(options) {
    const opts = options || {};
    const characterId = cleanId(opts.characterId);
    const previous = opts.previous !== undefined ? opts.previous : (characterId ? currentScene(characterId) : null);
    const current = characterId ? store.getLife(characterId) : null;
    // A garment the user explicitly named overrides the life-state outfit for
    // this one generation; any other specifics they added are carried too. The
    // stored life state is never changed.
    const parsed = camera.parseUserRequest(opts.message || '');
    const spec = camera.buildPhotoSpec({
        intent: opts.intent,
        subject: opts.subject,
        life: current || {},
        characters: opts.characters,
        previous,
        timeOfDay: opts.timeOfDay,
        outfitOverride: opts.outfitOverride || parsed.clothing,
        userScene: opts.userScene || parsed.scene
    });
    const request = camera.buildPhotoInstruction(spec);
    return { spec, request, summary: camera.specSummary(spec) };
}

// Persist a generated photo into the character's scene history so the next
// photo can keep location/outfit continuity. This never overwrites the life
// state itself.
function recordScene(characterId, spec, result) {
    if (!cleanId(characterId) || !spec) return null;
    return store.addSceneEntry(characterId, {
        intent: spec.intent,
        cameraView: spec.cameraView,
        subject: spec.primarySubject,
        activity: spec.activity,
        location: spec.location,
        outfit: spec.outfit,
        summary: camera.specSummary(spec),
        file: result && result.filename ? result.filename : '',
        url: result && result.url ? result.url : ''
    });
}

// --- Photo offers --------------------------------------------------------------

function setOffer(characterId, conversationId, offer) {
    return store.setPendingOffer(characterId, conversationId, offer);
}

function getOffer(characterId, conversationId) {
    return store.getPendingOffer(characterId, conversationId);
}

function clearOffer(characterId, conversationId) {
    return store.clearPendingOffer(characterId, conversationId);
}

function detectOffer(reply) {
    return camera.detectOffer(reply);
}

function isAcceptance(message) {
    return camera.isAcceptance(message);
}

function isRejection(message) {
    return camera.isRejection(message);
}

// --- Life evolution ------------------------------------------------------------

// Advance the character's life state, event-based and bounded. Uses the local
// chat model when available and falls back to a deterministic pick otherwise.
// Fail-open: any error leaves the state untouched.
async function evolve(options) {
    const opts = options || {};
    const characterId = cleanId(opts.characterId);
    if (!characterId) return { ok: false, reason: 'no_character' };
    const record = store.getRecord(characterId) || store.ensureRecord(characterId);
    if (!life.shouldEvolve(record, opts.now, { intervalMinutes: opts.intervalMinutes })) {
        return { ok: false, reason: 'not_due' };
    }
    const current = store.getLife(characterId);
    const recent = store.getRecentActivities(characterId);
    let patch = null;
    let source = 'scheduled';
    if (opts.providers && typeof opts.providers.chat === 'function') {
        try {
            const messages = life.buildEvolveMessages({
                character: opts.character,
                settings: opts.settings,
                current,
                recent,
                identity: opts.identity
            });
            const raw = await opts.providers.chat(opts.provider || 'ollama', messages, opts.model || '', { temperature: 0, think: false });
            patch = life.parseEvolve(raw);
            if (patch) source = 'llm';
        } catch (err) {
            console.warn('[character-life] evolve skipped model:', err.message);
        }
    }
    if (!patch) {
        patch = life.pickDeterministicActivity({ recent, current, seed: opts.seed, provenance: 'scheduled' });
        delete patch.provenance;
        source = 'scheduled';
    }
    const next = store.setLife(characterId, patch, source);
    if (next && next.activity) {
        store.pushRecentActivity(characterId, { activity: next.activity, location: next.location });
    }
    store.setLastEvolutionAt(characterId);
    return { ok: true, life: next, source };
}

// The life block for the companion persona prompt ('' when empty).
function formatForPrompt(characterId) {
    return life.formatLife(store.getLife(characterId));
}

function clearRecord(characterId) {
    return store.deleteRecord(characterId);
}

module.exports = {
    PROVENANCE: life.PROVENANCE,
    INTENT: camera.INTENT,
    CAMERA_VIEW: camera.CAMERA_VIEW,
    STORE_PATH: store.LIFE_PATH,
    getProfile,
    getLife,
    setLife,
    currentScene,
    listSceneHistory,
    clearSceneHistory,
    detectPhotoIntent,
    planPhoto,
    recordScene,
    setOffer,
    getOffer,
    clearOffer,
    detectOffer,
    isAcceptance,
    isRejection,
    evolve,
    formatForPrompt,
    lifePhrase: life.lifePhrase,
    lifeSummary: life.lifeSummary,
    formatLife: life.formatLife,
    cameraLabel: camera.cameraLabel,
    specSummary: camera.specSummary,
    clearRecord,
    _reset: store._reset
};
