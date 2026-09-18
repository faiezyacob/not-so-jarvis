/* ============================================
   JARVIS — Director
   Lightweight coordinator for multi-stage
   creative jobs. The Director decides WHAT
   should happen next (opening frame, approval,
   video direction); the existing image and H3
   video pipelines decide HOW to execute it.
   It never talks to ComfyUI directly.
   ============================================ */

const path = require('path');

const providers = require('../../server/providers');
const imageGenerator = require('../image-generator');
const videoGenerator = require('../video-generator');
const productionPlan = require('./production-plan');
const approval = require('./approval-manager');
const prompts = require('./director-prompts');

// "Production" language: distinguishes a multi-stage production request
// (movie/film/commercial/cinematic, or a timed video built from an existing
// image) from a plain single video request. Exposed for routing/tests.
const PRODUCTION_NOUN_RE =
    /\b(?:movie|short[\s-]*film|feature[\s-]*film|documentary|commercial|trailer|teaser|cinematic\s+(?:video|film|movie|clip|sequence|short|scene)|multi[\s-]?shot(?:\s+sequence)?|storyboard|video\s+production|film\s+production)\b/i;
const MEDIUM_RE = /\b(?:video|movie|film|clip|animation|footage|reel)\b/i;
const DIRECTOR_MODE_RE =
    /\b(?:director\s+mode|as\s+(?:a|the)\s+director|direct\s+(?:this|a|the)\s+(?:movie|film|video|scene|shot)|production\s+mode|multi[-\s]?stage\s+(?:production|video))\b/i;
const GENERATION_VERB_RE = /\b(?:generat|creat|mak|render|produc|shoot|direct|turn|animat)\w*/i;
const IMAGE_SOURCE_RE = /\b(?:this|that|the|my|same)\s+(?:image|photo|picture|character|frame)\b|\b(?:her|him|them|this character|the character)\b/i;
const DURATION_RE =
    /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s*(?:-|to)?\s*(?:seconds?|secs?|minutes?)\b/i;

// Parse the brief JSON the LLM returns, tolerating fences/commentary.
function parseBriefJson(raw) {
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

// Merge LLM output over a fallback brief. Request-level fields the model leaves
// blank fall back to the heuristic values so the brief is never empty.
function mergeBrief(base, parsed) {
    const out = productionPlan.normalizeBrief(base);
    if (!parsed) return out;
    for (const key of Object.keys(out)) {
        if (key === 'explicitConstraints') {
            if (Array.isArray(parsed.explicitConstraints) && parsed.explicitConstraints.length) {
                out.explicitConstraints = parsed.explicitConstraints;
            }
            continue;
        }
        if (key === 'shotList') {
            if (Array.isArray(parsed.shotList) && parsed.shotList.length) {
                out.shotList = parsed.shotList;
            }
            continue;
        }
        const value = parsed[key];
        if (value !== undefined && value !== null && String(value).trim()) {
            out[key] = String(value).trim();
        }
    }
    if (/^\d+$/.test(String(parsed.shots || '')) && Number(parsed.shots) > 1) {
        out.shots = String(Math.min(8, Math.round(Number(parsed.shots))));
    }
    return productionPlan.normalizeBrief(out);
}

async function buildBrief({ message, provider, model, think }) {
    const fallback = prompts.heuristicBrief(message);
    const userMessage =
        'USER PRODUCTION REQUEST:\n"' + message + '"\n\n' +
        'Output the creative brief JSON only.';
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.BRIEF_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ], model, { think, temperature: 0 });
        const parsed = parseBriefJson(raw);
        if (parsed) return mergeBrief(fallback, parsed);
    } catch (err) {
        console.warn('[director] brief extraction failed, using heuristic:', err.message);
    }
    return mergeBrief(fallback, null);
}

async function updateBrief(currentBrief, feedback, { provider, model, think }) {
    const current = productionPlan.normalizeBrief(currentBrief);
    const userMessage =
        'CURRENT CREATIVE BRIEF:\n' + JSON.stringify(current, null, 2) + '\n\n' +
        'DIRECTION CHANGE:\n"' + String(feedback || '') + '"\n\n' +
        'Output the updated brief JSON only.';
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.BRIEF_UPDATE_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ], model, { think, temperature: 0 });
        const parsed = parseBriefJson(raw);
        if (parsed) {
            const merged = mergeBrief(current, parsed);
            merged.originalRequest = current.originalRequest;
            return merged;
        }
    } catch (err) {
        console.warn('[director] brief update failed:', err.message);
    }
    return current;
}

// True when the message asks for a multi-stage production rather than a single
// generation. Exposed as a detection helper; it no longer gates the Director
// (video requests run directly unless the user explicitly asks for Director).
function detectProductionRequest(message, opts = {}) {
    const text = String(message || '').trim();
    if (!text) return false;
    if (/\?\s*$/.test(text) && !PRODUCTION_NOUN_RE.test(text)) return false;
    if (videoGenerator.isVideoConceptQuestion && videoGenerator.isVideoConceptQuestion(text)) return false;
    if (videoGenerator.isStillImageOnlyChange && videoGenerator.isStillImageOnlyChange(text)) return false;
    if (DIRECTOR_MODE_RE.test(text)) return true;
    if (!GENERATION_VERB_RE.test(text) && !IMAGE_SOURCE_RE.test(text)) return false;
    // A production noun ("movie", "commercial", "cinematic video", ...) marks
    // the request as multi-stage.
    if (PRODUCTION_NOUN_RE.test(text)) return true;
    // A bare duration + medium only counts when the request also builds on an
    // existing image ("turn this into a 10-second video"). A plain "5 second
    // video of a cat" stays on the normal video pipeline.
    if (DURATION_RE.test(text) && MEDIUM_RE.test(text) &&
        (IMAGE_SOURCE_RE.test(text) || videoGenerator.I2V_REF_RE.test(text))) {
        return true;
    }
    return false;
}

// The user explicitly asked to skip the workflow question and just generate.
const DIRECT_MODE_RE =
    /\b(?:direct\s+(?:video|generation)|plain\s+video|normal\s+video|no\s+director|skip\s+(?:the\s+)?director|without\s+(?:the\s+)?director|just\s+(?:generate\s+)?(?:the\s+)?video|generate\s+the\s+video\s+directly)\b/i;

function wantsDirectMode(message) {
    return DIRECT_MODE_RE.test(String(message || ''));
}

// Explicit "director mode" / "as a director" phrasing skips the question and
// goes straight to Director. Production nouns like "movie"/"commercial" do NOT
// count as explicit — those still ask (no guessing).
function wantsDirectorMode(message) {
    return DIRECTOR_MODE_RE.test(String(message || ''));
}

// The composer "Director Mode" toggle pre-selects the Director workflow: a
// fresh video request goes straight to the Director instead of the normal H3
// pipeline. It never overrides an explicit "just generate the video" and never
// re-routes a continue/modify turn of an active video task.
function shouldForceDirector(message, decision) {
    if (!decision || decision.task !== 'video_generation') return false;
    if (wantsDirectMode(message)) return false;
    return decision.intent === 'new_task' || decision.intent === 'switch_task';
}

function defaultVideoDuration() {
    try {
        const settings = videoGenerator.effectiveVideoSettings();
        const value = Number(settings && settings.h3Duration);
        if (Number.isFinite(value) && value > 0) return value;
    } catch (err) {
        // fall through to the H3 minimum
    }
    return videoGenerator.H3_MIN_SECONDS || 5;
}

// A source image only counts as the production's first frame when the user
// references an existing image (an @-picker reference or "this image"), never
// for a from-scratch text production.
function resolveExistingSource(conversationId, message, referenceImage) {
    if (referenceImage) {
        return path.basename(String(referenceImage).split('?')[0]);
    }
    const text = String(message || '');
    const referencesImage = IMAGE_SOURCE_RE.test(text) ||
        (videoGenerator.I2V_REF_RE && videoGenerator.I2V_REF_RE.test(text));
    if (!referencesImage) return null;
    const found = videoGenerator.resolveVideoSourceImage(conversationId);
    return found ? found.rawFilename : null;
}

// Create the production plan for a fresh request. The brief is canonical from
// here on; later stages are rebuilt from it, never from the raw message.
async function createProduction({ conversationId, message, provider, model, think, referenceImage }) {
    const parsedDuration = typeof videoGenerator.parseRequestedVideoDuration === 'function'
        ? videoGenerator.parseRequestedVideoDuration(message)
        : null;
    const duration = (parsedDuration !== null && parsedDuration !== undefined)
        ? parsedDuration
        : defaultVideoDuration();
    const brief = await buildBrief({ message, provider, model, think });
    const sourceImage = resolveExistingSource(conversationId, message, referenceImage);
    const production = productionPlan.create({
        conversationId,
        brief,
        video: { duration },
        sourceImage,
        originalRequest: message
    });
    if (sourceImage) {
        // Starting from an existing image: record it as the opening frame and
        // treat it as approved so the Director goes straight to the video stage.
        production.image = {
            url: '/generated/' + encodeURIComponent(sourceImage),
            rawFilename: sourceImage,
            prompt: brief.subject || '',
            seed: null,
            attributes: null,
            fromSource: true
        };
        production.status = productionPlan.STATUS.AWAITING_IMAGE_APPROVAL;
    }
    productionPlan.set(conversationId, production);
    return production;
}

// Build the opening-frame prompt from the brief via the existing image prompt
// builder. Stores the resulting prompt on the plan so regeneration reuses it.
async function buildImageStagePrompt(production, { provider, model, think }) {
    // While the brief is still the user's original ask, carry their exact
    // wording too; after a direction change the updated brief is authoritative.
    const authoritative = production.briefModified ? '' : production.brief.originalRequest;
    const concept = prompts.composeImageConcept(production.brief, { authoritative });
    const structuredRequest = {
        intent: 'image_generation',
        user_prompt: concept,
        previous_prompt: '',
        creative_mode: 'none',
        explicit_constraints: production.brief.explicitConstraints || []
    };
    let prompt = concept;
    let attributes = null;
    try {
        const enhanced = await imageGenerator.buildImagePrompt(
            structuredRequest, providers, provider, model, think
        );
        if (enhanced && enhanced.prompt) {
            prompt = enhanced.prompt;
            attributes = enhanced.attributes || null;
        }
    } catch (err) {
        console.warn('[director] image prompt build failed, using concept:', err.message);
    }
    production.image = Object.assign({}, production.image || {}, {
        prompt,
        attributes,
        fromSource: false
    });
    productionPlan.set(production.conversationId, production);
    return prompt;
}

// Apply a direction change to the canonical brief, then rebuild the opening
// frame prompt from the updated brief (never by appending to the old prompt).
async function applyDirectionUpdate(production, feedback, { provider, model, think }) {
    production.brief = await updateBrief(production.brief, feedback, { provider, model, think });
    // The brief is now the user's edited intent, so stop carrying the original
    // request verbatim (it would reassert the pre-edit direction).
    production.briefModified = true;
    productionPlan.set(production.conversationId, production);
    return buildImageStagePrompt(production, { provider, model, think });
}

function markImageReady(production, { url, rawFilename, prompt, seed }) {
    production.image = {
        url,
        rawFilename: rawFilename || path.basename(String(url || '').split('?')[0]),
        prompt: prompt || (production.image && production.image.prompt) || '',
        seed: Number.isFinite(Number(seed)) ? Number(seed) : null,
        attributes: (production.image && production.image.attributes) || null,
        fromSource: false
    };
    production.status = productionPlan.STATUS.AWAITING_IMAGE_APPROVAL;
    production.error = '';
    productionPlan.setStage(production, 'image', 'completed', { assetId: production.image.rawFilename });
    productionPlan.setStage(production, 'image_approval', 'pending');
    productionPlan.setStage(production, 'video', 'pending');
    production.currentStage = 'image_approval';
    productionPlan.set(production.conversationId, production);
    return production;
}

function markImageRunning(production) {
    production.status = productionPlan.STATUS.GENERATING_IMAGE;
    production.error = '';
    productionPlan.setStage(production, 'image', 'running');
    production.currentStage = 'image';
    productionPlan.set(production.conversationId, production);
    return production;
}

function markVideoRunning(production) {
    production.status = productionPlan.STATUS.GENERATING_VIDEO;
    production.error = '';
    productionPlan.setStage(production, 'image_approval', 'approved');
    productionPlan.setStage(production, 'video', 'running');
    production.currentStage = 'video';
    productionPlan.set(production.conversationId, production);
    return production;
}

function markImageFailed(production, message) {
    production.status = productionPlan.STATUS.FAILED_IMAGE;
    production.error = String(message || 'Image generation failed.');
    productionPlan.setStage(production, 'image', 'failed');
    production.currentStage = 'image';
    productionPlan.set(production.conversationId, production);
    return production;
}

function markVideoReady(production, { url, prompt }) {
    production.videoUrl = url || null;
    if (prompt) production.videoPrompt = prompt;
    production.status = productionPlan.STATUS.COMPLETED;
    production.error = '';
    productionPlan.setStage(production, 'video', 'completed', { assetId: path.basename(String(url || '').split('?')[0]) });
    production.currentStage = null;
    productionPlan.set(production.conversationId, production);
    return production;
}

function markVideoFailed(production, message) {
    production.status = productionPlan.STATUS.FAILED_VIDEO;
    production.error = String(message || 'Video generation failed.');
    productionPlan.setStage(production, 'video', 'failed');
    production.currentStage = 'video';
    productionPlan.set(production.conversationId, production);
    return production;
}

function cancel(production) {
    production.status = productionPlan.STATUS.CANCELLED;
    production.currentStage = null;
    productionPlan.set(production.conversationId, production);
    return production;
}

// Build the H3 video-direction request from the approved frame + canonical
// brief + requested duration. Returns everything handleVideoGenerationStream
// needs; the H3 director LLM (reused, not reimplemented) writes the prompt.
async function buildVideoStageRequest(production, { provider, model, think }) {
    const sourceImageRawFilename =
        (production.image && production.image.rawFilename) || production.sourceImage || null;
    const duration = Number(production.video && production.video.duration) > 0
        ? Number(production.video.duration)
        : defaultVideoDuration();
    const authoritative = production.briefModified ? '' : production.brief.originalRequest;
    // A Director production is cut like a film: plan the shot list up front so
    // the direction, the H3 system prompt addendum, and the state all agree.
    const shotList = prompts.planShots(production.brief, duration, { authoritative });
    const structuredRequest = {
        intent: 'video_generation',
        action: 'generate',
        user_prompt: prompts.composeVideoDirection(production.brief, duration, { authoritative, shotList }),
        previous_prompt: '',
        creative_mode: 'none',
        has_reference_image: Boolean(sourceImageRawFilename),
        requested_duration: duration,
        explicit_constraints: production.brief.explicitConstraints || [],
        shots: shotList.length,
        shot_plan: shotList,
        multi_shot: shotList.length > 1,
        parameters: {}
    };
    const director = await videoGenerator.buildH3VideoPrompt(
        structuredRequest,
        providers,
        provider,
        model,
        sourceImageRawFilename,
        production.conversationId,
        think
    );
    // Record the planned cut count on the production so the card can show it.
    production.video = Object.assign({}, production.video, { shots: shotList.length });
    productionPlan.set(production.conversationId, production);
    return {
        videoPrompt: director.prompt,
        structuredRequest,
        videoMode: sourceImageRawFilename ? 'i2va' : 't2va',
        sourceImageRawFilename,
        duration: director.duration || duration,
        width: director.width,
        height: director.height
    };
}

// --- Card / marker rendering --------------------------------------------------

function markerData(production) {
    return {
        id: production.id,
        status: production.status,
        duration: (production.video && production.video.duration) || null,
        shots: shotCountOf(production) || null
    };
}

function markerLine(production) {
    return '\n\n[[director:' + JSON.stringify(markerData(production)) + ']]';
}

const MARKER_RE = /\n*\[\[director:(\{[^\n]*?\})\]\]/g;

function stripMarkers(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(MARKER_RE, '')
        .trim();
}

function durationLabel(production) {
    const d = Number(production.video && production.video.duration);
    return Number.isFinite(d) && d > 0 ? d + '-second' : 'short';
}

function imageUrlOf(production) {
    return (production.image && production.image.url) || null;
}

// How many shots the production is cut into (2+ means a real cut sequence).
function shotCountOf(production) {
    if (!production) return 0;
    const stored = Number(production && production.video && production.video.shots);
    if (Number.isFinite(stored) && stored > 0) return stored;
    try {
        const duration = Number(production && production.video && production.video.duration) || 0;
        const authoritative = production.briefModified
            ? ''
            : ((production.brief && production.brief.originalRequest) || '');
        return prompts.planShots((production && production.brief) || {}, duration, { authoritative }).length;
    } catch (err) {
        return 0;
    }
}

function shotCountLabel(production) {
    const count = shotCountOf(production);
    return count > 1 ? count + '-shot' : '';
}

// The persisted assistant message for the approval checkpoint: director intro,
// the opening frame, and the marker the UI turns into the action card.
function renderImageApprovalContent(production, imageMarkdown) {
    const plan = shotCountLabel(production);
    const intro =
        '**Director** \u2014 Opening frame ready.\n\n' +
        'I\'ve created the proposed opening frame for your ' + durationLabel(production) +
        ' video. This image will be used as the starting frame.' +
        (plan ? ' I\'ll direct it as a ' + plan + ' sequence.' : '');
    return intro + '\n\n' + imageMarkdown + markerLine(production);
}

function renderVideoCompleteContent(production, videoMarkdown) {
    const plan = shotCountLabel(production);
    const intro =
        '**Director** \u2014 Your ' + durationLabel(production) +
        ' video is ready.' + (plan ? ' Cut as a ' + plan + ' sequence.' : '');
    return intro + '\n\n' + videoMarkdown + markerLine(production);
}

function renderFailureContent(production, stage, message) {
    const intro =
        '**Director** \u2014 ' +
        (stage === 'video' ? 'Video' : 'Opening frame') + ' generation failed.\n\n' +
        String(message || 'Generation failed.');
    return intro + markerLine(production);
}

function renderCancelledContent(production) {
    return '**Director** \u2014 Production cancelled.' + markerLine(production);
}

// Build the SSE `director` payload the client renders.
function buildCard(production, content) {
    return {
        productionId: production.id,
        status: production.status,
        duration: (production.video && production.video.duration) || null,
        shots: shotCountOf(production) || null,
        image: imageUrlOf(production),
        video: production.videoUrl || null,
        error: production.error || '',
        content
    };
}

module.exports = {
    STATUS: productionPlan.STATUS,
    ACTIONS: approval.ACTIONS,
    detectProductionRequest,
    wantsDirectMode,
    wantsDirectorMode,
    shouldForceDirector,
    createProduction,
    buildImageStagePrompt,
    applyDirectionUpdate,
    buildVideoStageRequest,
    markImageRunning,
    markVideoRunning,
    markImageReady,
    markImageFailed,
    markVideoReady,
    markVideoFailed,
    cancel,
    buildCard,
    renderImageApprovalContent,
    renderVideoCompleteContent,
    renderFailureContent,
    renderCancelledContent,
    stripMarkers,
    durationLabel,
    shotCountOf,
    getProduction: productionPlan.get,
    isOpen: productionPlan.isOpen,
    isAwaitingApproval: productionPlan.isAwaitingApproval,
    isActive: productionPlan.isActive,
    removeProduction: productionPlan.remove,
    normalizeAction: approval.normalizeAction,
    classifyMessage: approval.classifyMessage,
    validateAction: approval.validate,
    // exposed for tests
    parseBriefJson,
    mergeBrief,
    updateBrief,
    buildBrief,
    resolveExistingSource
};
