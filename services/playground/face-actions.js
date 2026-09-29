/* ============================================
   JARVIS — Creative Playground Face Actions
   A dedicated, first-class facial-expression layer.
   A Face Action is a coherent expression preset
   (expression + mouth + eyes + head) or an explicit
   composition of those four components. It describes
   WHAT the character's face is doing — never WHO they
   are — so it composes on top of identity, outfit and
   scene without ever overriding them.

   The catalog is data-only + pure helpers (no LLM, no
   GPU, no dependencies) so the Creative Playground and
   any future consumer share the SAME definitions. This
   module is deliberately separate from the general
   Activity/pose system.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

// --- Component vocabularies ---------------------------------------------------
//
// The four independent dimensions a Face Action is composed from. Each entry is
// creative intent (a phrase the prompt builder renders), never final prompt
// text itself.

const EXPRESSION_OPTIONS = [
    { id: 'natural', label: 'Natural', phrase: 'a natural, relaxed expression' },
    { id: 'relaxed', label: 'Relaxed', phrase: 'a relaxed, at-ease expression' },
    { id: 'soft_smile', label: 'Soft Smile', phrase: 'a soft, warm smile' },
    { id: 'big_smile', label: 'Big Smile', phrase: 'a bright, wide smile' },
    { id: 'closed_smile', label: 'Closed-Mouth Smile', phrase: 'a warm closed-mouth smile' },
    { id: 'playful', label: 'Playful', phrase: 'a playful, cheeky expression' },
    { id: 'flirty', label: 'Flirty', phrase: 'a flirty, playful expression' },
    { id: 'confident', label: 'Confident', phrase: 'a confident, self-assured expression' },
    { id: 'coy', label: 'Coy', phrase: 'a coy, bashful expression' },
    { id: 'shy', label: 'Shy', phrase: 'a shy, reserved expression' },
    { id: 'amused', label: 'Amused', phrase: 'an amused, lightly entertained expression' },
    { id: 'surprised', label: 'Surprised', phrase: 'a surprised, wide-eyed expression' },
    { id: 'curious', label: 'Curious', phrase: 'a curious, inquisitive expression' },
    { id: 'serious', label: 'Serious', phrase: 'a serious, composed expression' },
    { id: 'thoughtful', label: 'Thoughtful', phrase: 'a thoughtful, reflective expression' },
    { id: 'laughing', label: 'Laughing', phrase: 'a laughing, delighted expression' }
];

const MOUTH_OPTIONS = [
    { id: 'relaxed_lips', label: 'Relaxed Lips', phrase: 'relaxed lips' },
    { id: 'closed_lips', label: 'Closed Lips', phrase: 'softly closed lips' },
    { id: 'closed_smile', label: 'Closed-Mouth Smile', phrase: 'a closed-mouth smile' },
    { id: 'open_smile', label: 'Open-Mouth Smile', phrase: 'an open-mouth smile' },
    { id: 'parted_lips', label: 'Slightly Parted Lips', phrase: 'slightly parted lips' },
    { id: 'pout', label: 'Subtle Pout', phrase: 'a subtle pout' },
    { id: 'pursed', label: 'Pursed Lips', phrase: 'softly pursed lips' },
    { id: 'smirk', label: 'Slight Smirk', phrase: 'a slight smirk with one corner of the mouth raised' },
    { id: 'tongue_out', label: 'Tongue Out', phrase: 'the tongue playfully sticking slightly out' }
];

const EYE_OPTIONS = [
    { id: 'direct_contact', label: 'Direct Eye Contact', phrase: 'direct, confident eye contact with the camera' },
    { id: 'soft_gaze', label: 'Soft Gaze', phrase: 'a soft, relaxed gaze' },
    { id: 'playful_gaze', label: 'Playful Gaze', phrase: 'a bright, playful gaze' },
    { id: 'looking_away', label: 'Looking Slightly Away', phrase: 'a gaze directed slightly away from the camera' },
    { id: 'side_glance', label: 'Side Glance', phrase: 'a sideways glance' },
    { id: 'looking_down', label: 'Looking Down', phrase: 'eyes cast gently downward' },
    { id: 'looking_up', label: 'Looking Upward', phrase: 'eyes lifted slightly upward' },
    { id: 'narrowed', label: 'Slightly Narrowed Eyes', phrase: 'slightly narrowed eyes' },
    { id: 'wide', label: 'Wide-Eyed', phrase: 'wide, bright eyes' },
    { id: 'wink', label: 'Wink', phrase: 'one eye closed in a playful wink while the other stays open' }
];

const HEAD_OPTIONS = [
    { id: 'neutral', label: 'Neutral', phrase: 'a level, neutral head position' },
    { id: 'slight_tilt', label: 'Slight Tilt', phrase: 'a slight natural head tilt' },
    { id: 'chin_down', label: 'Chin Slightly Down', phrase: 'the chin slightly lowered' },
    { id: 'chin_up', label: 'Chin Slightly Raised', phrase: 'the chin slightly raised' },
    { id: 'three_quarter', label: 'Three-Quarter Angle', phrase: 'the head turned to a three-quarter angle' },
    { id: 'over_shoulder', label: 'Looking Over Shoulder', phrase: 'the head turned to look back over the shoulder' }
];

// --- Coherent presets ---------------------------------------------------------
//
// The generator favours these coherent combinations over independently
// randomizing every component. `contexts` drive the context-sensitive weighting
// (lifestyle / glamour / playful / seductive / cinematic / …). `prompt` is the
// concise, visually actionable clause rendered into the final prompt.

const FACE_ACTIONS = [
    {
        id: 'natural', label: 'Natural', description: 'A natural, relaxed expression.',
        expression: 'natural', mouth: 'relaxed_lips', eyes: 'soft_gaze', head: 'neutral',
        weight: 4,
        contexts: ['natural', 'lifestyle', 'casual', 'editorial', 'cinematic', 'travel'],
        prompt: 'a natural, relaxed facial expression with a calm, steady gaze'
    },
    {
        id: 'relaxed', label: 'Relaxed', description: 'An easy, at-ease expression.',
        expression: 'relaxed', mouth: 'relaxed_lips', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 3,
        contexts: ['natural', 'lifestyle', 'casual', 'travel'],
        prompt: 'a relaxed, at-ease expression with a soft gaze and a slight head tilt'
    },
    {
        id: 'soft_smile', label: 'Soft Smile', description: 'A warm, gentle smile.',
        expression: 'soft_smile', mouth: 'closed_smile', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 5,
        contexts: ['lifestyle', 'glamour', 'natural', 'casual', 'editorial', 'seductive'],
        prompt: 'a soft, warm smile with a gentle direct gaze and a slight natural head tilt'
    },
    {
        id: 'big_smile', label: 'Big Smile', description: 'A bright, wide smile.',
        expression: 'big_smile', mouth: 'open_smile', eyes: 'playful_gaze', head: 'slight_tilt',
        weight: 2,
        contexts: ['playful', 'lifestyle', 'travel', 'seasonal'],
        prompt: 'a bright, wide open-mouth smile with lively eyes and a slight head tilt'
    },
    {
        id: 'closed_smile', label: 'Closed-Mouth Smile', description: 'A warm smile with closed lips.',
        expression: 'closed_smile', mouth: 'closed_smile', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 3,
        contexts: ['lifestyle', 'natural', 'glamour', 'casual'],
        prompt: 'a warm closed-mouth smile with soft eyes and a slight head tilt'
    },
    {
        id: 'smirk', label: 'Smirk', description: 'A confident, subtle smirk.',
        expression: 'confident', mouth: 'smirk', eyes: 'narrowed', head: 'chin_down',
        weight: 3,
        contexts: ['glamour', 'confident', 'seductive', 'editorial'],
        prompt: 'a subtle, confident smirk with one corner of the mouth slightly raised, direct slightly narrowed eyes and a slightly lowered chin'
    },
    {
        id: 'playful', label: 'Playful', description: 'A playful, cheeky expression.',
        expression: 'playful', mouth: 'open_smile', eyes: 'playful_gaze', head: 'slight_tilt',
        weight: 3,
        contexts: ['playful', 'lifestyle', 'casual'],
        prompt: 'a playful, cheeky expression with a slight open-mouth smile, bright eyes and a small head tilt'
    },
    {
        id: 'flirty', label: 'Flirty', description: 'A flirty, playful expression.',
        expression: 'flirty', mouth: 'smirk', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 2,
        contexts: ['playful', 'seductive', 'glamour'],
        prompt: 'a flirty, playful expression with a faint smile, a soft inviting gaze and a slight head tilt'
    },
    {
        id: 'confident', label: 'Confident', description: 'A confident, self-assured expression.',
        expression: 'confident', mouth: 'relaxed_lips', eyes: 'direct_contact', head: 'neutral',
        weight: 3,
        contexts: ['glamour', 'confident', 'seductive', 'editorial', 'cinematic'],
        prompt: 'a confident, self-assured expression with direct eye contact and a level gaze'
    },
    {
        id: 'coy', label: 'Coy', description: 'A coy, bashful expression.',
        expression: 'coy', mouth: 'closed_smile', eyes: 'looking_away', head: 'slight_tilt',
        weight: 2,
        contexts: ['seductive', 'lifestyle', 'playful'],
        prompt: 'a coy, bashful expression with a small closed-mouth smile, a gaze looking gently away and a slight head tilt'
    },
    {
        id: 'shy', label: 'Shy', description: 'A shy, reserved expression.',
        expression: 'shy', mouth: 'closed_smile', eyes: 'looking_down', head: 'chin_down',
        weight: 1.5,
        contexts: ['lifestyle', 'seductive', 'natural'],
        prompt: 'a shy, reserved expression with a small closed-mouth smile, eyes cast gently downward and the chin slightly lowered'
    },
    {
        id: 'amused', label: 'Amused', description: 'A lightly entertained expression.',
        expression: 'amused', mouth: 'closed_smile', eyes: 'playful_gaze', head: 'slight_tilt',
        weight: 2,
        contexts: ['playful', 'lifestyle', 'cinematic'],
        prompt: 'an amused, lightly entertained expression with a subtle smile and bright, knowing eyes'
    },
    {
        id: 'surprised', label: 'Surprised', description: 'A surprised, wide-eyed expression.',
        expression: 'surprised', mouth: 'parted_lips', eyes: 'wide', head: 'slight_tilt',
        weight: 1.5,
        contexts: ['playful', 'lifestyle', 'fantasy'],
        prompt: 'a surprised expression with wide eyes, slightly parted lips and a small head tilt'
    },
    {
        id: 'curious', label: 'Curious', description: 'A curious, inquisitive expression.',
        expression: 'curious', mouth: 'relaxed_lips', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 2.5,
        contexts: ['lifestyle', 'travel', 'natural', 'fantasy'],
        prompt: 'a curious, inquisitive expression with a soft, attentive gaze and a slight head tilt'
    },
    {
        id: 'serious', label: 'Serious', description: 'A serious, composed expression.',
        expression: 'serious', mouth: 'closed_lips', eyes: 'narrowed', head: 'neutral',
        weight: 2.5,
        contexts: ['glamour', 'cinematic', 'editorial', 'confident'],
        prompt: 'a serious, composed expression with softly closed lips, a steady direct gaze and a level head'
    },
    {
        id: 'thoughtful', label: 'Thoughtful', description: 'A thoughtful, reflective expression.',
        expression: 'thoughtful', mouth: 'relaxed_lips', eyes: 'looking_away', head: 'chin_down',
        weight: 2,
        contexts: ['cinematic', 'natural', 'editorial'],
        prompt: 'a thoughtful, reflective expression with a soft gaze looking slightly away and the chin gently lowered'
    },
    {
        id: 'laughing', label: 'Laughing', description: 'A laughing, delighted expression.',
        expression: 'laughing', mouth: 'open_smile', eyes: 'playful_gaze', head: 'slight_tilt',
        weight: 2,
        contexts: ['lifestyle', 'playful', 'travel', 'seasonal'],
        prompt: 'a laughing, delighted expression with an open-mouth laugh, bright crinkled eyes and the head tilted back a little'
    },
    {
        id: 'pout', label: 'Subtle Pout', description: 'A subtle, soft pout.',
        expression: 'playful', mouth: 'pout', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 1.2,
        contexts: ['seductive', 'glamour', 'playful'],
        prompt: 'a subtle pout with soft eyes and a slight head tilt'
    },
    {
        id: 'parted_lips', label: 'Slightly Parted Lips', description: 'Soft, slightly parted lips.',
        expression: 'confident', mouth: 'parted_lips', eyes: 'soft_gaze', head: 'neutral',
        weight: 1.5,
        contexts: ['seductive', 'glamour', 'editorial'],
        prompt: 'slightly parted lips with a soft, steady gaze and a calm, relaxed expression'
    },
    {
        id: 'tongue_out', label: 'Tongue Out', description: 'A playful tongue-out expression.',
        expression: 'playful', mouth: 'tongue_out', eyes: 'playful_gaze', head: 'slight_tilt',
        weight: 1.5,
        contexts: ['playful'],
        prompt: 'a playful, cheeky expression with the tongue sticking slightly out, bright playful eyes and a slight head tilt'
    },
    {
        id: 'wink', label: 'Wink', description: 'A playful wink.',
        expression: 'playful', mouth: 'closed_smile', eyes: 'wink', head: 'slight_tilt',
        weight: 1.5,
        contexts: ['playful', 'seductive'],
        prompt: 'a playful wink with one eye closed, a small smile and a slight head tilt'
    },
    {
        id: 'side_glance', label: 'Side Glance', description: 'A cool sideways glance.',
        expression: 'confident', mouth: 'relaxed_lips', eyes: 'side_glance', head: 'three_quarter',
        weight: 1.5,
        contexts: ['glamour', 'cinematic', 'seductive', 'editorial'],
        prompt: 'a cool side glance with the head turned to a three-quarter angle and a composed expression'
    },
    {
        id: 'looking_away', label: 'Looking Away', description: 'A pensive, averted gaze.',
        expression: 'thoughtful', mouth: 'relaxed_lips', eyes: 'looking_away', head: 'three_quarter',
        weight: 1.5,
        contexts: ['cinematic', 'natural', 'editorial'],
        prompt: 'a pensive expression with the gaze directed slightly away and the head at a three-quarter angle'
    },
    {
        id: 'soft_gaze', label: 'Soft Gaze', description: 'A gentle, soft gaze.',
        expression: 'natural', mouth: 'relaxed_lips', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 2.5,
        contexts: ['lifestyle', 'glamour', 'seductive', 'natural'],
        prompt: 'a soft, gentle gaze with a calm expression and a slight head tilt'
    },
    {
        id: 'direct_contact', label: 'Direct Eye Contact', description: 'Direct, confident eye contact.',
        expression: 'confident', mouth: 'relaxed_lips', eyes: 'direct_contact', head: 'neutral',
        weight: 3.5,
        contexts: ['glamour', 'confident', 'editorial', 'cinematic', 'seductive'],
        prompt: 'direct, confident eye contact with the camera and a composed, level expression'
    },
    {
        id: 'narrowed', label: 'Slightly Narrowed Eyes', description: 'An assessing, narrowed gaze.',
        expression: 'confident', mouth: 'closed_lips', eyes: 'narrowed', head: 'neutral',
        weight: 1.5,
        contexts: ['glamour', 'cinematic'],
        prompt: 'slightly narrowed, assessing eyes with a composed expression and a level head'
    },
    {
        id: 'wide_eyed', label: 'Wide-Eyed', description: 'A wide-eyed, alert expression.',
        expression: 'surprised', mouth: 'parted_lips', eyes: 'wide', head: 'slight_tilt',
        weight: 1.2,
        contexts: ['playful', 'fantasy'],
        prompt: 'a wide-eyed, alert expression with slightly parted lips and a small head tilt'
    },
    {
        id: 'head_tilt', label: 'Slight Head Tilt', description: 'A natural, inquisitive head tilt.',
        expression: 'natural', mouth: 'relaxed_lips', eyes: 'soft_gaze', head: 'slight_tilt',
        weight: 2,
        contexts: ['lifestyle', 'natural', 'playful'],
        prompt: 'a natural expression with a soft gaze and a slight, inquisitive head tilt'
    },
    {
        id: 'chin_down', label: 'Chin Slightly Down', description: 'A coy, lowered-chin look.',
        expression: 'shy', mouth: 'closed_smile', eyes: 'looking_up', head: 'chin_down',
        weight: 1.2,
        contexts: ['seductive', 'coy', 'lifestyle'],
        prompt: 'a coy expression with the chin slightly lowered and eyes lifted gently upward'
    },
    {
        id: 'chin_up', label: 'Chin Slightly Raised', description: 'A confident, raised-chin look.',
        expression: 'confident', mouth: 'closed_smile', eyes: 'direct_contact', head: 'chin_up',
        weight: 1.5,
        contexts: ['glamour', 'confident', 'editorial'],
        prompt: 'a confident expression with the chin slightly raised and direct eye contact'
    },
    {
        id: 'over_shoulder', label: 'Looking Over Shoulder', description: 'A soft look back over the shoulder.',
        expression: 'soft_smile', mouth: 'closed_smile', eyes: 'soft_gaze', head: 'over_shoulder',
        weight: 2,
        contexts: ['glamour', 'seductive', 'editorial', 'cinematic'],
        prompt: 'a soft smile while looking back over the shoulder, with a gentle gaze'
    }
];

const ACTION_BY_ID = {};
for (const action of FACE_ACTIONS) ACTION_BY_ID[action.id] = action;

// --- Context-sensitive weighting ---------------------------------------------
//
// Content style (theme) and wardrobe personality (Outfit Pack) select which
// expression families read as natural for the character. This only biases the
// automatic pick; an explicit user choice always wins.

const THEME_CONTEXT = {
    'lifestyle-candid': ['lifestyle', 'casual', 'natural', 'playful'],
    'fashion-editorial': ['glamour', 'editorial', 'confident'],
    'cinematic-storytelling': ['cinematic'],
    'fantasy-character-worlds': ['fantasy'],
    'travel-adventure': ['travel', 'natural'],
    'seasonal-concepts': ['seasonal', 'lifestyle'],
    'experimental-photography': ['experimental', 'editorial']
};

const PACK_CONTEXT = {
    'glam-boudoir': ['glamour', 'seductive'],
    'confident-seductive': ['glamour', 'seductive', 'confident'],
    'casual-night-out': ['glamour', 'seductive', 'playful'],
    'edgy-alternative': ['cinematic', 'confident'],
    'casual-streetwear': ['playful', 'casual'],
    'soft-feminine-casual': ['lifestyle', 'natural'],
    'lounge-home': ['lifestyle', 'natural'],
    'minimalist-neutral': ['editorial', 'glamour'],
    'vacation-summer': ['travel', 'lifestyle'],
    'gym-activewear': ['lifestyle', 'natural'],
    'casual-smart': ['editorial', 'confident'],
    'casual-everyday': ['casual', 'natural', 'lifestyle']
};

const MATCH_THRESHOLD = 0.5;

function themeIdOf(theme) {
    if (!theme) return '';
    return typeof theme === 'string' ? theme : String(theme.id || '');
}

function contextTags(context = {}) {
    const tags = new Set();
    const themeId = themeIdOf(context.themeId || context.theme);
    for (const tag of (THEME_CONTEXT[themeId] || [])) tags.add(tag);
    const pack = String(context.outfitPack || '');
    for (const tag of (PACK_CONTEXT[pack] || [])) tags.add(tag);
    return tags;
}

function optionById(list, id) {
    const key = String(id || '').trim().toLowerCase();
    if (!key) return null;
    return list.find((entry) => entry.id === key) || null;
}

function normalizeComponentId(list, value) {
    if (!value) return '';
    const key = String(value).trim();
    const byId = optionById(list, key);
    if (byId) return byId.id;
    const lower = key.toLowerCase();
    const byLabel = list.find((entry) => String(entry.label).toLowerCase() === lower);
    return byLabel ? byLabel.id : '';
}

function optionPhrase(list, id) {
    const entry = optionById(list, id);
    return entry ? entry.phrase : '';
}

function optionLabel(list, id) {
    const entry = optionById(list, id);
    return entry ? entry.label : '';
}

function componentLabels(components) {
    return {
        expressionLabel: optionLabel(EXPRESSION_OPTIONS, components.expression),
        mouthLabel: optionLabel(MOUTH_OPTIONS, components.mouth),
        eyesLabel: optionLabel(EYE_OPTIONS, components.eyes),
        headLabel: optionLabel(HEAD_OPTIONS, components.head)
    };
}

// --- Composition --------------------------------------------------------------

// Render a concise, visually actionable clause from a component set. The mouth
// clause is dropped when the expression phrase already names it, so a custom
// composition never says "a warm smile with a closed-mouth smile".
function describeComponents(components) {
    const comp = components || {};
    const expressions = optionPhrase(EXPRESSION_OPTIONS, comp.expression);
    const mouth = optionPhrase(MOUTH_OPTIONS, comp.mouth);
    const eyes = optionPhrase(EYE_OPTIONS, comp.eyes);
    const head = optionPhrase(HEAD_OPTIONS, comp.head);
    let clause = expressions || 'a natural, relaxed expression';
    const redundantMouth = (comp.mouth === 'closed_smile'
        && ['soft_smile', 'closed_smile'].includes(comp.expression))
        || (comp.mouth === 'open_smile' && ['big_smile', 'laughing'].includes(comp.expression));
    if (mouth && !redundantMouth) clause += ' with ' + mouth;
    if (eyes) clause += '; ' + eyes;
    if (head && comp.head !== 'neutral') clause += ' and ' + head;
    return clause;
}

function actionFromPreset(preset, source, mode) {
    if (!preset) return null;
    return {
        id: preset.id,
        label: preset.label,
        description: preset.description || '',
        expression: preset.expression,
        mouth: preset.mouth,
        eyes: preset.eyes,
        head: preset.head,
        ...componentLabels(preset),
        prompt: preset.prompt || describeComponents(preset),
        source: source || 'preset',
        mode: mode || 'explicit',
        signature: preset.id
    };
}

function buildCustomAction(components, source, mode) {
    const comp = {
        expression: normalizeComponentId(EXPRESSION_OPTIONS, components.expression) || 'natural',
        mouth: normalizeComponentId(MOUTH_OPTIONS, components.mouth) || 'relaxed_lips',
        eyes: normalizeComponentId(EYE_OPTIONS, components.eyes) || 'soft_gaze',
        head: normalizeComponentId(HEAD_OPTIONS, components.head) || 'neutral'
    };
    return {
        id: '',
        label: 'Custom expression',
        description: '',
        expression: comp.expression,
        mouth: comp.mouth,
        eyes: comp.eyes,
        head: comp.head,
        ...componentLabels(comp),
        prompt: describeComponents(comp),
        source: source || 'explicit',
        mode: mode || 'explicit',
        signature: 'custom:' + [comp.expression, comp.mouth, comp.eyes, comp.head].join(':')
    };
}

function findExactPreset(components) {
    const comp = components || {};
    return FACE_ACTIONS.find((action) =>
        action.expression === comp.expression && action.mouth === comp.mouth &&
        action.eyes === comp.eyes && action.head === comp.head) || null;
}

// Build a structured Face Action from a preset id, a component map, or a
// free-text description. Returns null when the value cannot be resolved.
function composeFaceAction(input) {
    if (!input) return null;
    if (typeof input === 'string') return resolveFaceActionValue(input);
    if (input.id && ACTION_BY_ID[input.id]) {
        return actionFromPreset(ACTION_BY_ID[input.id], input.source || 'explicit', input.mode || 'explicit');
    }
    const comp = {
        expression: normalizeComponentId(EXPRESSION_OPTIONS, input.expression),
        mouth: normalizeComponentId(MOUTH_OPTIONS, input.mouth),
        eyes: normalizeComponentId(EYE_OPTIONS, input.eyes),
        head: normalizeComponentId(HEAD_OPTIONS, input.head)
    };
    const preset = findExactPreset(comp);
    if (preset) return actionFromPreset(preset, input.source || 'explicit', input.mode || 'explicit');
    return buildCustomAction(comp, input.source || 'explicit', input.mode || 'explicit');
}

// --- Selection ----------------------------------------------------------------

function normalizeFaceActionId(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return '';
    if (ACTION_BY_ID[key]) return key;
    const found = FACE_ACTIONS.find((action) => String(action.label).toLowerCase() === key);
    return found ? found.id : '';
}

function getFaceAction(id) {
    const key = normalizeFaceActionId(id);
    return key ? ACTION_BY_ID[key] : null;
}

function scoreFaceAction(action, context = {}) {
    if (!action) return 0;
    const tags = contextTags(context);
    let score = Number(action.weight) || 1;
    const contexts = Array.isArray(action.contexts) ? action.contexts : [];
    for (const tag of contexts) if (tags.has(tag)) score += 3;
    return score;
}

function rankFaceActions(context = {}) {
    return FACE_ACTIONS
        .map((action) => ({ action, score: scoreFaceAction(action, context) }))
        .sort((a, b) => b.score - a.score);
}

function weightedPresetPick(entries, rng) {
    const pool = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.action);
    if (!pool.length) return null;
    const weights = pool.map((entry) => Math.max(Number(entry.score) || 0, 0.25));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const raw = typeof rng === 'function' ? Number(rng()) : Math.random();
    const base = Number.isFinite(raw) ? ((raw % 1) + 1) % 1 : 0;
    let target = base * total;
    for (let i = 0; i < pool.length; i++) {
        target -= weights[i];
        if (target < 0) return pool[i].action;
    }
    return pool[pool.length - 1].action;
}

// Select one Face Action for a context. `mode` is 'auto' (fit the content style
// and wardrobe) or 'random' (any expression, ignoring context). Deterministic
// for a given rng so a seeded Surprise stays reproducible. Avoided ids are
// filtered first so a re-roll does not immediately repeat the same expression.
function selectFaceAction(context = {}) {
    const rng = typeof context.rng === 'function' ? context.rng : Math.random;
    const avoid = new Set(Array.isArray(context.avoidFaceActionIds) ? context.avoidFaceActionIds : []);
    if (String(context.mode || 'auto') === 'random') {
        const filtered = FACE_ACTIONS.filter((action) => !avoid.has(action.id));
        const pool = (filtered.length ? filtered : FACE_ACTIONS)
            .map((action) => ({ action, score: Number(action.weight) || 1 }));
        return actionFromPreset(weightedPresetPick(pool, rng), 'auto', 'random');
    }
    let scored = rankFaceActions(context);
    const filtered = scored.filter((entry) => !avoid.has(entry.action.id));
    if (filtered.length) scored = filtered;
    const action = weightedPresetPick(scored, rng);
    return action ? actionFromPreset(action, 'auto', 'auto') : null;
}

function resolveFaceActionSelection(value) {
    const raw = String(value || '').trim();
    const key = raw.toLowerCase();
    if (!key || key === 'none' || key === 'off') return { mode: 'none', id: '' };
    if (key === 'auto') return { mode: 'auto', id: '' };
    if (key === 'random') return { mode: 'random', id: '' };
    const id = normalizeFaceActionId(raw);
    if (id) return { mode: 'explicit', id };
    return { mode: 'none', id: '' };
}

// Resolve a raw selection value from the UI or a caller: 'auto'/'random'/a
// preset id/a label/a free-text expression. Deterministic for a given rng.
function resolveFaceActionValue(value, context = {}) {
    if (!value) return null;
    if (typeof value === 'object') return composeFaceAction(value);
    const selection = resolveFaceActionSelection(value);
    if (selection.mode === 'explicit') {
        return actionFromPreset(getFaceAction(selection.id), 'explicit', 'explicit');
    }
    if (selection.mode === 'auto') return selectFaceAction(Object.assign({}, context, { mode: 'auto' }));
    if (selection.mode === 'random') return selectFaceAction(Object.assign({}, context, { mode: 'random' }));
    const matched = matchFaceActionFromText(value);
    return matched.confident ? matched.action : null;
}

// --- Natural-language matching ------------------------------------------------
//
// Ordered so the stronger signal wins ("big smile" before "smile"; "tongue out"
// before a generic smile). Returns a confident, internally coherent Face Action
// or an unspecified match. No LLM.

const EXPRESSION_HINTS = [
    { id: 'laughing', re: /\b(?:laughing|laughs?|laugh|giggling|in stitches|bursting out laughing)\b/i, confidence: 0.9 },
    { id: 'big_smile', re: /\b(?:open[- ]mouth smile|big smile|broad smile|beaming|grinning|grin|ear[- ]to[- ]ear smile)\b/i, confidence: 0.9 },
    { id: 'soft_smile', re: /\b(?:soft smile|gentle smile|slight smile|subtle smile|small smile|smil(?:e|ing|es))\b/i, confidence: 0.8 },
    { id: 'closed_smile', re: /\b(?:closed[- ]mouth smile|closed[- ]lip smile|smile with (?:her|his|their|my)?\s*lips closed)\b/i, confidence: 0.9 },
    { id: 'smirk', re: /\b(?:smirk(?:ing|s)?|smug)\b/i, confidence: 0.9 },
    { id: 'playful', re: /\b(?:playful|cheeky|mischievous|silly|goofy)\b/i, confidence: 0.85 },
    { id: 'flirty', re: /\b(?:flirty|flirtatious|coquettish)\b/i, confidence: 0.85 },
    { id: 'confident', re: /\b(?:confident|self[- ]assured|assured|in control)\b/i, confidence: 0.8 },
    { id: 'coy', re: /\b(?:coy|bashful)\b/i, confidence: 0.85 },
    { id: 'shy', re: /\b(?:shy|timid|sheepish|embarrassed)\b/i, confidence: 0.85 },
    { id: 'amused', re: /\b(?:amused|entertained)\b/i, confidence: 0.8 },
    { id: 'surprised', re: /\b(?:surprised|shocked|astonished|startled|taken aback)\b/i, confidence: 0.85 },
    { id: 'curious', re: /\b(?:curious|inquisitive|intrigued|quizzical|puzzled)\b/i, confidence: 0.8 },
    { id: 'serious', re: /\b(?:serious|deadpan|stern|stoic|composed|unsmiling)\b/i, confidence: 0.8 },
    { id: 'thoughtful', re: /\b(?:thoughtful|pensive|reflective|contemplative|deep in thought|lost in thought)\b/i, confidence: 0.85 },
    { id: 'natural', re: /\b(?:natural|relaxed|neutral)\s+(?:facial\s+)?expression\b/i, confidence: 0.7 }
];

const MOUTH_HINTS = [
    { id: 'tongue_out', re: /\b(?:tongue[- ]out|tongue\s+out|sticking (?:her|his|their|my)?\s*tongue out|tongue sticking out|tongue playfully)\b/i, confidence: 0.95 },
    { id: 'smirk', re: /\b(?:smirk(?:ing|s)?)\b/i, confidence: 0.9 },
    { id: 'open_smile', re: /\b(?:open[- ]mouth smile|open smile|mouth open(?: in a smile)?|teeth[- ]showing|showing (?:her|his|their)?\s*teeth)\b/i, confidence: 0.85 },
    { id: 'pout', re: /\b(?:pout(?:ing|s)?)\b/i, confidence: 0.85 },
    { id: 'pursed', re: /\b(?:pursed lips|pursing (?:her|his|their)?\s*lips)\b/i, confidence: 0.85 },
    { id: 'parted_lips', re: /\b(?:parted lips|lips\s+(?:slightly\s+)?parted|slightly parted)\b/i, confidence: 0.8 },
    { id: 'closed_smile', re: /\b(?:closed[- ]mouth smile|closed[- ]lip smile|lips closed|mouth closed|closed lips)\b/i, confidence: 0.85 },
    { id: 'relaxed_lips', re: /\b(?:relaxed lips|relaxed mouth)\b/i, confidence: 0.6 }
];

const EYE_HINTS = [
    { id: 'wink', re: /\b(?:wink(?:ing|s)?)\b/i, confidence: 0.95 },
    { id: 'wide', re: /\b(?:wide[- ]eyed|eyes wide|wide eyes)\b/i, confidence: 0.85 },
    { id: 'narrowed', re: /\b(?:narrowed eyes|eyes\s+(?:slightly\s+)?narrowed|squinting)\b/i, confidence: 0.8 },
    { id: 'side_glance', re: /\b(?:side(?:ways)? glance|glancing (?:to the|to her|to his|to their)?\s*side)\b/i, confidence: 0.9 },
    { id: 'looking_away', re: /\b(?:looking away|gazing away|averted gaze|looking off|glancing away|looking\s+(?:slightly\s+)?away)\b/i, confidence: 0.85 },
    { id: 'looking_down', re: /\b(?:looking down|gaze\s+(?:cast\s+)?down|eyes down)\b/i, confidence: 0.85 },
    { id: 'looking_up', re: /\b(?:looking up|eyes\s+(?:lifted\s+)?up|gazing up)\b/i, confidence: 0.8 },
    { id: 'direct_contact', re: /\b(?:direct\s+(?:eye\s+)?contact|looking\s+(?:directly\s+)?(?:at|into)\s+the camera|looking at the viewer|eye contact|into the lens)\b/i, confidence: 0.9 },
    { id: 'soft_gaze', re: /\b(?:soft gaze|gentle gaze|soft eyes)\b/i, confidence: 0.8 },
    { id: 'playful_gaze', re: /\b(?:playful gaze|bright eyes|sparkling eyes|twinkl(?:e|ing) eyes)\b/i, confidence: 0.75 }
];

const HEAD_HINTS = [
    { id: 'over_shoulder', re: /\b(?:over (?:her|his|their|the) shoulder|looking back over (?:her|his|their) shoulder|glancing over (?:her|his|their) shoulder)\b/i, confidence: 0.95 },
    { id: 'three_quarter', re: /\b(?:three[- ]quarter|turned (?:to the )?side|in profile)\b/i, confidence: 0.8 },
    { id: 'chin_down', re: /\b(?:chin\s+(?:slightly\s+)?down|chin lowered|lowered chin|head\s+(?:slightly\s+)?(?:down|bowed))\b/i, confidence: 0.8 },
    { id: 'chin_up', re: /\b(?:chin\s+(?:slightly\s+)?up|chin raised|chin lift|head\s+(?:tilted\s+)?up)\b/i, confidence: 0.8 },
    { id: 'slight_tilt', re: /\b(?:head tilt|tilt(?:ed|ing)?\s+(?:her|his|their)?\s*head|slight tilt)\b/i, confidence: 0.8 },
    { id: 'neutral', re: /\b(?:neutral head|level head|facing\s+(?:the camera\s+)?(?:straight|forward))\b/i, confidence: 0.6 }
];

function bestHint(hints, text) {
    let best = null;
    for (const hint of hints) {
        if (!hint.re.test(text)) continue;
        if (!best || hint.confidence > best.confidence) best = hint;
    }
    return best;
}

// Resolve conflicting facial instructions before composing. "smiling with her
// tongue out" is one playful tongue-out action — never "closed smile + tongue
// out". A smirk never silently adds a big smile, laughing or an open mouth.
function normalizeConflict(explicit) {
    if (explicit.mouth === 'tongue_out') {
        explicit.expression = 'playful';
        if (!explicit.eyes) explicit.eyes = 'playful_gaze';
        if (!explicit.head) explicit.head = 'slight_tilt';
    }
    if (explicit.eyes === 'wink') {
        if (!explicit.expression) explicit.expression = 'playful';
        if (!explicit.mouth) explicit.mouth = 'closed_smile';
    }
    if (explicit.mouth === 'smirk' && !explicit.expression) explicit.expression = 'confident';
    if (explicit.expression === 'laughing' && !explicit.mouth) explicit.mouth = 'open_smile';
    if (explicit.expression === 'big_smile' && !explicit.mouth) explicit.mouth = 'open_smile';
    if (explicit.expression === 'closed_smile' && explicit.mouth === 'open_smile') explicit.mouth = 'closed_smile';
}

// The best preset that satisfies every explicitly requested component.
function findPresetForExplicit(explicit) {
    const keys = Object.keys(explicit).filter((key) => explicit[key]);
    if (!keys.length) return null;
    const candidates = FACE_ACTIONS.filter((action) => keys.every((key) => action[key] === explicit[key]));
    if (!candidates.length) return null;
    return candidates.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0];
}

function mergeWithBase(explicit) {
    const base = FACE_ACTIONS
        .filter((action) => action.expression === explicit.expression)
        .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0] || FACE_ACTIONS[0];
    return {
        expression: explicit.expression || base.expression,
        mouth: explicit.mouth || base.mouth,
        eyes: explicit.eyes || base.eyes,
        head: explicit.head || base.head
    };
}

// Turn a facial instruction in natural language into a structured, internally
// coherent Face Action. Returns { id, label, confidence, components, preset,
// action, confident }; an uncertain match leaves the expression unspecified.
function matchFaceActionFromText(text) {
    const value = String(text || '').trim();
    const empty = { id: '', label: '', confidence: 0, components: null, preset: null, action: null, confident: false };
    if (!value) return empty;

    const explicit = {};
    let confidence = 0;

    const expression = bestHint(EXPRESSION_HINTS, value);
    if (expression) {
        confidence = Math.max(confidence, expression.confidence);
        if (expression.id === 'smirk') {
            explicit.expression = 'confident';
            explicit.mouth = 'smirk';
        } else {
            explicit.expression = expression.id;
        }
    }
    const mouth = bestHint(MOUTH_HINTS, value);
    if (mouth) {
        confidence = Math.max(confidence, mouth.confidence);
        explicit.mouth = mouth.id;
    }
    const eyes = bestHint(EYE_HINTS, value);
    if (eyes) {
        confidence = Math.max(confidence, eyes.confidence);
        explicit.eyes = eyes.id;
    }
    const head = bestHint(HEAD_HINTS, value);
    if (head) {
        confidence = Math.max(confidence, head.confidence);
        explicit.head = head.id;
    }
    if (!Object.keys(explicit).length) return empty;

    normalizeConflict(explicit);
    const preset = findPresetForExplicit(explicit);
    const action = preset
        ? actionFromPreset(preset, 'matched', 'explicit')
        : buildCustomAction(mergeWithBase(explicit), 'matched', 'explicit');
    const confident = confidence >= MATCH_THRESHOLD;
    return {
        id: confident ? (preset ? preset.id : '') : '',
        label: confident ? action.label : '',
        confidence,
        components: confident
            ? { expression: action.expression, mouth: action.mouth, eyes: action.eyes, head: action.head }
            : null,
        preset: confident ? preset : null,
        action: confident ? action : null,
        confident
    };
}

// --- Introspection / formatting -----------------------------------------------

function pronoun(gender) {
    const key = String(gender || '').toLowerCase();
    if (key === 'woman') return { subject: 'She', possessive: 'her' };
    if (key === 'man') return { subject: 'He', possessive: 'his' };
    return { subject: 'They', possessive: 'their' };
}

// A concise, identity-safe sentence naming only what the face is doing.
function formatFaceAction(faceAction, options = {}) {
    if (!faceAction) return '';
    const voice = pronoun(options.gender);
    const subject = options.name && String(options.name).trim()
        ? String(options.name).trim()
        : voice.subject;
    const clause = faceAction.prompt || describeComponents(faceAction);
    return subject + ' has ' + clause;
}

// Remove recognizable facial-action wording after it has been moved into the
// structured Face Action section. This is used only for a concept's free-form
// scene prompt, so the final prompt does not repeat or contradict the same
// expression in two places.
const FACE_ACTION_TEXT_RE = /\b(?:looking\s+back\s+over\s+(?:her|his|their|the)\s+shoulder|looking\s+over\s+(?:her|his|their|the)\s+shoulder|direct\s+(?:eye\s+)?contact|looking\s+(?:directly\s+)?(?:at|into)\s+the\s+camera|side(?:ways)?\s+glance|looking\s+(?:slightly\s+)?away|gazing\s+away|looking\s+down|looking\s+up|eyes\s+(?:slightly\s+)?narrowed|wide[- ]eyed|head\s+(?:slightly\s+)?tilt(?:ed)?|tilt(?:ing|ed)?\s+(?:her|his|their)?\s*head|chin\s+(?:slightly\s+)?(?:down|up|raised)|slightly\s+parted\s+lips|parted\s+lips|pursed\s+lips|closed[- ]mouth\s+smile|open[- ]mouth\s+smile|tongue[- ]out|sticking\s+(?:her|his|their|my)?\s*tongue\s+out|tongue\s+out|soft\s+smile|big\s+smile|subtle\s+smile|gentle\s+smile|closed[- ]lip\s+smile|smil(?:e|ing|es)|grinn?ing|smirk(?:ing)?|wink(?:ing)?|laugh(?:ing|s)?|giggling|playful\s+(?:cheeky\s+)?expression|cheeky\s+expression|flirty\s+expression|confident\s+expression|coy\s+expression|shy\s+expression|surprised\s+expression|curious\s+expression|serious\s+expression|thoughtful\s+expression|natural\s+expression|relaxed\s+expression|playful|flirty|confident|coy|shy|surprised|curious|serious|thoughtful)\b/gi;

function stripFaceActionText(text) {
    return String(text || '')
        .replace(FACE_ACTION_TEXT_RE, ' ')
        .replace(/\b(?:with|and|while|but|as)\s+(?:her|his|their|a|an|the)\b/gi, ' ')
        .replace(/\b(?:with|and|while|but|as)\s*(?=[,.;!?]|$)/gi, ' ')
        .replace(/\b(?:her|his|their|the)\s*(?=[,.;!?]|$)/gi, ' ')
        .replace(/\s+([,.;!?])/g, '$1')
        .replace(/([,;])\s*(?:[,;]|$)/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
        .trim();
}

function faceActionSignature(faceAction) {
    if (!faceAction) return '';
    return faceAction.signature
        || ('custom:' + [faceAction.expression, faceAction.mouth, faceAction.eyes, faceAction.head].join(':'));
}

function listFaceActions() {
    return FACE_ACTIONS.map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        expression: action.expression,
        mouth: action.mouth,
        eyes: action.eyes,
        head: action.head
    }));
}

// The full component vocabulary + preset catalog for the UI.
function listFaceActionOptions() {
    return {
        presets: listFaceActions(),
        expressions: EXPRESSION_OPTIONS.map((entry) => ({ value: entry.id, label: entry.label })),
        mouths: MOUTH_OPTIONS.map((entry) => ({ value: entry.id, label: entry.label })),
        eyes: EYE_OPTIONS.map((entry) => ({ value: entry.id, label: entry.label })),
        heads: HEAD_OPTIONS.map((entry) => ({ value: entry.id, label: entry.label }))
    };
}

module.exports = {
    FACE_ACTIONS,
    EXPRESSION_OPTIONS,
    MOUTH_OPTIONS,
    EYE_OPTIONS,
    HEAD_OPTIONS,
    THEME_CONTEXT,
    PACK_CONTEXT,
    MATCH_THRESHOLD,
    listFaceActions,
    listFaceActionOptions,
    getFaceAction,
    getFaceActionById: getFaceAction,
    normalizeFaceActionId,
    resolveFaceActionSelection,
    resolveFaceActionValue,
    composeFaceAction,
    describeComponents,
    formatFaceAction,
    stripFaceActionText,
    faceActionSignature,
    scoreFaceAction,
    rankFaceActions,
    selectFaceAction,
    matchFaceActionFromText
};
