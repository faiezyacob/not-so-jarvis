/* ============================================
   JARVIS — UGC Studio
   The conversational workflow layer that turns a
   natural-language UGC request into a structured
   project (brief -> product -> creator -> outfit ->
   environment -> script -> scenes -> references)
   and hands the approved plan to the existing
   Director Mode for the final video.

   The studio owns the stage machine and the
   project state. It never talks to ComfyUI; image
   and video execution stay in the existing
   pipelines, and the final prompt wording is always
   produced by imageGenerator.buildImagePrompt.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const providers = require('../../server/providers');
const imageGenerator = require('../image-generator');
const characterPresets = require('../character-presets');
const characterGen = require('../playground/character');
const outfitPacks = require('../playground/outfit-packs');
const state = require('./state');
const products = require('./products');
const catalog = require('./catalog');
const prompts = require('./prompts');

const STATUS = state.STATUS;

const STAGES = Object.freeze({
    IDLE: 'idle',
    BRIEF: 'brief',
    PRODUCT_SELECTION: 'product_selection',
    CREATOR_SELECTION: 'creator_selection',
    CREATIVE_DIRECTION: 'creative_direction',
    SCRIPT_REVIEW: 'script_review',
    SCENE_REVIEW: 'scene_review',
    REFERENCE_GENERATION: 'reference_generation',
    REFERENCE_APPROVAL: 'reference_approval',
    VIDEO_GENERATION: 'video_generation',
    COMPLETED: 'completed'
});

const ACTIONS = Object.freeze({
    SELECT_PRODUCT: 'select_product',
    CREATE_PRODUCT: 'create_product',
    DELETE_PRODUCT: 'delete_product',
    SELECT_CREATOR: 'select_creator',
    CREATE_CREATOR: 'create_creator',
    RANDOM_CREATOR: 'random_creator',
    SKIP_CREATOR: 'skip_creator',
    SELECT_OUTFIT: 'select_outfit',
    SELECT_ENVIRONMENT: 'select_environment',
    SELECT_CONTENT_TYPE: 'select_content_type',
    APPROVE_BRIEF: 'approve_brief',
    EDIT_BRIEF: 'edit_brief',
    REGENERATE_BRIEF: 'regenerate_brief',
    APPROVE_SCRIPT: 'approve_script',
    EDIT_SCRIPT: 'edit_script',
    REGENERATE_SCRIPT: 'regenerate_script',
    CHANGE_TONE: 'change_tone',
    CHANGE_HOOK: 'change_hook',
    APPROVE_SCENES: 'approve_scenes',
    EDIT_SCENE: 'edit_scene',
    REGENERATE_SCENE: 'regenerate_scene',
    ADD_SCENE: 'add_scene',
    DELETE_SCENE: 'delete_scene',
    MOVE_SCENE: 'move_scene',
    GENERATE_REFERENCES: 'generate_references',
    REGENERATE_REFERENCES: 'regenerate_references',
    REGENERATE_REFERENCE: 'regenerate_reference',
    RETRY_FAILED: 'retry_failed',
    EDIT_DIRECTION: 'edit_direction',
    APPROVE_REFERENCES: 'approve_references',
    CONTINUE_DIRECTOR: 'continue_director',
    CONFIRM_DURATION: 'confirm_duration',
    SAVE_DRAFT: 'save_draft',
    EXIT: 'exit',
    RESUME: 'resume',
    DISCARD: 'discard',
    VIEW_BRIEF: 'view_brief'
});

const MARKER_RE = /\[\[ugc:(\{[^\n]*?\})\]\]/g;

// The canonical brief schema. Every field here must survive extraction,
// normalization, save/reload and regeneration — no step may drop one.
const BRIEF_FIELDS = Object.freeze([
    'objective', 'productName', 'brand', 'productCategory', 'contentType', 'platform',
    'duration', 'aspectRatio', 'targetAudience', 'tone', 'keyMessage', 'callToAction',
    'environment', 'dialogueLanguage', 'creatorDescription', 'additionalInstructions'
]);

// --- Action / stage validation ------------------------------------------------
//
// The server must never trust the UI to enforce workflow order. Every action is
// validated against the project's current stage (and status) before it runs.
const SETUP_STAGES = ['product_selection', 'creator_selection', 'creative_direction'];
const SCRIPT_STAGES = ['script_review'];
const SCRIPT_OR_SCENE_STAGES = ['script_review', 'scene_review'];
const SCENE_STAGES = ['scene_review', 'reference_generation', 'reference_approval'];
const REFERENCE_STAGES = ['reference_generation', 'reference_approval'];

const ACTION_RULES = Object.freeze({
    [ACTIONS.SELECT_PRODUCT]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.CREATE_PRODUCT]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.DELETE_PRODUCT]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.SELECT_CREATOR]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.CREATE_CREATOR]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.RANDOM_CREATOR]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.SKIP_CREATOR]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.SELECT_OUTFIT]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.SELECT_ENVIRONMENT]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.SELECT_CONTENT_TYPE]: { stages: SETUP_STAGES.concat(['brief']) },
    [ACTIONS.EDIT_BRIEF]: { stages: ['brief'] },
    [ACTIONS.REGENERATE_BRIEF]: { stages: ['brief'] },
    [ACTIONS.APPROVE_BRIEF]: { stages: ['brief'] },
    [ACTIONS.EDIT_SCRIPT]: { stages: SCRIPT_OR_SCENE_STAGES },
    [ACTIONS.REGENERATE_SCRIPT]: { stages: SCRIPT_OR_SCENE_STAGES },
    [ACTIONS.CHANGE_TONE]: { stages: SCRIPT_OR_SCENE_STAGES },
    [ACTIONS.CHANGE_HOOK]: { stages: SCRIPT_OR_SCENE_STAGES },
    [ACTIONS.APPROVE_SCRIPT]: { stages: SCRIPT_STAGES },
    [ACTIONS.EDIT_SCENE]: { stages: SCENE_STAGES },
    [ACTIONS.ADD_SCENE]: { stages: SCENE_STAGES },
    [ACTIONS.DELETE_SCENE]: { stages: SCENE_STAGES },
    [ACTIONS.MOVE_SCENE]: { stages: SCENE_STAGES },
    [ACTIONS.REGENERATE_SCENE]: { stages: SCENE_STAGES },
    [ACTIONS.APPROVE_SCENES]: { stages: ['scene_review'] },
    [ACTIONS.GENERATE_REFERENCES]: { stages: REFERENCE_STAGES },
    [ACTIONS.REGENERATE_REFERENCES]: { stages: REFERENCE_STAGES },
    [ACTIONS.REGENERATE_REFERENCE]: { stages: REFERENCE_STAGES },
    [ACTIONS.RETRY_FAILED]: { stages: REFERENCE_STAGES },
    [ACTIONS.EDIT_DIRECTION]: { stages: REFERENCE_STAGES },
    [ACTIONS.APPROVE_REFERENCES]: { stages: ['reference_approval'] },
    [ACTIONS.CONTINUE_DIRECTOR]: { stages: ['reference_approval'] },
    [ACTIONS.CONFIRM_DURATION]: { stages: ['reference_approval'] },
    // Lifecycle actions are always available.
    [ACTIONS.SAVE_DRAFT]: { stages: '*' },
    [ACTIONS.EXIT]: { stages: '*' },
    [ACTIONS.RESUME]: { stages: '*' },
    [ACTIONS.DISCARD]: { stages: '*' },
    [ACTIONS.VIEW_BRIEF]: { stages: '*' }
});

// Whether an action may run against the project's current state. Returns
// { ok:true } or { ok:false, error }. Lifecycle actions always pass; everything
// else is rejected on a completed project or a stage the action does not serve.
function validateAction(project, type) {
    if (!project) return { ok: false, error: 'There is no active UGC project.' };
    const rule = ACTION_RULES[type];
    if (!rule) return { ok: false, error: 'Unknown UGC Studio action.' };
    if (rule.stages === '*') {
        if (type === ACTIONS.RESUME && project.status !== STATUS.DRAFT) {
            return { ok: false, error: 'This project is not a draft.' };
        }
        return { ok: true };
    }
    if (project.status === STATUS.COMPLETED) {
        return { ok: false, error: 'This UGC production is already complete.' };
    }
    if (!rule.stages.includes(project.stage)) {
        return {
            ok: false,
            error: 'That action is not available at the "' + project.stage + '" stage.'
        };
    }
    return { ok: true };
}

// --- Reference plan fingerprint -----------------------------------------------
//
// Every reference frame is stamped with a fingerprint of the visual plan that
// produced it. Any visual change (scene, script dialogue, brief duration,
// product, creator, outfit, environment, direction) changes the fingerprint, so
// a frame generated for an older plan can never be mixed with a newer one or
// approved.

function hashString(value) {
    let hash = 5381;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
}

function currentPlanHash(project) {
    if (!project) return '';
    const creator = project.creator || {};
    const outfit = project.outfit || {};
    const environment = project.environment || {};
    const product = project.product || {};
    const brief = project.brief || {};
    const parts = [
        'mode:' + (project.creatorMode || (project.creator ? 'person' : 'none')),
        'creator:' + [creator.name, creator.identity, creator.appearance, creator.hair].join('|'),
        'outfit:' + (outfit.outfit || outfit.label || ''),
        'env:' + (environment.description || environment.label || ''),
        'product:' + [product.name, product.brand, product.description].join('|'),
        'aspect:' + (brief.aspectRatio || '9:16'),
        'duration:' + (brief.duration || '')
    ];
    for (const scene of (project.scenes || [])) {
        const camera = scene.camera || {};
        parts.push([
            scene.id, scene.order, scene.duration, scene.action,
            camera.shotType, camera.movement, camera.framing,
            scene.productVisibility, scene.environment, scene.outfit
        ].join('~'));
    }
    return hashString(parts.join('\n'));
}

// --- Intent detection ---------------------------------------------------------

// A UGC request is a video/creative request that also asks for user-generated
// content framing (UGC, creator-style ad, TikTok/Reels ad, product video, ...).
const UGC_NOUN_RE =
    /\b(?:ugc|user[\s-]?generated\s+content|creator[\s-]?style[d]?|influencer|tiktok\s+ad|instagram\s+(?:ad|reel)|product\s+(?:video|ad|demo(?:nstration)?|testimonial|unboxing|showcase|routine)|unboxing\s+video|brand\s+(?:video|content)|testimonial\s+video|lifestyle\s+content|routine\s+video|(?:video|ad|reel|content)\s+(?:featuring|for|with)\s+my\s+(?:product|brand|business))\b/i;
const UGC_MEDIA_RE = /\b(?:video|ad|advert|content|reel|short|clip|commercial)\b/i;
const UGC_ACTION_RE =
    /\b(?:make|create|generate|produce|film|shoot|build|design|write|draft|compose|need|want|looking\s+for|give\s+me)\b/i;

// "Write me a UGC script" / "give me a UGC concept" are UGC workflow entries
// that must NOT trigger image/video generation on their own.
const UGC_SCRIPT_RE = /\b(?:ugc\s+)?(?:script|storyboard|concept|idea|hook)\b/i;

function detectUgcIntent(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    const hasNoun = UGC_NOUN_RE.test(text);
    const hasUgc = /\bugc\b/i.test(text);
    if (!hasNoun && !hasUgc) return false;
    // A UGC/workflow action is required so unrelated chat about a "creator-style
    // video someone watched" does not start a project.
    const action = UGC_ACTION_RE.test(text) || UGC_SCRIPT_RE.test(text) ||
        /\bfor\s+my\s+(?:product|brand|business)\b/i.test(text);
    if (!action) return false;
    // A bare "ugc" mention still needs a media/script/product context.
    if (!hasNoun && !(UGC_MEDIA_RE.test(text) || UGC_SCRIPT_RE.test(text))) return false;
    return true;
}

function isScriptOnlyRequest(message) {
    const text = String(message || '');
    return UGC_SCRIPT_RE.test(text) && !UGC_MEDIA_RE.test(text);
}

// --- Small helpers ------------------------------------------------------------

function makeId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || 1200);
}

function parseJson(raw) {
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

function hasOwn(obj, key) {
    return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// --- Normalization ------------------------------------------------------------

function normalizeBrief(input) {
    const src = input && typeof input === 'object' ? input : {};
    const durationCheck = prompts.validateDuration(src.duration);
    return {
        objective: clean(src.objective),
        productName: clean(src.productName, 120),
        brand: clean(src.brand, 120),
        productCategory: clean(src.productCategory, 120),
        contentType: clean(src.contentType, 60),
        platform: clean(src.platform, 60),
        duration: durationCheck.valid ? durationCheck.value : null,
        aspectRatio: clean(src.aspectRatio, 12) || '9:16',
        targetAudience: clean(src.targetAudience),
        tone: clean(src.tone, 200),
        keyMessage: clean(src.keyMessage),
        callToAction: clean(src.callToAction),
        environment: clean(src.environment, 200),
        dialogueLanguage: clean(src.dialogueLanguage, 40),
        creatorDescription: clean(src.creatorDescription, 400),
        additionalInstructions: clean(src.additionalInstructions)
    };
}

function normalizeScript(input) {
    if (!input || typeof input !== 'object') return null;
    const hook = clean(input.hook);
    const main = clean(input.main);
    const productInteraction = clean(input.productInteraction);
    const closing = clean(input.closing);
    const fullText = clean(input.fullText) ||
        [hook, main, productInteraction, closing].filter(Boolean).join(' ');
    return {
        hook,
        main,
        productInteraction,
        closing,
        fullText,
        tone: clean(input.tone, 200),
        hookStyle: clean(input.hookStyle, 60),
        approved: input.approved === true,
        source: clean(input.source, 30) || 'llm',
        creatorName: clean(input.creatorName, 80),
        claims: Array.isArray(input.claims) ? input.claims.map((c) => clean(c, 40)).filter(Boolean) : [],
        needsConfirmation: input.needsConfirmation === true
    };
}

function normalizeCamera(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
        shotType: clean(src.shotType, 120),
        movement: clean(src.movement, 120),
        framing: clean(src.framing, 120)
    };
}

function normalizeScene(input, index) {
    const src = input && typeof input === 'object' ? input : {};
    const durationCheck = prompts.validateDuration(src.duration);
    return {
        id: clean(src.id, 40) || ('scn_' + (index + 1)),
        order: index + 1,
        duration: durationCheck.valid ? durationCheck.value : 3,
        objective: clean(src.objective, 300),
        action: clean(src.action, 600),
        dialogue: clean(src.dialogue, 600),
        camera: normalizeCamera(src.camera),
        environment: clean(src.environment, 300),
        outfit: clean(src.outfit, 400),
        productVisibility: clean(src.productVisibility, 200),
        transition: clean(src.transition, 200),
        status: clean(src.status, 30) || 'planned',
        referenceUrl: clean(src.referenceUrl, 500) || null,
        needsConfirmation: src.needsConfirmation === true
    };
}

function normalizeCreator(input) {
    if (!input || typeof input !== 'object') return null;
    return {
        characterId: clean(input.characterId, 60) || null,
        source: clean(input.source, 30) || 'character',
        name: clean(input.name, 80),
        identity: clean(input.identity),
        appearance: clean(input.appearance),
        hair: clean(input.hair),
        appearanceCategory: clean(input.appearanceCategory, 60),
        appearanceCategoryLabel: clean(input.appearanceCategoryLabel, 120),
        outfitPack: clean(input.outfitPack, 60),
        outfitPackCustom: clean(input.outfitPackCustom)
    };
}

function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const project = {
        id: clean(raw.id, 60) || makeId('ugc'),
        conversationId: clean(raw.conversationId, 80),
        mode: 'ugc',
        status: Object.values(STATUS).includes(raw.status) ? raw.status : STATUS.ACTIVE,
        stage: Object.values(STAGES).includes(raw.stage) ? raw.stage : STAGES.BRIEF,
        version: Number.isFinite(Number(raw.version)) ? Math.max(0, Math.round(Number(raw.version))) : 0,
        request: clean(raw.request),
        product: raw.product && typeof raw.product === 'object' ? raw.product : null,
        creatorMode: raw.creatorMode === 'none' ? 'none' : (raw.creatorMode === 'person' ? 'person' : ''),
        creatorSkipped: raw.creatorSkipped === true,
        creator: normalizeCreator(raw.creator),
        outfit: raw.outfit && typeof raw.outfit === 'object'
            ? {
                packId: clean(raw.outfit.packId, 60),
                label: clean(raw.outfit.label, 120),
                outfit: clean(raw.outfit.outfit)
            }
            : null,
        environment: raw.environment && typeof raw.environment === 'object'
            ? {
                id: clean(raw.environment.id, 60),
                label: clean(raw.environment.label, 120),
                description: clean(raw.environment.description, 300)
            }
            : null,
        contentType: raw.contentType && typeof raw.contentType === 'object'
            ? { id: clean(raw.contentType.id, 60), label: clean(raw.contentType.label, 120) }
            : null,
        brief: normalizeBrief(raw.brief),
        script: normalizeScript(raw.script),
        scenes: Array.isArray(raw.scenes) ? raw.scenes.map(normalizeScene) : [],
        continuity: raw.continuity && typeof raw.continuity === 'object'
            ? {
                creatorIdentity: clean(raw.continuity.creatorIdentity) || null,
                outfitState: clean(raw.continuity.outfitState) || null,
                environmentState: clean(raw.continuity.environmentState) || null,
                productState: clean(raw.continuity.productState) || null
            }
            : { creatorIdentity: null, outfitState: null, environmentState: null, productState: null },
        references: Array.isArray(raw.references)
            ? raw.references.map((r) => ({
                sceneId: clean(r && r.sceneId, 40),
                order: Number(r && r.order) || 0,
                url: clean(r && r.url, 500),
                filename: clean(r && r.filename, 300),
                prompt: clean(r && r.prompt, 2000),
                status: clean(r && r.status, 30) || 'ready',
                planHash: clean(r && r.planHash, 40),
                error: clean(r && r.error, 300)
            }))
            : [],
        approvedReferences: Array.isArray(raw.approvedReferences)
            ? raw.approvedReferences.map((r) => ({
                sceneId: clean(r && r.sceneId, 40),
                order: Number(r && r.order) || 0,
                url: clean(r && r.url, 500),
                filename: clean(r && r.filename, 300),
                planHash: clean(r && r.planHash, 40)
            }))
            : [],
        planHash: clean(raw.planHash, 40),
        referencesVersion: Number.isFinite(Number(raw.referencesVersion))
            ? Math.max(0, Math.round(Number(raw.referencesVersion))) : 0,
        durationConfirmed: raw.durationConfirmed === true,
        directorProductionId: clean(raw.directorProductionId, 60) || null,
        videoUrl: clean(raw.videoUrl, 500) || null,
        lastError: clean(raw.lastError, 500),
        suggestedProductName: clean(raw.suggestedProductName, 120),
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: raw.updatedAt || new Date().toISOString()
    };
    return project;
}

// --- Stage machine ------------------------------------------------------------

function nextSetupStage(project) {
    if (!project.product || !project.product.name) return STAGES.PRODUCT_SELECTION;
    const creatorSettled = Boolean(project.creator) || project.creatorMode === 'none' || project.creatorSkipped;
    if (!creatorSettled) return STAGES.CREATOR_SELECTION;
    if (!project.contentType || !project.outfit || !project.environment) return STAGES.CREATIVE_DIRECTION;
    return STAGES.BRIEF;
}

// Advance the setup stage only while the project is still in setup (or the
// brief). A selection made mid-workflow (a natural edit of the outfit or
// environment) must not reset the project back to the brief.
function advanceSetupStage(project) {
    if (SETUP_STAGES.includes(project.stage) || project.stage === STAGES.BRIEF) {
        project.stage = nextSetupStage(project);
    }
    return project.stage;
}

function markActive(project) {
    if (project.status === STATUS.DRAFT) project.status = STATUS.ACTIVE;
    return project;
}

function isActive(project) {
    return Boolean(project && project.status === STATUS.ACTIVE);
}

function isOpen(project) {
    if (!project || project.status === STATUS.COMPLETED) return false;
    return Boolean(project.status === STATUS.ACTIVE
        || project.stage === STAGES.REFERENCE_APPROVAL
        || project.stage === STAGES.SCENE_REVIEW
        || project.stage === STAGES.SCRIPT_REVIEW);
}

function save(project) {
    if (!project) return null;
    project.version = (Number(project.version) || 0) + 1;
    if (project.scenes && project.scenes.length) {
        reconcileContinuity(project);
        // Never persist a line that cannot be spoken inside its shot's duration;
        // an over-long line is delivered too fast and sounds robotic.
        prompts.enforceDialogueBudgets(project.scenes);
    }
    project.updatedAt = new Date().toISOString();
    state.setProject(project.conversationId, project);
    return project;
}

// Whether a card action carries an older project version than the live project
// (a stale card the user has moved on from). Typed decisions carry no version.
function isStaleAction(project, action) {
    if (!project || !action) return false;
    if (!Number.isFinite(Number(action.projectVersion))) return false;
    return Number(action.projectVersion) !== Number(project.version);
}

// --- Reference integrity ------------------------------------------------------

// Every scene's current reference status: pending (never generated), ready
// (generated for the current plan), stale (generated for an older plan), failed,
// or approved.
function referenceStatus(project, ref) {
    if (!ref) return 'pending';
    const current = currentPlanHash(project);
    if (ref.status === 'approved') return 'approved';
    if (ref.status === 'failed') return 'failed';
    if (ref.planHash && current && ref.planHash !== current) return 'stale';
    return ref.status === 'ready' ? 'ready' : (ref.status || 'pending');
}

// Drop the approval whenever the visual plan changes, and mark every existing
// frame stale so an old frame can never be approved or mixed with a new one.
function invalidateReferences(project) {
    if (!project) return project;
    project.approvedReferences = [];
    project.planHash = '';
    project.referencesVersion = (Number(project.referencesVersion) || 0) + 1;
    project.references = (project.references || []).map((r) =>
        Object.assign({}, r, { status: r.status === 'failed' ? 'failed' : 'stale' }));
    return project;
}

// True only when every scene has exactly one ready frame generated for the
// current plan.
function referencesComplete(project) {
    const scenes = project.scenes || [];
    if (!scenes.length) return false;
    const current = currentPlanHash(project);
    const byScene = new Map();
    for (const ref of (project.references || [])) {
        if (!ref || !ref.filename) continue;
        if (ref.status !== 'ready' && ref.status !== 'approved') continue;
        if (ref.planHash !== current) continue;
        byScene.set(ref.sceneId, (byScene.get(ref.sceneId) || 0) + 1);
    }
    return scenes.every((s) => byScene.get(s.id) === 1);
}

// --- Continuity ---------------------------------------------------------------

function reconcileContinuity(project) {
    if (!project) return project;
    const continuity = project.continuity || {};
    continuity.creatorIdentity = project.creator
        ? (project.creator.identity || project.creator.name || null)
        : null;
    continuity.outfitState = project.outfit ? (project.outfit.outfit || null) : null;
    continuity.environmentState = project.environment
        ? (project.environment.description || project.environment.label || null)
        : null;
    continuity.productState = project.product
        ? [project.product.name, project.product.description].filter(Boolean).join(' \u2014 ') || null
        : null;
    project.continuity = continuity;
    for (const scene of (project.scenes || [])) {
        if (!scene.environment) scene.environment = continuity.environmentState || '';
        if (!scene.outfit) scene.outfit = continuity.outfitState || '';
    }
    return project;
}

// --- Brief extraction ---------------------------------------------------------

function mergeBrief(fallback, parsed) {
    const out = normalizeBrief(fallback);
    if (!parsed) return out;
    const textKeys = ['objective', 'targetAudience', 'tone', 'keyMessage', 'callToAction',
        'additionalInstructions', 'productName', 'brand', 'productCategory', 'creatorDescription',
        'dialogueLanguage'];
    for (const key of textKeys) {
        const value = clean(parsed[key]);
        if (value) out[key] = value;
    }
    const durationCheck = prompts.validateDuration(parsed.duration);
    if (durationCheck.valid) out.duration = durationCheck.value;
    const aspect = clean(parsed.aspectRatio, 12);
    if (/^(?:9:16|16:9|1:1|4:5|3:4)$/.test(aspect)) out.aspectRatio = aspect;
    const contentType = catalog.getContentType(parsed.contentType);
    if (contentType) out.contentType = contentType.id;
    else if (!out.contentType && parsed.contentType) {
        const detected = catalog.detectContentType(parsed.contentType);
        if (detected) out.contentType = detected;
    }
    const platform = catalog.getPlatform(parsed.platform);
    if (platform) out.platform = platform.id;
    const environment = catalog.getEnvironment(parsed.environment);
    if (environment) out.environment = environment.id;
    else if (parsed.environment) out.environment = clean(parsed.environment, 200);
    return out;
}

async function extractBrief(message, { provider, model, think }) {
    const fallback = prompts.heuristicBrief(message);
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.BRIEF_SYSTEM_PROMPT },
            { role: 'user', content: 'USER REQUEST:\n"' + message + '"\n\nOutput the brief JSON only.' }
        ], model, { think: false, temperature: 0 });
        const parsed = parseJson(raw);
        if (parsed) return mergeBrief(fallback, parsed);
    } catch (err) {
        console.warn('[ugc] brief extraction failed, using heuristic:', err.message);
    }
    return mergeBrief(fallback, null);
}

function environmentFromBrief(brief) {
    if (!brief || !brief.environment) return null;
    const entry = catalog.getEnvironment(brief.environment);
    if (entry && entry.id !== 'custom') {
        return { id: entry.id, label: entry.label, description: entry.description };
    }
    return { id: 'custom', label: 'Custom', description: clean(brief.environment, 300) };
}

function contentTypeFromBrief(brief) {
    if (!brief || !brief.contentType) return null;
    const entry = catalog.getContentType(brief.contentType);
    if (entry) return { id: entry.id, label: entry.label };
    return null;
}

// --- Project lifecycle --------------------------------------------------------

async function createProject({ conversationId, message, provider, model, think }) {
    const brief = await extractBrief(message, { provider, model, think });
    // Only an exact product-name match binds automatically; a fuzzy match is
    // surfaced as a suggestion so the wrong product is never silently selected.
    const resolved = products.resolveByName(brief.productName);
    const project = normalizeProject({
        id: makeId('ugc'),
        conversationId,
        status: STATUS.ACTIVE,
        stage: STAGES.BRIEF,
        request: message,
        product: resolved.product ? products.snapshot(resolved.product) : null,
        environment: environmentFromBrief(brief),
        contentType: contentTypeFromBrief(brief),
        brief: Object.assign({}, brief, { duration: brief.duration || 15 }),
        suggestedProductName: (!resolved.product && brief.productName) ? brief.productName : '',
        continuity: {},
        createdAt: new Date().toISOString()
    });
    advanceSetupStage(project);
    save(project);
    return project;
}

function getProject(conversationId) {
    const raw = state.getProject(conversationId);
    if (!raw) return null;
    // Re-normalize on read so an older/partial persisted project is always safe.
    return normalizeProject(raw);
}

function removeProject(conversationId) {
    return state.removeProject(conversationId);
}

function listProjects() {
    return state.listProjects().map(normalizeProject).filter(Boolean);
}

function exitProject(project) {
    if (!project) return null;
    project.status = STATUS.DRAFT;
    return save(project);
}

function resumeProject(project) {
    if (!project) return null;
    project.status = STATUS.ACTIVE;
    return save(project);
}

// --- Selection actions --------------------------------------------------------

function selectProduct(project, productId) {
    const product = products.get(productId);
    if (!product) return project;
    project.product = products.snapshot(product);
    project.suggestedProductName = '';
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

function createProduct(project, input) {
    const payload = Object.assign({}, input);
    // The brief often already named the product; keep that name/brand.
    if (!payload.name && project.product && project.product.name) payload.name = project.product.name;
    const product = products.create(payload);
    project.product = products.snapshot(product);
    project.suggestedProductName = '';
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

// Remove a saved product from the library. The project keeps its own snapshot,
// so a project already using the product is unaffected.
function deleteProduct(project, productId) {
    const removed = products.remove(productId);
    if (!removed) return { ok: false, error: 'That product is no longer in the library.' };
    return { ok: true, project };
}

function selectCreator(project, characterId) {
    const preset = characterPresets.get(characterId);
    if (!preset) return project;
    project.creatorMode = 'person';
    project.creatorSkipped = false;
    project.creator = {
        characterId: preset.id,
        source: 'character',
        name: preset.name || 'Character',
        identity: preset.identityText || (preset.identity && preset.identity.identityText) || (typeof preset.identity === 'string' ? preset.identity : ''),
        appearance: preset.appearance || (preset.identity && preset.identity.skin ? [preset.identity.skin.tone, preset.identity.face && preset.identity.face.shape, preset.identity.eyes && preset.identity.eyes.color].filter(Boolean).join(', ') : ''),
        hair: preset.hair || (preset.identity && preset.identity.hair ? [preset.identity.hair.style, preset.identity.hair.texture, preset.identity.hair.color, 'hair'].filter(Boolean).join(' ') : ''),
        characterSnapshot: preset,
        appearanceCategory: preset.appearanceCategory || '',
        // Derive the label when an older preset stored only the category key,
        // so the creator's ethnicity survives into the image/video prompts.
        appearanceCategoryLabel: preset.appearanceCategoryLabel
            || (preset.appearanceCategory ? characterGen.appearanceCategoryLabel(preset.appearanceCategory) : ''),
        outfitPack: preset.outfitPack || '',
        outfitPackCustom: preset.outfitPackCustom || ''
    };
    // The creator's saved wardrobe personality seeds the outfit when the user
    // has not chosen one yet (a saved character keeps its wardrobe).
    if (!project.outfit && preset.outfit) {
        project.outfit = {
            packId: preset.outfitPack || '',
            label: preset.outfitPackCustom || '',
            outfit: preset.outfit
        };
    }
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

function randomCreator(project, profile) {
    const normalized = characterGen.normalizeProfile(profile);
    const generated = characterGen.generateUniqueIdentity(Math.random, [], normalized);
    project.creatorMode = 'person';
    project.creatorSkipped = false;
    project.creator = {
        characterId: null,
        source: 'random',
        name: generated.name || 'Creator',
        identity: generated.identityText || '',
        appearance: characterGen.formatAppearance(generated),
        hair: characterGen.formatHair(generated),
        appearanceCategory: generated.appearanceCategory || '',
        appearanceCategoryLabel: characterGen.appearanceCategoryLabel(generated.appearanceCategory),
        characterProfile: normalized,
        characterSeed: generated.seed
    };
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

// Product-only UGC: the user explicitly skips the on-camera creator. No person
// is invented later by the script, scene or Director prompts.
function skipCreator(project) {
    project.creator = null;
    project.creatorMode = 'none';
    project.creatorSkipped = true;
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

// Resolve an Outfit Pack into a concrete outfit (never pass the pack name alone
// to the image/video model).
function selectOutfit(project, packId, customText, rng) {
    const normalized = outfitPacks.normalizePackId(packId);
    if (!normalized) {
        project.outfit = null;
        invalidateReferences(project);
        advanceSetupStage(project);
        return save(project);
    }
    const custom = normalized === outfitPacks.CUSTOM_PACK_ID;
    if (custom) {
        const text = clean(customText);
        if (!text) return project;
        project.outfit = {
            packId: outfitPacks.CUSTOM_PACK_ID,
            label: outfitPacks.CUSTOM_PACK_LABEL,
            outfit: text
        };
        invalidateReferences(project);
        advanceSetupStage(project);
        return save(project);
    }
    const pack = outfitPacks.getPack(normalized);
    if (!pack) return project;
    const gender = (project.creator && project.creator.identity && project.creator.identity.gender) || '';
    const composed = outfitPacks.composeFromPack(normalized, rng || Math.random, { gender });
    project.outfit = {
        packId: normalized,
        label: pack.label,
        outfit: composed.outfit || ''
    };
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

function selectEnvironment(project, environmentId, customDescription) {
    if (environmentId === 'custom') {
        const text = clean(customDescription);
        if (!text) return project;
        project.environment = { id: 'custom', label: 'Custom', description: text };
    } else {
        const entry = catalog.getEnvironment(environmentId);
        if (!entry) return project;
        project.environment = { id: entry.id, label: entry.label, description: entry.description };
    }
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

function selectContentType(project, id) {
    const entry = catalog.getContentType(id);
    if (!entry) return project;
    project.contentType = { id: entry.id, label: entry.label };
    project.brief.contentType = entry.id;
    invalidateReferences(project);
    advanceSetupStage(project);
    return save(project);
}

function editBrief(project, patch) {
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, project.brief);
    const previousDuration = Number(project.brief && project.brief.duration) || null;
    const previousAspect = (project.brief && project.brief.aspectRatio) || '';
    for (const key of ['objective', 'targetAudience', 'tone', 'keyMessage', 'callToAction',
        'additionalInstructions', 'dialogueLanguage', 'creatorDescription']) {
        if (hasOwn(src, key)) next[key] = clean(src[key]);
    }
    let durationInvalid = false;
    if (hasOwn(src, 'duration')) {
        const check = prompts.validateDuration(src.duration);
        if (check.valid) next.duration = check.value;
        else if (String(src.duration || '').trim()) durationInvalid = true;
    }
    if (hasOwn(src, 'aspectRatio')) {
        const aspect = clean(src.aspectRatio, 12);
        if (/^(?:9:16|16:9|1:1|4:5|3:4)$/.test(aspect)) next.aspectRatio = aspect;
    }
    if (hasOwn(src, 'platform')) {
        const platform = catalog.getPlatform(src.platform);
        if (platform) next.platform = platform.id;
    }
    if (hasOwn(src, 'contentType')) {
        const entry = catalog.getContentType(src.contentType);
        if (entry) {
            next.contentType = entry.id;
            project.contentType = { id: entry.id, label: entry.label };
        }
    }
    project.brief = normalizeBrief(next);
    const nextDuration = Number(project.brief.duration) || null;
    const durationChanged = Boolean(previousDuration && nextDuration && previousDuration !== nextDuration);
    const aspectChanged = Boolean(previousAspect && project.brief.aspectRatio && previousAspect !== project.brief.aspectRatio);
    if (durationChanged && project.scenes && project.scenes.length) {
        resizeScenesForDuration(project, nextDuration);
    }
    if (durationChanged || aspectChanged) {
        // A new duration/aspect is a new plan: the previous cap confirmation no
        // longer applies.
        project.durationConfirmed = false;
        invalidateReferences(project);
    }
    const result = save(project);
    result.durationInvalid = durationInvalid;
    return result;
}

// Recompute the scene plan when the total duration changes: grow or shrink the
// scene count toward the size the duration implies, then fit the durations so
// they always sum to the new total.
function resizeScenesForDuration(project, duration) {
    const scenes = project.scenes || [];
    if (!scenes.length) return scenes;
    const target = prompts.sceneCountFor(duration);
    if (scenes.length < target) {
        const template = prompts.deterministicScenes(project);
        while (scenes.length < target) {
            const base = template[Math.min(scenes.length, template.length - 1)];
            scenes.push(normalizeScene(Object.assign({}, base), scenes.length));
        }
    } else if (scenes.length > target) {
        // Remove from the middle so the hook and the closing shot survive.
        while (scenes.length > target) scenes.splice(Math.floor(scenes.length / 2), 1);
    }
    scenes.forEach((s, i) => {
        s.order = i + 1;
        if (!s.id) s.id = 'scn_' + (i + 1);
    });
    fitDurations(scenes, duration);
    project.scenes = scenes;
    return scenes;
}

// --- Script -------------------------------------------------------------------

// Re-derive the brief from the original request (used by "Regenerate Brief").
async function regenerateBrief(project, { provider, model, think }) {
    const extracted = await extractBrief(project.request || '', { provider, model, think });
    // Merge over the existing brief so a field the re-extraction leaves empty
    // (brand, productCategory, dialogueLanguage, ...) is never dropped.
    project.brief = mergeBrief(
        Object.assign({}, project.brief, { duration: extracted.duration || project.brief.duration || 15 }),
        extracted
    );
    if (extracted.productName && !(project.product && project.product.name)) {
        // Only an exact name binds; a fuzzy match is surfaced for confirmation.
        const resolved = products.resolveByName(extracted.productName);
        if (resolved.product) project.product = products.snapshot(resolved.product);
        else project.suggestedProductName = extracted.productName;
    }
    if (extracted.environment && !project.environment) {
        project.environment = environmentFromBrief(extracted);
    }
    if (extracted.contentType && !project.contentType) {
        project.contentType = contentTypeFromBrief(extracted);
    }
    invalidateReferences(project);
    return save(project);
}

async function generateScript(project, { provider, model, think, feedback, field }) {
    const product = project.product || {};
    const brief = project.brief || {};
    const creator = project.creator || {};
    const scriptBudget = prompts.dialogueWordBudget(brief.duration || 15);
    const context = [
        'PRODUCT: ' + JSON.stringify(product),
        'CREATIVE BRIEF: ' + JSON.stringify(brief),
        'CONTENT TYPE: ' + (project.contentType ? project.contentType.label : ''),
        'CREATOR: ' + JSON.stringify({ name: creator.name, identity: creator.identity, tone: brief.tone }),
        'SPEAKING BUDGET: the whole script is spoken across the video, so keep the total at ' +
        'about ' + scriptBudget + ' words (roughly 2.3 words per second of ' +
        (brief.duration || 15) + 's). A longer script has to be rushed and sounds robotic.',
        feedback ? 'REVISION REQUEST (apply this to the previous script): "' + feedback + '"' : '',
        field ? 'FOCUS: rewrite only the ' + field + ' and keep the rest close to the original.' : ''
    ].filter(Boolean).join('\n');

    let script = null;
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.SCRIPT_SYSTEM_PROMPT },
            { role: 'user', content: context + '\n\nOutput the script JSON only.' }
        ], model, { think, temperature: 0.7 });
        const parsed = parseJson(raw);
        if (parsed) {
            script = normalizeScript(parsed);
            script.source = 'llm';
            // Never approve an unsupported claim: strip unsupported sentences and
            // flag the script for the user's confirmation.
            prompts.validateScript(project, script);
            if (!script.fullText) script = null;
        }
    } catch (err) {
        console.warn('[ugc] script generation failed, using fallback:', err.message);
    }
    if (!script || !script.fullText) script = deterministicScriptFor(project);
    if (field && project.script) {
        // A focused rewrite must not discard the untouched sections.
        for (const key of ['hook', 'main', 'productInteraction', 'closing']) {
            if (key === field) continue;
            if (project.script[key]) script[key] = project.script[key];
        }
        script.fullText = [script.hook, script.main, script.productInteraction, script.closing]
            .filter(Boolean).join(' ');
    }
    script.approved = false;
    script.tone = brief.tone || script.tone || 'natural';
    script.creatorName = creator.name || script.creatorName || '';
    project.script = script;
    // A new script invalidates any scene approval (the spoken content changed),
    // but the reference frames themselves are visual and stay usable.
    if (project.scenes && project.scenes.length) {
        project.scenes.forEach((s) => { if (s.status === 'approved') s.status = 'planned'; });
    }
    project.stage = STAGES.SCRIPT_REVIEW;
    return save(project);
}

function deterministicScriptFor(project) {
    return normalizeScript(prompts.deterministicScript(project));
}

function approveScript(project) {
    if (!project.script) return project;
    project.script.approved = true;
    return save(project);
}

function editScriptField(project, field, value) {
    if (!project.script) return project;
    const allowed = ['hook', 'main', 'productInteraction', 'closing'];
    if (allowed.includes(field)) {
        project.script[field] = clean(value);
        project.script.fullText = [project.script.hook, project.script.main,
            project.script.productInteraction, project.script.closing].filter(Boolean).join(' ');
        project.script.approved = false;
        project.script.needsConfirmation = false;
        // The script changed, so any scene approval no longer applies.
        if (project.scenes && project.scenes.length) {
            project.scenes.forEach((s) => { if (s.status === 'approved') s.status = 'planned'; });
        }
    }
    return save(project);
}

// --- Scenes -------------------------------------------------------------------

// Scale/trim whole-second durations so the scene plan sums to exactly `total`.
function fitDurations(scenes, total) {
    if (!Array.isArray(scenes) || !scenes.length) return scenes;
    const target = Number(total) > 0 ? Math.round(Number(total)) : null;
    if (!target) return scenes;
    const raw = scenes.map((s) => (Number(s.duration) > 0 ? Number(s.duration) : 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum === target) {
        scenes.forEach((s, i) => { s.duration = raw[i]; });
        return scenes;
    }
    const scaled = raw.map((v) => Math.max(1, Math.round(v * (target / sum))));
    let diff = target - scaled.reduce((a, b) => a + b, 0);
    // Distribute the remaining seconds to the longest scenes (or trim from them).
    let guard = 0;
    while (diff !== 0 && guard < 1000) {
        const ordered = scaled.map((v, i) => ({ v, i })).sort((a, b) => (diff > 0 ? a.v - b.v : b.v - a.v));
        const pick = ordered[0].i;
        if (diff > 0) {
            scaled[pick] += 1;
            diff -= 1;
        } else if (scaled[pick] > 1) {
            scaled[pick] -= 1;
            diff += 1;
        } else {
            break;
        }
        guard += 1;
    }
    scenes.forEach((s, i) => { s.duration = scaled[i]; });
    return scenes;
}

function normalizeSceneList(list, project) {
    const scenes = (Array.isArray(list) ? list : []).map(normalizeScene);
    scenes.forEach((scene, index) => { scene.id = scene.id || ('scn_' + (index + 1)); });
    // Repair malformed/duplicate IDs, empty required fields, unsupported claims
    // and over-long dialogue deterministically.
    prompts.validateScenes(project, scenes);
    fitDurations(scenes, project.brief && project.brief.duration);
    return scenes;
}

async function generateScenes(project, { provider, model, think }) {
    const product = project.product || {};
    const brief = project.brief || {};
    const environment = project.environment || {};
    const outfit = project.outfit || {};
    const creator = project.creator || {};
    const context = [
        'TOTAL DURATION (seconds): ' + (brief.duration || 15),
        'CONTENT TYPE: ' + (project.contentType ? project.contentType.label : ''),
        'SCRIPT: ' + (project.script ? project.script.fullText : ''),
        'SPEAKING BUDGET: each scene\'s "dialogue" must fit its own "duration" at about 2.3 ' +
        'words per second (a 3s scene is at most ~' + prompts.dialogueWordBudget(3) +
        ' words, a 5s scene ~' + prompts.dialogueWordBudget(5) + '). Split a longer thought ' +
        'across scenes; an over-long line is spoken too fast and sounds robotic.',
        'CREATOR: ' + JSON.stringify({ name: creator.name, identity: creator.identity }),
        'OUTFIT (keep consistent): ' + (outfit.outfit || ''),
        'ENVIRONMENT (keep consistent): ' + (environment.description || environment.label || ''),
        'PRODUCT: ' + JSON.stringify({ name: product.name, description: product.description, benefits: product.keyBenefits })
    ].join('\n');

    let scenes = null;
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.SCENE_SYSTEM_PROMPT },
            { role: 'user', content: context + '\n\nOutput the scene plan JSON only.' }
        ], model, { think, temperature: 0.5 });
        const parsed = parseJson(raw);
        if (parsed && Array.isArray(parsed.scenes) && parsed.scenes.length) {
            scenes = normalizeSceneList(parsed.scenes, project);
        }
    } catch (err) {
        console.warn('[ugc] scene planning failed, using fallback:', err.message);
    }
    if (!scenes || !scenes.length) {
        scenes = normalizeSceneList(prompts.deterministicScenes(project), project);
    }
    scenes.forEach((scene) => { scene.status = 'planned'; });
    project.scenes = scenes;
    invalidateReferences(project);
    project.stage = STAGES.SCENE_REVIEW;
    return save(project);
}

function editScene(project, sceneId, patch) {
    const scene = (project.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return project;
    const src = patch && typeof patch === 'object' ? patch : {};
    if (hasOwn(src, 'action')) scene.action = clean(src.action, 600);
    if (hasOwn(src, 'dialogue')) scene.dialogue = clean(src.dialogue, 600);
    if (hasOwn(src, 'objective')) scene.objective = clean(src.objective, 300);
    if (hasOwn(src, 'productVisibility')) scene.productVisibility = clean(src.productVisibility, 200);
    if (hasOwn(src, 'transition')) scene.transition = clean(src.transition, 200);
    if (hasOwn(src, 'environment')) scene.environment = clean(src.environment, 300);
    if (hasOwn(src, 'outfit')) scene.outfit = clean(src.outfit, 400);
    if (src.camera && typeof src.camera === 'object') {
        scene.camera = Object.assign(normalizeCamera(scene.camera), normalizeCamera(src.camera));
    }
    if (hasOwn(src, 'duration')) {
        const check = prompts.validateDuration(src.duration);
        if (check.valid) scene.duration = check.value;
    }
    scene.status = 'planned';
    scene.referenceUrl = null;
    if (project.brief && project.brief.duration) fitDurations(project.scenes, project.brief.duration);
    invalidateReferences(project);
    return save(project);
}

function addScene(project, afterId) {
    const scenes = project.scenes || [];
    const index = afterId ? scenes.findIndex((s) => s.id === afterId) : scenes.length - 1;
    const scene = normalizeScene({ duration: 2, objective: 'New scene', action: 'Describe what happens.' }, scenes.length);
    scene.id = makeId('scn');
    scenes.splice(index + 1, 0, scene);
    scenes.forEach((s, i) => { s.order = i + 1; });
    if (project.brief && project.brief.duration) fitDurations(scenes, project.brief.duration);
    project.scenes = scenes;
    invalidateReferences(project);
    return save(project);
}

function deleteScene(project, sceneId) {
    const scenes = project.scenes || [];
    const index = scenes.findIndex((s) => s.id === sceneId);
    if (index === -1) return project;
    scenes.splice(index, 1);
    scenes.forEach((s, i) => { s.order = i + 1; });
    if (project.brief && project.brief.duration) fitDurations(scenes, project.brief.duration);
    project.scenes = scenes;
    invalidateReferences(project);
    return save(project);
}

function moveScene(project, sceneId, direction) {
    const scenes = project.scenes || [];
    const index = scenes.findIndex((s) => s.id === sceneId);
    if (index === -1) return project;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= scenes.length) return project;
    const [scene] = scenes.splice(index, 1);
    scenes.splice(target, 0, scene);
    scenes.forEach((s, i) => { s.order = i + 1; });
    project.scenes = scenes;
    invalidateReferences(project);
    return save(project);
}

function approveScenes(project) {
    if (!project.scenes || !project.scenes.length) return project;
    project.scenes.forEach((s) => { s.status = 'approved'; });
    invalidateReferences(project);
    project.stage = STAGES.REFERENCE_GENERATION;
    return save(project);
}

// Rewrite only the named scene (or re-roll it deterministically when the model
// is unavailable). Other scenes, the creator, outfit and environment are left
// untouched.
async function regenerateScene(project, sceneId, { provider, model, think, direction }) {
    const scene = (project.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return project;
    const context = [
        'The video is a ' + (project.brief.duration || 15) + '-second UGC video.',
        'Creator: ' + JSON.stringify({ identity: project.creator && project.creator.identity, outfit: (project.outfit || {}).outfit }),
        'Environment (keep): ' + ((project.environment || {}).description || (project.environment || {}).label || ''),
        'Product: ' + JSON.stringify({ name: (project.product || {}).name, description: (project.product || {}).description }),
        'CURRENT SCENE ' + scene.order + ': ' + JSON.stringify({ objective: scene.objective, action: scene.action, camera: scene.camera, productVisibility: scene.productVisibility }),
        'DIALOGUE BUDGET: at most ~' + prompts.dialogueWordBudget(scene.duration) + ' words for this ' +
        scene.duration + 's scene (about 2.3 words per second; keep it natural, not rushed).',
        'REQUESTED CHANGE: ' + (direction || 'Regenerate this scene with a fresh, different camera and action.')
    ].join('\n');
    let replacement = null;
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: prompts.SCENE_SYSTEM_PROMPT },
            { role: 'user', content: context + '\n\nReturn exactly one scene as {"scenes":[ ... ]} and keep its duration at ' + scene.duration + ' seconds.' }
        ], model, { think, temperature: 0.6 });
        const parsed = parseJson(raw);
        if (parsed && Array.isArray(parsed.scenes) && parsed.scenes.length) {
            replacement = normalizeScene(parsed.scenes[0], scene.order - 1);
        }
    } catch (err) {
        console.warn('[ugc] scene regeneration failed, re-rolling locally:', err.message);
    }
    if (!replacement) {
        const fallback = prompts.deterministicScenes(project)[Math.min(scene.order - 1, 3)] || {};
        replacement = normalizeScene(fallback, scene.order - 1);
    }
    // Preserve the existing slot, id and duration; adopt the new content.
    scene.objective = replacement.objective || scene.objective;
    scene.action = replacement.action || scene.action;
    scene.dialogue = replacement.dialogue || scene.dialogue;
    scene.camera = replacement.camera && (replacement.camera.shotType || replacement.camera.movement)
        ? replacement.camera
        : scene.camera;
    scene.productVisibility = replacement.productVisibility || scene.productVisibility;
    scene.transition = replacement.transition || scene.transition;
    scene.status = 'planned';
    scene.referenceUrl = null;
    prompts.validateScenes(project, [scene]);
    // The scene's visuals changed, so every frame for the old plan is stale.
    invalidateReferences(project);
    return save(project);
}

function setDirectorProduction(project, productionId) {
    if (!project) return null;
    project.directorProductionId = productionId || null;
    project.lastError = '';
    project.stage = STAGES.VIDEO_GENERATION;
    return save(project);
}

// Confirm rendering a brief longer than the H3 ceiling at the 15-second maximum
// instead of silently clamping it.
function confirmDuration(project) {
    if (!project) return project;
    project.durationConfirmed = true;
    return save(project);
}

// --- Lifecycle ----------------------------------------------------------------

// The Director production finished: mark the linked UGC project complete.
function completeProduction(project, detail) {
    if (!project) return null;
    project.status = STATUS.COMPLETED;
    project.stage = STAGES.COMPLETED;
    project.videoUrl = (detail && detail.url) || project.videoUrl || null;
    project.lastError = '';
    return save(project);
}

// The Director production failed or was cancelled: return the project to the
// reference-approval checkpoint so the user can retry, keeping the frames.
function failProduction(project, message) {
    if (!project) return null;
    project.lastError = clean(message, 500) || 'The Director production failed.';
    if (project.stage === STAGES.VIDEO_GENERATION) project.stage = STAGES.REFERENCE_APPROVAL;
    return save(project);
}

// Sync the linked UGC project when its Director production reaches a terminal
// state. Matches by the production id recorded on the project, so no second
// production system is introduced.
function syncDirectorOutcome(conversationId, productionId, outcome, detail) {
    if (!conversationId || !productionId) return null;
    const project = getProject(conversationId);
    if (!project || project.directorProductionId !== productionId) return null;
    if (outcome === 'completed') return completeProduction(project, detail);
    if (outcome === 'failed' || outcome === 'cancelled') {
        return failProduction(project, detail && detail.message);
    }
    return null;
}

function findByProductionId(productionId) {
    const key = String(productionId || '');
    if (!key) return null;
    return listProjects().find((p) => p.directorProductionId === key) || null;
}

// --- Reference images ---------------------------------------------------------

// Build the structured request for one scene's reference frame. The concept is
// direction only; imageGenerator.buildImagePrompt owns the final prompt. Product
// reference images travel as `product_references` — a separate channel from the
// scene frames, so the two can never be confused.
function buildReferenceRequest(project, scene) {
    reconcileContinuity(project);
    const built = prompts.referenceConcept(project, scene);
    return {
        intent: 'image_generation',
        user_prompt: built.concept,
        previous_prompt: '',
        creative_mode: 'light',
        explicit_constraints: built.constraints,
        product_references: (built.productReferences || []).slice()
    };
}

function recordReference(project, sceneId, result) {
    const scene = (project.scenes || []).find((s) => s.id === sceneId);
    if (scene) {
        scene.referenceUrl = result.url;
        scene.status = 'reference';
    }
    const list = (project.references || []).filter((r) => r.sceneId !== sceneId);
    list.push({
        sceneId,
        order: scene ? scene.order : list.length + 1,
        url: result.url,
        filename: result.filename,
        prompt: result.prompt || '',
        status: 'ready',
        planHash: currentPlanHash(project),
        error: ''
    });
    list.sort((a, b) => a.order - b.order);
    project.references = list;
    project.planHash = currentPlanHash(project);
    return save(project);
}

// Record a failed frame for one scene. The scene stays identifiable so the UI
// can show exactly which frames failed and offer a retry-failed-only action.
function recordReferenceFailure(project, sceneId, message) {
    const scene = (project.scenes || []).find((s) => s.id === sceneId);
    if (scene) scene.status = 'reference_failed';
    const list = (project.references || []).filter((r) => r.sceneId !== sceneId);
    list.push({
        sceneId,
        order: scene ? scene.order : list.length + 1,
        url: '',
        filename: '',
        prompt: '',
        status: 'failed',
        planHash: currentPlanHash(project),
        error: clean(message, 300)
    });
    list.sort((a, b) => a.order - b.order);
    project.references = list;
    return save(project);
}

function markReferencesReady(project) {
    project.stage = STAGES.REFERENCE_APPROVAL;
    return save(project);
}

// Approve the frames. Requires exactly one ready frame per approved scene,
// generated for the current plan. Missing, stale, failed or duplicate frames
// reject the approval with a clear reason.
function approveReferences(project) {
    const scenes = project.scenes || [];
    if (!scenes.length) return { ok: false, error: 'There is no approved scene plan.' };
    const current = currentPlanHash(project);
    const byScene = new Map();
    for (const ref of (project.references || [])) {
        if (!ref || !ref.filename) continue;
        if (ref.status !== 'ready' && ref.status !== 'approved') continue;
        if (ref.planHash !== current) continue;
        if (!byScene.has(ref.sceneId)) byScene.set(ref.sceneId, []);
        byScene.get(ref.sceneId).push(ref);
    }
    const missing = [];
    const duplicate = [];
    for (const scene of scenes) {
        const refs = byScene.get(scene.id) || [];
        if (refs.length === 0) missing.push(scene.order);
        else if (refs.length > 1) duplicate.push(scene.order);
    }
    if (missing.length || duplicate.length) {
        const parts = [];
        if (missing.length) parts.push('missing a ready frame for scene(s) ' + missing.join(', '));
        if (duplicate.length) parts.push('more than one frame for scene(s) ' + duplicate.join(', '));
        return {
            ok: false,
            error: 'Reference approval needs exactly one current frame per scene (' +
                parts.join('; ') + '). Regenerate the affected scenes.'
        };
    }
    const approved = [];
    for (const scene of scenes) {
        const ref = byScene.get(scene.id)[0];
        approved.push({
            sceneId: ref.sceneId,
            order: ref.order,
            url: ref.url,
            filename: ref.filename,
            planHash: ref.planHash
        });
    }
    approved.sort((a, b) => a.order - b.order);
    project.approvedReferences = approved;
    project.planHash = current;
    const approvedIds = new Set(approved.map((r) => r.sceneId));
    project.references = (project.references || []).map((r) =>
        Object.assign({}, r, { status: approvedIds.has(r.sceneId) && r.planHash === current ? 'approved' : r.status }));
    project.stage = STAGES.VIDEO_GENERATION;
    save(project);
    return { ok: true };
}

// Scenes whose current frame is missing, failed, stale or otherwise not ready.
function pendingReferenceSceneIds(project) {
    const scenes = project.scenes || [];
    const current = currentPlanHash(project);
    const ready = new Map();
    for (const ref of (project.references || [])) {
        if (ref && ref.filename && (ref.status === 'ready' || ref.status === 'approved')
            && ref.planHash === current) {
            ready.set(ref.sceneId, true);
        }
    }
    return scenes.filter((s) => !ready.get(s.id)).map((s) => s.id);
}

// All approved reference frames in scene order. The Director conditions the
// final video on every scene's approved frame (reference-to-video), not just
// the first — this is what makes the generated scene frames actually reach the
// video instead of being discarded after approval.
function resolveReferenceFrames(project) {
    const approved = project.approvedReferences && project.approvedReferences.length
        ? project.approvedReferences
        : (project.references || []).filter((r) => r && (r.status === 'ready' || r.status === 'approved')
            && (!r.planHash || r.planHash === currentPlanHash(project)));
    return approved
        .filter((r) => r && r.filename)
        .slice()
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
        .map((r) => ({
            sceneId: r.sceneId || null,
            order: Number(r.order) || 0,
            url: r.url || ('/generated/' + encodeURIComponent(r.filename)),
            filename: r.filename
        }));
}

// The opening frame shown in the Director approval card: the first approved
// reference, which is also <Picture 1> for the video.
function resolveOpeningFrame(project) {
    const frames = resolveReferenceFrames(project);
    const first = frames[0] || null;
    return first ? { url: first.url, filename: first.filename } : null;
}

// --- Natural-language editing -------------------------------------------------

const APPROVE_RE =
    /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|approve[d]?|looks?\s+good|that\s+works|perfect|go\s+ahead|continue|proceed|do\s+it|accept|use\s+(?:it|this|that))[.!]*$/i;

const CONTINUE_VIDEO_RE =
    /\b(?:continue\s+(?:in\s+)?director(?:\s+mode)?|continue\s+to\s+(?:the\s+)?video|generate\s+(?:the\s+)?(?:final\s+)?video|make\s+(?:the\s+)?video|start\s+(?:the\s+)?(?:video|production)|approve\s+(?:the\s+)?references?)\b/i;

const REFERENCE_REQUEST_RE =
    /\b(?:generate|create|make|show|produce)\s+(?:me\s+)?(?:the\s+)?(?:reference|scene|keyframe|frame)s?\b/i;

const EDIT_CONTEXT_RE =
    /\b(?:script|hook|cta|call\s+to\s+action|tone|creator|character|outfit|clothes|clothing|wardrobe|environment|scene|shot|camera|product|brief)\b/i;
const EDIT_VERB_RE =
    /\b(?:make|change|update|rewrite|regenerate|remove|add|use|switch|replace|set|turn|shorten|lengthen|keep|put|adjust|redo|dress)\b/i;
const SCENE_NUMBER_RE = /\bscene\s+(\d+)\b/i;
// "make it 20 seconds" / "change the duration to 30s" — narrowly matched so a
// fresh request ("make a 15 second video of a cat") is not read as a UGC edit.
const DURATION_EDIT_RE =
    /\b(?:make\s+it|make\s+the\s+(?:video|ugc\s+video)|change\s+the\s+(?:duration|length|video)|set\s+the\s+(?:duration|length))\b[^.]*\b\d/i;
const OUTFIT_VERB_RE = /\b(?:put|use|wear|wearing|dress|switch|change)\b/i;

// Classify a typed follow-up for an active project. Conservative: only matches
// clear approvals, reference/video requests, or edits that name a UGC artifact
// (so an unrelated generation request still flows to the normal router). The
// interpretation is stage-aware: a scene action at the reference stages targets
// that scene's frame, earlier it targets the scene plan.
function classifyMessage(message, project) {
    const text = String(message || '').trim();
    if (!text || !project) return null;
    const stage = project.stage;

    // Confirm rendering a brief longer than the H3 ceiling at 15 seconds.
    const requested = Number(project.brief && project.brief.duration) || 0;
    if (requested > prompts.DURATION_LIMITS.renderMax &&
        /\b(?:continue|render|generate|proceed|do\s+it|go\s+ahead)\b[^.]*\b15\s*(?:seconds?|s)?\b/i.test(text)) {
        return { action: 'confirm_duration' };
    }

    // Explicit stage approvals ("approve the scenes" / "approve the script").
    if (/\bapprove\s+(?:the\s+)?(?:scene\s+plan|scenes?)\b/i.test(text)) return { action: 'approve_scenes' };
    if (/\bapprove\s+(?:the\s+)?script\b/i.test(text)) return { action: 'approve_script' };
    if (/\bapprove\s+(?:the\s+)?(?:references?|frames?|refs?)\b/i.test(text)) return { action: 'approve_references' };
    if (/\bapprove\s+(?:the\s+)?brief\b/i.test(text)) return { action: 'approve_brief' };

    // A targeted scene regenerate is stage-aware: at the reference stages it
    // means that scene's frame, earlier it means the scene plan itself.
    const sceneMatch = text.match(/\b(?:regenerate|redo|re-do|rework|rewrite)\s+(?:only\s+)?scene\s+(\d+)\b/i);
    if (sceneMatch) {
        const referenceStage = stage === STAGES.REFERENCE_APPROVAL || stage === STAGES.REFERENCE_GENERATION;
        return {
            action: referenceStage ? 'regenerate_reference' : 'regenerate_scene',
            sceneNumber: Number(sceneMatch[1])
        };
    }
    if (DURATION_EDIT_RE.test(text)) return { action: 'edit', message: text };

    if (CONTINUE_VIDEO_RE.test(text)) return { action: 'continue_director' };
    if (REFERENCE_REQUEST_RE.test(text)) return { action: 'generate_references' };

    if (APPROVE_RE.test(text)) {
        if (stage === STAGES.SCRIPT_REVIEW) return { action: 'approve_script' };
        if (stage === STAGES.SCENE_REVIEW) return { action: 'approve_scenes' };
        if (stage === STAGES.REFERENCE_APPROVAL) return { action: 'approve_references' };
        if (stage === STAGES.BRIEF || stage === STAGES.CREATIVE_DIRECTION) {
            return { action: 'approve_brief' };
        }
        return null;
    }

    const outfitPack = outfitPacks.detectOutfitPackFromText(text);
    const isEdit = EDIT_VERB_RE.test(text) && (
        EDIT_CONTEXT_RE.test(text) ||
        SCENE_NUMBER_RE.test(text) ||
        DURATION_EDIT_RE.test(text) ||
        (outfitPack && OUTFIT_VERB_RE.test(text))
    );
    if (isEdit) return { action: 'edit', message: text };
    return null;
}

// Deterministic edits for the common phrasings, then an LLM fallback for
// free-form changes. Returns { project, changed }.
async function applyNaturalEdit(project, message, { provider, model, think }) {
    const text = String(message || '').trim();
    const changed = [];
    let visualChange = false;

    // 1. Duration (validated; never silently accepts an impossible value).
    const duration = prompts.parseDuration(text);
    if (duration && /\b(?:make|change|set|shorten|lengthen|video|duration|length|seconds?)\b/i.test(text)) {
        const check = prompts.validateDuration(duration);
        if (check.valid) {
            project.brief.duration = check.value;
            if (project.scenes && project.scenes.length) resizeScenesForDuration(project, check.value);
            changed.push('duration');
            visualChange = true;
        }
    }

    // 2. Remove the CTA.
    if (/\b(?:remove|drop|delete|no)\s+(?:the\s+)?(?:cta|call\s+to\s+action)\b/i.test(text) && project.script) {
        project.script.closing = '';
        project.script.fullText = [project.script.hook, project.script.main, project.script.productInteraction]
            .filter(Boolean).join(' ');
        project.script.approved = false;
        changed.push('script');
    }

    // 3. "Make the hook shorter" / "shorten the hook".
    if (/\b(?:shorten|short(?:er)?|trim)\b/i.test(text) && /\bhook\b/i.test(text) && project.script) {
        project.script.hook = prompts.fitDialogueToBudget(project.script.hook, 3);
        project.script.fullText = [project.script.hook, project.script.main,
            project.script.productInteraction, project.script.closing].filter(Boolean).join(' ');
        project.script.approved = false;
        changed.push('script');
    }

    // 4. "Keep the same outfit in every scene".
    if (/\b(?:keep|use)\s+(?:the\s+)?same\s+outfit\b/i.test(text) || /\boutfit\s+in\s+every\s+scene\b/i.test(text)) {
        const outfitText = (project.outfit && project.outfit.outfit) || project.continuity.outfitState || '';
        if (outfitText) {
            project.continuity.outfitState = outfitText;
            (project.scenes || []).forEach((s) => { s.outfit = outfitText; });
            changed.push('continuity');
            visualChange = true;
        }
    }

    // 5. Outfit change (pack, or "put <name> in <pack>").
    const packId = outfitPacks.detectOutfitPackFromText(text);
    if (packId && /\b(?:outfit|wear|wearing|put|dress|wardrobe|clothes)\b/i.test(text)) {
        selectOutfit(project, packId, '', Math.random);
        changed.push('outfit');
        visualChange = true;
    }

    // 6. Environment change.
    const envId = catalog.detectEnvironment(text);
    if (envId) {
        selectEnvironment(project, envId, envId === 'custom' ? text : '');
        changed.push('environment');
        visualChange = true;
    }

    // 7. Creator change by name ("use Maya as the creator").
    const namedCreator = text.match(/\buse\s+([A-Z][\w'-]{1,30})\s+as\s+(?:the\s+)?creator\b/i)
        || text.match(/\b(?:creator|character)\s+([A-Z][\w'-]{1,30})\b/);
    if (namedCreator) {
        const name = namedCreator[1].toLowerCase();
        const preset = characterPresets.list().find((c) => String(c.name || '').toLowerCase() === name);
        if (preset) {
            selectCreator(project, preset.id);
            changed.push('creator');
            visualChange = true;
        }
    }
    if (/\b(?:another|different|new)\s+creator\b/i.test(text) || /\bchange\s+(?:the\s+)?creator\b/i.test(text)) {
        project.stage = STAGES.CREATOR_SELECTION;
        changed.push('creator_selection');
    }

    // 8. Explicit scene-targeted camera/action edits.
    const sceneMatch = text.match(/scene\s+(\d+)/i);
    if (sceneMatch && project.scenes && project.scenes.length) {
        const scene = project.scenes.find((s) => s.order === Number(sceneMatch[1]));
        if (scene) {
            if (/\bclose[\s-]?up\b/i.test(text)) {
                scene.camera = Object.assign(normalizeCamera(scene.camera), { shotType: 'close-up', framing: 'product-focused' });
                changed.push('scene');
                visualChange = true;
            }
            if (/\bproduct\s+(?:shot|focus|close)\b/i.test(text)) {
                scene.productVisibility = 'product fills the frame';
                changed.push('scene');
                visualChange = true;
            }
            if (/\bcamera\s+(?:movement|moves?)\b/i.test(text) && /\bcontinue|same\b/i.test(text)) {
                const previous = project.scenes.find((s) => s.order === Number(sceneMatch[1]) - 1);
                if (previous) {
                    scene.camera = Object.assign(normalizeCamera(scene.camera), {
                        movement: previous.camera.movement || 'slow push in'
                    });
                    changed.push('scene');
                    visualChange = true;
                }
            }
            scene.status = 'planned';
            scene.referenceUrl = null;
        }
    } else if (/\bproduct\s+(?:shot|focus|close)\b/i.test(text) && project.scenes && project.scenes.length) {
        // "Change the product shot" with no scene number: make the product
        // prominent across the plan.
        project.scenes.forEach((s) => { s.productVisibility = 'product fills the frame'; s.status = 'planned'; });
        changed.push('scenes');
        visualChange = true;
    }

    // 9. LLM fallback for anything else substantial (or a clearer rewrite).
    if (!changed.length && EDIT_VERB_RE.test(text)) {
        const updated = await llmEditProject(project, text, { provider, model, think });
        if (updated) {
            changed.push(...updated);
            if (updated.includes('scenes') || updated.includes('brief')) visualChange = true;
        }
    }

    if (visualChange) invalidateReferences(project);
    reconcileContinuity(project);
    save(project);
    return { project, changed };
}

// Ask the model to apply a free-form change to the project's structured slices.
async function llmEditProject(project, message, { provider, model, think }) {
    const slice = {};
    const keys = [];
    if (project.script) { slice.script = project.script; keys.push('script'); }
    if (project.scenes && project.scenes.length) { slice.scenes = project.scenes; keys.push('scenes'); }
    slice.brief = project.brief;
    keys.push('brief');
    let raw;
    try {
        raw = await providers.chat(provider, [
            { role: 'system', content: prompts.EDIT_SYSTEM_PROMPT },
            { role: 'user', content: 'CURRENT STATE:\n' + JSON.stringify(slice, null, 2) +
                '\n\nREQUESTED CHANGE:\n"' + message + '"\n\nOutput the updated JSON only.' }
        ], model, { think, temperature: 0.3 });
    } catch (err) {
        console.warn('[ugc] natural edit failed:', err.message);
        return null;
    }
    const parsed = parseJson(raw);
    if (!parsed) return null;
    const changed = [];
    if (hasOwn(parsed, 'brief')) {
        project.brief = normalizeBrief(parsed.brief);
        changed.push('brief');
    }
    if (hasOwn(parsed, 'script') && parsed.script) {
        const next = normalizeScript(parsed.script);
        next.approved = false;
        prompts.validateScript(project, next);
        project.script = next;
        changed.push('script');
    }
    if (hasOwn(parsed, 'scenes') && Array.isArray(parsed.scenes) && parsed.scenes.length) {
        project.scenes = normalizeSceneList(parsed.scenes, project);
        changed.push('scenes');
    }
    if (changed.includes('scenes') || changed.includes('brief')) {
        invalidateReferences(project);
    }
    return changed.length ? changed : null;
}

// --- Handoff data -------------------------------------------------------------

// Everything the Director needs, in the Director's own structured shape.
// H3 renders at most 15 seconds; a longer UGC brief is clamped for the Director
// handoff (a >15s request is the Long Video Director's job, not the H3 stage).
const DIRECTOR_MAX_SECONDS = 15;

function directorProductionInput(project) {
    const brief = prompts.directorBrief(project);
    const requested = Number(project.brief && project.brief.duration) > 0
        ? Number(project.brief.duration)
        : DIRECTOR_MAX_SECONDS;
    const check = prompts.validateDuration(requested);
    // Never silently clamp: the caller must explain the ceiling and ask the user
    // to confirm before rendering a longer brief at the 15s maximum.
    const durationCapped = check.valid ? check.capped : false;
    const duration = Math.min(DIRECTOR_MAX_SECONDS, Math.max(1, requested));
    return {
        brief,
        duration,
        requestedDuration: requested,
        durationCapped,
        originalRequest: project.request || '',
        openingFrame: resolveOpeningFrame(project),
        references: resolveReferenceFrames(project)
    };
}

// --- Card / rendering ---------------------------------------------------------

function productSnapshotForCard(product) {
    return products.snapshot(product);
}

function buildCard(project) {
    const card = {
        id: project.id,
        stage: project.stage,
        status: project.status,
        version: project.version || 0,
        title: 'UGC Studio',
        request: project.request,
        product: project.product || null,
        creator: project.creator || null,
        creatorMode: project.creatorMode || '',
        creatorSkipped: project.creatorSkipped === true,
        outfit: project.outfit || null,
        environment: project.environment || null,
        contentType: project.contentType || null,
        brief: project.brief,
        script: project.script || null,
        scenes: (project.scenes || []).map((s) => ({
            id: s.id,
            order: s.order,
            duration: s.duration,
            objective: s.objective,
            action: s.action,
            dialogue: s.dialogue,
            camera: s.camera,
            environment: s.environment,
            outfit: s.outfit,
            productVisibility: s.productVisibility,
            transition: s.transition,
            status: s.status,
            referenceUrl: s.referenceUrl,
            needsConfirmation: s.needsConfirmation === true
        })),
        references: (project.references || []).map((r) => ({
            sceneId: r.sceneId, order: r.order, url: r.url, prompt: r.prompt,
            status: referenceStatus(project, r), error: r.error || ''
        })),
        referencesComplete: referencesComplete(project),
        continuity: project.continuity,
        directorProductionId: project.directorProductionId,
        videoUrl: project.videoUrl || null,
        lastError: project.lastError || '',
        durationCapped: (() => {
            const check = prompts.validateDuration(project.brief && project.brief.duration);
            return check.valid ? check.capped : false;
        })(),
        durationConfirmed: project.durationConfirmed === true,
        // The product name the brief extracted when it is not yet in the library,
        // so the product card can offer a one-click "Create <name>".
        suggestedProductName: project.suggestedProductName || ''
    };
    // Only ship the catalogs the current interaction needs, so the persisted
    // marker stays small.
    if (project.stage === STAGES.PRODUCT_SELECTION) {
        card.products = products.list().map(productSnapshotForCard);
    }
    if (project.stage === STAGES.CREATOR_SELECTION) {
        card.characters = characterPresets.list().map((c) => ({ id: c.id, name: c.name || 'Character' }));
    }
    if (project.stage === STAGES.CREATIVE_DIRECTION) {
        card.outfitPacks = outfitPacks.listPacks().map((p) => ({ id: p.id, label: p.label, description: p.description }));
        card.environments = catalog.ENVIRONMENTS.map((e) => ({ id: e.id, label: e.label }));
        card.contentTypes = catalog.CONTENT_TYPES.map((c) => ({ id: c.id, label: c.label }));
    }
    return card;
}

function markerLine(card) {
    return '[[ugc:' + JSON.stringify(card) + ']]';
}

const STAGE_INTRO = {
    [STAGES.PRODUCT_SELECTION]: 'UGC Studio \u2014 let\'s start with the product. Pick one from your library, or create a new one. I use only the details you supply \u2014 no invented claims.',
    [STAGES.CREATOR_SELECTION]: 'UGC Studio \u2014 who is on camera? Choose a saved character, roll a new creator, or keep the product focus and skip the creator.',
    [STAGES.CREATIVE_DIRECTION]: 'UGC Studio \u2014 a few creative choices: content type, outfit and environment.',
    [STAGES.BRIEF]: 'UGC Studio \u2014 here is the brief I assembled. Edit anything, then approve it to write the script.',
    [STAGES.SCRIPT_REVIEW]: 'UGC Studio \u2014 here is the script. Approve it to plan the scenes, or ask for changes.',
    [STAGES.SCENE_REVIEW]: 'UGC Studio \u2014 here is the scene plan. Adjust any scene, then approve to generate the reference frames.',
    [STAGES.REFERENCE_GENERATION]: 'UGC Studio \u2014 generating the reference frames\u2026',
    [STAGES.REFERENCE_APPROVAL]: 'UGC Studio \u2014 reference frames are ready. Approve them to hand the production to Director Mode.',
    [STAGES.VIDEO_GENERATION]: 'UGC Studio \u2014 handing this to Director Mode\u2026',
    [STAGES.COMPLETED]: 'UGC Studio \u2014 production complete.'
};

function renderContent(project) {
    const card = buildCard(project);
    const intro = STAGE_INTRO[project.stage] || 'UGC Studio';
    return intro + '\n\n' + markerLine(card);
}

function normalizeAction(value) {
    if (!value) return null;
    const type = typeof value === 'string' ? value : (value.type || value.action);
    const key = String(type || '').trim().toLowerCase();
    if (!Object.values(ACTIONS).includes(key)) return null;
    const out = { type: key };
    if (value && typeof value === 'object') {
        for (const field of ['projectId', 'productId', 'characterId', 'environmentId', 'contentTypeId', 'outfitPack',
            'outfitPackCustom', 'sceneId', 'field', 'value', 'direction', 'message', 'productionId']) {
            if (value[field] !== undefined && value[field] !== null) out[field] = String(value[field]);
        }
        if (value.duration !== undefined) out.duration = value.duration;
        if (value.brief && typeof value.brief === 'object') out.brief = value.brief;
        if (value.product && typeof value.product === 'object') out.product = value.product;
        if (value.creator && typeof value.creator === 'object') out.creator = value.creator;
        if (value.scene && typeof value.scene === 'object') out.scene = value.scene;
        if (value.script && typeof value.script === 'object') out.script = value.script;
        if (value.direction === 'up' || value.direction === 'down') out.moveDirection = value.direction;
        if (value.sceneNumber !== undefined) out.sceneNumber = Number(value.sceneNumber);
        if (value.version !== undefined) out.projectVersion = Number(value.version);
        if (value.delete === true) out.delete = true;
    }
    return out;
}

module.exports = {
    STATUS,
    STAGES,
    ACTIONS,
    MARKER_RE,
    detectUgcIntent,
    isScriptOnlyRequest,
    createProject,
    getProject,
    removeProject,
    listProjects,
    normalizeProject,
    save,
    markActive,
    isActive,
    isOpen,
    nextSetupStage,
    selectProduct,
    createProduct,
    deleteProduct,
    exitProject,
    resumeProject,
    selectCreator,
    randomCreator,
    skipCreator,
    selectOutfit,
    selectEnvironment,
    selectContentType,
    editBrief,
    regenerateBrief,
    generateScript,
    approveScript,
    editScriptField,
    generateScenes,
    regenerateScene,
    setDirectorProduction,
    confirmDuration,
    completeProduction,
    failProduction,
    syncDirectorOutcome,
    findByProductionId,
    editScene,
    addScene,
    deleteScene,
    moveScene,
    approveScenes,
    fitDurations,
    resizeScenesForDuration,
    buildReferenceRequest,
    recordReference,
    recordReferenceFailure,
    markReferencesReady,
    approveReferences,
    referencesComplete,
    pendingReferenceSceneIds,
    referenceStatus,
    currentPlanHash,
    invalidateReferences,
    validateAction,
    isStaleAction,
    resolveOpeningFrame,
    reconcileContinuity,
    classifyMessage,
    applyNaturalEdit,
    directorProductionInput,
    buildCard,
    renderContent,
    normalizeAction,
    BRIEF_FIELDS,
    ACTION_RULES,
    DURATION_LIMITS: prompts.DURATION_LIMITS,
    // catalog re-exports for API/UI
    listContentTypes: () => catalog.CONTENT_TYPES.slice(),
    listEnvironments: () => catalog.ENVIRONMENTS.slice(),
    listPlatforms: () => catalog.PLATFORMS.slice(),
    listOutfitPacks: outfitPacks.listPacks,
    listCharacters: () => characterPresets.list(),
    listProducts: () => products.list(),
    // exposed for tests
    mergeBrief,
    extractBrief,
    deterministicScriptFor
};
