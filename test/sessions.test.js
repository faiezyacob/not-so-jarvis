/* ============================================
   JARVIS — Device sessions
   Tests that conversations, generated media and
   activity events are private to the owning device
   session, and that pre-session (legacy) records
   are adopted by the first session.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point every persistent store at a scratch directory BEFORE requiring them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sessions-'));
process.env.CONVERSATIONS_PATH = path.join(tmp, 'conversations.json');
process.env.GENERATED_HISTORY_PATH = path.join(tmp, 'generated-history.json');
process.env.GENERATED_DIR = path.join(tmp, 'generated');
process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-log.json');
fs.mkdirSync(process.env.GENERATED_DIR, { recursive: true });
// Seed an empty metadata file so the store does not fall back to scanning the
// scratch media directory.
fs.writeFileSync(process.env.GENERATED_HISTORY_PATH, JSON.stringify({ entries: [] }));

const conversationService = require('../server/conversation-service');
const generatedHistory = require('../services/generated-history');
const activityLog = require('../services/activity-log');
const thumbnail = require('../services/thumbnail');

// The gallery schedules thumbnails in the background; that is irrelevant here.
thumbnail.schedule = () => {};
thumbnail.remove = () => {};

function makeFile(name) {
    fs.writeFileSync(path.join(process.env.GENERATED_DIR, name), 'x');
}

let sessionA;
let sessionB;

test('conversations are private to the creating session', () => {
    sessionA = conversationService.createConversation({ title: 'A' }, 'sess-a');
    sessionB = conversationService.createConversation({ title: 'B' }, 'sess-b');
    assert.equal(sessionA.sessionId, 'sess-a');

    const aIds = conversationService.getAllConversations('sess-a').map((c) => c.id);
    const bIds = conversationService.getAllConversations('sess-b').map((c) => c.id);
    assert.deepEqual(aIds, [sessionA.id]);
    assert.deepEqual(bIds, [sessionB.id]);
    assert.equal(conversationService.canAccessConversation(sessionA.id, 'sess-a'), true);
    assert.equal(conversationService.canAccessConversation(sessionA.id, 'sess-b'), false);
});

test('legacy conversations are adopted by the first session only', () => {
    const legacy = conversationService.createConversation({ title: 'Legacy' });
    assert.equal(legacy.sessionId, null);
    assert.equal(conversationService.canAccessConversation(legacy.id, 'sess-a'), true);

    const adopted = conversationService.adoptLegacyConversations('sess-a');
    assert.equal(adopted, 1);
    assert.equal(conversationService.canAccessConversation(legacy.id, 'sess-a'), true);
    assert.equal(conversationService.canAccessConversation(legacy.id, 'sess-b'), false);
    // Once claimed, a second session adopts nothing.
    assert.equal(conversationService.adoptLegacyConversations('sess-b'), 0);
    assert.equal(conversationService.getAllConversations('sess-a').some((c) => c.id === legacy.id), true);
    assert.equal(conversationService.getAllConversations('sess-b').some((c) => c.id === legacy.id), false);
});

test('generated media is scoped to the owning session', () => {
    makeFile('a1.png');
    makeFile('b1.png');
    generatedHistory.add({ file: '/generated/a1.png', rawFilename: 'a1.png', prompt: 'a', conversationId: sessionA.id });
    generatedHistory.add({ file: '/generated/b1.png', rawFilename: 'b1.png', prompt: 'b', conversationId: sessionB.id });

    const aImages = generatedHistory.listPublic('sess-a');
    assert.equal(aImages.some((x) => x.prompt === 'a'), true);
    assert.equal(aImages.some((x) => x.prompt === 'b'), false);
    const bImages = generatedHistory.listPublic('sess-b');
    assert.equal(bImages.some((x) => x.prompt === 'b'), true);
    assert.equal(bImages.some((x) => x.prompt === 'a'), false);
});

test('legacy generated media is adopted with the conversations', () => {
    makeFile('legacy.png');
    generatedHistory.add({ file: '/generated/legacy.png', rawFilename: 'legacy.png', prompt: 'legacy' });
    assert.equal(generatedHistory.listPublic('sess-a').some((x) => x.prompt === 'legacy'), false);
    assert.equal(generatedHistory.listPublic('sess-b').some((x) => x.prompt === 'legacy'), false);

    assert.equal(generatedHistory.adoptLegacy('sess-a'), 1);
    assert.equal(generatedHistory.listPublic('sess-a').some((x) => x.prompt === 'legacy'), true);
    assert.equal(generatedHistory.listPublic('sess-b').some((x) => x.prompt === 'legacy'), false);
});

test('a session cannot delete another session\'s media', () => {
    const target = generatedHistory.listPublic('sess-a').find((x) => x.prompt === 'a');
    assert.ok(target);
    assert.equal(generatedHistory.remove(target.id, 'sess-b'), null);
    assert.ok(generatedHistory.listPublic('sess-a').some((x) => x.id === target.id));
    assert.ok(generatedHistory.remove(target.id, 'sess-a'));
    assert.equal(generatedHistory.listPublic('sess-a').some((x) => x.id === target.id), false);
});

test('activity entries carry their conversation id', () => {
    activityLog.record({ type: 'image', title: 'Image generated', conversationId: sessionA.id, file: '/generated/a1.png' });
    activityLog.record({ type: 'system', title: 'Server started' });
    const entries = activityLog.list(10);
    // Newest first: the system event is last recorded, so it leads.
    assert.equal(entries[0].title, 'Server started');
    assert.equal(entries[0].conversationId, null);
    assert.equal(entries[1].conversationId, sessionA.id);
});
