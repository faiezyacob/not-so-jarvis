/* ============================================
   JARVIS — Message deletion
   Tests the per-message store operations behind
   "delete a response" (single message lookup and
   removal scoped to its conversation).
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-message-delete-'));
process.env.CONVERSATIONS_PATH = path.join(tmp, 'conversations.json');
process.env.GENERATED_HISTORY_PATH = path.join(tmp, 'generated-history.json');
process.env.GENERATED_DIR = path.join(tmp, 'generated');
process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-log.json');
process.env.TASK_STATE_PATH = path.join(tmp, 'task-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmp, 'character-presets.json');
fs.mkdirSync(process.env.GENERATED_DIR, { recursive: true });
fs.writeFileSync(process.env.GENERATED_HISTORY_PATH, JSON.stringify({ entries: [] }));

const conversationService = require('../server/conversation-service');
const generatedHistory = require('../services/generated-history');
const taskState = require('../services/task-state');
const messageMedia = require('../services/message-media');
const thumbnail = require('../services/thumbnail');

// The gallery schedules thumbnails in the background; irrelevant here.
thumbnail.schedule = () => {};
thumbnail.remove = () => {};

function makeFile(name) {
    fs.writeFileSync(path.join(process.env.GENERATED_DIR, name), 'x');
}

test('getMessage is scoped to its conversation', () => {
    const conv = conversationService.createConversation({ title: 'Messages' });
    const other = conversationService.createConversation({ title: 'Other' });
    const message = conversationService.addMessage(conv.id, 'assistant', 'hello');

    assert.equal(conversationService.getMessage(conv.id, message.id).id, message.id);
    assert.equal(conversationService.getMessage(other.id, message.id), null);
    assert.equal(conversationService.getMessage(conv.id, 'missing'), null);
});

test('deleteMessage removes only the requested response', () => {
    const conv = conversationService.createConversation({ title: 'Delete' });
    const first = conversationService.addMessage(conv.id, 'assistant', 'first');
    const second = conversationService.addMessage(conv.id, 'assistant', 'second');

    const removed = conversationService.deleteMessage(conv.id, first.id);
    assert.equal(removed.id, first.id);
    const remaining = conversationService.getMessages(conv.id);
    assert.deepEqual(remaining.map((m) => m.id), [second.id]);
    // The conversation itself survives.
    assert.ok(conversationService.getConversation(conv.id));
});

test('updateMessageContent rewrites one message without touching others', () => {
    const conv = conversationService.createConversation({ title: 'Rewrite' });
    const first = conversationService.addMessage(conv.id, 'user', 'edit ![reference](/generated/a.png) please');
    const second = conversationService.addMessage(conv.id, 'assistant', 'done');

    conversationService.updateMessageContent(conv.id, first.id, 'edit please');
    assert.equal(conversationService.getMessage(conv.id, first.id).content, 'edit please');
    assert.equal(conversationService.getMessage(conv.id, second.id).content, 'done');
    assert.equal(conversationService.updateMessageContent(conv.id, 'missing', 'x'), null);
});

test('deleteMessage never crosses conversations and is idempotent', () => {
    const conv = conversationService.createConversation({ title: 'A' });
    const other = conversationService.createConversation({ title: 'B' });
    const message = conversationService.addMessage(conv.id, 'assistant', 'keep');

    assert.equal(conversationService.deleteMessage(other.id, message.id), null);
    assert.equal(conversationService.getMessages(conv.id).length, 1);
    assert.ok(conversationService.deleteMessage(conv.id, message.id));
    assert.equal(conversationService.deleteMessage(conv.id, message.id), null);
});

test('collectGeneratedFilenames reads markdown image links and video tags', () => {
    const names = messageMedia.collectGeneratedFilenames([
        'Here is a scene: ![scene](/generated/scene.png)',
        '<video class="md-video" preload="metadata" src="/generated/clip.mp4"></video>',
        '![encoded](/generated/a%20b.webp)'
    ]);
    assert.equal(names.has('scene.png'), true);
    assert.equal(names.has('clip.mp4'), true);
    assert.equal(names.has('a b.webp'), true);
});

test('removeMessageMedia deletes an embedded image and video together', () => {
    const conv = conversationService.createConversation({ title: 'Media' });
    makeFile('scene.png');
    makeFile('clip.mp4');
    generatedHistory.add({
        file: '/generated/scene.png',
        rawFilename: 'scene.png',
        prompt: 'scene',
        conversationId: conv.id
    });
    generatedHistory.add({
        file: '/generated/clip.mp4',
        rawFilename: 'clip.mp4',
        prompt: 'clip',
        conversationId: conv.id,
        video: { duration: 5 }
    });
    taskState.setTask(conv.id, {
        type: 'video',
        generatedAsset: '/generated/clip.mp4',
        sourceImage: 'scene.png'
    });

    const message = conversationService.addMessage(
        conv.id,
        'assistant',
        'Here:\n\n![scene](/generated/scene.png)\n\n'
            + '<video class="md-video" preload="metadata" playsinline src="/generated/clip.mp4"></video>'
    );
    const removed = messageMedia.removeMessageMedia(conv.id, message).sort();
    assert.deepEqual(removed, ['clip.mp4', 'scene.png']);

    assert.equal(fs.existsSync(path.join(process.env.GENERATED_DIR, 'scene.png')), false);
    assert.equal(fs.existsSync(path.join(process.env.GENERATED_DIR, 'clip.mp4')), false);
    const remaining = generatedHistory.list().map((entry) => entry.rawFilename);
    assert.equal(remaining.includes('scene.png'), false);
    assert.equal(remaining.includes('clip.mp4'), false);

    const task = taskState.getTask(conv.id);
    assert.equal(task.generatedAsset, null);
    assert.equal(task.sourceImage, null);
});

test('stripRemovedMediaReferences removes image and video references', () => {
    const conv = conversationService.createConversation({ title: 'References' });
    const referenced = conversationService.addMessage(
        conv.id,
        'user',
        'Change ![reference 1](/generated/old.png)\n\n'
            + '<video src="/generated/old.mp4"></video>\n\nnow please'
    );
    const kept = conversationService.addMessage(
        conv.id,
        'assistant',
        'Keep ![other](/generated/keep.png)'
    );

    const rewritten = messageMedia.stripRemovedMediaReferences(conv.id, new Set(['old.png', 'old.mp4']));
    assert.equal(rewritten, 1);
    const content = conversationService.getMessage(conv.id, referenced.id).content;
    assert.equal(content.includes('old.png'), false);
    assert.equal(content.includes('old.mp4'), false);
    assert.equal(content.includes('Change'), true);
    assert.equal(content.includes('now please'), true);
    assert.equal(
        conversationService.getMessage(conv.id, kept.id).content,
        'Keep ![other](/generated/keep.png)'
    );
});
