/* ============================================
   JARVIS — UGC Studio Prompts
   LLM system prompts + deterministic composers used
   by the UGC Studio workflow: brief extraction,
   script writing, scene planning, natural-language
   edits, and the per-scene reference-image concept.
   The studio never invents product claims; every
   prompt says so explicitly.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const catalog = require('./catalog');
const characterGen = require('../playground/character');

// Resolve the demographic appearance label for a creator. Saved presets carry
// it, but an older preset (or a caller that only stored the category key) may
// not — derive it from the key so the ethnicity is never silently dropped.
function appearanceLabelOf(creator) {
    if (!creator) return '';
    const stored = String(creator.appearanceCategoryLabel || '').trim();
    if (stored) return stored;
    const key = String(creator.appearanceCategory || '').trim();
    return key ? (characterGen.appearanceCategoryLabel(key) || '') : '';
}

// --- Brief extraction ---------------------------------------------------------

const BRIEF_SYSTEM_PROMPT =
    'You are JARVIS\'s UGC Studio. The user wants a short user-generated-content ' +
    '(UGC) video for a product. Extract a structured creative brief from their request.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"objective": "...", "productName": "...", "brand": "...", "productCategory": "...", ' +
    '"contentType": "...", "platform": "...", "duration": null, "aspectRatio": "...", ' +
    '"targetAudience": "...", "tone": "...", "keyMessage": "...", "callToAction": "...", ' +
    '"environment": "...", "creatorDescription": "...", "additionalInstructions": "..."}\n\n' +
    'Rules:\n' +
    '- Extract ONLY what the user said. Never invent product claims, ingredients, ' +
    'certifications, medical benefits, or performance guarantees.\n' +
    '- "contentType" is one of: product-demo, testimonial, unboxing, problem-solution, ' +
    'lifestyle, routine-tutorial, showcase, comparison, review, before-after. Empty if unclear.\n' +
    '- "platform" is one of: tiktok, instagram-reels, instagram, youtube-shorts, youtube, ' +
    'facebook, generic. Empty if the user did not say.\n' +
    '- "duration" is the requested length in seconds as a number, else null.\n' +
    '- "aspectRatio" is one of 9:16, 16:9, 1:1, 4:5, 3:4 when stated, else "".\n' +
    '- "environment" is one of: home, bedroom, bathroom, kitchen, modern-apartment, ' +
    'outdoor-lifestyle, studio, office, cafe, custom. Empty if unclear.\n' +
    '- Empty string for anything the user did not specify. Do not fill with guesses.';

// --- Script -------------------------------------------------------------------

const SCRIPT_SYSTEM_PROMPT =
    'You are JARVIS\'s UGC Studio writing a short-form UGC video script. ' +
    'You write the way a real person talks on camera, not like a corporate advertisement.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"hook": "...", "main": "...", "productInteraction": "...", "closing": "...", ' +
    '"fullText": "..."}\n\n' +
    'Rules:\n' +
    '- "hook": one or two spoken lines that stop the scroll in the first two seconds.\n' +
    '- "main": the core message, in the creator\'s natural voice.\n' +
    '- "productInteraction": what the creator does with the product on camera ' +
    '(application, holding, revealing) — consistent with the supplied product facts.\n' +
    '- "closing": the call to action.\n' +
    '- "fullText": the complete script as a single flowing block the creator would say aloud.\n' +
    '- Speaking pace: the whole script is spoken across the video, so keep the total at ' +
    'about 2.3 words per second of the requested duration (a 15-second video is roughly ' +
    '30-35 words total). A longer script has to be rushed and sounds robotic.\n' +
    '- Keep it concise enough for the requested duration and platform.\n' +
    '- NEVER invent personal experiences, fake testimonials, ingredients, clinical or ' +
    'medical results, prices, or performance guarantees. Use ONLY the supplied product facts.\n' +
    '- No corporate advertising language. No emojis. Plain, conversational language.';

// --- Scenes -------------------------------------------------------------------

const SCENE_SYSTEM_PROMPT =
    'You are JARVIS\'s UGC Studio planning the shot list for a short UGC video. ' +
    'Return a structured scene plan whose total duration matches the requested length.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"scenes": [{"duration": 5, "objective": "...", "action": "...", "dialogue": "...", ' +
    '"camera": {"shotType": "...", "movement": "...", "framing": "..."}, ' +
    '"productVisibility": "...", "transition": "..."}]}\n\n' +
    'Rules:\n' +
    '- Return between 2 and 5 scenes.\n' +
    '- The scene durations in seconds MUST add up to EXACTLY the total requested duration.\n' +
    '- Each scene is one continuous shot; "transition" describes how it cuts from the previous one.\n' +
    '- "productVisibility" describes how the product appears in the scene (or "not visible").\n' +
    '- Speaking pace: each scene\'s "dialogue" must fit that scene\'s "duration" at about ' +
    '2.3 words per second (a 5-second scene is at most ~11 words). Split a longer thought ' +
    'across scenes instead of writing one long line — an over-long line is spoken too fast ' +
    'and sounds robotic. Leave "dialogue" empty in scenes where nobody speaks.\n' +
    '- The creator, outfit and environment stay consistent across scenes unless the brief says otherwise.\n' +
    '- Never invent product claims. Describe only what is on camera.';

// --- Natural-language edit ----------------------------------------------------

const EDIT_SYSTEM_PROMPT =
    'You are JARVIS\'s UGC Studio. Apply the user\'s requested change to the supplied ' +
    'UGC project state. Return the UPDATED state, not a description of the edit.\n\n' +
    'Respond with ONLY a single JSON object with the SAME top-level keys that were given.\n\n' +
    'Rules:\n' +
    '- Apply the change as a real replacement of the affected field(s), not as an appended instruction.\n' +
    '- Preserve every field the user did not ask to change, exactly.\n' +
    '- Never invent product claims, ingredients, certifications, or performance guarantees.\n' +
    '- Keep scene durations summing to the total brief duration when you touch the scenes.\n' +
    '- Keep the creator identity, outfit and environment consistent unless the user asked to change them.';

// --- Deterministic parsing helpers --------------------------------------------

const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30
};

// Parse "15 seconds", "15-second", "15s", "a 20 second video", "half a minute".
function parseDuration(text) {
    const value = String(text || '');
    const unit = '(?:seconds?|secs?|s)';
    let match = value.match(new RegExp('\\b(\\d+(?:\\.\\d+)?)\\s*-?\\s*' + unit + '\\b', 'i'));
    if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    const wordMatch = value.match(new RegExp('\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\s*-?\\s*' + unit + '\\b', 'i'));
    if (wordMatch) {
        const n = NUMBER_WORDS[wordMatch[1].toLowerCase()];
        if (n) return n;
    }
    match = value.match(/\b(?:half\s+a\s+minute|30\s*seconds)\b/i);
    if (match) return 30;
    if (/\b(?:a\s+)?minute\b/i.test(value)) return 60;
    return null;
}

function parseAspectRatio(text) {
    const value = String(text || '');
    const direct = value.match(/\b(9:16|16:9|1:1|4:5|3:4)\b/);
    if (direct) return direct[1];
    if (/\b(?:vertical|portrait|reels?|tiktok|shorts?)\b/i.test(value)) return '9:16';
    if (/\b(?:horizontal|landscape|widescreen)\b/i.test(value)) return '16:9';
    if (/\bsquare\b/i.test(value)) return '1:1';
    return '';
}

const GENERATION_VERB_RE = /\b(?:generate|create|make|produce|render|film|shoot|edit)\b/i;

// Strip the meta framing so the objective is the creative idea, not the command.
function cleanObjective(message) {
    return String(message || '')
        .replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|produce|render|film|shoot)\s+(?:me\s+)?/i, '')
        .replace(/\ba\s+ugc\s+video\b/gi, '')
        .replace(/\bugc\s+video\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function heuristicBrief(message) {
    const raw = String(message || '').trim();
    const duration = parseDuration(raw);
    const aspectRatio = parseAspectRatio(raw);
    const contentType = catalog.detectContentType(raw) || '';
    const platform = catalog.detectPlatform(raw)
        || catalog.defaultPlatformFor(aspectRatio, duration);
    return {
        objective: cleanObjective(raw) || raw,
        productName: '',
        brand: '',
        productCategory: '',
        contentType,
        platform,
        duration,
        aspectRatio,
        targetAudience: '',
        tone: /\bnatural\b|\bnot\s+like\s+an?\s+(?:traditional\s+)?(?:ad|advert)/i.test(raw) ? 'natural, unscripted' : '',
        keyMessage: '',
        callToAction: '',
        environment: catalog.detectEnvironment(raw) || '',
        creatorDescription: '',
        additionalInstructions: ''
    };
}

// --- Speaking-rate budget -----------------------------------------------------
//
// H3 renders a spoken line at the pace the shot's duration implies: a line with
// more words than the shot has seconds gets compressed into a fast, robotic
// delivery. Keep every line inside a natural words-per-second budget so a 5s
// cut carries ~11-12 words, not 25.

const SPEAKING_WORDS_PER_SECOND = 2.3;

function countWords(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value ? value.split(' ').length : 0;
}

// Whole-word budget for a shot of `seconds`, floored so a tiny shot still gets
// a usable line.
function dialogueWordBudget(seconds) {
    const s = Number(seconds) > 0 ? Number(seconds) : 3;
    return Math.max(3, Math.round(s * SPEAKING_WORDS_PER_SECOND));
}

// Trim a spoken line to the budget at the last complete sentence that fits,
// falling back to a whole-word cut. Never cuts mid-word.
function fitDialogueToBudget(text, seconds) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    const budget = dialogueWordBudget(seconds);
    if (countWords(value) <= budget) return value;
    const sentences = value.match(/[^.!?]+[.!?]+/g) || [];
    let out = '';
    for (const sentence of sentences) {
        const next = (out ? out + ' ' : '') + sentence.trim();
        if (countWords(next) > budget) break;
        out = next;
    }
    if (out) return out.trim();
    const clipped = value.split(' ').slice(0, budget).join(' ')
        .replace(/[\s,;:.\-]+$/, '');
    return /[.!?]$/.test(clipped) ? clipped : clipped + '.';
}

// Enforce the budget on every scene in place (after durations are final).
function enforceDialogueBudgets(scenes) {
    for (const scene of (Array.isArray(scenes) ? scenes : [])) {
        if (!scene || !scene.dialogue) continue;
        scene.dialogue = fitDialogueToBudget(scene.dialogue, scene.duration);
    }
    return scenes;
}

// Deterministic script fallback built only from supplied facts.
function deterministicScript(project) {
    const product = project.product || {};
    const brief = project.brief || {};
    const creator = project.creator || {};
    const name = product.name || 'this product';
    const benefit = (product.keyBenefits && product.keyBenefits[0]) || '';
    const action = product.usageInstructions || (product.description ? product.description.slice(0, 140) : '');
    const message = brief.keyMessage || benefit || '';
    const cta = brief.callToAction || ('Available now \u2014 ' + name + '.');
    const hook = 'Okay, so I have been using ' + name +
        (product.brand ? ' from ' + product.brand : '') + ' and I have to show you this.';
    const main = message
        ? message
        : 'Here is what I noticed: ' + (product.description || name) + '.';
    const productInteraction = action
        ? action
        : 'I am holding ' + name + ' so you can see it up close.';
    const closing = cta;
    return {
        hook,
        main,
        productInteraction,
        closing,
        fullText: [hook, main, productInteraction, closing].filter(Boolean).join(' '),
        tone: brief.tone || 'natural',
        hookStyle: 'curiosity',
        approved: false,
        source: 'fallback',
        creatorName: creator.name || ''
    };
}

// Deterministic scene plan. Splits the total duration into equal-ish whole
// seconds so the sum is always exact.
const SCENE_TEMPLATES = {
    'product-demo': [
        { objective: 'Hook the viewer', action: 'The creator speaks straight to camera, drawing attention.', productVisibility: 'product held near the face', camera: { shotType: 'medium close-up', movement: 'static', framing: 'selfie framing' } },
        { objective: 'Show the product', action: 'The creator brings the product into frame and shows it clearly.', productVisibility: 'product fills the frame', camera: { shotType: 'close-up', movement: 'slight push in', framing: 'product-focused' } },
        { objective: 'Demonstrate use', action: 'The creator applies or uses the product naturally.', productVisibility: 'product in active use', camera: { shotType: 'medium shot', movement: 'handheld', framing: 'creator and product' } },
        { objective: 'Close with the call to action', action: 'The creator holds the product and delivers the call to action.', productVisibility: 'product held up', camera: { shotType: 'medium close-up', movement: 'static', framing: 'creator centered' } }
    ],
    default: [
        { objective: 'Open with the hook', action: 'The creator introduces the topic directly to camera.', productVisibility: 'not visible', camera: { shotType: 'medium close-up', movement: 'static', framing: 'selfie framing' } },
        { objective: 'Introduce the product', action: 'The creator brings the product into the scene and reacts.', productVisibility: 'product visible in hand', camera: { shotType: 'medium shot', movement: 'handheld', framing: 'creator and product' } },
        { objective: 'Make the point', action: 'The creator shares the key message about the product.', productVisibility: 'product visible', camera: { shotType: 'close-up', movement: 'slow push in', framing: 'creator and product' } },
        { objective: 'Call to action', action: 'The creator closes with the call to action.', productVisibility: 'product held up', camera: { shotType: 'medium close-up', movement: 'static', framing: 'creator centered' } }
    ]
};

function sceneCountFor(duration) {
    const seconds = Number(duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return 3;
    if (seconds <= 8) return 2;
    if (seconds <= 16) return 3;
    if (seconds <= 30) return 4;
    return 5;
}

// Divide `total` seconds into `count` whole-second chunks that sum exactly.
function splitDuration(total, count) {
    const safeTotal = Math.max(count, Math.round(Number(total) || count * 4));
    const base = Math.floor(safeTotal / count);
    const remainder = safeTotal - base * count;
    const out = [];
    for (let i = 0; i < count; i++) out.push(base + (i < remainder ? 1 : 0));
    return out;
}

// Split an approved script into spoken sentences so the deterministic scene
// fallback still carries on-camera dialogue even when the scene LLM fails.
function scriptSentences(text) {
    const parts = String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g);
    return parts ? parts.map((s) => s.trim()).filter(Boolean) : [];
}

// Spread spoken sentences across the scenes in order (first line in the opening
// scene, last line in the closing scene) so the creator talks to camera
// throughout rather than in a single block.
function distributeDialogue(sentences, count) {
    const out = new Array(count).fill('');
    if (!sentences.length || count <= 0) return out;
    sentences.forEach((line, index) => {
        const slot = Math.min(count - 1, Math.floor((index * count) / sentences.length));
        out[slot] = out[slot] ? out[slot] + ' ' + line : line;
    });
    return out;
}

function deterministicScenes(project) {
    const brief = project.brief || {};
    const duration = Number(brief.duration) > 0 ? Number(brief.duration) : 15;
    const template = SCENE_TEMPLATES[brief.contentType] || SCENE_TEMPLATES.default;
    const count = sceneCountFor(duration);
    const durations = splitDuration(duration, count);
    const dialogueLines = project.script && project.script.fullText
        ? distributeDialogue(scriptSentences(project.script.fullText), count)
        : new Array(count).fill('');
    const scenes = [];
    for (let i = 0; i < count; i++) {
        const base = template[Math.min(i, template.length - 1)];
        scenes.push({
            duration: durations[i],
            objective: base.objective,
            action: base.action,
            dialogue: fitDialogueToBudget(dialogueLines[i], durations[i]),
            camera: base.camera,
            productVisibility: base.productVisibility,
            transition: i === 0 ? 'opens the video' : 'cut from the previous scene'
        });
    }
    return scenes;
}

// The per-scene reference-image concept handed to imageGenerator.buildImagePrompt.
function referenceConcept(project, scene) {
    const product = project.product || {};
    const creator = project.creator || {};
    const outfit = project.outfit || {};
    const environment = project.environment || {};
    const brief = project.brief || {};
    const continuity = project.continuity || {};
    const lines = [];
    const appearanceLabel = appearanceLabelOf(creator);
    lines.push('UGC reference frame for scene ' + (scene.order || 1) + ': ' + String(scene.action || scene.objective || '').trim());
    if (creator.identity) lines.push('Creator: ' + creator.identity + '.');
    // The trait strings alone do not reliably render the demographic, so the
    // appearance category (e.g. "East Asian") is stated explicitly, mirroring
    // the Creative Playground's concept direction.
    if (appearanceLabel) lines.push('Creator appearance category: ' + appearanceLabel + '.');
    if (creator.appearance) lines.push('Creator facial appearance: ' + creator.appearance + '.');
    if (creator.hair) lines.push('Creator hair: ' + creator.hair + '.');
    if (outfit.outfit) lines.push('Outfit: ' + outfit.outfit + '.');
    if (environment.description || environment.label) {
        lines.push('Environment: ' + (environment.description || environment.label) + '.');
    }
    const productBits = [product.name, product.brand, product.category].filter(Boolean).join(', ');
    if (productBits) lines.push('Product on camera: ' + productBits + '.');
    if (product.description) lines.push('Product appearance: ' + product.description + '.');
    const camera = scene.camera || {};
    const cameraText = [camera.shotType, camera.movement, camera.framing].filter(Boolean).join(', ');
    if (cameraText) lines.push('Camera: ' + cameraText + '.');
    if (scene.productVisibility) lines.push('Product visibility: ' + scene.productVisibility + '.');
    if (brief.tone) lines.push('Tone: ' + brief.tone + '.');
    const aspectRatio = brief.aspectRatio || '9:16';
    lines.push('Frame for a ' + aspectRatio + ' aspect ratio.');
    lines.push('Photorealistic, natural UGC phone-camera look, believable and unpolished. ' +
        'One frozen moment, not a collage or storyboard.');
    const constraints = [];
    if (appearanceLabel) constraints.push('Character demographic appearance: ' + appearanceLabel);
    if (continuity.creatorIdentity) constraints.push('Keep the exact same creator identity across every scene');
    if (continuity.outfitState) constraints.push('Keep the exact same outfit across every scene');
    if (continuity.environmentState) constraints.push('Keep the same environment across every scene');
    if (project.creator && project.creator.characterId) {
        constraints.push('Preserve the supplied character identity and facial features');
    }
    if (product.name) constraints.push('Show the exact product "' + product.name + '" as described');
    return { concept: lines.join(' '), constraints };
}

// Strip any existing H3 dialogue wrapper / language tag / quotes from a scene's
// dialogue so it can be re-attributed to the on-screen creator exactly once.
function normalizeDialogue(value) {
    let text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    text = text.replace(/<\/?d>/gi, ' ').replace(/\s+/g, ' ').trim();
    text = text.replace(/^\[[a-z ]+\]\s*/i, '');
    return text.replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim();
}

// Spoken-language tag for the H3 <d>[Language] ...</d> wrapper. H3 defaults to
// its dominant language when the tag is missing (the Mandarin-dialogue bug), so
// the tag is always written explicitly. A named language in the request wins,
// otherwise English.
const DIALOGUE_LANGUAGES = [
    { tag: 'English', re: /\b(?:english|in\s+english)\b/i },
    { tag: 'Chinese', re: /\b(?:chinese|mandarin|cantonese|in\s+chinese)\b/i },
    { tag: 'Spanish', re: /\b(?:spanish|espa[nñ]ol|espanol|castellano)\b/i },
    { tag: 'French', re: /\b(?:french|fran[cç]ais)\b/i },
    { tag: 'German', re: /\b(?:german|deutsch)\b/i },
    { tag: 'Portuguese', re: /\b(?:portuguese|portugu[eê]s)\b/i },
    { tag: 'Italian', re: /\b(?:italian|italiano)\b/i },
    { tag: 'Japanese', re: /\b(?:japanese|nihongo)\b/i },
    { tag: 'Korean', re: /\b(?:korean|hangul)\b/i },
    { tag: 'Hindi', re: /\b(?:hindi|urdu)\b/i },
    { tag: 'Arabic', re: /\b(?:arabic)\b/i },
    { tag: 'Russian', re: /\b(?:russian)\b/i }
];

function detectDialogueLanguage(text) {
    const value = String(text || '');
    if (!value.trim()) return '';
    for (const entry of DIALOGUE_LANGUAGES) {
        if (entry.re.test(value)) return entry.tag;
    }
    return '';
}

function dialogueLanguageFor(project) {
    const brief = (project && project.brief) || {};
    const explicit = String(brief.dialogueLanguage || '').trim();
    if (explicit) return explicit;
    return detectDialogueLanguage(project && project.request)
        || detectDialogueLanguage(brief.additionalInstructions)
        || 'English';
}

// Compose the Director's canonical brief from a UGC project. The structured
// scene plan becomes the Director's shot list, so the handoff is not a text blob.
function directorBrief(project) {
    const product = project.product || {};
    const creator = project.creator || {};
    const outfit = project.outfit || {};
    const environment = project.environment || {};
    const brief = project.brief || {};
    const language = dialogueLanguageFor(project);
    const scenes = Array.isArray(project.scenes) ? project.scenes : [];
    const subjectParts = [];
    if (creator.identity) subjectParts.push(creator.identity);
    else subjectParts.push('a relatable creator');
    if (product.name) subjectParts.push('presenting ' + product.name);
    const shotList = scenes.map((scene) => {
        const action = String(scene.action || scene.objective || '').trim();
        const camera = scene.camera || {};
        const cam = [camera.shotType, camera.movement].filter(Boolean).join(' ');
        let shot = (action + (cam ? ' (camera: ' + cam + ')' : '')).replace(/\s+$/, '').replace(/\.+$/, '');
        const dialogue = fitDialogueToBudget(normalizeDialogue(scene.dialogue), scene.duration);
        if (dialogue) {
            // The creator speaks on camera, so the line keeps a stable (S1) ID and
            // an H3 <d> wrapper. The explicit language tag stops H3 from inventing
            // speech in its dominant language. This is what makes H3 render
            // visible lip-sync instead of treating the words as off-screen
            // narration. The H3 stage also re-asserts this dialogue
            // deterministically (ensureShotDialogue) because the director LLM
            // otherwise drops it.
            shot += '. The on-screen creator (S1) says: <d>[' + language + '] ' + dialogue + '</d>';
        }
        return shot;
    }).filter(Boolean);
    const appearanceLabel = appearanceLabelOf(creator);
    const details = [];
    if (appearanceLabel) details.push('creator appearance category: ' + appearanceLabel);
    if (product.brand) details.push('brand: ' + product.brand);
    if (product.keyBenefits && product.keyBenefits.length) details.push('benefits: ' + product.keyBenefits.join(', '));
    if (outfit.outfit) details.push('outfit: ' + outfit.outfit);
    if (shotList.some((shot) => shot.includes('<d>'))) {
        details.push('the creator speaks directly to camera in ' + language + ' with natural on-camera lip-sync');
    }
    if (brief.callToAction) details.push('call to action: ' + brief.callToAction);
    if (product.claimsToAvoid && product.claimsToAvoid.length) {
        details.push('never claim: ' + product.claimsToAvoid.join(', '));
    }
    return {
        originalRequest: project.request || '',
        subject: subjectParts.join(' '),
        setting: environment.description || environment.label || '',
        action: scenes.length ? String(scenes[0].action || '') : '',
        mood: brief.tone || 'natural, authentic',
        visualStyle: 'photorealistic UGC phone-camera look, natural light',
        camera: 'handheld medium close-up',
        cameraMovement: 'subtle handheld motion',
        temporal: scenes.map((s) => s.action).filter(Boolean).join(' then '),
        sound: '',
        aspectRatio: brief.aspectRatio || '9:16',
        shots: String(shotList.length || 1),
        shotList,
        explicitConstraints: [
            'This is authentic user-generated content, not a polished advertisement',
            'Keep the creator, outfit, product and environment consistent across every shot'
        ],
        details: details.join('; '),
        creativeMode: 'none'
    };
}

module.exports = {
    BRIEF_SYSTEM_PROMPT,
    SCRIPT_SYSTEM_PROMPT,
    SCENE_SYSTEM_PROMPT,
    EDIT_SYSTEM_PROMPT,
    GENERATION_VERB_RE,
    parseDuration,
    parseAspectRatio,
    cleanObjective,
    heuristicBrief,
    deterministicScript,
    deterministicScenes,
    scriptSentences,
    distributeDialogue,
    normalizeDialogue,
    detectDialogueLanguage,
    dialogueLanguageFor,
    splitDuration,
    sceneCountFor,
    SPEAKING_WORDS_PER_SECOND,
    countWords,
    dialogueWordBudget,
    fitDialogueToBudget,
    enforceDialogueBudgets,
    referenceConcept,
    directorBrief
};
