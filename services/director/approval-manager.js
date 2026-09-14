/* ============================================
   JARVIS — Director Approval Manager
   Turns a button payload or a plain chat
   message into a Director action for the active
   production, and validates that the action is
   legal for the production's current stage.
   Pure-ish: only reads, never mutates state.
   ============================================ */

const imageGenerator = require('../image-generator');
const productionPlan = require('./production-plan');

const ACTIONS = Object.freeze({
    APPROVE: 'approve',
    REGENERATE_IMAGE: 'regenerate_image',
    MODIFY_DIRECTION: 'modify_direction',
    GENERATE_VIDEO: 'generate_video',
    CHOOSE_DIRECT: 'choose_direct',
    CHOOSE_DIRECTOR: 'choose_director',
    CANCEL: 'cancel'
});

const BUTTON_ACTIONS = new Set([
    ACTIONS.APPROVE,
    ACTIONS.REGENERATE_IMAGE,
    ACTIONS.MODIFY_DIRECTION,
    ACTIONS.GENERATE_VIDEO,
    ACTIONS.CHOOSE_DIRECT,
    ACTIONS.CHOOSE_DIRECTOR,
    ACTIONS.CANCEL
]);

const APPROVE_RE = /^(?:approve(?:d)?|yes|yep|yeah|ok(?:ay)?|sure|looks good|looks great|good|great|perfect|go ahead|proceed|continue|accept(?:ed)?|do it|make (?:the )?video|generate (?:the )?video|start (?:the )?video|i approve)\b[\s.!]*$/i;
const APPROVE_LOOSE_RE = /\b(?:approve(?:d)?|go ahead|proceed|accept(?:ed)?)\b/i;
const REGENERATE_RE = /\b(?:regenerate|re-?generate|re-?roll|reroll|re-?do|redo|try again|another (?:opening )?(?:frame|image|picture|photo)|new (?:opening )?(?:frame|image|picture|photo)|different (?:frame|image|picture)|not (?:quite|good)|no,? try)\b/i;
// "make the video now" / "start the video" is approval, not a direction change,
// even though it is not a clean "approve" and mentions the video.
const VIDEO_GO_RE =
    /\b(?:generate|make|create|start|render|produce|continue|proceed|go|do)\b[\s\S]{0,24}\b(?:video|movie|film|clip|animation|production)\b|\b(?:video|movie|film|clip|animation)\b[\s\S]{0,24}\b(?:now|please|next|go|proceed|ahead)\b/i;
// "turn this into a 10-second video" is an approval/generate request framed as
// an image-to-video instruction, not a direction change to the frame.
const VIDEO_MAKE_RE =
    /\b(?:turn|convert|transform|animate)\b[\s\S]{0,30}\b(?:video|movie|film|clip|animation)\b|\b(?:seconds?|secs?|minutes?)\b[\s\S]{0,20}\b(?:video|movie|film|clip)\b|\b(?:video|movie|film|clip)\b[\s\S]{0,20}\b(?:seconds?|secs?|minutes?)\b/i;
const CANCEL_RE = /\b(?:cancel|abort|stop|discard|drop|forget)\b[\s\S]{0,20}\b(?:production|movie|video|film|clip|it|this|that)\b|\b(?:cancel|abort|scrap|stop)\s+(?:the\s+)?(?:production|project|movie|video|film|shot)\b/i;

// Answers to the "Direct video or Director mode?" question.
const MODE_DIRECTOR_RE =
    /\b(?:director(?:\s+mode)?|with (?:an?\s+)?approval|approval (?:flow|step)|image\s+first|opening\s+frame|cinematic|movie|film|commercial|full\s+production|production\s+mode)\b/i;
const MODE_DIRECT_RE =
    /\b(?:direct(?:ly)?|normal|plain|simple|straight(?:\s+to)?\s+video|just\s+(?:the\s+)?video|just\s+(?:generate|render|make)|no\s+director|skip(?:\s+the)?\s+director|without\s+(?:the\s+)?director|generate\s+(?:the\s+)?video\s+directly)\b/i;

function normalizeAction(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        const type = value.trim().toLowerCase();
        if (!BUTTON_ACTIONS.has(type)) return null;
        return { type, productionId: '', direction: '' };
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const type = String(value.type || value.action || '').trim().toLowerCase();
    if (!BUTTON_ACTIONS.has(type)) return null;
    return {
        type,
        productionId: String(value.productionId || value.id || '').trim(),
        direction: String(value.direction || value.feedback || value.message || '').trim()
    };
}

function isCancel(message) {
    return CANCEL_RE.test(String(message || ''));
}

function isApprove(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    return APPROVE_RE.test(text) || APPROVE_LOOSE_RE.test(text);
}

function isRegenerate(message) {
    const text = String(message || '');
    return REGENERATE_RE.test(text) && !isApprove(text);
}

function isModify(message, hasImageContext = true) {
    const text = String(message || '').trim();
    if (!text) return false;
    if (/^(?:what|which|why|who|when|where|how|is|are|do|does|did|can|could|would|should)\b/i.test(text)) {
        return false;
    }
    if (/\?\s*$/.test(text)) return false;
    try {
        if (imageGenerator.detectImageModifyIntent(text, hasImageContext)) return true;
    } catch (err) {
        // fall through to the verb/target heuristic below
    }
    // Feedback that names a change but uses no explicit modify verb
    // ("her jacket should be red", "move the camera further away").
    if (/\b(?:should|instead|more|less|better|without|with|move|add|remove|swap|replace|change|make|look)\b/i.test(text) &&
        /\b(?:her|his|their|him|them|the|camera|jacket|dress|hair|light|background|setting|shot|look|style|color|colour|scene|character|subject|expression|pose)\b/i.test(text)) {
        return true;
    }
    return false;
}

// Decide what the user's message means for an open production. Returns
// { action, direction } when the Director should handle the turn, or null when
// the message is ordinary chat / another task and should flow normally.
function classifyMessage(message, production) {
    if (!production || !productionPlan.isOpen(production)) return null;
    const text = String(message || '').trim();
    if (!text) return null;

    // Cancel is honored in every open stage.
    if (isCancel(text)) return { action: ACTIONS.CANCEL, direction: '' };

    // The user is choosing how the video gets built.
    if (productionPlan.isAwaitingModeChoice(production)) {
        if (/^\s*(?:cancel|stop|never\s*mind|forget\s+it)\s*[.!]*$/i.test(text)) {
            return { action: ACTIONS.CANCEL, direction: '' };
        }
        if (MODE_DIRECTOR_RE.test(text)) return { action: ACTIONS.CHOOSE_DIRECTOR, direction: '' };
        if (MODE_DIRECT_RE.test(text)) return { action: ACTIONS.CHOOSE_DIRECT, direction: '' };
        return null;
    }

    // While the opening frame is pending approval the user can approve,
    // regenerate, or change direction.
    if (productionPlan.isAwaitingApproval(production)) {
        if (isApprove(text) || (!isRegenerate(text) && (VIDEO_GO_RE.test(text) || VIDEO_MAKE_RE.test(text)))) {
            return { action: ACTIONS.APPROVE, direction: '' };
        }
        if (isRegenerate(text)) return { action: ACTIONS.REGENERATE_IMAGE, direction: '' };
        if (isModify(text)) return { action: ACTIONS.MODIFY_DIRECTION, direction: text };
    }

    // A failed stage can be retried by asking again.
    if (production.status === productionPlan.STATUS.FAILED_IMAGE) {
        if (isRegenerate(text) || isApprove(text)) {
            return { action: ACTIONS.REGENERATE_IMAGE, direction: '' };
        }
        if (isModify(text)) return { action: ACTIONS.MODIFY_DIRECTION, direction: text };
    }
    if (production.status === productionPlan.STATUS.FAILED_VIDEO) {
        if (isApprove(text) || /\b(?:retry|try again|again|generate|make|render)\b/i.test(text)) {
            return { action: ACTIONS.APPROVE, direction: '' };
        }
    }
    return null;
}

// Validate a button/typed action against the production's current stage.
function validate(production, action) {
    if (!production) return { ok: false, reason: 'There is no active production in this conversation.' };
    if (!action) return { ok: false, reason: 'Unknown director action.' };
    const status = production.status;
    if (status === productionPlan.STATUS.CANCELLED) {
        return { ok: false, reason: 'This production was cancelled.' };
    }
    if (status === productionPlan.STATUS.COMPLETED && action.type !== ACTIONS.CANCEL) {
        return { ok: false, reason: 'This production is already complete.' };
    }
    if (action.type === ACTIONS.CANCEL) return { ok: true };

    if (status === productionPlan.STATUS.AWAITING_MODE_CHOICE) {
        if (action.type === ACTIONS.CHOOSE_DIRECT || action.type === ACTIONS.CHOOSE_DIRECTOR) {
            return { ok: true };
        }
        return { ok: false, reason: 'Choose Direct video or Director mode first.' };
    }

    const generating = status === productionPlan.STATUS.GENERATING_IMAGE ||
        status === productionPlan.STATUS.GENERATING_VIDEO;
    if (generating) {
        return { ok: false, reason: 'A generation is already running for this production. Use cancel to stop it.' };
    }

    if (action.type === ACTIONS.APPROVE) {
        if (!productionPlan.isAwaitingApproval(production) &&
            status !== productionPlan.STATUS.FAILED_VIDEO) {
            return { ok: false, reason: 'There is no opening frame waiting for approval.' };
        }
        return { ok: true };
    }
    if (action.type === ACTIONS.REGENERATE_IMAGE || action.type === ACTIONS.MODIFY_DIRECTION) {
        if (status !== productionPlan.STATUS.AWAITING_IMAGE_APPROVAL &&
            status !== productionPlan.STATUS.FAILED_IMAGE) {
            return { ok: false, reason: 'The opening frame is no longer editable.' };
        }
        return { ok: true };
    }
    if (action.type === ACTIONS.GENERATE_VIDEO) {
        if (!production.image && !production.sourceImage) {
            return { ok: false, reason: 'There is no approved frame to animate yet.' };
        }
        return { ok: true };
    }
    return { ok: false, reason: 'Unsupported director action.' };
}

module.exports = {
    ACTIONS,
    normalizeAction,
    classifyMessage,
    validate,
    isApprove,
    isRegenerate,
    isCancel,
    isModify
};
