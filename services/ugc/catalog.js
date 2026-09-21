/* ============================================
   JARVIS — UGC Studio Catalog
   Data-only content types, environments and
   platforms used by UGC Studio. No logic, no
   prompting — just the option space so the UI
   never hardcodes a catalog and the studio can
   validate a selection.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const CONTENT_TYPES = Object.freeze([
    { id: 'product-demo', label: 'Product Demo', guidance: 'Show how the product is used or applied, step by step, in a natural setting.' },
    { id: 'testimonial', label: 'Testimonial', guidance: 'A creator talks about their experience with the product in their own words.' },
    { id: 'unboxing', label: 'Unboxing', guidance: 'Reveal and unpack the product, reacting naturally to what is inside.' },
    { id: 'problem-solution', label: 'Problem \u2192 Solution', guidance: 'Open on an everyday problem, then introduce the product as the solution.' },
    { id: 'lifestyle', label: 'Lifestyle Integration', guidance: 'The product fits naturally into a real routine or activity, not a staged ad.' },
    { id: 'routine-tutorial', label: 'Routine / Tutorial', guidance: 'Walk through a routine or how-to sequence that features the product.' },
    { id: 'showcase', label: 'Product Showcase', guidance: 'A close, deliberate look at the product — texture, details, and form.' },
    { id: 'comparison', label: 'Comparison', guidance: 'Contrast the product with an alternative, without inventing claims.' },
    { id: 'review', label: 'Review', guidance: 'An honest-feeling review of the product based only on supplied details.' },
    { id: 'before-after', label: 'Before & After (concept)', guidance: 'A conceptual before/after — never claim an unsupported result.' }
]);

const ENVIRONMENTS = Object.freeze([
    { id: 'home', label: 'Home', description: 'a bright, lived-in home interior' },
    { id: 'bedroom', label: 'Bedroom', description: 'a soft, natural-light bedroom' },
    { id: 'bathroom', label: 'Bathroom', description: 'a clean, modern bathroom' },
    { id: 'kitchen', label: 'Kitchen', description: 'a bright home kitchen with natural light' },
    { id: 'modern-apartment', label: 'Modern Apartment', description: 'a modern apartment living space with clean lines' },
    { id: 'outdoor-lifestyle', label: 'Outdoor Lifestyle', description: 'an outdoor lifestyle setting with natural daylight' },
    { id: 'studio', label: 'Studio', description: 'a clean, minimal studio set' },
    { id: 'office', label: 'Office', description: 'a modern office or desk workspace' },
    { id: 'cafe', label: 'Caf\u00e9', description: 'a warm neighbourhood caf\u00e9' },
    { id: 'custom', label: 'Custom', description: '' }
]);

const PLATFORMS = Object.freeze([
    { id: 'tiktok', label: 'TikTok' },
    { id: 'instagram-reels', label: 'Instagram Reels' },
    { id: 'instagram', label: 'Instagram' },
    { id: 'youtube-shorts', label: 'YouTube Shorts' },
    { id: 'youtube', label: 'YouTube' },
    { id: 'facebook', label: 'Facebook' },
    { id: 'generic', label: 'Generic / Unsure' }
]);

function find(list, id) {
    const key = String(id || '').trim().toLowerCase();
    if (!key) return null;
    return list.find((item) => item.id === key) || null;
}

function getContentType(id) {
    return find(CONTENT_TYPES, id);
}

function getEnvironment(id) {
    return find(ENVIRONMENTS, id);
}

function getPlatform(id) {
    return find(PLATFORMS, id);
}

// Resolve a free-text environment mention to a catalog entry. "Custom" is
// returned when the user names something the catalog does not cover so the
// exact wording survives.
const ENVIRONMENT_HINTS = [
    { id: 'bathroom', re: /\bbath(?:room)?\b/i },
    { id: 'bedroom', re: /\bbedroom\b/i },
    { id: 'kitchen', re: /\bkitchen\b/i },
    { id: 'modern-apartment', re: /\b(?:apartment|flat|loft|condo)\b/i },
    { id: 'outdoor-lifestyle', re: /\b(?:outdoor|outside|park|garden|beach|street|nature)\b/i },
    { id: 'studio', re: /\bstudio\b/i },
    { id: 'office', re: /\b(?:office|desk|workspace|coworking)\b/i },
    { id: 'cafe', re: /\bcaf[e\u00e9]\b|\bcoffee\s+shop\b/i },
    { id: 'home', re: /\b(?:home|house|living\s+room|indoors?)\b/i }
];

function detectEnvironment(text) {
    const value = String(text || '');
    for (const hint of ENVIRONMENT_HINTS) {
        if (hint.re.test(value)) return hint.id;
    }
    return null;
}

const CONTENT_TYPE_HINTS = [
    { id: 'unboxing', re: /\bunbox(?:ing)?\b/i },
    { id: 'testimonial', re: /\btestimonial\b|\breview\b/i },
    { id: 'problem-solution', re: /\bproblem\b.{0,20}\bsolution\b|\bbefore\s*(?:and|&)\s*after\b/i },
    { id: 'routine-tutorial', re: /\b(?:routine|tutorial|how\s+to|step\s+by\s+step|morning\s+routine)\b/i },
    { id: 'comparison', re: /\b(?:comparison|compare|versus|vs\.?)\b/i },
    { id: 'showcase', re: /\b(?:showcase|close[\s-]?up|product\s+shot)\b/i },
    { id: 'demo', re: /\b(?:demo|demonstrat|apply|application|how\s+it\s+works|use\s+it)\b/i },
    { id: 'lifestyle', re: /\blifestyle\b|\bdaily\s+life\b|\bvlog\b/i }
];

function detectContentType(text) {
    const value = String(text || '');
    for (const hint of CONTENT_TYPE_HINTS) {
        if (hint.re.test(value)) return hint.id === 'demo' ? 'product-demo' : hint.id;
    }
    return null;
}

const PLATFORM_HINTS = [
    { id: 'tiktok', re: /\btik\s*tok\b/i },
    { id: 'instagram-reels', re: /\binstagram\s+reels?\b|\breels?\b/i },
    { id: 'instagram', re: /\binstagram\b|\big\b/i },
    { id: 'youtube-shorts', re: /\byoutube\s+shorts?\b|\bshorts?\b/i },
    { id: 'youtube', re: /\byoutube\b/i },
    { id: 'facebook', re: /\bfacebook\b|\bfb\b/i }
];

function detectPlatform(text) {
    const value = String(text || '');
    for (const hint of PLATFORM_HINTS) {
        if (hint.re.test(value)) return hint.id;
    }
    return null;
}

// Infer a sensible default platform from the aspect ratio / duration when the
// user never named one (short + vertical is nearly always social-first).
function defaultPlatformFor(aspectRatio, duration) {
    const ratio = String(aspectRatio || '');
    const seconds = Number(duration);
    if ((ratio === '9:16' || ratio === '4:5') && Number.isFinite(seconds) && seconds <= 60) {
        return 'tiktok';
    }
    return 'generic';
}

module.exports = {
    CONTENT_TYPES,
    ENVIRONMENTS,
    PLATFORMS,
    getContentType,
    getEnvironment,
    getPlatform,
    detectEnvironment,
    detectContentType,
    detectPlatform,
    defaultPlatformFor
};
