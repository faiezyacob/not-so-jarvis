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
const inbox = require('./inbox');
const moments = require('./moments');
const creativeDefaults = require('../creative-defaults');

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

// Build the structured photo plan for a resolved intent (or a creative moment).
// Returns { spec, request, summary, posture } where `request` is
// { mode, instruction, prompt }.
function planPhoto(options) {
    const opts = options || {};
    const characterId = cleanId(opts.characterId);
    const previous = opts.previous !== undefined ? opts.previous : (characterId ? currentScene(characterId) : null);
    const current = characterId ? store.getLife(characterId) : null;
    // A garment the user explicitly named overrides the life-state outfit for
    // this one generation; any other specifics they added are carried too. The
    // stored life state is never changed.
    const parsed = camera.parseUserRequest(opts.message || '');
    const specOptions = {
        intent: opts.intent,
        subject: opts.subject,
        moment: opts.moment,
        life: current || {},
        characters: opts.characters,
        previous,
        timeOfDay: opts.timeOfDay,
        outfitOverride: opts.outfitOverride || parsed.clothing,
        userScene: opts.userScene || parsed.scene
    };
    let spec = camera.buildPhotoSpec(specOptions);
    // A character photo always has a complete outfit. When the user named only
    // one garment, the shared wardrobe fills the missing slots; when the user,
    // the life state and continuity left clothing open (a moment in another
    // room), it composes the whole outfit. The identity editor is therefore
    // never asked to invent clothing against a low-cut reference portrait.
    const characters = Array.isArray(opts.characters) ? opts.characters.filter(Boolean) : [];
    const explicitGarment = String(opts.outfitOverride || parsed.clothing || '').trim();
    const composeWardrobe = (rawPrompt) => {
        const defaults = creativeDefaults.buildCreativeDefaults(characters, {
            environment: spec.location,
            activity: spec.activity,
            scenePrompt: [spec.location, spec.activity, spec.momentTitle].filter(Boolean).join(' '),
            rawPrompt,
            seed: opts.seed
        });
        return defaults && Array.isArray(defaults.clothing) && defaults.clothing[0] && defaults.clothing[0].outfit
            ? defaults.clothing[0].outfit
            : '';
    };
    if (spec.includeCharacter && characters.length) {
        if (explicitGarment) {
            const wardrobe = composeWardrobe(opts.message || explicitGarment);
            // The partial-fill pass returns only the slots the user left open, so
            // put the named garment back in front of it.
            const completed = !wardrobe
                ? ''
                : (wardrobe.toLowerCase().indexOf(explicitGarment.toLowerCase()) !== -1
                    ? wardrobe
                    : explicitGarment + ' with ' + wardrobe);
            if (completed && completed !== explicitGarment) {
                spec = camera.buildPhotoSpec(Object.assign({}, specOptions, { outfitOverride: completed }));
            }
        } else if (!spec.outfit) {
            const composed = composeWardrobe('');
            if (composed) spec = camera.buildPhotoSpec(Object.assign({}, specOptions, { autoOutfit: composed }));
        }
    }
    const request = camera.buildPhotoInstruction(spec);
    return {
        spec,
        request,
        summary: camera.specSummary(spec),
        posture: spec.posture || null
    };
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

// --- Unprompted photo inbox ----------------------------------------------------

// Is a photo drop due for this character right now? Pure policy check.
function inboxDue(characterId, behavior, options) {
    const id = cleanId(characterId);
    if (!id) return { due: false, reason: 'no_character' };
    return inbox.dueCheck(Object.assign({}, options, {
        behavior: behavior || {},
        record: store.getRecord(id)
    }));
}

// The moment to capture (intent + moment + message), from the current fictional
// life and the moments already sent, so consecutive drops do not repeat.
function inboxPlan(characterId, options) {
    const id = cleanId(characterId);
    if (!id) return null;
    const opts = options || {};
    const current = store.getLife(id) || {};
    const recent = Array.isArray(opts.recent) ? opts.recent : inboxHistory(id);
    return inbox.planMoment(Object.assign({}, opts, {
        life: current,
        count: store.getInbox(id).length,
        recent
    }));
}

// The creative moment for the next unprompted drop. Asks the local model first
// and always resolves to a usable moment (deterministic catalog on any failure).
function planInboxMoment(characterId, options) {
    const id = cleanId(characterId);
    if (!id) return Promise.resolve(null);
    const opts = options || {};
    return moments.buildInboxMoment({
        character: opts.character,
        settings: opts.settings,
        life: store.getLife(id) || {},
        recent: Array.isArray(opts.recent) ? opts.recent : inboxHistory(id),
        count: store.getInbox(id).length,
        providers: opts.providers,
        provider: opts.provider,
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        now: opts.now,
        hour: opts.hour
    });
}

// Recent moment titles from the tray plus the recent scene activities, newest
// first, so a new drop avoids what the last few photos already showed.
function inboxHistory(characterId) {
    const sent = store.getInbox(characterId, 6)
        .map((item) => item.moment)
        .filter(Boolean);
    const seen = store.getSceneHistory(characterId, 6)
        .map((scene) => [scene.activity, scene.location].filter(Boolean).join(' '))
        .filter(Boolean);
    return sent.concat(seen);
}

function captureInboxPhoto(characterId, input) {
    return inbox.capture(characterId, input);
}

function markInboxAttempt(characterId, at) {
    return inbox.markAttempt(characterId, at);
}

function listInbox(characterId, limit) {
    return inbox.listInbox(characterId, limit);
}

function inboxUnreadCount(characterId) {
    return inbox.unreadCount(characterId);
}

function markInboxRead(characterId, itemId) {
    return inbox.markRead(characterId, itemId);
}

function removeInboxItem(characterId, itemId) {
    return inbox.remove(characterId, itemId);
}

function clearInbox(characterId) {
    return inbox.clear(characterId);
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
    // Unprompted photo inbox.
    inboxDue,
    inboxPlan,
    planInboxMoment,
    pickDeterministicMoment: moments.pickDeterministicMoment,
    MOMENT_CATALOG: moments.MOMENT_CATALOG,
    captureInboxPhoto,
    markInboxAttempt,
    listInbox,
    inboxUnreadCount,
    markInboxRead,
    removeInboxItem,
    clearInbox,
    clearRecord,
    _reset: store._reset
};
