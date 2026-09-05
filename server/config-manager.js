/* ============================================
   JARVIS — Config Manager
   Stores active AI provider/model in a local JSON file.
   ============================================ */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const DEFAULT_CONFIG = { provider: 'ollama', model: 'llama3.2' };

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

module.exports = { getConfig, setModelConfig };
