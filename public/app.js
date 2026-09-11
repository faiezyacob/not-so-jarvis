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
const WIDGET_IDS = { cpu: 'cpuCard', ram: 'ramCard', vram: 'vramCard', weather: 'weatherCard', generated: 'generatedWidget', comfyui: 'comfyuiCard' };

function loadWidgetSettings() {
    try {
        const saved = localStorage.getItem(WIDGET_SETTINGS_KEY);
        if (saved) return { comfyui: true, ...JSON.parse(saved) };
    } catch {}
    return { cpu: true, ram: true, vram: true, weather: true, generated: true, comfyui: true };
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

// --- Widget Order (Drag & Drop) ---

const WIDGET_ORDER_KEY = 'jarvis-widget-order';
const DEFAULT_WIDGET_ORDER = ['cpuCard', 'ramCard', 'vramCard', 'weatherCard', 'generatedWidget', 'comfyuiCard'];

function loadWidgetOrder() {
    try {
        const saved = localStorage.getItem(WIDGET_ORDER_KEY);
        if (saved) {
            const order = JSON.parse(saved);
            if (Array.isArray(order) && order.length === DEFAULT_WIDGET_ORDER.length) return order;
        }
    } catch {}
    return DEFAULT_WIDGET_ORDER.slice();
}

function saveWidgetOrder(order) {
    try { localStorage.setItem(WIDGET_ORDER_KEY, JSON.stringify(order)); } catch {}
}

function applyWidgetOrder() {
    const monitor = document.querySelector('.system-monitor');
    if (!monitor) return;

    const order = loadWidgetOrder();
    const cards = monitor.querySelectorAll('.metric-card');

    const cardMap = {};
    cards.forEach(card => { cardMap[card.id] = card; });

    order.forEach(id => {
        const card = cardMap[id];
        if (card) monitor.insertBefore(card, document.querySelector('.monitor-footer'));
    });
}

let draggedCard = null;

function initWidgetDragDrop() {
    applyWidgetOrder();

    const monitor = document.querySelector('.system-monitor');
    if (!monitor) return;

    const cards = monitor.querySelectorAll('.metric-card');

    cards.forEach(card => {
        card.setAttribute('draggable', 'true');

        card.addEventListener('dragstart', (e) => {
            draggedCard = card;
            card.classList.add('metric-card--dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.id);
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('metric-card--dragging');
            monitor.querySelectorAll('.metric-card').forEach(c => {
                c.classList.remove('metric-card--dragover');
            });
            draggedCard = null;
            persistCurrentOrder();
            resizeAllCanvases();
        });

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!draggedCard || draggedCard === card) return;
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('metric-card--dragover');
        });

        card.addEventListener('dragleave', () => {
            card.classList.remove('metric-card--dragover');
        });

        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('metric-card--dragover');
            if (!draggedCard || draggedCard === card) return;

            const allCards = Array.from(monitor.querySelectorAll('.metric-card'));
            const dragIdx = allCards.indexOf(draggedCard);
            const dropIdx = allCards.indexOf(card);

            if (dragIdx < dropIdx) {
                monitor.insertBefore(draggedCard, card.nextSibling);
            } else {
                monitor.insertBefore(draggedCard, card);
            }
        });
    });
}

function persistCurrentOrder() {
    const monitor = document.querySelector('.system-monitor');
    if (!monitor) return;
    const cards = monitor.querySelectorAll('.metric-card');
    const order = Array.from(cards).map(c => c.id);
    saveWidgetOrder(order);
}

function resizeAllCanvases() {
    ['cpu', 'ram', 'vram'].forEach(key => {
        resizeCanvas(canvasElements[key]);
        drawChart(key);
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

    // Panel navigation (left sidebar)
    const navItems = dropdown.querySelectorAll('.settings-nav-item');
    const panels = dropdown.querySelectorAll('.settings-panel');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(i => i.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            item.classList.add('active');
            const panel = dropdown.querySelector('.settings-panel[data-panel="' + item.dataset.panel + '"]');
            if (panel) panel.classList.add('active');
        });
    });

    initChatProviderSettings();
    initImageGenSettings();
    initUpscaleSettings();
    initVideoSettings();
    initFreeComfyButton();
    initRestartServerButton();
}

function initFreeComfyButton() {
    const freeBtn = document.getElementById('freeComfyBtn');
    if (!freeBtn) return;

    freeBtn.addEventListener('click', async () => {
        freeBtn.disabled = true;
        freeBtn.textContent = 'Freeing...';

        try {
            const res = await fetch('/api/comfyui/free', { method: 'POST' });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                window.alert('Free failed: ' + (data.error || 'Unknown error'));
                return;
            }

            window.alert('ComfyUI models unloaded and memory freed');
        } catch (err) {
            window.alert('Connection error: ' + err.message);
        } finally {
            freeBtn.disabled = false;
            freeBtn.textContent = 'Free model';
        }
    });
}

// --- Image Generation Settings ---
//
// UNET / CLIP / VAE overrides for the Krea2 pipeline are stored server-side
// in data/config.json so they apply to every generation. The UI lists the
// models ComfyUI actually has when it is reachable, but free text is always
// allowed.
//
// LoRA stack: users attach LoRAs from the list ComfyUI reports (LoraLoader
// lora_name entries). Each attached LoRA has an on/off toggle, a strength
// slider, and an optional trigger word. The stack is persisted as
// settings.loras[] and chained into the Krea2 workflow by the
// image-generator service. Trigger words are prepended to the prompt.

const IMAGE_GEN_FIELDS = [
    { key: 'unet', inputId: 'imageUnet', listId: 'imageUnetList' },
    { key: 'clip', inputId: 'imageClip', listId: 'imageClipList' },
    { key: 'vae', inputId: 'imageVae', listId: 'imageVaeList' },
    { key: 'editLora', inputId: 'imageEditLora' }
];

const LORA_STRENGTH_MIN = 0;
const LORA_STRENGTH_MAX = 2;
const LORA_STRENGTH_STEP = 0.05;

// --- LoRA stack helpers ---

function initLoraStack(opts) {
    const o = opts || {};
    return {
        loras: [],          // [{ name, strength, on, triggerWord }] current attached stack
        triggerMemory: {},  // { [loraName]: triggerWord } remembered even after removal
        available: [],      // lora filenames ComfyUI reports
        listEl: null,
        addSelect: null,
        statusEl: null,
        endpoint: o.endpoint || '/api/settings/image',  // where the stack is persisted
        listId: o.listId || 'loraList',
        addSelectId: o.addSelectId || 'loraAddSelect',
        statusId: o.statusId || 'loraStatus'
    };
}

function loraStatus(state, text, isError) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.classList.toggle('settings-save-status--error', !!isError);
    state.statusEl.style.display = text ? '' : 'none';
}

function loraRow(state, lora, index) {
    const row = document.createElement('div');
    row.className = 'lora-row' + (lora.on === false ? ' lora-row--off' : '');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'lora-row-toggle';
    toggle.checked = lora.on !== false;
    toggle.title = 'Toggle LoRA';
    toggle.addEventListener('change', () => {
        lora.on = toggle.checked;
        saveLoraStack(state);
    });

    const nameWrap = document.createElement('div');
    nameWrap.className = 'lora-name-wrap';

    const name = document.createElement('span');
    name.className = 'lora-name';
    name.textContent = lora.name;
    name.title = lora.name;
    nameWrap.appendChild(name);

    const triggerInput = document.createElement('input');
    triggerInput.type = 'text';
    triggerInput.className = 'lora-trigger-word';
    triggerInput.placeholder = 'trigger word';
    triggerInput.value = lora.triggerWord || '';
    triggerInput.title = 'Trigger word prepended to prompt';
    triggerInput.addEventListener('change', () => {
        const word = triggerInput.value.trim();
        lora.triggerWord = word;
        if (word) {
            state.triggerMemory[lora.name] = word;
        } else {
            delete state.triggerMemory[lora.name];
        }
        saveLoraStack(state);
    });
    nameWrap.appendChild(triggerInput);

    const strength = document.createElement('input');
    strength.type = 'range';
    strength.className = 'lora-strength';
    strength.min = String(LORA_STRENGTH_MIN);
    strength.max = String(LORA_STRENGTH_MAX);
    strength.step = String(LORA_STRENGTH_STEP);
    strength.value = String(clampLoraStrength(lora.strength));
    strength.title = 'Strength';
    strength.addEventListener('input', () => {
        row.dataset.strength = strength.value;
    });
    strength.addEventListener('change', () => {
        lora.strength = Number(strength.value);
        saveLoraStack(state);
    });
    row.dataset.strength = String(clampLoraStrength(lora.strength));

    const strengthVal = document.createElement('span');
    strengthVal.className = 'lora-strength-label';

    const remove = document.createElement('button');
    remove.className = 'lora-remove';
    remove.textContent = '\u00D7';
    remove.title = 'Remove LoRA';
    remove.addEventListener('click', (e) => {
        e.stopPropagation();
        state.loras.splice(index, 1);
        renderLoraStack(state);
        saveLoraStack(state);
    });

    row.appendChild(toggle);
    row.appendChild(nameWrap);
    row.appendChild(strength);
    row.appendChild(strengthVal);
    row.appendChild(remove);
    return row;
}

function clampLoraStrength(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(LORA_STRENGTH_MIN, Math.min(LORA_STRENGTH_MAX, n));
}

function renderLoraStack(state) {
    if (!state.listEl) return;
    state.listEl.innerHTML = '';

    state.loras.forEach((lora, i) => {
        const row = loraRow(state, lora, i);
        state.listEl.appendChild(row);
        const label = row.querySelector('.lora-strength-label');
        const slider = row.querySelector('.lora-strength');
        const updateLabel = () => { label.textContent = Number(slider ? slider.value : (lora.strength || 1)).toFixed(2); };
        if (slider) slider.addEventListener('input', updateLabel);
        updateLabel();
    });

    // Rebuild the "Add LoRA" dropdown, hiding names already in the stack.
    if (state.addSelect) {
        const attached = new Set(state.loras.map(l => l.name));
        state.addSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '\u2014 Add LoRA \u2014';
        state.addSelect.appendChild(placeholder);
        state.available.forEach(name => {
            if (attached.has(name)) return;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            state.addSelect.appendChild(opt);
        });
    }
}

async function saveLoraStack(state) {
    loraStatus(state, 'Saving...');
    try {
        const res = await fetch(state.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                loras: state.loras,
                loraTriggerWords: state.triggerMemory
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            loraStatus(state, 'Save failed: ' + (data.error || 'Unknown error'), true);
            return;
        }
        const count = state.loras.filter(l => l.on !== false).length;
        loraStatus(state, count
            ? 'Saved ' + count + ' LoRA' + (count > 1 ? 's' : '')
            : 'No active LoRAs');
    } catch {
        loraStatus(state, 'Save failed: connection error', true);
    }
    setTimeout(() => loraStatus(state, ''), 3000);
}

function initLoraSettings(state) {
    const listEl = document.getElementById(state.listId);
    const addSelect = document.getElementById(state.addSelectId);
    const statusEl = document.getElementById(state.statusId);
    if (!listEl || !addSelect) return;

    state.listEl = listEl;
    state.addSelect = addSelect;
    state.statusEl = statusEl;
    if (statusEl) statusEl.style.display = 'none';

    addSelect.addEventListener('change', () => {
        const name = addSelect.value;
        if (!name) return;
        state.loras.push({
            name,
            strength: 1,
            on: true,
            triggerWord: state.triggerMemory[name] || ''
        });
        addSelect.value = '';
        renderLoraStack(state);
        saveLoraStack(state);
    });
}

function initImageGenSettings() {
    const inputs = IMAGE_GEN_FIELDS
        .map(f => ({ f, input: document.getElementById(f.inputId) }))
        .filter(x => x.input);
    if (!inputs.length) return;

    const statusEl = document.getElementById('imageSettingsStatus');
    if (statusEl) statusEl.style.display = 'none';
    let saved = {};

    const loraState = initLoraStack();
    initLoraSettings(loraState);

    const setStatus = (text, isError) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('settings-save-status--error', !!isError);
        statusEl.style.display = text ? '' : 'none';
    };

    const persist = async (field, input) => {
        const value = input.value.trim();
        if (value === (saved[field.key] || '')) return;

        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field.key]: value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            saved[field.key] = value;
            setStatus(value ? 'Saved: ' + value : 'Reverted to default');
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    // Aspect Ratio + Size are the only user-facing resolution controls. They
    // map to Krea2 latent dimensions server-side, so no pixel values appear
    // in the UI.
    const persistSelect = async (key, select) => {
        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: select.value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            setStatus('Saved: ' + select.value);
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    const aspectSelect = document.getElementById('imageAspectRatio');
    const sizeSelect = document.getElementById('imageSize');
    if (aspectSelect) aspectSelect.addEventListener('change', () => persistSelect('aspectRatio', aspectSelect));
    if (sizeSelect) sizeSelect.addEventListener('change', () => persistSelect('imageSize', sizeSelect));

    (async () => {
        try {
            const res = await fetch('/api/settings/image');
            if (!res.ok) throw new Error('API error');
            const data = await res.json();

            const defaults = data.defaults || {};
            const settings = data.settings || {};
            const choices = data.choices || {};

            IMAGE_GEN_FIELDS.forEach((f) => {
                const input = document.getElementById(f.inputId);
                if (!input) return;
                saved[f.key] = settings[f.key] || '';
                input.value = saved[f.key];
                input.placeholder = f.key === 'clip'
                    ? (defaults.clip || 'CLIP model')
                    : (defaults[f.key] || (f.key.toUpperCase() + ' model'));
                input.title = 'Default: ' + (defaults[f.key] || '');

                const list = document.getElementById(f.listId);
                if (list) {
                    const options = choices[f.key === 'clip' ? 'clips' : f.key + 's'] || [];
                    options.forEach((name) => {
                        const opt = document.createElement('option');
                        opt.value = name;
                        list.appendChild(opt);
                    });
                }
            });

            // Load the LoRA stack (attached list + available scan from ComfyUI)
            // and the remembered per-LoRA trigger words.
            loraState.available = Array.isArray(choices.loras) ? choices.loras : [];
            loraState.triggerMemory = (settings.loraTriggerWords && typeof settings.loraTriggerWords === 'object')
                ? settings.loraTriggerWords
                : {};
            loraState.loras = Array.isArray(settings.loras) ? settings.loras.map((l) => ({
                name: l.name,
                strength: clampLoraStrength(l.strength),
                on: l.on !== false,
                triggerWord: (l.triggerWord !== undefined && l.triggerWord !== null)
                    ? String(l.triggerWord)
                    : (loraState.triggerMemory[l.name] || '')
            })) : [];
            renderLoraStack(loraState);

            // Restore the saved Aspect Ratio + Size (fall back to defaults).
            if (aspectSelect) aspectSelect.value = settings.aspectRatio || defaults.aspectRatio || '4:5';
            if (sizeSelect) sizeSelect.value = settings.imageSize || defaults.imageSize || 'M';

            if (!data.comfyAvailable) {
                setStatus('ComfyUI unreachable — showing defaults only', true);
                loraStatus(loraState, 'ComfyUI unreachable — LoRAs unavailable', true);
            }
        } catch {
            setStatus('Could not load image settings', true);
        }
    })();

    inputs.forEach(({ f, input }) => {
        input.addEventListener('change', () => persist(f, input));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
    });
}

// --- Shared Upscale Settings (image + video) ---

const UPSCALE_SELECT_FIELDS = [
    { key: 'upscaleEngine', id: 'upscaleEngine' },
    { key: 'upscaleMode', id: 'upscaleMode' },
    { key: 'upscaleResolution', id: 'upscaleResolution' },
    { key: 'upscaleMultiplier', id: 'upscaleMultiplier' },
    { key: 'upscaleProfile', id: 'upscaleProfile' },
    { key: 'upscaleNoise', id: 'upscaleNoise' },
    { key: 'upscalePreScale', id: 'upscalePreScale' }
];

const UPSCALE_TEXT_FIELDS = [
    { key: 'seedvr2Dit', id: 'upscaleDiT' },
    { key: 'seedvr2Vae', id: 'upscaleVae' },
    { key: 'seedvr2Attention', id: 'upscaleAttention' }
];

function initUpscaleSettings() {
    const statusEl = document.getElementById('upscaleSettingsStatus');
    if (statusEl) statusEl.style.display = 'none';
    const setStatus = (text, isError) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('settings-save-status--error', !!isError);
        statusEl.style.display = text ? '' : 'none';
    };

    const syncVisibility = () => {
        const engineSel = document.getElementById('upscaleEngine');
        const modeSel = document.getElementById('upscaleMode');
        const engine = engineSel ? engineSel.value : 'rtx';
        const mode = modeSel ? modeSel.value : 'target';

        const resField = document.getElementById('upscaleResolutionField');
        const multField = document.getElementById('upscaleMultiplierField');
        if (resField) resField.style.display = mode === 'target' ? '' : 'none';
        // Multiplier doubles as the RTX video scale factor, so keep it visible
        // when RTX is selected even in target mode.
        if (multField) multField.style.display = (mode === 'multiplier' || engine === 'rtx') ? '' : 'none';

        ['upscaleProfileField', 'upscaleNoiseField', 'upscalePreScaleField', 'upscaleDiTField', 'upscaleVaeField', 'upscaleAttentionField'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.style.display = engine === 'seedvr2' ? '' : 'none';
        });
    };

    const persistSelect = async (key, select) => {
        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: select.value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            setStatus('Saved: ' + select.value);
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    const persistText = async (key, input) => {
        const value = input.value.trim();
        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            setStatus(value ? 'Saved: ' + value : 'Reverted to default');
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    const engineSel = document.getElementById('upscaleEngine');
    const modeSel = document.getElementById('upscaleMode');

    UPSCALE_SELECT_FIELDS.forEach(({ key, id }) => {
        const select = document.getElementById(id);
        if (!select) return;
        select.addEventListener('change', () => persistSelect(key, select));
    });

    UPSCALE_TEXT_FIELDS.forEach(({ key, id }) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => persistText(key, input));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
    });

    if (engineSel) engineSel.addEventListener('change', syncVisibility);
    if (modeSel) modeSel.addEventListener('change', syncVisibility);

    (async () => {
        try {
            const res = await fetch('/api/settings/image');
            if (!res.ok) throw new Error('API error');
            const data = await res.json();
            const defaults = data.defaults || {};
            const settings = data.settings || {};

            UPSCALE_SELECT_FIELDS.forEach(({ key, id }) => {
                const select = document.getElementById(id);
                if (!select) return;
                const stored = settings[key];
                select.value = (stored !== undefined && stored !== null && stored !== '')
                    ? stored
                    : (defaults[key] !== undefined && defaults[key] !== null ? defaults[key] : select.value);
            });

            UPSCALE_TEXT_FIELDS.forEach(({ key, id }) => {
                const input = document.getElementById(id);
                if (!input) return;
                const stored = settings[key];
                input.value = (stored !== undefined && stored !== null && stored !== '') ? stored : '';
                input.placeholder = defaults[key] || (key === 'seedvr2Dit' ? 'SeedVR2 DiT model' : key === 'seedvr2Attention' ? 'sdpa' : 'SeedVR2 VAE model');
            });

            syncVisibility();
        } catch {
            setStatus('Could not load upscale settings', true);
        }
    })();
}

// --- Video Generation Settings ---

const VIDEO_SELECT_FIELDS = [
    { key: 'h3Size', id: 'videoSizeScale' },
    { key: 'h3Duration', id: 'videoDuration' },
    { key: 'attentionBackend', id: 'videoAttentionBackend' }
];

const VIDEO_TEXT_FIELDS = [
    { key: 'h3Unet', id: 'videoUnet' },
    { key: 'h3Clip', id: 'videoClip' },
    { key: 'h3VideoVae', id: 'videoVae' },
    { key: 'h3AudioVae', id: 'videoAudioVae' }
];

const VIDEO_HINTS = {
    videoUnet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    videoClip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    videoAudioVae: 'minimax_h3_audio_vae_fp32.safetensors'
};

// --- Video Generation Settings ---

function initVideoSettings() {
    const statusEl = document.getElementById('videoSettingsStatus');
    if (statusEl) statusEl.style.display = 'none';
    const setStatus = (text, isError) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('settings-save-status--error', !!isError);
        statusEl.style.display = text ? '' : 'none';
    };

    const loraState = initLoraStack({
        endpoint: '/api/settings/video',
        listId: 'videoLoraList',
        addSelectId: 'videoLoraAddSelect',
        statusId: 'videoLoraStatus'
    });
    initLoraSettings(loraState);

    const persistSelect = async (key, select) => {
        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: select.value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            setStatus('Saved: ' + select.value);
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    const persistText = async (key, input) => {
        const value = input.value.trim();
        setStatus('Saving...');
        try {
            const res = await fetch('/api/settings/video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                return;
            }
            setStatus(value ? 'Saved: ' + value : 'Reverted to default');
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };

    VIDEO_SELECT_FIELDS.forEach(({ key, id }) => {
        const select = document.getElementById(id);
        if (!select) return;
        select.addEventListener('change', () => persistSelect(key, select));
    });

    VIDEO_TEXT_FIELDS.forEach(({ key, id }) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => persistText(key, input));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
    });

    (async () => {
        try {
            const res = await fetch('/api/settings/video');
            if (!res.ok) throw new Error('API error');
            const data = await res.json();
            const defaults = data.defaults || {};
            const settings = data.settings || {};

            VIDEO_SELECT_FIELDS.forEach(({ key, id }) => {
                const select = document.getElementById(id);
                if (!select) return;
                const stored = settings[key];
                select.value = (stored !== undefined && stored !== null && stored !== '')
                    ? stored
                    : (defaults[key] !== undefined && defaults[key] !== null ? defaults[key] : select.value);
            });

            VIDEO_TEXT_FIELDS.forEach(({ key, id }) => {
                const input = document.getElementById(id);
                if (!input) return;
                const stored = settings[key];
                input.value = (stored !== undefined && stored !== null && stored !== '') ? stored : '';
                input.placeholder = defaults[key] || VIDEO_HINTS[id] || key;
                input.title = 'Default: ' + (defaults[key] || VIDEO_HINTS[id] || '');
            });

            const choices = data.choices || {};
            loraState.available = Array.isArray(choices.loras) ? choices.loras : [];
            loraState.triggerMemory = (settings.loraTriggerWords && typeof settings.loraTriggerWords === 'object')
                ? settings.loraTriggerWords
                : {};
            loraState.loras = Array.isArray(settings.loras) ? settings.loras.map((l) => ({
                name: l.name,
                strength: clampLoraStrength(l.strength),
                on: l.on !== false,
                triggerWord: (l.triggerWord !== undefined && l.triggerWord !== null)
                    ? String(l.triggerWord)
                    : (loraState.triggerMemory[l.name] || '')
            })) : [];
            renderLoraStack(loraState);

            if (!data.comfyAvailable) {
                setStatus('ComfyUI unreachable — showing defaults only', true);
                loraStatus(loraState, 'ComfyUI unreachable — LoRAs unavailable', true);
            }
        } catch {
            setStatus('Could not load video settings', true);
        }
    })();
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

// --- Chat Reasoning Toggle (thinking-capable models, on by default) ---

const CHAT_REASONING_KEY = 'jarvis-chat-reasoning';
let chatThinkingModels = null;

function getReasoningEnabled() {
    try {
        return localStorage.getItem(CHAT_REASONING_KEY) !== 'false';
    } catch {
        return true;
    }
}

function setReasoningEnabled(enabled) {
    try { localStorage.setItem(CHAT_REASONING_KEY, enabled ? 'true' : 'false'); } catch {}
}

function modelSupportsThinking(modelId) {
    if (!modelId) return false;
    if (!Array.isArray(chatThinkingModels)) return false;
    return chatThinkingModels.indexOf(modelId) !== -1;
}

async function fetchThinkingModels() {
    if (Array.isArray(chatThinkingModels)) return chatThinkingModels;
    try {
        const res = await fetch('/api/ai/models');
        const data = await res.json();
        const list = (data.models || []).filter(function (m) {
            return m.capabilities && m.capabilities.indexOf('thinking') !== -1;
        }).map(function (m) { return m.id; });
        chatThinkingModels = list;
    } catch {
        chatThinkingModels = [];
    }
    return chatThinkingModels;
}

function refreshReasoningVisibility(modelInput) {
    const field = document.getElementById('chatReasoningField');
    if (!field || !modelInput) return;
    const supported = modelSupportsThinking(modelInput.value.trim());
    field.style.display = supported ? '' : 'none';
}

function initChatReasoningToggle(providerSelect, modelInput) {
    const toggle = document.getElementById('chatReasoningToggle');
    if (!toggle) return;

    toggle.checked = getReasoningEnabled();

    // Sync with the persisted server setting (on by default).
    fetch('/api/settings/chat').then(function (res) {
        return res.json();
    }).then(function (data) {
        if (data && typeof data.reasoningEnabled === 'boolean') {
            setReasoningEnabled(data.reasoningEnabled);
            toggle.checked = data.reasoningEnabled;
        }
    }).catch(function () {});

    toggle.addEventListener('change', function () {
        setReasoningEnabled(toggle.checked);
        fetch('/api/settings/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reasoningEnabled: toggle.checked })
        }).catch(function () {});
        if (typeof ModelLibrary !== 'undefined' && ModelLibrary.syncReasoningToggles) {
            ModelLibrary.syncReasoningToggles(toggle.checked);
        }
    });

    fetchThinkingModels().then(function () {
        refreshReasoningVisibility(modelInput);
    });
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
        refreshReasoningVisibility(modelInput);
    });

    initChatReasoningToggle(providerSelect, modelInput);
    initUnloadModelButton(providerSelect, modelInput);
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
    initWidgetDragDrop();

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
    Gallery.init();
    initComfyUI();

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

// --- ComfyUI Widget ---

const COMFYUI_REFRESH_MS = 1000;
let comfyuiProgress = null; // { value, max } from ComfyUI's /ws relayed via SSE
let comfyuiEvents = null;

function initComfyUI() {
    fetchComfyUIStatus();
    setInterval(fetchComfyUIStatus, COMFYUI_REFRESH_MS);
    connectComfyUIEvents();
    const cancelBtn = document.getElementById('comfyuiCancelBtn');
    if (cancelBtn && !cancelBtn.dataset.bound) {
        cancelBtn.dataset.bound = '1';
        cancelBtn.addEventListener('click', cancelComfyUIJob);
    }
}

async function cancelComfyUIJob() {
    const cancelBtn = document.getElementById('comfyuiCancelBtn');
    if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling...';
    }
    try {
        const res = await fetch('/api/comfyui/cancel', { method: 'POST' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Cancel failed');
        }
        comfyuiProgress = null;
        await fetchComfyUIStatus();
    } catch (err) {
        const detailEl = document.getElementById('comfyuiDetail');
        if (detailEl) detailEl.textContent = 'Cancel failed: ' + err.message;
    } finally {
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancel job';
        }
    }
}

async function fetchComfyUIStatus() {
    try {
        const res = await fetch('/api/comfyui/status');
        if (!res.ok) throw new Error('Fetch failed');
        const data = await res.json();
        updateComfyUIDisplay(data);
    } catch {
        updateComfyUIDisplay({ available: false, queue: null, system_stats: null });
    }
}

// Real-time generation progress is relayed from the JARVIS server, which keeps
// its own WebSocket to ComfyUI and streams progress here over Server-Sent
// Events. The browser never talks to ComfyUI directly.
function connectComfyUIEvents() {
    if (comfyuiEvents) return;
    try {
        comfyuiEvents = new EventSource('/api/comfyui/events');
        comfyuiEvents.addEventListener('progress', (e) => {
            try {
                const d = JSON.parse(e.data);
                if (d && d.max > 0) {
                    comfyuiProgress = { value: d.value, max: d.max };
                    updateComfyUIProgress();
                }
            } catch {}
        });
        comfyuiEvents.addEventListener('idle', () => {
            comfyuiProgress = null;
        });
        comfyuiEvents.onerror = () => {
            comfyuiProgress = null;
            comfyuiEvents.close();
            comfyuiEvents = null;
            setTimeout(connectComfyUIEvents, 5000);
        };
    } catch {
        comfyuiEvents = null;
    }
}

function updateComfyUIDisplay(data) {
    const statusEl = document.getElementById('comfyuiStatus');
    const valueEl = document.getElementById('comfyuiValue');
    const progressWrap = document.getElementById('comfyuiProgressWrapper');
    const detailEl = document.getElementById('comfyuiDetail');
    const cancelBtn = document.getElementById('comfyuiCancelBtn');
    if (!statusEl || !detailEl || !valueEl || !progressWrap) return;

    if (!data || !data.available) {
        statusEl.textContent = 'Offline';
        statusEl.className = 'comfyui-status comfyui-status--offline';
        valueEl.style.display = 'none';
        progressWrap.style.display = 'none';
        detailEl.textContent = 'ComfyUI not reachable';
        if (cancelBtn) cancelBtn.style.display = 'none';
        return;
    }

    const running = (data.queue && data.queue.queue_running) || [];
    const pending = (data.queue && data.queue.queue_pending) || [];
    const gpu = (data.system_stats && data.system_stats.devices && data.system_stats.devices[0]) || null;

    if (running.length > 0) {
        statusEl.textContent = 'Generating';
        statusEl.className = 'comfyui-status comfyui-status--generating';
        valueEl.style.display = '';
        progressWrap.style.display = 'block';
        updateComfyUIProgress();
    } else {
        comfyuiProgress = null;
        statusEl.textContent = pending.length > 0 ? 'Queued' : 'Online';
        statusEl.className = pending.length > 0 ? 'comfyui-status comfyui-status--queued' : 'comfyui-status comfyui-status--online';
        valueEl.style.display = 'none';
        progressWrap.style.display = 'none';
    }

    if (cancelBtn && !cancelBtn.disabled) {
        cancelBtn.style.display = (running.length > 0 || pending.length > 0) ? '' : 'none';
    }

    let detail = '';
    if (pending.length > 0) detail += pending.length + ' queued \u00B7 ';
    if (gpu) {
        const gpuName = gpu.name || 'GPU';
        if (gpu.vram_total) {
            const used = gpu.vram_total - (gpu.vram_free || 0);
            detail += gpuName + ' \u00B7 ' + gb(used) + '/' + gb(gpu.vram_total) + ' VRAM';
        } else {
            detail += gpuName;
        }
    }
    detailEl.textContent = detail || '-';
}

function updateComfyUIProgress() {
    const valueEl = document.getElementById('comfyuiValue');
    const progressBar = document.getElementById('comfyuiProgressBar');
    if (!valueEl || !progressBar) return;

    if (comfyuiProgress && comfyuiProgress.max > 0) {
        const pct = Math.min(100, Math.round((comfyuiProgress.value / comfyuiProgress.max) * 100));
        valueEl.textContent = pct + '%';
        progressBar.style.width = pct + '%';
        progressBar.classList.remove('comfyui-progress-bar--indeterminate');
    } else {
        valueEl.textContent = '...';
        progressBar.style.width = '100%';
        progressBar.classList.add('comfyui-progress-bar--indeterminate');
    }
}

function gb(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

