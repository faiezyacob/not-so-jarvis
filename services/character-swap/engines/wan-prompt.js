/* ============================================
   JARVIS — Wan Animate 2 prompt composer
   Wan-specific scene wording. Never emits H3
   <Picture>/<Video>/<d> tokens or reference
   sections.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const DEFAULT_NEGATIVE = [
    'blurry',
    'low quality',
    'worst quality',
    'jpeg artifacts',
    'distorted face',
    'deformed face',
    'extra limbs',
    'extra fingers',
    'fused fingers',
    'malformed hands',
    'missing fingers',
    'duplicate person',
    'warped background',
    'flicker',
    'static',
    'text',
    'watermark',
    'logo'
].join(', ');

function clean(value, max = 4000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stripH3Language(text) {
    return clean(text)
        .replace(/<Picture\s*\d+>/gi, 'the reference person')
        .replace(/<Video\s*\d+>/gi, 'the original video')
        .replace(/<Audio\s*\d+>/gi, 'the original audio')
        .replace(/<d>[\s\S]*?<\/d>/gi, '')
        .replace(/\b(?:subject_definitions|retention_analysis)\b\s*[:：]?/gi, '')
        .replace(/\[Shot\s*\d+\]/gi, '')
        .replace(/\bAt\s+\d{2}:\d{2}\.\d{3}\b/g, '');
}

function identityLine(person) {
    const description = person && person.description && typeof person.description === 'object'
        ? person.description
        : null;
    if (!description) return '';
    const bits = [
        description.identitySummary,
        [description.age, description.gender].filter(Boolean).join(' '),
        description.hair,
        description.build,
        description.clothing,
        description.accessories
    ].map((value) => clean(value, 200)).filter(Boolean);
    return bits.length ? 'The person: ' + Array.from(new Set(bits)).join(', ') + '.' : '';
}

function buildPositivePrompt(person, notes) {
    const parts = [
        'A realistic video of the person from the reference image inside the original scene.',
        'They keep the original body motion, gestures, facial expression, gaze, camera movement and timing.',
        'The original background, lighting, shadows, furniture, objects and every other person stay exactly as they are in the source video.',
        identityLine(person),
        'The replacement blends naturally into the source lighting and colour tone.'
    ];
    const extra = stripH3Language(notes);
    if (extra) parts.push(extra);
    return parts.filter(Boolean).join(' ');
}

function buildNegativePrompt(value) {
    const text = clean(value);
    return text || DEFAULT_NEGATIVE;
}

module.exports = {
    DEFAULT_NEGATIVE,
    stripH3Language,
    identityLine,
    buildPositivePrompt,
    buildNegativePrompt
};
