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

// --- News feeds (dashboard widget + chat context) ---

const NEWS_SETTINGS_KEY = 'news';
const MAX_NEWS_FEEDS = 20;

function sanitizeFeedUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('feed URL is required');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('feed URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('feed URL must start with http:// or https://');
    }
    return parsed.toString();
}

function sanitizeNewsFeeds(feeds) {
    if (!Array.isArray(feeds)) throw new Error('feeds must be an array');
    if (feeds.length > MAX_NEWS_FEEDS) throw new Error('too many feeds (max ' + MAX_NEWS_FEEDS + ')');
    return feeds.map((feed) => {
        const url = sanitizeFeedUrl(feed && feed.url);
        const fallback = new URL(url).hostname.replace(/^www\./i, '');
        const label = String((feed && feed.label) || '').trim().slice(0, 60) || fallback;
        return { label, url };
    });
}

function getNews() {
    const config = loadConfig();
    const stored = config[NEWS_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function setNews(patch) {
    const config = loadConfig();
    const current = { ...(config[NEWS_SETTINGS_KEY] || {}) };
    const input = patch || {};
    if (input.feeds !== undefined) {
        if (Array.isArray(input.feeds) && input.feeds.length === 0) {
            delete current.feeds;
        } else {
            current.feeds = sanitizeNewsFeeds(input.feeds);
        }
    }
    if (input.localArea !== undefined) {
        const area = String(input.localArea || '').trim().slice(0, 80);
        if (area) current.localArea = area;
        else delete current.localArea;
    }
    current.updatedAt = new Date().toISOString();
    config[NEWS_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

function clearNewsFeeds() {
    const config = loadConfig();
    const current = { ...(config[NEWS_SETTINGS_KEY] || {}) };
    delete current.feeds;
    current.updatedAt = new Date().toISOString();
    config[NEWS_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

// --- ComfyUI launcher (start a local ComfyUI server from the widget/chat) ---
//
// `root` is the ComfyUI install folder (containing main.py) and is cached
// automatically the first time it can be resolved. `startCommand` is an
// optional shell command that overrides auto-detection entirely. Both can
// also be supplied through COMFYUI_ROOT / COMFYUI_START_CMD env vars.

const COMFYUI_SETTINGS_KEY = 'comfyui';

function sanitizeStartCommand(value) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    if (s.length > 2000) throw new Error('start command is too long (max 2000 characters).');
    return s;
}

function getComfyUI() {
    const config = loadConfig();
    const stored = config[COMFYUI_SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function setComfyUI(patch) {
    const config = loadConfig();
    const current = { ...(config[COMFYUI_SETTINGS_KEY] || {}) };
    const input = patch || {};
    if (input.startCommand !== undefined) {
        const cmd = sanitizeStartCommand(input.startCommand);
        if (cmd) current.startCommand = cmd;
        else delete current.startCommand;
    }
    if (input.root !== undefined) {
        const root = String(input.root || '').trim();
        if (root) current.root = root;
        else delete current.root;
    }
    config[COMFYUI_SETTINGS_KEY] = current;
    saveConfig(config);
    return current;
}

module.exports = { getConfig, setModelConfig, getReasoningEnabled, setReasoningEnabled, getChatSettings, setChatSettings, getImageSettings, setImageSettings, getVideoSettings, setVideoSettings, getHuggingFace, getHuggingFaceToken, setHuggingFace, getWeather, setWeather, getNews, setNews, clearNewsFeeds, getComfyUI, setComfyUI };
