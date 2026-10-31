/* ============================================
   JARVIS — Wan Animate 2 swap prompt composer
   Wan Animate 2 is a Move-style model: the
   performance video supplies motion and the
   text prompt supplies appearance, background
   and viewpoint. This module turns a short
   user direction ("replace the person on the
   left") into the model's subject + background
   format with an explicit preservation clause,
   so only the named subject changes.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const TARGET_NOUNS = /\b(person|people|man|woman|guy|girl|boy|subject|character|figure|performer|actor|actress|someone|somebody|child|kid|adult|individual|dancer|leader|speaker)\b/i;
const POSITION_WORDS = /\b(left|right|middle|centre|center|foreground|background|front|back|beside|next\s+to)\b/i;
const NON_TARGETS = /\b(background|scene|setting|environment|lighting|camera|angle|framing|colour|color|palette|style|outfit|clothes|clothing|dress|shirt|jacket|logo|text|watermark)\b/i;

const SCENE_WORDS = /\b(street|road|room|cafe|coffee\s*shop|restaurant|office|park|beach|forest|city|town|village|studio|stage|house|home|kitchen|bedroom|bathroom|alley|rooftop|garden|mall|shop|store|bar|club|nightclub|gym|school|classroom|hospital|station|airport|train|bus|car|library|museum|church|temple|mountain|river|lake|ocean|sea|desert|snow|rain|market|square|bridge|harbour|harbor|warehouse|factory|garage|attic|basement|hallway|corridor|lobby|elevator|boat|plane|field|meadow|cliff|waterfall|cave|campsite|hotel|apartment|balcony|terrace|patio|deck|pool|spa|salon|theatre|theater|cinema|arcade|carnival|fair|festival|wedding|mosque|synagogue)\b/i;

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

// Every "in a <scene>", "at the <place>", ... phrase that is genuinely a
// background cue. A phrase that begins with a position word ("on the left in
// a cafe") is skipped; the inner "in a cafe" match is used instead.
function scenePhraseMatches(text) {
    const out = [];
    const re = /\b(?:in|at|on|inside)\s+(?:a|an|the)\s+([^.,;!?]+)/gi;
    let match;
    while ((match = re.exec(text))) {
        const capture = String(match[1] || '').trim();
        const first = capture.split(/\s+/)[0] || '';
        if (POSITION_WORDS.test(first) || !SCENE_WORDS.test(capture)) {
            re.lastIndex = match.index + 1;
            continue;
        }
        out.push({ index: match.index, phrase: clean(match[0], 200), capture });
    }
    return out;
}

// A scene phrase at the very end of a target ("the person on the left in a
// busy cafe") is not part of the person. Only strip it when the remaining head
// still names a person AND a position, so "the person in the car" survives.
function stripTrailingScene(target) {
    if (!POSITION_WORDS.test(target)) return target;
    const matches = scenePhraseMatches(target);
    for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index];
        if (target.slice(match.index + match.phrase.length).trim()) continue;
        const head = target.slice(0, match.index).trim();
        if (TARGET_NOUNS.test(head) && POSITION_WORDS.test(head)) return head;
    }
    return target;
}

// The person the user asked to replace. The patterns stop before "with/to/
// into" so a user note about the replacement image never becomes the target.
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
        let target = clean(match[1], 90)
            .replace(/^(?:only|just)\s+/i, '')
            .replace(/\s+(?:is|be|should|needs?|must|has\s+to)$/i, '');
        target = stripTrailingScene(target);
        if (!target || target.length > 70) continue;
        const namesPerson = TARGET_NOUNS.test(target) || POSITION_WORDS.test(target);
        if (!namesPerson) continue;
        if (!TARGET_NOUNS.test(target) && NON_TARGETS.test(target)) continue;
        return withArticle(target);
    }
    return '';
}

// An explicit new scene the user wants INSTEAD of the original one. Only a
// real background cue is accepted; "the person on the left" is not a scene.
function extractSceneOverride(prompt) {
    const text = clean(prompt, 1200);
    if (!text) return '';
    const explicit = text.match(/\b(?:background|scene|setting|environment)\s*(?:is|:|=|becomes?|change(?:d)?\s+to|to)\s*(.+)$/i);
    if (explicit) {
        const value = clean(explicit[1], 240);
        if (value) return value;
    }
    const matches = scenePhraseMatches(text);
    return matches.length ? matches[matches.length - 1].phrase : '';
}

function buildSwapPrompt(input = {}) {
    const userPrompt = clean(input.userPrompt, 1200);
    const identitySummary = clean(input.identitySummary, 400);
    const scene = input.scene && typeof input.scene === 'object' ? input.scene : null;
    const target = extractTarget(userPrompt) || 'the subject';
    const appearance = (identitySummary || 'the character shown in the reference image').replace(/[.]+$/, '');
    const override = extractSceneOverride(userPrompt);
    const sceneSummary = (scene ? clean(scene.summary, 420) : '').replace(/[.]+$/, '');
    const background = (override || sceneSummary ||
        'the same background as the original video: the same location, set, props, lighting, colour palette and camera framing').replace(/[.]+$/, '');
    const otherPeople = (scene ? clean(scene.otherPeople, 200) : '').replace(/[.]+$/, '');
    const viewpoint = (scene ? clean(scene.viewpoint, 80) : '').replace(/[.]+$/, '');

    const parts = [
        'Subject appearance: ' + appearance + '.',
        'Change: only ' + target + ' is replaced by this character; every other person stays unchanged.',
        'Background: ' + background + '.'
    ];
    if (otherPeople) parts.push('Other people: ' + otherPeople + '.');
    parts.push(viewpoint
        ? 'Viewpoint: ' + viewpoint + ', matching the original video.'
        : 'Viewpoint: the same camera angle, framing and crop as the original video.');
    parts.push('Preservation: keep the original video\'s background, set, props, lighting, colours, ' +
        'camera angle, framing, timing and audio unchanged. Do not add, remove, move or restyle ' +
        'anything except ' + target + '.');
    return parts.join(' ');
}

module.exports = {
    TARGET_NOUNS,
    POSITION_WORDS,
    NON_TARGETS,
    SCENE_WORDS,
    extractTarget,
    extractSceneOverride,
    buildSwapPrompt
};
