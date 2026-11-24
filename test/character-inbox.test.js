/* ============================================
   JARVIS — Character photo inbox tests
   Delivery policy, message composition and the
   per-character tray. No GPU and no ComfyUI call:
   the render is the server's job, not this module's.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-inbox-'));
process.env.CHARACTER_LIFE_PATH = path.join(TMP, 'character-life.json');

const store = require('../services/character-life/store');
const inbox = require('../services/character-life/inbox');
const moments = require('../services/character-life/moments');
const characterLife = require('../services/character-life');

const NOW = Date.parse('2026-06-01T15:00:00.000Z');

function reset() {
    store._reset();
    try { fs.unlinkSync(process.env.CHARACTER_LIFE_PATH); } catch (err) { /* first run */ }
    store._reset();
}

function behavior(overrides) {
    return Object.assign({
        initiative: 'scheduled',
        photoSharing: 'auto',
        lifeProgression: true,
        lifeIntervalMinutes: 180,
        proactiveMinIntervalMinutes: 180,
        quietHoursStart: 22,
        quietHoursEnd: 8
    }, overrides || {});
}

function seedLife(characterId) {
    store.setLife(characterId, {
        activity: 'Grabbing a coffee',
        location: 'the corner cafe',
        outfit: 'denim jacket and a white tee',
        mood: 'content'
    }, 'llm');
}

test('a drop requires the explicit opt-in', () => {
    reset();
    seedLife('maya');
    const record = store.getRecord('maya');
    assert.equal(inbox.dueCheck({ behavior: behavior({ photoSharing: 'off' }), record, now: NOW, hour: 15 }).reason, 'disabled');
    assert.equal(inbox.dueCheck({ behavior: behavior({ photoSharing: 'ask' }), record, now: NOW, hour: 15 }).reason, 'not_auto');
    assert.equal(inbox.dueCheck({ behavior: behavior({ initiative: 'passive' }), record, now: NOW, hour: 15 }).reason, 'passive');
    assert.equal(inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 15 }).due, true);
});

test('quiet hours and an empty life state hold the drop back', () => {
    reset();
    seedLife('maya');
    const record = store.getRecord('maya');
    assert.equal(inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 23 }).reason, 'quiet_hours');
    assert.equal(inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 4 }).reason, 'quiet_hours');
    assert.equal(inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 15 }).due, true);

    reset();
    assert.equal(inbox.dueCheck({
        behavior: behavior(), record: store.ensureRecord('maya'), now: NOW, hour: 15
    }).reason, 'no_life');
});

test('the interval and the unread cap are both respected', () => {
    reset();
    seedLife('maya');
    const record = store.ensureRecord('maya');
    record.lastInboxAt = new Date(NOW - 30 * 60000).toISOString();
    record.inbox.push({
        id: 'note_a', status: 'ready', url: '/generated/a.png', file: 'a.png',
        caption: 'Hi.', createdAt: new Date(NOW - 30 * 60000).toISOString(), readAt: null
    });
    assert.equal(inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 15 }).reason, 'too_soon');

    record.inbox[0].readAt = new Date(NOW - 29 * 60000).toISOString();
    record.inbox.push({ id: 'note_b', status: 'ready', url: '/generated/b.png', file: 'b.png', caption: 'Hey.', createdAt: new Date(NOW - 20 * 60000).toISOString(), readAt: null });
    record.inbox.push({ id: 'note_c', status: 'ready', url: '/generated/c.png', file: 'c.png', caption: 'Hey.', createdAt: new Date(NOW - 10 * 60000).toISOString(), readAt: null });
    const state = inbox.dueCheck({ behavior: behavior(), record, now: NOW + 5 * 3600000, hour: 15 });
    assert.equal(state.reason, 'unread_full');
    assert.equal(state.unread, 2);
});

test('a failed attempt waits a full interval instead of retrying every tick', () => {
    reset();
    seedLife('maya');
    store.setLastInboxAttemptAt('maya', new Date(NOW - 5 * 60000).toISOString());
    const record = store.getRecord('maya');
    const soon = inbox.dueCheck({ behavior: behavior(), record, now: NOW, hour: 15 });
    assert.equal(soon.reason, 'too_soon');
    const later = inbox.dueCheck({ behavior: behavior(), record, now: NOW + 4 * 3600000, hour: 15 });
    assert.equal(later.due, true);
});

test('the message reads like a text and never uses an em dash', () => {
    const caption = inbox.captionFor({ activity: 'walking home from the gym', location: 'the park', mood: 'tired' });
    assert.ok(caption.length > 0);
    assert.ok(caption.endsWith('.'));
    assert.equal(caption.indexOf('\u2014'), -1);
    assert.equal(caption.indexOf('\u2013'), -1);
    assert.ok(/walking home from the gym/i.test(caption), 'the activity is the message');
    assert.equal(inbox.captionFor({}).length > 0, true, 'an empty life still gets a line');
});

test('a captured photo lands in the tray as unread and can be read and deleted', () => {
    reset();
    seedLife('maya');
    const item = inbox.capture('maya', {
        result: { url: '/generated/photo.png', filename: 'photo.png' },
        spec: { intent: 'selfie', cameraView: 'front', activity: 'Grabbing a coffee', location: 'the corner cafe' },
        caption: 'Grabbing a coffee.',
        summary: 'front camera selfie'
    });
    assert.ok(item && item.id);
    assert.equal(item.readAt, null);
    assert.equal(inbox.unreadCount('maya'), 1);
    assert.equal(store.getLastInboxAt('maya'), item.createdAt);

    const read = inbox.markRead('maya', item.id);
    assert.ok(read.readAt);
    assert.equal(inbox.unreadCount('maya'), 0);

    const removed = inbox.remove('maya', item.id);
    assert.equal(removed.id, item.id);
    assert.equal(inbox.listInbox('maya').length, 0);
});

test('the tray keeps the newest items and stays bounded', () => {
    reset();
    for (let i = 0; i < store.LIMITS.INBOX + 6; i++) {
        store.addInboxItem('maya', {
            url: '/generated/p' + i + '.png',
            file: 'p' + i + '.png',
            caption: 'photo ' + i,
            createdAt: new Date(NOW + i * 1000).toISOString()
        });
    }
    const list = inbox.listInbox('maya');
    assert.equal(list.length, store.LIMITS.INBOX);
    assert.equal(list[0].caption, 'photo ' + (store.LIMITS.INBOX + 5), 'newest first');
});

test('an unprompted photo plans a creative moment with a message in her voice', () => {
    reset();
    seedLife('maya');
    const plan = characterLife.inboxPlan('maya');
    assert.ok(plan.moment, 'expected a structured moment');
    assert.ok(plan.moment.activity.length > 0);
    assert.ok(plan.moment.location.length > 0);
    assert.ok(plan.moment.framing.length > 0);
    assert.ok(['selfie', 'outfit'].includes(plan.intent), 'a character moment is a selfie or mirror shot');
    assert.ok(plan.caption.length > 0);
    assert.ok(plan.reason.length > 0);
});

test('a moment recomposes the photo instead of only changing clothes', () => {
    reset();
    seedLife('maya');
    const plan = characterLife.planPhoto({
        characterId: 'maya',
        intent: 'selfie',
        moment: {
            id: 'bed-morning',
            title: 'Morning in bed',
            location: 'her bedroom',
            activity: 'lying in bed on her stomach, propped up on both elbows',
            stance: 'lying',
            camera: 'front',
            framing: 'close, chest-up, the pillow visible',
            angle: 'slightly above, the phone propped against the mattress',
            composition: 'she fills the frame against rumpled bedding',
            hands: 'one hand tucked under the pillow, the other resting on the duvet',
            lighting: 'soft morning light',
            mood: 'sleepy'
        },
        characters: [{ name: 'Maya' }],
        message: ''
    });
    assert.equal(plan.spec.location, 'her bedroom');
    assert.equal(plan.spec.momentTitle, 'Morning in bed');
    assert.equal(plan.spec.outfitSource, 'auto', 'a moment in a different room composes a wardrobe');
    assert.ok(plan.spec.outfit.length > 0);
    assert.ok(!/denim jacket/.test(plan.spec.outfit), 'the cafe outfit does not follow her to bed');
    assert.match(plan.request.instruction, /lying in bed on her stomach/);
    assert.match(plan.request.instruction, /fully dressed/i);
    assert.match(plan.request.instruction, /Recompose the frame completely/);
    assert.match(plan.request.instruction, /ANATOMY/);
    assert.match(plan.request.instruction, /Hands: one hand tucked under the pillow/);
    assert.match(plan.request.instruction, /five fingers/);
    assert.match(plan.request.instruction, /FINAL REMINDER/);
    assert.equal(plan.posture.stance, 'lying');
    assert.match(plan.posture.phrase, /lying in bed on her stomach/);
});

test('a moment in the same place keeps the life outfit', () => {
    reset();
    seedLife('maya');
    const plan = characterLife.planPhoto({
        characterId: 'maya',
        intent: 'selfie',
        moment: {
            id: 'cafe-window', title: 'Cafe window', location: 'the corner cafe',
            activity: 'sitting at the cafe table with a coffee', stance: 'sitting', camera: 'front',
            framing: 'close, the window behind her', angle: 'phone propped on the table',
            composition: 'warm cafe light', lighting: 'soft window light', mood: 'calm'
        },
        characters: [{ name: 'Maya' }],
        message: ''
    });
    assert.equal(plan.spec.outfitSource, 'life');
    assert.match(plan.spec.outfit, /denim jacket/);
});

test('consecutive drops avoid repeating the last moment', () => {
    const first = moments.pickDeterministicMoment({ seed: 1, count: 0, hour: 15, recent: [] });
    const second = moments.pickDeterministicMoment({ seed: 1, count: 1, hour: 15, recent: [first.title] });
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.activity, first.activity);
});

test('a moment never reuses the last photo outfit when there is no life state', () => {
    reset();
    // Erika-style character: no life state at all, but a previous photo in the
    // scene history. A new moment must compose a fresh wardrobe, not inherit it.
    store.addSceneEntry('erika', {
        summary: 'front camera selfie — a minimalist kitchen — sitting on the kitchen counter',
        activity: 'sitting on the kitchen counter',
        location: 'a minimalist kitchen',
        outfit: 'a lightweight beige overshirt over a white henley top'
    });
    const moment = {
        id: 'bed', title: 'Bed', location: 'her bedroom',
        activity: 'lying on her back in bed', stance: 'lying', camera: 'front'
    };
    const first = characterLife.planPhoto({
        characterId: 'erika', intent: 'selfie', moment, characters: [{ name: 'Erika' }], message: '', seed: 1000
    });
    const second = characterLife.planPhoto({
        characterId: 'erika', intent: 'selfie', moment, characters: [{ name: 'Erika' }], message: '', seed: 1777
    });
    assert.equal(first.spec.outfitSource, 'auto');
    assert.ok(!/beige overshirt/.test(first.spec.outfit), 'the previous photo outfit is not reused');
    assert.notEqual(first.spec.outfit, second.spec.outfit, 'a new seed composes a new outfit');
});

test('a model moment must be safe, complete and start with an action', () => {
    const good = moments.parseMoment(JSON.stringify({
        title: 'Kitchen counter',
        location: 'the kitchen',
        activity: 'sitting on the kitchen counter with a mug',
        stance: 'sitting',
        camera: 'mirror',
        framing: 'knees-up, the window behind her',
        angle: 'phone propped on the island',
        hands: 'one hand around the mug, the other resting on the counter',
        composition: 'morning light across the counter',
        lighting: 'clean morning daylight',
        mood: 'content',
        caption: 'Coffee first \u2014 obviously'
    }));
    assert.equal(good.location, 'the kitchen');
    assert.equal(good.stance, 'sitting');
    assert.equal(good.camera, 'mirror');
    assert.match(good.hands, /one hand around the mug/);
    assert.equal(good.caption.indexOf('\u2014'), -1);
    assert.equal(good.caption.indexOf('\u2013'), -1);
    assert.ok(good.caption.endsWith('.'));

    assert.equal(moments.parseMoment('{"location":"the bedroom","activity":"lying naked on the bed"}'), null);
    assert.equal(moments.parseMoment('{"location":"the bathroom","activity":"sitting on the toilet"}'), null);
    assert.equal(moments.parseMoment('{"location":"the kitchen","activity":"sitting on the counter","framing":"a bowl of fruit on the counter beside her"}'), null);
    assert.equal(moments.parseMoment('{"location":"the kitchen","activity":"holding a plate of food"}'), null);
    assert.equal(moments.parseMoment('{"location":"the bedroom","activity":"a sunny room"}'), null);
    assert.equal(moments.parseMoment('not json at all'), null);
    assert.equal(moments.parseMoment('{"location":"","activity":""}'), null);
});

test('the moment planner uses the local model and falls back to the catalog', async () => {
    reset();
    seedLife('maya');
    const llm = await characterLife.planInboxMoment('maya', {
        character: { name: 'Maya' },
        providers: {
            chat: async () => JSON.stringify({
                title: 'Kitchen counter',
                location: 'the kitchen',
                activity: 'sitting up on the kitchen counter with a mug',
                stance: 'sitting',
                camera: 'front',
                framing: 'knees-up, the cabinets behind her',
                angle: 'phone propped on the island',
                composition: 'bare feet dangling',
                lighting: 'morning light',
                mood: 'content',
                caption: 'Coffee first.'
            })
        },
        model: 'stub'
    });
    assert.equal(llm.source, 'llm');
    assert.equal(llm.title, 'Kitchen counter');
    assert.equal(llm.camera, 'front');

    const fallback = await characterLife.planInboxMoment('maya', {
        character: { name: 'Maya' },
        providers: { chat: async () => { throw new Error('offline'); } }
    });
    assert.equal(fallback.source, 'catalog');
    assert.ok(fallback.activity.length > 0);
    assert.ok(fallback.framing.length > 0);
});

test('the facade answers the delivery policy from the stored life record', () => {
    reset();
    seedLife('maya');
    const due = characterLife.inboxDue('maya', behavior(), { now: NOW, hour: 15 });
    assert.equal(due.due, true);
    const blocked = characterLife.inboxDue('maya', behavior({ photoSharing: 'off' }), { now: NOW, hour: 15 });
    assert.equal(blocked.due, false);
});

test('clearing the tray keeps the fictional life intact', () => {
    reset();
    seedLife('maya');
    inbox.capture('maya', { result: { url: '/generated/x.png', filename: 'x.png' }, spec: {}, caption: 'Hi.' });
    const cleared = characterLife.clearInbox('maya');
    assert.equal(cleared.length, 1);
    assert.equal(characterLife.listInbox('maya').length, 0);
    assert.equal(characterLife.getLife('maya').activity, 'Grabbing a coffee');
});
