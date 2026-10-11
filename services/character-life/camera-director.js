/* ============================================
   JARVIS — Camera Director
   Turns conversational intent + the character's
   life state into a structured photo-generation
   specification: viewpoint, subject, activity,
   location, outfit, framing, angle, composition
   and lighting. It is deliberately independent of
   the character identity system: identity is applied
   upstream, and a rear-camera subject/scenery photo
   never forces the character's face into frame.

   Pure + deterministic. No fs, no network.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const outfitContext = require('../playground/outfit-context');

const INTENT = {
    SELFIE: 'selfie',
    OUTFIT: 'outfit',
    SUBJECT: 'subject',
    SCENERY: 'scenery',
    GROUP: 'group',
    SCENE_REF: 'scene_reference',
    NONE: 'none'
};

const CAMERA_VIEW = { FRONT: 'front', REAR: 'rear', MIRROR: 'mirror' };

const PHOTO_NOUN_RE = /\b(?:pics?|pictures?|photos?|photographs?|selfies?|snaps?(?:hot)?|images?)\b/i;
const PHOTO_VERB_RE = /\b(?:show|send|take|snap|grab|share|let me see|lemme see|put up|wanna see|want to see)\b/i;
const SELFIE_RE = /\b(?:selfie|of (?:you|yourself)|your (?:face|selfie)|let me see you|see your face|how (?:do )?you look|pic(?:ture)? of you|photo(?:graph)? of you)\b/i;
const OUTFIT_RE = /\b(?:outfit|ootd|what (?:are|'?re) you wearing|what you(?:'?re| are) wearing|your (?:look|style|clothes|wardrobe)|mirror selfie|outfit check|dressed (?:up|in))\b/i;
const MIRROR_RE = /\b(?:mirror|full[- ]body|head[- ]to[- ]toe|whole outfit|outfit check)\b/i;
const SCENERY_RE = /\b(?:the (?:view|scenery|landscape|sunset|sunrise|sky|place|city|beach|park|mountains?|sea|ocean|street|water)|scenery|landscape|view from|where you are|around you|surroundings|what it looks like)\b/i;
const GROUP_RE = /\b(?:group (?:photo|pic(?:ture)?|shot|selfie)|with (?:your )?(?:friends|family|everyone|the (?:group|crew|girls|boys|team))|all of you|you (?:and|with) (?:your )?(?:friends|family))\b/i;
const FOOD_RE = /\b(?:eat(?:ing)?|ate|food|meal|breakfast|lunch|dinner|snack|dessert|coffee|tea|drink(?:ing)?|cook(?:ing)?|bak(?:ing)?|drinking|making|made)\b/i;
const ANIMAL_RE = /\b(?:cat|dog|kitten|puppy|pet|bird|rabbit|hamster|horse|animal)\b/i;
const OBJECT_RE = /\b(?:book|guitar|piano|plant|plants|flower|flowers|laptop|phone|painting|drawing|canvas|car|bike|bicycle|garden|desk|room|project)\b/i;
const GENERATION_VERB_RE = /\b(?:generate|create|draw|render|paint|produce|design|imagine)\b/i;
const SCENE_SETTING_RE = /\b(?:in (?:paris|tokyo|london|new york|rome|berlin|a forest|the forest|space|a castle|the desert)|wearing (?:a|an|the) .+ (?:dress|suit|gown|armor)|as (?:a|an) .+|medieval|cyberpunk|fantasy|sci[- ]?fi|superhero)\b/i;

// "send me a pic" / "let me see you" / "show me what you're doing" default to a
// casual front-camera selfie without another recognized subject.
const DEFAULT_SELFIE_RE = /\b(?:show me what you(?:'?re| are) (?:doing|up to|wearing)|send (?:me )?(?:a |another )?(?:pic|photo|selfie)|let me see you|how are you looking|wanna see you|want to see you)\b/i;

function normalize(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

// Extract a short object noun phrase for a subject photo. Falls back to a
// category phrase when the request is implicit ("what are you eating").
function extractSubject(message, category) {
    const text = normalize(message);
    const patterns = [
        /\b(?:show|send|see|of|at)\s+(?:me\s+)?(?:your|the|that|this|a|an)\s+([^,.!?]{2,50})/i,
        /\b(?:show|send)\s+me\s+([^,.!?]{2,50})/i,
        /\bwhat\s+you(?:'?re| are)\s+(?:eating|drinking|making|cooking|reading|holding|working on)\b/i
    ];
    for (const re of patterns) {
        const match = re.exec(text);
        if (match && match[1]) {
            const phrase = match[1].replace(/\b(?:right now|please|rn|pls)\b/gi, '').replace(/\s+/g, ' ').trim();
            if (phrase) return phrase.replace(/\b(?:pic|picture|photo|photograph)\b/gi, '').trim() || phrase;
        }
    }
    if (category === 'food') return 'the food she is having';
    if (category === 'animal') return 'the animal';
    if (category === 'object') return 'the thing she is focused on';
    return 'what she is looking at';
}

function detectCategory(message) {
    const text = normalize(message);
    if (ANIMAL_RE.test(text)) return 'animal';
    if (FOOD_RE.test(text)) return 'food';
    if (OBJECT_RE.test(text)) return 'object';
    return null;
}

// Classify a message into a photo intent. Returns
// { intent, confidence: 'definite'|'default'|'none', subject, groupSize }.
// Conservative: a general image-generation request ("generate an image of X in
// Paris") is NOT a life-state photo request and returns NONE so the normal
// pipeline owns it.
function detectPhotoIntent(message, options) {
    const text = normalize(message);
    if (!text) return { intent: INTENT.NONE, confidence: 'none', subject: '', groupSize: 0 };
    const opts = options || {};
    const names = (Array.isArray(opts.names) ? opts.names : []).map((n) => String(n || '').trim()).filter(Boolean);
    const hasPhotoWord = PHOTO_NOUN_RE.test(text);
    const hasPhotoVerb = PHOTO_VERB_RE.test(text);
    const generationOnly = GENERATION_VERB_RE.test(text) && !hasPhotoVerb;

    // A photo explicitly OF the character (or "of her/him/you") is a selfie /
    // identity request even when the message also mentions a place or view.
    const nameAlt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const ofPersonRe = nameAlt
        ? new RegExp('\\b(?:photos?|pics?|pictures?|images?|selfies?)\\s+of\\s+(?:' + nameAlt + '|her|him|them|you|yourself)\\b', 'i')
        : /\b(?:photos?|pics?|pictures?|images?|selfies?)\s+of\s+(?:her|him|them|you|yourself)\b/i;
    if (ofPersonRe.test(text)) {
        return { intent: INTENT.SELFIE, confidence: 'definite', subject: '', groupSize: 0 };
    }

    if (SCENE_SETTING_RE.test(text) && !SELFIE_RE.test(text) && !OUTFIT_RE.test(text)) {
        return { intent: INTENT.NONE, confidence: 'none', subject: '', groupSize: 0 };
    }
    if (generationOnly && !SELFIE_RE.test(text)) {
        return { intent: INTENT.NONE, confidence: 'none', subject: '', groupSize: 0 };
    }

    if (GROUP_RE.test(text)) {
        return { intent: INTENT.GROUP, confidence: 'definite', subject: 'a group of her friends', groupSize: 3 };
    }
    if (OUTFIT_RE.test(text)) {
        const mirror = MIRROR_RE.test(text) || /\boutfit|ootd|what you(?:'?re| are) wearing|your look\b/i.test(text);
        return { intent: INTENT.OUTFIT, confidence: 'definite', subject: '', groupSize: 0, mirror };
    }
    if (SCENERY_RE.test(text) && hasPhotoVerb) {
        return { intent: INTENT.SCENERY, confidence: 'definite', subject: '', groupSize: 0 };
    }
    // "Show me you cooking" / "a pic of you running" is a photo OF her doing
    // the action, so it stays a selfie even though it names a food/object word.
    const youAction = /\byou\s+[a-z]+ing\b/i.test(text);
    if (/\b(?:show me|send me|see|pic of|picture of|photo of)\s+you\b/i.test(text) ||
        (hasPhotoVerb && youAction)) {
        return { intent: INTENT.SELFIE, confidence: 'definite', subject: '', groupSize: 0 };
    }
    const category = detectCategory(text);
    // A subject request needs an explicit "show/send/see" or a food/animal noun
    // tied to the photo verb, so "what are you eating?" alone stays chat.
    if (category && (hasPhotoVerb || /\bshow me|send me|let me see|pic of|picture of|photo of\b/i.test(text))) {
        return { intent: INTENT.SUBJECT, confidence: 'definite', subject: extractSubject(text, category), category, groupSize: 0 };
    }
    if (SELFIE_RE.test(text)) {
        return { intent: INTENT.SELFIE, confidence: 'definite', subject: '', groupSize: 0 };
    }
    if (DEFAULT_SELFIE_RE.test(text)) {
        return { intent: INTENT.SELFIE, confidence: 'definite', subject: '', groupSize: 0 };
    }
    // Ambiguous: a bare photo noun with a "show/send/take me" verb, with no
    // other subject, defaults to a selfie.
    if (hasPhotoWord && PHOTO_VERB_RE.test(text) && !category) {
        return { intent: INTENT.SELFIE, confidence: 'default', subject: '', groupSize: 0 };
    }
    return { intent: INTENT.NONE, confidence: 'none', subject: '', groupSize: 0 };
}

function isAcceptance(message) {
    const text = normalize(message).toLowerCase();
    if (!text) return false;
    return /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|do it|pwease|alright|of course|absolutely|sounds good|why not|send it|show me|let'?s see (?:it|them))\b/.test(text)
        || /\b(?:yes please|go ahead|send it over|show me|i'?d love to see|sure thing)\b/.test(text);
}

function isRejection(message) {
    const text = normalize(message).toLowerCase();
    return /^(?:no|nope|nah|don'?t|not now|no thanks|maybe later|later)\b/.test(text);
}

// Generic phrases that add no real direction; dropping them keeps the prompt
// clean when the user only restated the request type.
const GENERIC_SCENE_PHRASES = new Set([
    '', 'outfit', 'your outfit', 'the outfit', 'view', 'the view', 'scenery', 'landscape',
    'selfie', 'a selfie', 'pic', 'a pic', 'picture', 'a picture', 'photo', 'a photo',
    'photograph', 'image', 'an image', 'you', 'yourself', 'me', 'your face', 'face',
    'what you are wearing', "what you're wearing", 'wearing', 'your look', 'your style'
]);

// The garment phrase a user explicitly names ("wearing a tank top" -> "a tank
// top"). Empty when they named none. Used to override the life-state outfit for
// that single generation — the stored life state is never changed.
function extractClothing(message) {
    const text = normalize(message);
    if (!text) return '';
    // Stop the garment phrase at a following scene preposition so "wearing a red
    // dress at the beach" yields the dress, leaving "at the beach" as scene.
    const m = /\b(?:wear|wearing|wears)\s+(.+?)(?=\s+(?:at|in|on|near|by|outside|inside)\s+(?:the|a|an|my|her|his|their)\b|[.!?,;]|$)/i.exec(text);
    if (!m || !m[1]) return '';
    return m[1]
        .replace(/\b(?:please|right now|now|rn|today|tonight)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,]+|[.!?,;:\s]+$/g, '')
        .trim();
}

// The descriptive part of a photo request with the imperative preamble stripped
// ("send me a selfie of you wearing a tank top at the beach" -> "at the beach"
// after the clothing is separated). Returns '' for a bare request.
function extractUserScene(message) {
    let t = normalize(message).replace(/@[A-Za-z0-9_]+/g, ' ');
    t = t.replace(/^\s*(?:hey\s+|hi\s+|ok(?:ay)?\s+|can you\s+|could you\s+|would you\s+|please\s+)*(?:send|show|take|snap|grab|share|give|let me see|lemme see|i want(?: to see)?|wanna see|want to see)\b[\s,]*/i, ' ');
    t = t.replace(/^\s*(?:me\s+)?(?:a|an|another|the)?\s*(?:pic(?:ture)?|photo(?:graph)?|selfie|snap(?:shot)?|image)?\s*(?:of|with|showing)?\s*(?:(?:yourself|your|you|me)\b)?\s*/i, ' ');
    t = t.replace(/^\s*(?:of|with|in|at|on|showing)\s+/i, ' ');
    return t.replace(/\s+/g, ' ').replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
}

// Split a photo request into an explicit clothing override and any remaining
// scene specifics. Trivial/generic content is dropped so the camera direction
// stays authoritative unless the user actually added detail.
function parseUserRequest(message) {
    const text = normalize(message);
    if (!text) return { clothing: '', scene: '' };
    // A bare "yes please" / "no thanks" carries no scene detail. This is a
    // stricter affirmation check than isAcceptance (which also treats "show me"
    // as an acceptance in the offer flow), because "show me you cooking" is a
    // real request.
    const AFFIRM_RE = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|do it|alright|sounds good|why not|send it|yes please|sure thing|absolutely|of course|i'?d love)\b/i;
    const REJECT_RE = /^(?:no|nope|nah|don'?t|not now|no thanks|maybe later|later)\b/i;
    if (AFFIRM_RE.test(text) || REJECT_RE.test(text)) return { clothing: '', scene: '' };
    const clothing = extractClothing(text);
    let scene = extractUserScene(text);
    if (clothing) {
        const idx = scene.toLowerCase().indexOf(clothing.toLowerCase());
        if (idx !== -1) scene = (scene.slice(0, idx) + ' ' + scene.slice(idx + clothing.length)).trim();
        scene = scene.replace(/\b(?:wearing|wear|wears)\b/gi, ' ');
    }
    scene = scene
        .replace(/^(?:your\s+|the\s+|a\s+|an\s+)?(?:outfit|look|style|selfie|pic(?:ture)?|photo(?:graph)?|image|face)\b[\s,]*/i, '')
        .replace(/^(?:while|as|when)\s+/i, '')
        .replace(/^(?:and|then|just)\s+/i, '')
        .replace(/\s+/g, ' ')
        .replace(/^[,.\s]+|[,.\s]+$/g, '')
        .trim();
    if (GENERIC_SCENE_PHRASES.has(scene.toLowerCase())) scene = '';
    // References to her own current activity ("what you're doing", "what you
    // are up to") are not a requested action; the life state answers them.
    if (/^what\b/i.test(scene)) scene = '';
    return { clothing, scene };
}

// Whether a phrase reads as an action/pose the character can be shown doing
// ("lying on the bed", "sitting on the couch", "at the beach"). A bare noun or
// modifier ("a big smile") is carried as an extra detail instead.
function looksLikeAction(phrase) {
    const text = String(phrase || '').trim();
    if (!text) return false;
    return /^(?:[a-z]{2,}ing\b|at\b|in\b|on\b|near\b|by\b|outside\b|inside\b|under\b|behind\b|beside\b|between\b|next to\b|towards?\b|across\b)/i.test(text);
}

// Detect a spontaneous photo offer in an assistant reply.
function detectOffer(reply) {
    const text = normalize(reply);
    if (!text) return null;
    const m = /\b(?:want (?:me )?to (?:send|show)|should i (?:send|show)|i can (?:send|show|take)|i(?:'?d| would) (?:love to |gladly )?(?:send|show)|want (?:a|to see a) (?:pic|photo)|i(?:'?ll| will) (?:send|show) you (?:a )?(?:pic|photo)|shall i (?:send|show)|want to see (?:my|your|this|that|it|them|me|a pic|a photo|what|how)\b|want a (?:look|peek)|want to see\?)/i.exec(text);
    if (!m) return null;
    const context = text.slice(Math.max(0, m.index - 40), m.index + 180).toLowerCase();
    let intent = INTENT.SELFIE;
    if (/\boutfit\b/.test(context)) intent = INTENT.OUTFIT;
    else if (/\b(?:view|scenery|outside|where i am|place)\b/.test(context)) intent = INTENT.SCENERY;
    else if (/\b(?:eat|food|meal|coffee|drink|making|cooking)\b/.test(context)) intent = INTENT.SUBJECT;
    else if (/\b(?:friend|group|everyone)\b/.test(context)) intent = INTENT.GROUP;
    return { intent, subject: intent === INTENT.SUBJECT ? extractSubject(context, detectCategory(context) || 'food') : '' };
}

// --- Lighting ------------------------------------------------------------------

function lightingFor(environment, timeOfDay) {
    const tags = (environment && environment.tags) || [];
    const time = String(timeOfDay || '').toLowerCase();
    if (time === 'night') return 'low warm ambient light after dark, soft shadows';
    if (time === 'evening' || tags.includes('evening')) return 'warm low evening light';
    if (time === 'morning') return 'soft natural morning light';
    if (tags.includes('outdoor')) return tags.includes('warm') || tags.includes('hot')
        ? 'bright natural daylight with warm sun'
        : 'natural daylight, softly overcast';
    if (tags.includes('indoor')) return 'soft even indoor light that suits the room';
    return 'natural ambient light suited to the setting';
}

// --- Spec building -------------------------------------------------------------

// Build the structured photo specification from an intent + the life state.
function buildPhotoSpec(options) {
    const opts = options || {};
    const intent = opts.intent && opts.intent !== INTENT.NONE ? opts.intent : INTENT.SELFIE;
    const life = opts.life || {};
    const previous = opts.previous || null;
    const characters = Array.isArray(opts.characters) ? opts.characters : [];
    const name = characters[0] && characters[0].name ? characters[0].name : 'the character';
    const location = life.location || (previous && previous.location) || '';
    const activity = life.activity || '';
    // A garment the user explicitly named always wins for this generation; the
    // life-state outfit is only the fallback and is never overwritten on disk.
    const outfitOverride = String(opts.outfitOverride || '').trim();
    const outfit = outfitOverride || life.outfit || (previous && previous.outfit) || '';
    const userScene = String(opts.userScene || '').trim();
    // The action/pose the user explicitly asked for ("lying on the bed") is
    // authoritative: it replaces the life-state activity for this generation.
    // A phrase that is not action-shaped ("a big smile") is carried as an extra
    // detail instead of being forced into a "she is …" clause.
    const requestedAction = String(opts.requestedAction || userScene || '').trim();
    const actionIsAction = looksLikeAction(requestedAction);
    // Lighting/context follow the requested place when the user named one.
    const environment = outfitContext.classifyEnvironment(
        [location, activity, requestedAction].filter(Boolean).join(' '), ''
    ) || null;
    const timeOfDay = opts.timeOfDay || '';
    const lighting = lightingFor(environment, timeOfDay);

    let cameraView = CAMERA_VIEW.FRONT;
    let includeCharacter = true;
    let distance = "arm's length, chest-up / upper-torso framing";
    let angle = 'roughly eye level with a slight natural selfie tilt';
    let composition = 'the subject filling the frame with the surrounding environment visible behind her';
    let primarySubject = name;

    switch (intent) {
        case INTENT.OUTFIT:
            cameraView = CAMERA_VIEW.MIRROR;
            includeCharacter = true;
            primarySubject = name + "'s outfit";
            distance = 'full-body in the mirror, standing far enough back to show the whole look';
            angle = 'straight-on at the mirror, phone held at chest height';
            composition = 'her full outfit clearly readable in the mirror reflection, room visible around her';
            break;
        case INTENT.GROUP:
            cameraView = CAMERA_VIEW.FRONT;
            includeCharacter = true;
            primarySubject = opts.subject || ('a group with ' + name);
            distance = 'wide enough to include everyone, chest-up to waist-up';
            angle = 'held out at arm\'s length or propped up, roughly eye level';
            composition = name + ' clearly present with the other people, everyone comfortably in frame';
            break;
        case INTENT.SUBJECT:
            cameraView = CAMERA_VIEW.REAR;
            includeCharacter = false;
            primarySubject = opts.subject || 'the subject';
            distance = 'a close, held-out shot that fills the frame with the subject';
            angle = 'pointed directly at the subject, slightly from above as it is held';
            composition = primarySubject + ' is the clear focus; the background is softly out of focus; no one looking at the camera';
            break;
        case INTENT.SCENERY:
            cameraView = CAMERA_VIEW.REAR;
            includeCharacter = false;
            primarySubject = 'the view' + (location ? ' from ' + location : '');
            distance = 'a wide shot taking in the whole scene';
            angle = 'held up and level to capture the horizon and depth';
            composition = primarySubject + ' is the focus, framed like a casual smartphone landscape; no one looking at the camera';
            break;
        case INTENT.SCENE_REF:
            cameraView = CAMERA_VIEW.REAR;
            includeCharacter = false;
            primarySubject = opts.subject || 'the scene they talked about';
            distance = 'a natural held-out shot of the scene';
            angle = 'level, taking in the scene naturally';
            composition = primarySubject + ' is the focus, photographed casually';
            break;
        case INTENT.SELFIE:
        default:
            cameraView = CAMERA_VIEW.FRONT;
            includeCharacter = true;
            primarySubject = name;
            break;
    }

    const continuity = [];
    if (previous) {
        if (location && previous.location && location.toLowerCase() === previous.location.toLowerCase()) {
            continuity.push('same location as the previous photo (' + location + ')');
        }
        if (outfit && previous.outfit && outfit.toLowerCase() === previous.outfit.toLowerCase()) {
            continuity.push('same outfit as the previous photo');
        }
    }

    return {
        intent,
        cameraView,
        includeCharacter,
        primarySubject,
        activity,
        location,
        outfit,
        outfitSource: outfitOverride ? 'user' : (life.outfit ? 'life' : (outfit ? 'continuity' : 'none')),
        userScene,
        requestedAction,
        actionSource: actionIsAction ? 'user' : (activity ? 'life' : 'none'),
        detail: actionIsAction ? '' : requestedAction,
        context: life.context || '',
        mood: life.mood || '',
        distance,
        angle,
        composition,
        lighting,
        environment: environment ? { id: environment.id, label: environment.label, tags: environment.tags } : null,
        continuity,
        characterName: name,
        subject: opts.subject || '',
        activityPhrase: (actionIsAction ? requestedAction : '') || (activity && location ? activity + ' in ' + location : (activity || (location ? 'in ' + location : '')))
    };
}

function wearingClause(spec) {
    return spec.outfit ? ' She is wearing ' + spec.outfit + '.' : '';
}

function doingClause(spec) {
    const phrase = spec.activityPhrase || '';
    return phrase ? ' She is ' + phrase + '.' : '';
}

// The identity-mode instruction: appends a camera direction to the existing
// character identity instruction. Used for front / mirror / group photos.
function buildIdentityInstruction(spec) {
    const name = spec.characterName || 'the character';
    const base = 'PHOTOGRAPH (keep her exact facial identity, hair, natural skin tone and body proportions unchanged).';
    let body;
    if (spec.cameraView === CAMERA_VIEW.MIRROR) {
        body = ' This is a casual full-body mirror selfie of ' + name + ', standing in front of a mirror and holding her phone at chest height so the mirror shows her whole outfit.' + doingClause(spec) + wearingClause(spec)
            + ' Framing: ' + spec.distance + ', ' + spec.angle + '. The reflection is clean and plausible, the phone visible in one hand.';
    } else if (spec.intent === INTENT.GROUP) {
        body = ' This is a casual smartphone group photo with ' + name + ' and the people around her.' + doingClause(spec) + wearingClause(spec)
            + ' Framing: ' + spec.distance + ', ' + spec.angle + '.';
    } else {
        body = ' This is a casual handheld smartphone photo of ' + name + ', taken by herself on the front-facing camera as a selfie.' + doingClause(spec) + wearingClause(spec)
            + ' Framing: ' + spec.distance + ', ' + spec.angle + ', the phone held at selfie distance.';
    }
    return base + body
        + ' Composition: ' + spec.composition + '.'
        + ' Lighting: ' + spec.lighting + '.'
        + (spec.detail ? ' The user also asked for: ' + spec.detail + '.' : '')
        + ' Natural, unposed and candid, the way a phone photo looks. Avoid professional studio lighting, editorial styling, generated-looking perfection and cinematic colour grading. Do not change who she is.';
}

// The plain-generation prompt: a rear-camera subject/scenery photo with no
// character face. Used with the normal text-to-image pipeline.
function buildPlainPrompt(spec) {
    const parts = [];
    if (spec.intent === INTENT.SCENERY) {
        parts.push('A casual smartphone landscape photo of ' + (spec.primarySubject || 'the view'));
    } else {
        parts.push('A casual smartphone photo of ' + (spec.primarySubject || 'the subject'));
    }
    if (spec.location && spec.intent !== INTENT.SCENERY) parts.push('at ' + spec.location);
    if (spec.userScene) parts.push('the user specifically asked for: ' + spec.userScene);
    parts.push(spec.composition);
    parts.push('Lighting: ' + spec.lighting);
    parts.push('Taken on a phone, natural and unposed, no professional studio lighting and no cinematic colour grading');
    if (spec.intent !== INTENT.SCENERY) parts.push('no one looking at the camera');
    return parts.join('. ').replace(/\.\./g, '.') + '.';
}

// Unified builder: returns the mode ('identity' or 'plain') plus the text the
// caller needs. `identity` mode appends to the character identity instruction;
// `plain` mode is a standalone generation prompt (no character face).
function buildPhotoInstruction(spec) {
    if (!spec) return null;
    if (spec.includeCharacter) {
        return { mode: 'identity', instruction: buildIdentityInstruction(spec), prompt: '' };
    }
    return { mode: 'plain', instruction: '', prompt: buildPlainPrompt(spec) };
}

function cameraLabel(spec) {
    if (!spec) return '';
    if (spec.cameraView === CAMERA_VIEW.MIRROR) return 'mirror selfie';
    if (spec.cameraView === CAMERA_VIEW.REAR) return spec.intent === INTENT.SCENERY ? 'back camera — scenery' : 'back camera';
    return 'front camera selfie';
}

function specSummary(spec) {
    if (!spec) return '';
    return cameraLabel(spec) + (spec.location ? ' — ' + spec.location : '') + (spec.activity ? ' — ' + spec.activity : '');
}

module.exports = {
    INTENT,
    CAMERA_VIEW,
    detectPhotoIntent,
    detectOffer,
    detectCategory,
    extractSubject,
    extractClothing,
    extractUserScene,
    parseUserRequest,
    isAcceptance,
    isRejection,
    buildPhotoSpec,
    buildPhotoInstruction,
    buildIdentityInstruction,
    buildPlainPrompt,
    lightingFor,
    cameraLabel,
    specSummary
};
