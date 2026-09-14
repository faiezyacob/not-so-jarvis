/* ============================================
   JARVIS — Chat Model Switcher
   Header pill + popover for switching the active
   Ollama model without opening the full library.
   ============================================ */

const ModelSwitcher = (function () {
    let isOpen = false;
    let installedCache = null;
    let runningSet = new Set();
    let activeModel = '';
    let online = null;

    function baseName(name) {
        if (!name) return '';
        return String(name).split(':')[0].trim().toLowerCase();
    }

    function shortName(name) {
        return String(name || '').split(':')[0];
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        if (typeof HardwareCompat !== 'undefined' && HardwareCompat.formatBytes) {
            return HardwareCompat.formatBytes(bytes);
        }
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        return Math.round(bytes / (1024 * 1024)) + ' MB';
    }

    function currentModel() {
        try {
            if (typeof getChatModel === 'function') return getChatModel();
        } catch (e) {}
        return '';
    }

    function init() {
        const pill = document.getElementById('modelPill');
        const switcher = document.getElementById('modelSwitcher');
        const browse = document.getElementById('modelSwitcherBrowse');
        if (!pill || !switcher) return;

        pill.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isOpen) close(); else open();
        });

        if (browse) {
            browse.addEventListener('click', function () {
                close();
                if (typeof ModelLibrary !== 'undefined' && ModelLibrary.open) ModelLibrary.open();
            });
        }

        document.addEventListener('click', function (e) {
            if (!isOpen) return;
            const wrap = document.querySelector('.model-switcher-wrap');
            if (wrap && !wrap.contains(e.target)) close();
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isOpen) close();
        });

        window.addEventListener('jarvis-model-changed', function () {
            refreshLabel();
            if (isOpen) renderList();
        });

        refreshLabel();
    }

    function open() {
        isOpen = true;
        const pill = document.getElementById('modelPill');
        const switcher = document.getElementById('modelSwitcher');
        if (pill) pill.setAttribute('aria-expanded', 'true');
        if (switcher) {
            switcher.hidden = false;
            switcher.classList.add('open');
        }
        const list = document.getElementById('modelSwitcherList');
        if (list) list.innerHTML = '<div class="msw-loading">Loading models…</div>';
        loadData().then(renderList);
    }

    function close() {
        isOpen = false;
        const pill = document.getElementById('modelPill');
        const switcher = document.getElementById('modelSwitcher');
        if (pill) pill.setAttribute('aria-expanded', 'false');
        if (switcher) {
            switcher.hidden = true;
            switcher.classList.remove('open');
        }
    }

    async function loadData() {
        const results = await Promise.all([
            fetch('/api/ai/models').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
            fetch('/api/ollama/status').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        ]);
        const modelsData = results[0];
        const status = results[1];

        installedCache = [];
        if (modelsData) {
            (modelsData.models || []).forEach(function (m) {
                if (m.installed) installedCache.push(m);
            });
            (modelsData.extraInstalled || []).forEach(function (m) {
                installedCache.push({
                    id: m.id,
                    provider: m.provider || 'ollama',
                    sizeBytes: m.sizeBytes || 0
                });
            });
        }

        online = status ? Boolean(status.online) : null;
        runningSet = new Set();
        if (status && Array.isArray(status.running)) {
            status.running.forEach(function (r) { runningSet.add(baseName(r.name)); });
        }
        activeModel = (status && status.model) || currentModel() || '';

        refreshLabel();
    }

    function refreshLabel() {
        const nameEl = document.getElementById('modelPillName');
        const dotEl = document.getElementById('modelPillDot');
        const model = currentModel() || activeModel;

        if (nameEl) nameEl.textContent = model ? shortName(model) : 'No model';

        let state = 'unknown';
        if (online === false) state = 'offline';
        else if (model && runningSet.has(baseName(model))) state = 'loaded';
        else if (model) state = 'ready';
        if (dotEl) dotEl.className = 'model-pill-dot model-pill-dot--' + state;
    }

    function sortModels(list) {
        const activeBase = baseName(activeModel || currentModel());
        return list.slice().sort(function (a, b) {
            const aActive = baseName(a.id) === activeBase ? 0 : 1;
            const bActive = baseName(b.id) === activeBase ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            const aRun = runningSet.has(baseName(a.id)) ? 0 : 1;
            const bRun = runningSet.has(baseName(b.id)) ? 0 : 1;
            if (aRun !== bRun) return aRun - bRun;
            return String(a.id).localeCompare(String(b.id));
        });
    }

    function renderList() {
        const listEl = document.getElementById('modelSwitcherList');
        const subEl = document.getElementById('modelSwitcherSub');
        if (!listEl) return;

        const models = installedCache || [];
        const activeBase = baseName(activeModel || currentModel());

        if (subEl) {
            subEl.textContent = models.length + ' installed';
        }

        if (!models.length) {
            const msg = online === false
                ? 'Ollama is offline. Start it, or browse the library.'
                : 'No local models yet. Download one to get started.';
            listEl.innerHTML = '<div class="msw-empty">' + msg + '</div>';
            return;
        }

        listEl.innerHTML = '';
        sortModels(models).forEach(function (m) {
            const isActive = baseName(m.id) === activeBase;
            const isRunning = runningSet.has(baseName(m.id));

            const row = document.createElement('div');
            row.className = 'model-switcher-item' + (isActive ? ' is-active' : '');
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.setAttribute('data-id', m.id);
            row.setAttribute('data-provider', m.provider || 'ollama');

            const meta = [];
            if (m.sizeBytes) meta.push(formatSize(m.sizeBytes));
            if (isRunning) meta.push('In VRAM');
            if (isActive) meta.push('Active');

            row.innerHTML = '<span class="msw-check">✓</span>'
                + '<span class="msw-body">'
                + '<span class="msw-name">' + m.id + '</span>'
                + (meta.length ? '<span class="msw-meta">' + meta.join(' · ') + '</span>' : '')
                + '</span>'
                + (isRunning
                    ? '<button class="msw-unload" type="button" title="Unload from memory" data-unload="' + m.id + '">Unload</button>'
                    : '');

            row.addEventListener('click', function (e) {
                if (e.target.closest('.msw-unload')) return;
                selectModel(m.id, m.provider || 'ollama');
            });
            row.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectModel(m.id, m.provider || 'ollama');
                }
            });

            const unloadBtn = row.querySelector('.msw-unload');
            if (unloadBtn) {
                unloadBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    unloadModel(m.id, m.provider || 'ollama');
                });
            }

            listEl.appendChild(row);
        });
    }

    async function selectModel(modelId, provider) {
        try {
            await fetch('/api/ai/models/use', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: modelId, provider: provider || 'ollama' })
            });
        } catch (e) {}

        if (typeof setChatProvider === 'function') setChatProvider(provider || 'ollama');
        if (typeof setChatModel === 'function') setChatModel(modelId);

        const providerSelect = document.getElementById('chatProvider');
        const modelInput = document.getElementById('chatModel');
        if (providerSelect) providerSelect.value = provider || 'ollama';
        if (modelInput) {
            modelInput.value = modelId;
            modelInput.dispatchEvent(new Event('change'));
        }
        if (providerSelect) providerSelect.dispatchEvent(new Event('change'));

        activeModel = modelId;
        close();
        window.dispatchEvent(new CustomEvent('jarvis-model-changed', { detail: { model: modelId, provider: provider } }));
    }

    async function unloadModel(modelId, provider) {
        try {
            await fetch('/api/ai/models/unload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelId, provider: provider || 'ollama' })
            });
        } catch (e) {}
        runningSet.delete(baseName(modelId));
        renderList();
        refreshLabel();
    }

    return {
        init: init,
        open: open,
        close: close,
        refreshLabel: refreshLabel
    };
})();
