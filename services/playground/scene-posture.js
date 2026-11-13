/* ============================================
   JARVIS — Creative Playground Scene Posture
   Resolves ONE physically supported body position for a
   scene from its environment and activity. A setting
   implies where the body can be (seated at a restaurant
   table, standing at a bar, lying on a bed), and an
   explicitly requested stance always wins. This keeps the
   action, the place and the posture from contradicting
   each other (for example posing in a restaurant is
   seated squarely at the table, never perched on the
   edge of a chair). Data-only, deterministic, no LLM,
   no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const outfitContext = require('./outfit-context');

const LOCATION_POSTURES = Object.freeze({
    default: {
        label: 'Standing naturally',
        stance: 'standing',
        phrase: 'standing naturally with an easy weight balance, both feet planted on the floor, shoulders relaxed and hands resting comfortably'
    },
    bedroom: {
        label: 'Seated on the bed',
        stance: 'sitting',
        phrase: 'seated comfortably on the side of the bed with the back supported and both feet resting on the floor, hands relaxed in the lap'
    },
    sleeping: {
        label: 'Reclining on the bed',
        stance: 'lying',
        phrase: 'reclining comfortably on the bed with the upper body propped up and facing the camera, shoulders relaxed and hands resting beside the body'
    },
    living_room: {
        label: 'Seated on the sofa',
        stance: 'sitting',
        phrase: 'seated comfortably on the sofa with the back supported by the cushions, both feet resting on the floor and hands relaxed in the lap'
    },
    bathroom: {
        label: 'Standing at the mirror',
        stance: 'standing',
        phrase: 'standing naturally in front of the mirror with an even weight balance, both feet planted on the floor and hands resting or lightly holding a small item'
    },
    kitchen: {
        label: 'Standing at the counter',
        stance: 'standing',
        phrase: 'standing relaxed at the counter with an even weight balance, both feet planted on the floor and hands resting naturally or lightly on the counter'
    },
    cafe: {
        label: 'Seated at the cafe table',
        stance: 'sitting',
        phrase: 'seated squarely on the chair at the cafe table with the back resting against the backrest, both feet flat on the floor and forearms resting lightly near the table'
    },
    restaurant: {
        label: 'Seated at the table',
        stance: 'sitting',
        phrase: 'seated squarely on the seat of the chair at the table with the back resting against the backrest, both feet flat on the floor, knees together and angled slightly to one side, and one hand resting lightly on the table'
    },
    bar: {
        label: 'Standing at the bar',
        stance: 'standing',
        phrase: 'standing casually beside the bar with the weight shifted naturally onto one leg, both feet on the floor, shoulders relaxed and one hand resting lightly on the bar top'
    },
    office: {
        label: 'Seated at the desk',
        stance: 'sitting',
        phrase: 'seated upright at the desk with the back supported, both feet flat on the floor and hands resting naturally near the desk'
    },
    study: {
        label: 'Seated at the desk',
        stance: 'sitting',
        phrase: 'seated upright at the desk with the back supported, both feet flat on the floor and hands resting naturally near the desk'
    },
    gym: {
        label: 'Standing ready',
        stance: 'standing',
        phrase: 'standing with an active, balanced posture, feet planted shoulder-width apart and shoulders relaxed'
    },
    hiking: {
        label: 'Standing on the trail',
        stance: 'standing',
        phrase: 'standing on the trail with a balanced, ready posture, weight even and both feet planted'
    },
    beach: {
        label: 'Standing relaxed',
        stance: 'standing',
        phrase: 'standing relaxed on the sand with a natural unforced posture, weight evenly balanced and arms resting naturally'
    },
    mall: {
        label: 'Standing naturally',
        stance: 'standing',
        phrase: 'standing naturally with an easy relaxed posture, weight evenly balanced and both feet planted'
    },
    street: {
        label: 'Standing on the street',
        stance: 'standing',
        phrase: 'standing naturally on the pavement with the weight shifted onto one leg, both feet planted and hands relaxed'
    },
    park: {
        label: 'Standing in the park',
        stance: 'standing',
        phrase: 'standing naturally with an easy relaxed posture, weight evenly balanced and both feet planted'
    },
    party: {
        label: 'Standing at the party',
        stance: 'standing',
        phrase: 'standing naturally with a relaxed social posture, weight shifted onto one leg and hands resting comfortably'
    },
    date_night: {
        label: 'Seated at the table',
        stance: 'sitting',
        phrase: 'seated squarely on the seat of the chair at the table with the back resting against the backrest, both feet flat on the floor, knees together and angled slightly to one side, and one hand resting lightly on the table'
    },
    wedding: {
        label: 'Standing at the celebration',
        stance: 'standing',
        phrase: 'standing naturally with a poised, relaxed posture, weight evenly balanced and hands resting comfortably'
    },
    hotel: {
        label: 'Standing in the room',
        stance: 'standing',
        phrase: 'standing naturally with an easy relaxed posture, weight evenly balanced and both feet planted'
    },
    rooftop: {
        label: 'Standing at the railing',
        stance: 'standing',
        phrase: 'standing beside the railing with the weight shifted naturally onto one leg, both feet planted and hands resting lightly on the railing'
    },
    transit: {
        label: 'Seated in the seat',
        stance: 'sitting',
        phrase: 'seated upright in the seat with the back resting against the seat back, both feet on the floor and hands relaxed in the lap'
    },
    market: {
        label: 'Standing in the market',
        stance: 'standing',
        phrase: 'standing naturally with an easy relaxed posture, weight evenly balanced and both feet planted'
    },
    museum: {
        label: 'Standing in the gallery',
        stance: 'standing',
        phrase: 'standing naturally with a calm, relaxed posture, weight evenly balanced and hands resting comfortably'
    },
    library: {
        label: 'Standing among the shelves',
        stance: 'standing',
        phrase: 'standing naturally among the shelves with an easy weight balance, both feet planted and hands resting comfortably'
    },
    balcony: {
        label: 'Standing on the balcony',
        stance: 'standing',
        phrase: 'standing naturally on the balcony with the weight shifted onto one leg, both feet planted and hands resting on the railing or at the sides'
    },
    resort: {
        label: 'Standing relaxed',
        stance: 'standing',
        phrase: 'standing relaxed with a natural unforced posture, weight evenly balanced and arms resting naturally'
    },
    studio: {
        label: 'Standing naturally',
        stance: 'standing',
        phrase: 'standing naturally with an even weight balance, both feet planted on the floor, shoulders relaxed and hands resting comfortably'
    },
    chair: {
        label: 'Seated on the chair',
        stance: 'sitting',
        phrase: 'seated squarely on the seat of the chair with the back resting against the backrest, both feet flat on the floor, knees together and angled slightly to one side, and hands resting naturally in the lap'
    },
    sofa: {
        label: 'Seated on the sofa',
        stance: 'sitting',
        phrase: 'seated comfortably on the sofa with the back supported by the cushions, both feet resting on the floor and hands relaxed in the lap'
    },
    mirror: {
        label: 'Standing at the mirror',
        stance: 'standing',
        phrase: 'standing naturally in front of the mirror with an even weight balance, both feet planted on the floor and hands resting or lightly holding a small item'
    },
    car_seat: {
        label: 'Seated in the car',
        stance: 'sitting',
        phrase: 'seated upright in the car seat with the back resting against the seat back, both feet on the floor and hands relaxed in the lap'
    }
});

const STANCE_POSTURES = Object.freeze({
    standing: {
        label: 'Standing naturally',
        phrase: 'standing naturally with an easy weight balance, both feet planted on the floor, shoulders relaxed and hands resting comfortably'
    },
    sitting: {
        label: 'Seated',
        phrase: 'seated with the weight resting on the seat, the back supported, both feet flat on the floor and hands relaxed in the lap'
    },
    lying: {
        label: 'Reclining',
        phrase: 'reclining comfortably with the upper body propped up and facing the camera, shoulders relaxed and hands resting beside the body'
    },
    walking: {
        label: 'Walking naturally',
        phrase: 'walking naturally with one foot forward and the weight transferring between the steps, both feet contacting the ground and arms swinging loosely'
    },
    kneeling: {
        label: 'Kneeling',
        phrase: 'kneeling with the weight supported on both knees and the lower legs, the upper body upright and hands resting naturally'
    },
    leaning: {
        label: 'Leaning casually',
        phrase: 'leaning casually with one shoulder supported by the surface beside them, both feet planted on the floor and hands resting comfortably'
    }
});

const STANCE_HINTS = [
    { stance: 'lying', re: /\b(?:lying|lying down|reclin(?:e|ed|ing)|sprawled|flat on (?:the|her|his|their) (?:back|stomach|front)|in bed|napping|asleep|sleeping)\b/i },
    { stance: 'sitting', re: /\b(?:sitting|seated|sat down|perched)\b/i },
    { stance: 'kneeling', re: /\b(?:kneeling|crouching|squatting)\b/i },
    { stance: 'walking', re: /\b(?:walking|strolling|striding|jogging|running|sightseeing|browsing|shopping)\b/i },
    { stance: 'leaning', re: /\b(?:leaning|leant|resting against)\b/i },
    { stance: 'standing', re: /\b(?:standing|stood|on (?:her|his|their) feet)\b/i }
];

const ACTIVITY_STANCE = [
    { stance: 'lying', re: /\b(?:sleeping|napping|resting in bed|waking up|stretching after waking|relaxing in bed)\b/i },
    { stance: 'standing', re: /\b(?:doing skincare|applying makeup|getting ready|at the mirror|mirror selfie|checking (?:her|his|their) reflection|showing (?:the|her|his|their) outfit|turning to show the (?:full )?look|exercising|working out|stretching|yoga|lifting weights|cooking|making (?:breakfast|coffee))\b/i },
    { stance: 'walking', re: /\b(?:walking|strolling|sightseeing|shopping|browsing|hiking|jogging|running|heading out)\b/i },
    { stance: 'sitting', re: /\b(?:on the (?:sofa|couch|chair|stool|bench|bed)|at the (?:table|desk)|waiting for food|drinking|eating)\b/i }
];

const LOCATION_HINTS = [
    { id: 'car_seat', re: /\b(?:car interior|in the car|backseat|passenger seat|driver'?s seat|car seat)\b/i },
    { id: 'chair', re: /\b(?:chair|stool|bench|perched)\b/i },
    { id: 'mirror', re: /\b(?:mirror|vanity)\b/i },
    { id: 'sofa', re: /\b(?:sofa|couch)\b/i },
    { id: 'bedroom', re: /\bbed\b/i }
];

function detectStance(text) {
    const value = String(text || '');
    if (!value.trim()) return '';
    for (const hint of STANCE_HINTS) {
        if (hint.re.test(value)) return hint.stance;
    }
    return '';
}

function activityStance(activity) {
    const value = String(activity || '');
    if (!value.trim()) return '';
    for (const hint of ACTIVITY_STANCE) {
        if (hint.re.test(value)) return hint.stance;
    }
    return '';
}

function locationId(environment, activity) {
    const text = String(environment || '');
    for (const hint of LOCATION_HINTS) {
        if (hint.re.test(text)) return hint.id;
    }
    const context = outfitContext.classifyEnvironment(environment, activity);
    return context ? context.id : '';
}

function buildPosture(id, stance, source) {
    const base = LOCATION_POSTURES[id] || LOCATION_POSTURES.default;
    const chosen = stance && base.stance !== stance && STANCE_POSTURES[stance]
        ? STANCE_POSTURES[stance]
        : base;
    return {
        id: id || 'default',
        label: chosen.label,
        stance: chosen.stance || stance || base.stance,
        phrase: chosen.phrase,
        source
    };
}

// Resolve the one body position for a scene. Priority: an explicit stance in
// the user's own wording, then a stance implied by the activity, then the
// place's natural posture, then standing.
function resolve(options = {}) {
    const environment = String(options.environment || '');
    const activity = String(options.activity || '');
    const userPrompt = String(options.userPrompt || '');
    const id = locationId(environment, activity);

    const requested = detectStance(userPrompt);
    if (requested) {
        const posture = buildPosture(id, requested, 'user');
        if (requested === 'lying' && (id === 'bedroom' || id === 'sleeping')) {
            return Object.assign({}, LOCATION_POSTURES.sleeping, { id: id || 'sleeping', source: 'user' });
        }
        return posture;
    }

    const implied = detectStance(activity) || activityStance(activity);
    if (implied) return buildPosture(id, implied, 'activity');
    if (id && LOCATION_POSTURES[id]) return buildPosture(id, '', 'location');
    return buildPosture('default', '', 'default');
}

// The one-line creative-direction sentence the prompt builder and the identity
// edit instruction both use.
function formatDirection(posture, name) {
    const phrase = posture && (typeof posture === 'string' ? posture : posture.phrase);
    if (!phrase) return '';
    const who = name || 'the character';
    return 'Body position: ' + who + ' is ' + phrase + '.';
}

module.exports = {
    LOCATION_POSTURES,
    STANCE_POSTURES,
    detectStance,
    activityStance,
    locationId,
    resolve,
    formatDirection
};
