/* SPDX-License-Identifier: MIT */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
process.env.CONVERSATIONS_PATH = path.join(tempDir, 'conversations.json');

const conversationService = require('../server/conversation-service');

test('summary windows roll forward without dropping messages between summaries', () => {
    const conversation = conversationService.createConversation({ title: 'Memory test' }, 'session-test');
    for (let i = 0; i < 40; i++) {
        conversationService.addMessage(conversation.id, i % 2 ? 'assistant' : 'user', 'message-' + i);
    }

    const firstWindow = conversationService.getSummaryWindow(conversation.id, 20);
    assert.equal(firstWindow.messages.length, 20);
    assert.equal(firstWindow.messages[0].content, 'message-0');
    assert.equal(firstWindow.throughMessageCount, 20);
    conversationService.setSummary(conversation.id, 'User prefers concise replies.', firstWindow.throughMessageCount);

    for (let i = 40; i < 60; i++) {
        conversationService.addMessage(conversation.id, i % 2 ? 'assistant' : 'user', 'message-' + i);
    }

    const nextWindow = conversationService.getSummaryWindow(conversation.id, 20);
    assert.equal(nextWindow.summary, 'User prefers concise replies.');
    assert.equal(nextWindow.messages.length, 20);
    assert.equal(nextWindow.messages[0].content, 'message-20');
    assert.equal(nextWindow.messages[19].content, 'message-39');
    assert.equal(nextWindow.throughMessageCount, 40);
});

test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});
