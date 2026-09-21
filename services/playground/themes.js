/* ============================================
   JARVIS — Creative Playground Themes
   Structured, extensible creative-theme catalog.
   Each theme carries compatible scene ideas and
   the option pools the Concept engine draws from
   when it randomizes. This is pure data + helpers
   so the catalog can grow without touching the
   UI or the concept logic.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const ANYTHING_ID = 'anything';

const THEMES = [
    {
        id: 'fashion-editorial',
        label: 'Fashion & Editorial',
        description: 'Magazine covers, runway looks, and styled studio portraiture.',
        aspectRatios: ['4:5', '1:1', '9:16'],
        environments: [
            'a seamless studio backdrop in muted concrete grey',
            'a stark white cyclorama with a single hard key light',
            'an editorial set with draped fabric and sculptural props',
            'a quiet marble hallway with tall windows',
            'a rooftop against a soft overcast sky'
        ],
        activities: [
            'holding a poised three-quarter pose',
            'mid-stride on an imaginary runway',
            'leaning against a plain wall with one hand in a pocket',
            'turning to look back over a shoulder',
            'seated on a low stool with an elegant upright posture'
        ],
        outfits: [
            'a tailored oversized blazer with wide-leg trousers',
            'a floor-length satin slip dress',
            'a structured trench coat over a turtleneck',
            'a sculptural knit top with flowing midi skirt',
            'a monochrome suit with sharp shoulders'
        ],
        lighting: [
            'crisp directional studio lighting with clean falloff',
            'soft beauty-dish light with gentle shadow',
            'high-key lighting with almost no shadow',
            'dramatic side lighting that carves the silhouette',
            'a single warm softbox against a cool background'
        ],
        cameras: [
            'full-length vertical composition, camera at chest height',
            'medium shot with generous negative space',
            'tight beauty portrait with a long lens',
            'slightly low angle for a commanding presence',
            'fashion-editorial 85mm compression'
        ],
        moods: ['confident', 'elegant', 'cool and restrained', 'bold', 'refined'],
        styles: [
            'high-fashion editorial photography',
            'clean commercial studio photography',
            'analogue magazine film look',
            'sharp digital campaign photography'
        ]
    },
    {
        id: 'travel-adventure',
        label: 'Travel & Adventure',
        description: 'Expansive destinations, motion, and the romance of being elsewhere.',
        aspectRatios: ['16:9', '4:5', '9:16'],
        environments: [
            'a windswept coastal cliff path',
            'a neon-lit night market alley',
            'a fog-wrapped mountain ridge at dawn',
            'a turquoise lagoon with a wooden pier',
            'an ancient stone street in a Mediterranean old town'
        ],
        activities: [
            'pausing to take in a vast panorama',
            'walking a narrow trail with a backpack',
            'wading ankle-deep along the shoreline',
            'haggling cheerfully at a market stall',
            'looking out from the deck of a slow ferry'
        ],
        outfits: [
            'a weathered field jacket and hiking boots',
            'light linen layers with a sun hat',
            'a practical daypack over a breathable shirt',
            'a flowing travel dress with a crossbody bag',
            'a windproof shell and rolled-up trousers'
        ],
        lighting: [
            'low golden sun raking across the landscape',
            'cool blue hour just before sunrise',
            'harsh tropical midday sun with strong contrast',
            'misty diffuse light with low visibility',
            'the warm glow of street lamps and signage after dark'
        ],
        cameras: [
            'wide establishing shot with the figure small in frame',
            'sweeping landscape composition with a strong leading line',
            'low angle emphasising the scale of the surroundings',
            'telephoto compression of layered scenery',
            'walking follow shot at shoulder height'
        ],
        moods: ['adventurous', 'awestruck', 'free', 'windswept', 'wanderlust'],
        styles: [
            'travel documentary photography',
            'vivid landscape photography',
            'National Geographic editorial look',
            'muted cinematic travel film'
        ]
    },
    {
        id: 'cinematic-storytelling',
        label: 'Cinematic Storytelling',
        description: 'Single frames that imply a whole film: tension, character, and place.',
        aspectRatios: ['16:9', '9:16', '1:1'],
        environments: [
            'a rain-slicked city street at night',
            'a dim apartment lit only by a flickering television',
            'a deserted rural road stretching to the horizon',
            'a crowded station platform in the last light',
            'a foggy pier with a single lamp'
        ],
        activities: [
            'turning to look at something just out of frame',
            'standing still while the world moves around them',
            'walking away from the camera down a long corridor',
            'lighting a cigarette against the wind',
            'waiting with a guarded expression'
        ],
        outfits: [
            'a long coat with the collar turned up',
            'a lived-in leather jacket and dark trousers',
            'a formal suit that looks slightly rumpled',
            'a hooded raincoat beaded with water',
            'plain dark clothing that lets the face carry the scene'
        ],
        lighting: [
            'single-source low-key lighting with deep shadow',
            'practical neon spilling from signs and shop windows',
            'harsh top light through window blinds',
            'cold moonlight with a warm practical in the distance',
            'rim lighting that separates the subject from the dark'
        ],
        cameras: [
            'anamorphic widescreen composition with strong foreground framing',
            'over-the-shoulder shot with the subject small in the frame',
            'tight dramatic close-up with shallow focus',
            'low tracking angle with leading lines into the distance',
            'static symmetrical framing that feels deliberate'
        ],
        moods: ['tense', 'melancholic', 'brooding', 'hopeful', 'noir'],
        styles: [
            'cinematic film still',
            'moody neo-noir photography',
            '35mm anamorphic cinematic look',
            'desaturated prestige-drama grade'
        ]
    },
    {
        id: 'fantasy-character-worlds',
        label: 'Fantasy & Character Worlds',
        description: 'Invented worlds and archetypes with a strong sense of lore.',
        aspectRatios: ['4:5', '1:1', '16:9'],
        environments: [
            'a misty enchanted forest lit by drifting embers',
            'a ruined marble temple reclaimed by vines',
            'a snowbound village beneath an aurora',
            'a floating island above a sea of clouds',
            'an alchemist\u2019s workshop crowded with glowing jars'
        ],
        activities: [
            'channeling a spell between cupped hands',
            'resting a hand on the hilt of a worn sword',
            'examining a glowing relic by lantern light',
            'standing at the edge of a precipice, cloak billowing',
            'reading from a floating, open grimoire'
        ],
        outfits: [
            'an embroidered travelling cloak over layered robes',
            'ornate ceremonial armour with weathered detailing',
            'a forest-green hunting tunic and leather bracers',
            'a hooded archivist\u2019s robe with brass clasps',
            'a regal gown traced with faintly luminous thread'
        ],
        lighting: [
            'cool ethereal glow from magical sources',
            'warm firelight against cool moonlit surroundings',
            'bioluminescent accents in deep shadow',
            'stormy backlight with a break in the clouds',
            'soft dawn light through canopy mist'
        ],
        cameras: [
            'epic low-angle hero composition',
            'intimate medium shot with the environment looming behind',
            'wide environmental portrait placing the figure in the world',
            'close-up focused on the face and a glowing detail',
            'dynamic diagonal composition with strong depth'
        ],
        moods: ['mythic', 'mysterious', 'heroic', 'eerie', 'wondrous'],
        styles: [
            'painterly fantasy illustration',
            'cinematic concept-art realism',
            'storybook illustration with rich texture',
            'dark-fantasy photography'
        ]
    },
    {
        id: 'seasonal-concepts',
        label: 'Seasonal Concepts',
        description: 'The year as a creative prompt: light, weather, ritual, and mood.',
        aspectRatios: ['4:5', '1:1', '16:9'],
        environments: [
            'a snow-dusted pine forest',
            'a field of wildflowers in high summer',
            'a street of amber autumn leaves',
            'a cherry-blossom path in full bloom',
            'a cosy interior with a crackling fireplace'
        ],
        activities: [
            'catching snowflakes with an upturned face',
            'walking through falling blossom',
            'wrapping both hands around a warm drink',
            'jumping into a drift of leaves',
            'sheltering under an umbrella in a spring shower'
        ],
        outfits: [
            'a chunky knit scarf and wool coat',
            'a light sundress with a woven bag',
            'a corduroy jacket in burnt orange and brown',
            'a pastel raincoat with rubber boots',
            'a soft cashmere cardigan in winter white'
        ],
        lighting: [
            'cool blue winter light with warm window spill',
            'bright, high summer sunlight',
            'amber autumn light filtering through leaves',
            'soft pastel spring light after rain',
            'the warm flicker of firelight'
        ],
        cameras: [
            'medium shot with the season filling the background',
            'wide environmental composition',
            'close-up on face and seasonal detail',
            'natural candid framing',
            'slightly above eye level, airy composition'
        ],
        moods: ['festive', 'nostalgic', 'fresh', 'serene', 'joyful'],
        styles: [
            'seasonal editorial photography',
            'warm lifestyle photography',
            'soft film-emulation look',
            'bright commercial seasonal campaign'
        ]
    },
    {
        // Process-driven photography. `techniques` drives selection: one
        // dominant experimental technique is chosen per concept and its camera /
        // lighting / activity / environment come from that technique's own pool,
        // so the result reads as a deliberate photographic experiment rather than
        // a pile of stacked effects. The flat pools below stay broad and are the
        // fallback (and feed the "Anything" theme).
        id: 'experimental-photography',
        label: 'Experimental Photography',
        description: 'Process-driven images: motion, optics, reflection, projection, exposure, perspective, shadow, and texture experiments.',
        aspectRatios: ['1:1', '4:5', '16:9'],
        environments: [
            'a minimal studio with a seamless backdrop',
            'a studio filled with projected geometric patterns',
            'a room with reflective surfaces and fragmented reflections',
            'a dark studio with a narrow beam of light',
            'a room filled with translucent curtains',
            'a space with coloured light projected across the walls',
            'a hallway with repeating architectural lines',
            'a room surrounded by mirrors',
            'a minimalist concrete interior',
            'a glass-walled room with reflections',
            'a city street after rain with reflective pavement',
            'a neon-lit street at night',
            'a brightly lit convenience store',
            'an empty parking structure',
            'a tunnel with repeating lights',
            'a subway platform with strong perspective lines',
            'a rooftop surrounded by city lights',
            'a plain room with dramatic window shadows',
            'a room with patterned blinds casting shadows',
            'a gallery-like white space',
            'a dark room with projected textures',
            'a room filled with transparent acrylic panels',
            'a set surrounded by translucent plastic sheets',
            'a minimal outdoor landscape with strong geometric forms',
            'a studio with coloured gels crossing the frame',
            'a smoke-filled room with a single beam of light'
        ],
        activities: [
            'moving quickly across the frame during a long exposure',
            'turning while the camera captures motion',
            'walking through a projected light pattern',
            'standing still while the background becomes motion-blurred',
            'interacting with a reflective surface',
            'looking through textured glass',
            'standing behind translucent fabric',
            'creating shadows with the hands',
            'holding a transparent object close to the lens',
            'moving fabric through the frame',
            'throwing lightweight fabric into the air',
            'interacting with projected geometric shapes',
            'standing between mirrored panels',
            'looking through a prism',
            'holding a prism in front of the camera',
            'moving a reflective object near the lens',
            'creating layered reflections in glass',
            'walking through coloured light',
            'posing beneath patterned shadows',
            'partially obscuring the face with an object',
            'creating an intentional silhouette',
            'moving while a strobe freezes selected moments',
            'holding a pose while the camera pans',
            'moving deliberately through a long exposure'
        ],
        outfits: [
            'a simple monochrome outfit',
            'a flowing oversized garment',
            'a fitted minimalist outfit',
            'a sharply tailored outfit',
            'a brightly coloured casual outfit',
            'a simple white outfit',
            'a simple black outfit',
            'a textured knit outfit',
            'a layered streetwear outfit',
            'a flowing skirt with a simple top',
            'a loose shirt with wide-leg trousers',
            'a simple dress with clean lines',
            'a reflective fabric accent',
            'a translucent outer layer over a solid outfit',
            'a bold geometric-print outfit',
            'a metallic accent combined with simple clothing',
            'a casual T-shirt and trousers',
            'a simple tank top and jeans',
            'a simple silhouette-friendly outfit',
            'sheer fabric layered over a solid base'
        ],
        lighting: [
            'hard sunlight creating geometric shadows',
            'soft window light interrupted by patterned blinds',
            'saturated red and blue projected light',
            'colored gels creating overlapping pools of light',
            'a narrow spotlight against darkness',
            'multiple colored light sources crossing the subject',
            'stroboscopic flash freezing movement',
            'a single backlight creating a silhouette',
            'strong side lighting emphasizing texture',
            'projected geometric patterns',
            'projected photographs or textures',
            'flickering practical lights',
            'mixed warm and cool artificial light',
            'light passing through glass',
            'reflected light bouncing from a metallic surface',
            'intentional lens flare',
            'controlled light leaks',
            'strong rim lighting',
            'underexposed ambient light with a bright subject',
            'bright overexposed highlights used deliberately',
            'saturated coloured gels with hard shadows',
            'soft diffused light through frosted glass'
        ],
        cameras: [
            'long exposure with controlled motion blur',
            'slow shutter with intentional camera movement',
            'a deliberately long exposure with streaking motion',
            'horizontal panning with a sharp subject',
            'vertical camera movement during exposure',
            'rotational camera movement creating curved light trails',
            'multiple-exposure movement sequence',
            'extreme low-angle perspective',
            'extreme high-angle perspective',
            'close wide-angle perspective',
            'very close perspective distortion',
            'fisheye distortion',
            'ultra-wide architectural perspective',
            'compressed telephoto framing',
            'prism refraction creating duplicated highlights',
            'shooting through textured glass',
            'shooting through translucent fabric',
            'shooting through rain-covered glass',
            'shooting through frosted glass',
            'reflection through a glass surface',
            'foreground refraction with a prism',
            'lens partially obscured by a transparent object',
            'intentional focus falloff',
            'shallow focus with an unusually close foreground',
            'layered reflection through glass',
            'multiple mirror reflections',
            'fragmented reflection',
            'reflection in a puddle',
            'reflection in polished metal',
            'symmetrical mirror composition',
            'intentional underexposure',
            'intentional overexposure',
            'high-key blown highlights',
            'deep-shadow silhouette',
            'double exposure',
            'multiple exposure',
            'extreme crop cutting through the subject',
            'subject partially outside the frame',
            'off-center composition with large negative space',
            'unexpected foreground obstruction',
            'repeating geometric framing',
            'visual symmetry',
            'intentional asymmetry',
            'split composition',
            'nested framing',
            'foreground ripples from water',
            'foreground soap-bubble iridescence',
            'fine mist drifting through the foreground',
            'foreground mesh fabric softening the frame',
            'extreme close-up with abstract framing',
            'dutch angle with deliberate imbalance'
        ],
        // Framing-only experiments, kept separate from the camera techniques so a
        // concept gets at most one camera effect plus one compositional support.
        compositions: [
            'extreme crop cutting through the subject',
            'subject partially outside the frame',
            'off-center composition with large negative space',
            'unexpected foreground obstruction',
            'repeating geometric framing',
            'visual symmetry',
            'intentional asymmetry',
            'split composition',
            'nested framing',
            'strong diagonal composition',
            'subject framed inside a rectangular opening',
            'tight graphic crop'
        ],
        // Physical surfaces used as photographic elements, folded into a
        // technique as one supporting material rather than its own effect.
        textures: [
            'rippling water in the foreground',
            'rain-covered glass',
            'fogged glass',
            'crinkled transparent plastic',
            'textured acrylic',
            'translucent fabric',
            'prismatic glass',
            'polished metal',
            'chrome surfaces',
            'wet pavement',
            'soap bubbles',
            'fine mist',
            'paper cutout shadows',
            'mesh fabric',
            'frosted glass'
        ],
        moods: ['dreamlike', 'unsettling', 'playful', 'surreal', 'meditative', 'curious',
            'strange', 'energetic', 'hypnotic', 'minimal', 'otherworldly', 'graphic',
            'unexpected', 'quiet', 'disorienting'],
        styles: [
            'experimental analogue photography',
            'abstract fine-art photography',
            'experimental colour photography',
            'experimental black-and-white photography',
            'creative studio photography',
            'experimental street photography',
            'experimental portrait photography',
            'conceptual photography',
            'experimental fashion photography',
            'abstract camera movement photography',
            'multiple-exposure photography',
            'prism photography',
            'experimental architectural photography',
            'light-art photography',
            'minimalist experimental photography',
            'cross-processed colour film',
            'high-contrast monochrome'
        ],
        // One coherent experiment per concept: pick a technique, then draw its
        // camera / lighting / activity / environment / material from that
        // technique only. `weight` would bias selection if a technique needed to
        // be rarer; every technique currently carries weight 1.
        techniques: [
            {
                id: 'motion-blur',
                label: 'Motion Blur',
                cameras: ['long exposure with controlled motion blur', 'slow shutter with intentional camera movement', 'a deliberately long exposure with streaking motion'],
                lighting: ['even, diffused light that keeps the blurred motion soft', 'soft window light with gentle falloff'],
                activities: ['moving quickly across the frame during a long exposure', 'turning while the camera captures motion', 'moving deliberately through a long exposure'],
                environments: ['a minimal studio with a seamless backdrop', 'a hallway with repeating architectural lines', 'a minimalist concrete interior'],
                textures: ['translucent fabric drifting through the frame']
            },
            {
                id: 'panning',
                label: 'Panning & Camera Movement',
                cameras: ['horizontal panning with a sharp subject', 'vertical camera movement during exposure', 'a panning frame that keeps the subject sharp while the background streaks'],
                lighting: ['city lights and street lamps streaking past', 'warm street light with cool shadow'],
                activities: ['standing still while the background becomes motion-blurred', 'walking while the camera pans with them', 'holding a pose while the camera pans'],
                environments: ['a neon-lit street at night', 'a tunnel with repeating lights', 'a city street after rain with reflective pavement'],
                textures: ['wet pavement reflecting the streaking lights']
            },
            {
                id: 'light-trails',
                label: 'Light Trails',
                cameras: ['rotational camera movement creating curved light trails', 'a long exposure that turns passing lights into streaks', 'multiple-exposure movement sequence'],
                lighting: ['moving vehicle lights and lamp trails', 'flickering practical lights'],
                activities: ['standing still while lights trail around them', 'turning slowly as the lights streak past'],
                environments: ['an empty parking structure', 'a tunnel with repeating lights', 'a city street after rain with reflective pavement'],
                textures: ['wet pavement']
            },
            {
                id: 'strobe',
                label: 'Stroboscopic / Flash',
                cameras: ['a stroboscopic sequence captured in a single frame', 'a strobe freezing several moments of one movement'],
                lighting: ['stroboscopic flash freezing movement', 'a single hard flash against darkness'],
                activities: ['moving while a strobe freezes selected moments'],
                environments: ['a dark studio with a narrow beam of light', 'an empty parking structure'],
                textures: ['fine mist']
            },
            {
                id: 'prism',
                label: 'Prism / Refraction',
                cameras: ['prism refraction creating duplicated highlights', 'foreground refraction with a prism', 'holding a prism in front of the camera'],
                lighting: ['soft window light split by the prism', 'a single backlight shaped by the prism'],
                activities: ['looking through a prism', 'holding a prism in front of the camera', 'moving a reflective object near the lens'],
                environments: ['a gallery-like white space', 'a minimal outdoor landscape with strong geometric forms', 'a brightly lit convenience store'],
                textures: ['prismatic glass', 'chrome surfaces']
            },
            {
                id: 'reflection',
                label: 'Reflection',
                cameras: ['layered reflection through glass', 'multiple mirror reflections', 'fragmented reflection', 'reflection in a puddle', 'reflection in polished metal', 'symmetrical mirror composition'],
                lighting: ['reflected light bouncing from a metallic surface', 'light passing through glass', 'bright overexposed highlights used deliberately'],
                activities: ['interacting with a reflective surface', 'standing between mirrored panels', 'creating layered reflections in glass'],
                environments: ['a room surrounded by mirrors', 'a glass-walled room with reflections', 'a room with reflective surfaces and fragmented reflections', 'a city street after rain with reflective pavement'],
                textures: ['polished metal', 'chrome surfaces', 'wet pavement', 'frosted glass']
            },
            {
                id: 'projection',
                label: 'Projection',
                cameras: ['a frame shaped by a projected pattern', 'projected geometric patterns defining the composition', 'a projected image falling across the subject'],
                lighting: ['projected geometric patterns', 'projected photographs or textures', 'saturated red and blue projected light'],
                activities: ['walking through a projected light pattern', 'interacting with projected geometric shapes', 'posing within a projected pattern'],
                environments: ['a studio filled with projected geometric patterns', 'a dark room with projected textures', 'a space with coloured light projected across the walls'],
                textures: ['paper cutout shadows']
            },
            {
                id: 'shadow-play',
                label: 'Shadow Play',
                cameras: ['a composition built from hard graphic shadows', 'shadows used as foreground shapes', 'a frame divided by a hard shadow line'],
                lighting: ['hard sunlight creating geometric shadows', 'soft window light interrupted by patterned blinds', 'strong side lighting emphasizing texture'],
                activities: ['creating shadows with the hands', 'posing beneath patterned shadows', 'creating an intentional silhouette'],
                environments: ['a plain room with dramatic window shadows', 'a room with patterned blinds casting shadows', 'a minimalist concrete interior'],
                textures: ['paper cutout shadows', 'mesh fabric']
            },
            {
                id: 'double-exposure',
                label: 'Double Exposure',
                cameras: ['double exposure', 'multiple exposure', 'a multiple-exposure movement sequence'],
                lighting: ['mixed warm and cool artificial light', 'underexposed ambient light with a bright subject'],
                activities: ['holding a pose through two overlapping exposures', 'standing still while a second frame overlays'],
                environments: ['a minimal studio with a seamless backdrop', 'a minimal outdoor landscape with strong geometric forms'],
                textures: ['translucent fabric']
            },
            {
                id: 'distortion',
                label: 'Perspective Distortion',
                cameras: ['fisheye distortion', 'very close perspective distortion', 'extreme low-angle perspective', 'extreme high-angle perspective', 'close wide-angle perspective', 'ultra-wide architectural perspective', 'compressed telephoto framing'],
                lighting: ['bright overexposed highlights used deliberately', 'strong side lighting emphasizing texture'],
                activities: ['leaning close into the lens', 'standing directly beneath the camera'],
                environments: ['a hallway with repeating architectural lines', 'an empty parking structure', 'a subway platform with strong perspective lines', 'a minimal outdoor landscape with strong geometric forms'],
                textures: []
            },
            {
                id: 'texture',
                label: 'Texture / Material',
                cameras: ['shooting through textured glass', 'shooting through translucent fabric', 'shooting through rain-covered glass', 'lens partially obscured by a transparent object', 'intentional focus falloff', 'shallow focus with an unusually close foreground', 'shooting through frosted glass'],
                lighting: ['light passing through glass', 'soft diffused light through frosted glass', 'strong rim lighting'],
                activities: ['looking through textured glass', 'standing behind translucent fabric', 'holding a transparent object close to the lens', 'moving fabric through the frame', 'throwing lightweight fabric into the air'],
                environments: ['a room filled with translucent curtains', 'a room filled with transparent acrylic panels', 'a set surrounded by translucent plastic sheets'],
                textures: ['rippling water in the foreground', 'rain-covered glass', 'fogged glass', 'crinkled transparent plastic', 'textured acrylic', 'translucent fabric', 'frosted glass', 'fine mist', 'soap bubbles']
            },
            {
                id: 'silhouette',
                label: 'Silhouette',
                cameras: ['a backlit silhouette', 'deep-shadow silhouette', 'a silhouette held against a bright background'],
                lighting: ['a single backlight creating a silhouette', 'underexposed ambient light with a bright subject', 'a narrow spotlight against darkness'],
                activities: ['creating an intentional silhouette', 'partially obscuring the face with an object'],
                environments: ['a dark studio with a narrow beam of light', 'a rooftop surrounded by city lights', 'a tunnel with repeating lights'],
                textures: ['fine mist']
            },
            {
                id: 'light-play',
                label: 'Colour & Practical Light',
                cameras: ['colored light crossing the frame', 'a frame shaped by overlapping light sources', 'a composition built from pools of coloured light'],
                lighting: ['saturated red and blue projected light', 'colored gels creating overlapping pools of light', 'multiple colored light sources crossing the subject', 'mixed warm and cool artificial light', 'flickering practical lights', 'intentional lens flare', 'controlled light leaks'],
                activities: ['walking through coloured light', 'standing between overlapping light sources', 'posing beneath patterned shadows'],
                environments: ['a brightly lit convenience store', 'a neon-lit street at night', 'a space with coloured light projected across the walls', 'a studio with coloured gels crossing the frame'],
                textures: ['fine mist']
            }
        ],
        // Keep the subject readable and the effect deliberate — experimental does
        // not mean destroying the subject or stacking unrelated effects.
        constraints: [
            'Keep the subject clearly recognizable with believable anatomy',
            'Use one intentional photographic technique, not a stack of unrelated effects',
            'The experimental effect should read as a deliberate in-camera photographic choice'
        ]
    },
    {
        // Warm, everyday photography — candid moments, selfies, mirror selfies,
        // outfit checks and spontaneous personal photos. The vocabulary stays
        // deliberately "phone-camera" and unposed — no editorial/stock-photo
        // language — so the result reads like a believable personal post.
        // Subcategories are data-only bundles; add one by adding a `categories`
        // entry below. Outfits are assembled from `outfitSystem` below so the
        // combination space is much larger than the flat `outfits` list.
        id: 'lifestyle-candid',
        label: 'Lifestyle & Candid',
        description: 'Warm, everyday moments captured as if they were never posed — selfies, mirror selfies, outfit checks, and spontaneous personal photos.',
        aspectRatios: ['1:1', '4:5', '16:9', '9:16'],
        // Theme-level fallback pools. Subcategories supply their own
        // environment/activity/camera/composition; these cover the rest and are
        // flattened into the "Anything" theme.
        environments: [
            'a sunlit kitchen with a half-drunk cup of coffee',
            'a lived-in living room with linen and houseplants',
            'a neighbourhood café beside a rain-speckled window',
            'a balcony overlooking quiet rooftops at golden hour',
            'a bookshop aisle between tall wooden shelves'
        ],
        activities: [
            'laughing mid-conversation',
            'reaching for a warm mug with both hands',
            'reading with an elbow propped on a table',
            'stretching after waking, still half in the duvet',
            'walking a dog down a leafy street'
        ],
        // A curated fallback pool (also flattened into the "Anything" theme).
        // Within this theme outfits are assembled from `outfitSystem` below so
        // the combination space is much larger than this list.
        outfits: [
            'an oversized knit sweater and soft denim',
            'a simple linen shirt with the sleeves rolled up',
            'relaxed loungewear in warm neutrals',
            'a light summer dress with sandals',
            'a casual button-up over a plain tee',
            'a fitted T-shirt with straight-leg jeans',
            'an oversized T-shirt with wide-leg jeans',
            'a baby tee with relaxed jeans',
            'a ribbed tank with linen trousers',
            'a cropped polo with high-waisted jeans',
            'an oversized button-up with denim shorts',
            'a fitted long-sleeve top with baggy jeans',
            'a sweatshirt with leggings',
            'a knit top with straight-leg trousers',
            'a casual cardigan with jeans',
            'a cropped cardigan with high-waisted jeans',
            'a fitted knit top with a pleated skirt',
            'a sleeveless blouse with a midi skirt',
            'a camisole with a flowy maxi skirt',
            'a casual sundress',
            'a floral midi dress',
            'a simple mini dress with sneakers',
            'a knit top with an A-line skirt',
            'an oversized graphic tee with cargo pants',
            'a cropped jacket with wide-leg jeans',
            'a bomber jacket with straight-leg jeans',
            'a varsity jacket with a denim skirt',
            'a fitted tank with baggy jeans',
            'a cropped zip jacket with cargo pants',
            'an oversized shirt with biker shorts',
            'a denim jacket with a casual dress',
            'a structured blazer with relaxed jeans',
            'a linen button-up with relaxed trousers',
            'a knit polo with jeans',
            'a sleeveless top with linen pants',
            'a cardigan with a denim skirt',
            'a midi dress with casual flats',
            'an oversized shirt with tailored shorts',
            'a loose linen shirt with shorts',
            'a tank top with wide-leg linen pants',
            'a lightweight sundress',
            'a cropped top with a flowy maxi skirt',
            'an open oversized shirt over a tank with shorts',
            'a casual matching linen set',
            'a relaxed summer dress',
            'an oversized sleep T-shirt',
            'a camisole with lounge pants',
            'a fitted tank with relaxed lounge pants',
            'an oversized sweatshirt with biker shorts',
            'a cozy cardigan with shorts',
            'a simple matching lounge set',
            'a sports bra with high-waisted leggings',
            'a cropped athletic top with biker shorts',
            'an oversized gym T-shirt with leggings',
            'a fitted tank with running shorts',
            'a lightweight zip jacket with leggings',
            'a matching athletic set',
            'a fitted top with straight-leg jeans',
            'a satin camisole with tailored trousers',
            'a simple fitted dress',
            'a knit top with a midi skirt',
            'a fitted blouse with dark denim',
            'an off-shoulder top with wide-leg trousers'
        ],
        // Reusable wardrobe components. Scenario selection combines these into a
        // complete look; `tags` mark which subcategories each piece suits and
        // `silhouette` keeps the readable shape varied. This is deliberately
        // character-agnostic: any identity can wear any of these looks.
        outfitSystem: {
            // Everyday-casual dominates: separates are the default look, one-piece
            // dresses are common, and a layered (outerwear) look is the exception,
            // so ordinary casual photos often have no outerwear at all.
            archetypes: [
                { id: 'separates', requires: ['tops', 'bottoms'], weight: 6 },
                { id: 'one-piece', requires: ['onePieces'], weight: 2.5 },
                { id: 'layered', requires: ['outerwear', 'bottoms'], weight: 1.2 }
            ],
            // `weight` biases selection toward everyday basics (high) and away from
            // styled/trendy pieces (low). It is optional and defaults to 1.
            components: {
                tops: [
                    { value: 'a basic tank top', tags: ['casual', 'summer', 'lounge'], silhouette: 'fitted', weight: 3 },
                    { value: 'a fitted tank top', tags: ['casual', 'street', 'summer', 'lounge', 'gym'], silhouette: 'fitted', weight: 3 },
                    { value: 'a ribbed tank top', tags: ['casual', 'summer', 'lounge'], silhouette: 'fitted', weight: 3 },
                    { value: 'a loose tank top', tags: ['casual', 'summer', 'lounge'], silhouette: 'relaxed', weight: 3 },
                    { value: 'a cropped tank top', tags: ['casual', 'trendy', 'summer'], silhouette: 'cropped', weight: 2 },
                    { value: 'a simple white tank top', tags: ['casual', 'summer'], silhouette: 'fitted', weight: 3 },
                    { value: 'a simple black tank top', tags: ['casual', 'street', 'evening'], silhouette: 'fitted', weight: 3 },
                    { value: 'a fitted scoop-neck tank', tags: ['casual', 'feminine'], silhouette: 'fitted', weight: 3 },
                    { value: 'a casual spaghetti-strap top', tags: ['casual', 'feminine', 'summer'], silhouette: 'fitted', weight: 2 },
                    { value: 'a simple camisole', tags: ['feminine', 'summer', 'lounge', 'casual'], silhouette: 'fitted', weight: 3 },
                    { value: 'a fitted camisole', tags: ['feminine', 'summer', 'lounge', 'casual'], silhouette: 'fitted', weight: 3 },
                    { value: 'a cropped camisole', tags: ['feminine', 'trendy', 'summer'], silhouette: 'cropped', weight: 2 },
                    { value: 'a basic crew-neck T-shirt', tags: ['casual', 'street'], silhouette: 'relaxed', weight: 3 },
                    { value: 'a fitted crew-neck T-shirt', tags: ['casual', 'street'], silhouette: 'fitted', weight: 3 },
                    { value: 'a fitted T-shirt', tags: ['casual', 'street', 'gym'], silhouette: 'fitted', weight: 3 },
                    { value: 'a loose cotton T-shirt', tags: ['casual', 'lounge'], silhouette: 'relaxed', weight: 3 },
                    { value: 'an oversized plain T-shirt', tags: ['casual', 'lounge', 'street'], silhouette: 'oversized', weight: 3 },
                    { value: 'an oversized T-shirt', tags: ['casual', 'street', 'lounge'], silhouette: 'oversized', weight: 3 },
                    { value: 'a cropped T-shirt', tags: ['casual', 'trendy'], silhouette: 'cropped', weight: 2.5 },
                    { value: 'a baby tee', tags: ['casual', 'feminine', 'trendy'], silhouette: 'fitted', weight: 2.5 },
                    { value: 'a basic V-neck T-shirt', tags: ['casual'], silhouette: 'relaxed', weight: 3 },
                    { value: 'a cropped V-neck T-shirt', tags: ['casual', 'trendy'], silhouette: 'cropped', weight: 2 },
                    { value: 'a casual long-sleeve T-shirt', tags: ['casual', 'street'], silhouette: 'relaxed', weight: 3 },
                    { value: 'a fitted long-sleeve top', tags: ['casual', 'feminine', 'evening'], silhouette: 'fitted', weight: 2 },
                    { value: 'a lightweight ribbed top', tags: ['casual', 'feminine'], silhouette: 'fitted', weight: 2.5 },
                    { value: 'a simple sleeveless top', tags: ['casual', 'feminine', 'summer'], silhouette: 'relaxed', weight: 3 },
                    { value: 'a cropped sleeveless top', tags: ['casual', 'feminine', 'trendy'], silhouette: 'cropped', weight: 2 },
                    { value: 'a casual polo shirt', tags: ['casual', 'brunch'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a loose polo shirt', tags: ['casual', 'brunch'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a fitted polo shirt', tags: ['casual', 'brunch'], silhouette: 'fitted', weight: 2 },
                    { value: 'a simple button-up shirt', tags: ['casual', 'brunch', 'travel'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'an oversized casual button-up', tags: ['casual', 'street', 'brunch'], silhouette: 'oversized', weight: 2.5 },
                    { value: 'a lightweight linen shirt', tags: ['travel', 'summer', 'brunch'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a cropped button-up shirt', tags: ['casual', 'trendy'], silhouette: 'cropped', weight: 2 },
                    { value: 'a basic knit top', tags: ['casual', 'feminine', 'brunch'], silhouette: 'fitted', weight: 2.5 },
                    { value: 'a relaxed knit top', tags: ['casual', 'feminine', 'brunch', 'lounge'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'a simple cardigan', tags: ['casual', 'feminine', 'lounge'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'a lightweight cardigan', tags: ['casual', 'feminine', 'brunch'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'a cropped cardigan', tags: ['feminine', 'brunch', 'trendy'], silhouette: 'cropped', weight: 1.5 },
                    { value: 'an oversized sweatshirt', tags: ['casual', 'street', 'lounge'], silhouette: 'oversized', weight: 2.5 },
                    { value: 'a casual hoodie', tags: ['casual', 'street', 'lounge'], silhouette: 'oversized', weight: 2.5 },
                    { value: 'a zip-up hoodie', tags: ['casual', 'street', 'lounge', 'gym'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a camisole', tags: ['feminine', 'summer', 'lounge', 'evening'], silhouette: 'fitted', weight: 2.5 },
                    { value: 'a satin camisole', tags: ['evening', 'feminine'], silhouette: 'fitted', weight: 0.5 },
                    { value: 'a fitted blouse', tags: ['evening', 'brunch', 'feminine'], silhouette: 'fitted', weight: 1 },
                    { value: 'an off-shoulder top', tags: ['evening', 'feminine'], silhouette: 'fitted', weight: 1 },
                    { value: 'a sleeveless blouse', tags: ['feminine', 'brunch', 'summer', 'evening'], silhouette: 'relaxed', weight: 1.2 },
                    { value: 'a knit top', tags: ['feminine', 'brunch', 'evening'], silhouette: 'fitted', weight: 1.2 },
                    { value: 'a fitted knit top', tags: ['feminine', 'brunch', 'evening'], silhouette: 'fitted', weight: 1.2 },
                    { value: 'an oversized graphic tee', tags: ['street', 'casual', 'trendy'], silhouette: 'oversized', weight: 1.5 },
                    { value: 'a fitted tank', tags: ['street', 'casual', 'summer', 'lounge', 'gym'], silhouette: 'fitted', weight: 3 },
                    { value: 'a tank top', tags: ['travel', 'summer', 'casual'], silhouette: 'fitted', weight: 3 },
                    { value: 'a cropped top', tags: ['travel', 'summer', 'trendy', 'evening'], silhouette: 'cropped', weight: 2 },
                    { value: 'a linen button-up', tags: ['brunch', 'travel', 'summer'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a knit polo', tags: ['brunch', 'casual'], silhouette: 'fitted', weight: 1.5 },
                    { value: 'a sleeveless top', tags: ['brunch', 'summer', 'feminine'], silhouette: 'relaxed', weight: 2 },
                    { value: 'a loose linen shirt', tags: ['travel', 'summer'], silhouette: 'relaxed', weight: 2 },
                    { value: 'an oversized sleep T-shirt', tags: ['lounge', 'bedroom'], silhouette: 'oversized', weight: 2.5 },
                    { value: 'an oversized button-up', tags: ['casual', 'brunch', 'travel'], silhouette: 'oversized', weight: 2.5 },
                    { value: 'a cozy cardigan', tags: ['lounge', 'bedroom'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'an open oversized shirt', tags: ['travel', 'summer', 'casual'], silhouette: 'oversized', weight: 2 },
                    { value: 'a sports bra', tags: ['gym'], silhouette: 'fitted', weight: 1 },
                    { value: 'a cropped athletic top', tags: ['gym'], silhouette: 'cropped', weight: 1 },
                    { value: 'an oversized gym T-shirt', tags: ['gym', 'casual'], silhouette: 'oversized', weight: 1 }
                ],
                bottoms: [
                    { value: 'straight-leg jeans', tags: ['casual', 'street', 'brunch', 'evening'], silhouette: 'straight', weight: 3 },
                    { value: 'relaxed jeans', tags: ['casual', 'street'], silhouette: 'relaxed', weight: 3 },
                    { value: 'wide-leg jeans', tags: ['casual', 'street', 'trendy', 'travel'], silhouette: 'wide', weight: 2.5 },
                    { value: 'baggy jeans', tags: ['street', 'trendy', 'casual'], silhouette: 'baggy', weight: 2 },
                    { value: 'high-waisted jeans', tags: ['casual', 'feminine', 'brunch'], silhouette: 'fitted', weight: 3 },
                    { value: 'mom jeans', tags: ['casual', 'feminine', 'street'], silhouette: 'relaxed', weight: 3 },
                    { value: 'light-wash jeans', tags: ['casual', 'summer', 'street'], silhouette: 'straight', weight: 2.5 },
                    { value: 'dark-wash jeans', tags: ['casual', 'street', 'evening'], silhouette: 'straight', weight: 2.5 },
                    { value: 'jeans', tags: ['casual', 'street', 'brunch'], silhouette: 'straight', weight: 3 },
                    { value: 'denim shorts', tags: ['casual', 'summer', 'travel'], silhouette: 'short', weight: 3 },
                    { value: 'high-waisted denim shorts', tags: ['casual', 'summer', 'feminine'], silhouette: 'short', weight: 3 },
                    { value: 'casual shorts', tags: ['casual', 'summer', 'lounge'], silhouette: 'short', weight: 3 },
                    { value: 'loose shorts', tags: ['casual', 'summer', 'lounge'], silhouette: 'short', weight: 3 },
                    { value: 'shorts', tags: ['travel', 'summer', 'casual', 'lounge'], silhouette: 'short', weight: 3 },
                    { value: 'linen shorts', tags: ['summer', 'travel'], silhouette: 'short', weight: 2 },
                    { value: 'athletic shorts', tags: ['gym', 'casual'], silhouette: 'short', weight: 1.5 },
                    { value: 'biker shorts', tags: ['street', 'gym', 'lounge', 'trendy', 'casual'], silhouette: 'short', weight: 1.5 },
                    { value: 'leggings', tags: ['gym', 'lounge', 'casual'], silhouette: 'fitted', weight: 2 },
                    { value: 'flare leggings', tags: ['casual', 'lounge', 'trendy'], silhouette: 'fitted', weight: 2 },
                    { value: 'high-waisted leggings', tags: ['gym'], silhouette: 'fitted', weight: 1 },
                    { value: 'relaxed sweatpants', tags: ['lounge', 'casual'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'wide-leg sweatpants', tags: ['lounge', 'casual', 'street'], silhouette: 'wide', weight: 2.5 },
                    { value: 'lounge pants', tags: ['lounge', 'bedroom', 'casual'], silhouette: 'relaxed', weight: 3 },
                    { value: 'drawstring pants', tags: ['lounge', 'casual'], silhouette: 'relaxed', weight: 2.5 },
                    { value: 'wide-leg trousers', tags: ['evening', 'travel', 'brunch', 'casual'], silhouette: 'wide', weight: 1.5 },
                    { value: 'linen trousers', tags: ['brunch', 'travel', 'summer'], silhouette: 'relaxed', weight: 2 },
                    { value: 'casual cargo pants', tags: ['street', 'casual', 'travel'], silhouette: 'utility', weight: 2.5 },
                    { value: 'cargo pants', tags: ['street', 'trendy', 'travel'], silhouette: 'utility', weight: 2 },
                    { value: 'denim skirt', tags: ['street', 'feminine', 'casual'], silhouette: 'skirt', weight: 2.5 },
                    { value: 'a casual mini skirt', tags: ['feminine', 'street', 'trendy'], silhouette: 'skirt', weight: 2 },
                    { value: 'a simple A-line skirt', tags: ['feminine', 'brunch', 'casual'], silhouette: 'skirt', weight: 2 },
                    { value: 'a midi skirt', tags: ['feminine', 'brunch', 'evening'], silhouette: 'skirt', weight: 1 },
                    { value: 'a pleated skirt', tags: ['feminine', 'brunch'], silhouette: 'skirt', weight: 0.8 },
                    { value: 'a flowy maxi skirt', tags: ['feminine', 'summer', 'travel'], silhouette: 'skirt', weight: 1.5 },
                    { value: 'straight-leg trousers', tags: ['evening', 'brunch', 'travel'], silhouette: 'straight', weight: 1 },
                    { value: 'tailored trousers', tags: ['evening', 'brunch'], silhouette: 'tailored', weight: 0.7 },
                    { value: 'tailored shorts', tags: ['brunch', 'summer'], silhouette: 'short', weight: 1 },
                    { value: 'wide-leg linen pants', tags: ['travel', 'summer'], silhouette: 'wide', weight: 2 },
                    { value: 'dark denim', tags: ['evening', 'casual'], silhouette: 'straight', weight: 2.5 },
                    { value: 'running shorts', tags: ['gym'], silhouette: 'short', weight: 1 }
                ],
                onePieces: [
                    { value: 'a casual sundress', tags: ['summer', 'travel', 'feminine', 'casual'], type: 'dress', weight: 3 },
                    { value: 'a simple T-shirt dress', tags: ['casual', 'summer', 'street'], type: 'dress', weight: 3 },
                    { value: 'a casual tank dress', tags: ['casual', 'summer'], type: 'dress', weight: 2.5 },
                    { value: 'a simple slip dress', tags: ['casual', 'feminine', 'summer'], type: 'dress', weight: 2 },
                    { value: 'a relaxed summer dress', tags: ['travel', 'summer', 'casual'], type: 'dress', weight: 2.5 },
                    { value: 'a lightweight sundress', tags: ['travel', 'summer'], type: 'dress', weight: 2.5 },
                    { value: 'a casual dress', tags: ['casual', 'street', 'brunch'], type: 'dress', weight: 3 },
                    { value: 'a simple mini dress', tags: ['feminine', 'street', 'trendy'], type: 'dress', weight: 1.5 },
                    { value: 'a floral midi dress', tags: ['feminine', 'brunch', 'summer'], type: 'dress', weight: 1 },
                    { value: 'a simple fitted dress', tags: ['evening', 'feminine'], type: 'dress', weight: 1 },
                    { value: 'a matching linen set', tags: ['travel', 'summer', 'brunch'], type: 'set', weight: 1.5 },
                    { value: 'a matching lounge set', tags: ['lounge', 'bedroom'], type: 'set', weight: 2.5 },
                    { value: 'a simple lounge set', tags: ['lounge', 'bedroom', 'casual'], type: 'set', weight: 2.5 },
                    { value: 'a matching athletic set', tags: ['gym'], type: 'set', weight: 1 }
                ],
                // Outerwear is an optional layer, not a core piece: everyday
                // versions (denim, flannel) lead, and structured/styled jackets are
                // kept uncommon so casual photos usually have no outerwear at all.
                outerwear: [
                    { value: 'a denim jacket', tags: ['casual', 'street', 'trendy'], silhouette: 'structured', weight: 1.5 },
                    { value: 'an oversized denim jacket', tags: ['casual', 'street', 'trendy'], silhouette: 'oversized', weight: 1.2 },
                    { value: 'an unbuttoned flannel shirt', tags: ['casual', 'street'], silhouette: 'relaxed', weight: 1.2 },
                    { value: 'a casual zip-up jacket', tags: ['street', 'gym', 'trendy', 'casual'], silhouette: 'relaxed', weight: 0.8 },
                    { value: 'a lightweight zip jacket', tags: ['gym', 'travel'], silhouette: 'fitted', weight: 0.8 },
                    { value: 'a cropped zip jacket', tags: ['street', 'gym', 'trendy'], silhouette: 'cropped', weight: 0.5 },
                    { value: 'a cropped jacket', tags: ['street', 'trendy', 'evening'], silhouette: 'cropped', weight: 0.5 },
                    { value: 'a bomber jacket', tags: ['street', 'trendy'], silhouette: 'oversized', weight: 0.4 },
                    { value: 'a varsity jacket', tags: ['street', 'trendy'], silhouette: 'oversized', weight: 0.3 },
                    { value: 'a structured blazer', tags: ['evening', 'brunch', 'trendy'], silhouette: 'structured', weight: 0.3 }
                ],
                // Sneakers, sandals and flats dominate; heels are reserved for
                // dressier evening scenarios.
                shoes: [
                    { value: 'white sneakers', tags: ['casual', 'street', 'travel', 'trendy', 'summer'], weight: 3 },
                    { value: 'casual sneakers', tags: ['casual', 'street', 'travel'], weight: 3 },
                    { value: 'canvas sneakers', tags: ['casual', 'street', 'summer'], weight: 2.5 },
                    { value: 'sneakers', tags: ['casual', 'street', 'travel', 'trendy'], weight: 3 },
                    { value: 'running shoes', tags: ['gym', 'casual'], weight: 2 },
                    { value: 'athletic sneakers', tags: ['gym'], weight: 1.5 },
                    { value: 'simple sandals', tags: ['summer', 'travel', 'casual'], weight: 2.5 },
                    { value: 'sandals', tags: ['summer', 'travel', 'casual'], weight: 2.5 },
                    { value: 'slides', tags: ['lounge', 'summer', 'casual', 'travel'], weight: 2 },
                    { value: 'flip-flops', tags: ['summer', 'travel', 'casual'], weight: 1.5 },
                    { value: 'casual flats', tags: ['brunch', 'travel', 'feminine', 'casual'], weight: 2.5 },
                    { value: 'ballet flats', tags: ['feminine', 'brunch', 'casual'], weight: 2 },
                    { value: 'ankle boots', tags: ['street', 'evening', 'casual'], weight: 1.5 },
                    { value: 'simple heels', tags: ['evening'], weight: 0.6 }
                ],
                // Subtle everyday accessories only; they stay optional.
                accessories: [
                    { value: 'a small shoulder bag', tags: ['casual', 'brunch', 'street'], weight: 2 },
                    { value: 'a crossbody bag', tags: ['travel', 'street', 'casual'], weight: 2 },
                    { value: 'a small crossbody bag', tags: ['travel', 'street', 'casual'], weight: 2 },
                    { value: 'a tote bag', tags: ['casual', 'brunch', 'travel'], weight: 2 },
                    { value: 'a canvas tote', tags: ['casual', 'travel'], weight: 2 },
                    { value: 'a baseball cap', tags: ['casual', 'street', 'gym'], weight: 1.5 },
                    { value: 'sunglasses', tags: ['travel', 'summer', 'street', 'casual'], weight: 2 },
                    { value: 'a simple necklace', tags: ['evening', 'feminine', 'brunch', 'casual'], weight: 2 },
                    { value: 'a simple gold necklace', tags: ['evening', 'feminine', 'brunch'], weight: 1.5 },
                    { value: 'small hoop earrings', tags: ['feminine', 'brunch', 'casual'], weight: 2 },
                    { value: 'a hair clip', tags: ['feminine', 'brunch', 'casual'], weight: 1.5 },
                    { value: 'a scrunchie', tags: ['feminine', 'casual', 'lounge'], weight: 1.5 },
                    { value: 'a fitness watch', tags: ['gym', 'casual'], weight: 1.5 },
                    { value: 'a simple bracelet', tags: ['feminine', 'casual', 'brunch'], weight: 1.5 }
                ]
            }
        },
        cameras: [
            'candid 35mm framing at eye level',
            'over-the-shoulder documentary composition',
            'loose medium shot that includes the room',
            'close, intimate framing with a shallow depth of field',
            'handheld-feeling frame with natural imperfections'
        ],
        lighting: [
            'soft natural window light',
            'warm window light with soft shadows',
            'gentle golden-hour glow through curtains',
            'bright diffused daylight on an overcast afternoon',
            'dappled light through leaves',
            'the warm pool of a single table lamp at dusk',
            'warm afternoon daylight',
            'bright overcast daylight',
            'everyday indoor lighting',
            'warm lamp light in the evening',
            'the ambient light of a cafe'
        ],
        moods: ['relaxed', 'playful', 'effortless', 'warm', 'spontaneous', 'low-key', 'cheerful', 'cosy',
            'unguarded', 'content'],
        styles: [
            'authentic phone-camera photo, casual and unposed',
            'everyday smartphone snapshot',
            'natural social-media photo with small imperfections',
            'candid personal photo, straight off a phone',
            'relaxed lifestyle photo posted to social media',
            'documentary lifestyle photography',
            'natural light 35mm film look',
            'soft editorial lifestyle imagery',
            'Instagram-natural candid photography'
        ],
        // Positive, casual guidance appended to every Lifestyle & Candid concept so the
        // image never drifts toward a professional photoshoot.
        constraints: [
            'Shoot like an everyday phone snapshot: casual, unposed and natural',
            'Authentic social-media look, not a staged studio session'
        ],
        categories: [
            {
                id: 'casual-selfie',
                label: 'Casual Selfie',
                outfitTags: ['casual', 'lounge', 'feminine'],
                environments: ['a bedroom with soft daylight', 'a sofa at home', 'a balcony', 'a plain wall at home'],
                activities: ['taking a quick selfie', 'smiling at the camera', 'checking the phone after taking a photo'],
                cameras: ["an arm's-length front-facing selfie", 'a front-facing phone camera shot', 'a quick phone snapshot'],
                compositions: ['casual framing, slightly off-center', 'looking into the camera with a natural expression', 'a spontaneous expression']
            },
            {
                id: 'mirror-selfie',
                label: 'Mirror Selfie',
                outfitTags: ['casual', 'feminine', 'street', 'trendy'],
                environments: ['a bedroom mirror', 'a bathroom mirror', 'an elevator mirror', 'a fitting-room mirror'],
                activities: ['taking a mirror selfie', 'showing the outfit in the mirror', 'checking her reflection'],
                cameras: ['a mirror selfie with the phone partly visible', 'a front-facing phone camera shot in the mirror', 'a vertical phone photo of the reflection'],
                compositions: ['the reflection framed in a mirror', 'a relaxed, unposed pose', 'looking at the phone screen']
            },
            {
                id: 'outfit-check',
                label: 'Outfit Check',
                // Outfit checks prioritise visual variety, so every casual
                // silhouette family is in play.
                outfitTags: ['casual', 'feminine', 'street', 'trendy', 'brunch'],
                environments: ['a bedroom', 'a hallway at home', 'a city sidewalk', 'a fitting room'],
                activities: ['showing the outfit', 'turning to show the full look', 'taking a mirror selfie'],
                cameras: ['a full-length handheld phone photo', 'a mirror selfie', 'a quick phone snapshot'],
                compositions: ['a relaxed, unposed pose', 'casual framing, slightly off-center', 'an imperfect crop that feels spontaneous']
            },
            {
                id: 'cafe-coffee',
                label: 'Cafe / Coffee',
                outfitTags: ['casual', 'brunch', 'feminine'],
                environments: ['a table in a cafe', 'a coffee shop window seat', 'a neighbourhood bakery'],
                activities: ['drinking coffee', 'sitting in a cafe', 'waiting for food'],
                cameras: ['a casual phone portrait', 'a handheld phone photo with slightly imperfect framing', 'a quick phone snapshot'],
                compositions: ['a candid moment caught mid-activity', 'a relaxed, unposed pose', 'natural arm position, everyday posture']
            },
            {
                id: 'bedroom-home',
                label: 'Bedroom / Home',
                outfitTags: ['lounge', 'casual', 'bedroom'],
                environments: ['a bedroom', 'a living room', 'a kitchen', 'a cosy corner of the apartment'],
                activities: ['relaxing at home', 'getting ready', 'lounging on the sofa', 'doing skincare'],
                cameras: ['a handheld phone photo with slightly imperfect framing', 'a front-facing phone camera shot', 'a quick phone snapshot'],
                compositions: ['a candid moment caught mid-activity', 'a relaxed, unposed pose', 'an imperfect crop that feels spontaneous']
            },
            {
                id: 'street-city',
                label: 'Street / City',
                outfitTags: ['casual', 'street', 'trendy'],
                environments: ['a city street', 'a crosswalk', 'a storefront sidewalk', 'a parking area'],
                activities: ['walking around the city', 'waiting at the curb', 'checking the phone while out'],
                cameras: ['a handheld phone photo with slightly imperfect framing', 'a phone-camera perspective, shot one-handed', 'a spontaneous phone photo'],
                compositions: ['casual framing, slightly off-center', 'a candid moment caught mid-activity', 'natural arm position, everyday posture']
            },
            {
                id: 'travel',
                label: 'Travel',
                // Vacation looks stay on travel/summer pieces (tanks, tees,
                // linen, shorts, dresses) rather than everyday lounge wear.
                outfitTags: ['travel', 'summer'],
                environments: ['a beach', 'a hotel room', 'an airport terminal', 'a balcony with a view'],
                activities: ['taking a vacation photo', 'sightseeing', 'waiting at the gate', 'walking along the shoreline'],
                cameras: ["an arm's-length front-facing selfie", 'a handheld phone photo with slightly imperfect framing', 'a quick phone snapshot'],
                compositions: ['casual framing, slightly off-center', 'looking into the camera with a natural expression', 'a spontaneous, unplanned composition']
            },
            {
                id: 'shopping',
                label: 'Shopping',
                outfitTags: ['casual', 'trendy', 'street'],
                environments: ['a shopping mall', 'a boutique', 'a fitting room', 'a street of shops'],
                activities: ['shopping', 'holding shopping bags', 'browsing the racks'],
                cameras: ['a handheld phone photo with slightly imperfect framing', 'a mirror selfie', 'a quick phone snapshot'],
                compositions: ['casual framing, slightly off-center', 'a relaxed, unposed pose', 'a spontaneous, unplanned composition']
            },
            {
                id: 'beauty-skincare',
                label: 'Beauty / Skincare',
                outfitTags: ['lounge', 'bedroom', 'casual'],
                environments: ['a bathroom vanity', 'a bedroom mirror', 'a bright dressing table'],
                activities: ['doing skincare', 'applying makeup', 'getting ready'],
                cameras: ['a front-facing phone camera shot', 'a mirror selfie with the phone partly visible', 'a close handheld phone photo'],
                compositions: ['looking at the phone screen', 'a relaxed, unposed pose', 'casual framing, slightly off-center']
            },
            {
                id: 'gym-fitness',
                label: 'Gym / Fitness',
                outfitTags: ['gym'],
                environments: ['a gym', 'a fitness studio', 'a parking area outside the gym', 'a home workout corner'],
                activities: ['leaving the gym', 'a post-workout stretch', 'taking a mirror selfie', 'catching her breath'],
                cameras: ['a mirror selfie with the phone partly visible', 'a handheld phone photo with slightly imperfect framing', 'a front-facing phone camera shot'],
                compositions: ['a relaxed, unposed pose', 'looking into the camera with a natural expression', 'casual framing, slightly off-center']
            },
            {
                id: 'morning-routine',
                label: 'Morning Routine',
                outfitTags: ['lounge', 'casual'],
                environments: ['a bedroom in the morning', 'a kitchen', 'a bathroom', 'a balcony'],
                activities: ['drinking coffee', 'getting ready', 'making breakfast', 'checking the phone'],
                cameras: ['a front-facing phone camera shot', 'a handheld phone photo with slightly imperfect framing', 'a quick phone snapshot'],
                compositions: ['a candid moment caught mid-activity', 'a relaxed, unposed pose', 'natural arm position, everyday posture']
            },
            {
                id: 'night-out',
                label: 'Night Out',
                outfitTags: ['evening'],
                environments: ['a restaurant table', 'a city street at night', 'a bar', 'a car interior'],
                activities: ['waiting for food', 'laughing with friends', 'posing before going out'],
                cameras: ['a handheld phone photo with slightly imperfect framing', 'a quick phone snapshot', "an arm's-length front-facing selfie"],
                compositions: ['a candid moment caught mid-activity', 'a spontaneous expression', 'casual framing, slightly off-center']
            },
            {
                id: 'candid-social',
                label: 'Candid Social Media',
                outfitTags: ['casual', 'brunch', 'lounge'],
                environments: ['an apartment', 'a cafe', 'a city street', 'a car interior'],
                activities: ['checking the phone', 'laughing', 'talking with someone off-camera', 'waiting'],
                cameras: ['a spontaneous phone photo', 'a quick phone snapshot', 'a handheld phone photo with slightly imperfect framing'],
                compositions: ['a candid moment caught mid-activity', 'natural arm position, everyday posture', 'an imperfect crop that feels spontaneous']
            },
            {
                id: 'instagram-story',
                label: 'Instagram Story',
                outfitTags: ['casual', 'street', 'trendy', 'lounge'],
                environments: ['a bedroom', 'a city street', 'a cafe', 'a car interior'],
                activities: ['talking to the camera', 'showing something to the camera', 'walking while filming'],
                cameras: ['a vertical story-format phone photo', 'a front-facing phone camera shot', 'a handheld phone photo with slightly imperfect framing'],
                compositions: ['a vertical phone framing', 'casual framing, slightly off-center', 'looking into the camera with a natural expression']
            }
        ]
    }
];

// The "Anything" theme is a meta-theme: it draws from every other theme's pools
// so the user can ask for a surprise without narrowing the direction first.
// Category-level pools are flattened too, so subcategory ingredients (e.g. the
// Lifestyle & Candid vocabulary) are available to the broadest surprise.
const POOL_KEYS = ['environments', 'activities', 'outfits', 'lighting', 'cameras', 'compositions', 'moods', 'styles'];

function buildAnythingTheme() {
    const pools = {};
    for (const key of POOL_KEYS) pools[key] = [];
    for (const theme of THEMES) {
        for (const key of POOL_KEYS) {
            for (const value of theme[key] || []) pools[key].push(value);
        }
        for (const category of theme.categories || []) {
            for (const key of POOL_KEYS) {
                for (const value of category[key] || []) pools[key].push(value);
            }
        }
    }
    return {
        id: ANYTHING_ID,
        label: 'Anything',
        description: 'Draw freely from every theme — the broadest surprise.',
        aspectRatios: ['1:1', '4:5', '16:9', '9:16'],
        environments: pools.environments,
        activities: pools.activities,
        outfits: pools.outfits,
        lighting: pools.lighting,
        cameras: pools.cameras,
        compositions: pools.compositions,
        moods: pools.moods,
        styles: pools.styles
    };
}

const ANYTHING = buildAnythingTheme();

// Legacy theme ids kept so persisted concepts/presets from before the
// Lifestyle & Candid merge still resolve to the merged theme.
const THEME_ALIASES = {
    'instagram-lifestyle': 'lifestyle-candid'
};

function listThemes() {
    return [ANYTHING].concat(THEMES);
}

function getTheme(id) {
    const key = String(id || '').trim();
    if (!key || key === ANYTHING_ID) return ANYTHING;
    return THEMES.find((t) => t.id === (THEME_ALIASES[key] || key)) || ANYTHING;
}

// Scenario bundles: when a theme declares `scenes`, each entry is a compatible
// combination of fields; picking one keeps the concept internally coherent.
// Themes without explicit scenes fall back to independent picks (below).
function scenariosFor(theme) {
    return Array.isArray(theme.scenes) ? theme.scenes.filter(Boolean) : [];
}

function pick(list, rng) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!arr.length) return '';
    const index = Math.floor(rng() * arr.length) % arr.length;
    return arr[index];
}

// Resolve a subcategory by id or label ("gym-fitness" / "Gym / Fitness").
function resolveCategory(theme, categoryRef) {
    const categories = Array.isArray(theme.categories) ? theme.categories.filter(Boolean) : [];
    const ref = String(categoryRef || '').trim();
    if (!categories.length || !ref) return null;
    const lower = ref.toLowerCase();
    return categories.find((c) => c.id === ref || String(c.label).toLowerCase() === lower) || null;
}

// --- Component-based outfit composition ---------------------------------------
//
// Themes may declare an `outfitSystem` (currently Lifestyle & Candid) whose
// `components` are reusable wardrobe pieces tagged for the subcategories they
// suit. Composing a look from these keeps the catalog small while producing a
// large, believable combination space, and keeps outfits character-agnostic:
// any identity can wear any look. Themes without an `outfitSystem` keep using
// their flat `outfits` pool unchanged.

function normalizeTags(value) {
    if (Array.isArray(value)) return value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
        return value.split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
    }
    return [];
}

// Components compatible with the allowed subcategory tags. With no tags every
// component is eligible; otherwise only matching ones are (so an empty result
// correctly makes that slot unavailable rather than leaking an unfitting piece).
function eligibleComponents(list, allowedTags) {
    const entries = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!allowedTags.length) return entries;
    return entries.filter((entry) => normalizeTags(entry.tags).some((tag) => allowedTags.includes(tag)));
}

// Optional entry weight (`weight`, default 1). Higher = more likely to be
// chosen. Used to keep casual outfits everyday and to keep styled
// pieces (blazers, satin, heels) rare.
function entryWeight(entry) {
    const weight = Number(entry && entry.weight);
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

// Weighted pick with a deterministic offset so a retry (to avoid a repeated
// look) lands on a different candidate instead of returning the same value.
// Deterministic for a given `rng`; a uniform pool (every weight 1) behaves like
// the old list-walking pick.
function weightedPickAt(list, rng, offset = 0) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!arr.length) return '';
    const weights = arr.map((entry) => entryWeight(entry));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0)) return arr[0];
    const raw = Number(rng());
    const base = Number.isFinite(raw) ? ((raw % 1) + 1) % 1 : 0;
    // Golden-ratio offset: each retry shifts the target without ever collapsing
    // back onto the same candidate.
    const target = ((base + (offset * 0.6180339887498949)) % 1) * total;
    let acc = 0;
    for (let i = 0; i < arr.length; i++) {
        acc += weights[i];
        if (target < acc) return arr[i];
    }
    return arr[arr.length - 1];
}

// Normalized outfit identity used to detect exact repeats.
function outfitSignature(outfit) {
    return String(outfit || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function joinPhrases(parts) {
    const list = (Array.isArray(parts) ? parts : []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function availableArchetypes(system, components, allowedTags, pinned) {
    const has = (key) => eligibleComponents(components[key], allowedTags).length > 0;
    const all = Array.isArray(system.archetypes) ? system.archetypes.filter(Boolean) : [];
    const wanted = pinned && pinned.length ? all.filter((a) => pinned.includes(a.id)) : all;
    const usable = wanted.filter((a) => (Array.isArray(a.requires) ? a.requires : []).every(has));
    if (usable.length) return usable;
    return wanted.length ? wanted : all;
}

function composeOnce(system, components, allowedTags, archetype, rng, offset, includeShoes, includeAccessory) {
    const outfitParts = [];
    const chosen = { top: '', bottom: '', onePiece: '', outerwear: '', shoes: '', accessories: '' };
    const tops = eligibleComponents(components.tops, allowedTags);
    const bottoms = eligibleComponents(components.bottoms, allowedTags);
    const onePieces = eligibleComponents(components.onePieces, allowedTags);
    const outerwear = eligibleComponents(components.outerwear, allowedTags);

    let silhouette = archetype;
    if (archetype === 'one-piece' && onePieces.length) {
        const piece = weightedPickAt(onePieces, rng, offset);
        chosen.onePiece = piece.value;
        silhouette = piece.type || 'dress';
        outfitParts.push(piece.value);
    } else if (archetype === 'layered' && outerwear.length) {
        const layer = weightedPickAt(outerwear, rng, offset);
        chosen.outerwear = layer.value;
        silhouette = 'layered+' + (layer.silhouette || 'outerwear');
        if (onePieces.length && offset % 2 === 1) {
            const piece = weightedPickAt(onePieces, rng, offset);
            chosen.onePiece = piece.value;
            outfitParts.push(layer.value + ' over ' + piece.value);
        } else if (bottoms.length) {
            const bottom = weightedPickAt(bottoms, rng, offset);
            chosen.bottom = bottom.value;
            if (tops.length && offset % 2 === 0) {
                const top = weightedPickAt(tops, rng, offset);
                chosen.top = top.value;
                outfitParts.push(layer.value + ' over ' + top.value + ' with ' + bottom.value);
            } else {
                outfitParts.push(layer.value + ' with ' + bottom.value);
            }
        }
    } else if (tops.length && bottoms.length) {
        const top = weightedPickAt(tops, rng, offset);
        const bottom = weightedPickAt(bottoms, rng, offset);
        chosen.top = top.value;
        chosen.bottom = bottom.value;
        silhouette = 'separates+' + (top.silhouette || 'top') + '+' + (bottom.silhouette || 'bottom');
        outfitParts.push(top.value + ' with ' + bottom.value);
    } else if (onePieces.length) {
        const piece = weightedPickAt(onePieces, rng, offset);
        chosen.onePiece = piece.value;
        silhouette = piece.type || 'dress';
        outfitParts.push(piece.value);
    }

    if (includeShoes) {
        const shoe = weightedPickAt(eligibleComponents(components.shoes, allowedTags), rng, offset);
        if (shoe && shoe.value) { chosen.shoes = shoe.value; outfitParts.push(shoe.value); }
    }
    if (includeAccessory) {
        const accessory = weightedPickAt(eligibleComponents(components.accessories, allowedTags), rng, offset);
        if (accessory && accessory.value) { chosen.accessories = accessory.value; outfitParts.push(accessory.value); }
    }
    return { outfit: joinPhrases(outfitParts), silhouette, components: chosen };
}

// Assemble one outfit for a category. Retries (with a shifting offset) until the
// signature is not in `options.avoidSignatures`, so consecutive surprises avoid
// repeating an exact look. Deterministic for a given `rng`.
function composeOutfit(system, category, rng = Math.random, options = {}) {
    const components = (system && system.components) || {};
    const allowedTags = normalizeTags(options.tags || (category && category.outfitTags) || system.defaultTags || []);
    const avoid = new Set((Array.isArray(options.avoidSignatures) ? options.avoidSignatures : [])
        .map((s) => outfitSignature(s)).filter(Boolean));
    const previousArchetype = String(options.previousArchetype || '').trim();
    const pinned = (Array.isArray(options.archetypes) && options.archetypes.length)
        ? options.archetypes
        : (category && Array.isArray(category.outfitArchetypes) ? category.outfitArchetypes : []);
    let archetypes = availableArchetypes(system, components, allowedTags, pinned);
    if (!archetypes.length) archetypes = [{ id: 'separates', requires: ['tops', 'bottoms'] }];
    // Encourage a structural change (separates <-> one-piece <-> layered) rather
    // than another variation of the previous silhouette.
    if (archetypes.length > 1 && previousArchetype) {
        const filtered = archetypes.filter((a) => a.id !== previousArchetype);
        if (filtered.length) archetypes = filtered;
    }
    // Accessories stay optional (many casual photos show none) and shoes are
    // almost always present. Both rolls happen once so retries keep the slots.
    const wantsShoes = rng() < 0.95;
    const wantsAccessory = rng() < 0.4;
    const maxTries = 16;
    let best = null;
    for (let attempt = 0; attempt < maxTries; attempt++) {
        const archetype = weightedPickAt(archetypes, rng, attempt).id || 'separates';
        const composed = composeOnce(
            system, components, allowedTags, archetype, rng, attempt,
            wantsShoes && attempt % 3 !== 1,
            wantsAccessory && attempt % 4 !== 2
        );
        if (!composed.outfit) continue;
        composed.archetype = archetype;
        composed.signature = outfitSignature(composed.outfit);
        if (!best) best = composed;
        if (!avoid.has(composed.signature)) { best = composed; break; }
    }
    if (!best) return { outfit: '', signature: '', archetype: '', silhouette: '', components: {} };
    return best;
}

// Pick a compatible creative scenario from a theme. Priority: an explicit
// subcategory (drawing from that category's pools, with theme-level fallback),
// then an explicit scene bundle, then independent picks per field. `rng` is
// injectable for tests and `categoryRef` pins a subcategory when one is named.
// `options.avoidOutfitSignatures`/`options.previousOutfitArchetype` reduce
// repeated looks for themes with an `outfitSystem`.
function pickScenario(theme, rng = Math.random, categoryRef = '', options = {}) {
    const categories = Array.isArray(theme.categories) ? theme.categories.filter(Boolean) : [];
    if (categories.length) {
        const category = resolveCategory(theme, categoryRef) || pick(categories, rng);
        const pickFrom = (key) => {
            if (Array.isArray(category[key]) && category[key].length) return pick(category[key], rng);
            return pick(theme[key], rng);
        };
        const scenario = {
            category: category.label,
            categoryId: category.id,
            environment: pickFrom('environments'),
            activity: pickFrom('activities'),
            outfit: '',
            lighting: pickFrom('lighting'),
            camera: pickFrom('cameras'),
            composition: pickFrom('compositions'),
            mood: pickFrom('moods'),
            style: pickFrom('styles')
        };
        if (theme.outfitSystem) {
            const composed = composeOutfit(theme.outfitSystem, category, rng, {
                tags: category.outfitTags,
                archetypes: category.outfitArchetypes,
                avoidSignatures: options.avoidOutfitSignatures,
                previousArchetype: options.previousOutfitArchetype
            });
            scenario.outfit = composed.outfit || pickFrom('outfits');
            scenario.outfitSignature = composed.signature || '';
            scenario.outfitArchetype = composed.archetype || '';
            scenario.outfitSilhouette = composed.silhouette || '';
        } else {
            scenario.outfit = pickFrom('outfits');
        }
        return scenario;
    }
    // Technique-driven themes (Experimental Photography): choose ONE dominant
    // technique, then draw its camera / lighting / activity / environment /
    // material from that technique's own pool so the effects stay coherent
    // instead of stacking. A technique may leave a slot empty to fall back to the
    // theme-level pool.
    if (Array.isArray(theme.techniques) && theme.techniques.length) {
        const technique = pick(theme.techniques, rng);
        const fromTechnique = (key) => {
            const local = Array.isArray(technique[key]) ? technique[key].filter(Boolean) : [];
            return pick(local.length ? local : theme[key], rng);
        };
        return {
            technique: technique.id || '',
            techniqueLabel: technique.label || '',
            environment: fromTechnique('environments'),
            activity: fromTechnique('activities'),
            outfit: pick(theme.outfits, rng),
            lighting: fromTechnique('lighting'),
            camera: fromTechnique('cameras'),
            composition: pick(theme.compositions, rng),
            texture: fromTechnique('textures'),
            mood: pick(theme.moods, rng),
            style: pick(theme.styles, rng)
        };
    }
    const chosen = rng();
    const scenes = scenariosFor(theme);
    if (scenes.length) {
        const scene = pick(scenes, () => chosen);
        return Object.assign({}, scene);
    }
    return {
        environment: pick(theme.environments, rng),
        activity: pick(theme.activities, rng),
        outfit: pick(theme.outfits, rng),
        lighting: pick(theme.lighting, rng),
        camera: pick(theme.cameras, rng),
        composition: pick(theme.compositions, rng),
        mood: pick(theme.moods, rng),
        style: pick(theme.styles, rng)
    };
}

function pickAspectRatio(theme, rng = Math.random) {
    return pick(theme.aspectRatios, rng) || '4:5';
}

module.exports = {
    ANYTHING_ID,
    POOL_KEYS,
    THEMES,
    listThemes,
    getTheme,
    resolveCategory,
    pickScenario,
    pickAspectRatio,
    composeOutfit,
    eligibleComponents,
    outfitSignature
};
