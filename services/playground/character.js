/* ============================================
   JARVIS — Creative Playground Character Generator
   Deterministic, seed-based random character
   identities. Independent appearance / age / gender
   controls act as constraints on a structured trait
   space; each appearance category supplies weighted
   pools (skin, face, eyes, hair, build, features)
   and light compatibility weighting keeps every
   combination coherent. No LLM, no GPU, no
   dependencies. The generator returns a structured
   identity plus a formatted natural-language
   description; scene/outfit/style stay separate.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

// --- Generation controls ------------------------------------------------------
//
// Appearance, age and gender are independent selectors. `random` means
// "unconstrained" and reproduces the general random-character behaviour.

const RANDOM = 'random';
const CHARACTER_SCHEMA_VERSION = 1;

const AGE_KEYS = ['young_adult', 'adult', 'mature', 'older'];
const GENDER_KEYS = ['woman', 'man'];

// Exact age ranges live here and nowhere else.
const AGE_GROUPS = {
    young_adult: {
        label: 'Young Adult',
        min: 18,
        max: 27,
        ages: ['19-year-old', '21-year-old', '23-year-old', '24-year-old', '26-year-old']
    },
    adult: {
        label: 'Adult',
        min: 28,
        max: 44,
        ages: ['29-year-old', '31-year-old', '34-year-old', '37-year-old', '40-year-old', '43-year-old']
    },
    mature: {
        label: 'Mature',
        min: 45,
        max: 59,
        ages: ['46-year-old', '49-year-old', '53-year-old', '57-year-old']
    },
    older: {
        label: 'Older',
        min: 60,
        max: 80,
        ages: ['62-year-old', '66-year-old', '70-year-old', '75-year-old', '79-year-old']
    }
};

const AGE_GROUP_ENTRIES = [
    { value: 'young_adult', weight: 5 },
    { value: 'adult', weight: 4 },
    { value: 'mature', weight: 1.2 },
    { value: 'older', weight: 0.7 }
];

const GENDER_ENTRIES = [
    { value: 'woman', weight: 5 },
    { value: 'man', weight: 4 }
];

const GENDER_LABELS = {
    woman: 'Woman',
    man: 'Man'
};

const GENDER_PRESENTATION = {
    woman: 'woman',
    man: 'man'
};

// --- Shared trait pools -------------------------------------------------------
//
// These pools are broad on purpose: they apply to every appearance category so
// no single category collapses into one "look". Demographic traits
// (skin/hair/eye colour) are category-specific and live on each category.

const ALL_AGE_GROUPS = AGE_KEYS.slice();
const ALL_SKINS = ['light', 'medium', 'deep'];
const YOUTHFUL = ['young_adult', 'adult'];
const AGED = ['mature', 'older'];

const FACE_SHAPES = [
    'an oval face',
    'a heart-shaped face',
    'a round face',
    'a square face',
    'an angular face',
    'a soft diamond-shaped face',
    'a long oval face',
    'a delicate heart-shaped face',
    'a broad face',
    'a tapered face',
    'a high-cheekboned face',
    'an elegantly elongated face',
    'a softly rounded face',
    'a defined square face',
    'a narrow oval face',
    'a rectangular face',
    'a triangular face',
    'an inverted-triangle face',
    'a diamond-shaped face',
    'an oblong face',
    'a softly squared face',
    'a chiselled angular face',
    'a petite rounded face',
    'a long, narrow face',
    'a balanced oval face',
    'a gently tapered face',
    'a strong, symmetrical face',
    'a fine-boned oval face',
    'a softly contoured face',
    'a wide, open face'
];

const EYE_SHAPES = [
    'almond-shaped eyes',
    'round eyes',
    'hooded eyes',
    'upturned eyes',
    'downturned eyes',
    'monolid eyes',
    'deep-set eyes',
    'wide-set eyes',
    'heavy-lidded eyes',
    'gently tapered eyes',
    'large expressive eyes',
    'narrow eyes',
    'oval eyes',
    'long-lashed eyes',
    'bright clear eyes',
    'cat-like eyes',
    'doe eyes',
    'close-set eyes',
    'small, neat eyes',
    'softly rounded eyes',
    'elongated eyes',
    'striking tilted eyes'
];

const EYEBROWS = [
    'softly arched eyebrows',
    'straight eyebrows',
    'thick natural eyebrows',
    'well-defined eyebrows',
    'tapered eyebrows',
    'rounded eyebrows',
    'subtly feathered eyebrows',
    'strong, straight brows',
    'naturally full eyebrows',
    'gently curved eyebrows',
    'high-arched eyebrows',
    'low, straight brows',
    'bushy brows',
    'thin, precise brows',
    'softly angled brows',
    'feathered arched brows',
    'bold, defined brows',
    'delicately arched brows'
];

// Separately represented face-structure traits. Kept independent of hair so a
// face re-roll can never disturb the hair (and vice versa).
const FACE_NOSES = [
    'a straight nose',
    'a softly rounded nose',
    'a slim, narrow nose',
    'a gently upturned nose',
    'a broad nose',
    'a button nose',
    'a refined nose',
    'a gently sloping nose',
    'a softly curved nose',
    'an elegant straight nose',
    'a slightly aquiline nose',
    'a petite nose',
    'a strong, straight nose',
    'a delicately bridged nose'
];

const FACE_LIPS = [
    'naturally full lips',
    'slim lips',
    'softly bowed lips',
    'a defined cupid\u2019s bow',
    'a full lower lip',
    'a balanced mouth',
    'a wide, generous mouth',
    'a small, delicate mouth',
    'gently curved lips',
    'a soft upper lip',
    'a defined lip line',
    'subtly full lips',
    'elegantly shaped lips',
    'a softly pointed cupid\u2019s bow'
];

const FACE_CHEEKS = [
    'high cheekbones',
    'soft cheeks',
    'full cheeks',
    'defined cheekbones',
    'delicate cheeks',
    'gently hollow cheeks',
    'rounded cheeks',
    'sculpted cheekbones',
    'rosy cheeks',
    'smoothly contoured cheeks'
];

const FACE_JAWS = [
    'a strong jawline',
    'a soft jawline',
    'a defined jawline',
    'a gently tapered jaw',
    'a rounded jawline',
    'a narrow jawline',
    'a square jawline',
    'a subtly angular jaw',
    'a firm jawline',
    'a delicate jawline'
];

// Natural undertone used alongside the tone. Complexion is described by tone +
// undertone, never a single flat colour value.
const SKIN_UNDERTONES = [
    'with a warm golden undertone',
    'with a neutral undertone',
    'with a warm olive undertone',
    'with a cool rosy undertone',
    'with a neutral beige undertone',
    'with a warm peach undertone',
    'with a cool ashy undertone',
    'with a neutral golden undertone',
    'with a soft warm undertone'
];

const HAIR_PARTS = [
    'a centre part',
    'a side part',
    'a deep side part',
    'a middle part with face-framing strands',
    'an off-centre part'
];

const HAIR_FRINGES = [
    { value: '', weight: 3 },
    { value: 'blunt bangs', weight: 2 },
    { value: 'wispy bangs', weight: 2 },
    { value: 'curtain bangs', weight: 2 },
    { value: 'side-swept bangs', weight: 1.5 },
    { value: 'baby bangs', weight: 1 },
    { value: 'long face-framing layers', weight: 1.5 }
];

const BUILDS = [
    { value: 'a slim build', weight: 3 },
    { value: 'an athletic build', weight: 3 },
    { value: 'a curvy build', weight: 4, genders: ['woman'] },
    { value: 'a petite frame', weight: 2, genders: ['woman'] },
    { value: 'a tall, lean frame', weight: 2 },
    { value: 'a soft, rounded build', weight: 2 },
    { value: 'a willowy build', weight: 1.5 },
    { value: 'a broad-shouldered build', weight: 2, genders: ['man'] },
    { value: 'a stocky build', weight: 1, genders: ['man'] },
    { value: 'a muscular build', weight: 2, genders: ['man'] },
    { value: 'a compact, athletic frame', weight: 2 },
    { value: 'a long-limbed build', weight: 1.5 },
    { value: 'a sturdy build', weight: 1.5 }
];

const DISTINCTIVE_FEATURES = [
    { value: '', weight: 3 },
    { value: 'a small beauty mark beneath one eye', weight: 2 },
    { value: 'a scattering of light freckles across the nose', weight: 2, skins: ['light', 'medium'] },
    { value: 'deep dimples when smiling', weight: 2 },
    { value: 'a tiny scar above one eyebrow', weight: 1 },
    { value: 'a gap between the front teeth', weight: 1 },
    { value: 'a widow\u2019s peak', weight: 1.5 },
    { value: 'a faint dimple in one cheek', weight: 1.5 },
    { value: 'a small mole on the jawline', weight: 1 },
    { value: 'a subtly dimpled chin', weight: 1 },
    { value: 'a faint scar on the chin', weight: 1 },
    { value: 'a faint scattering of freckles across the cheeks', weight: 1.5, skins: ['light', 'medium'] },
    { value: 'a small beauty mark above the lip', weight: 1.5 },
    { value: 'a beauty mark on the cheekbone', weight: 1.5 },
    { value: 'a tiny mole near the ear', weight: 1 },
    { value: 'a faint horizontal scar on the forehead', weight: 0.8 },
    { value: 'a small scar beside one eyebrow', weight: 1 },
    { value: 'a single dimple in the left cheek', weight: 1.5 },
    { value: 'a subtle cleft chin', weight: 1 },
    { value: 'a gently crooked smile', weight: 1 },
    { value: 'a faint freckle on one cheek', weight: 1.5, skins: ['light', 'medium'] },
    { value: 'soft laugh lines around the eyes', weight: 1, groups: ['mature', 'older'] },
    { value: 'a small mole on the temple', weight: 0.8 }
];

const EXPRESSIONS = [
    { value: 'a calm, open expression', weight: 3 },
    { value: 'a warm, easy smile', weight: 3 },
    { value: 'a thoughtful, serious look', weight: 2 },
    { value: 'a bright, cheerful expression', weight: 2 },
    { value: 'a relaxed, unposed look', weight: 2 },
    { value: 'a confident, level gaze', weight: 2 }
];

// `textures` gates a style to a hair-texture family; `genders` gates a look to
// a gender. Untagged entries are available to everyone.
const HAIR_STYLES = [
    { value: 'long', type: 'adj', weight: 4, textures: ['straight', 'wavy', 'curly'] },
    { value: 'shoulder-length', type: 'adj', weight: 3, textures: ['straight', 'wavy', 'curly'] },
    { value: 'medium-length layered', type: 'adj', weight: 3, textures: ['straight', 'wavy'] },
    { value: 'tousled', type: 'adj', weight: 2, textures: ['wavy', 'curly'] },
    { value: 'long layered', type: 'adj', weight: 2, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'a short bob', type: 'noun', weight: 3, textures: ['straight', 'wavy'] },
    { value: 'a sharp bob', type: 'noun', weight: 2, textures: ['straight'] },
    { value: 'a chin-length bob', type: 'noun', weight: 2, textures: ['straight', 'wavy', 'curly'] },
    { value: 'a pixie cut', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'coily'] },
    { value: 'a buzz cut', type: 'noun', weight: 1, textures: ['straight', 'coily'], genders: ['man'] },
    { value: 'a high ponytail', type: 'noun', weight: 2, textures: ['straight', 'wavy', 'curly'] },
    { value: 'a low ponytail', type: 'noun', weight: 2, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'a sleek low bun', type: 'noun', weight: 2, textures: ['straight', 'wavy'] },
    { value: 'a high bun', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'a top knot', type: 'noun', weight: 1.5, textures: ['wavy', 'curly', 'coily'] },
    { value: 'a messy bun', type: 'noun', weight: 2, textures: ['wavy', 'curly', 'coily'] },
    { value: 'twists', type: 'noun', weight: 1.5, textures: ['curly', 'coily'] },
    { value: 'box braids', type: 'noun', weight: 1.5, textures: ['curly', 'coily'] },
    { value: 'locs', type: 'noun', weight: 1.5, textures: ['coily', 'curly'] },
    { value: 'a round afro', type: 'noun', weight: 1.5, textures: ['coily', 'curly'] },
    { value: 'an undercut', type: 'noun', weight: 1, textures: ['straight', 'wavy'], genders: ['man'] },
    { value: 'a fade', type: 'noun', weight: 1, textures: ['coily', 'straight'], genders: ['man'] },
    { value: 'a shoulder-length shag', type: 'noun', weight: 1.5, textures: ['wavy', 'curly'] },
    { value: 'a side-swept fringe', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'curtain bangs', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly'] },
    { value: 'a blunt shoulder-length cut', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'an asymmetric lob', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'a layered shag with bangs', type: 'noun', weight: 1.5, textures: ['wavy', 'curly'] },
    { value: 'space buns', type: 'noun', weight: 1, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'a sleek middle-part style', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'a braided crown', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'twin French braids', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'cornrows', type: 'noun', weight: 1.5, textures: ['coily', 'curly'] },
    { value: 'finger coils', type: 'noun', weight: 1.5, textures: ['coily', 'curly'] },
    { value: 'bantu knots', type: 'noun', weight: 1, textures: ['coily', 'curly'] },
    { value: 'a tapered afro', type: 'noun', weight: 1.5, textures: ['coily', 'curly'] },
    { value: 'a braided ponytail', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly', 'coily'] },
    { value: 'a half-up half-down style', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly'] },
    { value: 'a wrapped headwrap style', type: 'noun', weight: 0.8, textures: ['coily', 'curly'] }
];

// Hair texture is chosen as a family, then realised as one of its variants, so
// the style pool can stay compatible without collapsing variation.
const HAIR_TEXTURE_FAMILIES = [
    { value: 'straight', weight: 4 },
    { value: 'wavy', weight: 4 },
    { value: 'curly', weight: 3.5 },
    { value: 'coily', weight: 2.5 }
];

const HAIR_TEXTURE_VALUES = {
    straight: [{ value: 'straight', weight: 4 }, { value: 'sleek straight', weight: 2 }, { value: 'fine straight', weight: 2 }],
    wavy: [{ value: 'wavy', weight: 4 }, { value: 'loosely wavy', weight: 2 }, { value: 'thick wavy', weight: 2 }],
    curly: [{ value: 'curly', weight: 4 }, { value: 'tightly curled', weight: 2 }, { value: 'softly curled', weight: 2 }],
    coily: [{ value: 'coily', weight: 4 }, { value: 'kinky coily', weight: 2 }, { value: 'densely coily', weight: 2 }]
};

const NAMES = {
    feminine: ['Maya', 'Hana', 'Sofia', 'Nora', 'Lena', 'Mina', 'Iris', 'Zoe', 'Priya', 'Amara',
        'Leila', 'Elena', 'Rina', 'Tara', 'Sana', 'Mira', 'Aisha', 'Lucia', 'Nadia', 'Ines',
        'Mila', 'Juno', 'Yara', 'Mei', 'Anika', 'Farah', 'Simone', 'Camila', 'Dalia', 'Esme'],
    masculine: ['Kai', 'Theo', 'Ravi', 'Diego', 'Omar', 'Kenji', 'Adrian', 'Malik', 'Elias', 'Noah',
        'Arjun', 'Mateo', 'Idris', 'Hugo', 'Samir', 'Dario', 'Luca', 'Tomas', 'Yusuf', 'Rohan',
        'Nico', 'Amir'],
    neutral: ['Ari', 'Noa', 'Remi', 'Sasha', 'Noor', 'Quinn', 'Rio', 'Kiran', 'Jules', 'Ren',
        'Sage', 'Ash', 'Micah', 'Eden', 'Lior', 'Toni', 'Devon']
};

// --- Appearance categories ----------------------------------------------------

function skin(value, group, weight) {
    return { value, group, weight: weight || 1 };
}

function hair(value, weight, groups) {
    return { value, weight, groups: (groups || ALL_AGE_GROUPS).slice() };
}

function eye(value, weight, skins) {
    return { value, weight, skins: (skins || ALL_SKINS).slice() };
}

function tex(value, weight) {
    return { value, weight: weight || 1 };
}

function makeCategory(spec) {
    return Object.assign({
        hairStyles: HAIR_STYLES,
        hairParts: HAIR_PARTS,
        hairFringes: HAIR_FRINGES,
        faceShapes: FACE_SHAPES,
        faceNoses: FACE_NOSES,
        faceLips: FACE_LIPS,
        faceCheeks: FACE_CHEEKS,
        faceJaws: FACE_JAWS,
        eyeShapes: EYE_SHAPES,
        eyebrows: EYEBROWS,
        builds: BUILDS,
        skinUndertones: SKIN_UNDERTONES,
        distinctiveFeatures: DISTINCTIVE_FEATURES
    }, spec);
}

// --- East Asian enrichment ----------------------------------------------------
//
// The East Asian category carries its own larger pools so random generation
// yields a wider and more flattering range of fictional East Asian identities.
// Every value is generic descriptive wording — no nationalities and no real
// people. Flattering traits are weighted slightly higher while variety stays.

const EAST_ASIAN_FACE_SHAPES = FACE_SHAPES.concat([
    { value: 'a soft oval face', weight: 2 },
    { value: 'a gently rounded face', weight: 2 },
    { value: 'a balanced oval face', weight: 2 },
    { value: 'a softly tapered face', weight: 1.5 },
    { value: 'a subtle heart-shaped face', weight: 1.5 },
    { value: 'a softly angular face', weight: 1.5 },
    { value: 'a broad oval face', weight: 1.2 },
    { value: 'a rounded face with a defined jawline', weight: 1.2 },
    { value: 'a longer oval face', weight: 1.2 },
    { value: 'a naturally proportioned face', weight: 1.5 }
]);

const EAST_ASIAN_EYE_SHAPES = EYE_SHAPES.concat([
    { value: 'almond-shaped eyes', weight: 2 },
    { value: 'soft almond eyes', weight: 2 },
    { value: 'slightly hooded almond eyes', weight: 1.5 },
    { value: 'monolid eyes', weight: 1.5 },
    { value: 'double-lidded eyes', weight: 1.5 },
    { value: 'slightly upturned eyes', weight: 1.5 },
    { value: 'slightly downturned eyes', weight: 1.2 },
    { value: 'rounded almond eyes', weight: 1.2 },
    { value: 'narrow almond eyes', weight: 1.2 },
    { value: 'softly hooded eyes', weight: 1.2 },
    { value: 'deep-set almond eyes', weight: 1 },
    { value: 'naturally proportioned eyes', weight: 1.5 }
]);

const EAST_ASIAN_EYEBROWS = EYEBROWS.concat([
    { value: 'softly feathered straight brows', weight: 1.5 },
    { value: 'natural straight brows', weight: 1.5 },
    { value: 'fine, softly tapered brows', weight: 1.2 },
    { value: 'softly rounded brows', weight: 1.2 },
    { value: 'gently straight brows', weight: 1.2 }
]);

const EAST_ASIAN_BUILDS = BUILDS.concat([
    { value: 'a slender, willowy frame', weight: 2 },
    { value: 'a graceful, petite frame', weight: 1.5, genders: ['woman'] },
    { value: 'a slim, toned build', weight: 2 },
    { value: 'a soft, delicate frame', weight: 1.5 }
]);

const EAST_ASIAN_HAIR_STYLES = HAIR_STYLES.concat([
    { value: 'waist-length', type: 'adj', weight: 2, textures: ['straight', 'wavy'] },
    { value: 'chest-length', type: 'adj', weight: 2, textures: ['straight', 'wavy', 'curly'] },
    { value: 'softly layered', type: 'adj', weight: 1.5, textures: ['straight', 'wavy', 'curly'] },
    { value: 'silky', type: 'adj', weight: 1.5, textures: ['straight'] },
    { value: 'glossy', type: 'adj', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'a hime cut', type: 'noun', weight: 1.5, textures: ['straight'] },
    { value: 'blunt bangs', type: 'noun', weight: 1.5, textures: ['straight'] },
    { value: 'wispy bangs', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'a soft lob', type: 'noun', weight: 2, textures: ['straight', 'wavy'] },
    { value: 'a sleek low chignon', type: 'noun', weight: 1.5, textures: ['straight', 'wavy'] },
    { value: 'a half-up bun', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly'] },
    { value: 'double buns', type: 'noun', weight: 1, textures: ['straight', 'wavy'] },
    { value: 'a side braid', type: 'noun', weight: 1.5, textures: ['straight', 'wavy', 'curly'] },
    { value: 'twin low braids', type: 'noun', weight: 1, textures: ['straight', 'wavy'] },
    { value: 'a claw-clip updo', type: 'noun', weight: 1, textures: ['straight', 'wavy'] }
]);

const EAST_ASIAN_DISTINCTIVE_FEATURES = DISTINCTIVE_FEATURES.concat([
    { value: 'a small, delicate nose', weight: 2 },
    { value: 'naturally rosy cheeks', weight: 2, skins: ['light', 'medium'] },
    { value: 'softly bowed lips', weight: 2 },
    { value: 'a tiny beauty mark beside the lip', weight: 1.5 },
    { value: 'a small mole above one eyebrow', weight: 1 },
    { value: 'a soft, dewy complexion', weight: 1.5, skins: ['light', 'medium'] },
    { value: 'a gently dimpled smile', weight: 1.5 }
]);

const APPEARANCE_CATEGORIES = {
    east_asian: makeCategory({
        label: 'East Asian',
        weight: 1,
        // A larger, flattering trait space (see "East Asian enrichment").
        faceShapes: EAST_ASIAN_FACE_SHAPES,
        eyeShapes: EAST_ASIAN_EYE_SHAPES,
        eyebrows: EAST_ASIAN_EYEBROWS,
        builds: EAST_ASIAN_BUILDS,
        hairStyles: EAST_ASIAN_HAIR_STYLES,
        distinctiveFeatures: EAST_ASIAN_DISTINCTIVE_FEATURES,
        skinTones: [
            skin('fair skin', 'light', 2),
            skin('light skin', 'light', 2),
            skin('porcelain skin', 'light', 2),
            skin('luminous fair skin', 'light', 2),
            skin('light beige skin', 'light', 2),
            skin('light olive skin', 'light', 2),
            skin('light golden skin', 'light', 2),
            skin('warm ivory skin', 'light', 1.5),
            skin('soft peach-beige skin', 'light', 1.5),
            skin('medium golden skin', 'medium', 3),
            skin('medium beige skin', 'medium', 2.5),
            skin('golden beige skin', 'medium', 2.5),
            skin('medium warm skin', 'medium', 2),
            skin('warm honey skin', 'medium', 2),
            skin('light golden-tan skin', 'medium', 2),
            skin('warm tan skin', 'medium', 2)
        ],
        hairColors: [
            hair('black', 5),
            hair('dark brown', 5),
            hair('blue-black', 3),
            hair('milk-tea brown', 3),
            hair('brown', 3),
            hair('mocha brown', 2.5),
            hair('espresso brown', 2.5),
            hair('smoky brown', 2),
            hair('chestnut', 2),
            hair('ash brown', 2),
            hair('warm chestnut', 2),
            hair('honey brown', 1.5, YOUTHFUL),
            hair('chestnut brown', 2, YOUTHFUL),
            hair('ash blonde', 1.5, YOUTHFUL),
            hair('cherry red', 1, YOUTHFUL),
            hair('rose gold', 0.8, YOUTHFUL),
            hair('burgundy', 0.7, YOUTHFUL),
            hair('teal', 0.5, YOUTHFUL),
            hair('lavender grey', 0.6, YOUTHFUL),
            hair('pastel pink', 0.5, ['young_adult']),
            hair('grey-streaked black', 2, AGED),
            hair('salt-and-pepper', 2, AGED),
            hair('silver', 1.5, AGED),
            hair('white', 1, AGED)
        ],
        hairTextures: [tex('straight', 6), tex('wavy', 2), tex('curly', 0.7), tex('coily', 0.2)],
        eyeColors: [
            eye('dark brown', 5),
            eye('deep espresso brown', 4),
            eye('black-brown', 4),
            eye('warm brown', 4),
            eye('soft chocolate brown', 3),
            eye('warm chestnut brown', 3),
            eye('light brown', 2),
            eye('golden brown', 2),
            eye('honey brown', 2),
            eye('hazel', 1),
            eye('amber', 1),
            eye('grey brown', 1),
            eye('hazel green', 1),
            eye('grey-blue', 0.7, ['light']),
            eye('dark jade', 0.5, ['light', 'medium'])
        ]
    }),

    southeast_asian: makeCategory({
        label: 'Southeast Asian',
        weight: 1,
        skinTones: [
            skin('light golden skin', 'light', 2),
            skin('medium golden skin', 'medium', 3),
            skin('warm tan skin', 'medium', 3),
            skin('medium olive skin', 'medium', 2),
            skin('golden tan skin', 'medium', 2),
            skin('golden brown skin', 'medium', 2),
            skin('deep golden brown skin', 'deep', 2),
            skin('warm brown skin', 'deep', 2),
            skin('deep warm brown skin', 'deep', 1.5)
        ],
        hairColors: [
            hair('black', 5),
            hair('dark brown', 5),
            hair('jet black', 3),
            hair('brown', 3),
            hair('chestnut', 2),
            hair('auburn', 1.5, YOUTHFUL),
            hair('honey brown', 1.5, YOUTHFUL),
            hair('copper', 1, YOUTHFUL),
            hair('burgundy', 0.6, YOUTHFUL),
            hair('grey-streaked', 1.5, AGED),
            hair('salt-and-pepper', 1.5, AGED),
            hair('silver', 1, AGED)
        ],
        hairTextures: [tex('straight', 3), tex('wavy', 4), tex('curly', 2.5), tex('coily', 1.5)],
        eyeColors: [
            eye('dark brown', 5),
            eye('black-brown', 3),
            eye('warm brown', 4),
            eye('light brown', 2),
            eye('amber', 2),
            eye('hazel', 1.5)
        ]
    }),

    south_asian: makeCategory({
        label: 'South Asian',
        weight: 1,
        skinTones: [
            skin('light olive skin', 'light', 2),
            skin('warm beige skin', 'light', 2),
            skin('medium olive skin', 'medium', 3),
            skin('warm tan skin', 'medium', 2),
            skin('golden brown skin', 'medium', 2),
            skin('golden beige skin', 'medium', 2),
            skin('deep brown skin', 'deep', 3),
            skin('rich dark brown skin', 'deep', 2)
        ],
        hairColors: [
            hair('black', 5),
            hair('dark brown', 5),
            hair('jet black', 3),
            hair('deep brown', 2),
            hair('brown', 3),
            hair('chestnut', 2),
            hair('auburn', 1, YOUTHFUL),
            hair('burgundy', 0.6, YOUTHFUL),
            hair('henna red', 0.8, YOUTHFUL),
            hair('grey-streaked', 2, AGED),
            hair('salt-and-pepper', 2, AGED),
            hair('silver', 1.5, AGED),
            hair('white', 1, AGED)
        ],
        hairTextures: [tex('straight', 3), tex('wavy', 4), tex('curly', 3), tex('coily', 2)],
        eyeColors: [
            eye('dark brown', 5),
            eye('black-brown', 4),
            eye('warm brown', 4),
            eye('amber', 2),
            eye('hazel', 1.5),
            eye('green', 1)
        ]
    }),

    white_european: makeCategory({
        label: 'White / European',
        weight: 1,
        skinTones: [
            skin('pale porcelain skin', 'light', 2),
            skin('fair skin', 'light', 3),
            skin('light skin', 'light', 2),
            skin('light olive skin', 'light', 2),
            skin('warm olive skin', 'light', 1.5),
            skin('light golden skin', 'light', 1.5),
            skin('freckled fair skin', 'light', 1.5),
            skin('medium warm skin', 'medium', 2),
            skin('sun-kissed tan skin', 'medium', 2)
        ],
        hairColors: [
            hair('dark brown', 4),
            hair('brown', 4),
            hair('light brown', 3),
            hair('chestnut', 3),
            hair('black', 3),
            hair('ash blonde', 2.5),
            hair('auburn', 2.5, YOUTHFUL),
            hair('honey blonde', 3, YOUTHFUL),
            hair('platinum blonde', 2, YOUTHFUL),
            hair('copper', 1.5, YOUTHFUL),
            hair('red', 1.5, YOUTHFUL),
            hair('grey-streaked', 2, AGED),
            hair('salt-and-pepper', 2, AGED),
            hair('silver', 2, AGED),
            hair('white', 1.5, AGED)
        ],
        hairTextures: [tex('straight', 4), tex('wavy', 4), tex('curly', 2.5), tex('coily', 0.5)],
        eyeColors: [
            eye('blue', 3),
            eye('grey-blue', 2.5),
            eye('green', 3),
            eye('grey', 2),
            eye('hazel', 2.5),
            eye('light brown', 3),
            eye('dark brown', 3),
            eye('amber', 1)
        ]
    }),

    black_african_diaspora: makeCategory({
        label: 'Black / African Diaspora',
        weight: 1,
        skinTones: [
            skin('light brown skin', 'light', 2),
            skin('medium brown skin', 'medium', 3),
            skin('golden brown skin', 'medium', 2),
            skin('caramel brown skin', 'medium', 2),
            skin('mahogany brown skin', 'deep', 2),
            skin('deep brown skin', 'deep', 3),
            skin('rich dark brown skin', 'deep', 3),
            skin('deep espresso brown skin', 'deep', 2),
            skin('warm ebony skin', 'deep', 2)
        ],
        hairColors: [
            hair('jet black', 5),
            hair('black', 4),
            hair('dark brown', 4),
            hair('chestnut brown', 2.5),
            hair('caramel brown', 2),
            hair('auburn', 1.5, YOUTHFUL),
            hair('honey brown', 1.5, YOUTHFUL),
            hair('copper', 1, YOUTHFUL),
            hair('burgundy', 0.8, YOUTHFUL),
            hair('platinum blonde', 0.8, YOUTHFUL),
            hair('pastel pink', 0.5, ['young_adult']),
            hair('grey-streaked', 1.5, AGED),
            hair('salt-and-pepper', 1.5, AGED),
            hair('silver', 1, AGED),
            hair('white', 0.8, AGED)
        ],
        hairTextures: [tex('coily', 5), tex('curly', 4), tex('wavy', 1.5), tex('straight', 1)],
        eyeColors: [
            eye('dark brown', 5),
            eye('rich brown', 4),
            eye('black-brown', 4),
            eye('warm brown', 3),
            eye('amber', 1.5),
            eye('hazel', 1)
        ]
    }),

    latino_hispanic: makeCategory({
        label: 'Latino / Hispanic',
        weight: 1,
        skinTones: [
            skin('light tan skin', 'light', 2),
            skin('light olive skin', 'light', 2),
            skin('warm beige skin', 'light', 2),
            skin('medium golden skin', 'medium', 3),
            skin('olive brown skin', 'medium', 2),
            skin('caramel skin', 'medium', 2),
            skin('deep tan skin', 'deep', 2),
            skin('warm brown skin', 'deep', 2),
            skin('deep brown skin', 'deep', 2)
        ],
        hairColors: [
            hair('black', 4),
            hair('dark brown', 5),
            hair('brown', 4),
            hair('chestnut', 3),
            hair('caramel', 2.5),
            hair('auburn', 2, YOUTHFUL),
            hair('honey brown', 2, YOUTHFUL),
            hair('copper', 1.5, YOUTHFUL),
            hair('blonde', 1.5, YOUTHFUL),
            hair('burgundy', 0.8, YOUTHFUL),
            hair('grey-streaked', 1.5, AGED),
            hair('salt-and-pepper', 1.5, AGED),
            hair('silver', 1, AGED)
        ],
        hairTextures: [tex('wavy', 4), tex('straight', 3), tex('curly', 3), tex('coily', 1.5)],
        eyeColors: [
            eye('dark brown', 5),
            eye('black-brown', 3),
            eye('warm brown', 4),
            eye('light brown', 2.5),
            eye('hazel', 2.5),
            eye('green', 1.5),
            eye('amber', 1.5)
        ]
    }),

    middle_eastern: makeCategory({
        label: 'Middle Eastern',
        weight: 1,
        skinTones: [
            skin('light olive skin', 'light', 2),
            skin('warm beige skin', 'light', 2),
            skin('medium olive skin', 'medium', 3),
            skin('medium tan skin', 'medium', 2),
            skin('golden tan skin', 'medium', 2),
            skin('golden brown skin', 'medium', 2),
            skin('deep olive skin', 'deep', 2),
            skin('warm brown skin', 'deep', 2)
        ],
        hairColors: [
            hair('black', 5),
            hair('dark brown', 5),
            hair('jet black', 3),
            hair('brown', 3),
            hair('chestnut', 2.5),
            hair('auburn', 1.5, YOUTHFUL),
            hair('copper', 1, YOUTHFUL),
            hair('honey brown', 1.5, YOUTHFUL),
            hair('burgundy', 0.6, YOUTHFUL),
            hair('grey-streaked', 2, AGED),
            hair('salt-and-pepper', 2, AGED),
            hair('silver', 1.5, AGED)
        ],
        hairTextures: [tex('wavy', 4), tex('straight', 3), tex('curly', 3), tex('coily', 1.5)],
        eyeColors: [
            eye('dark brown', 5),
            eye('black-brown', 3),
            eye('warm brown', 4),
            eye('light brown', 2.5),
            eye('hazel', 2.5),
            eye('green', 2),
            eye('amber', 1.5)
        ]
    }),

    mixed_diverse: makeCategory({
        label: 'Mixed / Diverse',
        weight: 1,
        skinTones: [
            skin('fair skin', 'light', 2),
            skin('light tan skin', 'light', 2),
            skin('light olive skin', 'light', 2),
            skin('medium golden skin', 'medium', 2.5),
            skin('olive skin', 'medium', 2),
            skin('caramel skin', 'medium', 2),
            skin('medium brown skin', 'medium', 2.5),
            skin('warm bronze skin', 'medium', 2),
            skin('deep brown skin', 'deep', 2),
            skin('rich dark brown skin', 'deep', 2)
        ],
        hairColors: [
            hair('black', 4),
            hair('jet black', 2),
            hair('dark brown', 4),
            hair('brown', 4),
            hair('chestnut', 3),
            hair('caramel', 2),
            hair('auburn', 2, YOUTHFUL),
            hair('honey blonde', 2, YOUTHFUL),
            hair('copper', 1.5, YOUTHFUL),
            hair('burgundy', 0.8, YOUTHFUL),
            hair('grey-streaked', 1.5, AGED),
            hair('salt-and-pepper', 1.5, AGED),
            hair('silver', 1, AGED)
        ],
        hairTextures: [tex('straight', 3), tex('wavy', 3.5), tex('curly', 3), tex('coily', 2.5)],
        eyeColors: [
            eye('dark brown', 4),
            eye('warm brown', 4),
            eye('light brown', 3),
            eye('hazel', 3),
            eye('green', 2.5),
            eye('grey-blue', 2),
            eye('blue', 1.5),
            eye('amber', 2)
        ]
    })
};

const APPEARANCE_KEYS = Object.keys(APPEARANCE_CATEGORIES);

const APPEARANCE_ENTRIES = APPEARANCE_KEYS.map((key) => ({
    value: key,
    weight: APPEARANCE_CATEGORIES[key].weight || 1
}));

// --- Profile normalization ----------------------------------------------------

function normalizeProfile(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        appearance: APPEARANCE_CATEGORIES[src.appearance] ? src.appearance : RANDOM,
        age: AGE_GROUPS[src.age] ? src.age : RANDOM,
        gender: GENDER_KEYS.includes(src.gender) ? src.gender : RANDOM
    };
}

function isRandomProfile(profile) {
    const p = normalizeProfile(profile);
    return p.appearance === RANDOM && p.age === RANDOM && p.gender === RANDOM;
}

function sameProfile(a, b) {
    const x = normalizeProfile(a);
    const y = normalizeProfile(b);
    return x.appearance === y.appearance && x.age === y.age && x.gender === y.gender;
}

// Human-readable label for an appearance category key (empty for unknown).
function appearanceCategoryLabel(key) {
    const category = APPEARANCE_CATEGORIES[key];
    return category ? category.label : '';
}

function listProfileOptions() {
    return {
        appearance: [{ value: RANDOM, label: 'Random' }].concat(
            APPEARANCE_KEYS.map((key) => ({ value: key, label: APPEARANCE_CATEGORIES[key].label }))
        ),
        age: [{ value: RANDOM, label: 'Random' }].concat(
            AGE_KEYS.map((key) => ({
                value: key,
                label: AGE_GROUPS[key].label + ' (' + AGE_GROUPS[key].min + '-' + AGE_GROUPS[key].max + ')'
            }))
        ),
        gender: [{ value: RANDOM, label: 'Random' }].concat(
            GENDER_KEYS.map((key) => ({ value: key, label: GENDER_LABELS[key] }))
        )
    };
}

// --- Deterministic RNG --------------------------------------------------------

// mulberry32 — small, fast, dependency-free. The same seed always yields the
// same sequence, so an identity is reproducible from its stored seed.
function createRng(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return function rng() {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Accept either a numeric seed or an RNG function (the concept engine's
// convention). A function contributes one draw to derive the identity seed;
// every trait is then drawn from that seed's own stream.
function resolveRng(input) {
    if (typeof input === 'function') {
        const seed = Math.floor(input() * 0xFFFFFFFF) >>> 0;
        return { seed: seed || 1, rng: createRng(seed || 1) };
    }
    const seed = (Number(input) >>> 0) || 1;
    return { seed, rng: createRng(seed) };
}

function toEntries(pool) {
    return (Array.isArray(pool) ? pool : [])
        .map((entry) => (typeof entry === 'string' ? { value: entry } : entry))
        .filter((entry) => entry && entry.value !== undefined && entry.value !== null);
}

function isCompatible(entry, context) {
    if (Array.isArray(entry.groups) && context.ageGroup && !entry.groups.includes(context.ageGroup)) return false;
    if (Array.isArray(entry.skins) && context.skinGroup && !entry.skins.includes(context.skinGroup)) return false;
    const gender = context.gender || context.presentation;
    if (Array.isArray(entry.genders) && gender && !entry.genders.includes(gender)) return false;
    if (Array.isArray(entry.presentations) && context.presentation && !entry.presentations.includes(context.presentation)) return false;
    if (Array.isArray(entry.textures) && context.texture && !entry.textures.includes(context.texture)) return false;
    return true;
}

function pickWeighted(pool, rng, context = {}) {
    const entries = toEntries(pool);
    if (!entries.length) return { value: '' };
    const compatible = entries.filter((entry) => isCompatible(entry, context));
    const candidates = compatible.length ? compatible : entries;
    const weightOf = (entry) => (Number(entry.weight) > 0 ? Number(entry.weight) : 1);
    const total = candidates.reduce((sum, entry) => sum + weightOf(entry), 0);
    let roll = rng() * total;
    for (const entry of candidates) {
        roll -= weightOf(entry);
        if (roll <= 0) return entry;
    }
    return candidates[candidates.length - 1];
}

function pickValue(pool, rng, context) {
    return pickWeighted(pool, rng, context).value;
}

function pickName(rng, gender) {
    const pool = gender === 'man'
        ? NAMES.masculine.concat(NAMES.neutral)
        : gender === 'woman'
            ? NAMES.feminine.concat(NAMES.neutral)
            : NAMES.neutral;
    return pickValue(pool, rng);
}

// --- Formatting ---------------------------------------------------------------

function joinList(items) {
    const arr = (Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

// Read a flat trait view from either the generated flat identity or the nested
// canonical identity, so formatting works for both legacy and new records.
function flatTraits(value) {
    const src = value && typeof value === 'object' ? value : {};
    const skin = src.skin && typeof src.skin === 'object' ? src.skin : {};
    const face = src.face && typeof src.face === 'object' ? src.face : {};
    const eyes = src.eyes && typeof src.eyes === 'object' ? src.eyes : {};
    const hair = src.hair && typeof src.hair === 'object' ? src.hair : {};
    return {
        skinTone: src.skinTone || skin.tone || '',
        skinUndertone: src.skinUndertone || skin.undertone || '',
        faceShape: src.faceShape || face.shape || '',
        faceNose: src.faceNose || face.nose || '',
        faceLips: src.faceLips || face.lips || '',
        faceCheeks: src.faceCheeks || face.cheeks || '',
        faceJaw: src.faceJaw || face.jaw || '',
        eyeColor: src.eyeColor || eyes.color || '',
        eyeShape: src.eyeShape || eyes.shape || '',
        eyebrows: src.eyebrows || '',
        hairColor: src.hairColor || hair.color || '',
        hairTexture: src.hairTexture || hair.texture || '',
        hairTextureFamily: src.hairTextureFamily || hair.textureFamily || '',
        hairStyle: src.hairStyle || hair.style || '',
        hairStyleType: src.hairStyleType || hair.styleType || 'adj',
        hairPart: src.hairPart || hair.part || '',
        hairFringe: src.hairFringe || hair.fringe || '',
        build: src.build || '',
        distinctiveFeature: src.distinctiveFeature || '',
        age: src.age || '',
        gender: src.gender || '',
        presentation: src.presentation || ''
    };
}

function formatEyes(identity) {
    const t = flatTraits(identity);
    return [String(t.eyeColor).trim(), String(t.eyeShape).trim()].filter(Boolean).join(' ');
}

// Face structure: shape + cheeks/jaw + nose + lips, all separately represented.
function formatFace(identity) {
    const t = flatTraits(identity);
    return joinList([t.faceShape, t.faceCheeks, t.faceJaw, t.faceNose, t.faceLips]
        .map((part) => String(part || '').trim()).filter(Boolean));
}

function formatHair(identity) {
    const t = flatTraits(identity);
    const style = String(t.hairStyle || '').trim();
    const texture = String(t.hairTexture || '').trim();
    const color = String(t.hairColor || '').trim();
    const part = String(t.hairPart || '').trim();
    const fringe = String(t.hairFringe || '').trim();
    if (!style) {
        const base = [texture, color, 'hair'].filter(Boolean).join(' ');
        return joinList([base, fringe].filter(Boolean));
    }
    if (t.hairStyleType === 'noun') {
        let text = style;
        if (fringe) text += ' with ' + fringe;
        if (color) text += ' in ' + color;
        if (part) text += ', ' + part;
        return text;
    }
    let text = [style, texture, color, 'hair'].filter(Boolean).join(' ');
    if (part) text += ', ' + part;
    if (fringe) text += ' with ' + fringe;
    return text;
}

// Appearance field for the concept model: skin + undertone, face structure,
// eyes, brows, build, feature.
function formatAppearance(identity) {
    const t = flatTraits(identity);
    const parts = [];
    if (t.skinTone) parts.push([t.skinTone, t.skinUndertone].filter(Boolean).join(' '));
    const face = formatFace(t);
    if (face) parts.push(face);
    const eyes = formatEyes(t);
    if (eyes) parts.push(eyes);
    if (t.eyebrows) parts.push(t.eyebrows);
    if (t.build) parts.push(t.build);
    if (t.distinctiveFeature) parts.push(t.distinctiveFeature);
    return joinList(parts);
}

// The natural-language identity sentence used as the concept's `subject`.
function formatIdentity(identity) {
    const t = flatTraits(identity);
    const head = ['a', String(t.age || '').trim(), String(t.presentation || '').trim()].filter(Boolean).join(' ');
    const parts = [];
    if (t.skinTone) parts.push([t.skinTone, t.skinUndertone].filter(Boolean).join(' '));
    const face = formatFace(t);
    if (face) parts.push(face);
    const eyes = formatEyes(t);
    if (eyes) parts.push(eyes);
    if (t.eyebrows) parts.push(t.eyebrows);
    const hair = formatHair(t);
    if (hair) parts.push(hair);
    if (t.build) parts.push(t.build);
    if (t.distinctiveFeature) parts.push(t.distinctiveFeature);
    return head + (parts.length ? ' with ' + joinList(parts) : '');
}

// Compact signature for duplicate detection within a session.
function identitySignature(identity) {
    const t = flatTraits(identity);
    return [
        t.age,
        t.gender || t.presentation,
        t.skinTone,
        t.skinUndertone,
        t.faceShape,
        t.faceNose,
        t.faceLips,
        t.faceCheeks,
        t.faceJaw,
        t.eyeColor,
        t.eyeShape,
        t.eyebrows,
        t.hairColor,
        t.hairTexture,
        t.hairStyle,
        t.hairPart,
        t.hairFringe,
        t.build,
        t.distinctiveFeature
    ].map((value) => String(value || '').toLowerCase()).join('|');
}

function canonicalIdentity(value, legacy = {}) {
    const src = value && typeof value === 'object' ? value : {};
    const fallback = legacy && typeof legacy === 'object' ? legacy : {};
    const profile = normalizeProfile(src.profile || src.characterProfile || fallback.profile || fallback.characterProfile);
    const appearanceCategory = src.appearanceCategory || fallback.appearanceCategory || '';
    const age = src.age || fallback.age || '';
    const ageGroup = src.ageGroup || fallback.ageGroup || '';
    const gender = src.gender || src.presentation && (src.presentation === 'woman' || src.presentation === 'man' ? src.presentation : '') || fallback.gender || '';
    const hairSource = src.hair && typeof src.hair === 'object' ? src.hair : {};
    const faceSource = src.face && typeof src.face === 'object' ? src.face : {};
    const eyesSource = src.eyes && typeof src.eyes === 'object' ? src.eyes : {};
    const skinSource = src.skin && typeof src.skin === 'object' ? src.skin : {};
    const out = {
        seed: src.seed !== undefined ? src.seed : (src.characterSeed !== undefined ? src.characterSeed : fallback.seed),
        profile,
        appearanceCategory,
        appearanceCategoryLabel: src.appearanceCategoryLabel || fallback.appearanceCategoryLabel || appearanceCategoryLabel(appearanceCategory),
        age,
        ageGroup,
        gender,
        skin: {
            tone: skinSource.tone || src.skinTone || fallback.skinTone || '',
            group: skinSource.group || src.skinGroup || fallback.skinGroup || '',
            undertone: skinSource.undertone || src.skinUndertone || fallback.skinUndertone || ''
        },
        face: {
            shape: faceSource.shape || src.faceShape || fallback.faceShape || '',
            nose: faceSource.nose || src.faceNose || fallback.faceNose || '',
            lips: faceSource.lips || src.faceLips || fallback.faceLips || '',
            cheeks: faceSource.cheeks || src.faceCheeks || fallback.faceCheeks || '',
            jaw: faceSource.jaw || src.faceJaw || fallback.faceJaw || ''
        },
        eyes: Object.keys(eyesSource).length ? Object.assign({}, eyesSource) : {
            color: src.eyeColor || fallback.eyeColor || '',
            shape: src.eyeShape || fallback.eyeShape || ''
        },
        eyebrows: src.eyebrows || fallback.eyebrows || '',
        hair: {
            color: hairSource.color || src.hairColor || fallback.hairColor || '',
            texture: hairSource.texture || src.hairTexture || fallback.hairTexture || '',
            textureFamily: hairSource.textureFamily || src.hairTextureFamily || fallback.hairTextureFamily || '',
            style: hairSource.style || src.hairStyle || fallback.hairStyle || '',
            styleType: hairSource.styleType || src.hairStyleType || fallback.hairStyleType || 'adj',
            part: hairSource.part || src.hairPart || fallback.hairPart || '',
            fringe: hairSource.fringe || src.hairFringe || fallback.hairFringe || ''
        },
        build: src.build || fallback.build || '',
        distinctiveFeature: src.distinctiveFeature || fallback.distinctiveFeature || ''
    };
    const hasTraits = Boolean(out.seed || out.age || out.ageGroup || out.gender ||
        out.skin.tone || out.face.shape || out.face.nose || out.face.lips || out.face.cheeks || out.face.jaw ||
        out.eyes.color || out.eyes.shape || out.hair.color || out.hair.style || out.hair.part || out.hair.fringe ||
        out.build || out.distinctiveFeature);
    if (!hasTraits) return null;
    const legacyShape = Object.assign({}, src, {
        age: out.age,
        gender: out.gender,
        presentation: src.presentation,
        skinTone: out.skin.tone,
        skinGroup: out.skin.group,
        skinUndertone: out.skin.undertone,
        faceShape: out.face.shape,
        faceNose: out.face.nose,
        faceLips: out.face.lips,
        faceCheeks: out.face.cheeks,
        faceJaw: out.face.jaw,
        eyeColor: out.eyes.color,
        eyeShape: out.eyes.shape,
        eyebrows: out.eyebrows,
        hairColor: out.hair.color,
        hairTexture: out.hair.texture,
        hairTextureFamily: out.hair.textureFamily,
        hairStyle: out.hair.style,
        hairStyleType: out.hair.styleType,
        hairPart: out.hair.part,
        hairFringe: out.hair.fringe,
        build: out.build,
        distinctiveFeature: out.distinctiveFeature
    });
    out.identitySignature = src.identitySignature || src.signature || fallback.identitySignature || identitySignature(legacyShape);
    out.identityText = src.identityText || fallback.identityText || formatIdentity(legacyShape);
    return out;
}

function normalizeCharacter(value) {
    const src = value && typeof value === 'object' ? value : {};
    const identity = canonicalIdentity(src.identity, src);
    const now = new Date().toISOString();
    return {
        id: String(src.id || ''),
        schemaVersion: Number(src.schemaVersion) || CHARACTER_SCHEMA_VERSION,
        name: String(src.name || '').trim(),
        identity,
        identityText: String(src.identityText || (identity && identity.identityText) || src.identity || '').trim(),
        identitySignature: String(src.identitySignature || (identity && identity.identitySignature) || '').trim(),
        referenceImages: Array.isArray(src.referenceImages) ? src.referenceImages.slice() : [],
        portraitReference: src.portraitReference && typeof src.portraitReference === 'object' ? Object.assign({}, src.portraitReference) : null,
        wardrobePreference: {
            packId: String((src.wardrobePreference && src.wardrobePreference.packId) || src.outfitPack || '').trim(),
            customText: String((src.wardrobePreference && src.wardrobePreference.customText) || src.outfitPackCustom || '').trim()
        },
        visualPreferences: {
            preferredStyle: String((src.visualPreferences && src.visualPreferences.preferredStyle) || src.style || '').trim(),
            preferredAspectRatio: String((src.visualPreferences && src.visualPreferences.preferredAspectRatio) || src.aspectRatio || '').trim()
        },
        provenance: src.provenance && typeof src.provenance === 'object' ? Object.assign({}, src.provenance) : { type: identity ? 'generated' : 'legacy' },
        createdAt: src.createdAt || now,
        updatedAt: src.updatedAt || now,
        revision: Number(src.revision) > 0 ? Number(src.revision) : 1,
        warning: identity ? '' : 'This legacy character has display text but no structured identity data.'
    };
}

// --- Generation ---------------------------------------------------------------

function pickAppearanceCategory(appearance, rng) {
    if (APPEARANCE_CATEGORIES[appearance]) return appearance;
    return pickValue(APPEARANCE_ENTRIES, rng);
}

// Generate one structured identity. Pass a numeric seed for reproducibility or
// an RNG function (the concept engine's convention); pass a `profile`
// ({ appearance, age, gender }) to constrain the generation. With no profile
// (or all `random`) the generator draws from the full trait space, preserving
// the general random-character behaviour.
function generateRandomIdentity(input = Math.random, profile) {
    const { seed, rng } = resolveRng(input);
    const normalized = normalizeProfile(profile);

    const ageGroup = normalized.age === RANDOM
        ? pickValue(AGE_GROUP_ENTRIES, rng)
        : normalized.age;
    const age = pickValue(AGE_GROUPS[ageGroup].ages, rng);
    const gender = normalized.gender === RANDOM
        ? pickValue(GENDER_ENTRIES, rng)
        : normalized.gender;
    const presentation = GENDER_PRESENTATION[gender] || 'person';
    const appearanceKey = pickAppearanceCategory(normalized.appearance, rng);
    const category = APPEARANCE_CATEGORIES[appearanceKey];

    const skinToneEntry = pickWeighted(category.skinTones, rng);
    const skinTone = skinToneEntry.value;
    const skinGroup = skinToneEntry.group || '';
    const skinUndertone = pickValue(category.skinUndertones || SKIN_UNDERTONES, rng);
    const faceShape = pickValue(category.faceShapes, rng);
    const faceNose = pickValue(category.faceNoses || FACE_NOSES, rng);
    const faceLips = pickValue(category.faceLips || FACE_LIPS, rng);
    const faceCheeks = pickValue(category.faceCheeks || FACE_CHEEKS, rng);
    const faceJaw = pickValue(category.faceJaws || FACE_JAWS, rng);
    const eyeColor = pickValue(category.eyeColors, rng, { skinGroup });
    const eyeShape = pickValue(category.eyeShapes, rng);
    const eyebrows = pickValue(category.eyebrows, rng);
    const hairColor = pickValue(category.hairColors, rng, { ageGroup });
    const hairTextureFamily = pickValue(category.hairTextures, rng, { ageGroup, gender });
    const hairTexture = pickValue(
        HAIR_TEXTURE_VALUES[hairTextureFamily] || HAIR_TEXTURE_FAMILIES,
        rng
    );
    const hairStyleEntry = pickWeighted(category.hairStyles, rng, {
        ageGroup,
        gender,
        texture: hairTextureFamily
    });
    const hairPart = pickValue(category.hairParts || HAIR_PARTS, rng);
    const hairFringe = pickValue(category.hairFringes || HAIR_FRINGES, rng);
    const build = pickValue(category.builds, rng, { gender });
    const distinctiveFeature = pickValue(category.distinctiveFeatures, rng, { skinGroup, gender });
    const expression = pickValue(EXPRESSIONS, rng);
    const name = pickName(rng, gender);

    const identity = {
        seed,
        characterSeed: seed,
        characterProfile: normalized,
        appearanceCategory: appearanceKey,
        name,
        age,
        ageGroup,
        gender,
        presentation,
        skinTone,
        skinGroup,
        skinUndertone,
        faceShape,
        faceNose,
        faceLips,
        faceCheeks,
        faceJaw,
        eyeColor,
        eyeShape,
        eyebrows,
        hairColor,
        hairTexture,
        hairTextureFamily,
        hairStyle: hairStyleEntry.value,
        hairStyleType: hairStyleEntry.type || 'adj',
        hairPart,
        hairFringe,
        build,
        distinctiveFeature,
        expression
    };
    identity.signature = identitySignature(identity);
    identity.identityText = formatIdentity(identity);
    return identity;
}

// Reroll until the identity is not in `avoidSignatures` (bounded). A numeric
// seed advances by attempt so rerolls actually change the result.
function generateUniqueIdentity(input = Math.random, avoidSignatures = [], profile, maxAttempts) {
    if (typeof profile === 'number') {
        maxAttempts = profile;
        profile = undefined;
    }
    const attempts = Number(maxAttempts) > 0 ? Number(maxAttempts) : 8;
    const avoid = new Set((Array.isArray(avoidSignatures) ? avoidSignatures : []).map((value) => String(value || '')));
    const numericSeed = typeof input === 'function' ? null : ((Number(input) >>> 0) || 1);
    let identity = generateRandomIdentity(input, profile);
    for (let attempt = 0; attempt < attempts && avoid.has(identity.signature); attempt++) {
        identity = generateRandomIdentity(numericSeed === null ? input : numericSeed + attempt + 1, profile);
    }
    return identity;
}

// --- Targeted re-rolls --------------------------------------------------------
//
// A face re-roll redraws only the face-structure / eyes / brows / feature traits
// and a hair re-roll only the hair traits, so neither can disturb the other.
// Deterministic for a given rng; the appearance category, age and gender (and
// therefore the person's demographic constraints) are preserved.

function categoryForIdentity(identity) {
    const key = identity && identity.appearanceCategory;
    return (key && APPEARANCE_CATEGORIES[key]) || null;
}

function fallbackCategory() {
    return {
        faceShapes: FACE_SHAPES,
        faceNoses: FACE_NOSES,
        faceLips: FACE_LIPS,
        faceCheeks: FACE_CHEEKS,
        faceJaws: FACE_JAWS,
        eyeShapes: EYE_SHAPES,
        eyeColors: mergePool('eyeColors'),
        eyebrows: EYEBROWS,
        distinctiveFeatures: DISTINCTIVE_FEATURES,
        hairColors: mergePool('hairColors'),
        hairTextures: mergePool('hairTextures'),
        hairStyles: HAIR_STYLES,
        hairParts: HAIR_PARTS,
        hairFringes: HAIR_FRINGES
    };
}

function refreshIdentity(identity) {
    identity.signature = identitySignature(identity);
    identity.identityText = formatIdentity(identity);
    identity.appearance = formatAppearance(identity);
    identity.hair = formatHair(identity);
    return identity;
}

function resolveRerollRng(input) {
    return resolveRng(input === undefined || input === null ? Math.random : input).rng;
}

function rerollIdentityFace(identity, input) {
    if (!identity || typeof identity !== 'object') return identity;
    const rng = resolveRerollRng(input);
    const category = categoryForIdentity(identity) || fallbackCategory();
    const next = Object.assign({}, identity);
    const gender = next.gender || next.presentation || '';
    const skinGroup = next.skinGroup || '';
    next.faceShape = pickValue(category.faceShapes, rng);
    next.faceNose = pickValue(category.faceNoses, rng);
    next.faceLips = pickValue(category.faceLips, rng);
    next.faceCheeks = pickValue(category.faceCheeks, rng);
    next.faceJaw = pickValue(category.faceJaws, rng);
    next.eyeColor = pickValue(category.eyeColors, rng, { skinGroup });
    next.eyeShape = pickValue(category.eyeShapes, rng);
    next.eyebrows = pickValue(category.eyebrows, rng);
    next.distinctiveFeature = pickValue(category.distinctiveFeatures, rng, { skinGroup, gender });
    return refreshIdentity(next);
}

function rerollIdentityHair(identity, input) {
    if (!identity || typeof identity !== 'object') return identity;
    const rng = resolveRerollRng(input);
    const category = categoryForIdentity(identity) || fallbackCategory();
    const next = Object.assign({}, identity);
    const ageGroup = next.ageGroup || '';
    const gender = next.gender || next.presentation || '';
    next.hairColor = pickValue(category.hairColors, rng, { ageGroup });
    next.hairTextureFamily = pickValue(category.hairTextures, rng, { ageGroup, gender });
    next.hairTexture = pickValue(HAIR_TEXTURE_VALUES[next.hairTextureFamily] || HAIR_TEXTURE_FAMILIES, rng);
    const hairStyleEntry = pickWeighted(category.hairStyles, rng, {
        ageGroup,
        gender,
        texture: next.hairTextureFamily
    });
    next.hairStyle = hairStyleEntry.value;
    next.hairStyleType = hairStyleEntry.type || 'adj';
    next.hairPart = pickValue(category.hairParts, rng);
    next.hairFringe = pickValue(category.hairFringes, rng);
    return refreshIdentity(next);
}

// --- Merged catalog (introspection / tests) -----------------------------------

function mergePool(key) {
    const byValue = new Map();
    for (const categoryKey of APPEARANCE_KEYS) {
        for (const raw of toEntries(APPEARANCE_CATEGORIES[categoryKey][key] || [])) {
            const value = raw.value;
            if (!byValue.has(value)) {
                byValue.set(value, Object.assign({}, raw));
                continue;
            }
            const existing = byValue.get(value);
            existing.weight = Math.max(Number(existing.weight) || 1, Number(raw.weight) || 1);
            for (const tag of ['groups', 'skins', 'genders', 'textures', 'presentations']) {
                if (Array.isArray(raw[tag])) {
                    existing[tag] = Array.from(new Set((existing[tag] || []).concat(raw[tag])));
                }
            }
        }
    }
    return Array.from(byValue.values());
}

const CHARACTER_TRAITS = {
    ageGroups: AGE_GROUPS,
    ageGroupWeights: AGE_GROUP_ENTRIES,
    genders: GENDER_ENTRIES,
    appearanceCategories: APPEARANCE_CATEGORIES,
    appearanceKeys: APPEARANCE_KEYS,
    skinTones: mergePool('skinTones'),
    skinUndertones: mergePool('skinUndertones'),
    faceShapes: mergePool('faceShapes'),
    faceNoses: mergePool('faceNoses'),
    faceLips: mergePool('faceLips'),
    faceCheeks: mergePool('faceCheeks'),
    faceJaws: mergePool('faceJaws'),
    eyeShapes: mergePool('eyeShapes'),
    eyeColors: mergePool('eyeColors'),
    eyebrows: mergePool('eyebrows'),
    hairColors: mergePool('hairColors'),
    hairTextures: mergePool('hairTextures'),
    hairStyles: mergePool('hairStyles'),
    hairParts: mergePool('hairParts'),
    hairFringes: mergePool('hairFringes'),
    builds: mergePool('builds'),
    distinctiveFeatures: mergePool('distinctiveFeatures'),
    expressions: EXPRESSIONS,
    names: NAMES
};

module.exports = {
    CHARACTER_SCHEMA_VERSION,
    RANDOM,
    AGE_KEYS,
    GENDER_KEYS,
    AGE_GROUPS,
    GENDER_PRESENTATION,
    APPEARANCE_KEYS,
    APPEARANCE_CATEGORIES,
    CHARACTER_TRAITS,
    createRng,
    normalizeProfile,
    isRandomProfile,
    sameProfile,
    appearanceCategoryLabel,
    listProfileOptions,
    generateRandomIdentity,
    generateUniqueIdentity,
    rerollIdentityFace,
    rerollIdentityHair,
    formatIdentity,
    formatAppearance,
    formatFace,
    formatHair,
    formatEyes,
    identitySignature
    ,canonicalIdentity
    ,normalizeCharacter
};
