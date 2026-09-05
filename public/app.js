/* ============================================
   JARVIS — Local AI Assistant
   Application Logic
   ============================================ */

// --- System Stats Data Structure ---

const systemStats = {
    cpu: {
        usage: 0,
        cores: 0,
        clock: '0 GHz',
        name: '',
        history: []
    },
    ram: {
        usage: 0,
        used: 0,
        total: 0,
        history: []
    },
    vram: {
        available: false,
        usage: 0,
        used: 0,
        total: 0,
        history: []
    },
    gpuName: '',
    gpuTemp: null
};

const HISTORY_LENGTH = 60;
const UPDATE_INTERVAL = 1000;

// --- Canvas References ---

const canvasElements = {
    cpu: null,
    ram: null,
    vram: null
};

const canvasContexts = {
    cpu: null,
    ram: null,
    vram: null
};

// --- Widget Settings ---

const WIDGET_SETTINGS_KEY = 'jarvis-widget-settings';
const WIDGET_IDS = { cpu: 'cpuCard', ram: 'ramCard', vram: 'vramCard', weather: 'weatherCard' };

function loadWidgetSettings() {
    try {
        const saved = localStorage.getItem(WIDGET_SETTINGS_KEY);
        if (saved) return JSON.parse(saved);
    } catch {}
    return { cpu: true, ram: true, vram: true, weather: true };
}

function saveWidgetSettings(settings) {
    try { localStorage.setItem(WIDGET_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function applyWidgetSettings(settings) {
    Object.keys(WIDGET_IDS).forEach(key => {
        const card = document.getElementById(WIDGET_IDS[key]);
        if (card) card.style.display = settings[key] ? '' : 'none';
    });
}

function initSettings() {
    const settingsBtn = document.getElementById('settingsBtn');
    const dropdown = document.getElementById('settingsDropdown');
    const checkboxes = dropdown.querySelectorAll('input[type="checkbox"]');
    const settings = loadWidgetSettings();

    checkboxes.forEach(cb => {
        const widget = cb.dataset.widget;
        cb.checked = settings[widget] !== false;
    });

    applyWidgetSettings(settings);

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');
        settingsBtn.classList.toggle('active');
    });

    checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            const s = loadWidgetSettings();
            s[cb.dataset.widget] = cb.checked;
            saveWidgetSettings(s);
            applyWidgetSettings(s);
        });
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !settingsBtn.contains(e.target)) {
            dropdown.classList.remove('open');
            settingsBtn.classList.remove('active');
        }
    });

    initChatProviderSettings();
}

// --- Chat Provider Settings ---

const CHAT_PROVIDER_KEY = 'jarvis-chat-provider';
const CHAT_MODEL_KEY = 'jarvis-chat-model';

function getChatProvider() {
    return localStorage.getItem(CHAT_PROVIDER_KEY) || 'ollama';
}

function getChatModel() {
    return localStorage.getItem(CHAT_MODEL_KEY) || '';
}

function setChatProvider(provider) {
    localStorage.setItem(CHAT_PROVIDER_KEY, provider);
}

function setChatModel(model) {
    localStorage.setItem(CHAT_MODEL_KEY, model);
}

function initChatProviderSettings() {
    const providerSelect = document.getElementById('chatProvider');
    const modelInput = document.getElementById('chatModel');

    if (!providerSelect || !modelInput) return;

    providerSelect.value = getChatProvider();
    modelInput.value = getChatModel();

    providerSelect.addEventListener('change', () => {
        setChatProvider(providerSelect.value);
    });

    modelInput.addEventListener('change', () => {
        setChatModel(modelInput.value.trim());
    });

    initUnloadModelButton(providerSelect, modelInput);
    initRestartServerButton();
}

function initUnloadModelButton(providerSelect, modelInput) {
    const unloadBtn = document.getElementById('unloadModelBtn');
    if (!unloadBtn) return;

    unloadBtn.addEventListener('click', async () => {
        const model = modelInput.value.trim();
        if (!model) {
            window.alert('Enter a model name first.');
            return;
        }

        const provider = providerSelect.value;
        unloadBtn.disabled = true;
        unloadBtn.textContent = 'Unloading...';

        try {
            const res = await fetch('/api/models/unload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, model })
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                window.alert('Unload failed: ' + (data.error || 'Unknown error'));
                return;
            }

            window.alert('Model unloaded: ' + model);
        } catch (err) {
            window.alert('Connection error: ' + err.message);
        } finally {
            unloadBtn.disabled = false;
            unloadBtn.textContent = 'Unload model';
        }
    });
}

function initRestartServerButton() {
    const restartBtn = document.getElementById('restartServerBtn');
    if (!restartBtn) return;

    restartBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm('Restart the JARVIS server now? The page will reload once it comes back up.')) {
            return;
        }

        restartBtn.disabled = true;
        restartBtn.textContent = 'Restarting...';

        try {
            const res = await fetch('/api/restart', { method: 'POST' });
            try { res.json(); } catch {}
        } catch (err) {
            // The server may die mid-request; ignore and wait for it to come back.
        }

        // Poll until the server is reachable again, then reload the page.
        const startedAt = Date.now();
        while (Date.now() - startedAt < 30000) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const h = await fetch('/api/health');
                if (h.ok) {
                    await new Promise(r => setTimeout(r, 800));
                    window.location.reload();
                    return;
                }
            } catch {}
        }

        restartBtn.disabled = false;
        restartBtn.textContent = 'Restart server';
        window.alert('Server did not come back up. Start it manually with start.bat.');
    });
}

// --- Initialization ---

document.addEventListener('DOMContentLoaded', async () => {
    await bootApp();
});

async function bootApp() {
    initCanvases();
    initTimestamp();
    initSettings();

    // Fetch initial stats
    await updateSystemStats();

    // Seed history with initial values
    for (let i = 0; i < HISTORY_LENGTH; i++) {
        systemStats.cpu.history.push(systemStats.cpu.usage);
        systemStats.ram.history.push(systemStats.ram.usage);
        systemStats.vram.history.push(systemStats.vram.available ? systemStats.vram.usage : 0);
    }

    updateAllCharts();
    startStatUpdates();
    updateTimestamp();
    setInterval(updateTimestamp, 1000);

    initWeather();
    ModelLibrary.init();

    // Boot conversation + chat
    try {
        await DB.ready();
    } catch (e) {
        console.warn('IndexedDB unavailable, running without persistence:', e.message);
    }
    Chat.init();
    await Chat.refreshConversationList();
    renderActiveChat();
}

async function renderActiveChat() {
    const conversations = await Conversations.list();
    if (conversations.length > 0) {
        const messages = await Conversations.select(conversations[0].id);
        renderMessages(messages);
    } else {
        renderMessages([]);
    }
}

function renderMessages(messages) {
    const chatMessagesEl = document.getElementById('chatMessages');
    chatMessagesEl.innerHTML = '';

    if (!messages || messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = 'Start a conversation. Ask me anything.';
        chatMessagesEl.appendChild(empty);
        return;
    }

    messages.forEach((m) => {
        renderMessageIn(m, chatMessagesEl);
    });
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderMessageIn(message, container) {
    const role = message.role;
    const el = document.createElement('div');
    el.className = 'message message--' + (role === 'assistant' ? 'ai' : 'user');

    const roleLabel = document.createElement('div');
    roleLabel.className = 'message-role';
    roleLabel.textContent = role === 'assistant' ? 'JARVIS' : 'USER';

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    // Use markdown parser for AI messages, plain text for user messages
    if (role === 'assistant') {
        contentEl.innerHTML = Markdown.parse(message.content);
    } else {
        contentEl.textContent = message.content;
    }

    el.appendChild(roleLabel);
    el.appendChild(contentEl);
    container.appendChild(el);
}

// --- Canvas Setup ---

function initCanvases() {
    const ids = ['cpuGraph', 'ramGraph', 'vramGraph'];
    const keys = ['cpu', 'ram', 'vram'];

    keys.forEach((key, i) => {
        const canvas = document.getElementById(ids[i]);
        canvasElements[key] = canvas;
        canvasContexts[key] = canvas.getContext('2d');
        resizeCanvas(canvas);
    });

    window.addEventListener('resize', () => {
        keys.forEach(key => {
            resizeCanvas(canvasElements[key]);
            drawChart(key);
        });
    });
}

function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
}

// --- Chart Drawing ---

function drawChart(key) {
    const canvas = canvasElements[key];
    const ctx = canvasContexts[key];
    const history = systemStats[key].history;

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const padding = { top: 4, right: 2, bottom: 4, left: 2 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    ctx.clearRect(0, 0, w, h);

    // Faint grid
    ctx.strokeStyle = 'rgba(108, 255, 154, 0.04)';
    ctx.lineWidth = 0.5;
    for (let y = 0; y <= 4; y++) {
        const yPos = padding.top + (plotH / 4) * y;
        ctx.beginPath();
        ctx.moveTo(padding.left, yPos);
        ctx.lineTo(w - padding.right, yPos);
        ctx.stroke();
    }

    if (history.length < 2) return;

    // Draw filled area under the line
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + plotH);

    for (let i = 0; i < history.length; i++) {
        const x = padding.left + (i / (HISTORY_LENGTH - 1)) * plotW;
        const y = padding.top + plotH - (history[i] / 100) * plotH;
        if (i === 0) {
            ctx.lineTo(x, y);
        } else {
            // Smooth curve
            const prevX = padding.left + ((i - 1) / (HISTORY_LENGTH - 1)) * plotW;
            const prevY = padding.top + plotH - (history[i - 1] / 100) * plotH;
            const cpx = (prevX + x) / 2;
            ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
        }
    }

    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
    gradient.addColorStop(0, 'rgba(108, 255, 154, 0.12)');
    gradient.addColorStop(1, 'rgba(108, 255, 154, 0.01)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw line
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
        const x = padding.left + (i / (HISTORY_LENGTH - 1)) * plotW;
        const y = padding.top + plotH - (history[i] / 100) * plotH;
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            const prevX = padding.left + ((i - 1) / (HISTORY_LENGTH - 1)) * plotW;
            const prevY = padding.top + plotH - (history[i - 1] / 100) * plotH;
            const cpx = (prevX + x) / 2;
            ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
        }
    }

    ctx.strokeStyle = 'rgba(108, 255, 154, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Glow on the line
    ctx.strokeStyle = 'rgba(108, 255, 154, 0.2)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Current value dot
    const lastX = padding.left + ((history.length - 1) / (HISTORY_LENGTH - 1)) * plotW;
    const lastY = padding.top + plotH - (history[history.length - 1] / 100) * plotH;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(108, 255, 154, 0.9)';
    ctx.fill();
}

function updateAllCharts() {
    ['cpu', 'ram', 'vram'].forEach(key => drawChart(key));
}

// --- Fetch Real System Stats from API ---

async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

async function updateSystemStats() {
    const stats = await fetchStats();
    if (!stats) return;

    // CPU
    if (stats.cpu) {
        systemStats.cpu.usage = stats.cpu.usage;
        systemStats.cpu.cores = stats.cpu.cores;
        systemStats.cpu.name = stats.cpu.name;
        if (stats.cpu.clock) systemStats.cpu.clock = stats.cpu.clock;
    }
    systemStats.cpu.history.push(systemStats.cpu.usage);
    if (systemStats.cpu.history.length > HISTORY_LENGTH) {
        systemStats.cpu.history.shift();
    }

    // RAM
    if (stats.ram) {
        systemStats.ram.usage = stats.ram.usage;
        systemStats.ram.used = stats.ram.used;
        systemStats.ram.total = stats.ram.total;
    }
    systemStats.ram.history.push(systemStats.ram.usage);
    if (systemStats.ram.history.length > HISTORY_LENGTH) {
        systemStats.ram.history.shift();
    }

    // VRAM
    if (stats.vram && stats.vram.available) {
        systemStats.vram.usage = stats.vram.usage;
        systemStats.vram.used = stats.vram.used;
        systemStats.vram.total = stats.vram.total;
        systemStats.vram.available = true;
        systemStats.gpuName = stats.gpu.name;
        systemStats.gpuTemp = stats.gpu.temperature;
    } else {
        systemStats.vram.available = false;
    }
    systemStats.vram.history.push(systemStats.vram.available ? systemStats.vram.usage : 0);
    if (systemStats.vram.history.length > HISTORY_LENGTH) {
        systemStats.vram.history.shift();
    }
}

// --- UI Updates ---

function updateStatDisplay() {
    const cpuPct = Math.round(systemStats.cpu.usage);
    const ramPct = Math.round(systemStats.ram.usage);

    document.getElementById('cpuValue').textContent = cpuPct + '%';
    document.getElementById('cpuName').textContent = systemStats.cpu.name || 'Unknown CPU';
    document.getElementById('cpuDetail').textContent = systemStats.cpu.cores + ' cores \u00B7 ' + systemStats.cpu.clock;

    document.getElementById('ramValue').textContent = ramPct + '%';
    document.getElementById('ramDetail').textContent = systemStats.ram.used + ' / ' + systemStats.ram.total + ' GB';

    if (systemStats.vram.available) {
        const vramPct = Math.round(systemStats.vram.usage);
        document.getElementById('gpuName').textContent = systemStats.gpuName || 'Unknown GPU';
        document.getElementById('vramValue').textContent = vramPct + '%';
        const temp = systemStats.gpuTemp;
        document.getElementById('vramDetail').textContent = systemStats.vram.used + ' / ' + systemStats.vram.total + ' GB' + (temp != null ? ' \u00B7 ' + temp + '\u00B0C' : '');
    } else {
        document.getElementById('gpuName').textContent = 'No GPU detected';
        document.getElementById('vramValue').textContent = 'N/A';
        document.getElementById('vramDetail').textContent = 'No GPU detected';
    }
}

function startStatUpdates() {
    setInterval(async () => {
        await updateSystemStats();
        updateStatDisplay();
        updateAllCharts();
    }, UPDATE_INTERVAL);
}

// --- Timestamp ---

function initTimestamp() {
    updateTimestamp();
}

function updateTimestamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('systemTimestamp').textContent = h + ':' + m + ':' + s;
}

// --- Weather (Open-Meteo) ---

const WMO_CODES = {
    0: { desc: 'Clear sky', icon: '\u2600\uFE0F' },
    1: { desc: 'Mainly clear', icon: '\uD83C\uDF24\uFE0F' },
    2: { desc: 'Partly cloudy', icon: '\u26C5' },
    3: { desc: 'Overcast', icon: '\u2601\uFE0F' },
    45: { desc: 'Fog', icon: '\uD83C\uDF2B\uFE0F' },
    48: { desc: 'Rime fog', icon: '\uD83C\uDF2B\uFE0F' },
    51: { desc: 'Light drizzle', icon: '\uD83C\uDF26\uFE0F' },
    53: { desc: 'Moderate drizzle', icon: '\uD83C\uDF26\uFE0F' },
    55: { desc: 'Dense drizzle', icon: '\uD83C\uDF27\uFE0F' },
    56: { desc: 'Freezing drizzle', icon: '\uD83C\uDF28\uFE0F' },
    57: { desc: 'Heavy freezing drizzle', icon: '\uD83C\uDF28\uFE0F' },
    61: { desc: 'Slight rain', icon: '\uD83C\uDF27\uFE0F' },
    63: { desc: 'Moderate rain', icon: '\uD83C\uDF27\uFE0F' },
    65: { desc: 'Heavy rain', icon: '\uD83C\uDF27\uFE0F' },
    66: { desc: 'Freezing rain', icon: '\uD83C\uDF28\uFE0F' },
    67: { desc: 'Heavy freezing rain', icon: '\uD83C\uDF28\uFE0F' },
    71: { desc: 'Slight snow', icon: '\u2744\uFE0F' },
    73: { desc: 'Moderate snow', icon: '\u2744\uFE0F' },
    75: { desc: 'Heavy snow', icon: '\u2744\uFE0F' },
    77: { desc: 'Snow grains', icon: '\u2744\uFE0F' },
    80: { desc: 'Light showers', icon: '\uD83C\uDF26\uFE0F' },
    81: { desc: 'Moderate showers', icon: '\uD83C\uDF27\uFE0F' },
    82: { desc: 'Violent showers', icon: '\uD83C\uDF27\uFE0F' },
    85: { desc: 'Light snow showers', icon: '\uD83C\uDF28\uFE0F' },
    86: { desc: 'Heavy snow showers', icon: '\uD83C\uDF28\uFE0F' },
    95: { desc: 'Thunderstorm', icon: '\u26C8\uFE0F' },
    96: { desc: 'Thunderstorm w/ hail', icon: '\u26C8\uFE0F' },
    99: { desc: 'Severe thunderstorm', icon: '\u26C8\uFE0F' }
};

const WEATHER_REFRESH_MS = 15 * 60 * 1000;
let weatherCoords = null;

function initWeather() {
    if (!navigator.geolocation) {
        setWeatherError('Geolocation not supported');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            weatherCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            fetchWeather();
            setInterval(fetchWeather, WEATHER_REFRESH_MS);
        },
        () => {
            setWeatherError('Unable to get user location');
        },
        { timeout: 10000 }
    );
}

function setWeatherError(msg) {
    document.getElementById('weatherStatus').textContent = msg;
    document.getElementById('weatherStatus').classList.add('weather-status--error');
    document.getElementById('weatherIcon').textContent = '\u2753';
    document.getElementById('weatherTemp').textContent = '--';
    document.getElementById('weatherDetail').textContent = '';
    document.getElementById('weatherLocation').textContent = '';
}

async function fetchWeather() {
    if (!weatherCoords) return;

    try {
        const url = 'https://api.open-meteo.com/v1/forecast'
            + '?latitude=' + weatherCoords.lat
            + '&longitude=' + weatherCoords.lon
            + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
            + '&timezone=auto';

        const res = await fetch(url);
        if (!res.ok) throw new Error('API error');

        const data = await res.json();
        const c = data.current;
        const code = c.weather_code;
        const info = WMO_CODES[code] || { desc: 'Unknown', icon: '\u2753' };

        document.getElementById('weatherStatus').textContent = 'NOW';
        document.getElementById('weatherStatus').classList.remove('weather-status--error');
        document.getElementById('weatherIcon').textContent = info.icon;
        document.getElementById('weatherTemp').textContent = Math.round(c.temperature_2m) + '\u00B0C';
        document.getElementById('weatherDetail').textContent =
            info.desc + ' \u00B7 Humidity ' + c.relative_humidity_2m + '%'
            + ' \u00B7 Wind ' + c.wind_speed_10m + ' km/h';

        const locRes = await fetch(
            'https://geocoding-api.open-meteo.com/v1/search?name=&latitude='
            + weatherCoords.lat + '&longitude=' + weatherCoords.lon + '&count=1'
        );
        document.getElementById('weatherLocation').textContent =
            data.timezone || (weatherCoords.lat.toFixed(2) + ', ' + weatherCoords.lon.toFixed(2));
    } catch {
        setWeatherError('Unable to fetch weather data');
    }
}

