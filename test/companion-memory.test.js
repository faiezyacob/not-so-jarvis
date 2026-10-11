/* SPDX-License-Identifier: MIT */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-companion-'));
process.env.COMPANION_PATH = path.join(tempDir, 'companion.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tempDir, 'character-presets.json');
process.env.CONVERSATIONS_PATH = path.join(tempDir, 'conversations.json');

const companion = require('../services/companion');
const store = require('../services/companion/store');
const extraction = require('../services/companion/extraction');
const retrieval = require('../services/companion/retrieval');
const prompt = require('../services/companion/prompt');
const characterPresets = require('../services/character-presets');
const conversationService = require('../server/conversation-service');

test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('memory records are isolated per character', () => {
    companion.addMemory('char_a', { type: 'semantic', text: 'The user is a marine biologist.', importance: 4 });
    companion.addMemory('char_b', { type: 'semantic', text: 'The user plays in a band on weekends.', importance: 3 });

    const a = companion.listMemories('char_a');
    const b = companion.listMemories('char_b');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.match(a[0].text, /marine biologist/);
    assert.match(b[0].text, /band/);
    assert.ok(a.every((m) => m.characterId === 'char_a'));
    assert.ok(b.every((m) => m.characterId === 'char_b'));
});

test('clearing one character never touches another', () => {
    companion.addMemory('char_clear_1', { type: 'episodic', text: 'They watched a meteor shower together.' });
    companion.addMemory('char_clear_2', { type: 'episodic', text: 'They cooked dinner together.' });
    companion.clearMemories('char_clear_1');
    assert.equal(companion.listMemories('char_clear_1').length, 0);
    assert.equal(companion.listMemories('char_clear_2').length, 1);
});

test('near-identical facts dedupe instead of piling up', () => {
    const first = extraction.applyExtraction('char_dedupe', {
        memories: [{ type: 'semantic', text: 'The user has a dog named Biscuit.', importance: 3, confidence: 'stated', category: 'pets' }]
    }, { conversationId: 'c1' });
    assert.equal(first.added, 1);

    const repeated = extraction.applyExtraction('char_dedupe', {
        memories: [{ type: 'semantic', text: 'The user has a dog named Biscuit.', importance: 5, confidence: 'stated', category: 'pets' }]
    }, { conversationId: 'c2' });
    assert.equal(repeated.added, 0);
    assert.equal(repeated.updated, 1);
    assert.equal(companion.listMemories('char_dedupe').length, 1);
    // Importance is raised on restatement.
    assert.equal(companion.listMemories('char_dedupe')[0].importance, 5);
});

test('a correction supersedes the old memory and preserves provenance', () => {
    extraction.applyExtraction('char_correct', {
        memories: [{ type: 'semantic', text: 'The user lives in Berlin.', importance: 4, confidence: 'stated', category: 'location' }]
    }, { conversationId: 'c1' });

    const report = extraction.applyExtraction('char_correct', {
        memories: [{ type: 'correction', text: 'The user lives in Munich.', importance: 4, confidence: 'stated', category: 'location' }]
    }, { conversationId: 'c2' });
    assert.equal(report.superseded, 1);
    assert.equal(report.added, 1);

    const all = companion.listMemories('char_correct', { status: 'all' });
    const active = all.filter((m) => m.status === 'active');
    const superseded = all.filter((m) => m.status === 'superseded');
    assert.equal(active.length, 1);
    assert.match(active[0].text, /Munich/);
    assert.equal(superseded.length, 1);
    assert.match(superseded[0].text, /Berlin/);
    assert.equal(superseded[0].supersededBy, active[0].id);
    assert.deepEqual(active[0].supersedes, [superseded[0].id]);
});

test('retrieval ranks relevant memories above unrelated ones', () => {
    const characterId = 'char_retrieval';
    companion.addMemory(characterId, { type: 'semantic', text: 'The user is learning to play the cello.', importance: 4, category: 'hobby' });
    companion.addMemory(characterId, { type: 'semantic', text: 'The user works as a pastry chef.', importance: 4, category: 'work' });
    companion.addMemory(characterId, { type: 'episodic', text: 'They talked about the cello recital for a long time.', importance: 3 });

    const ranked = companion.rankMemories(companion.listMemories(characterId), 'How is the cello practice going?');
    assert.ok(ranked.length >= 1);
    assert.match(ranked[0].memory.text, /cello/i);

    const selection = companion.selectMemoryContext(companion.listMemories(characterId), 'How is the cello practice going?');
    assert.match(selection.text, /cello/i);
    assert.ok(selection.selected.some((m) => /cello/i.test(m.text)));
});

test('retrieval returns nothing for an unrelated turn with no pinned memories', () => {
    const characterId = 'char_none';
    companion.addMemory(characterId, { type: 'semantic', text: 'The user once visited Iceland.', importance: 2 });
    const selection = companion.selectMemoryContext(companion.listMemories(characterId), 'What is the weather?');
    assert.equal(selection.selected.length, 0);
    assert.equal(selection.text, '');
});

test('pinned memories are always retrievable, even on unrelated turns', () => {
    const characterId = 'char_pinned';
    companion.addMemory(characterId, { type: 'semantic', text: 'The user is allergic to peanuts.', importance: 5, pinned: true });
    const selection = companion.selectMemoryContext(companion.listMemories(characterId), 'Tell me a joke.');
    assert.equal(selection.selected.length, 1);
    assert.match(selection.text, /peanuts/);
});

test('retrieval respects the context budget', () => {
    const characterId = 'char_budget';
    for (let i = 0; i < 12; i++) {
        companion.addMemory(characterId, { type: 'semantic', text: 'Fact number ' + i + ' about the user and their many interests and projects.', importance: 4 });
    }
    const selection = companion.selectMemoryContext(companion.listMemories(characterId), 'Tell me about the user', { maxCount: 3, maxChars: 5000 });
    assert.ok(selection.selected.length <= 3);
});

test('parseExtraction reads fenced JSON and clamps values', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify({
        memories: [
            { type: 'SEMANTIC', text: 'The user prefers tea over coffee.', importance: 99, confidence: 'stated', category: 'food' },
            { type: 'episodic', text: 'They met at a coffee shop.', importance: 2, confidence: 'weird' }
        ],
        state: { goals: ['finish a novel'], activities: [], events: [{ text: 'started guitar lessons' }], notes: 'travelling soon' }
    }) + '\n```';
    const parsed = extraction.parseExtraction(raw);
    assert.equal(parsed.memories.length, 2);
    assert.equal(parsed.memories[0].importance, 5);
    assert.equal(parsed.memories[0].confidence, 'stated');
    assert.equal(parsed.memories[1].confidence, 'stated');
    assert.equal(parsed.state.goals.length, 1);
    assert.equal(parsed.state.events.length, 1);
});

test('parseExtraction tolerates malformed output', () => {
    assert.deepEqual(extraction.parseExtraction('not json at all'), { memories: [], state: null });
    assert.deepEqual(extraction.parseExtraction(''), { memories: [], state: null });
    const partial = extraction.parseExtraction('{"memories":[{"type":"semantic","text":"ok fact"}]}');
    assert.equal(partial.memories.length, 1);
});

test('shouldExtract skips trivial turns', () => {
    assert.equal(extraction.shouldExtract('User: hi\nAssistant: hello there!'), false);
    assert.equal(extraction.shouldExtract('User: ' + 'I have been learning to play the cello and practising every evening. '.repeat(2)), true);
});

test('extractMemories is fail-open when the provider errors', async () => {
    const characterId = 'char_failopen';
    const result = await extraction.extractMemories({
        characterId,
        provider: 'ollama',
        model: 'test',
        excerpt: 'User: ' + 'I am planning a trip to Japan next spring and I am very excited about it. '.repeat(2),
        providers: { chat: async () => { throw new Error('ollama offline'); } }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.equal(companion.listMemories(characterId).length, 0);
});

test('extractMemories persists a valid extraction', async () => {
    const characterId = 'char_extract_ok';
    const result = await extraction.extractMemories({
        characterId,
        provider: 'ollama',
        model: 'test',
        conversationId: 'conv-1',
        excerpt: 'User: ' + 'My favourite film is Blade Runner 2049 and I watch it every year. '.repeat(2),
        providers: {
            chat: async () => JSON.stringify({
                memories: [{ type: 'semantic', text: 'The user\'s favourite film is Blade Runner 2049.', importance: 4, confidence: 'stated', category: 'media' }],
                state: null
            })
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.report.added, 1);
    const memories = companion.listMemories(characterId);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].sourceConversationId, 'conv-1');
});

test('casualizeReply removes em/en dashes and tidies punctuation', () => {
    const out = prompt.casualizeReply('Yeah that sounds fun \u2014 want to do it tonight?');
    assert.ok(!/[\u2014\u2013]/.test(out));
    assert.match(out, /fun, want to do it tonight\?/);

    const sentenceFinal = prompt.casualizeReply('It was a long day \u2014.');
    assert.equal(sentenceFinal, 'It was a long day.');

    const range = prompt.casualizeReply('Somewhere between 10\u201315 minutes.');
    assert.ok(!/[\u2014\u2013]/.test(range));

    assert.equal(prompt.casualizeReply('no dashes here'), 'no dashes here');
    assert.equal(prompt.casualizeReply(''), '');
});

test('persona rules forbid em dashes and encourage casual style', () => {
    assert.match(prompt.DEFAULT_PERSONA_RULES, /em dashes or en dashes/i);
    assert.match(prompt.DEFAULT_PERSONA_RULES, /texting a close friend/i);
});

test('companion context includes persona but marks memory as untrusted data', () => {
    const character = { id: 'char_prompt', name: 'Maya', identityText: 'A woman with short dark hair.' };
    const text = prompt.buildCompanionContext({
        character,
        settings: { personality: 'Warm and curious.' },
        state: { goals: ['finish a short story'] },
        memoryText: '- [semantic] The user is a marine biologist.'
    });
    assert.match(text, /You are Maya/);
    assert.match(text, /Warm and curious/);
    assert.match(text, /untrusted data/i);
    assert.match(text, /marine biologist/);
    assert.match(text, /finish a short story/);
});

test('companion context omits memory when disabled', () => {
    const text = prompt.buildCompanionContext({
        character: { id: 'c', name: 'Maya' },
        settings: { memoryEnabled: false },
        memoryText: '- [semantic] The user is a marine biologist.'
    });
    assert.ok(!/marine biologist/.test(text));
});

test('companion context is empty when disabled or characterless', () => {
    assert.equal(prompt.buildCompanionContext({ character: null }), '');
    assert.equal(prompt.buildCompanionContext({ character: { id: 'c', name: 'M' }, settings: { enabled: false } }), '');
});

test('global companion settings sanitize and per-character overrides merge', () => {
    const sanitized = companion.sanitizeGlobalSettings({ maxContextMemories: 999, retentionDays: -5, memoryEnabled: false });
    assert.equal(sanitized.maxContextMemories, 30);
    assert.equal(sanitized.retentionDays, 0);
    assert.equal(sanitized.memoryEnabled, false);

    const effective = companion.effectiveSettings({ memoryEnabled: true, autoMemory: false }, sanitized);
    assert.equal(effective.memoryEnabled, true);
    assert.equal(effective.autoMemory, false);
    assert.equal(effective.lifeProgression, false);
});

test('companion settings round-trip on a character preset', () => {
    const character = characterPresets.create({ name: 'Nova', identityText: 'A woman with silver hair.' });
    const updated = characterPresets.setCompanion(character.id, {
        personality: 'Calm and precise.',
        interests: ['astronomy', 'chess'],
        memoryEnabled: false
    });
    assert.equal(updated.personality, 'Calm and precise.');
    assert.deepEqual(updated.interests, ['astronomy', 'chess']);
    assert.equal(updated.memoryEnabled, false);

    const reread = characterPresets.getCompanion(character.id);
    assert.equal(reread.personality, 'Calm and precise.');
    assert.equal(reread.enabled, true);
});

test('conversations link to a character for companion chat', () => {
    const conversation = conversationService.createConversation({ title: 'Companion', characterId: 'char_link' }, 'session-a');
    assert.equal(conversation.characterId, 'char_link');
    const found = conversationService.getConversationsForCharacter('char_link', 'session-a');
    assert.equal(found.length, 1);
    assert.equal(found[0].id, conversation.id);
    // A different session does not see the other session's companion history.
    assert.equal(conversationService.getConversationsForCharacter('char_link', 'session-b').length, 0);
});

test('buildContextForTurn wires persona, retrieval and memory ids', () => {
    const characterId = 'char_turn';
    const memory = companion.addMemory(characterId, { type: 'semantic', text: 'The user loves hiking in the Alps.', importance: 4 });
    const result = companion.buildContextForTurn({
        characterId,
        character: { id: characterId, name: 'Nova', identityText: 'A woman with silver hair.' },
        settings: { personality: 'Calm and precise.' },
        globalSettings: companion.DEFAULT_GLOBAL_SETTINGS,
        query: 'Should I plan an Alps hiking trip?'
    });
    assert.match(result.text, /You are Nova/);
    assert.match(result.text, /Calm and precise/);
    assert.match(result.text, /Alps/);
    assert.ok(result.memoryIds.includes(memory.id));
});

test('scheduleTurnExtraction is disabled by settings', () => {
    const scheduled = companion.scheduleTurnExtraction({
        characterId: 'char_sched',
        characterName: 'Nova',
        excerpt: 'User: ' + 'I am learning to sail this summer and I am excited about it. '.repeat(2),
        settings: { memoryEnabled: false },
        globalSettings: companion.DEFAULT_GLOBAL_SETTINGS,
        providers: { chat: async () => '{}' }
    });
    assert.equal(scheduled, false);
});

test('markAccessed bumps access metadata without changing content', () => {
    const characterId = 'char_access';
    const memory = companion.addMemory(characterId, { type: 'semantic', text: 'The user grew up in Lisbon.', importance: 3 });
    companion.markMemoriesUsed(characterId, [memory.id]);
    const reread = companion.getMemory(characterId, memory.id);
    assert.equal(reread.accessCount, 1);
    assert.ok(reread.lastAccessedAt);
    assert.match(reread.text, /Lisbon/);
});
