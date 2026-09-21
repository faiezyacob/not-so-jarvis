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
    SELECT_CREATOR: 'select_creator',
    CREATE_CREATOR: 'create_creator',
    RANDOM_CREATOR: 'random_creator',
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
    EDIT_DIRECTION: 'edit_direction',
    APPROVE_REFERENCES: 'approve_references',
    CONTINUE_DIRECTOR: 'continue_director',
    SAVE_DRAFT: 'save_draft',
    EXIT: 'exit',
    RESUME: 'resume',
    DISCARD: 'discard',
    VIEW_BRIEF: 'view_brief'
});

const MARKER_RE = /\[\[ugc:(\{[^\n]*?\})\]\]/g;

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
    const duration = Number(src.duration);
    return {
        objective: clean(src.objective),
        contentType: clean(src.contentType, 60),
        platform: clean(src.platform, 60),
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        aspectRatio: clean(src.aspectRatio, 12) || '9:16',
        targetAudience: clean(src.targetAudience),
        tone: clean(src.tone, 200),
        keyMessage: clean(src.keyMessage),
        callToAction: clean(src.callToAction),
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
        creatorName: clean(input.creatorName, 80)
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
    const duration = Number(src.duration);
    return {
        id: clean(src.id, 40) || ('scn_' + (index + 1)),
        order: index + 1,
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 3,
        objective: clean(src.objective, 300),
        action: clean(src.action, 600),
        dialogue: clean(src.dialogue, 600),
        camera: normalizeCamera(src.camera),
        environment: clean(src.environment, 300),
        outfit: clean(src.outfit, 400),
        productVisibility: clean(src.productVisibility, 200),
        transition: clean(src.transition, 200),
        status: clean(src.status, 30) || 'planned',
        referenceUrl: clean(src.referenceUrl, 500) || null
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
        request: clean(raw.request),
        product: raw.product && typeof raw.product === 'object' ? raw.product : null,
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
                status: clean(r && r.status, 30) || 'ready'
            }))
            : [],
        approvedReferences: Array.isArray(raw.approvedReferences)
            ? raw.approvedReferences.map((r) => ({
                sceneId: clean(r && r.sceneId, 40),
                order: Number(r && r.order) || 0,
                url: clean(r && r.url, 500),
                filename: clean(r && r.filename, 300)
            }))
            : [],
        directorProductionId: clean(raw.directorProductionId, 60) || null,
        suggestedProductName: clean(raw.suggestedProductName, 120),
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: raw.updatedAt || new Date().toISOString()
    };
    return project;
}

// --- Stage machine ------------------------------------------------------------

function nextSetupStage(project) {
    if (!project.product || !project.product.name) return STAGES.PRODUCT_SELECTION;
    if (!project.creator) return STAGES.CREATOR_SELECTION;
    if (!project.contentType || !project.outfit || !project.environment) return STAGES.CREATIVE_DIRECTION;
    return STAGES.BRIEF;
}

function markActive(project) {
    if (project.status === STATUS.DRAFT) project.status = STATUS.ACTIVE;
    return project;
}

function isActive(project) {
    return Boolean(project && project.status === STATUS.ACTIVE);
}

function isOpen(project) {
    return Boolean(project && (project.status === STATUS.ACTIVE
        || project.stage === STAGES.REFERENCE_APPROVAL
        || project.stage === STAGES.SCENE_REVIEW
        || project.stage === STAGES.SCRIPT_REVIEW));
}

function save(project) {
    if (!project) return null;
    if (project.scenes && project.scenes.length) reconcileContinuity(project);
    project.updatedAt = new Date().toISOString();
    state.setProject(project.conversationId, project);
    return project;
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
    const textKeys = ['objective', 'targetAudience', 'tone', 'keyMessage', 'callToAction', 'additionalInstructions'];
    for (const key of textKeys) {
        const value = clean(parsed[key]);
        if (value) out[key] = value;
    }
    const duration = Number(parsed.duration);
    if (Number.isFinite(duration) && duration > 0) out.duration = Math.round(duration);
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
    // Keep the product name/brand on the returned brief for binding.
    out.productName = clean(parsed.productName, 120) || out.productName || '';
    out.brand = clean(parsed.brand, 120);
    out.productCategory = clean(parsed.productCategory, 120);
    out.creatorDescription = clean(parsed.creatorDescription, 400);
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
    const existing = products.findByName(brief.productName);
    const project = normalizeProject({
        id: makeId('ugc'),
        conversationId,
        status: STATUS.ACTIVE,
        stage: STAGES.BRIEF,
        request: message,
        product: existing ? products.snapshot(existing) : null,
        environment: environmentFromBrief(brief),
        contentType: contentTypeFromBrief(brief),
        brief: Object.assign({}, brief, { duration: brief.duration || 15 }),
        continuity: {},
        createdAt: new Date().toISOString()
    });
    project.stage = nextSetupStage(project);
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
    project.stage = nextSetupStage(project);
    return save(project);
}

function createProduct(project, input) {
    const payload = Object.assign({}, input);
    // The brief often already named the product; keep that name/brand.
    if (!payload.name && project.product && project.product.name) payload.name = project.product.name;
    const product = products.create(payload);
    project.product = products.snapshot(product);
    project.stage = nextSetupStage(project);
    return save(project);
}

function selectCreator(project, characterId) {
    const preset = characterPresets.get(characterId);
    if (!preset) return project;
    project.creator = {
        characterId: preset.id,
        source: 'character',
        name: preset.name || 'Character',
        identity: preset.identity || '',
        appearance: preset.appearance || '',
        hair: preset.hair || '',
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
    project.stage = nextSetupStage(project);
    return save(project);
}

function randomCreator(project, profile) {
    const normalized = characterGen.normalizeProfile(profile);
    const generated = characterGen.generateUniqueIdentity(Math.random, [], normalized);
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
    project.stage = nextSetupStage(project);
    return save(project);
}

// Resolve an Outfit Pack into a concrete outfit (never pass the pack name alone
// to the image/video model).
function selectOutfit(project, packId, customText, rng) {
    const normalized = outfitPacks.normalizePackId(packId);
    if (!normalized) {
        project.outfit = null;
        project.stage = nextSetupStage(project);
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
        project.stage = nextSetupStage(project);
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
    project.stage = nextSetupStage(project);
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
    project.stage = nextSetupStage(project);
    return save(project);
}

function selectContentType(project, id) {
    const entry = catalog.getContentType(id);
    if (!entry) return project;
    project.contentType = { id: entry.id, label: entry.label };
    project.brief.contentType = entry.id;
    project.stage = nextSetupStage(project);
    return save(project);
}

function editBrief(project, patch) {
    const src = patch && typeof patch === 'object' ? patch : {};
    const next = Object.assign({}, project.brief);
    for (const key of ['objective', 'targetAudience', 'tone', 'keyMessage', 'callToAction', 'additionalInstructions']) {
        if (hasOwn(src, key)) next[key] = clean(src[key]);
    }
    if (hasOwn(src, 'duration')) {
        const duration = Number(src.duration);
        if (Number.isFinite(duration) && duration > 0) next.duration = Math.round(duration);
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
    if (project.scenes && project.scenes.length) {
        fitDurations(project.scenes, project.brief.duration);
    }
    return save(project);
}

// --- Script -------------------------------------------------------------------

// Re-derive the brief from the original request (used by "Regenerate Brief").
async function regenerateBrief(project, { provider, model, think }) {
    const brief = await extractBrief(project.request || '', { provider, model, think });
    project.brief = normalizeBrief(Object.assign({}, project.brief, brief, {
        duration: brief.duration || project.brief.duration || 15
    }));
    if (brief.productName && !(project.product && project.product.name)) {
        const existing = products.findByName(brief.productName);
        if (existing) project.product = products.snapshot(existing);
        else project.suggestedProductName = brief.productName;
    }
    if (brief.environment && !project.environment) {
        project.environment = environmentFromBrief(brief);
    }
    if (brief.contentType && !project.contentType) {
        project.contentType = contentTypeFromBrief(brief);
    }
    return save(project);
}

async function generateScript(project, { provider, model, think, feedback, field }) {
    const product = project.product || {};
    const brief = project.brief || {};
    const creator = project.creator || {};
    const context = [
        'PRODUCT: ' + JSON.stringify(product),
        'CREATIVE BRIEF: ' + JSON.stringify(brief),
        'CONTENT TYPE: ' + (project.contentType ? project.contentType.label : ''),
        'CREATOR: ' + JSON.stringify({ name: creator.name, identity: creator.identity, tone: brief.tone }),
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
        const duration = Number(src.duration);
        if (Number.isFinite(duration) && duration > 0) scene.duration = Math.round(duration);
    }
    scene.status = 'planned';
    scene.referenceUrl = null;
    if (project.brief && project.brief.duration) fitDurations(project.scenes, project.brief.duration);
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
    return save(project);
}

function approveScenes(project) {
    if (!project.scenes || !project.scenes.length) return project;
    project.scenes.forEach((s) => { s.status = 'approved'; });
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
    project.references = (project.references || []).filter((r) => r.sceneId !== sceneId);
    return save(project);
}

function setDirectorProduction(project, productionId) {
    if (!project) return null;
    project.directorProductionId = productionId || null;
    project.stage = STAGES.VIDEO_GENERATION;
    return save(project);
}

// --- Reference images ---------------------------------------------------------

// Build the structured request for one scene's reference frame. The concept is
// direction only; imageGenerator.buildImagePrompt owns the final prompt.
function buildReferenceRequest(project, scene) {
    reconcileContinuity(project);
    const built = prompts.referenceConcept(project, scene);
    return {
        intent: 'image_generation',
        user_prompt: built.concept,
        previous_prompt: '',
        creative_mode: 'light',
        explicit_constraints: built.constraints
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
        status: 'ready'
    });
    list.sort((a, b) => a.order - b.order);
    project.references = list;
    return save(project);
}

function markReferencesReady(project) {
    project.stage = STAGES.REFERENCE_APPROVAL;
    return save(project);
}

function approveReferences(project) {
    project.approvedReferences = (project.references || []).map((r) => ({
        sceneId: r.sceneId,
        order: r.order,
        url: r.url,
        filename: r.filename
    }));
    project.references = (project.references || []).map((r) => Object.assign({}, r, { status: 'approved' }));
    project.stage = STAGES.VIDEO_GENERATION;
    return save(project);
}

// The opening frame the Director animates: the first approved reference.
function resolveOpeningFrame(project) {
    const approved = project.approvedReferences && project.approvedReferences.length
        ? project.approvedReferences
        : (project.references || []);
    const first = approved.find((r) => r && r.filename) || null;
    if (!first) return null;
    return { url: first.url, filename: first.filename };
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
// (so an unrelated generation request still flows to the normal router).
function classifyMessage(message, project) {
    const text = String(message || '').trim();
    if (!text || !project) return null;

    // A targeted scene regenerate and a duration change are edits even though
    // they can contain "video" — check them before the continue cue.
    const sceneMatch = text.match(/regenerate\s+(?:only\s+)?scene\s+(\d+)/i);
    if (sceneMatch) {
        return { action: 'regenerate_reference', sceneNumber: Number(sceneMatch[1]) };
    }
    if (DURATION_EDIT_RE.test(text)) return { action: 'edit', message: text };

    if (CONTINUE_VIDEO_RE.test(text)) return { action: 'continue_director' };
    if (REFERENCE_REQUEST_RE.test(text)) return { action: 'generate_references' };

    if (APPROVE_RE.test(text)) {
        if (project.stage === STAGES.SCRIPT_REVIEW) return { action: 'approve_script' };
        if (project.stage === STAGES.SCENE_REVIEW) return { action: 'approve_scenes' };
        if (project.stage === STAGES.REFERENCE_APPROVAL) return { action: 'approve_references' };
        if (project.stage === STAGES.BRIEF || project.stage === STAGES.CREATIVE_DIRECTION) {
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
    const lower = text.toLowerCase();

    // 1. Duration.
    const duration = prompts.parseDuration(text);
    if (duration && /\b(?:make|change|set|shorten|lengthen|video|duration|length|seconds?)\b/i.test(text)) {
        project.brief.duration = duration;
        if (project.scenes && project.scenes.length) fitDurations(project.scenes, duration);
        changed.push('duration');
    }

    // 2. Remove the CTA.
    if (/\b(?:remove|drop|delete|no)\s+(?:the\s+)?(?:cta|call\s+to\s+action)\b/i.test(text) && project.script) {
        project.script.closing = '';
        project.script.fullText = [project.script.hook, project.script.main, project.script.productInteraction]
            .filter(Boolean).join(' ');
        project.script.approved = false;
        changed.push('script');
    }

    // 3. "Keep the same outfit in every scene".
    if (/\b(?:keep|use)\s+(?:the\s+)?same\s+outfit\b/i.test(text) || /\boutfit\s+in\s+every\s+scene\b/i.test(text)) {
        const outfitText = (project.outfit && project.outfit.outfit) || project.continuity.outfitState || '';
        if (outfitText) {
            project.continuity.outfitState = outfitText;
            (project.scenes || []).forEach((s) => { s.outfit = outfitText; });
            changed.push('continuity');
        }
    }

    // 4. Outfit change (pack, or "put <name> in <pack>").
    const packId = outfitPacks.detectOutfitPackFromText(text);
    if (packId && /\b(?:outfit|wear|wearing|put|dress|wardrobe|clothes)\b/i.test(text)) {
        selectOutfit(project, packId, '', Math.random);
        changed.push('outfit');
    }

    // 5. Environment change.
    const envId = catalog.detectEnvironment(text);
    if (envId) {
        selectEnvironment(project, envId, envId === 'custom' ? text : '');
        changed.push('environment');
    }

    // 6. Creator change by name ("use Maya as the creator").
    const namedCreator = text.match(/\buse\s+([A-Z][\w'-]{1,30})\s+as\s+(?:the\s+)?creator\b/i)
        || text.match(/\b(?:creator|character)\s+([A-Z][\w'-]{1,30})\b/);
    if (namedCreator) {
        const name = namedCreator[1].toLowerCase();
        const preset = characterPresets.list().find((c) => String(c.name || '').toLowerCase() === name);
        if (preset) {
            selectCreator(project, preset.id);
            changed.push('creator');
        }
    }
    if (/\b(?:another|different|new)\s+creator\b/i.test(text) || /\bchange\s+(?:the\s+)?creator\b/i.test(text)) {
        project.stage = STAGES.CREATOR_SELECTION;
        changed.push('creator_selection');
    }

    // 7. Explicit scene-targeted camera/action edits.
    const sceneMatch = text.match(/scene\s+(\d+)/i);
    if (sceneMatch && project.scenes && project.scenes.length) {
        const scene = project.scenes.find((s) => s.order === Number(sceneMatch[1]));
        if (scene) {
            if (/\bclose[\s-]?up\b/i.test(text)) {
                scene.camera = Object.assign(normalizeCamera(scene.camera), { shotType: 'close-up', framing: 'product-focused' });
                changed.push('scene');
            }
            if (/\bproduct\s+(?:shot|focus|close)\b/i.test(text)) {
                scene.productVisibility = 'product fills the frame';
                changed.push('scene');
            }
            if (/\bcamera\s+(?:movement|moves?)\b/i.test(text) && /\bcontinue|same\b/i.test(text)) {
                const previous = project.scenes.find((s) => s.order === Number(sceneMatch[1]) - 1);
                if (previous) {
                    scene.camera = Object.assign(normalizeCamera(scene.camera), {
                        movement: previous.camera.movement || 'slow push in'
                    });
                    changed.push('scene');
                }
            }
            scene.status = 'planned';
            scene.referenceUrl = null;
        }
    }

    // 8. LLM fallback for anything else substantial (or a clearer rewrite).
    if (!changed.length && EDIT_VERB_RE.test(text)) {
        const updated = await llmEditProject(project, text, { provider, model, think });
        if (updated) changed.push(...updated);
    }

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
        project.script = next;
        changed.push('script');
    }
    if (hasOwn(parsed, 'scenes') && Array.isArray(parsed.scenes) && parsed.scenes.length) {
        project.scenes = normalizeSceneList(parsed.scenes, project);
        changed.push('scenes');
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
    const duration = Math.min(DIRECTOR_MAX_SECONDS, Math.max(5, requested));
    return {
        brief,
        duration,
        originalRequest: project.request || '',
        openingFrame: resolveOpeningFrame(project)
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
        title: 'UGC Studio',
        request: project.request,
        product: project.product || null,
        creator: project.creator || null,
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
            referenceUrl: s.referenceUrl
        })),
        references: (project.references || []).map((r) => ({
            sceneId: r.sceneId, order: r.order, url: r.url, prompt: r.prompt, status: r.status
        })),
        continuity: project.continuity,
        directorProductionId: project.directorProductionId,
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
    exitProject,
    resumeProject,
    selectCreator,
    randomCreator,
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
    editScene,
    addScene,
    deleteScene,
    moveScene,
    approveScenes,
    fitDurations,
    buildReferenceRequest,
    recordReference,
    markReferencesReady,
    approveReferences,
    resolveOpeningFrame,
    reconcileContinuity,
    classifyMessage,
    applyNaturalEdit,
    directorProductionInput,
    buildCard,
    renderContent,
    normalizeAction,
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
