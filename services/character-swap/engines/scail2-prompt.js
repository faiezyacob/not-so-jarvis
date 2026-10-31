/* ============================================
   JARVIS — SCAIL-2 replacement prompt composer
   SCAIL-2 prompts describe the finished video,
   never an instruction. This module turns the
   structured character identity + the cached
   source-scene caption + the user's short
   direction into a positive description of the
   replaced scene, in the official format.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const TARGET_NOUNS = /\b(person|people|man|woman|guy|girl|boy|subject|character|figure|performer|actor|actress|someone|somebody|child|kid|adult|individual|dancer|leader|speaker)\b/i;
const POSITION_WORDS = /\b(left|right|middle|centre|center|foreground|background|front|back|beside|next\s+to)\b/i;
const NON_TARGETS = /\b(background|scene|setting|environment|lighting|camera|angle|framing|colour|color|palette|style|outfit|clothes|clothing|dress|shirt|jacket|logo|text|watermark)\b/i;

function clean(value, limit) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .slice(0, limit || 500);
}

function withArticle(text) {
    const value = clean(text, 90);
    if (!value) return '';
    if (/^(the|a|an|this|that|these|those)\b/i.test(value)) return value;
    return 'the ' + value;
}

// The person the user asked to replace. Used for target selection and to keep
// the finished-video description anchored to the right subject. It is never
// written as an imperative into the SCAIL prompt.
function extractTarget(prompt) {
    const text = clean(prompt, 1200);
    if (!text) return '';
    const patterns = [
        /\b(?:replace|swap|change|turn)\s+(?:out\s+)?(?:the\s+)?(.+?)(?=\s+(?:with|to|into|by|using|for)\b|[.,;!?]|$)/i,
        /\b(?:the\s+)?(.+?)\s+(?:should|needs?\s+to|must|has\s+to)\s+be\s+(?:replaced|swapped|changed|turned)\b/i,
        /\b(?:make|keep)\s+(?:the\s+)?(.+?)\s+(?:the|into\s+the)\s+(?:reference|character)\b/i
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (!match) continue;
        const target = clean(match[1], 90)
            .replace(/^(?:only|just)\s+/i, '')
            .replace(/\s+(?:is|be|should|needs?|must|has\s+to)$/i, '');
        if (!target || target.length > 70) continue;
        if (!(TARGET_NOUNS.test(target) || POSITION_WORDS.test(target))) continue;
        if (!TARGET_NOUNS.test(target) && NON_TARGETS.test(target)) continue;
        return withArticle(target);
    }
    return '';
}

function clothingLine(description) {
    if (!description || typeof description !== 'object') return '';
    const bits = [
        description.clothing,
        description.footwear ? 'footwear: ' + description.footwear : '',
        description.accessories ? 'accessories: ' + description.accessories : ''
    ].map((value) => clean(value, 220)).filter(Boolean);
    return bits.length ? 'The character is wearing ' + bits.join('; ') + '.' : '';
}

function identityLine(description, identitySummary) {
    if (description && typeof description === 'object') {
        const bits = [
            [clean(description.age, 40), clean(description.gender, 40)].filter(Boolean).join(' '),
            clean(description.face, 160),
            clean(description.hair, 160),
            clean(description.skin, 120),
            clean(description.build, 100),
            clean(description.distinguishing, 160)
        ].filter(Boolean);
        if (bits.length) return 'The character is ' + bits.join(', ') + '.';
    }
    const summary = clean(identitySummary, 400);
    return summary ? 'The character is ' + summary.replace(/[.]+$/, '') + '.' : '';
}

// Drop imperative replacement wording so the prompt reads as a description of
// the finished video. Detail that is genuinely about the scene is preserved.
function stripInstruction(value) {
    return clean(value, 1200)
        .replace(/\b(?:please\s+)?(?:replace|swap|change|turn)\b[\s\S]*?(?:\bwith\b|\bto\b|\binto\b|\bby\b|\busing\b)/gi, '')
        .replace(/\b(?:replace|swap|change|turn)\s+(?:out\s+)?(?:the\s+)?[^.,;!?]+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildScailPrompt(input = {}) {
    const description = input.description && typeof input.description === 'object' ? input.description : null;
    const scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    const target = extractTarget(input.userPrompt) || 'the main person';
    const identity = identityLine(description, input.identitySummary);
    const clothing = clothingLine(description);
    const sceneSummary = scene ? clean(scene.summary, 500).replace(/[.]+$/, '') : '';
    const viewpoint = scene ? clean(scene.viewpoint, 80).replace(/[.]+$/, '') : '';
    const otherPeople = scene ? clean(scene.otherPeople, 220).replace(/[.]+$/, '') : '';
    const extra = stripInstruction(input.userPrompt);

    const parts = [
        'A realistic video of ' + target + ', whose appearance matches the reference character.'
    ];
    if (identity) parts.push(identity);
    if (clothing) parts.push(clothing);
    parts.push(target.charAt(0).toUpperCase() + target.slice(1) +
        ' keeps the original body motion, posture, gestures, facial expression, gaze and timing of the source performance.');
    if (sceneSummary) parts.push('The scene shows ' + sceneSummary + '.');
    if (otherPeople) parts.push('The other people in the scene, ' + otherPeople + ', remain unchanged.');
    parts.push(viewpoint
        ? 'The camera keeps the same viewpoint, ' + viewpoint + ', as the original footage.'
        : 'The camera keeps the same angle, framing and movement as the original footage.');
    parts.push('The original lighting, shadows and colour tone fall across the character naturally, so the replacement blends into the scene.');
    if (extra && !TARGET_NOUNS.test(extra)) parts.push('Additional visible detail: ' + extra.replace(/[.]+$/, '') + '.');
    return parts.join(' ');
}

module.exports = {
    TARGET_NOUNS,
    POSITION_WORDS,
    NON_TARGETS,
    extractTarget,
    stripInstruction,
    buildScailPrompt
};
