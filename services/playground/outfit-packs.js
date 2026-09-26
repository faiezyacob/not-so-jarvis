/* ============================================
   JARVIS — Creative Playground Outfit Packs
   Outfit Packs describe a character's wardrobe
   personality as a structured wardrobe space, not a
   fixed prompt. A pack is a first-class, replaceable
   character attribute: selecting one composes a
   specific, coherent outfit from that pack's pieces
   while leaving face / hair / body / skin / identity
   untouched. Composition reuses the theme outfit
   engine (`themes.composeOutfit`) so the combination
   space is large and every look is deterministic for
   a given seed. No LLM, no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const themes = require('./themes');

// The synthetic id for a user-defined outfit. The composed-outfit fields stay
// empty and `outfitPackCustom` carries the exact clothing the user asked for.
const CUSTOM_PACK_ID = 'custom';
const CUSTOM_PACK_LABEL = 'Custom';

// Default silhouette mix shared by packs that don't declare their own. Weights
// bias toward separates (the everyday default), with one-piece looks common and
// outerwear an optional layer rather than the norm.
const DEFAULT_ARCHETYPES = [
    { id: 'separates', requires: ['tops', 'bottoms'], weight: 5 },
    { id: 'one-piece', requires: ['onePieces'], weight: 2 },
    { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 1.5 }
];

function piece(value, weight, extra) {
    return Object.assign({ value, weight: weight || 1 }, extra || {});
}

// --- Pack catalog -------------------------------------------------------------
//
// `wardrobe` describes the space the composer draws from. `palette` and `rules`
// are declared metadata (surfaced by the API/UI and used to keep compositions
// on-personality). `archetypes` is an optional silhouette mix; it defaults to
// DEFAULT_ARCHETYPES when omitted.

const OUTFIT_PACKS = [
    {
        id: 'casual-everyday',
        label: 'Casual Everyday',
        description: 'Relaxed, practical everyday clothing.',
        personality: 'Simple silhouettes, versatile pieces and practical styling.',
        wardrobe: {
            tops: [
                piece('a basic white T-shirt', 3),
                piece('a fitted grey T-shirt', 3),
                piece('a relaxed navy T-shirt', 2.5),
                piece('a plain black T-shirt', 2.5),
                piece('a light blue cotton T-shirt', 2.5),
                piece('a simple white tank top', 2),
                piece('a beige cotton T-shirt', 2),
                piece('an olive green T-shirt', 2),
                piece('a burgundy relaxed tee', 1.5),
                piece('a soft white henley top', 1.5),
                piece('a striped cotton tee', 1.5),
                piece('a short-sleeve chambray shirt', 1.5),
                piece('a fitted grey ribbed tank', 1.5),
                piece('a relaxed oatmeal henley', 1.5),
                piece('a cotton long-sleeve crewneck', 1.5),
                piece('a casual sage-green polo shirt', 1.2),
                piece('a lightweight striped rugby shirt', 1)
            ],
            bottoms: [
                piece('classic blue jeans', 3),
                piece('straight-leg blue jeans', 3),
                piece('dark navy jeans', 2.5),
                piece('black jeans', 2),
                piece('denim shorts', 2),
                piece('beige cotton shorts', 2),
                piece('casual grey shorts', 1.5),
                piece('khaki chino shorts', 2),
                piece('olive relaxed joggers', 1.5),
                piece('a light-wash denim skirt', 1.5),
                piece('grey pull-on shorts', 1.5),
                piece('straight-leg khaki trousers', 1.5),
                piece('a casual black midi skirt', 1.2),
                piece('dark denim shorts', 1.2),
                piece('relaxed corduroy trousers', 1)
            ],
            dresses: [
                piece('a simple cotton day dress', 2),
                piece('a relaxed T-shirt dress', 2),
                piece('a casual navy dress', 1.5),
                piece('a denim shirt dress', 1.5),
                piece('a striped jersey dress', 1.5),
                piece('a relaxed linen-blend shirt dress', 1.2),
                piece('a soft ribbed midi dress', 1.2)
            ],
            layers: [
                piece('a lightweight beige overshirt', 2),
                piece('a simple white overshirt', 1.5),
                piece('a grey zip-up jacket', 1),
                piece('an open plaid flannel shirt', 1.5),
                piece('a cropped light denim jacket', 1.5),
                piece('a quilted olive vest', 1),
                piece('a relaxed navy cardigan', 1.2)
            ],
            footwear: [
                piece('clean white sneakers', 3),
                piece('simple sneakers', 3),
                piece('canvas sneakers', 2),
                piece('casual sandals', 2),
                piece('grey slip-on sneakers', 1.5),
                piece('brown leather sandals', 1.5),
                piece('simple flats', 1.5),
                piece('retro running sneakers', 1.2),
                piece('brown casual ankle boots', 1)
            ],
            accessories: [
                piece('a small beige crossbody bag', 2),
                piece('a canvas tote', 2),
                piece('a simple baseball cap', 1.5),
                piece('sunglasses', 1.5),
                piece('a woven belt', 1.5),
                piece('a simple wristwatch', 1),
                piece('a patterned cotton scarf', 1),
                piece('small hoop earrings', 1)
            ]
        },
        palette: ['white', 'grey', 'navy', 'black', 'light blue', 'beige'],
        rules: [
            'simple silhouettes',
            'practical everyday styling',
            'versatile pieces',
            'avoid formal tailoring',
            'avoid excessive accessories'
        ]
    },
    {
        id: 'lounge-home',
        label: 'Lounge & Home',
        description: 'Comfortable, relaxed private/home clothing.',
        personality: 'Soft fabrics, relaxed shapes and minimal styling.',
        wardrobe: {
            tops: [
                piece('an oversized cream T-shirt', 3),
                piece('a soft grey camisole', 2.5),
                piece('a relaxed muted-pink T-shirt', 2.5),
                piece('a loose soft-blue lounge top', 2),
                piece('a soft charcoal sweatshirt', 2),
                piece('a lightweight knit lounge top', 2),
                piece('a loose white ribbed tank', 2),
                piece('a soft mauve lounge tank', 1.5),
                piece('an oversized button-down sleep shirt', 1.5),
                piece('a waffle-knit long-sleeve top', 1.5),
                piece('a soft modal wrap top', 1.2),
                piece('a relaxed thermal henley', 1)
            ],
            bottoms: [
                piece('soft grey sweatpants', 3),
                piece('relaxed charcoal leggings', 2.5),
                piece('loose beige lounge shorts', 2.5),
                piece('soft cream joggers', 2),
                piece('comfy knit lounge pants', 2),
                piece('soft cotton sleep shorts', 2),
                piece('muted-pink lounge leggings', 1.5),
                piece('wide-leg jersey lounge pants', 1.5),
                piece('a soft ribbed lounge skirt', 1),
                piece('a relaxed cotton pajama bottom', 1.2)
            ],
            dresses: [
                piece('a soft lounge slip dress', 2),
                piece('a relaxed cotton night dress', 1.5),
                piece('a soft jersey nightgown', 1.5),
                piece('a modal short-sleeve sleep dress', 1.2),
                piece('a loose waffle-knit lounge dress', 1)
            ],
            layers: [
                piece('a loose muted-pink cardigan', 2),
                piece('an oversized cream cardigan', 2),
                piece('a soft grey hoodie', 1.5),
                piece('a fleecy cream robe', 1.5),
                piece('a soft zip-front fleece', 1.2),
                piece('a long brushed-knit cardigan', 1)
            ],
            footwear: [
                piece('simple slippers', 3),
                piece('soft socks', 2.5),
                piece('cosy house shoes', 2),
                piece('quilted slippers', 1.5),
                piece('fuzzy slide slippers', 1)
            ],
            accessories: [
                piece('a simple scrunchie', 2),
                piece('a soft hair tie', 1.5),
                piece('a cozy knit headband', 1),
                piece('a satin sleep mask', 1),
                piece('a soft blanket scarf', 0.8)
            ]
        },
        palette: ['cream', 'grey', 'muted beige', 'soft blue', 'muted pink', 'charcoal'],
        rules: [
            'prioritize comfort',
            'relaxed silhouettes',
            'soft fabrics',
            'minimal accessories',
            'avoid formal clothing',
            'avoid elaborate styling'
        ]
    },
    {
        id: 'soft-feminine-casual',
        label: 'Soft Feminine Casual',
        description: 'Feminine, gentle, approachable everyday styling.',
        personality: 'Soft silhouettes, coordinated pieces and understated detail.',
        wardrobe: {
            tops: [
                piece('a fitted cream top', 2.5),
                piece('a soft blush blouse', 2.5),
                piece('a light blue fitted top', 2),
                piece('a white knit top', 2),
                piece('a simple pastel-green blouse', 1.5),
                piece('a pale-pink wrap blouse', 1.5),
                piece('a delicate white eyelet top', 1.5),
                piece('a soft lavender fitted tee', 1.5),
                piece('a puff-sleeve cotton blouse', 1.2),
                piece('a soft ribbed cardigan top', 1.2),
                piece('a floral tie-front blouse', 1)
            ],
            bottoms: [
                piece('a simple cream midi skirt', 2.5),
                piece('a soft pink pleated skirt', 2),
                piece('light blue jeans', 2),
                piece('beige tailored shorts', 1.5),
                piece('a white flowy midi skirt', 2),
                piece('pale-blue wide-leg trousers', 1.5),
                piece('a blush satin skirt', 1.5),
                piece('a cream wide-leg trouser', 1.2),
                piece('a floral pleated midi skirt', 1.2),
                piece('a soft pink cropped trouser', 1)
            ],
            dresses: [
                piece('a soft blush casual dress', 3),
                piece('a cream floral day dress', 2.5),
                piece('a light blue sundress', 2),
                piece('a simple white summer dress', 2),
                piece('a pastel wrap dress', 1.5),
                piece('a light pink tiered midi dress', 1.5),
                piece('a blue floral tea dress', 1.2),
                piece('a soft sage smocked dress', 1)
            ],
            layers: [
                piece('a cream cardigan', 2.5),
                piece('a soft blush cardigan', 2),
                piece('a light knit cardigan', 1.5),
                piece('a pale-pink bolero', 1),
                piece('a cropped boucle jacket', 1),
                piece('a lightweight floral kimono', 1)
            ],
            footwear: [
                piece('simple ballet flats', 3),
                piece('beige sandals', 2.5),
                piece('white flats', 2),
                piece('blush low heels', 1.5),
                piece('cream Mary Jane shoes', 1.2),
                piece('delicate ankle-strap sandals', 1)
            ],
            accessories: [
                piece('a delicate necklace', 2),
                piece('small stud earrings', 1.5),
                piece('a small cream shoulder bag', 2),
                piece('a thin pearl bracelet', 1.5),
                piece('a light silk hair ribbon', 1.5),
                piece('a small floral hair clip', 1),
                piece('a slim pendant necklace', 1.2)
            ]
        },
        palette: ['cream', 'blush', 'soft pink', 'light blue', 'beige', 'white', 'muted green'],
        rules: [
            'feminine without becoming overly formal',
            'soft silhouettes',
            'simple coordinated pieces',
            'understated accessories',
            'avoid excessive ornamentation'
        ]
    },
    {
        id: 'casual-streetwear',
        label: 'Casual Streetwear',
        description: 'Urban, relaxed and practical.',
        personality: 'Relaxed proportions, practical layers and contemporary shapes.',
        wardrobe: {
            tops: [
                piece('an oversized white T-shirt', 3),
                piece('a graphic black tee', 2.5),
                piece('a relaxed charcoal hoodie', 2.5),
                piece('an oversized grey T-shirt', 2),
                piece('a black hoodie', 2),
                piece('a cropped black hoodie', 1.5, { genders: ['woman'] }),
                piece('a boxy olive tee', 1.5),
                piece('a mesh-layer black top', 1.5),
                piece('an oversized striped long-sleeve tee', 1.5),
                piece('a boxy cropped sweatshirt', 1.5),
                piece('a heavyweight long-sleeve tee', 1.2),
                piece('a sleeveless utility vest top', 1)
            ],
            bottoms: [
                piece('black cargo pants', 3),
                piece('olive cargo pants', 2.5),
                piece('relaxed dark jeans', 2.5),
                piece('baggy grey jeans', 2),
                piece('charcoal joggers', 1.5),
                piece('grey cargo shorts', 1.5),
                piece('wide-leg black jeans', 1.5),
                piece('stone cargo trousers', 1.5),
                piece('relaxed carpenter jeans', 1.2),
                piece('nylon track pants', 1)
            ],
            dresses: [
                piece('a relaxed black T-shirt dress', 1.5),
                piece('a loose grey street dress', 1)
            ],
            layers: [
                piece('a utility jacket', 2.5),
                piece('an olive bomber jacket', 2),
                piece('a black zip-up hoodie', 2),
                piece('a denim jacket', 1.5),
                piece('a black workwear overshirt', 1.5),
                piece('a cropped puffer vest', 1),
                piece('a heavyweight varsity jacket', 1)
            ],
            footwear: [
                piece('chunky white sneakers', 3),
                piece('black sneakers', 2.5),
                piece('high-top sneakers', 2),
                piece('chunky skate shoes', 1.5),
                piece('black-and-white retro sneakers', 1.5),
                piece('utility hiking sneakers', 1)
            ],
            accessories: [
                piece('a black crossbody bag', 2),
                piece('a baseball cap', 1.5),
                piece('a beanie', 1.5),
                piece('a chunky chain necklace', 1.5),
                piece('a black bucket hat', 1.5),
                piece('a canvas belt bag', 1.5),
                piece('layered silver chains', 1.2),
                piece('a pair of tinted sunglasses', 1)
            ]
        },
        palette: ['black', 'charcoal', 'olive', 'grey', 'white', 'muted earth tones'],
        rules: [
            'relaxed proportions',
            'layered styling',
            'practical streetwear',
            'contemporary silhouettes',
            'avoid formal pieces',
            'avoid overly elegant styling'
        ]
    },
    {
        id: 'vacation-summer',
        label: 'Vacation & Summer',
        description: 'Light, breezy and warm-weather oriented.',
        personality: 'Lightweight fabrics, breathable shapes and relaxed proportions.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 4 },
            { id: 'one-piece', requires: ['onePieces'], weight: 3 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 0.8 }
        ],
        wardrobe: {
            tops: [
                piece('a white sleeveless tank top', 3),
                piece('a cream linen shirt', 2.5),
                piece('a breezy pale-blue button-up', 2.5),
                piece('a sage cotton tank', 2),
                piece('a loose white linen shirt', 2),
                piece('a white crochet crop top', 1.5, { genders: ['woman'] }),
                piece('a coral sleeveless blouse', 1.5),
                piece('a striped breathable tee', 1.5),
                piece('a pale-yellow halter top', 1.5, { genders: ['woman'] }),
                piece('a breezy embroidered blouse', 1.2),
                piece('a lightweight crochet tank', 1.2),
                piece('a terracotta linen vest', 1)
            ],
            bottoms: [
                piece('linen shorts', 3),
                piece('beige cotton shorts', 2.5),
                piece('white linen trousers', 2.5),
                piece('a lightweight sage skirt', 2),
                piece('cream wide-leg linen pants', 2),
                piece('a palm-print wrap skirt', 1.5),
                piece('terracotta swim trunks', 1.5, { genders: ['man'] }),
                piece('a floral swim skirt', 1.5, { genders: ['woman'] }),
                piece('sand-colored drawstring shorts', 1.5),
                piece('a lightweight printed sarong skirt', 1.2),
                piece('a relaxed cotton wrap trouser', 1),
                piece('a blue board short', 1.2)
            ],
            dresses: [
                piece('a white breezy sundress', 3),
                piece('a pale-blue linen dress', 2.5),
                piece('a cream light summer dress', 2.5),
                piece('a tropical-print wrap dress', 1.5),
                piece('a gauzy coral midi dress', 1.5),
                piece('a breezy white maxi dress', 1.5),
                piece('a printed cotton halter dress', 1, { genders: ['woman'] })
            ],
            layers: [
                piece('a light linen overshirt', 1.5),
                piece('a thin white cardigan', 1),
                piece('a white crochet cover-up', 1.5, { genders: ['woman'] }),
                piece('a lightweight cotton beach shirt', 1.5),
                piece('a gauzy striped kimono', 1)
            ],
            footwear: [
                piece('simple sandals', 3),
                piece('leather sandals', 2.5),
                piece('white canvas slip-ons', 2),
                piece('espadrilles', 1.5),
                piece('woven slide sandals', 1.5),
                piece('water-friendly sandals', 1)
            ],
            accessories: [
                piece('a canvas tote', 2.5),
                piece('a straw hat', 2),
                piece('sunglasses', 2),
                piece('a shell necklace', 1),
                piece('a woven sun hat', 1.5),
                piece('a raffia shoulder bag', 1.5),
                piece('a colorful woven bracelet', 1),
                piece('a printed headscarf', 1)
            ]
        },
        palette: ['white', 'cream', 'sand', 'pale blue', 'sage', 'warm neutrals'],
        rules: [
            'lightweight fabrics',
            'breathable silhouettes',
            'warm-weather styling',
            'relaxed proportions',
            'avoid heavy layers',
            'avoid winter clothing'
        ]
    },
    {
        id: 'gym-activewear',
        label: 'Gym & Activewear',
        description: 'Functional athletic clothing.',
        personality: 'Performance construction, fitted shapes and practical footwear.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 6 },
            { id: 'one-piece', requires: ['onePieces'], weight: 1 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 1.2 }
        ],
        wardrobe: {
            tops: [
                piece('a fitted black athletic top', 3),
                piece('a grey sports tank', 2.5),
                piece('a navy performance T-shirt', 2.5),
                piece('a white training top', 2),
                piece('a black sports bra', 1.5, { genders: ['woman'] }),
                piece('a teal racerback tank', 1.5, { genders: ['woman'] }),
                piece('a light-grey dri-fit long-sleeve', 1.5),
                piece('a slate sleeveless running top', 1.5),
                piece('a fitted compression shirt', 1.5),
                piece('a cropped training tank', 1, { genders: ['woman'] }),
                piece('a lightweight performance quarter-zip', 1.2)
            ],
            bottoms: [
                piece('black high-waisted leggings', 3),
                piece('navy leggings', 2),
                piece('grey athletic shorts', 2.5),
                piece('black biker shorts', 2.5),
                piece('navy running shorts', 2),
                piece('grey compression leggings', 1.5),
                piece('black performance joggers', 1.5),
                piece('navy compression shorts', 1.5),
                piece('grey training tights', 1.2),
                piece('black split running shorts', 1)
            ],
            dresses: [
                piece('a fitted athletic set', 1.5),
                piece('a one-piece training jumpsuit', 1)
            ],
            layers: [
                piece('a lightweight grey athletic jacket', 2),
                piece('a black zip training jacket', 1.5),
                piece('a reflective running vest', 1),
                piece('a lightweight track jacket', 1.5),
                piece('a fitted performance hoodie', 1.2)
            ],
            footwear: [
                piece('white running shoes', 3),
                piece('grey trainers', 2.5),
                piece('black training sneakers', 2),
                piece('lightweight running shoes', 2),
                piece('cross-training shoes', 1.5)
            ],
            accessories: [
                piece('a fitness watch', 1.5),
                piece('a gym duffel bag', 1),
                piece('a sweat-wicking headband', 1),
                piece('a running cap', 1),
                piece('a pair of sport sunglasses', 0.8)
            ]
        },
        palette: ['black', 'grey', 'white', 'navy', 'muted athletic colors'],
        rules: [
            'functional athletic construction',
            'fitted or performance-oriented silhouettes',
            'practical footwear',
            'avoid unnecessary accessories',
            'avoid formal clothing'
        ]
    },
    {
        id: 'casual-smart',
        label: 'Casual Smart',
        description: 'Polished but still relaxed.',
        personality: 'Clean shapes, coordinated colours and a polished finish.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 4.5 },
            { id: 'one-piece', requires: ['onePieces'], weight: 1.5 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 2.5 }
        ],
        wardrobe: {
            tops: [
                piece('a simple navy polo', 2.5),
                piece('a crisp white button-up shirt', 2.5),
                piece('a cream knit top', 2),
                piece('a fitted beige blouse', 2),
                piece('a muted-blue button-up', 2),
                piece('a slim light-grey merino top', 1.5),
                piece('a white short-sleeve popover shirt', 1.5),
                piece('a fine-gauge knit polo', 1.5),
                piece('a striped oxford shirt', 1.2),
                piece('a soft drape-neck blouse', 1)
            ],
            bottoms: [
                piece('beige chinos', 3),
                piece('navy chinos', 2.5),
                piece('simple charcoal trousers', 2.5),
                piece('brown tailored trousers', 1.5),
                piece('straight-leg navy trousers', 2),
                piece('a cream A-line skirt', 1.5),
                piece('grey tailored shorts', 1.5),
                piece('stone pleated trousers', 1.5),
                piece('a navy pleated midi skirt', 1.2),
                piece('straight-leg dark chinos', 1.5)
            ],
            dresses: [
                piece('a simple cream shirt dress', 2),
                piece('a tailored navy dress', 1.5)
            ],
            layers: [
                piece('a beige blazer', 2),
                piece('a navy knit cardigan', 1.5),
                piece('a structured blazer', 1),
                piece('a lightweight trench coat', 1.2),
                piece('a fine-gauge sweater vest', 1.2)
            ],
            footwear: [
                piece('clean white minimalist sneakers', 2.5),
                piece('brown loafers', 2.5),
                piece('simple leather loafers', 2),
                piece('black suede slip-ons', 1.5),
                piece('brown leather derbies', 1.2),
                piece('low-profile leather sneakers', 1.5)
            ],
            accessories: [
                piece('a leather watch', 2),
                piece('a small structured bag', 1.5),
                piece('a slim leather belt', 1.5),
                piece('a silk neck scarf', 1),
                piece('small geometric earrings', 1)
            ]
        },
        palette: ['navy', 'white', 'cream', 'beige', 'charcoal', 'brown', 'muted blue'],
        rules: [
            'clean silhouettes',
            'coordinated colors',
            'polished appearance',
            'understated accessories',
            'avoid full formalwear',
            'avoid excessive streetwear elements'
        ]
    },
    {
        id: 'casual-night-out',
        label: 'Casual Night Out',
        description: 'Stylish, social and slightly more refined than everyday wear.',
        personality: 'Slightly more fitted shapes and evening-appropriate styling.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 3.5 },
            { id: 'one-piece', requires: ['onePieces'], weight: 3 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 2 }
        ],
        wardrobe: {
            tops: [
                piece('a fitted black top', 3),
                piece('a deep-navy fitted top', 2.5),
                piece('a cream satin camisole', 2),
                piece('a burgundy fitted blouse', 1.5),
                piece('a black off-shoulder top', 1.5, { genders: ['woman'] }),
                piece('a draped charcoal satin blouse', 1.5),
                piece('a lace-detail emerald top', 1.5, { genders: ['woman'] }),
                piece('a fitted ribbed mock-neck top', 1.5),
                piece('a deep-plum wrap blouse', 1.2),
                piece('a black halter top', 1, { genders: ['woman'] })
            ],
            bottoms: [
                piece('dark denim jeans', 3),
                piece('black fitted trousers', 2.5),
                piece('a simple black skirt', 2),
                piece('charcoal tailored trousers', 2),
                piece('a black satin mini skirt', 1.5, { genders: ['woman'] }),
                piece('a charcoal leather-look pencil skirt', 1.5, { genders: ['woman'] }),
                piece('dark straight-leg trousers', 1.5),
                piece('a satin wide-leg trouser', 1.2),
                piece('a dark denim midi skirt', 1)
            ],
            dresses: [
                piece('a simple black dress', 3),
                piece('a deep-navy cocktail dress', 2),
                piece('a burgundy midi dress', 1.5),
                piece('a fitted bodycon dress', 1.5, { genders: ['woman'] }),
                piece('a draped satin midi dress', 1.5, { genders: ['woman'] })
            ],
            layers: [
                piece('a lightweight black jacket', 2),
                piece('a fitted leather jacket', 1.5),
                piece('a deep-navy blazer', 1.5),
                piece('a cropped satin bomber jacket', 1),
                piece('a longline tailored coat', 1)
            ],
            footwear: [
                piece('ankle boots', 2.5),
                piece('minimalist heels', 2),
                piece('black heeled boots', 1.5),
                piece('strappy black heels', 1.5),
                piece('pointed-toe slingback heels', 1.2),
                piece('sleek black loafers', 1.2)
            ],
            accessories: [
                piece('understated gold jewellery', 2),
                piece('a small black clutch', 1.5),
                piece('delicate earrings', 1.5),
                piece('a slim metallic belt', 1),
                piece('a small shoulder bag', 1.2)
            ]
        },
        palette: ['black', 'charcoal', 'dark denim', 'cream', 'burgundy', 'deep navy', 'muted metallic accents'],
        rules: [
            'slightly more fitted silhouettes',
            'evening-appropriate styling',
            'understated accessories',
            'polished but not formal',
            'avoid excessive glamour unless requested'
        ]
    },
    {
        id: 'minimalist-neutral',
        label: 'Minimalist & Neutral',
        description: 'Clean, restrained and timeless.',
        personality: 'Minimal noise, clean shapes and a restrained palette.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 4.5 },
            { id: 'one-piece', requires: ['onePieces'], weight: 2 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 2 }
        ],
        wardrobe: {
            tops: [
                piece('a plain white T-shirt', 3),
                piece('a black monochrome top', 2.5),
                piece('a cream knit top', 2.5),
                piece('a beige relaxed shirt', 2),
                piece('a simple grey top', 2),
                piece('a stone-colored mock-neck top', 1.5),
                piece('a white sleeveless turtleneck', 1.5),
                piece('a taupe fine-knit polo', 1.2),
                piece('a black ribbed long-sleeve top', 1.5),
                piece('a crisp ivory poplin shirt', 1.2)
            ],
            bottoms: [
                piece('black straight-leg trousers', 3),
                piece('cream tailored trousers', 2.5),
                piece('taupe wide-leg pants', 2),
                piece('grey relaxed trousers', 2),
                piece('beige straight-leg pants', 2),
                piece('a charcoal column skirt', 1.5),
                piece('black pleated wide-leg trousers', 1.5),
                piece('a taupe midi skirt', 1.2),
                piece('cream straight-leg jeans', 1.2)
            ],
            dresses: [
                piece('a simple black slip dress', 2),
                piece('a cream minimal dress', 2),
                piece('a beige shirt dress', 1.5),
                piece('a black column midi dress', 1.2),
                piece('a soft grey knit dress', 1.2)
            ],
            layers: [
                piece('a structured black blazer', 2),
                piece('a cream knit cardigan', 2),
                piece('a grey wool coat', 1.5),
                piece('a camel tailored coat', 1.5),
                piece('a clean-lined overshirt jacket', 1.2)
            ],
            footwear: [
                piece('minimalist white sneakers', 3),
                piece('simple black flats', 2.5),
                piece('clean black boots', 2),
                piece('taupe leather loafers', 1.5),
                piece('minimalist leather sandals', 1)
            ],
            accessories: [
                piece('a simple leather belt', 2),
                piece('an understated tote', 1.5),
                piece('a slim silver watch', 1.2),
                piece('a structured leather crossbody bag', 1),
                piece('small matte hoop earrings', 1)
            ]
        },
        palette: ['black', 'white', 'cream', 'beige', 'taupe', 'grey', 'charcoal'],
        rules: [
            'minimal visual noise',
            'clean silhouettes',
            'restrained palette',
            'simple layering',
            'no loud graphics',
            'avoid excessive accessories',
            'avoid visually complicated outfits'
        ]
    },
    {
        id: 'edgy-alternative',
        label: 'Edgy & Alternative',
        description: 'Dark, expressive and slightly rebellious.',
        personality: 'Darker palette, stronger shapes and controlled hardware.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 4 },
            { id: 'one-piece', requires: ['onePieces'], weight: 1.5 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 3 }
        ],
        wardrobe: {
            tops: [
                piece('a fitted black graphic tee', 3),
                piece('a black fitted top', 2.5),
                piece('a dark washed-grey top', 2),
                piece('a deep-burgundy fitted top', 1.5),
                piece('a black fishnet-layer top', 1.5),
                piece('a charcoal distressed tee', 1.5),
                piece('a black mesh long-sleeve top', 1.2),
                piece('a faded band tee', 1.5),
                piece('a dark red sleeveless top', 1)
            ],
            bottoms: [
                piece('black skinny jeans', 3),
                piece('washed black denim', 2.5),
                piece('black cargo trousers', 2.5),
                piece('dark olive cargo pants', 2),
                piece('a black leather skirt', 1.5),
                piece('a black pleated micro skirt', 1.5, { genders: ['woman'] }),
                piece('distressed black jeans', 1.5),
                piece('black coated denim trousers', 1.5),
                piece('a charcoal cargo skirt', 1, { genders: ['woman'] }),
                piece('dark grey carpenter pants', 1.2)
            ],
            dresses: [
                piece('a black leather dress', 1.5),
                piece('a dark charcoal dress', 1.5),
                piece('a black mesh-overlay dress', 1.5, { genders: ['woman'] })
            ],
            layers: [
                piece('a black leather jacket', 3),
                piece('a faux-leather jacket', 2),
                piece('a dark washed denim jacket', 1.5),
                piece('a black oversized blazer', 1.2),
                piece('a distressed military jacket', 1),
                piece('a cropped biker jacket', 1.5)
            ],
            footwear: [
                piece('black combat boots', 3),
                piece('chunky black sneakers', 2.5),
                piece('black platform boots', 2),
                piece('lace-up creeper shoes', 1),
                piece('black western ankle boots', 1.2)
            ],
            accessories: [
                piece('a studded belt', 2),
                piece('silver metal jewellery', 2),
                piece('a black choker', 1.5),
                piece('a chain-strap shoulder bag', 1.5),
                piece('a silver signet ring', 1),
                piece('a black hardware belt', 1.2),
                piece('a dark beanie', 1)
            ]
        },
        palette: ['black', 'charcoal', 'dark grey', 'deep burgundy', 'dark olive', 'washed denim', 'muted metallic accents'],
        rules: [
            'darker palette',
            'stronger silhouettes',
            'controlled use of hardware',
            'expressive but wearable',
            'avoid turning every outfit into a costume',
            'avoid excessive accessories'
        ]
    },
    {
        id: 'glam-boudoir',
        label: 'Glam & Boudoir',
        description: 'Seductive, sultry and after-dark styling.',
        personality: 'Fitted silhouettes, satin and lace textures, confident evening glamour.',
        archetypes: [
            { id: 'separates', requires: ['tops', 'bottoms'], weight: 3 },
            { id: 'one-piece', requires: ['onePieces'], weight: 4 },
            { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 1 }
        ],
        wardrobe: {
            tops: [
                piece('a black lace-trim camisole', 3, { genders: ['woman'] }),
                piece('a deep-red satin camisole', 2.5, { genders: ['woman'] }),
                piece('a black satin corset-style top', 2, { genders: ['woman'] }),
                piece('a champagne silk camisole', 2, { genders: ['woman'] }),
                piece('a fitted velvet bustier top', 2, { genders: ['woman'] }),
                piece('a sheer black lace top', 1.5, { genders: ['woman'] }),
                piece('a black off-shoulder bodysuit', 1.5, { genders: ['woman'] }),
                piece('a burgundy velvet wrap top', 1.5, { genders: ['woman'] }),
                piece('a black silk halter top', 1.2, { genders: ['woman'] }),
                piece('a fitted black satin shirt', 1)
            ],
            bottoms: [
                piece('a black satin skirt with a high thigh slit', 2.5, { genders: ['woman'] }),
                piece('a fitted black leather-look mini skirt', 2, { genders: ['woman'] }),
                piece('black lace-trim sleep shorts', 2, { genders: ['woman'] }),
                piece('a deep-burgundy satin slip skirt', 1.5, { genders: ['woman'] }),
                piece('high-waisted black cigarette trousers', 1.5),
                piece('sheer black hosiery', 1.5, { genders: ['woman'] }),
                piece('a burgundy velvet pencil skirt', 1.2, { genders: ['woman'] }),
                piece('black tailored wide-leg trousers', 1.2),
                piece('a satin split-front skirt', 1, { genders: ['woman'] })
            ],
            dresses: [
                piece('a black satin slip dress with a thigh slit', 3, { genders: ['woman'] }),
                piece('a deep-red fitted bodycon dress', 2.5, { genders: ['woman'] }),
                piece('a little black dress with a plunging neckline', 2.5, { genders: ['woman'] }),
                piece('a black lace midi dress', 2, { genders: ['woman'] }),
                piece('a champagne silk slip dress', 1.5, { genders: ['woman'] }),
                piece('a backless emerald satin dress', 1.5, { genders: ['woman'] }),
                piece('a black velvet midi dress', 1.5, { genders: ['woman'] }),
                piece('a deep-burgundy cowl-neck dress', 1.2, { genders: ['woman'] })
            ],
            layers: [
                piece('a black silk robe', 2, { genders: ['woman'] }),
                piece('a sheer black lace kimono', 1.5, { genders: ['woman'] }),
                piece('a cropped black leather jacket', 1.5),
                piece('a velvet evening blazer', 1, { genders: ['woman'] }),
                piece('a long satin robe', 1, { genders: ['woman'] })
            ],
            footwear: [
                piece('black stiletto heels', 3),
                piece('strappy black heels', 2.5),
                piece('black ankle-strap heels', 2),
                piece('black over-the-knee boots', 1.5),
                piece('pointed-toe black pumps', 1.5),
                piece('velvet platform sandals', 1, { genders: ['woman'] })
            ],
            accessories: [
                piece('a delicate lace choker', 2),
                piece('understated gold jewellery', 1.5),
                piece('a small satin clutch', 1.5),
                piece('a deep-red satin eye mask', 1, { genders: ['woman'] }),
                piece('a delicate layered pendant', 1.2),
                piece('a velvet hair ribbon', 1, { genders: ['woman'] }),
                piece('a slim crystal bracelet', 1, { genders: ['woman'] })
            ]
        },
        palette: ['black', 'deep red', 'burgundy', 'champagne', 'emerald', 'charcoal', 'muted gold'],
        rules: [
            'confident fitted silhouettes',
            'satin, silk and lace textures',
            'sultry but never explicit styling',
            'after-dark glamour',
            'still elegant, not costume-like',
            'adult characters only'
        ]
    }
];

const PACK_BY_ID = {};
for (const pack of OUTFIT_PACKS) PACK_BY_ID[pack.id] = pack;

// --- Context detection --------------------------------------------------------
//
// Maps contextual wording ("dress her for the gym", "something warm for the
// beach", "more polished for the office") onto a pack. Specific packs are
// listed before the broad Everyday fallback so a keyword never collapses to
// "casual" by accident.

const PACK_HINTS = [
    { id: 'gym-activewear', re: /\b(?:gym|workout|work[- ]?out|fitness|training|exercise|running|jogging|athletic|activewear|sport(?:y|s)?)\b/i },
    { id: 'lounge-home', re: /\b(?:lounge|at\s+home|homewear|home\s+wear|cozy|cosy|comfortable|pajamas|pyjamas|pjs|sleepwear|bedroom|relaxing\s+at\s+home|house)\b/i },
    { id: 'vacation-summer', re: /\b(?:vacation|holiday|summer|beach|tropical|resort|pool|swim|warm\s+weather|hot\s+weather|sunny|seaside|coastal|warm\s+outdoor)\b/i },
    { id: 'glam-boudoir', re: /\b(?:seductive|sultry|alluring|boudoir|glam(?:orous)?|sexy|tempting|siren|provocative|lingerie|corset|lace[- ]trim(?:med)?|silk\s+slip|bodycon|plunging)\b/i },
    { id: 'casual-night-out', re: /\b(?:night\s+out|evening\s+out|party|clubbing|club|dinner|date\s+night|going\s+out|nightlife|drinks)\b/i },
    { id: 'casual-streetwear', re: /\b(?:streetwear|street\s+style|urban|skate|hip[- ]?hop|hoodie|street)\b/i },
    { id: 'soft-feminine-casual', re: /\b(?:feminine|girly|gentle|romantic|soft\s+and\s+pretty)\b/i },
    { id: 'casual-smart', re: /\b(?:office|workwear|work\s+wear|smart\s+casual|business\s+casual|polished|interview|meeting|smart)\b/i },
    { id: 'minimalist-neutral', re: /\b(?:minimal(?:ist)?|neutral|monochrome|understated)\b/i },
    { id: 'edgy-alternative', re: /\b(?:edgy|alternative|grunge|punk|goth(?:ic)?|rock|rebel|rebellious|leather|dark\s+aesthetic)\b/i },
    { id: 'casual-everyday', re: /\b(?:everyday|casual|relaxed|practical|day[- ]to[- ]day|versatile)\b/i }
];

// Explicitly unknown / negative phrases that must never imply a pack.
const NO_PACK_RE = /\b(?:no\s+pack|without\s+(?:a\s+)?pack|theme\s+default|no\s+outfit\s+pack)\b/i;

function detectOutfitPackFromText(text) {
    const value = String(text || '').trim();
    if (!value || NO_PACK_RE.test(value)) return '';
    for (const hint of PACK_HINTS) {
        if (hint.re.test(value)) return hint.id;
    }
    return '';
}

// Context modifiers that only affect composition (not pack identity). A warm /
// hot setting suppresses heavy layers; a cold setting favours them.
function contextModifiers(text) {
    const value = String(text || '');
    return {
        warm: /\b(?:warm|hot|summer|beach|tropical|sunny|heat)\b/i.test(value),
        cold: /\b(?:cold|winter|snow|chilly|freezing|cold\s+weather)\b/i.test(value)
    };
}

// --- Normalization / introspection --------------------------------------------

function normalizePackId(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return '';
    if (key === CUSTOM_PACK_ID) return CUSTOM_PACK_ID;
    return PACK_BY_ID[key] ? key : '';
}

function getPack(id) {
    const key = normalizePackId(id);
    return key && key !== CUSTOM_PACK_ID ? PACK_BY_ID[key] : null;
}

function isCustomPack(id) {
    return normalizePackId(id) === CUSTOM_PACK_ID;
}

function packLabel(id) {
    if (isCustomPack(id)) return CUSTOM_PACK_LABEL;
    const pack = getPack(id);
    return pack ? pack.label : '';
}

// Compact catalog for the API/UI (no large wardrobe pools).
function listPacks() {
    return OUTFIT_PACKS.map((pack) => ({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        personality: pack.personality || '',
        palette: (pack.palette || []).slice()
    }));
}

// --- Composition --------------------------------------------------------------

function filterByGender(list, gender) {
    const entries = Array.isArray(list) ? list : [];
    if (!gender) return entries;
    return entries.filter((entry) => !Array.isArray(entry.genders) || entry.genders.includes(gender));
}

// Whether a composed one-piece look suits the character's gender. A pack entry
// that explicitly declares `genders` is honoured; an untagged dress/gown is
// treated as feminine (the convention across the catalog) and falls back to a
// separates look for a male character.
function genderFitsComposed(composed, gender) {
    if (!gender) return true;
    const piece = composed && composed.components && composed.components.onePiece;
    if (piece && Array.isArray(piece.genders) && piece.genders.length) return piece.genders.includes(gender);
    const outfit = String((composed && composed.outfit) || '');
    const feminine = /\b(?:dress|gown|nightgown|skirt|frock|sundress|maxi|midi|camisole|blouse|leggings|bodysuit|bralette|crop\s+top|baby\s+tee|off-shoulder|spaghetti[- ]strap|tankini|bikini)\b/i.test(outfit);
    if (gender === 'woman') return true;
    if (gender === 'man') return !feminine;
    return true;
}

// Translate a pack's `wardrobe` into the theme outfit engine's component shape.
// Entries tagged with `genders` are filtered out when the character's gender is
// known and does not match; otherwise they stay available.
function toSystem(pack, options = {}) {
    const wardrobe = (pack && pack.wardrobe) || {};
    const byGender = (list) => filterByGender(list, options.gender);
    let archetypes = Array.isArray(pack.archetypes) && pack.archetypes.length
        ? pack.archetypes
        : DEFAULT_ARCHETYPES;
    if (options.avoidLayers) archetypes = archetypes.filter((a) => a.id !== 'layered');
    // A caller may further restrict the silhouette mix (e.g. skip one-piece
    // looks when the outfit must be gender-appropriate and the pack's wardrobe
    // is not gender-tagged).
    if (Array.isArray(options.archetypes) && options.archetypes.length) {
        const allowed = new Set(options.archetypes.map((id) => String(id)));
        const filtered = archetypes.filter((a) => allowed.has(a.id));
        if (filtered.length) archetypes = filtered;
    }
    return {
        archetypes,
        components: {
            tops: byGender(wardrobe.tops),
            bottoms: byGender(wardrobe.bottoms),
            onePieces: byGender(wardrobe.dresses),
            outerwear: byGender(wardrobe.layers),
            shoes: byGender(wardrobe.footwear),
            accessories: byGender(wardrobe.accessories)
        }
    };
}

// Compose a specific, coherent outfit from a pack. Deterministic for a given
// `rng`; a different seed yields a different look from the same wardrobe.
function composeFromPack(packId, rng = Math.random, options = {}) {
    const pack = getPack(packId);
    if (!pack) {
        return { outfit: '', signature: '', archetype: '', silhouette: '', components: {}, packId: '', packLabel: '' };
    }
    const composed = themes.composeOutfit(toSystem(pack, options), null, rng, {
        // No tag gating: the pack itself is the wardrobe constraint.
        tags: [],
        avoidSignatures: options.avoidSignatures,
        previousArchetype: options.previousArchetype
    });
    // Post-filter: a look whose clothing is clearly gender-inappropriate is
    // swapped for a neutral separates look when the character's gender does not
    // match. This keeps packs without gender tags usable for every character.
    if (options.gender && composed && composed.outfit && !genderFitsComposed(composed, options.gender)) {
        const neutral = Object.assign({}, options, { archetypes: ['separates', 'layered'] });
        for (let attempt = 0; attempt < 6; attempt++) {
            const retry = themes.composeOutfit(
                toSystem(pack, neutral),
                null,
                rng,
                { tags: [], avoidSignatures: options.avoidSignatures, previousArchetype: attempt % 2 ? 'layered' : 'separates' }
            );
            if (retry && retry.outfit && genderFitsComposed(retry, options.gender)) {
                return {
                    outfit: retry.outfit || '',
                    signature: retry.signature || '',
                    archetype: retry.archetype || '',
                    silhouette: retry.silhouette || '',
                    components: retry.components || {},
                    packId: pack.id,
                    packLabel: pack.label
                };
            }
        }
        // The pack offers no gender-appropriate separates: fall back to the
        // neutral everyday pack rather than emit a mismatched outfit.
        const fallback = PACK_BY_ID['casual-everyday'];
        if (fallback && fallback.id !== pack.id) {
            const neutralComposed = themes.composeOutfit(
                toSystem(fallback, neutral),
                null,
                rng,
                { tags: [], avoidSignatures: options.avoidSignatures, previousArchetype: '' }
            );
            if (neutralComposed && neutralComposed.outfit) {
                return {
                    outfit: neutralComposed.outfit || '',
                    signature: neutralComposed.signature || '',
                    archetype: neutralComposed.archetype || '',
                    silhouette: neutralComposed.silhouette || '',
                    components: neutralComposed.components || {},
                    packId: fallback.id,
                    packLabel: fallback.label
                };
            }
        }
    }
    return {
        outfit: composed.outfit || '',
        signature: composed.signature || '',
        archetype: composed.archetype || '',
        silhouette: composed.silhouette || '',
        components: composed.components || {},
        packId: pack.id,
        packLabel: pack.label
    };
}

module.exports = {
    CUSTOM_PACK_ID,
    CUSTOM_PACK_LABEL,
    OUTFIT_PACKS,
    DEFAULT_ARCHETYPES,
    listPacks,
    getPack,
    packLabel,
    normalizePackId,
    isCustomPack,
    detectOutfitPackFromText,
    contextModifiers,
    toSystem,
    composeFromPack
};
