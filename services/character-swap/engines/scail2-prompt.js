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
    const bits = clothingBits(description);
    return bits.length ? 'The character is wearing ' + bits.join('; ') + '.' : '';
}

function clothingBits(description) {
    if (!description || typeof description !== 'object') return [];
    return [
        description.clothing,
        description.footwear ? 'footwear: ' + description.footwear : '',
        description.accessories ? 'accessories: ' + description.accessories : ''
    ].map((value) => clean(value, 220)).filter(Boolean);
}

function identityBits(description, identitySummary) {
    if (description && typeof description === 'object') {
        const bits = [
            [clean(description.age, 40), clean(description.gender, 40)].filter(Boolean).join(' '),
            clean(description.face, 160),
            clean(description.hair, 160),
            clean(description.skin, 120),
            clean(description.build, 100),
            clean(description.distinguishing, 160)
        ].filter(Boolean);
        if (bits.length) return bits;
    }
    const summary = clean(identitySummary, 400);
    return summary ? [summary.replace(/[.]+$/, '')] : [];
}

function identityLine(description, identitySummary) {
    const bits = identityBits(description, identitySummary);
    return bits.length ? 'The character is ' + bits.join(', ') + '.' : '';
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

// The selected source subject's pose, action and props. SCAIL-2 keeps the
// performance from the driving video, so naming what the subject does and what
// they interact with anchors the replacement. It is written as description and
// placed before the user's own direction.
function subjectClause(subject) {
    if (!subject || typeof subject !== 'object') return '';
    const summary = clean(subject.summary, 500).replace(/[.]+$/, '');
    const action = clean(subject.action, 160).replace(/[.]+$/, '');
    const position = clean(subject.position, 160).replace(/[.]+$/, '');
    const objects = clean(subject.objects, 240).replace(/[.]+$/, '');
    let body = summary || [action, position].filter(Boolean).join(', ');
    if (!body) return '';
    body = body.charAt(0).toLowerCase() + body.slice(1);
    const firstObject = objects.split(',')[0].trim();
    const needsObjects = firstObject && body.toLowerCase().indexOf(firstObject.toLowerCase()) === -1;
    return body + '.' + (needsObjects ? ' The subject stays close to ' + objects + '.' : '');
}

function subjectLine(subject) {
    const clause = subjectClause(subject);
    return clause ? 'In the finished video, ' + clause : '';
}

function personName(person, index) {
    const place = clean(person && person.place, 40);
    if (place) return 'the person ' + place;
    return 'person ' + (index + 1);
}

function capitalise(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// Multi-character replacement: one finished-video description covering every
// selected person, so two characters share a single combined prompt. Each
// person keeps their own identity, clothing and subject wording.
function buildGroupPrompt(input) {
    const people = input.people.filter(Boolean);
    const scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    const sceneSummary = scene ? clean(scene.summary, 500).replace(/[.]+$/, '') : '';
    const viewpoint = scene ? clean(scene.viewpoint, 80).replace(/[.]+$/, '') : '';
    const otherPeople = scene ? clean(scene.otherPeople, 220).replace(/[.]+$/, '') : '';
    const extra = stripInstruction(input.userPrompt);
    const parts = [
        'A realistic video of the ' + people.length + ' selected people, whose appearance matches their reference characters.'
    ];
    people.forEach((person, index) => {
        const name = personName(person, index);
        const clause = subjectClause(person.subjectDescription || person.subject);
        if (clause) parts.push('In the finished video, ' + clause);
        const identity = identityBits(person.description, person.identitySummary);
        if (identity.length) parts.push(capitalise(name) + ' is ' + identity.join(', ') + '.');
        const clothing = clothingBits(person.description);
        if (clothing.length) parts.push(capitalise(name) + ' is wearing ' + clothing.join('; ') + '.');
    });
    parts.push('Each of them keeps the original body motion, posture, gestures, facial expression, gaze and timing of the source performance.');
    if (sceneSummary) parts.push('The scene shows ' + sceneSummary + '.');
    if (otherPeople) parts.push('The other people in the scene, ' + otherPeople + ', remain unchanged.');
    parts.push(viewpoint
        ? 'The camera keeps the same viewpoint, ' + viewpoint + ', as the original footage.'
        : 'The camera keeps the same angle, framing and movement as the original footage.');
    parts.push('The original lighting, shadows and colour tone fall across each character naturally, so the replacements blend into the scene.');
    if (extra && !TARGET_NOUNS.test(extra)) parts.push('Additional visible detail: ' + extra.replace(/[.]+$/, '') + '.');
    return parts.join(' ');
}

function buildScailPrompt(input = {}) {
    if (Array.isArray(input.people) && input.people.length > 1) return buildGroupPrompt(input);
    const description = input.description && typeof input.description === 'object' ? input.description : null;
    const scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    const subject = input.subject && typeof input.subject === 'object' ? input.subject : null;
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
    const subjectDescription = subjectLine(subject);
    if (subjectDescription) parts.push(subjectDescription);
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
    subjectLine,
    subjectClause,
    buildScailPrompt
};
