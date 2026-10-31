/* ============================================
   JARVIS — Character Swap prompt composer
   Rigless-compatible single/group replacement
   wording, reference roles and view ordering.
   Behaviour adapted from Rigless (Apache-2.0);
   this implementation is original JavaScript.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const MAX_PICTURES = 9;

const ROLE_ORDER = {
    front: ['front', 'full', 'close', 'side', 'back', 'other'],
    side: ['side', 'full', 'front', 'close', 'back', 'other'],
    back: ['back', 'full', 'side', 'close', 'front', 'other']
};

const VIEW_TEXT = {
    front: '<Picture {n}> is the same person facing the camera.',
    back: '<Picture {n}> shows the same person from behind.',
    close: '<Picture {n}> is a close-up of the same person\'s face.',
    side: '<Picture {n}> is a side view of the same person.',
    full: '<Picture {n}> shows the same person full body, head to toe.',
    other: '<Picture {n}> is another view of the same person.'
};

function roleOf(reference) {
    const role = String(reference && reference.role || '').toLowerCase();
    if (role === 'closeup' || role === 'close_up' || role === 'face') return 'close';
    if (role === 'full_body' || role === 'fullbody') return 'full';
    if (role === 'front' || role === 'back' || role === 'side' || role === 'full') return role;
    return 'other';
}

function orderReferences(person) {
    const refs = Array.isArray(person && person.refs) ? person.refs : [];
    const facing = ['front', 'side', 'back'].includes(person && person.facing) ? person.facing : 'front';
    const priority = ROLE_ORDER[facing] || ROLE_ORDER.front;
    const ranked = refs.slice().sort((a, b) => {
        const ai = priority.indexOf(roleOf(a));
        const bi = priority.indexOf(roleOf(b));
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    return ranked.slice(0, MAX_PICTURES);
}

// The ONE identity image a geometry-driven engine (Wan Animate) uses for a
// person. It is chosen from the person's real facing (front/side/back via the
// existing ordering) and then locked for every window and every pass, so a
// replacement can never switch references mid-clip.
function selectIdentityReference(person) {
    const refs = Array.isArray(person && person.refs) ? person.refs : [];
    if (!refs.length) return null;
    return orderReferences(person)[0] || refs[0];
}

function structuredSummary(description) {
    const d = description && typeof description === 'object' ? description : {};
    const parts = [];
    const push = (value) => {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (text && !parts.includes(text)) parts.push(text);
    };
    push(d.identitySummary);
    push([d.age, d.gender].filter(Boolean).join(' '));
    push(d.skin);
    push(d.face);
    push(d.eyes);
    push(d.eyebrows ? d.eyebrows + ' eyebrows' : '');
    push(d.hair);
    push(d.build);
    push(d.clothing);
    push(d.footwear);
    push(d.accessories);
    push(d.distinguishing);
    return parts.join(', ');
}

function noneOf(items) {
    const list = (Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!list.length) return '';
    const parts = list.map((item) => 'no ' + item);
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

function views(roles, first) {
    return roles.map((role, index) => {
        const n = first + index;
        if (n === first && role !== 'back') return '';
        return (VIEW_TEXT[role] || VIEW_TEXT.other).replace('{n}', n);
    }).filter(Boolean);
}

function personLine(person, first) {
    const description = structuredSummary(person.description);
    if (!description) return '';
    return 'The person in <Picture ' + first + '>: ' + description + '.';
}

function singlePrompt(person, notes) {
    const refs = orderReferences(person);
    const roles = refs.map(roleOf);
    const sentences = [
        'Replace the selected person in <Video 1> with the person in <Picture 1>.',
        ...views(roles, 1),
        'Keep the reference person\'s face, hair and clothing. Follow the source performance\'s pose, gaze, expression and movement. Preserve the scene and the other people.',
        'The background, camera movement, lighting, shadows and every other person come from <Video 1>. Never paint the reference picture\'s background into the scene.'
    ];
    const description = structuredSummary(person.description);
    if (description) sentences.push('The person in the pictures: ' + description + '.');
    const unlike = noneOf(person.description && person.description.unlike);
    if (unlike) sentences.push('Unlike the original person, they have ' + unlike + '.');
    if (notes && String(notes).trim()) sentences.push(String(notes).trim());
    return sentences.filter(Boolean).join(' ');
}

function groupPrompt(people, notes) {
    const ordered = people.map((person) => ({ person, refs: orderReferences(person) }));
    const firsts = [];
    let cursor = 1;
    for (const item of ordered) {
        firsts.push(cursor);
        cursor += item.refs.length;
    }
    const sentences = ['Replace the ' + ordered.length + ' selected people in <Video 1>.'];
    ordered.forEach((item, index) => {
        const where = item.person.place || '';
        const look = item.person.look ? ', ' + item.person.look : '';
        sentences.push('The person ' + where + look + ' becomes the person in <Picture ' + firsts[index] + '>.');
        sentences.push(...views(item.refs.map(roleOf), firsts[index]));
    });
    sentences.push('Keep each reference person\'s face, hair and clothing. Follow each source performance\'s pose, gaze, expression and movement. Preserve the scene and the other people.');
    sentences.push('The background, camera movement, lighting, shadows and every other person come from <Video 1>. Never paint a reference picture\'s background into the scene.');
    ordered.forEach((item, index) => {
        const line = personLine(item.person, firsts[index]);
        if (line) sentences.push(line);
        const unlike = noneOf(item.person.description && item.person.description.unlike);
        if (unlike) {
            sentences.push('Unlike the original person ' + (item.person.place || '') + ', they have ' + unlike + '.');
        }
    });
    if (notes && String(notes).trim()) sentences.push(String(notes).trim());
    return sentences.filter(Boolean).join(' ');
}

function buildPrompt(people, notes) {
    const list = (Array.isArray(people) ? people : []).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return singlePrompt(list[0], notes);
    return groupPrompt(list, notes);
}

function places(people) {
    if (people.length === 2) return ['on the left', 'on the right'];
    if (people.length === 3) return ['on the left', 'in the middle', 'on the right'];
    return people.map((_, index) => 'person ' + (index + 1));
}

function assignPlaces(people) {
    const words = places(people);
    const order = people.map((person, index) => ({ person, index, x: Number(person.x) || 0.5 }))
        .sort((a, b) => a.x - b.x);
    order.forEach((item, rank) => {
        item.person.place = words[rank] || ('person ' + (rank + 1));
    });
    return people;
}

module.exports = {
    MAX_PICTURES,
    roleOf,
    orderReferences,
    selectIdentityReference,
    structuredSummary,
    buildPrompt,
    assignPlaces
};
