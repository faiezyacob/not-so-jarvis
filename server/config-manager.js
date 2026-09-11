/* ============================================
   JARVIS — Config Manager
   Stores active AI provider/model in a local JSON file.
   ============================================ */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const DEFAULT_CONFIG = { provider: 'ollama', model: 'llama3.2', reasoningEnabled: true };

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

module.exports = { getConfig, setModelConfig, getReasoningEnabled, setReasoningEnabled, getImageSettings, setImageSettings, getVideoSettings, setVideoSettings };
