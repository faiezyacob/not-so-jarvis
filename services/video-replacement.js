/* ============================================
   JARVIS — Video Character Replacement
   A dedicated workflow adapter that edits an
   EXISTING video by replacing the person/people in
   it with identities supplied as image references,
   using MiniMax H3's native reference-to-video node
   (`MiniMaxH3ReferenceToVideo`).

   This is deliberately separate from the ordinary
   H3 I2V/T2V pipeline and from Creator Studio / UGC
   Studio / the Director: those are untouched. This
   adapter only runs when the user references a
   source video AND replacement image(s) in one
   natural-language instruction inside chat.

   The source video is the scene/motion reference; the
   replacement images are identity references. H3
   never receives a first frame here — it receives a
   decoded source video plus image references, so
   motion, camera and timing are inherited from the
   real footage instead of being re-invented.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('./comfyui');
const generatedHistory = require('./generated-history');
const generationQueue = require('./generation-queue');
const videoGenerator = require('./video-generator');

const H3_FPS = videoGenerator.H3_FPS || 24;
const REPLACEMENT_NODE = 'MiniMaxH3ReferenceToVideo';
const SOURCE_VIDEO_NODE = 'VHS_LoadVideo';
const REQUIRED_NODES = [REPLACEMENT_NODE, SOURCE_VIDEO_NODE];
const DEFAULT_REF_UNET = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
// Verified against the installed ComfyUI node schema
// (comfy_extras/nodes_minimax_h3.py MiniMaxH3ReferenceToVideo): the reference
// image AutoGrow input accepts at most 9 entries. Extra mappings are never
// silently dropped; the plan is rejected with a clear message instead.
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;
// Opt-in subject-mask compositing. All of these are CORE ComfyUI nodes
// (comfy_extras/nodes_sam3.py + nodes_mask.py), plus the SAM3 checkpoint.
const MASK_NODES = Object.freeze([
    'CheckpointLoaderSimple', 'CLIPTextEncode', 'ImageFromBatch',
    'SAM3_Detect', 'SAM3_VideoTrack', 'SAM3_TrackToMask',
    'GrowMask', 'ImageCompositeMasked'
]);
const DEFAULT_SAM3_CHECKPOINT = videoGenerator.H3_REPLACEMENT_MASK_DEFAULT_MODEL || 'sam3.1_multiplex_fp16.safetensors';

const DATA_DIR = path.join(__dirname, '..', 'data');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(DATA_DIR, 'generated');

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|avi|mkv)$/i;

// How the user asks to swap people. Deliberately verb-led so ordinary video
// generation ("make a video of...") is never captured. Covers the natural
// phrasings: replace/swap/switch X with/for Y, "put X in", "use X in".
const REPLACEMENT_VERB_RE = /\b(?:replace|replacing|swap|swapping|switch|switching|substitute|substituting)\b|\bput\b[^.]{0,60}?\b(?:in|into|from)\b|\buse\b[^.]{0,60}?\b(?:in|into|inside)\b/i;
// Motion transfer: "make @image3 perform the same action as the person in
// @video1" is a single-identity replacement with the source providing motion.
const MOTION_TRANSFER_RE = /\b(?:perform\s+the\s+same|same\s+(?:action|movement|motion|gestures?)|do\s+what)\b/i;
// The replacement must target a person/identity (not a background/object),
// unless an explicit @video/@image reference makes the intent concrete.
const PERSON_WORD_RE = /\b(?:person|people|man|woman|guy|girl|character|characters|face|faces|identity|identities|someone|body|bodies|woman's|man's|their)\b/i;
// A request that is explicitly about editing an existing clip rather than
// generating a new one.
const SOURCE_VIDEO_WORD_RE = /\b(?:source\s+video|original\s+video|this\s+video|the\s+video|existing\s+video|@video|video\s*\d+)\b/i;

// Explicit ordering / mapping cues that make multi-image→multi-person
// assignment unambiguous.
const MAPPING_CUE_RE = /\b(?:respectively|in\s+that\s+order|in\s+the\s+same\s+order|first|second|third|1st|2nd|3rd|left|right|->|=>|→|to\s+the\s+(?:man|woman|person|guy|girl))\b/i;

const REFERENCE_TOKEN_RE = /@image\s*\d+\b|@video\s*\d+\b/gi;

function clampToRange(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function safeFilename(name) {
    return String(name || 'x').replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').slice(0, 100) || 'x';
}

function ensureGeneratedDir() {
    if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function isVideoFilename(name) {
    return VIDEO_EXT_RE.test(String(name || ''));
}

// --- Intent detection ---------------------------------------------------------

// Conservative detector: a replacement verb is required, and the request must
// be about an existing/source video. Missing pieces are reported so the server
// can ask a concise follow-up instead of guessing.
function detectReferenceReplacement(message, options = {}) {
    const text = String(message || '');
    const hasVideoReference = options.hasVideoReference === true ||
        /\b@video\s*\d+\b/i.test(text) || /\bvideo\s*\d+\b/i.test(text);
    const hasImageReference = options.hasImageReference === true ||
        /\b@image\s*\d+\b/i.test(text) || /\bimage\s*\d+\b/i.test(text);
    const replacementCue = REPLACEMENT_VERB_RE.test(text) || MOTION_TRANSFER_RE.test(text);
    const sourceVideoCue = SOURCE_VIDEO_WORD_RE.test(text);
    const personCue = PERSON_WORD_RE.test(text);
    const detected = replacementCue && (hasVideoReference || sourceVideoCue) && (personCue || hasVideoReference || hasImageReference);
    return {
        detected,
        hasVideoReference,
        hasImageReference,
        needsVideo: detected && !hasVideoReference,
        needsImages: detected && !hasImageReference
    };
}

// --- Request understanding: count, targets, transfer and preservation --------
//
// The user's natural-language request determines HOW MANY people to replace and
// WHICH attributes move from each reference image. The number of targets is
// never assumed to equal the number of uploaded images: an explicit count wins,
// a singular phrasing means one target, "everyone" means every supplied
// identity, and a plural phrasing means the images provided.

const REPLACEMENT_MODES = Object.freeze(['identity_only', 'identity_and_outfit', 'full_appearance']);

const CLOTHING_WORD_RE = /\b(?:clothes|clothing|outfit|outfits|wardrobe|attire|garments?|apparel)\b/i;

const COUNT_WORDS = Object.freeze({ one: 1, a: 1, an: 1, single: 1, two: 2, both: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 });
const COUNT_WORD_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|both|single|a|an)\s+(?:of\s+the\s+)?(?:people|persons?|characters?|actors?|subjects?|men|women|guys|girls|individuals?|figures?)\b/i;
// "everyone"/"all of them"/"the whole group" — every supplied identity is a
// target, so the count follows the reference images and no non-target people
// remain.
const ALL_TARGETS_RE = /\b(?:all(?:\s+of\s+(?:them|the\s+people|the\s+characters))?|everyone|everybody|every\s+person|each\s+person|the\s+whole\s+(?:group|cast)|all\s+the\s+(?:people|persons|characters|actors|subjects))\b/i;
const PLURAL_TARGET_RE = /\b(?:people|persons|characters|actors|subjects|men|women|guys|girls|individuals|figures|both|group|cast)\b/i;
const SINGULAR_TARGET_RE = /\b(?:the|a|an|one|this|that)\s+(?:person|man|woman|guy|girl|character|individual|figure|someone|somebody)\b/i;

// Positional descriptors in the order they appear in the request.
const TARGET_DESCRIPTORS = Object.freeze([
    { id: 'left', label: 'person on the left', re: /(?:on|to|at)\s+the\s+left\b|\b(?:the\s+)?left\s+(?:person|man|woman|guy|girl|one|character|figure)\b|\bleftmost\b/i },
    { id: 'right', label: 'person on the right', re: /(?:on|to|at)\s+the\s+right\b|\b(?:the\s+)?right\s+(?:person|man|woman|guy|girl|one|character|figure)\b|\brightmost\b/i },
    { id: 'middle', label: 'person in the middle', re: /(?:in|at)\s+the\s+(?:middle|centre|center)\b|\b(?:the\s+)?(?:middle|centre|center)\s+(?:person|man|woman|guy|girl|one|character)\b|\bcent(?:re|er)(?:most)?\b/i },
    { id: 'foreground', label: 'person in the foreground', re: /\b(?:person|man|woman|guy|girl|character|figure|one|people)\s+(?:in|at)\s+the\s+foreground\b|\b(?:the\s+)?foreground\s+(?:person|man|woman|guy|girl|character|figure)\b|\bnearest\b|\bclosest\s+to\s+the\s+camera\b/i },
    { id: 'background', label: 'person in the background', re: /\b(?:person|man|woman|guy|girl|character|figure|one|people)\s+(?:in|at)\s+the\s+background\b|\b(?:the\s+)?background\s+(?:person|man|woman|guy|girl|character|figure)\b|\bfarthest\b|\bfurthest\b/i }
]);

const GENDER_DESCRIPTORS = Object.freeze([
    { id: 'woman', label: 'woman', re: /\b(?:the\s+)?(?:woman|girl|lady)\b/i },
    { id: 'man', label: 'man', re: /\b(?:the\s+)?(?:man|guy|gentleman)\b/i }
]);

function safeCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function countFromWord(raw) {
    const value = String(raw || '').toLowerCase();
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    return COUNT_WORDS[value] || 0;
}

// Infer how many people the user asked to replace. `explicit` marks a
// user-stated count that must be reconciled against the supplied images.
function inferReplacementCount(message, imageCount) {
    const text = String(message || '');
    const images = safeCount(imageCount);
    // "leave everyone else unchanged" must not be read as "replace everyone".
    const scan = text.replace(/\b(?:everyone|everybody|all(?:\s+of\s+them)?|all\s+the\s+(?:people|persons|characters))\s+else\b/gi, ' ');
    if (ALL_TARGETS_RE.test(scan)) return { count: images, scope: 'all', explicit: true };
    const m = COUNT_WORD_RE.exec(text);
    if (m) {
        const n = countFromWord(m[1]);
        if (n > 0) return { count: n, scope: 'explicit', explicit: true };
    }
    if (SINGULAR_TARGET_RE.test(text) && !PLURAL_TARGET_RE.test(text) && images > 1) {
        return { count: 1, scope: 'singular', explicit: true };
    }
    if (PLURAL_TARGET_RE.test(text)) return { count: images, scope: 'plural', explicit: false };
    return { count: images, scope: 'images', explicit: false };
}

function normalizePosition(word) {
    const w = String(word || '').toLowerCase();
    if (w === 'centre' || w === 'center') return 'middle';
    return w;
}

// Ordered positional (or, failing that, gender) descriptors the request names.
function extractTargetDescriptors(message) {
    const text = String(message || '');
    const positions = [];
    for (const d of TARGET_DESCRIPTORS) {
        const m = d.re.exec(text);
        if (m) positions.push({ index: m.index, id: d.id, position: d.id, label: 'person ' + (d.id === 'middle' ? 'in the middle' : 'on the ' + d.id) });
    }
    positions.sort((a, b) => a.index - b.index);
    if (positions.length) {
        // Attach an explicit gender to the matching position ("the woman on the left").
        positions.forEach((item) => {
            const gm = new RegExp('\\b(?:the\\s+)?(woman|girl|lady|man|guy|gentleman)\\s+(?:on|to|at|in)\\s+the\\s+(' + item.position + '|centre|center)\\b', 'i').exec(text);
            if (gm) {
                item.gender = String(gm[1]).toLowerCase();
                item.label = 'the ' + item.gender + ' ' + (item.position === 'middle' ? 'in the middle' : 'on the ' + item.position);
            }
        });
        return positions;
    }
    const genders = [];
    for (const g of GENDER_DESCRIPTORS) {
        const m = g.re.exec(text);
        if (m) genders.push({ index: m.index, id: g.id, gender: g.id, label: 'the ' + g.label });
    }
    genders.sort((a, b) => a.index - b.index);
    return genders;
}

// Explicit positional→image pairings ("the person on the left with @image1 and
// the person on the right with @image2"). Returns { position: imageIndex }.
function extractTargetImageBindings(message) {
    const text = String(message || '');
    const bindings = {};
    const forward = /\b(?:the\s+)?(?:person|man|woman|guy|girl|character|figure|one)\s+(?:on|to|at|in)\s+the\s+(left|right|middle|centre|center)\b[^.!?]{0,60}?(?:@image|@picture|image|picture)\s*(\d+)/gi;
    const reverse = /(?:@image|@picture|image|picture)\s*(\d+)[^.!?]{0,60}?\b(?:the\s+)?(?:person|man|woman|guy|girl|character|figure)\s+(?:on|to|at|in)\s+the\s+(left|right|middle|centre|center)\b/gi;
    let m;
    while ((m = forward.exec(text))) {
        const pos = normalizePosition(m[1]);
        if (!bindings[pos]) bindings[pos] = parseInt(m[2], 10);
    }
    while ((m = reverse.exec(text))) {
        const pos = normalizePosition(m[2]);
        if (!bindings[pos]) bindings[pos] = parseInt(m[1], 10);
    }
    return bindings;
}

// Map the inferred targets onto the supplied reference images. Explicit
// positional bindings are applied only when they form a complete, non-repeating
// permutation; otherwise the images are assigned in the order they were given.
function buildTargets(descriptors, count, bindings, replacements) {
    const targets = [];
    for (let i = 0; i < count; i += 1) {
        const d = descriptors[i];
        targets.push({
            index: i + 1,
            sourceSubjectId: 'subject-' + (i + 1),
            description: d && d.label ? d.label : ('person ' + (i + 1)),
            position: d && d.position ? d.position : null,
            gender: d && d.gender ? d.gender : null,
            referenceIndex: i + 1
        });
    }
    const ordered = replacements.slice();
    if (descriptors.length === count && count > 1) {
        const wanted = [];
        let complete = true;
        for (const t of targets) {
            const bound = t.position ? bindings[t.position] : undefined;
            if (!bound || bound < 1 || bound > count || wanted.includes(bound)) { complete = false; break; }
            wanted.push(bound);
        }
        if (complete) {
            targets.forEach((t, i) => {
                t.referenceIndex = bindings[t.position];
                ordered[i] = replacements[bindings[t.position] - 1];
            });
        }
    }
    return { targets, orderedReplacements: ordered };
}

// `identity_only` is the default: transfer the face/hair and preserve the
// source clothing. `identity_and_outfit` additionally copies clothing and
// accessories from the reference; `full_appearance` copies everything.
function transferAttributesFor(mode) {
    if (mode === 'full_appearance') return { identity: true, hair: true, clothing: true, accessories: true, body: true };
    if (mode === 'identity_and_outfit') return { identity: true, hair: true, clothing: true, accessories: true, body: false };
    return { identity: true, hair: true, clothing: false, accessories: false, body: false };
}

function resolveReplacementMode(message) {
    const text = String(message || '');
    if (/\b(?:full|complete|entire|whole)\s+(?:look|appearance|outfit|character|identity)\b/i.test(text) ||
        /\b(?:everything|all\s+of\s+(?:her|his|their)\s+(?:look|appearance))\b/i.test(text)) {
        return 'full_appearance';
    }
    const clothing = '(?:clothes|clothing|outfits?|wardrobe|attire|garments?|apparel)';
    // Transfer wins when the clothing is bound to a reference source
    // ("outfits from the images", "use the clothing from @image1") — including
    // "keep their outfits from the images", where "keep" means keep the
    // reference's outfit, not the source's.
    const clothingTransfer =
        new RegExp('\\b' + clothing + '\\b[^.!?]{0,30}?\\bfrom\\b', 'i').test(text) ||
        new RegExp('\\bfrom\\b[^.!?]{0,30}?\\b' + clothing + '\\b', 'i').test(text) ||
        new RegExp('\\b(?:use|transfer|copy|apply|adopt|take|reuse|wearing|wear|dressed\\s+in)\\b[^.!?]{0,30}?\\b' + clothing + '\\b', 'i').test(text);
    if (clothingTransfer) return 'identity_and_outfit';
    const clothingPreserve =
        /\bidentity[- ]only\b/i.test(text) ||
        new RegExp('\\b(?:keep|preserve|retain|maintain|leave|same|original)\\b[^.!?]{0,30}?\\b' + clothing + '\\b', 'i').test(text) ||
        /\bonly\s+(?:the\s+)?(?:face|faces|identity|look|appearance)\b/i.test(text) ||
        /\bjust\s+(?:the\s+)?(?:face|faces|identity)\b/i.test(text);
    if (clothingPreserve) return 'identity_only';
    return 'identity_only';
}

// What must be preserved from the source video. Defaults preserve everything;
// only an explicit request to change an element flips it.
function resolvePreservation(message, mode, options = {}) {
    const text = String(message || '');
    const changed = (noun) => new RegExp('\\b(?:change|alter|replace|swap|different|new)\\b[^.!?]{0,30}\\b(?:the\\s+|their\\s+|her\\s+|his\\s+)?(?:' + noun + ')\\b', 'i').test(text);
    const scope = options.countScope || '';
    return {
        motion: !changed('motion|movement|action|gestures?|performance|choreography|pose'),
        background: !changed('background|scene|environment|setting|location'),
        camera: !changed('camera|framing|shot|angle|viewpoint'),
        timing: !changed('timing|pacing|duration|speed|tempo'),
        clothing: mode === 'identity_only',
        nonTargetPeople: scope !== 'all' && !/\b(?:remove|delete|erase|hide)\b[^.!?]{0,25}\b(?:the\s+)?(?:other|remaining|rest\s+of\s+the)\s+(?:people|persons|characters|group)\b/i.test(text),
        sceneObjects: !changed('objects?|props?|furniture|set'),
        audio: !/\b(?:remove|strip|delete|mute|silence)\b[^.!?]{0,25}\b(?:audio|sound|track|music|soundtrack|voice)\b/i.test(text) &&
            !/\b(?:no|without)\s+(?:audio|sound|music)\b/i.test(text)
    };
}

// The source audio can be supplied to the reference node as a synchronized
// audio reference, but this pipeline does not re-mux the original track, so
// sample-exact 1:1 preservation is never claimed.
function resolveAudioPolicy(message, hasAudio) {
    if (!hasAudio) return { policy: 'none', note: 'The source video has no audio track.' };
    const text = String(message || '');
    if (/\b(?:remove|strip|delete|mute|silence)\b[^.!?]{0,25}\b(?:audio|sound|track|music|soundtrack|voice)\b/i.test(text) ||
        /\b(?:no|without)\s+(?:audio|sound|music)\b/i.test(text)) {
        return { policy: 'none', note: 'Audio removal was requested.' };
    }
    return {
        policy: 'partially_copy',
        note: 'The source audio is supplied to the model as a synchronized audio reference; the original dialogue, ambience and music are retained wherever the model reproduces them. This pipeline does not remux the original track, so sample-exact 1:1 preservation is not guaranteed.'
    };
}

function sourceHasAudio(asset) {
    if (!asset || !asset.absPath) return false;
    try { return hasLikelyAudioTrack(fs.readFileSync(asset.absPath)); } catch (_) { return false; }
}

function parseReplacementRequest(message, options = {}) {
    const imageCount = Array.isArray(options.replacements) ? options.replacements.length : safeCount(options.imageCount);
    const count = inferReplacementCount(message, imageCount);
    const descriptors = extractTargetDescriptors(message);
    // Two or more distinct positional targets ("the person on the right and the
    // person on the left") outrank a singular noun phrase.
    if (descriptors.length > count.count) {
        count.count = descriptors.length;
        count.scope = 'explicit';
        count.explicit = true;
    }
    const bindings = extractTargetImageBindings(message);
    const mode = resolveReplacementMode(message);
    const preserve = resolvePreservation(message, mode, { countScope: count.scope });
    const audio = resolveAudioPolicy(message, options.hasAudio === true);
    return { imageCount, count, descriptors, bindings, mode, preserve, audio };
}

// --- Plan construction --------------------------------------------------------

// Extra direction beyond the replacement instruction itself ("make her smile",
// "keep the lighting warm"). Pure replacement sentences are dropped so the
// prompt never repeats a garbled version of the mapping it already encodes.
const REPLACEMENT_SENTENCE_RE = /\b(?:replace|replacing|swap|swapping|switch|switching|substitute|substituting)\b/i;

function extractExtraDirection(message) {
    const text = String(message || '')
        .replace(REFERENCE_TOKEN_RE, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[\[[^\]]*\]\]/g, ' ');
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    return sentences
        .filter((s) => !REPLACEMENT_SENTENCE_RE.test(s))
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;!?])/g, '$1')
        .trim();
}

// Build the structured replacement plan from already-resolved assets. Returns
// { ok:true, plan } or { ok:false, error, code } — the ambiguity results also
// carry the (candidate) `plan` and `ambiguous:true` so the UI can confirm the
// assumed mapping in one click. `assumeOrder` skips the ambiguity gates (used
// after the user confirms).
function buildPlanObject(options = {}) {
    const message = String(options.message || '');
    const replacements = Array.isArray(options.replacements) ? options.replacements.filter(Boolean) : [];
    const request = parseReplacementRequest(message, { replacements, hasAudio: options.hasAudio === true });
    const additionalInstructions = extractExtraDirection(message);
    const { targets, orderedReplacements } = buildTargets(request.descriptors, replacements.length, request.bindings, replacements);
    return {
        intent: 'video_character_replacement',
        sourceVideo: options.sourceVideo || null,
        replacements: orderedReplacements,
        targets,
        targetMapping: targets.map((t) => ({ targetId: t.sourceSubjectId, description: t.description, referenceIndex: t.referenceIndex })),
        replaceCount: orderedReplacements.length,
        countScope: request.count.scope,
        replaceMode: request.mode,
        transfer: transferAttributesFor(request.mode),
        preserve: request.preserve,
        audioPolicy: request.audio.policy,
        audioNote: request.audio.note,
        additionalInstructions,
        requestedDuration: options.requestedDuration || null,
        assumedOrder: orderedReplacements.length > 1 && !MAPPING_CUE_RE.test(message)
    };
}

function buildReplacementPlan(options = {}) {
    const message = String(options.message || '');
    const replacements = Array.isArray(options.replacements) ? options.replacements.filter(Boolean) : [];
    if (!options.sourceVideo) {
        return {
            ok: false,
            code: 'replacement_source_video_missing',
            error: 'I need the source video to edit. Reference the clip with @video1 (or generate one first), then ask me to replace the people in it.'
        };
    }
    if (!replacements.length) {
        return {
            ok: false,
            code: 'replacement_images_missing',
            error: 'I need at least one replacement image. Reference who should appear with @image1 (an uploaded image or one generated earlier), then try again.'
        };
    }
    if (replacements.length > MAX_REFERENCE_IMAGES) {
        return {
            ok: false,
            code: 'replacement_reference_limit',
            error: 'This workflow accepts up to ' + MAX_REFERENCE_IMAGES + ' replacement images at once, but ' +
                replacements.length + ' were provided. Split the request into groups of ' + MAX_REFERENCE_IMAGES + ' or fewer.'
        };
    }
    const hasAudio = options.hasAudio !== undefined ? options.hasAudio === true : sourceHasAudio(options.sourceVideo);
    const request = parseReplacementRequest(message, { replacements, hasAudio });
    const statedCount = request.count.explicit ? request.count.count : 0;
    if (statedCount > replacements.length) {
        return {
            ok: false,
            code: 'replacement_images_insufficient',
            error: 'You asked to replace ' + statedCount + ' people, but only ' + replacements.length +
                ' reference image' + (replacements.length === 1 ? ' was' : 's were') + ' provided. Add ' +
                (statedCount - replacements.length) + ' more, or say to replace fewer.'
        };
    }
    if (statedCount > 0 && statedCount < replacements.length) {
        // The user named fewer people than images: never silently drop images.
        const trimmed = replacements.slice(0, statedCount);
        const plan = buildPlanObject({ ...options, message, replacements: trimmed, hasAudio });
        plan.countAdjusted = true;
        plan.ignoredReferences = replacements.slice(statedCount).map(serializePlanAsset).filter(Boolean);
        if (options.assumeOrder !== true) {
            return {
                ok: false,
                code: 'replacement_count_mismatch',
                error: 'You named ' + statedCount + ' target people but supplied ' + replacements.length +
                    ' reference images. Confirm using only the first ' + statedCount + ', or add the missing target.',
                ambiguous: true,
                plan
            };
        }
        return { ok: true, plan };
    }
    const plan = buildPlanObject({ ...options, message, replacements, hasAudio });
    if (plan.assumedOrder && options.assumeOrder !== true) {
        return {
            ok: false,
            code: 'replacement_mapping_ambiguous',
            error: 'Both replacement images are ready, but I need to confirm who replaces whom.',
            ambiguous: true,
            plan
        };
    }
    return { ok: true, plan };
}

// Rebuild a plan from a serialized card payload (after the user confirms).
// Every filename is re-resolved by the caller against the conversation
// registry; this only restores the structured direction the card carried.
function rehydrateReplacementPlan(serialized, sourceVideo, replacements) {
    const raw = serialized || {};
    const ordered = Array.isArray(replacements) ? replacements.filter(Boolean) : [];
    const count = ordered.length;
    const mode = REPLACEMENT_MODES.includes(raw.replacementMode) ? raw.replacementMode : 'identity_only';
    const preserve = Object.assign(
        resolvePreservation(raw.additionalInstructions || '', mode, { countScope: raw.countScope }),
        raw.preserve || {}
    );
    const targets = (Array.isArray(raw.targets) && raw.targets.length === count)
        ? raw.targets.map((t, i) => ({
            index: i + 1,
            sourceSubjectId: t.sourceSubjectId || ('subject-' + (i + 1)),
            description: t.description || ('person ' + (i + 1)),
            position: t.position || null,
            referenceIndex: t.referenceIndex || (i + 1)
        }))
        : ordered.map((_, i) => ({ index: i + 1, sourceSubjectId: 'subject-' + (i + 1), description: 'person ' + (i + 1), position: null, referenceIndex: i + 1 }));
    return {
        intent: 'video_character_replacement',
        sourceVideo,
        replacements: ordered,
        targets,
        targetMapping: targets.map((t) => ({ targetId: t.sourceSubjectId, description: t.description, referenceIndex: t.referenceIndex })),
        replaceCount: count,
        countScope: raw.countScope || null,
        replaceMode: mode,
        transfer: raw.transfer || transferAttributesFor(mode),
        preserve,
        audioPolicy: raw.audioPolicy || 'none',
        audioNote: raw.audioNote || '',
        additionalInstructions: raw.additionalInstructions || '',
        requestedDuration: raw.requestedDuration || null,
        assumedOrder: false
    };
}

// Strip the resolved absPath and round-trip only what the client needs to show
// the mapping; the server re-resolves every filename against the conversation
// registry when the user confirms.
function serializePlanAsset(asset) {
    if (!asset || !asset.filename) return null;
    const origin = asset.origin === 'upload' ? 'upload' : 'generated';
    return {
        filename: asset.filename,
        origin,
        url: asset.url || ('/' + (origin === 'upload' ? 'images' : 'generated') + '/' + encodeURIComponent(asset.filename))
    };
}

function serializeReplacementPlan(plan) {
    if (!plan) return null;
    return {
        sourceVideo: serializePlanAsset(plan.sourceVideo),
        replacements: (plan.replacements || []).map(serializePlanAsset).filter(Boolean),
        targets: (plan.targets || []).map((t) => ({
            index: t.index,
            sourceSubjectId: t.sourceSubjectId,
            description: t.description,
            position: t.position,
            referenceIndex: t.referenceIndex
        })),
        targetMapping: plan.targetMapping || [],
        replaceCount: plan.replaceCount || (plan.replacements || []).length,
        countScope: plan.countScope || null,
        replacementMode: plan.replaceMode || 'identity_only',
        transfer: plan.transfer || null,
        preserve: plan.preserve || {},
        audioPolicy: plan.audioPolicy || 'none',
        audioNote: plan.audioNote || '',
        countAdjusted: Boolean(plan.countAdjusted),
        ignoredReferences: plan.ignoredReferences || [],
        additionalInstructions: plan.additionalInstructions || '',
        requestedDuration: plan.requestedDuration || null,
        ambiguous: Boolean(plan.assumedOrder)
    };
}

// --- Prompt construction ------------------------------------------------------

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function listPhrase(items) {
    const list = (items || []).filter(Boolean);
    if (list.length <= 1) return list[0] || '';
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
}

function transferPhrase(mode, transfer) {
    const t = transfer || transferAttributesFor(mode);
    const parts = [];
    if (t.identity) parts.push('facial identity');
    if (t.hair) parts.push('hairstyle');
    if (t.clothing) parts.push('clothing');
    if (t.accessories) parts.push('accessories');
    if (t.body) parts.push('body shape');
    return listPhrase(parts);
}

// Deterministic H3 full-reference prompt following the official MiniMax H3
// reference-video guide: the six rewrite sections (`subject_definitions`,
// `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`,
// `non_diegetic_music`) with the node's `<Video N>` / `<Picture N>` / `<Audio 1>`
// reference-label contract. The source video owns the scene and motion; the
// reference images contribute ONLY the attributes the user asked to transfer.
function buildReplacementPrompt(plan) {
    const p = plan && typeof plan === 'object' ? plan : {};
    const replacements = Array.isArray(p.replacements) ? p.replacements : [];
    const preserve = p.preserve || {};
    const mode = p.replaceMode || 'identity_only';
    const transfer = p.transfer || transferAttributesFor(mode);
    const count = replacements.length;
    const multiple = count > 1;
    const targets = (Array.isArray(p.targets) && p.targets.length === count)
        ? p.targets
        : replacements.map((_, i) => ({ index: i + 1, description: 'person ' + (i + 1), position: null }));
    const audioPolicy = p.audioPolicy || 'none';
    const hasAudio = audioPolicy !== 'none';
    const transferText = transferPhrase(mode, transfer);
    const targetNames = targets.map((t, i) => t.description || ('person ' + (i + 1)));
    const pictureList = listPhrase(replacements.map((_, i) => '<Picture ' + (i + 1) + '>'));

    // --- subject_definitions ---
    const defs = [];
    defs.push('<Video 1> is the source video for the target video edit: the authoritative reference for the scene, background, environment, camera framing and movement, lighting, the existing people, and the overall timing and duration.');
    replacements.forEach((ref, i) => {
        const who = targetNames[i];
        defs.push('<Picture ' + (i + 1) + '> is the identity and appearance reference for the ' + who + ' in <Video 1>' +
            (transfer.clothing ? ', including their clothing and accessories' : '') + '.');
    });
    if (hasAudio) defs.push('<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video.');

    // --- summary ---
    const taskTypes = ['video editing'];
    if (hasAudio) taskTypes.push('audio reuse');
    let summary = '[' + taskTypes.join(' + ') + '] The target video is an edited version of <Video 1>. ';
    if (multiple) {
        summary += 'Replace only the targeted people — ' + listPhrase(targetNames) + ' — each with the matching reference image (' + pictureList + '). ';
    } else {
        summary += 'Replace only the ' + targetNames[0] + ' with <Picture 1>. ';
    }
    summary += 'Transfer ' + transferText + ' from the reference image' + (multiple ? 's' : '') +
        ' while preserving the original scene, background, camera and motion of <Video 1>.';
    if (p.additionalInstructions) summary += ' Additional direction: ' + String(p.additionalInstructions).replace(/[.]?$/, '.');

    // --- retention_analysis ---
    const retention = [];
    retention.push('<Video 1> (scene, background, environment, camera and timing): fully_preserved - the source provides the scene, background, environment, camera framing and movement, lighting and temporal structure of the target video.');
    replacements.forEach((ref, i) => {
        retention.push('<Picture ' + (i + 1) + '> (identity and appearance for the ' + targetNames[i] + '): attribute_transfer - ' +
            transferText + ' are transferred from <Picture ' + (i + 1) + '> to the ' + targetNames[i] +
            ' in <Video 1>; the reference image background, lighting and composition are not used.');
    });
    const replacedNoun = multiple ? 'replaced people' : 'replaced person';
    if (preserve.motion !== false) {
        retention.push('The pose, body movement and gestures of the ' + replacedNoun + ' in <Video 1>: fully_preserved - they keep the original position, body pose, movement, facial expression and timing of the source footage.');
    }
    if (preserve.camera !== false) retention.push('The original camera framing and movement in <Video 1>: fully_preserved.');
    if (preserve.background !== false) retention.push('The background, environment and scene objects of <Video 1>: fully_preserved.');
    if (preserve.clothing !== false) retention.push('The original clothing of the ' + replacedNoun + ' in <Video 1>: fully_preserved.');
    if (preserve.nonTargetPeople !== false) retention.push('Non-target people in <Video 1>: fully_preserved - they are not replaced, altered or duplicated.');
    if (hasAudio) retention.push('<Audio 1>: partially_copy - the original dialogue, ambience and music are reused wherever the model reproduces them; the pipeline does not re-mux the source track, so exact 1:1 sample preservation is not guaranteed.');

    // --- detailed_description ---
    let detailed = 'The target video preserves the visual style, lighting, colour palette and spatial layout of <Video 1>.\n';
    detailed += '[Shot 1] The shot follows <Video 1>: the same scene, background, environment, camera framing and movement, and the same overall timing and duration.';
    targets.forEach((target, i) => {
        const who = targetNames[i];
        let sentence = ' The ' + who + ' in <Video 1> is replaced by the identity shown in <Picture ' + (i + 1) + '>: ' +
            transferText + ' come from <Picture ' + (i + 1) + '>, while the original position, pose, gestures, facial expression, movement and timing of the ' + who + ' in <Video 1> are preserved.';
        if (preserve.clothing === false) sentence += ' The clothing and accessories from <Picture ' + (i + 1) + '> are applied to the ' + who + '.';
        sentence += ' The background, lighting and composition of <Picture ' + (i + 1) + '> are never used.';
        detailed += sentence;
    });
    if (preserve.nonTargetPeople !== false) detailed += ' Every other person in <Video 1> remains exactly as they are, with unchanged identity, clothing and movement.';
    if (preserve.background !== false) detailed += ' The background and environment come only from <Video 1>.';
    detailed += ' The replacement is stable across every frame, and the transferred identity keeps the same face, hair and skin tone throughout.';

    // --- overall_soundscape ---
    let soundscape = 'N/A';
    if (hasAudio) soundscape = 'The original room tone, environmental ambience, dialogue and sound effects of <Audio 1> continue with the source video timing.';
    else if (preserve.timing !== false) soundscape = 'Natural room tone and ambient sound consistent with the source scene.';

    // --- non_diegetic_music ---
    const music = hasAudio
        ? 'The original audience-only score and music from <Audio 1> are reused; no new music is introduced.'
        : 'N/A';

    return (
        'subject_definitions:\n' + defs.join('\n') + '\n\n' +
        'summary:\n' + summary + '\n\n' +
        'retention_analysis:\n' + retention.join('\n') + '\n\n' +
        'detailed_description:\n' + detailed + '\n\n' +
        'overall_soundscape:\n' + soundscape + '\n\n' +
        'non_diegetic_music:\n' + music
    ).replace(/\n{3,}/g, '\n\n').trim();
}

// --- Video probing (duration + audio presence, no dependencies) ---------------

function probeDurationBuffer(buf, ext) {
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (buffer.length < 16) return null;

    // ISO BMFF (MP4/MOV): the mvhd box carries timescale + duration.
    const mvhd = buffer.indexOf('mvhd');
    if (mvhd !== -1 && mvhd + 32 <= buffer.length) {
        const version = buffer[mvhd + 4];
        if (version === 0) {
            const timescale = buffer.readUInt32BE(mvhd + 16);
            const duration = buffer.readUInt32BE(mvhd + 20);
            if (timescale > 0 && duration > 0) return duration / timescale;
        } else if (version === 1 && mvhd + 36 <= buffer.length) {
            const timescale = buffer.readUInt32BE(mvhd + 24);
            const duration = Number(buffer.readBigUInt64BE(mvhd + 28));
            if (timescale > 0 && duration > 0) return duration / timescale;
        }
    }

    // WebM: the Segment/Info Duration element (0x44 0x89, float seconds).
    const webm = buffer.indexOf(Buffer.from([0x44, 0x89]));
    if (webm !== -1) {
        let pos = webm + 2;
        const first = buffer[pos];
        if (first) {
            let len = 1;
            let mask = 0x80;
            while (len <= 8 && !(first & mask)) { len += 1; mask >>= 1; }
            const size = first & (mask - 1);
            const valuePos = pos + len;
            if ((size === 4 || size === 8) && valuePos + size <= buffer.length) {
                return size === 4 ? buffer.readFloatBE(valuePos) : buffer.readDoubleBE(valuePos);
            }
        }
    }
    return null;
}

function probeVideoDuration(filePath) {
    try {
        return probeDurationBuffer(fs.readFileSync(filePath), path.extname(String(filePath)));
    } catch (_) {
        return null;
    }
}

// Best-effort audio-track detection so the source soundtrack can condition the
// reference node when it exists and is skipped when it does not.
function hasLikelyAudioTrack(buf) {
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (!buffer.length) return false;
    const ascii = buffer.toString('latin1');
    if (/mp4a|soun|\.aac|aac\s/.test(ascii)) return true;
    if (/A_OPUS|A_VORBIS|A_AAC|A_FLAC|A_MPEG/.test(ascii)) return true;
    if (/auds/.test(ascii)) return true;
    return false;
}

// --- Reference model resolution -----------------------------------------------

function refUnetCandidates(info) {
    const required = info && info.UNETLoader && info.UNETLoader.input &&
        info.UNETLoader.input.required && info.UNETLoader.input.required.unet_name;
    const list = Array.isArray(required) && Array.isArray(required[0]) ? required[0] : [];
    return list.filter((name) => /ref2va/i.test(String(name || '')));
}

function resolveRefUnet(info, settings) {
    const override = process.env.H3_REF_UNET || (settings && settings.h3RefUnet) || '';
    if (override) return override;
    const candidates = refUnetCandidates(info);
    return candidates[0] || null;
}

// --- Conditioning strategy ----------------------------------------------------
//
// The character-swap adapter (akatz-ai/MiniMax-H3-Character-Swap-LoRA) replaces
// ONE selected person; it is the verified adapter for a single-person swap and
// is what makes the replacement land. Applied model-wide on a multi-reference
// request it binds a single identity, so every extra <Picture N> is ignored —
// the root cause of "only one character gets replaced". It is therefore applied
// to EVERY single-target request and never to a multi-target one; the
// multi-target path uses the native multi-reference conditioning, which honours
// every <Picture N>. (The adapter copies the reference's clothing as well as
// identity; an explicit "keep the original clothes" instruction is still
// honoured by the prompt, but the adapter is what guarantees the person is
// actually swapped.)
function characterSwapDecision(plan, settings) {
    const swap = videoGenerator.normalizeH3CharacterSwap(settings);
    const base = { enabled: swap.enabled, loraName: swap.loraName, strength: swap.strength };
    if (!swap.enabled) return Object.assign({ use: false, reason: 'disabled' }, base);
    const count = plan && Array.isArray(plan.replacements) ? plan.replacements.length : 0;
    if (count !== 1) return Object.assign({ use: false, reason: 'multi-target' }, base);
    return Object.assign({ use: true, reason: 'single-target' }, base);
}

// Reference image sizing: `auto` uses the reference pipeline's 2048px short edge
// (max identity/garment fidelity) when clothing/appearance is transferred, and
// the cheaper generation-area `match` otherwise. An explicit setting wins.
function refImageSizeForPlan(plan, settings) {
    const configured = (settings && settings.replacementRefImageSize) || 'auto';
    if (configured === 'match' || configured === 'max') return configured;
    return (plan && plan.replaceMode && plan.replaceMode !== 'identity_only') ? 'max' : 'match';
}

// A short SAM3 grounding prompt derived from the request (a named gender is more
// specific than "person" and yields far fewer false detections).
function maskPromptForPlan(plan) {
    const targets = (plan && Array.isArray(plan.targets)) ? plan.targets : [];
    const gender = targets.map((t) => t && t.gender).find(Boolean);
    if (gender === 'woman' || gender === 'girl') return 'woman';
    if (gender === 'man' || gender === 'boy') return 'man';
    return 'person';
}

// The opt-in subject-mask plan. When enabled, buildReplacementGraph segments the
// target with SAM3, tracks it across the clip, grows the mask and composites the
// generated subject back onto the ORIGINAL source frames so the background and
// non-target people keep their original pixels.
function replacementMaskPlan(plan, settings) {
    const s = settings || {};
    const raw = s.replacementMaskToSubject;
    const enabled = raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
    const count = plan && Array.isArray(plan.replacements) ? plan.replacements.length : 0;
    const prompt = String(s.replacementMaskPrompt || '').trim() || maskPromptForPlan(plan);
    return {
        enabled,
        prompt,
        model: String(s.replacementMaskModel || '').trim() || DEFAULT_SAM3_CHECKPOINT,
        grow: videoGenerator.normalizeReplacementMaskGrow(s.replacementMaskGrow, videoGenerator.H3_REPLACEMENT_MASK_DEFAULT_GROW),
        // Single target: track every detected subject but mask only the first.
        // Multi-target ("everyone"): union every tracked subject.
        objectIndices: count > 1 ? '' : '0'
    };
}

// Fail clearly when the mask mode is enabled but its core nodes or the SAM3
// checkpoint are not available, instead of silently producing an unmasked job.
function assertReplacementMaskReady(info, mask) {
    if (!mask || !mask.enabled) return;
    const available = info || {};
    for (const node of MASK_NODES) {
        if (!Object.prototype.hasOwnProperty.call(available, node)) {
            const error = new Error(
                'Subject-mask background preservation needs the ComfyUI node "' + node + '", which this build does not provide. ' +
                'Update ComfyUI (SAM3 and the core mask nodes) or turn the replacement mask off in Settings > Video.'
            );
            error.code = 'replacement_mask_node_missing';
            throw error;
        }
    }
    const required = available.CheckpointLoaderSimple && available.CheckpointLoaderSimple.input &&
        available.CheckpointLoaderSimple.input.required && available.CheckpointLoaderSimple.input.required.ckpt_name;
    const choices = Array.isArray(required) && Array.isArray(required[0]) ? required[0] : [];
    const found = choices.some((name) => String(name).trim().toLowerCase() === String(mask.model).trim().toLowerCase());
    if (choices.length && !found) {
        const error = new Error(
            'Subject-mask background preservation needs the SAM3 checkpoint "' + mask.model + '", which is not installed.\n\n' +
            'Place it in ComfyUI/models/checkpoints, then try again — or turn the replacement mask off in Settings > Video.'
        );
        error.code = 'replacement_mask_model_missing';
        throw error;
    }
}

// --- Graph construction -------------------------------------------------------

function buildReplacementGraph(opts = {}) {
    const {
        prompt,
        W = 1280,
        H = 720,
        frames = 124,
        seed = 0,
        settings = {},
        refImageNames = [],
        refVideoName = null,
        refVideoHasAudio = false,
        firstBlockCacheInputs = null,
        // Conditioning strategy.
        useCharacterSwap,
        refImageSize,
        mask
    } = opts;
    const applyCharacterSwap = useCharacterSwap !== undefined
        ? useCharacterSwap === true
        : (settings.h3CharSwapEnabled !== false);
    const imageSize = refImageSize || 'match';
    const maskEnabled = Boolean(mask && mask.enabled && refVideoName);

    const graph = {};
    graph.model = {
        class_type: 'UNETLoader',
        inputs: {
            unet_name: settings.h3RefUnet || DEFAULT_REF_UNET,
            weight_dtype: 'default'
        }
    };
    graph.clip = {
        class_type: 'CLIPLoader',
        inputs: {
            clip_name: settings.h3Clip || videoGenerator.H3_DEFAULTS.h3Clip,
            type: 'minimax',
            device: 'default'
        }
    };
    graph.video_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3VideoVae || videoGenerator.H3_DEFAULTS.h3VideoVae }
    };
    graph.audio_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3AudioVae || videoGenerator.H3_DEFAULTS.h3AudioVae }
    };
    graph.noise = {
        class_type: 'RandomNoise',
        inputs: { noise_seed: seed }
    };
    // Turbo is intentionally NOT applied here: the reference pipeline runs on
    // the Ref2VA base with the stock sampler/scheduler, which is the verified
    // configuration for reference conditioning.
    graph.sampler_select = {
        class_type: 'KSamplerSelect',
        inputs: { sampler_name: 'res_multistep' }
    };

    // Model optimization stack: First Block Cache -> [character-swap LoRA] ->
    // user LoRAs -> attention. The single-identity character-swap adapter is
    // added ONLY for a single-target appearance swap; a multi-target request
    // must NOT use it (it would collapse every <Picture N> onto one identity).
    const cachedModelNode = videoGenerator.appendFirstBlockCache(graph, 'model', settings, firstBlockCacheInputs);
    const swapModelNode = applyCharacterSwap
        ? videoGenerator.appendH3CharacterSwapLora(graph, cachedModelNode, settings)
        : cachedModelNode;
    const userModelNode = videoGenerator.appendLoraChain(graph, swapModelNode, settings.loras);
    const attention = videoGenerator.normalizeH3AttentionBackend(settings.attentionBackend);
    const patchedModelNode = videoGenerator.applyAttentionPatch(graph, userModelNode, attention);
    const schedulerModelNode = attention === 'sla' ? patchedModelNode : userModelNode;

    // Decoded source video (frames at 24 fps, capped to the generation length).
    // The source clip is the scene/motion/timing reference; the replacement
    // images are identity/appearance references only.
    if (refVideoName) {
        graph.ref_video = {
            class_type: SOURCE_VIDEO_NODE,
            inputs: {
                video: refVideoName,
                force_rate: H3_FPS,
                custom_width: 0,
                custom_height: 0,
                frame_load_cap: frames,
                skip_first_frames: 0,
                select_every_nth: 1,
                format: 'None'
            }
        };
    }

    // Replacement identity images. `ref_image_size` controls how much reference
    // detail the model sees: 'max' keeps garment/identity fidelity (2048px short
    // edge), 'match' scales to the generation area.
    const conditionInputs = {
        clip: ['clip', 0],
        vae: ['video_vae', 0],
        audio_vae: ['audio_vae', 0],
        prompt: String(prompt || ''),
        width: W,
        height: H,
        length: frames,
        ref_image_size: imageSize
    };
    refImageNames.forEach((name, index) => {
        const nodeId = 'ref_image_' + index;
        graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } };
        conditionInputs['ref_images.ref_image_' + index] = [nodeId, 0];
    });
    if (refVideoName) {
        conditionInputs['ref_videos.ref_video_0'] = ['ref_video', 0];
        if (refVideoHasAudio) {
            conditionInputs['ref_video_audios.ref_video_audio_0'] = ['ref_video', 2];
        }
    }
    graph.reference = { class_type: REPLACEMENT_NODE, inputs: conditionInputs };

    const steps = videoGenerator.normalizeH3Steps(settings.h3Steps, videoGenerator.H3_DEFAULT_STEPS);
    // Full denoise from the reference node's own latent. The reference node
    // PRESENTS the source video and the replacement images together; the whole
    // frame is regenerated from the reference conditioning. Do NOT inject the
    // source latent here — that turns the swap into low-denoise img2img and
    // returns (close to) the original clip with the character unchanged.
    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: { model: [schedulerModelNode, 0], scheduler: 'simple', steps, denoise: 1 }
    };
    graph.guider = {
        class_type: 'BasicGuider',
        inputs: { model: [patchedModelNode, 0], conditioning: ['reference', 0] }
    };
    graph.sample = {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
            noise: ['noise', 0],
            guider: ['guider', 0],
            sampler: ['sampler_select', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['reference', 1]
        }
    };
    graph.decode = {
        class_type: 'VAEDecode',
        inputs: { samples: ['sample', 0], vae: ['video_vae', 0] }
    };
    graph.decode_audio = {
        class_type: 'VAEDecodeAudio',
        inputs: { samples: ['sample', 0], vae: ['audio_vae', 0] }
    };

    // Opt-in subject mask: segment + track the target with SAM3, grow the mask,
    // and composite the generated subject back onto the ORIGINAL source frames
    // so everything outside the masked person keeps its original pixels. The
    // mask is computed on the full source clip and the composite narrows both to
    // the generated frame count, keeping them aligned.
    let imagesNode = ['decode', 0];
    if (maskEnabled) {
        graph.mask_source = {
            class_type: SOURCE_VIDEO_NODE,
            inputs: {
                video: refVideoName,
                force_rate: H3_FPS,
                custom_width: W,
                custom_height: H,
                frame_load_cap: frames,
                skip_first_frames: 0,
                select_every_nth: 1,
                format: 'None'
            }
        };
        graph.mask_first = {
            class_type: 'ImageFromBatch',
            inputs: { image: ['mask_source', 0], batch_index: 0, length: 1 }
        };
        graph.mask_ckpt = {
            class_type: 'CheckpointLoaderSimple',
            inputs: { ckpt_name: mask.model }
        };
        graph.mask_text = {
            class_type: 'CLIPTextEncode',
            inputs: { text: mask.prompt, clip: ['mask_ckpt', 1] }
        };
        graph.mask_detect = {
            class_type: 'SAM3_Detect',
            inputs: {
                model: ['mask_ckpt', 0],
                image: ['mask_first', 0],
                conditioning: ['mask_text', 0],
                threshold: 0.35,
                refine_iterations: 2,
                individual_masks: true
            }
        };
        graph.mask_track = {
            class_type: 'SAM3_VideoTrack',
            inputs: {
                images: ['mask_source', 0],
                model: ['mask_ckpt', 0],
                initial_mask: ['mask_detect', 0],
                conditioning: ['mask_text', 0],
                detection_threshold: 0.5,
                max_objects: 0,
                detect_interval: 1
            }
        };
        graph.mask_tomask = {
            class_type: 'SAM3_TrackToMask',
            inputs: { track_data: ['mask_track', 0], object_indices: mask.objectIndices }
        };
        graph.mask_grow = {
            class_type: 'GrowMask',
            inputs: { mask: ['mask_tomask', 0], expand: mask.grow, tapered_corners: false }
        };
        graph.composite = {
            class_type: 'ImageCompositeMasked',
            inputs: {
                destination: ['mask_source', 0],
                source: ['decode', 0],
                x: 0,
                y: 0,
                resize_source: false,
                mask: ['mask_grow', 0]
            }
        };
        imagesNode = ['composite', 0];
    }

    // The original soundtrack is reused unchanged when the source has audio
    // (the verified FaceRefine pattern); H3's own audio is only used otherwise.
    graph.video = {
        class_type: 'CreateVideo',
        inputs: {
            images: imagesNode,
            audio: refVideoHasAudio ? ['ref_video', 2] : ['decode_audio', 0],
            fps: H3_FPS,
            crf: 8
        }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: {
            video: ['video', 0],
            filename_prefix: 'not-so-jarvis/replace',
            format: 'auto',
            codec: 'auto'
        }
    };
    return graph;
}

async function validateReplacementGraph(info, graph) {
    if (!info || typeof info !== 'object') {
        const error = new Error('ComfyUI did not report its available nodes.');
        error.code = 'comfyui_unavailable';
        throw error;
    }
    for (const node of REQUIRED_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, node)) {
            const error = new Error(
                'This ComfyUI build does not provide the "' + node + '" node, so motion-preserving video replacement is unavailable. ' +
                'Update ComfyUI (the MiniMax H3 reference-to-video node and VideoHelperSuite are required).'
            );
            error.code = 'video_replacement_node_missing';
            throw error;
        }
    }
    if (!resolveRefUnet(info, { h3RefUnet: (graph.model.inputs || {}).unet_name })) {
        const error = new Error('The MiniMax H3 reference-to-video model (Ref2VA) is not installed.');
        error.code = 'h3_reference_unet_missing';
        throw error;
    }
    for (const [key, node] of Object.entries(graph)) {
        if (!node || !node.class_type) continue;
        if (!Object.prototype.hasOwnProperty.call(info, node.class_type)) {
            const error = new Error('ComfyUI is missing the node "' + node.class_type + '" (used as "' + key + '").');
            error.code = 'comfyui_missing_nodes';
            throw error;
        }
    }
}

// --- Execution ----------------------------------------------------------------

async function uploadFile(absPath, prefix) {
    const buffer = fs.readFileSync(absPath);
    const name = prefix + '_' + Date.now() + '_' + path.basename(absPath);
    const uploaded = await comfyui.uploadImage(buffer, name);
    return { name: (uploaded && uploaded.name) || name, buffer };
}

async function generateReplacementVideo(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'video character replacement',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        ensureGeneratedDir();
        const startedAt = Date.now();
        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);

        const settings = videoGenerator.effectiveVideoSettings();
        const sourceBuffer = fs.readFileSync(plan.sourceVideo.absPath);
        const sourceExt = path.extname(plan.sourceVideo.absPath).toLowerCase();

        const probedDims = videoGenerator.probeVideoBuffer(sourceBuffer, sourceExt);
        const sourceSeconds = probeDurationBuffer(sourceBuffer, sourceExt);
        const requested = Number(plan.requestedDuration || options.duration);
        const chosenSeconds = Number.isFinite(requested) && requested > 0
            ? requested
            : (Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : settings.h3Duration);
        const duration = videoGenerator.h3DurationSeconds(Math.round(chosenSeconds));
        const frames = videoGenerator.h3FramesForSeconds(duration);
        const dims = videoGenerator.h3Dimensions(
            probedDims && probedDims.width ? probedDims.width : 1280,
            probedDims && probedDims.height ? probedDims.height : 720,
            settings.h3Size
        );
        const W = dims.W;
        const H = dims.H;
        // The plan's audio policy decides whether the source track is supplied
        // as a synchronized audio reference; an explicit legacy option still
        // wins when the plan predates the policy.
        const audioWanted = plan.audioPolicy === undefined ? options.preserveAudio !== false : plan.audioPolicy !== 'none';
        const refVideoHasAudio = audioWanted && hasLikelyAudioTrack(sourceBuffer);

        const uploadedInputNames = [];
        const info = await comfyui.getObjectInfo();
        const refUnet = resolveRefUnet(info, settings);
        if (!refUnet) {
            const error = new Error('The MiniMax H3 reference-to-video model (Ref2VA) is not installed.');
            error.code = 'h3_reference_unet_missing';
            throw error;
        }

        const resolvedSettings = Object.assign({}, settings, {
            h3RefUnet: refUnet,
            attentionBackend: videoGenerator.resolveH3AttentionBackend(info, settings.attentionBackend)
        });

        // The single-identity character-swap adapter is applied ONLY to a
        // single-target appearance swap (see characterSwapDecision); fail
        // clearly when it is enabled for one but not installed rather than
        // silently dropping back to the stock Ref2VA base.
        const swapDecision = characterSwapDecision(plan, resolvedSettings);
        if (swapDecision.use) videoGenerator.assertH3CharacterSwapReady(info, resolvedSettings);
        const refImageSize = refImageSizeForPlan(plan, resolvedSettings);
        const maskPlan = replacementMaskPlan(plan, resolvedSettings);
        assertReplacementMaskReady(info, maskPlan);

        const prompt = buildReplacementPrompt(plan);
        const finalPrompt = String(prompt || '').trim();

        try {
            const sourceUpload = await uploadFile(plan.sourceVideo.absPath, 'jarvis_replace_src');
            uploadedInputNames.push(sourceUpload.name);

            const refImageNames = [];
            for (let i = 0; i < plan.replacements.length; i += 1) {
                const ref = plan.replacements[i];
                const up = await uploadFile(ref.absPath, 'jarvis_replace_ref_' + i);
                uploadedInputNames.push(up.name);
                refImageNames.push(up.name);
            }

            const graph = buildReplacementGraph({
                prompt: finalPrompt,
                W,
                H,
                frames,
                seed,
                settings: resolvedSettings,
                refImageNames,
                refVideoName: sourceUpload.name,
                refVideoHasAudio,
                firstBlockCacheInputs: videoGenerator.resolveFirstBlockCacheInputNames(info),
                useCharacterSwap: swapDecision.use,
                refImageSize,
                mask: maskPlan
            });

            await validateReplacementGraph(info, graph);

            if (typeof options.onProgress === 'function') {
                try { options.onProgress('reference-begin'); } catch (_) { /* best-effort */ }
            }

            const pid = await comfyui.queuePrompt(graph);
            console.log('[video-replacement] queued reference workflow:', pid,
                '(' + duration + 's, ' + frames + 'f, ' + plan.replacements.length + ' ref image(s), ' +
                'audio=' + refVideoHasAudio + ', charSwap=' + swapDecision.use +
                ', refImageSize=' + refImageSize +
                ', mask=' + (maskPlan.enabled ? (maskPlan.prompt + '@' + maskPlan.grow) : 'off') + ')');

            const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
            const history = await comfyui.waitForPrompt(pid, { timeoutMs, signal });

            const videoFiles = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|avi|mov)$/i);
            if (!videoFiles.length) {
                const error = new Error('ComfyUI finished but produced no replacement video.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }
            const entry = videoFiles[videoFiles.length - 1];
            const buffer = await comfyui.downloadImage(entry);
            await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.mp4';
            const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_repl_' + stamp + extension;
            const filePath = path.join(GENERATED_DIR, basename);
            fs.writeFileSync(filePath, buffer);

            const acceleration = videoGenerator.videoAccelerationInfo(resolvedSettings, resolvedSettings.attentionBackend);
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: finalPrompt,
                model: 'MiniMax H3 Reference',
                width: W,
                height: H,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration: videoGenerator.h3EffectiveDurationSeconds(duration),
                    frames,
                    fps: H3_FPS,
                    mode: 'reference',
                    source: plan.sourceVideo.filename,
                    references: plan.replacements.map((r) => r.filename),
                    preserveAudio: refVideoHasAudio,
                    // The original soundtrack is reused verbatim when present
                    // (muxed straight into the output), so it is fully copied.
                    audioPolicy: refVideoHasAudio ? 'fully_copy' : 'none',
                    replacementMode: plan.replaceMode || 'identity_only',
                    replaceCount: plan.replaceCount || plan.replacements.length,
                    targets: (plan.targets || []).map((t) => ({ description: t.description, referenceIndex: t.referenceIndex })),
                    transfer: plan.transfer || null,
                    preservation: plan.preserve || null,
                    // Background strategy actually used. Masked mode composites
                    // the generated subject back onto the original frames, so
                    // everything outside the masked person is the source's own
                    // pixels; the unmasked path only requests preservation.
                    background: maskPlan.enabled
                        ? { strategy: 'sam3-subject-composite', maskPrompt: maskPlan.prompt, grow: maskPlan.grow, model: maskPlan.model, guaranteed: false }
                        : { strategy: 'reference-conditioned', guaranteed: false },
                    characterSwap: swapDecision.use
                        ? { lora: swapDecision.loraName, strength: swapDecision.strength }
                        : null,
                    characterSwapReason: swapDecision.reason,
                    referenceImageSize: refImageSize,
                    resolution: { width: W, height: H },
                    acceleration,
                    videoPipeline: 'minimax-h3-reference'
                }
            });

            return {
                url: meta.file,
                filename: basename,
                width: W,
                height: H,
                duration: videoGenerator.h3EffectiveDurationSeconds(duration),
                frames,
                fps: H3_FPS,
                mode: 'reference',
                references: plan.replacements.map((r) => r.filename),
                targets: plan.targets || [],
                replacementMode: plan.replaceMode || 'identity_only',
                audioPolicy: refVideoHasAudio ? 'fully_copy' : 'none',
                background: meta.video.background,
                characterSwap: meta.video.characterSwap,
                prompt: finalPrompt,
                generationMs: meta.generationMs,
                meta
            };
        } finally {
            for (const name of uploadedInputNames) {
                await comfyui.deleteInputFile(name).catch(() => {});
            }
        }
    }, queueOpts);
}

module.exports = {
    REPLACEMENT_NODE,
    SOURCE_VIDEO_NODE,
    REQUIRED_NODES,
    DEFAULT_REF_UNET,
    MAX_REFERENCE_IMAGES,
    MAX_REFERENCE_VIDEOS,
    MAX_REFERENCE_AUDIOS,
    MASK_NODES,
    DEFAULT_SAM3_CHECKPOINT,
    REPLACEMENT_VERB_RE,
    MAPPING_CUE_RE,
    REPLACEMENT_MODES,
    detectReferenceReplacement,
    inferReplacementCount,
    extractTargetDescriptors,
    extractTargetImageBindings,
    resolveReplacementMode,
    resolvePreservation,
    resolveAudioPolicy,
    transferAttributesFor,
    parseReplacementRequest,
    extractExtraDirection,
    buildTargets,
    buildReplacementPlan,
    rehydrateReplacementPlan,
    buildReplacementPrompt,
    serializePlanAsset,
    serializeReplacementPlan,
    probeDurationBuffer,
    probeVideoDuration,
    hasLikelyAudioTrack,
    refUnetCandidates,
    resolveRefUnet,
    characterSwapDecision,
    refImageSizeForPlan,
    maskPromptForPlan,
    replacementMaskPlan,
    assertReplacementMaskReady,
    buildReplacementGraph,
    validateReplacementGraph,
    generateReplacementVideo
};
