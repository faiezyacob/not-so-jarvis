/* ============================================
   JARVIS — Environment context tests
   Covers the stats/weather gates and formatting
   used to feed live telemetry into chat. The
   network and storage seams are stubbed.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const contextBuilder = require('../server/context-builder');
const conversationService = require('../server/conversation-service');
const configManager = require('../server/config-manager');
const weather = require('../services/weather');

const STATS = {
    cpu: { usage: 23, cores: 16, clock: '4.20 GHz', name: 'Test CPU', temperature: null },
    ram: { usage: 39, used: 12.4, total: 32, free: 19.6 },
    gpu: { usage: 45, temperature: 61, name: 'Test GPU' },
    vram: { available: true, usage: 76, used: 18.2, total: 24, free: 5.8 }
};

// --- system stats gate -------------------------------------------------------

test('isSystemStatsQuery: matches machine/hardware questions', () => {
    for (const q of [
        'what is my cpu usage?',
        'how much vram is free',
        'show me the gpu temperature',
        'system status report',
        "how's my pc doing",
        'give me the system stats'
    ]) {
        assert.equal(contextBuilder.isSystemStatsQuery(q), true, q);
    }
});

test('isSystemStatsQuery: ignores unrelated chat', () => {
    for (const q of [
        'draw me a cat',
        'what is the capital of France?',
        'make her hair blue',
        'read me a poem'
    ]) {
        assert.equal(contextBuilder.isSystemStatsQuery(q), false, q);
    }
});

test('buildSystemStatsContext: gated by the query, then formats values', () => {
    assert.equal(contextBuilder.buildSystemStatsContext('tell me a joke', STATS), '');
    const out = contextBuilder.buildSystemStatsContext('what is my cpu and gpu doing?', STATS);
    assert.equal(out.includes('Test CPU'), true);
    assert.equal(out.includes('23% usage'), true);
    assert.equal(out.includes('Test GPU'), true);
    assert.equal(out.includes('45% utilization'), true);
    assert.equal(out.includes('RAM: 12.4 / 32 GB (39%)'), true);
    assert.equal(out.includes('VRAM: 18.2 / 24 GB (76%)'), true);
});

test('formatSystemStats: notes when no GPU is present', () => {
    const stats = Object.assign({}, STATS, { vram: { available: false, usage: 0, used: 0, total: 0, free: 0 } });
    const out = contextBuilder.formatSystemStats(stats);
    assert.equal(out.includes('not available'), true);
    assert.equal(out.includes('Test GPU'), false);
});

// --- weather gate + formatting ----------------------------------------------

test('isWeatherQuery: matches weather phrasings', () => {
    for (const q of [
        'what is the weather?',
        'will it rain today',
        "what's the temperature outside",
        'do I need an umbrella',
        'how windy is it'
    ]) {
        assert.equal(weather.isWeatherQuery(q), true, q);
    }
});

test('isWeatherQuery: ignores unrelated chat', () => {
    for (const q of [
        'draw me a cat',
        'explain closures',
        'add a windmill to the image'
    ]) {
        assert.equal(weather.isWeatherQuery(q), false, q);
    }
});

test('formatWeather: renders the snapshot fields', () => {
    const out = weather.formatWeather({
        label: 'Testville',
        description: 'Light rain',
        temperature: 12.3,
        apparent: 10.1,
        humidity: 80,
        wind: 14.5,
        observedAt: '2026-01-01T00:00'
    });
    assert.equal(out.includes('Testville'), true);
    assert.equal(out.includes('Light rain'), true);
    assert.equal(out.includes('12.3\u00B0C'), true);
    assert.equal(out.includes('feels like 10.1\u00B0C'), true);
    assert.equal(out.includes('Humidity: 80%'), true);
});

test('buildWeatherContext: no location yields guidance, not a forecast', async () => {
    const original = configManager.getWeather;
    configManager.getWeather = () => ({});
    try {
        const out = await weather.buildWeatherContext("what's the weather?");
        assert.equal(out.includes('location is not known'), true);
        assert.equal(out.includes('Do not invent'), true);
    } finally {
        configManager.getWeather = original;
    }
});

test('buildWeatherContext: non-weather turns are a no-op', async () => {
    assert.equal(await weather.buildWeatherContext('draw me a cat'), '');
});

// --- buildContext injection --------------------------------------------------

test('buildContext: appends the environment context as a system message', () => {
    const originals = {
        getMessages: conversationService.getMessages,
        getConversation: conversationService.getConversation,
        getChatSettings: configManager.getChatSettings
    };
    conversationService.getMessages = () => [];
    conversationService.getConversation = () => null;
    configManager.getChatSettings = () => ({ systemPrompt: '' });
    try {
        const messages = contextBuilder.buildContext('conv', 'hi', 'ollama', 'm', '', [], 'ENV-BLOCK');
        const env = messages.find((m) => m.content === 'ENV-BLOCK');
        assert.ok(env);
        assert.equal(env.role, 'system');
    } finally {
        conversationService.getMessages = originals.getMessages;
        conversationService.getConversation = originals.getConversation;
        configManager.getChatSettings = originals.getChatSettings;
    }
});
