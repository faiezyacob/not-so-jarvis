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
const WIDGET_IDS = { cpu: 'cpuCard', ram: 'ramCard', vram: 'vramCard', weather: 'weatherCard', generated: 'generatedWidget', comfyui: 'comfyuiCard', ollama: 'ollamaCard', activity: 'activityCard' };

function loadWidgetSettings() {
    try {
        const saved = localStorage.getItem(WIDGET_SETTINGS_KEY);
        if (saved) return { comfyui: true, ollama: true, activity: true, ...JSON.parse(saved) };
    } catch {}
    return { cpu: true, ram: true, vram: true, weather: true, generated: true, comfyui: true, ollama: true, activity: true };
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

const SETTINGS_PANEL_KEY = 'jarvis-settings-panel';

const WIDGET_ORDER_KEY = 'jarvis-widget-order';
const DEFAULT_WIDGET_ORDER = ['cpuCard', 'ramCard', 'vramCard', 'weatherCard', 'generatedWidget', 'comfyuiCard', 'ollamaCard', 'activityCard'];

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
        if (card) monitor.appendChild(card);
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
    const modal = dropdown.querySelector('.settings-modal');
    const checkboxes = dropdown.querySelectorAll('input[type="checkbox"][data-widget]');
    const settings = loadWidgetSettings();

    checkboxes.forEach(cb => {
        const widget = cb.dataset.widget;
        cb.checked = settings[widget] !== false;
    });

    applyWidgetSettings(settings);

    const openSettings = () => {
        dropdown.classList.add('open');
        settingsBtn.classList.add('active');
        const search = document.getElementById('settingsSearch');
        if (search) { search.value = ''; applySettingsSearch(''); }
        if (search && window.matchMedia('(min-width: 700px)').matches) search.focus();
    };
    const closeSettings = () => {
        dropdown.classList.remove('open');
        settingsBtn.classList.remove('active');
    };

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains('open')) closeSettings();
        else openSettings();
    });

    const closeBtn = document.getElementById('settingsClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    const doneBtn = document.getElementById('settingsDone');
    if (doneBtn) doneBtn.addEventListener('click', closeSettings);
    dropdown.addEventListener('click', (e) => {
        if (e.target === dropdown) closeSettings();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !dropdown.classList.contains('open')) return;
        const search = document.getElementById('settingsSearch');
        if (search && search.value) {
            search.value = '';
            applySettingsSearch('');
            search.blur();
            return;
        }
        closeSettings();
    });

    checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            const s = loadWidgetSettings();
            s[cb.dataset.widget] = cb.checked;
            saveWidgetSettings(s);
            applyWidgetSettings(s);
        });
    });

    // Panel navigation (left sidebar)
    const navItems = dropdown.querySelectorAll('.settings-nav-item');
    const panels = dropdown.querySelectorAll('.settings-panel');
    const subtitle = document.getElementById('settingsPanelSubtitle');
    const selectPanel = (name, save) => {
        const search = document.getElementById('settingsSearch');
        if (search && search.value) {
            search.value = '';
            applySettingsSearch('');
        }
        navItems.forEach(i => i.classList.toggle('active', i.dataset.panel === name));
        panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
        const active = dropdown.querySelector('.settings-nav-item[data-panel="' + name + '"]');
        if (subtitle) subtitle.textContent = active ? active.textContent.charAt(0) + active.textContent.slice(1).toLowerCase() : name;
        if (modal) modal.scrollTop = 0;
        const panelsWrap = document.getElementById('settingsPanels');
        if (panelsWrap) panelsWrap.scrollTop = 0;
        if (save !== false) {
            try { localStorage.setItem(SETTINGS_PANEL_KEY, name); } catch {}
        }
    };
    navItems.forEach(item => {
        item.addEventListener('click', () => selectPanel(item.dataset.panel));
    });
    const gotoSystem = document.getElementById('gotoSystemBtn');
    if (gotoSystem) gotoSystem.addEventListener('click', () => selectPanel('system'));
    try {
        const savedPanel = localStorage.getItem(SETTINGS_PANEL_KEY);
        if (savedPanel && dropdown.querySelector('.settings-nav-item[data-panel="' + savedPanel + '"]')) {
            selectPanel(savedPanel, false);
        }
    } catch {}

    // Search filters cards/fields by data-search + visible text.
    const searchInput = document.getElementById('settingsSearch');
    if (searchInput) {
        searchInput.addEventListener('input', () => applySettingsSearch(searchInput.value));
    }

    // Mirror per-panel save statuses into the modal footer.
    ['imageSettingsStatus', 'upscaleSettingsStatus', 'videoSettingsStatus', 'loraStatus', 'videoLoraStatus'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        new MutationObserver(() => {
            const footer = document.getElementById('settingsFooterStatus');
            if (!footer) return;
            if (el.textContent) {
                footer.textContent = el.textContent;
                footer.classList.toggle('settings-save-status--error', el.classList.contains('settings-save-status--error'));
            }
        }).observe(el, { childList: true, characterData: true, subtree: true });
    });

    initChatProviderSettings();
    initImageGenSettings();
    initUpscaleSettings();
    initVideoSettings();
    initModelSetup();
    initEngineCards();
    initFreeComfyButton();
    initRestartServerButton();
}

// --- First-run setup guide (Settings > Setup) ---
//
// Status comes from GET /api/setup/status (ComfyUI paths, token state,
// per-model / per-node install flags, readiness, background job). Downloads
// and node installs run server-side; this polls for progress while a job is
// active and lights the nav dot while anything required is still missing.

let setupPollTimer = null;

function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    ));
}

function setSetupStatus(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('settings-save-status--error', !!isError);
}

async function fetchSetupStatus() {
    const res = await fetch('/api/setup/status');
    if (!res.ok) throw new Error('Setup status failed: HTTP ' + res.status);
    return res.json();
}

function renderSetupModels(data) {
    const list = document.getElementById('setupModels');
    if (!list) return;
    const groups = [['image', 'IMAGE'], ['video', 'VIDEO'], ['upscale', 'UPSCALE']];
    let html = '';
    for (const [key, title] of groups) {
        const items = (data.models || []).filter((m) => m.group === key);
        if (!items.length) continue;
        html += '<div class="setup-group-title">' + title + '</div>';
        for (const m of items) {
            const badge = m.installed
                ? '<span class="setup-badge setup-badge--ok">READY</span>'
                : '<span class="setup-badge setup-badge--missing">MISSING</span>';
            const sub = escHtml(m.filename || '(no file configured)') +
                ' · ' + escHtml(m.sizeLabel || '—') +
                (m.repo ? ' · <a href="' + escHtml(m.repoUrl || ('https://huggingface.co/' + m.repo)) + '" target="_blank" rel="noreferrer">' + escHtml(m.repo) + '</a>' : '') +
                (m.required ? '' : ' · optional') +
                (m.note ? '<br>' + escHtml(m.note) : '') +
                (!m.installed && !m.url && m.filename && !m.note ? '<br><span class="setup-warn">Unknown source for this filename — place it in ComfyUI models/' + escHtml(m.dest) + '/ by hand.</span>' : '');
            const btn = m.installed
                ? ''
                : (m.url ? '<button class="settings-browse-btn setup-row-btn" type="button" data-setup-download="' + escHtml(m.id) + '">Download</button>' : '');
            html += '<div class="setup-row">' + badge +
                '<div class="setup-row-main"><div class="setup-row-title">' + escHtml(m.label) + '</div>' +
                '<div class="setup-row-sub">' + sub + '</div></div>' + btn + '</div>';
        }
    }
    if (!data.comfyAvailable) {
        html = '<div class="setup-row"><span class="setup-badge setup-badge--missing">OFFLINE</span>' +
            '<div class="setup-row-main"><div class="setup-row-title">ComfyUI is unreachable</div>' +
            '<div class="setup-row-sub">Start ComfyUI, then press Re-check. Downloads land in its models/ folder.</div></div></div>' + html;
    }
    list.innerHTML = html;
    list.querySelectorAll('[data-setup-download]').forEach((btn) => {
        btn.addEventListener('click', () => setupDownload([btn.getAttribute('data-setup-download')]));
    });
    const sub = document.getElementById('setupModelsSub');
    if (sub) sub.textContent = data.modelRoot ? 'Checked against ' + data.modelRoot : "Checked against ComfyUI's models/ folder.";
}

function renderSetupNodes(data) {
    const list = document.getElementById('setupNodes');
    if (!list) return;
    let html = '';
    for (const n of (data.nodes || [])) {
        const badge = !data.comfyAvailable
            ? '<span class="setup-badge setup-badge--missing">UNKNOWN</span>'
            : (n.ready === true
                ? '<span class="setup-badge setup-badge--ok">READY</span>'
                : '<span class="setup-badge setup-badge--missing">MISSING</span>');
        const btn = (data.comfyAvailable && n.ready === false && n.installable)
            ? '<button class="settings-browse-btn setup-row-btn" type="button" data-setup-node="' + escHtml(n.id) + '">Install</button>'
            : '';
        html += '<div class="setup-row">' + badge +
            '<div class="setup-row-main"><div class="setup-row-title">' + escHtml(n.label) + '</div>' +
            '<div class="setup-row-sub">' + escHtml(n.nodes.join(', ')) +
            (n.missing && n.missing.length && data.comfyAvailable ? ' — <span class="setup-warn">missing: ' + escHtml(n.missing.join(', ')) + '</span>' : '') +
            (n.required ? '' : ' · optional') + (n.nvidiaOnly ? ' · NVIDIA GPU only' : '') +
            '<br>' + escHtml(n.note || '') + '</div></div>' + btn + '</div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('[data-setup-node]').forEach((btn) => {
        btn.addEventListener('click', () => setupInstallNodes([btn.getAttribute('data-setup-node')]));
    });
}

function renderSetupJob(data) {
    const job = (data && data.job) || {};
    const field = document.getElementById('setupProgressField');
    const bar = document.getElementById('setupProgressBar');
    const logEl = document.getElementById('setupJobLog');
    if (field) field.hidden = !(job.running || (job.done && job.log && job.log.length));
    if (bar) {
        const cur = job.current || {};
        const knownTotal = job.running && cur.total > 0;
        bar.classList.toggle('setup-progress-bar--indeterminate', job.running && !knownTotal);
        if (knownTotal) {
            bar.style.width = Math.max(0, Math.min(100, (cur.received / cur.total) * 100)).toFixed(1) + '%';
        } else if (job.running) {
            bar.style.width = '100%';
        } else if (job.done && job.ok) {
            bar.style.width = '100%';
        }
    }
    if (job.running) {
        const cur = job.current || {};
        const mb = (n) => (Number(n) > 0 ? (Number(n) / 1024 / 1024).toFixed(0) + ' MB' : '—');
        setSetupStatus('setupJobStatus', (job.kind === 'nodes' ? 'Installing nodes' : 'Downloading') +
            (cur.label ? ': ' + cur.label : '') +
            (cur.total > 0 ? ' (' + mb(cur.received) + ' / ' + mb(cur.total) + ')' : '') +
            ' — job ' + (job.finished || 0) + '/' + (job.total || 0));
    } else if (job.done) {
        setSetupStatus('setupJobStatus', job.ok ? 'Finished. Press Re-check to refresh.' : ('Failed: ' + (job.error || 'unknown error')), !job.ok);
    } else {
        setSetupStatus('setupJobStatus', '');
    }
    if (logEl) {
        if (job.log && job.log.length) {
            logEl.hidden = false;
            logEl.textContent = job.log.slice(-12).join('\n');
            logEl.scrollTop = logEl.scrollHeight;
        } else {
            logEl.hidden = true;
        }
    }
}

function renderSetupStatus(data) {
    renderSetupModels(data);
    renderSetupNodes(data);
    renderSetupJob(data);

    const tok = (data && data.token) || {};
    setSetupStatus('setupHfStatus', tok.configured
        ? 'Saved (' + tok.source + (tok.user ? ' as ' + tok.user : '') + ', ' + (tok.masked || '•••') + ').'
        : 'No token saved.', false);

    const ready = (data && data.ready) || {};
    const bits = [
        ['Image', ready.image], ['Video', ready.video],
        ['Upscale', ready.upscale], ['Edit', ready.edit]
    ];
    const readyEl = document.getElementById('setupReadyStatus');
    if (readyEl) {
        readyEl.textContent = bits.map(([name, ok]) => name + ' ' + (ok ? '✓' : '✗')).join(' · ');
        readyEl.classList.toggle('settings-save-status--error', bits.some(([, ok]) => !ok));
    }
    const dot = document.getElementById('setupNavDot');
    if (dot) {
        const incomplete = !data.comfyAvailable || bits.some(([, ok]) => !ok) ||
            (data.models || []).some((m) => m.required && !m.installed) ||
            (data.nodes || []).some((n) => n.required && n.ready === false);
        dot.hidden = !incomplete;
    }
}

function stopSetupPoll() {
    if (setupPollTimer) clearInterval(setupPollTimer);
    setupPollTimer = null;
}

function startSetupPoll() {
    stopSetupPoll();
    setupPollTimer = setInterval(async () => {
        try {
            const data = await fetchSetupStatus();
            renderSetupStatus(data);
            if (!data.job || !data.job.running) {
                stopSetupPoll();
                const refreshed = await fetchSetupStatus();
                renderSetupStatus(refreshed);
            }
        } catch {
            // Keep polling; ComfyUI or the server may be restarting.
        }
    }, 2500);
}

async function refreshSetup(message) {
    try {
        if (message) setSetupStatus('setupModelsStatus', message);
        const data = await fetchSetupStatus();
        renderSetupStatus(data);
        if (message) setSetupStatus('setupModelsStatus', '');
        if (data.job && data.job.running) startSetupPoll();
    } catch (err) {
        setSetupStatus('setupModelsStatus', 'Could not load setup status: ' + err.message, true);
    }
}

async function setupDownload(ids) {
    try {
        setSetupStatus('setupModelsStatus', 'Starting download…');
        const res = await fetch('/api/setup/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            setSetupStatus('setupModelsStatus', (data && data.reason === 'already running') ? 'A setup job is already running.' : ('Download failed: ' + ((data && data.error) || res.status)), true);
            return;
        }
        setSetupStatus('setupModelsStatus', '');
        startSetupPoll();
    } catch (err) {
        setSetupStatus('setupModelsStatus', 'Download failed: ' + err.message, true);
    }
}

async function setupInstallNodes(ids) {
    try {
        setSetupStatus('setupNodesStatus', 'Starting install…');
        const res = await fetch('/api/setup/install-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            setSetupStatus('setupNodesStatus', (data && data.reason === 'already running') ? 'A setup job is already running.' : ('Install failed: ' + ((data && data.error) || res.status)), true);
            return;
        }
        setSetupStatus('setupNodesStatus', '');
        startSetupPoll();
    } catch (err) {
        setSetupStatus('setupNodesStatus', 'Install failed: ' + err.message, true);
    }
}

function initModelSetup() {
    const saveBtn = document.getElementById('setupHfSave');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const input = document.getElementById('setupHfToken');
        const token = input ? String(input.value || '').trim() : '';
        if (!token) {
            setSetupStatus('setupHfStatus', 'Paste a token first (hf_…).', true);
            return;
        }
        setSetupStatus('setupHfStatus', 'Saving…');
        try {
            const res = await fetch('/api/setup/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                setSetupStatus('setupHfStatus', 'Save failed: ' + ((data && data.error) || res.status), true);
                return;
            }
            if (input) input.value = '';
            setSetupStatus('setupHfStatus', 'Saved' + (data.user ? ' as ' + data.user : '') +
                (data.warning ? '. Note: ' + data.warning : '.'), Boolean(data.warning && !data.valid));
        } catch (err) {
            setSetupStatus('setupHfStatus', 'Save failed: ' + err.message, true);
        }
    });
    const removeBtn = document.getElementById('setupHfRemove');
    if (removeBtn) removeBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/setup/token', { method: 'DELETE' });
            setSetupStatus('setupHfStatus', 'Token removed (env-provided tokens still apply).');
            refreshSetup();
        } catch (err) {
            setSetupStatus('setupHfStatus', 'Remove failed: ' + err.message, true);
        }
    });
    const missingBtn = document.getElementById('setupDownloadMissing');
    if (missingBtn) missingBtn.addEventListener('click', async () => {
        try {
            setSetupStatus('setupModelsStatus', 'Starting download…');
            const res = await fetch('/api/setup/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                setSetupStatus('setupModelsStatus', (data && data.reason === 'already running') ? 'A setup job is already running.' : ('Download failed: ' + ((data && data.error) || res.status)), true);
                return;
            }
            setSetupStatus('setupModelsStatus', '');
            startSetupPoll();
        } catch (err) {
            setSetupStatus('setupModelsStatus', 'Download failed: ' + err.message, true);
        }
    });
    const refreshBtn = document.getElementById('setupRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshSetup('Re-checking…'));
    const nodesBtn = document.getElementById('setupInstallNodes');
    if (nodesBtn) nodesBtn.addEventListener('click', async () => {
        try {
            const data = await fetchSetupStatus();
            const ids = (data.nodes || []).filter((n) => n.ready === false && n.installable).map((n) => n.id);
            if (!ids.length) {
                setSetupStatus('setupNodesStatus', 'Nothing installable is missing.');
                return;
            }
            setupInstallNodes(ids);
        } catch (err) {
            setSetupStatus('setupNodesStatus', 'Install failed: ' + err.message, true);
        }
    });
    refreshSetup();
}

function applySettingsSearch(query) {
    const q = (query || '').trim().toLowerCase();
    const dropdown = document.getElementById('settingsDropdown');
    if (!dropdown) return;
    const modal = dropdown.querySelector('.settings-modal');
    const subtitle = document.getElementById('settingsPanelSubtitle');
    const panels = dropdown.querySelectorAll('.settings-panel');
    if (!q) {
        if (modal) modal.classList.remove('searching');
        panels.forEach((panel) => {
            panel.style.display = '';
            panel.querySelectorAll('.settings-card').forEach((c) => { c.style.display = ''; });
            Array.prototype.forEach.call(panel.children, (child) => {
                if (child.classList && child.classList.contains('settings-field')) child.style.display = '';
            });
        });
        const active = dropdown.querySelector('.settings-nav-item.active');
        if (subtitle && active) subtitle.textContent = active.textContent.charAt(0) + active.textContent.slice(1).toLowerCase();
        return;
    }
    if (modal) modal.classList.add('searching');
    let total = 0;
    panels.forEach((panel) => {
        let visible = 0;
        panel.querySelectorAll('.settings-card').forEach((card) => {
            const hay = ((card.dataset.search || '') + ' ' + card.textContent).toLowerCase();
            const match = hay.indexOf(q) !== -1;
            card.style.display = match ? '' : 'none';
            if (match) {
                visible++;
                if (card.tagName === 'DETAILS' && !card.open) card.open = true;
            }
        });
        Array.prototype.forEach.call(panel.children, (child) => {
            if (child.classList && child.classList.contains('settings-field')) child.style.display = 'none';
        });
        panel.style.display = visible ? 'flex' : 'none';
        total += visible;
    });
    if (subtitle) subtitle.textContent = total === 1 ? '1 match' : total + ' matches';
    const wrap = document.getElementById('settingsPanels');
    if (wrap) wrap.scrollTop = 0;
}

function initEngineCards() {
    const select = document.getElementById('upscaleEngine');
    const cards = document.querySelectorAll('#upscaleEngineCards .engine-card');
    if (!select || !cards.length) return;
    const sync = () => {
        cards.forEach((c) => c.classList.toggle('active', c.dataset.engine === select.value));
    };
    cards.forEach((c) => {
        c.addEventListener('click', () => {
            select.value = c.dataset.engine;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            sync();
        });
    });
    select.addEventListener('change', sync);
    sync();
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
// lora_name entries). Each attached LoRA has an on/off/auto mode, a strength
// slider, and an optional trigger word. In AUTO the trigger word is the
// keyword that must appear in the prompt for the LoRA to apply. The stack is
// persisted as settings.loras[] and chained into the Krea2 workflow by the
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
        loras: [],          // [{ name, strength, mode, on, triggerWord }] current attached stack
        triggerMemory: {},  // { [loraName]: triggerWord } remembered even after removal
        available: [],      // lora filenames ComfyUI reports
        listEl: null,
        addSelect: null,
        statusEl: null,
        endpoint: o.endpoint || '/api/settings/image',  // where the stack is persisted
        autoEnabled: o.auto === true,  // image stacks expose the AUTO mode
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
    const mode = lora.mode || (lora.on === false ? 'off' : 'on');
    const row = document.createElement('div');
    row.className = 'lora-row'
        + (mode === 'off' ? ' lora-row--off' : '')
        + (mode === 'auto' ? ' lora-row--auto' : '');

    let modeControl;
    if (state.autoEnabled) {
        // Image-only three-state control: ON applies always, OFF never, AUTO
        // applies only when the keyword below appears in the prompt.
        modeControl = document.createElement('div');
        modeControl.className = 'lora-mode';
        modeControl.title = 'ON: always applied - OFF: never - AUTO: applied when the keyword appears in the prompt';
        [['on', 'ON'], ['off', 'OFF'], ['auto', 'AUTO']].forEach(([value, label]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.mode = value;
            btn.textContent = label;
            if (value === mode) btn.classList.add('is-active');
            btn.addEventListener('click', () => {
                lora.mode = value;
                lora.on = value === 'on';
                renderLoraStack(state);
                saveLoraStack(state);
            });
            modeControl.appendChild(btn);
        });
    } else {
        modeControl = document.createElement('input');
        modeControl.type = 'checkbox';
        modeControl.className = 'lora-row-toggle';
        modeControl.checked = mode !== 'off';
        modeControl.title = 'Toggle LoRA';
        modeControl.addEventListener('change', () => {
            const next = modeControl.checked ? 'on' : 'off';
            lora.mode = next;
            lora.on = next === 'on';
            saveLoraStack(state);
        });
    }

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
    triggerInput.placeholder = mode === 'auto' ? 'keyword' : 'trigger word';
    triggerInput.value = lora.triggerWord || '';
    triggerInput.title = mode === 'auto'
        ? 'Auto keyword: this LoRA is applied only when the word appears in the prompt (and is used as its trigger word)'
        : 'Trigger word prepended to prompt';
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

    row.appendChild(modeControl);
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
        const count = state.loras.filter(l => (l.mode || (l.on === false ? 'off' : 'on')) !== 'off').length;
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
            mode: 'on',
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

    const loraState = initLoraStack({ auto: true });
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

    // Seed lock + variation count: numeric/select settings that are persisted
    // the same way as the dropdowns above.
    const variationsSelect = document.getElementById('imageVariations');
    const seedModeSelect = document.getElementById('imageSeedMode');
    const seedInput = document.getElementById('imageSeed');
    const syncSeedDisabled = () => {
        if (seedInput) seedInput.disabled = !(seedModeSelect && seedModeSelect.value === 'fixed');
    };
    const persistValue = async (key, value, label) => {
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
            setStatus('Saved: ' + label);
        } catch {
            setStatus('Save failed: connection error', true);
        }
        setTimeout(() => setStatus(''), 3000);
    };
    if (variationsSelect) variationsSelect.addEventListener('change', () => persistValue('variations', Number(variationsSelect.value), variationsSelect.value));
    if (seedModeSelect) seedModeSelect.addEventListener('change', () => { syncSeedDisabled(); persistValue('seedMode', seedModeSelect.value, seedModeSelect.value); });
    if (seedInput) seedInput.addEventListener('change', () => persistValue('seed', Math.max(0, Math.floor(Number(seedInput.value) || 0)), seedInput.value));

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
                mode: (l.mode === 'on' || l.mode === 'off' || l.mode === 'auto')
                    ? l.mode
                    : (l.on === false ? 'off' : 'on'),
                on: l.on === true,
                triggerWord: (l.triggerWord !== undefined && l.triggerWord !== null)
                    ? String(l.triggerWord)
                    : (loraState.triggerMemory[l.name] || '')
            })) : [];
            renderLoraStack(loraState);

            // Restore the saved Aspect Ratio + Size (fall back to defaults).
            if (aspectSelect) aspectSelect.value = settings.aspectRatio || defaults.aspectRatio || '4:5';
            if (sizeSelect) sizeSelect.value = settings.imageSize || defaults.imageSize || 'M';

            // Restore seed lock + variations.
            if (variationsSelect) variationsSelect.value = String(settings.variations || defaults.variations || 1);
            if (seedModeSelect) seedModeSelect.value = settings.seedMode || defaults.seedMode || 'random';
            if (seedInput) {
                seedInput.value = (settings.seed !== undefined && settings.seed !== null)
                    ? settings.seed
                    : (defaults.seed || 0);
            }
            syncSeedDisabled();

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
            if (engineSel) engineSel.dispatchEvent(new Event('change', { bubbles: true }));
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

const VIDEO_FACEREFINE_SELECT_FIELDS = [
    { key: 'faceRefineDenoise', id: 'videoFaceRefineDenoise' },
    { key: 'faceRefineSteps', id: 'videoFaceRefineSteps' },
    { key: 'faceRefineCropFactor', id: 'videoFaceRefineCropFactor' },
    { key: 'faceRefineCanvasMode', id: 'videoFaceRefineCanvasMode' },
    { key: 'faceRefineSelect', id: 'videoFaceRefineSelect' }
];

let faceRefinePollTimer = null;

function faceRefineStatusEl() {
    return document.getElementById('videoFaceRefineStatus');
}

function faceRefineLogEl() {
    return document.getElementById('videoFaceRefineLog');
}

function setFaceRefineStatus(text, isError) {
    const el = faceRefineStatusEl();
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('settings-save-status--error', !!isError);
}

function renderFaceRefineStatus(data) {
    if (!data) {
        setFaceRefineStatus('Could not check FaceRefine status.', true);
        return;
    }
    const logEl = faceRefineLogEl();
    const job = data.job || {};
    if (Array.isArray(job.log) && job.log.length && logEl) {
        logEl.hidden = false;
        logEl.textContent = job.log.slice(-12).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
    } else if (logEl && !job.running) {
        logEl.hidden = true;
    }
    if (job.running) {
        setFaceRefineStatus('Installing FaceRefine... (restart ComfyUI when done)');
        scheduleFaceRefinePoll();
        return;
    }
    if (job.done && !job.ok && job.error) {
        setFaceRefineStatus('Install failed: ' + job.error, true);
        return;
    }
    if (job.done && job.ok && job.warn) {
        setFaceRefineStatus(job.warn, true);
        return;
    }
    if (!data.comfyAvailable) {
        setFaceRefineStatus('ComfyUI unreachable — FaceRefine status unknown.', true);
        return;
    }
    if (data.ready) {
        setFaceRefineStatus(
            'Ready' + (data.nativeAudioPresent ? ' (lipsync lock available).' : ' (no lipsync lock — audio passes through).')
        );
        return;
    }
    const missing = Array.isArray(data.nodesMissing) ? data.nodesMissing : [];
    if (data.restartRequired || (missing.length && data.packInstalled)) {
        setFaceRefineStatus('Installed — restart ComfyUI to load the nodes.', true);
        return;
    }
    const parts = [];
    if (missing.length) parts.push('nodes: ' + missing.join(', '));
    if (!data.vhsPresent) parts.push('VHS_LoadVideo');
    if (!data.detectorFound) parts.push('detector ' + (data.detectorName || 'face_yolov8m.pt'));
    setFaceRefineStatus(
        parts.length ? 'Missing: ' + parts.join('; ') + '. Press Install.' : 'FaceRefine not installed. Press Install.',
        true
    );
}

function scheduleFaceRefinePoll() {
    if (faceRefinePollTimer) return;
    faceRefinePollTimer = setTimeout(async () => {
        faceRefinePollTimer = null;
        try {
            const res = await fetch('/api/video/face-refine/status');
            const data = await res.json().catch(() => null);
            renderFaceRefineStatus(data);
            if (data && data.job && data.job.running) scheduleFaceRefinePoll();
        } catch {
            setFaceRefineStatus('Could not check FaceRefine status.', true);
        }
    }, 2500);
}

async function refreshFaceRefineStatus() {
    try {
        const res = await fetch('/api/video/face-refine/status');
        const data = await res.json().catch(() => null);
        renderFaceRefineStatus(data);
    } catch {
        setFaceRefineStatus('Could not check FaceRefine status.', true);
    }
}

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

    // --- FaceRefine: enable toggle, tuning selects, detector, installer ---
    const faceRefineToggle = document.getElementById('videoFaceRefineEnabled');
    if (faceRefineToggle) {
        faceRefineToggle.addEventListener('change', async () => {
            const enabled = faceRefineToggle.checked;
            setStatus(enabled ? 'Enabling FaceRefine...' : 'Saving...');
            try {
                const res = await fetch('/api/settings/video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ faceRefineEnabled: enabled })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setStatus('Save failed: ' + (data.error || 'Unknown error'), true);
                    faceRefineToggle.checked = !enabled;
                    return;
                }
                setStatus(enabled ? 'FaceRefine on — checking ComfyUI setup...' : 'FaceRefine off.');
                // First enable kicks off the background auto-install server-side.
                refreshFaceRefineStatus();
            } catch {
                setStatus('Save failed: connection error', true);
                faceRefineToggle.checked = !enabled;
            }
            setTimeout(() => setStatus(''), 3000);
        });
    }

    VIDEO_FACEREFINE_SELECT_FIELDS.forEach(({ key, id }) => {
        const select = document.getElementById(id);
        if (!select) return;
        select.addEventListener('change', () => persistSelect(key, select));
    });

    const faceRefineDetector = document.getElementById('videoFaceRefineDetector');
    if (faceRefineDetector) {
        faceRefineDetector.addEventListener('change', () => persistText('faceRefineDetector', faceRefineDetector));
        faceRefineDetector.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                faceRefineDetector.blur();
            }
        });
    }

    const faceRefineInstallBtn = document.getElementById('videoFaceRefineInstallBtn');
    if (faceRefineInstallBtn) {
        faceRefineInstallBtn.addEventListener('click', async () => {
            setFaceRefineStatus('Starting FaceRefine install...');
            try {
                const res = await fetch('/api/video/face-refine/install', { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setFaceRefineStatus('Install failed: ' + (data.error || 'Unknown error'), true);
                    return;
                }
                if (data.install && data.install.started === false) {
                    setFaceRefineStatus('Install already running — see log below.');
                } else {
                    setFaceRefineStatus('Installing FaceRefine... (restart ComfyUI when done)');
                }
                refreshFaceRefineStatus();
            } catch {
                setFaceRefineStatus('Install failed: connection error', true);
            }
        });
    }

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

            const faceRefineToggle = document.getElementById('videoFaceRefineEnabled');
            if (faceRefineToggle) {
                const stored = settings.faceRefineEnabled;
                faceRefineToggle.checked = stored === true || stored === 1 ||
                    String(stored).toLowerCase() === 'true' || String(stored) === '1' ||
                    (stored === undefined && defaults.faceRefineEnabled === true);
            }

            VIDEO_FACEREFINE_SELECT_FIELDS.forEach(({ key, id }) => {
                const select = document.getElementById(id);
                if (!select) return;
                const stored = settings[key];
                const fallback = (defaults[key] !== undefined && defaults[key] !== null) ? String(defaults[key]) : null;
                const wanted = (stored !== undefined && stored !== null && stored !== '') ? String(stored) : fallback;
                const hasOption = Array.from(select.options).some((o) => o.value === wanted);
                if (wanted !== null && hasOption) select.value = wanted;
            });

            const faceRefineDetector = document.getElementById('videoFaceRefineDetector');
            if (faceRefineDetector) {
                const stored = settings.faceRefineDetector;
                faceRefineDetector.value = (stored !== undefined && stored !== null && stored !== '') ? stored : '';
                faceRefineDetector.placeholder = defaults.faceRefineDetector || 'face_yolov8m.pt';
            }

            refreshFaceRefineStatus();

            const choices = data.choices || {};
            loraState.available = Array.isArray(choices.loras) ? choices.loras : [];
            loraState.triggerMemory = (settings.loraTriggerWords && typeof settings.loraTriggerWords === 'object')
                ? settings.loraTriggerWords
                : {};
            loraState.loras = Array.isArray(settings.loras) ? settings.loras.map((l) => ({
                name: l.name,
                strength: clampLoraStrength(l.strength),
                mode: (l.mode === 'on' || l.mode === 'off' || l.mode === 'auto')
                    ? l.mode
                    : (l.on === false ? 'off' : 'on'),
                on: l.on === true,
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
    initVoiceSettings();
    initChatPersonaSettings();
    initChatSamplingSettings();
}

// --- Chat Persona / System Prompt (Settings > Chat, persisted server-side) ---

const CHAT_PERSONA_PRESETS = {
    default: '',
    concise: 'Be concise. Prefer short bullet points and skip filler.',
    developer: 'You are a senior software engineer. Give precise, production-ready answers with code examples when relevant.',
    creative: 'You are a creative writing partner. Favor vivid, imaginative language and offer bold variations.',
    tutor: 'You are a patient study tutor. Explain step by step and check understanding with a short question at the end.',
    custom: null
};

function initChatPersonaSettings() {
    const personaSelect = document.getElementById('chatPersona');
    const promptInput = document.getElementById('chatSystemPrompt');
    const statusEl = document.getElementById('chatSettingsStatus');
    if (!personaSelect || !promptInput) return;

    const setStatus = (msg, isErr) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isErr ? '#e07a5f' : '';
        if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2500);
    };

    const save = async (patch) => {
        try {
            const res = await fetch('/api/settings/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setStatus('Saved');
            return data.settings || null;
        } catch (err) {
            setStatus(err.message, true);
            return null;
        }
    };

    // Load persisted values (new shape { settings } with legacy fallback).
    fetch('/api/settings/chat').then((res) => res.json()).then((data) => {
        const s = data.settings || data;
        if (s && typeof s.systemPrompt === 'string') promptInput.value = s.systemPrompt;
        if (s && typeof s.persona === 'string' && CHAT_PERSONA_PRESETS.hasOwnProperty(s.persona)) {
            personaSelect.value = s.persona;
        } else if (promptInput.value.trim()) {
            personaSelect.value = 'custom';
        }
    }).catch(() => {});

    personaSelect.addEventListener('change', async () => {
        const preset = personaSelect.value;
        if (preset !== 'custom' && CHAT_PERSONA_PRESETS.hasOwnProperty(preset)) {
            promptInput.value = CHAT_PERSONA_PRESETS[preset];
        }
        await save({ persona: preset, systemPrompt: promptInput.value });
    });

    let blurTimer = null;
    promptInput.addEventListener('input', () => {
        if (personaSelect.value !== 'custom' && promptInput.value !== (CHAT_PERSONA_PRESETS[personaSelect.value] || '')) {
            personaSelect.value = 'custom';
        }
        if (blurTimer) clearTimeout(blurTimer);
        blurTimer = setTimeout(async () => {
            await save({ persona: personaSelect.value, systemPrompt: promptInput.value });
        }, 800);
    });
    promptInput.addEventListener('blur', async () => {
        if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
        await save({ persona: personaSelect.value, systemPrompt: promptInput.value });
    });
}

// --- Chat Sampling: temperature / top_p (Settings > Chat) ---

function initChatSamplingSettings() {
    const tempInput = document.getElementById('chatTemperature');
    const topPInput = document.getElementById('chatTopP');
    const tempValue = document.getElementById('chatTemperatureValue');
    const topPValue = document.getElementById('chatTopPValue');
    const resetBtn = document.getElementById('chatSamplingReset');
    const statusEl = document.getElementById('chatSettingsStatus');
    if (!tempInput || !topPInput) return;

    const setStatus = (msg, isErr) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isErr ? '#e07a5f' : '';
        if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2500);
    };

    const paint = () => {
        if (tempValue) tempValue.textContent = tempInput.value === '' ? 'default' : Number(tempInput.value).toFixed(1);
        if (topPValue) topPValue.textContent = topPInput.value === '' ? 'default' : Number(topPInput.value).toFixed(2);
    };

    const save = async (patch) => {
        try {
            const res = await fetch('/api/settings/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Save failed');
            setStatus('Saved');
        } catch (err) {
            setStatus(err.message, true);
        }
    };

    // Sliders can't represent "blank = model default" natively, so an empty
    // value means default; any drag sets a number, reset clears back to blank.
    const applyLoaded = (s) => {
        if (s.temperature === null || s.temperature === undefined || s.temperature === '') {
            tempInput.value = '0.7';
            tempInput.dataset.default = 'true';
        } else {
            tempInput.value = String(s.temperature);
            delete tempInput.dataset.default;
        }
        if (s.topP === null || s.topP === undefined || s.topP === '') {
            topPInput.value = '0.9';
            topPInput.dataset.default = 'true';
        } else {
            topPInput.value = String(s.topP);
            delete topPInput.dataset.default;
        }
        paint();
        if (tempValue && tempInput.dataset.default) tempValue.textContent = 'default';
        if (topPValue && topPInput.dataset.default) topPValue.textContent = 'default';
    };

    fetch('/api/settings/chat').then((res) => res.json()).then((data) => {
        applyLoaded(data.settings || data);
    }).catch(() => paint());

    const onChange = () => {
        delete tempInput.dataset.default;
        delete topPInput.dataset.default;
        paint();
        save({ temperature: Number(tempInput.value), topP: Number(topPInput.value) });
    };
    tempInput.addEventListener('change', onChange);
    topPInput.addEventListener('change', onChange);
    tempInput.addEventListener('input', paint);
    topPInput.addEventListener('input', paint);

    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            await save({ temperature: null, topP: null });
            tempInput.dataset.default = 'true';
            topPInput.dataset.default = 'true';
            tempInput.value = '0.7';
            topPInput.value = '0.9';
            paint();
            if (tempValue) tempValue.textContent = 'default';
            if (topPValue) topPValue.textContent = 'default';
        });
    }
}

function initVoiceSettings() {
    const replyToggle = document.getElementById('voiceReplyToggle');
    const autoSendToggle = document.getElementById('voiceAutoSendToggle');
    const voiceSelect = document.getElementById('voiceSelect');
    const rateInput = document.getElementById('voiceRate');
    const rateValue = document.getElementById('voiceRateValue');

    if (replyToggle && window.VoiceOutput && typeof window.VoiceOutput.isEnabled === 'function') {
        replyToggle.checked = window.VoiceOutput.isEnabled();
        replyToggle.addEventListener('change', () => window.VoiceOutput.setEnabled(replyToggle.checked));
    }
    if (autoSendToggle && window.VoiceInput && typeof window.VoiceInput.isAutoSend === 'function') {
        autoSendToggle.checked = window.VoiceInput.isAutoSend();
        autoSendToggle.addEventListener('change', () => window.VoiceInput.setAutoSend(autoSendToggle.checked));
    }
    if (voiceSelect && window.VoiceOutput) {
        voiceSelect.value = window.VoiceOutput.getVoiceName ? window.VoiceOutput.getVoiceName() : '';
        voiceSelect.addEventListener('change', () => window.VoiceOutput.setVoiceName(voiceSelect.value));
    }
    if (rateInput && window.VoiceOutput) {
        const rate = window.VoiceOutput.getRate ? window.VoiceOutput.getRate() : 1;
        rateInput.value = String(rate);
        if (rateValue) rateValue.textContent = Number(rate).toFixed(1) + '×';
        rateInput.addEventListener('input', () => {
            const next = parseFloat(rateInput.value);
            window.VoiceOutput.setRate(next);
            if (rateValue) rateValue.textContent = Number(next).toFixed(1) + '×';
        });
    }
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
    initOllamaWidget();
    initActivityWidget();

    // Boot conversation + chat
    try {
        await DB.ready();
    } catch (e) {
        console.warn('IndexedDB unavailable, running without persistence:', e.message);
    }
    Chat.init();
    if (window.VoiceInput && typeof window.VoiceInput.init === 'function') window.VoiceInput.init();
    if (window.VoiceOutput && typeof window.VoiceOutput.init === 'function') window.VoiceOutput.init();
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
            reportWeatherLocation(weatherCoords.lat, weatherCoords.lon);
            fetchWeather();
            setInterval(fetchWeather, WEATHER_REFRESH_MS);
        },
        () => {
            setWeatherError('Unable to get user location');
        },
        { timeout: 10000 }
    );
}

// Report the browser's coordinates (and a label when known) to the server so
// the chat assistant can answer weather questions with live data.
function reportWeatherLocation(lat, lon, label) {
    try {
        fetch('/api/weather/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: lat, lon: lon, label: label || '' })
        }).catch(() => {});
    } catch (err) { /* ignore — best effort */ }
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
        reportWeatherLocation(weatherCoords.lat, weatherCoords.lon, data.timezone);
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

// --- Ollama Widget ---

const OLLAMA_REFRESH_MS = 5000;

function initOllamaWidget() {
    fetchOllamaStatus();
    setInterval(fetchOllamaStatus, OLLAMA_REFRESH_MS);
}

async function fetchOllamaStatus() {
    if (!document.getElementById('ollamaStatus')) return;
    try {
        const res = await fetch('/api/ollama/status');
        if (!res.ok) throw new Error('Fetch failed');
        renderOllamaStatus(await res.json());
    } catch {
        renderOllamaStatus({ online: false });
    }
}

function renderOllamaStatus(data) {
    const statusEl = document.getElementById('ollamaStatus');
    const modelEl = document.getElementById('ollamaModel');
    const detailEl = document.getElementById('ollamaDetail');
    if (!statusEl || !modelEl || !detailEl) return;

    if (!data || !data.online) {
        statusEl.textContent = 'Offline';
        statusEl.className = 'comfyui-status comfyui-status--offline';
        modelEl.textContent = 'Ollama not reachable';
        detailEl.textContent = 'Start Ollama to enable chat';
        return;
    }

    statusEl.textContent = 'Online';
    statusEl.className = 'comfyui-status comfyui-status--online';
    modelEl.textContent = data.model || 'No model selected';

    const running = Array.isArray(data.running) ? data.running : [];
    if (running.length > 0) {
        const names = running.map((r) => String(r.name || '').split(':')[0]).filter(Boolean);
        const vram = running.reduce((sum, r) => sum + (Number(r.vramBytes) || 0), 0);
        detailEl.textContent = names.join(', ') + (vram > 0 ? ' \u00B7 ' + gb(vram) + ' VRAM' : '');
    } else {
        const installed = Number(data.installed) || 0;
        detailEl.textContent = installed + ' installed \u00B7 none loaded';
    }
}

// --- Activity Widget ---

const ACTIVITY_REFRESH_MS = 5000;
const ACTIVITY_ICONS = {
    image: '\u25A3',
    edit: '\u270E',
    video: '\u25B6',
    upscale: '\u2B06',
    unload: '\u2B07',
    system: '\u25CF'
};

function initActivityWidget() {
    fetchActivity();
    setInterval(fetchActivity, ACTIVITY_REFRESH_MS);
}

async function fetchActivity() {
    if (!document.getElementById('activityList')) return;
    try {
        const res = await fetch('/api/activity');
        if (!res.ok) throw new Error('Fetch failed');
        const data = await res.json();
        renderActivity(data.entries || []);
    } catch {
        // Keep the last successful render.
    }
}

function renderActivity(entries) {
    const listEl = document.getElementById('activityList');
    if (!listEl) return;

    if (!entries.length) {
        listEl.innerHTML = '<div class="activity-empty">No recent activity.</div>';
        return;
    }

    listEl.innerHTML = '';
    entries.slice(0, 8).forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'activity-item activity-item--' + (entry.type || 'system');
        if (entry.detail) row.title = entry.detail;

        const icon = document.createElement('span');
        icon.className = 'activity-icon';
        icon.textContent = ACTIVITY_ICONS[entry.type] || ACTIVITY_ICONS.system;

        const body = document.createElement('div');
        body.className = 'activity-body';

        const top = document.createElement('div');
        top.className = 'activity-top';
        const title = document.createElement('span');
        title.className = 'activity-title';
        title.textContent = entry.title || 'Activity';
        const time = document.createElement('span');
        time.className = 'activity-time';
        time.textContent = relativeTime(entry.timestamp);
        top.appendChild(title);
        top.appendChild(time);

        body.appendChild(top);
        if (entry.detail) {
            const detail = document.createElement('div');
            detail.className = 'activity-detail';
            detail.textContent = entry.detail;
            body.appendChild(detail);
        }

        row.appendChild(icon);
        row.appendChild(body);

        if (entry.file && window.Gallery && typeof Gallery.openFromUrl === 'function') {
            row.classList.add('activity-item--clickable');
            row.addEventListener('click', () => Gallery.openFromUrl(entry.file));
        }
        listEl.appendChild(row);
    });
}

function relativeTime(iso) {
    let value = String(iso || '');
    // Timestamps written before the log kept a timezone are UTC without the
    // trailing Z; parse them as UTC so they don't read hours off.
    if (value && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) value += 'Z';
    const then = Date.parse(value);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
}

