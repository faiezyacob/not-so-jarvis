/* ============================================
   JARVIS — Long Video Director
   The orchestrator for videos longer than the
   15-second MiniMax H3 limit. It owns the story,
   the duration, the beat segmentation, the Story
   Bible, the pacing and the sequence structure,
   then hands one approved prompt to the installed
   H3 LongVideos ComfyUI node — which performs the
   actual frame-to-frame temporal chaining.

   It never extracts frames, never generates clips
   independently and never concatenates. The
   existing H3 Video Director keeps owning the
   <=15s workflow and individual prompt quality.
   ============================================ */

const path = require('path');

const providers = require('../../server/providers');
const videoGenerator = require('../video-generator');
const planStore = require('./plan');
const prompts = require('./prompts');
const motion = require('./motion');
const generator = require('./generator');

const MAX_SHORT_SECONDS = videoGenerator.H3_MAX_SECONDS; // 15
const MAX_LONG_SECONDS = Math.max(MAX_SHORT_SECONDS + 1, Number(process.env.H3_LONGVIDEO_MAX_SECONDS) || 120);

const ACTIONS = Object.freeze({
    APPROVE: 'approve',
    MODIFY_PLAN: 'modify_plan',
    RETRY: 'retry',
    CANCEL: 'cancel'
});

const BUTTON_ACTIONS = new Set(Object.values(ACTIONS));

// --- Duration parsing (raw, long-aware) --------------------------------------
//
// The normal pipeline clamps to H3's 5-15s window. The duration router needs the
// RAW requested length so it can decide whether the request belongs to the
// existing workflow or the Long Video Director.

const NUM_SECONDS_RE = /(\d+(?:\.\d+)?)\s*(?:-|\u2013|\u2014)?\s*(?:seconds?|secs?|s)\b/gi;
const NUM_MINUTES_RE = /(\d+(?:\.\d+)?)\s*(?:-|\u2013|\u2014)?\s*(?:minutes?|mins?)\b/gi;
const WORD_NUMBERS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90
};
const WORD_SECONDS_RE = new RegExp(
    '\\b(' + Object.keys(WORD_NUMBERS).join('|') + ')\\s*(?:-|to)?\\s*(?:seconds?|secs?)\\b', 'gi');
const WORD_MINUTES_RE = new RegExp(
    '\\b(' + Object.keys(WORD_NUMBERS).join('|') + ')\\s*(?:-|to)?\\s*(?:minutes?|mins?)\\b', 'gi');
const HALF_MINUTE_RE = /\bhalf\s+(?:a|an)\s+(?:minutes?|mins?)\b/i;
const A_MINUTE_RE = /(?<!half\s)\b(?:a|an)\s+(?:minutes?|mins?)\b/i;

// Return the largest explicitly named duration in seconds, or null. "the last
// 10 seconds of a 30 second movie" resolves to 30 (the total the user named).
function parseRequestedSeconds(message) {
    const text = String(message || '');
    if (!text.trim()) return null;
    let found = null;
    const consider = (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0 && n <= 600) {
            found = found === null ? n : Math.max(found, n);
        }
    };
    let match;
    NUM_SECONDS_RE.lastIndex = 0;
    while ((match = NUM_SECONDS_RE.exec(text))) consider(Number(match[1]));
    NUM_MINUTES_RE.lastIndex = 0;
    while ((match = NUM_MINUTES_RE.exec(text))) consider(Number(match[1]) * 60);
    WORD_SECONDS_RE.lastIndex = 0;
    while ((match = WORD_SECONDS_RE.exec(text))) consider(WORD_NUMBERS[String(match[1]).toLowerCase()]);
    WORD_MINUTES_RE.lastIndex = 0;
    while ((match = WORD_MINUTES_RE.exec(text))) {
        consider(WORD_NUMBERS[String(match[1]).toLowerCase()] * 60);
    }
    if (HALF_MINUTE_RE.test(text)) consider(30);
    if (A_MINUTE_RE.test(text)) consider(60);
    if (found === null) return null;
    return Math.min(MAX_LONG_SECONDS, Math.round(found));
}

// Prompt meta-requests ("write me a prompt for a 30 second video") are prompt
// writing, not a long video generation — the resolver owns that path.
const PROMPT_META_RE =
    /\b(?:write|brainstorm|suggest|draft|ideate|give\s+me|come\s+up\s+with|need)\b[\s\S]{0,40}\b(?:prompt|prompts|idea|ideas|concept)\b/i;

// "make a movie poster" is a still image that happens to name a video medium.
const NON_VIDEO_PRODUCTION_RE =
    /\b(?:movie|film|video|clip)\s+(?:poster|cover|thumbnail|art|artwork|image|picture|photo|logo|title)\b/i;

// The duration router. >15s routes to the Long Video Director; <=15s is left
// completely untouched for the existing H3 workflow.
function isLongVideoRequest(message, opts = {}) {
    const text = String(message || '').trim();
    if (!text) return false;
    const seconds = parseRequestedSeconds(text);
    if (seconds === null || seconds <= MAX_SHORT_SECONDS) return false;
    if (videoGenerator.isVideoConceptQuestion && videoGenerator.isVideoConceptQuestion(text)) return false;
    if (videoGenerator.isStillImageOnlyChange && videoGenerator.isStillImageOnlyChange(text)) return false;
    if (PROMPT_META_RE.test(text)) return false;
    if (NON_VIDEO_PRODUCTION_RE.test(text)) return false;
    if (/\?\s*$/.test(text)) return false;
    // Deliberately no exclusion for an active task: an explicit new long-video
    // request supersedes whatever came before. A continuation without a video
    // noun ("make it 30 seconds") never matches the strength gate below.
    const strength = videoGenerator.videoRequestStrength(text);
    if (strength === 'definite') return true;
    if (strength === 'likely' && videoGenerator.VIDEO_WORD_RE.test(text)) return true;
    return false;
}

// --- Reference source ---------------------------------------------------------

function resolveSourceImage(conversationId, message, referenceImage) {
    if (referenceImage) return path.basename(String(referenceImage).split('?')[0]);
    const text = String(message || '');
    const referencesImage = (videoGenerator.I2V_REF_RE && videoGenerator.I2V_REF_RE.test(text)) ||
        /\b(?:this|that|the|my)\s+(?:image|photo|picture|frame)\b/i.test(text);
    if (!referencesImage) return null;
    const found = videoGenerator.resolveVideoSourceImage(conversationId);
    return found ? found.rawFilename : null;
}

// --- LLM planning helpers -----------------------------------------------------

function parseJsonObject(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
        return null;
    }
}

async function callPlanner(systemPrompt, userMessage, { provider, model, think }) {
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ], model, { think, temperature: 0 });
        return parseJsonObject(raw);
    } catch (err) {
        console.warn('[long-video] planning LLM failed:', err.message);
        return null;
    }
}

async function buildStoryBible(request, { provider, model, think }) {
    const fallback = prompts.heuristicBible(request);
    const parsed = await callPlanner(
        prompts.STORY_BIBLE_SYSTEM_PROMPT,
        'USER VIDEO REQUEST:\n"' + request + '"\n\nOutput the Story Bible JSON only.',
        { provider, model, think }
    );
    if (!parsed) return { bible: fallback, composer: 'fallback' };
    const merged = planStore.normalizeBible(parsed);
    if (!merged.storySummary) merged.storySummary = fallback.storySummary;
    return { bible: merged, composer: 'llm' };
}

// Force the planned beats onto the deterministic duration budget so the total
// always equals the request and every beat stays <=15s. The LLM content is kept
// (action/camera/continuity/motion state/transition); only the timings are
// corrected. The motion chain is then reconciled so every beat after the first
// starts from the previous beat's ACTUAL ending state.
function mergeBeatsWithBudget(llmBeats, duration, opts = {}) {
    const durations = prompts.segmentDuration(duration, MAX_SHORT_SECONDS);
    const source = Array.isArray(llmBeats) ? llmBeats.slice(0, durations.length) : [];
    const beats = [];
    let cursor = 0;
    for (let i = 0; i < durations.length; i++) {
        const seconds = durations[i];
        const startTime = Number(cursor.toFixed(1));
        cursor += seconds;
        const input = (source[i] && typeof source[i] === 'object') ? source[i] : {};
        beats.push({
            id: i + 1,
            startTime,
            endTime: Number(cursor.toFixed(1)),
            duration: seconds,
            purpose: String(input.purpose || '').trim(),
            action: String(input.action || '').trim(),
            camera: String(input.camera || '').trim(),
            continuity: String(input.continuity || '').trim(),
            transition_mode: input.transition_mode,
            ending_motion_state: input.ending_motion_state,
            ending_world_state: input.ending_world_state,
            transition_from_previous: input.transition_from_previous
        });
    }
    // Beat content the LLM supplied beyond the deterministic count is folded
    // into the last beat's action so it is not silently dropped.
    if (Array.isArray(llmBeats) && llmBeats.length > durations.length && beats.length) {
        const extra = llmBeats.slice(durations.length)
            .map((b) => String((b && b.action) || '').trim())
            .filter(Boolean);
        if (extra.length) {
            const last = beats[beats.length - 1];
            last.action = [last.action].concat(extra).filter(Boolean).join(' ');
        }
    }
    return motion.reconcileMotionChain(beats, opts);
}

// The subject the deterministic motion prose names, when the Story Bible makes
// it unambiguous. With several characters we fall back to "the subject".
function primarySubjectName(bible) {
    const characters = (bible && Array.isArray(bible.characters)) ? bible.characters : [];
    if (characters.length === 1) {
        return String(characters[0].name || characters[0].id || '').trim();
    }
    return '';
}

async function buildBeats(request, bible, duration, { provider, model, think }) {
    const budget = prompts.segmentDuration(duration, MAX_SHORT_SECONDS);
    const userMessage =
        'REQUESTED TOTAL DURATION: ' + duration + ' seconds\n' +
        'BEAT BUDGET (prefer this split; sum must equal the total): ' +
        budget.map((s) => s + 's').join(' + ') + '\n' +
        'STORY BIBLE:\n' + JSON.stringify(bible, null, 2) + '\n\n' +
        'USER VIDEO REQUEST:\n"' + request + '"\n\n' +
        'Output the beats JSON object only.';
    const parsed = await callPlanner(prompts.BEAT_PLAN_SYSTEM_PROMPT, userMessage, { provider, model, think });
    const subjectName = primarySubjectName(bible);
    const llmBeats = parsed && Array.isArray(parsed.beats) ? parsed.beats : null;
    if (llmBeats && llmBeats.length) {
        return { beats: mergeBeatsWithBudget(llmBeats, duration, { subjectName }), composer: 'llm' };
    }
    return {
        beats: mergeBeatsWithBudget(prompts.heuristicBeats(bible, duration), duration, { subjectName }),
        composer: 'fallback'
    };
}

// Create a fresh plan from a raw request: Story Bible -> beats -> LongVideos
// prompt. The storyboard stops for approval before anything touches the GPU.
async function createFromRequest({ conversationId, message, provider, model, think, referenceImage }) {
    const duration = parseRequestedSeconds(message) || MAX_SHORT_SECONDS + 5;
    const { bible } = await buildStoryBible(message, { provider, model, think });
    const { beats, composer } = await buildBeats(message, bible, duration, { provider, model, think });
    const prompt = prompts.composeLongVideoPrompt(bible, beats, { request: message });
    const sourceImage = resolveSourceImage(conversationId, message, referenceImage);
    const plan = planStore.create({
        conversationId,
        request: message,
        duration,
        bible,
        beats,
        prompt,
        composer,
        sourceImage,
        referenceMode: sourceImage ? 'first_frame' : 'none'
    });
    planStore.set(conversationId, plan);
    planStore.setStage(plan, 'planning', 'completed');
    planStore.set(conversationId, plan);
    return plan;
}

// Contextual editing (section 13): update the Story Bible and affected beats,
// then rebuild the composed prompt — never append to the old one.
async function applyStoryboardUpdate(plan, feedback, { provider, model, think }) {
    const userMessage =
        'CURRENT STORY BIBLE:\n' + JSON.stringify(plan.storyBible, null, 2) + '\n\n' +
        'CURRENT BEATS:\n' + JSON.stringify(plan.beats, null, 2) + '\n\n' +
        'REQUESTED TOTAL DURATION: ' + plan.duration + ' seconds\n\n' +
        'CHANGE:\n"' + String(feedback || '') + '"\n\n' +
        'Output the updated Story Bible and beats JSON only.';
    const parsed = await callPlanner(prompts.STORYBOARD_UPDATE_SYSTEM_PROMPT, userMessage, { provider, model, think });

    // A length named in the change ("make it 60 seconds") re-budgets the plan;
    // otherwise the approved total is kept.
    const namedDuration = parseRequestedSeconds(feedback);
    const duration = (namedDuration && namedDuration > MAX_SHORT_SECONDS)
        ? namedDuration
        : plan.duration;

    let bible = plan.storyBible;
    let beats = plan.beats;
    let composer = 'fallback';
    if (parsed) {
        if (parsed.storyBible && typeof parsed.storyBible === 'object') {
            const normalized = planStore.normalizeBible(parsed.storyBible);
            if (!normalized.storySummary) normalized.storySummary = plan.storyBible.storySummary;
            bible = normalized;
        }
        if (Array.isArray(parsed.beats) && parsed.beats.length) {
            beats = mergeBeatsWithBudget(parsed.beats, duration, { subjectName: primarySubjectName(bible) });
        }
        composer = 'llm';
    }
    if (duration !== plan.duration) {
        beats = mergeBeatsWithBudget(beats, duration, { subjectName: primarySubjectName(bible) });
    }
    const prompt = prompts.composeLongVideoPrompt(bible, beats, { request: plan.request });
    return planStore.patch(plan.conversationId, {
        storyBible: bible,
        beats,
        duration,
        prompt,
        composer,
        status: planStore.STATUS.AWAITING_STORYBOARD_APPROVAL,
        error: '',
        stages: planStore.STAGE_DEFS.map((s) => ({
            id: s.id,
            label: s.label,
            status: s.id === 'planning' || s.id === 'storyboard' ? 'completed' : 'pending'
        }))
    });
}

// --- Actions ------------------------------------------------------------------

function normalizeAction(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        const type = value.trim().toLowerCase();
        if (!BUTTON_ACTIONS.has(type)) return null;
        return { type, planId: '', direction: '' };
    }
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const type = String(value.type || value.action || '').trim().toLowerCase();
    if (!BUTTON_ACTIONS.has(type)) return null;
    return {
        type,
        planId: String(value.planId || value.id || '').trim(),
        direction: String(value.direction || value.feedback || value.message || '').trim()
    };
}

const APPROVE_RE =
    /^(?:approve(?:d)?|yes|yep|yeah|ok(?:ay)?|sure|looks good|looks great|good|great|perfect|go ahead|proceed|continue|accept(?:ed)?|do it|generate(?: the)? video|make (?:the )?video|start (?:the )?video|i approve)\b[\s.!]*$/i;
const APPROVE_LOOSE_RE = /\b(?:approve(?:d)?|go ahead|proceed|generate(?: the)? video|make(?: the)? video)\b/i;
const VIDEO_GO_RE =
    /\b(?:generate|make|create|start|render|produce|continue|proceed|go|do)\b[\s\S]{0,24}\b(?:video|movie|film|clip|animation|production)\b|\b(?:video|movie|film|clip|animation)\b[\s\S]{0,24}\b(?:now|please|next|go|proceed|ahead)\b/i;
const CANCEL_RE =
    /\b(?:cancel|abort|stop|discard|drop|forget)\b[\s\S]{0,20}\b(?:long video|production|movie|video|film|clip|it|this|that)\b|\b(?:cancel|abort|scrap|stop)\s+(?:the\s+)?(?:long video|production|project|movie|video|film)\b/i;
const RETRY_RE = /\b(?:retry|try again|again|regenerate|re-?render|rerun|re-?run|render it again|generate it again)\b/i;
const PLAN_CHANGE_RE =
    /\b(?:change|make|add|remove|delete|replace|swap|update|instead|should|move|turn|set|use|give|wear|dress|put|rain|rainy|night|day|darker|brighter|closer|further|slower|faster)\b/i;

function looksLikeQuestion(text) {
    if (/\?\s*$/.test(text)) return true;
    return /^(?:what|which|why|who|when|where|how|is|are|do|does|did|can|could|would|should)\b/i.test(text);
}

// Map a typed/button message to a Long Video Director action. Returns null when
// the message is unrelated (or a brand-new request that supersedes the plan).
function classifyMessage(message, plan) {
    if (!plan || !planStore.isOpen(plan)) return null;
    const text = String(message || '').trim();
    if (!text) return null;

    if (CANCEL_RE.test(text)) return { action: ACTIONS.CANCEL, direction: '' };

    if (planStore.isActive(plan)) return null; // only cancel is meaningful mid-render

    if (planStore.isAwaitingStoryboard(plan)) {
        // A fresh, explicit long-video request supersedes the parked storyboard.
        // Checked before approval so "make a 60 second movie of X" is never
        // misread as "yes, go ahead".
        if (isLongVideoRequest(text)) return null;
        if (responseIsApprove(text)) return { action: ACTIONS.APPROVE, direction: '' };
        if (responseIsPlanChange(text)) return { action: ACTIONS.MODIFY_PLAN, direction: text };
        return null;
    }

    if (plan.status === planStore.STATUS.FAILED) {
        // A fresh explicit long request supersedes a failed plan (checked before
        // retry so "make a 60 second movie of X" is not a retry).
        if (isLongVideoRequest(text)) return null;
        if (responseIsApprove(text) || RETRY_RE.test(text)) return { action: ACTIONS.RETRY, direction: '' };
        if (responseIsPlanChange(text)) return { action: ACTIONS.MODIFY_PLAN, direction: text };
    }
    return null;
}

function responseIsApprove(text) {
    if (APPROVE_RE.test(text) || APPROVE_LOOSE_RE.test(text)) return true;
    if (looksLikeQuestion(text)) return false;
    return VIDEO_GO_RE.test(text);
}

function responseIsPlanChange(text) {
    if (looksLikeQuestion(text)) return false;
    if (isLongVideoRequest(text)) return false;
    return PLAN_CHANGE_RE.test(text);
}

// --- Markers / cards ----------------------------------------------------------

const MARKER_RE = /\n*\[\[longvideo:(\{[^\n]*?\})\]\]/g;

function compactBeats(plan) {
    return (plan.beats || []).map((b) => ({
        id: b.id,
        duration: b.duration,
        action: String(b.action || '').trim(),
        purpose: String(b.purpose || '').trim(),
        // Motion-continuity hint for the storyboard card: how this beat opens
        // relative to the previous one.
        mode: b.transition_mode || 'continuous_transition',
        continuation: b.transition_from_previous
            ? String(b.transition_from_previous.initial_continuation || '').trim()
            : ''
    }));
}

function markerData(plan) {
    return {
        id: plan.id,
        status: plan.status,
        duration: plan.duration,
        shots: (plan.beats || []).length,
        composer: plan.composer,
        video: plan.videoUrl || null,
        error: plan.error || '',
        beats: compactBeats(plan),
        stages: (plan.stages || []).map((s) => ({ id: s.id, status: s.status }))
    };
}

function markerLine(plan) {
    return '\n\n[[longvideo:' + JSON.stringify(markerData(plan)) + ']]';
}

function stripMarkers(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(MARKER_RE, '')
        .trim();
}

function extractMarkers(markdown) {
    return String(markdown || '').replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function buildCard(plan, content) {
    return Object.assign({ planId: plan.id, content }, markerData(plan));
}

function beatListMarkdown(plan) {
    return (plan.beats || []).map((b) => {
        const number = String(b.id).padStart(2, '0');
        const action = String(b.action || b.purpose || '').trim() || 'Continues the sequence.';
        return number + ' \u00b7 ' + b.duration + 's\n' + action;
    }).join('\n\n');
}

function renderStoryboardContent(plan) {
    const count = (plan.beats || []).length;
    const changeNote = plan.composer === 'fallback'
        ? '\n\n_Heads up: the planner model was unavailable, so this is a simple split of your request._'
        : '';
    const abruptCount = (plan.beats || []).filter((b) => b.transition_mode === 'abrupt_transition').length;
    const motionNote = count > 1
        ? (abruptCount
            ? '\n\nEach beat continues the previous beat\'s camera and subject motion, with ' +
              abruptCount + ' deliberate hard cut' + (abruptCount === 1 ? '' : 's') + '.'
            : '\n\nEach beat continues the previous beat\'s camera and subject motion, then transitions into its new action.')
        : '';
    return '**Long Video Director** \u2014 I\'ve planned your ' + plan.duration + '-second video' +
        (plan.sourceImage ? ' from your reference image' : '') + ':\n\n' +
        beatListMarkdown(plan) +
        '\n\n' + count + ' H3 beat' + (count === 1 ? '' : 's') +
        ', capped at 15s each. The LongVideos node chains them into one continuous video.' +
        motionNote + changeNote + markerLine(plan);
}

function renderGeneratingContent(plan) {
    return '**Long Video Director** \u2014 Rendering your ' + plan.duration + '-second video' +
        ((plan.beats || []).length ? ' (' + plan.beats.length + ' beats)' : '') + '\u2026' +
        markerLine(plan);
}

function renderCompleteContent(plan, videoMarkdown) {    return '**Long Video Director** \u2014 Your ' + plan.duration + '-second video is ready' +
        ((plan.beats || []).length ? ' (' + plan.beats.length + ' beats)' : '') + '.\n\n' +
        videoMarkdown + markerLine(plan);
}

function renderFailureContent(plan, message) {
    return '**Long Video Director** \u2014 The long video failed to render.\n\n' +
        String(message || plan.error || 'Generation failed.') +
        '\n\nYour approved storyboard is saved — retry to render it again.' +
        markerLine(plan);
}

function renderCancelledContent(plan) {
    return '**Long Video Director** \u2014 Long video cancelled.' + markerLine(plan);
}

module.exports = {
    MAX_SHORT_SECONDS,
    MAX_LONG_SECONDS,
    ACTIONS,
    STATUS: planStore.STATUS,
    parseRequestedSeconds,
    isLongVideoRequest,
    resolveSourceImage,
    parseJsonObject,
    mergeBeatsWithBudget,
    primarySubjectName,
    buildStoryBible,
    buildBeats,
    createFromRequest,
    applyStoryboardUpdate,
    classifyMessage,
    normalizeAction,
    responseIsApprove,
    responseIsPlanChange,
    markerData,
    markerLine,
    stripMarkers,
    extractMarkers,
    buildCard,
    renderStoryboardContent,
    renderGeneratingContent,
    renderCompleteContent,
    renderFailureContent,
    renderCancelledContent,
    getPlan: planStore.get,
    isOpen: planStore.isOpen,
    isActive: planStore.isActive,
    isAwaitingStoryboard: planStore.isAwaitingStoryboard,
    removePlan: planStore.remove,
    patchPlan: planStore.patch,
    setStage: planStore.setStage,
    advanceStage: planStore.advanceStage,
    completeStages: planStore.completeStages,
    generateLongVideo: generator.generateLongVideo,
    motion
};
