/* ============================================
   JARVIS — Config Manager
   Stores active AI provider/model in a local JSON file.
   ============================================ */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const DEFAULT_CONFIG = {
    provider: 'ollama',
    model: 'llama3.2',
    reasoningEnabled: true,
    chatSystemPrompt: '',
    chatPersona: 'default',
    chatTemperature: null,
    chatTopP: null
};

const CHAT_PERSONAS = ['default', 'concise', 'developer', 'creative', 'tutor', 'custom'];

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function saveConfig(config) {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getConfig() {
    return loadConfig();
}

function setModelConfig(provider, model) {
    const config = loadConfig();
    if (provider) config.provider = provider;
    if (model) config.model = model;
    saveConfig(config);
    return config;
}

function getReasoningEnabled() {
    const config = loadConfig();
    // On by default: only an explicit false disables reasoning.
    return config.reasoningEnabled !== false;
}

function setReasoningEnabled(enabled) {
    const config = loadConfig();
    config.reasoningEnabled = enabled !== false;
    saveConfig(config);
    return config.reasoningEnabled;
}

// --- Chat controls: persona / system prompt / sampling ---

function sanitizeTemperature(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('temperature must be a number 0-2 (or blank for model default).');
    if (n < 0 || n > 2) throw new Error('temperature must be between 0 and 2.');
    return Math.round(n * 100) / 100;
}

function sanitizeTopP(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('top_p must be a number 0-1 (or blank for model default).');
    if (n <= 0 || n > 1) throw new Error('top_p must be between 0 and 1.');
    return Math.round(n * 100) / 100;
}

function sanitizeSystemPrompt(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.length > 4000) throw new Error('system prompt is too long (max 4000 characters).');
    return s;
}

function getChatSettings() {
    const config = loadConfig();
    return {
        reasoningEnabled: config.reasoningEnabled !== false,
        systemPrompt: typeof config.chatSystemPrompt === 'string' ? config.chatSystemPrompt : '',
        persona: CHAT_PERSONAS.indexOf(config.chatPersona) !== -1 ? config.chatPersona : 'default',
        temperature: config.chatTemperature === null || config.chatTemperature === undefined
            ? null : Number(config.chatTemperature),
        topP: config.chatTopP === null || config.chatTopP === undefined
            ? null : Number(config.chatTopP)
    };
}

function setChatSettings(patch) {
    const config = loadConfig();
    const input = patch || {};
    if (input.reasoningEnabled !== undefined) {
        config.reasoningEnabled = input.reasoningEnabled !== false;
    }
    if (input.systemPrompt !== undefined) {
        config.chatSystemPrompt = sanitizeSystemPrompt(input.systemPrompt).trim() ? sanitizeSystemPrompt(input.systemPrompt) : '';
    }
    if (input.persona !== undefined) {
        const p = String(input.persona || 'default').toLowerCase();
        config.chatPersona = CHAT_PERSONAS.indexOf(p) !== -1 ? p : 'custom';
    }
    if (input.temperature !== undefined) {
        const t = sanitizeTemperature(input.temperature);
        if (t === null) delete config.chatTemperature;
        else config.chatTemperature = t;
    }
    if (input.topP !== undefined) {
        const p = sanitizeTopP(input.topP);
        if (p === null) delete config.chatTopP;
        else config.chatTopP = p;
    }
    saveConfig(config);
    return getChatSettings();
}

const IMAGE_SETTINGS_KEY = 'imageGeneration';
const VIDEO_SETTINGS_KEY = 'videoGeneration';

function getImageSettings() {
    const config = loadConfig();
    const stored = config[IMAGE_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function setImageSettings(patch) {
    const config = loadConfig();
    const current = { ...(config[IMAGE_SETTINGS_KEY] || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
        if (value === null || value === undefined || value === '') {
            delete current[key];
        } else {
            current[key] = value;
        }
    }
    config[IMAGE_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

function getVideoSettings() {
    const config = loadConfig();
    const stored = config[VIDEO_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function setVideoSettings(patch) {
    const config = loadConfig();
    const current = { ...(config[VIDEO_SETTINGS_KEY] || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
        if (value === null || value === undefined || value === '') {
            delete current[key];
        } else {
            current[key] = value;
        }
    }
    config[VIDEO_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

// --- Hugging Face token (first-run model setup guide) ---
//
// Used as the Bearer token for Hugging Face downloads in
// services/model-setup.js. An HF_TOKEN / HUGGINGFACE_TOKEN env var wins when
// set; otherwise the token saved through Settings > Setup applies. The raw
// token is never returned by the status endpoint (only a masked preview).

const HF_SETTINGS_KEY = 'huggingface';

function getHuggingFace() {
    const config = loadConfig();
    const stored = config[HF_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function getHuggingFaceToken() {
    if (process.env.HF_TOKEN) return String(process.env.HF_TOKEN).trim();
    if (process.env.HUGGINGFACE_TOKEN) return String(process.env.HUGGINGFACE_TOKEN).trim();
    const stored = getHuggingFace();
    return typeof stored.token === 'string' ? stored.token.trim() : '';
}

function setHuggingFace(patch) {
    const config = loadConfig();
    const current = { ...(config[HF_SETTINGS_KEY] || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
        if (key !== 'token' && key !== 'user' && key !== 'verifiedAt') continue;
        if (value === null || value === undefined || value === '') {
            delete current[key];
        } else {
            current[key] = String(value);
        }
    }
    config[HF_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

// --- Weather location (dashboard widget reports the browser's geolocation) ---

const WEATHER_SETTINGS_KEY = 'weather';

function sanitizeCoordinate(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error('coordinate out of range');
    }
    return Math.round(n * 10000) / 10000;
}

function getWeather() {
    const config = loadConfig();
    const stored = config[WEATHER_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function setWeather(patch) {
    const config = loadConfig();
    const current = { ...(config[WEATHER_SETTINGS_KEY] || {}) };
    const input = patch || {};
    if (input.lat !== undefined) current.lat = sanitizeCoordinate(input.lat, -90, 90);
    if (input.lon !== undefined) current.lon = sanitizeCoordinate(input.lon, -180, 180);
    if (input.label !== undefined) current.label = String(input.label || '').slice(0, 120);
    current.updatedAt = new Date().toISOString();
    config[WEATHER_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

module.exports = { getConfig, setModelConfig, getReasoningEnabled, setReasoningEnabled, getChatSettings, setChatSettings, getImageSettings, setImageSettings, getVideoSettings, setVideoSettings, getHuggingFace, getHuggingFaceToken, setHuggingFace, getWeather, setWeather };
