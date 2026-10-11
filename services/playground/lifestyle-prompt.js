/* ============================================
   JARVIS — Lifestyle & Candid prompt normalization
   A deterministic, theme-scoped post-process for the Creative Playground's
   Lifestyle & Candid theme. It runs on the assembled scene prompt (after the
   image prompt builder has produced it) and before the theme photography
   suffix is appended. It:
     - collapses repeated character-identity descriptions into one authoritative
       identity block while keeping genuinely new attributes;
     - reconciles the prompt's lighting with the scene environment (source
       warmth is preserved, a contradictory time-of-day is not);
     - strips unwanted global golden/yellow/orange colour grades and adds one
       neutral white-balance / natural-skin guidance clause.
   It preserves the user's scene, wardrobe, pose, expression and aspect ratio
   and never rewrites the saved character identity. It runs only for the
   Lifestyle & Candid theme and is idempotent (running it twice changes
   nothing). No LLM, no I/O, no other theme is touched.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const LIFESTYLE_THEME_ID = 'lifestyle-candid';

// The one photography treatment the Lifestyle & Candid theme appends. It is
// referenced by playground.js so the suffix has a single source of truth.
const LIFESTYLE_PHOTOGRAPHY_SUFFIX =
    'An ultra-realistic photoreal image captured with an authentic handheld iPhone 16 Pro, ' +
    'styled as a casual Instagram lifestyle photo';

// Rendering guidance. Both variants keep the image's own lighting; they only
// govern the overall white balance so a warm source cannot tint the whole frame.
const NEUTRAL_GUIDANCE =
    'The overall white balance stays neutral and true to life with realistic, natural skin tones and no global yellow or orange color grading, warm or golden cast, or amber wash';
const WARM_SKIN_GUIDANCE =
    'Skin renders as medium beige with a neutral undertone and the overall white balance stays neutral and true to life, with no global yellow or orange color grading, warm or golden cast, or amber wash and no artificial orange skin';
const NO_CAST_RE = /no global yellow or orange/i;

// Global colour-grade phrases that produce an unwanted cast. `golden hour`,
// `warm lamp light` and other light sources are deliberately NOT matched — only
// a named global grade/cast/tint/filter is removed.
const GLOBAL_GRADE_RE = new RegExp(
    '\\b(?:overall|global|heavy|strong|deep|intense|warm|golden|amber|orange|yellow)\\s+' +
    '(?:(?:warm|golden|amber|orange|yellow)\\s+)*' +
    '(?:colou?r\\s+grade|colou?r\\s+grading|colou?r\\s+cast|grade|grading|cast|tint|filter|wash)\\b' +
    '(?:\\s+(?:over|across|on)\\s+the\\s+(?:whole|entire)\\s+(?:image|frame|photo|scene|picture))?',
    'gi'
);

// Identity restatement / lock vocabulary. Used to find the identity block(s)
// the enhancer may have repeated.
const IDENTITY_LOCK_RE = new RegExp(
    '\\b(?:character identity|same (?:character|person|woman|man|individual)|' +
    '(?:preserve|keep|maintain)\\s+(?:the\\s+)?(?:exact\\s+|same\\s+)?' +
    '(?:character|identity|person|subject|face|facial|hair|skin|complexion|features?)|' +
    'facial structure|facial features|eye shape|eye colou?r|hairstyle|hair colou?r|' +
    'skin tone|complexion|distinctive (?:feature|mark)|body (?:type|proportions))\\b',
    'i'
);

// A short verb list so a merged clause never re-introduces a lock instruction.
const LOCK_VERB_RE = /\b(?:preserve|keep|maintain|show|same|exact)\b/i;

// Lighting vocabulary. `light` intentionally matches "lighting"/"sunlight".
const LIGHTING_RE = /\b(?:light|lighting|lit|glow|sunlight|sun|daylight|lamp|window|shadow|shadows|backlit|overcast|dusk|evening|night|golden hour|golden-hour|streetlight|storefront|ambient|spotlight|neon|candle)\b/i;

const IDENTITY_STOPWORDS = new Set([
    'the', 'and', 'with', 'her', 'his', 'their', 'a', 'an', 'of', 'in', 'on',
    'at', 'to', 'for', 'from', 'that', 'this', 'who', 'whom', 'she', 'he',
    'they', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'as', 'by', 'or',
    'but', 'not', 'very', 'year', 'years', 'old', 'new'
]);

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Split a prompt into sentence-like segments. Semicolons count as separators
// (the enhancer uses them for lock clauses); decimal points do not split because
// the boundary requires following whitespace.
function splitSegments(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?;])\s+(?=[A-Z0-9"'(])/)
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function tidy(text) {
    let out = String(text || '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.;:])/g, '$1')
        .replace(/,\s*\./g, '.')
        .replace(/\.\s*\./g, '.')
        .replace(/^[\s,;.]+/, '')
        .replace(/[\s,;]+$/, '');
    if (out && !/[.!?]$/.test(out)) out += '.';
    return out;
}

// Remove a named global colour grade/cast/tint so warm light sources stay warm
// without tinting the whole image.
function stripGlobalColorGrade(text) {
    let out = String(text || '');
    out = out.replace(GLOBAL_GRADE_RE, '');
    out = out.replace(/\bsepia(?:\s+tone)?\b/gi, '');
    // Remove connectors left dangling when a grade phrase is deleted, then tidy
    // the punctuation the deletion exposed.
    out = out.replace(/\b(?:with|in|under|using|and|that|which)\s+a?\s*(?=[,.;]|$)/gi, '');
    out = out.replace(/\s{2,}/g, ' ');
    out = out.replace(/\s+([,.;:])/g, '$1');
    out = out.replace(/,\s*\./g, '.');
    out = out.replace(/,\s*,/g, ',');
    return out.trim();
}

// --- Identity collapse ---------------------------------------------------------

function identityTokens(identity) {
    const set = new Set();
    for (const value of [identity.subject, identity.appearance, identity.hair]) {
        for (const token of normalizeText(value).split(' ')) {
            if (token.length > 2 && !IDENTITY_STOPWORDS.has(token)) set.add(token);
        }
    }
    return set;
}

function overlapCount(segment, tokens) {
    if (!tokens.size) return 0;
    const present = new Set(normalizeText(segment).split(' '));
    let count = 0;
    for (const token of tokens) if (present.has(token)) count += 1;
    return count;
}

// A segment restates the character when it names the subject AND at least one
// distinguishing detail, when it uses identity-lock wording, or when it simply
// shares most of the identity vocabulary (a paraphrase).
function isIdentitySegment(segment, identity) {
    const all = identityTokens(identity);
    if (!all.size) return IDENTITY_LOCK_RE.test(segment);
    const subjectTokens = identityTokens({ subject: identity.subject });
    const detailTokens = new Set([...all].filter((token) => !subjectTokens.has(token)));
    const subjectOverlap = overlapCount(segment, subjectTokens);
    const detailOverlap = overlapCount(segment, detailTokens);
    const totalOverlap = overlapCount(segment, all);
    if (IDENTITY_LOCK_RE.test(segment) && totalOverlap >= 1) return true;
    if (subjectTokens.size && detailTokens.size &&
        subjectOverlap >= Math.ceil(subjectTokens.size * 0.5) && detailOverlap >= 1) {
        return true;
    }
    return totalOverlap >= Math.max(2, Math.ceil(all.size * 0.35));
}

// Reduce the identity descriptions to one authoritative block. The block with
// the most identity signal is kept; a genuinely novel attribute in another
// block (one that adds an identity token the base lacks) is merged in, and the
// redundant restatements are dropped.
function collapseIdentity(segments, identity) {
    const tokens = identityTokens(identity);
    const identityIndexes = [];
    segments.forEach((segment, index) => { if (isIdentitySegment(segment, identity)) identityIndexes.push(index); });
    if (identityIndexes.length <= 1) return segments;

    let baseIndex = identityIndexes[0];
    let bestOverlap = -1;
    for (const index of identityIndexes) {
        const overlap = overlapCount(segments[index], tokens);
        if (overlap > bestOverlap) { bestOverlap = overlap; baseIndex = index; }
    }

    let base = segments[baseIndex];
    let baseTokens = new Set(normalizeText(base).split(' '));
    const drop = new Set();

    for (const index of identityIndexes) {
        if (index === baseIndex) continue;
        drop.add(index);
        const clauses = segments[index].split(/[,;]|\band\b/i).map((clause) => clause.trim()).filter(Boolean);
        for (const clause of clauses) {
            if (LOCK_VERB_RE.test(clause)) continue;
            const wordlist = normalizeText(clause).split(' ')
                .filter((word) => word.length > 2 && !IDENTITY_STOPWORDS.has(word));
            if (wordlist.length < 2) continue;
            const novel = wordlist.filter((word) => !baseTokens.has(word));
            if (!novel.length) continue;
            base = base.replace(/[.,;]?\s*$/, '') + ', ' + clause.replace(/^[,\s]+/, '');
            baseTokens = new Set(normalizeText(base).split(' '));
        }
    }

    const result = [];
    segments.forEach((segment, index) => {
        if (drop.has(index)) return;
        result.push(index === baseIndex ? base : segment);
    });
    return result;
}

// --- Lighting reconciliation ---------------------------------------------------

function classifyScene(scene) {
    const environment = normalizeText(scene && scene.environment);
    const lighting = normalizeText(scene && scene.lighting);
    const combined = environment + ' ' + lighting;
    const indoor = /\b(?:cafe|coffee|bakery|bedroom|living room|kitchen|office|bookshop|shop|store|indoor|interior|room|apartment|restaurant|bar|library|studio|bathroom|hallway|fitting room)\b/.test(environment);
    const outdoor = /\b(?:street|sidewalk|city|beach|park|outdoor|mountain|rooftop|balcony|forest|field|garden|plaza|road|market|harbor|harbour|trail|alley)\b/.test(environment);
    let timeOfDay = 'unknown';
    if (/\b(?:evening|night|dusk|sunset|moonlight|streetlight|storefront|neon)\b/.test(combined)) timeOfDay = 'evening';
    else if (/\b(?:golden hour|golden-hour|sunrise)\b/.test(combined)) timeOfDay = 'goldenHour';
    else if (/\b(?:overcast|cloudy|diffused|soft daylight)\b/.test(combined)) timeOfDay = 'overcast';
    else if (/\b(?:daylight|afternoon|morning|noon|sunlight|midday|bright)\b/.test(combined)) timeOfDay = 'day';
    else if (/\b(?:ambient|indoor|interior|lamp|window light)\b/.test(combined)) timeOfDay = 'ambient';
    // An outdoor "ambient" reading is just unfiltered daylight; normalize it so
    // the scene and its rewritten lighting phrase classify the same way and the
    // pass stays idempotent.
    if (outdoor && !indoor && timeOfDay === 'ambient') timeOfDay = 'day';
    return { indoor, outdoor, timeOfDay, hasLighting: Boolean(lighting) };
}

function segmentTimeOfDay(segment) {
    const text = normalizeText(segment);
    if (/\b(?:evening|night|dusk|sunset|moonlight)\b/.test(text)) return 'evening';
    if (/\b(?:golden hour|golden-hour|sunrise)\b/.test(text)) return 'goldenHour';
    if (/\b(?:overcast|cloudy|diffused)\b/.test(text)) return 'overcast';
    if (/\b(?:midday|noon|afternoon|morning|daylight|sunlight)\b/.test(text)) return 'day';
    return 'unknown';
}

// The phrase that names a conflicting time of day inside a segment. Used to
// rewrite the offending wording in place so an identity/action sentence that
// merely mentions the wrong light is not destroyed.
const TOD_PHRASE_RE = {
    evening: /\b(?:evening|night|dusk|sunset|moonlight|neon)\s*(?:sunlight|light|glow|sun|ambience|ambient light|streetlights?|storefront (?:lights?|signs?))?/i,
    goldenHour: /\b(?:warm\s+)?golden[- ]hour\s*(?:sunlight|light|glow|sun)?/i,
    overcast: /\b(?:overcast|cloudy|diffused)\s*(?:daylight|light|sky)?/i,
    day: /\b(?:midday|noon|afternoon|morning|daylight|sunlight|sun)\s*(?:light|lighting|glow)?/i,
    ambient: /\b(?:ambient|indoor|interior)\s*(?:lighting|light)?/i
};

// A lighting phrase that matches the scene, used when a contradictory phrase is
// replaced. Source warmth (e.g. streetlights) is named as its own light.
function sceneLightingPhrase(sceneCtx) {
    if (sceneCtx.indoor) return 'realistic indoor ambient light';
    if (sceneCtx.timeOfDay === 'evening') return 'natural evening light with warm streetlights and storefront lights';
    if (sceneCtx.timeOfDay === 'goldenHour') return 'warm golden-hour sunlight';
    if (sceneCtx.timeOfDay === 'overcast') return 'soft overcast daylight';
    if (sceneCtx.outdoor || sceneCtx.timeOfDay === 'day' || sceneCtx.timeOfDay === 'ambient') {
        return 'natural outdoor ambient daylight';
    }
    return 'natural, true-to-life lighting';
}

// A lighting clause is contradictory when it names a time of day that does not
// match the scene's own lighting. Indoor scenes tolerate a window/day mention;
// every other explicit mismatch (e.g. an indoor cafe described as golden hour,
// or a daytime street described as night) is reconciled away.
function lightingConflicts(segmentTod, sceneCtx) {
    if (segmentTod === 'unknown' || sceneCtx.timeOfDay === 'unknown') return false;
    if (segmentTod === sceneCtx.timeOfDay) return false;
    if (sceneCtx.indoor) return !(sceneCtx.timeOfDay === 'ambient' && segmentTod === 'day');
    if ((sceneCtx.timeOfDay === 'day' && segmentTod === 'overcast') ||
        (sceneCtx.timeOfDay === 'overcast' && segmentTod === 'day')) {
        return false;
    }
    return true;
}

function canonicalLightingSentence(sceneCtx) {
    if (sceneCtx.indoor) {
        return 'The scene is lit by realistic indoor ambient light with a neutral overall white balance';
    }
    if (sceneCtx.timeOfDay === 'evening') {
        return 'The scene is lit by natural evening ambience, with practical warm streetlights and storefront lights reading as their own light sources and a neutral overall white balance';
    }
    if (sceneCtx.timeOfDay === 'goldenHour') {
        return 'The scene is lit by warm golden-hour sunlight as a directional light source, with a neutral overall white balance';
    }
    if (sceneCtx.timeOfDay === 'overcast') {
        return 'The scene is lit by soft overcast daylight with a neutral overall white balance';
    }
    if (sceneCtx.outdoor || sceneCtx.timeOfDay === 'day' || sceneCtx.timeOfDay === 'ambient') {
        return 'The scene is lit by natural outdoor ambient daylight with a neutral overall white balance';
    }
    return 'The scene is lit with natural, true-to-life lighting and a neutral overall white balance';
}

// --- Colour / skin guidance ----------------------------------------------------

function isWarmSkin(identity) {
    const text = [identity.subject, identity.appearance, identity.hair].filter(Boolean).join(' ');
    return /\b(?:golden|warm|olive|amber|sun-?kissed)\s+(?:under)?tone\b|\bgolden\s+(?:skin|complexion|undertone)\b|\bwarm\s+(?:skin|complexion|undertone)\b|\bgolden[- ]toned\s+skin\b/i.test(text);
}

function dedupeSegments(segments) {
    const seen = new Set();
    const out = [];
    for (const segment of segments) {
        const key = normalizeText(segment);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(segment);
    }
    return out;
}

// --- Public API -----------------------------------------------------------------

function normalizeLifestylePrompt(prompt, options = {}) {
    const input = String(prompt || '').trim();
    if (!input) return '';
    const identity = options.identity && typeof options.identity === 'object' ? options.identity : {};
    const scene = options.scene && typeof options.scene === 'object' ? options.scene : {};

    // Drop any guidance a previous pass added (re-added at the end) so the pass
    // is idempotent and never accumulates clauses.
    const withoutGuidance = splitSegments(input).filter((segment) => !NO_CAST_RE.test(segment)).join(' ');

    let segments = splitSegments(stripGlobalColorGrade(withoutGuidance));
    segments = collapseIdentity(segments, identity);

    const sceneCtx = classifyScene(scene);
    // A user's own prompt is authoritative: if it names an explicit time of day,
    // that wins over the theme's default lighting so the scene's intended light
    // is never replaced indiscriminately.
    const userTimeOfDay = options.userPrompt ? segmentTimeOfDay(options.userPrompt) : 'unknown';
    if (userTimeOfDay !== 'unknown') sceneCtx.timeOfDay = userTimeOfDay;
    const kept = [];
    let hasLighting = false;
    for (const segment of segments) {
        if (LIGHTING_RE.test(segment)) {
            const tod = segmentTimeOfDay(segment);
            if (lightingConflicts(tod, sceneCtx)) {
                // Rewrite the offending wording in place, so a sentence that
                // also carries identity/action is not destroyed. Only a pure
                // lighting sentence with no in-place rewrite is dropped.
                const re = TOD_PHRASE_RE[tod];
                let replaced = false;
                const rewritten = re
                    ? segment.replace(re, () => { replaced = true; return sceneLightingPhrase(sceneCtx); })
                    : segment;
                if (replaced) {
                    kept.push(rewritten);
                    hasLighting = true;
                } else if (isIdentitySegment(segment, identity)) {
                    kept.push(segment);
                    hasLighting = true;
                }
                continue;
            }
            hasLighting = true;
        }
        kept.push(segment);
    }

    if (!hasLighting && (sceneCtx.indoor || sceneCtx.outdoor || sceneCtx.hasLighting)) {
        kept.push(canonicalLightingSentence(sceneCtx));
    }

    let text = tidy(dedupeSegments(kept).join('. '));

    if (!NO_CAST_RE.test(text)) {
        const guidance = isWarmSkin(identity) ? WARM_SKIN_GUIDANCE : NEUTRAL_GUIDANCE;
        text = tidy(text.replace(/[.\s]+$/, '') + '. ' + guidance);
    }

    return text;
}

// Append the one theme photography suffix, once. Idempotent.
function applyLifestyleSuffix(prompt) {
    const text = tidy(String(prompt || ''));
    if (!text) return '';
    if (text.includes(LIFESTYLE_PHOTOGRAPHY_SUFFIX)) return text;
    return tidy(text.replace(/[.\s]+$/, '') + '. ' + LIFESTYLE_PHOTOGRAPHY_SUFFIX);
}

function isLifestyleTheme(themeId) {
    return String(themeId || '') === LIFESTYLE_THEME_ID;
}

module.exports = {
    LIFESTYLE_THEME_ID,
    LIFESTYLE_PHOTOGRAPHY_SUFFIX,
    NEUTRAL_GUIDANCE,
    WARM_SKIN_GUIDANCE,
    isLifestyleTheme,
    normalizeLifestylePrompt,
    applyLifestyleSuffix
};
