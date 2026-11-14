/* ============================================
   JARVIS — Image Arena UI
   A dedicated benchmark workspace: one prompt,
   one background job per selected image model,
   live job states and a comparison gallery.
   Sessions live on the server, so closing the
   sheet never stops a generation.
   SPDX-License-Identifier: MIT
   ============================================ */

const ImageArenaUI = (() => {
    'use strict';

    const STORAGE_KEY = 'jarvis-image-arena';
    const ACTIVE_STATUSES = ['pending', 'queued', 'initializing', 'generating', 'saving'];
    const STATUS_LABELS = {
        pending: 'Pending',
        queued: 'Queued',
        initializing: 'Initializing',
        generating: 'Generating',
        saving: 'Saving',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };
    const SESSION_LABELS = {
        running: 'Running',
        completed: 'Completed',
        completed_with_errors: 'Completed with errors',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };

    let els = {};
    let models = [];
    let selected = new Set();
    let selectionInitialized = false;
    let mode = 'native';
    let sort = 'status';
    let session = null;
    let history = [];
    let compareSelection = new Set();
    let lastSessionId = null;
    let eventSource = null;
    let pollTimer = null;
    let viewerJob = null;
    let viewer = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
    let busy = false;
    let pendingSnapshot = null;
    let renderTimer = null;
    let lastResultsSignature = '';
    let lastSessionStatus = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function clear(node) {
        if (node) node.replaceChildren();
    }

    function fmtMs(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value) || value <= 0) return '—';
        if (value < 1000) return Math.round(value) + ' ms';
        if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 2 : 1) + ' s';
        const minutes = Math.floor(value / 60000);
        const seconds = Math.round((value % 60000) / 100) / 10;
        return minutes + 'm ' + seconds + 's';
    }

    function fmtDate(value) {
        if (!value) return '—';
        try {
            return new Date(value).toLocaleString();
        } catch (err) {
            return String(value);
        }
    }

    function slug(value) {
        return String(value || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    }

    function fileFromUrl(url) {
        try {
            return decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || '');
        } catch (err) {
            return String(url || '').split('/').pop() || '';
        }
    }

    function thumbUrl(url) {
        const file = fileFromUrl(url);
        return file ? '/generated/thumb/' + encodeURIComponent(file) : url;
    }

    function downloadUrl(url, filename) {
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || fileFromUrl(url) || 'arena-image.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function isSessionActive(target) {
        if (!target) return false;
        if (target.status === 'running') return true;
        return Array.isArray(target.jobs) && target.jobs.some((job) => ACTIVE_STATUSES.indexOf(job.status) !== -1);
    }

    function selectedModelIds() {
        return models.filter((model) => model.available && selected.has(model.id)).map((model) => model.id);
    }

    function setStatus(text, kind) {
        if (!els.status) return;
        els.status.textContent = text || '';
        els.status.dataset.kind = kind || '';
    }

    // --- Matched resolution --------------------------------------------------

    function matchingEnabled() {
        return Boolean(els.matchResolution && els.matchResolution.checked);
    }

    function selectedResolutionLimits() {
        return models
            .filter((model) => model.available && selected.has(model.id))
            .map((model) => model.resolutionLimits)
            .filter(Boolean);
    }

    function autoMatchMegapixels() {
        const limits = selectedResolutionLimits();
        if (!limits.length) return null;
        const floor = limits.reduce((value, limit) => Math.max(value, Number(limit.minMegapixels) || 0), 0);
        return floor > 0 ? floor : null;
    }

    function updateMatchNote() {
        if (!els.matchNote || !els.matchSize) return;
        const matched = matchingEnabled();
        els.matchNote.hidden = !matched;
        if (!matched) {
            els.matchNote.dataset.kind = '';
            els.matchNote.textContent = '';
            return;
        }
        const limits = selectedResolutionLimits();
        const auto = autoMatchMegapixels();
        const chosenSize = els.matchSize.value;
        const parts = [];
        if (chosenSize === 'auto') {
            parts.push(auto !== null
                ? 'Auto uses ' + auto + ' MP — the smallest canvas every selected engine supports.'
                : 'Select at least one engine to resolve the shared canvas.');
        } else if (chosenSize === 'custom') {
            parts.push('Every engine renders exactly the width × height you set, rounded to a 32 px grid.');
        } else {
            parts.push('Every engine renders the same ' + chosenSize + ' MP canvas at the chosen aspect ratio.');
        }
        const strict = limits.find((limit) => limit.strictMinimum);
        const chosen = chosenSize === 'auto' ? auto : Number(chosenSize);
        let warn = false;
        if (strict) {
            const floor = Number(strict.minMegapixels) || 0;
            const ceiling = Number(strict.maxMegapixels) || 0;
            if (Number.isFinite(chosen) && chosen > 0 && chosen < floor) {
                parts.push('A selected engine needs at least ' + floor + ' MP, so this size will be rejected.');
                warn = true;
            } else if (Number.isFinite(chosen) && ceiling && chosen > ceiling) {
                parts.push('A selected engine tops out at ' + ceiling + ' MP, so this size will be rejected.');
                warn = true;
            }
        }
        els.matchNote.dataset.kind = warn ? 'warn' : '';
        els.matchNote.textContent = parts.join(' ');
    }

    // --- Preferences ---------------------------------------------------------

    function loadPrefs() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (raw && Array.isArray(raw.selected)) selected = new Set(raw.selected.map(String));
            selectionInitialized = raw && raw.selectionInitialized === true;
            if (raw && raw.mode === 'controlled') mode = 'controlled';
            if (raw && typeof raw.sort === 'string' && ['status', 'model', 'time'].indexOf(raw.sort) !== -1) sort = raw.sort;
            if (raw && raw.settings && typeof raw.settings === 'object') {
                if (typeof raw.settings.aspectRatio === 'string') els.aspectRatio.value = raw.settings.aspectRatio;
                if (typeof raw.settings.imageSize === 'string') els.imageSize.value = raw.settings.imageSize;
                if (raw.settings.seed !== undefined && raw.settings.seed !== null) els.seed.value = String(raw.settings.seed);
                if (raw.settings.steps !== undefined && raw.settings.steps !== null) els.steps.value = String(raw.settings.steps);
                if (raw.settings.cfg !== undefined && raw.settings.cfg !== null) els.cfg.value = String(raw.settings.cfg);
                els.enhance.checked = raw.settings.allowPromptEnhancement === true;
                if (typeof raw.settings.matchSize === 'string' &&
                    Array.from(els.matchSize.options).some((option) => option.value === raw.settings.matchSize)) {
                    els.matchSize.value = raw.settings.matchSize;
                }
                if (raw.settings.matchResolution === true) els.matchResolution.checked = true;
                if (raw.settings.matchWidth) els.matchWidth.value = String(raw.settings.matchWidth);
                if (raw.settings.matchHeight) els.matchHeight.value = String(raw.settings.matchHeight);
            }
            if (raw && typeof raw.lastSessionId === 'string') lastSessionId = raw.lastSessionId;
        } catch (err) { /* corrupt preferences are ignored */ }
        els.mode.value = mode;
        els.sort.value = sort;
    }

    function savePrefs() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                selected: Array.from(selected),
                selectionInitialized: selectionInitialized,
                mode: mode,
                sort: sort,
                lastSessionId: lastSessionId,
                settings: {
                    aspectRatio: els.aspectRatio.value,
                    imageSize: els.imageSize.value,
                    seed: els.seed.value || null,
                    steps: els.steps.value || null,
                    cfg: els.cfg.value || null,
                    allowPromptEnhancement: els.enhance.checked,
                    matchResolution: matchingEnabled(),
                    matchSize: els.matchSize.value,
                    matchWidth: els.matchWidth.value || null,
                    matchHeight: els.matchHeight.value || null
                }
            }));
        } catch (err) { /* private mode / quota */ }
    }

    // --- Model discovery -----------------------------------------------------

    async function refreshModels(force) {
        const button = els.refreshModels;
        if (button) button.disabled = true;
        const container = els.models;
        if (!models.length) {
            clear(container);
            container.appendChild(el('div', 'arena-empty', 'Checking ComfyUI and the installed image models…'));
        }
        try {
            const res = await fetch('/api/benchmark/models' + (force ? '?refresh=1' : ''));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not discover image models.');
            models = Array.isArray(data.models) ? data.models : [];
            const availableIds = new Set(models.filter((model) => model.available).map((model) => model.id));
            if (!selectionInitialized) {
                selected = new Set(availableIds);
                selectionInitialized = true;
            } else {
                // Keep the user's persisted choices, but never leave a stale id
                // in the set when an engine is removed from the registry.
                selected = new Set(Array.from(selected).filter((id) => models.some((model) => model.id === id)));
            }
            savePrefs();
            renderModels();
        } catch (err) {
            clear(container);
            container.appendChild(el('div', 'arena-empty arena-empty--warn', err.message || 'Model discovery failed.'));
            setStatus('Could not reach the Image Arena API.', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    function renderModels() {
        const container = els.models;
        if (!container) return;
        clear(container);
        if (!models.length) {
            container.appendChild(el('div', 'arena-empty', 'No text-to-image engines are configured.'));
            updateCounts();
            return;
        }
        models.forEach((model) => {
            const row = el('div', 'arena-model' + (model.available ? '' : ' is-unavailable'));
            const checkWrap = el('label', 'arena-model-check');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = model.available && selected.has(model.id);
            checkbox.disabled = !model.available;
            checkbox.setAttribute('aria-label', 'Select ' + model.label);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selected.add(model.id);
                else selected.delete(model.id);
                savePrefs();
                updateCounts();
                renderModelRowState(row, model);
            });
            checkWrap.appendChild(checkbox);

            const main = el('div', 'arena-model-main');
            const title = el('div', 'arena-model-title');
            title.appendChild(el('strong', '', model.label));
            title.appendChild(el('span', 'arena-engine', model.engine + ' · ' + (model.locality || 'local')));
            main.appendChild(title);

            const meta = el('div', 'arena-model-meta');
            const native = model.native || {};
            const parts = [model.type || 'Text-to-image'];
            if (model.resolution && model.resolution.label) parts.push(model.resolution.label);
            if (model.resolutionLimits) {
                parts.push(model.resolutionLimits.minMegapixels + '–' + model.resolutionLimits.maxMegapixels + ' MP');
            }
            if (native.steps) parts.push(native.steps + ' steps');
            if (native.cfg !== null && native.cfg !== undefined) parts.push('cfg ' + native.cfg);
            if (native.sampler) parts.push(native.sampler + (native.scheduler ? ' / ' + native.scheduler : ''));
            meta.textContent = parts.join(' · ');
            main.appendChild(meta);
            if (!model.available && model.reason) {
                main.appendChild(el('div', 'arena-model-reason', model.reason));
            }

            const state = el('div', 'arena-model-state');
            row.appendChild(checkWrap);
            row.appendChild(main);
            row.appendChild(state);
            renderModelRowState(row, model);
            container.appendChild(row);
        });
        updateCounts();
    }

    function renderModelRowState(row, model) {
        const state = row.querySelector('.arena-model-state');
        if (!state) return;
        state.className = 'arena-model-state';
        if (!model.available) {
            state.classList.add('is-unavailable');
            state.textContent = 'Unavailable';
            row.classList.add('is-unavailable');
            return;
        }
        const chosen = selected.has(model.id);
        state.classList.add(chosen ? 'is-selected' : 'is-excluded');
        state.textContent = chosen ? 'Selected' : 'Excluded';
        row.classList.toggle('is-excluded', !chosen);
    }

    function updateCounts() {
        const count = selectedModelIds().length;
        if (els.selectedCount) els.selectedCount.textContent = count + (count === 1 ? ' model selected' : ' models selected');
        const active = session ? isSessionActive(session) : false;
        const disabled = busy || active || count === 0;
        if (els.generate) els.generate.disabled = disabled;
        if (els.generateFooter) els.generateFooter.disabled = disabled;
        updateMatchNote();
    }

    // --- Settings ------------------------------------------------------------

    function syncModeUi() {
        mode = els.mode.value === 'controlled' ? 'controlled' : 'native';
        const controlled = mode === 'controlled';
        const matched = matchingEnabled();
        els.aspectRatio.disabled = !controlled && !matched;
        els.imageSize.disabled = !controlled || matched;
        [els.seed, els.steps, els.cfg].forEach((input) => {
            if (input) input.disabled = !controlled;
        });
        if (els.matchRow) els.matchRow.hidden = !matched;
        if (els.matchSize) els.matchSize.disabled = !matched;
        const custom = matched && els.matchSize.value === 'custom';
        if (els.matchWidth) els.matchWidth.disabled = !custom;
        if (els.matchHeight) els.matchHeight.disabled = !custom;
        updateMatchNote();
        const summary = controlled ? 'Controlled — shared resolution and seed' : 'Native — model defaults';
        els.modeSummary.textContent = matched ? summary + ' · matched canvas' : summary;
        if (controlled) {
            els.modeNote.textContent = matched
                ? 'Controlled mode sends the same prompt, seed and one shared canvas to every model, plus the aspect ratio and any steps/CFG you supply.'
                : 'Controlled mode sends the same prompt, aspect ratio, size and seed (plus steps/CFG when supplied) to every model. Engines still apply their own required settings, and each engine\'s size ladder is different — turn on Match output resolution to force one canvas.';
        } else {
            els.modeNote.textContent = matched
                ? 'Native mode keeps each engine\'s own steps, CFG, sampler and prompt handling, but every job renders the matched canvas you choose above.'
                : 'Native mode runs each engine exactly as configured in Settings > Image. Aspect, size, seed, steps and CFG are used only in Controlled mode.';
        }
        savePrefs();
    }

    function readSettings() {
        const matched = matchingEnabled();
        const custom = matched && els.matchSize.value === 'custom';
        return {
            aspectRatio: els.aspectRatio.value,
            imageSize: els.imageSize.value,
            matchResolution: matched,
            matchSize: els.matchSize.value,
            width: custom && els.matchWidth.value !== '' ? Number(els.matchWidth.value) : null,
            height: custom && els.matchHeight.value !== '' ? Number(els.matchHeight.value) : null,
            seedMode: els.seed.value ? 'fixed' : 'random',
            seed: els.seed.value === '' ? null : Number(els.seed.value),
            steps: els.steps.value === '' ? null : Number(els.steps.value),
            cfg: els.cfg.value === '' ? null : Number(els.cfg.value),
            allowPromptEnhancement: els.enhance.checked === true
        };
    }

    // --- Session rendering ---------------------------------------------------

    // ComfyUI progress can tick many times per second. Coalesce snapshots so a
    // long sampler never forces the whole gallery to re-render on every step.
    function scheduleRender(next) {
        pendingSnapshot = next;
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            const snapshot = pendingSnapshot;
            pendingSnapshot = null;
            if (snapshot) renderSession(snapshot);
        }, 120);
    }

    function renderSession(next) {
        session = next || null;
        compareSelection = new Set(Array.from(compareSelection).filter((id) => {
            return session && session.jobs.some((job) => job.id === id && job.status === 'completed');
        }));
        if (!session) {
            els.session.hidden = true;
            lastSessionStatus = null;
            updateCounts();
            updateSelectionBar();
            return;
        }
        els.session.hidden = false;
        if (lastSessionId !== session.id) {
            lastSessionId = session.id;
            savePrefs();
        }
        renderSessionMeta();
        renderJobs();
        const signature = resultsSignature(session);
        if (signature !== lastResultsSignature) {
            lastResultsSignature = signature;
            renderResults();
        }
        updateCounts();
        const active = isSessionActive(session);
        if (!active && lastSessionStatus === 'running') {
            loadHistory();
            const counts = session.counts || {};
            const ready = (counts.completed || 0) + ' of ' + (counts.total || 0) + ' images ready';
            setStatus(ready + (counts.failed ? ' · ' + counts.failed + ' failed' : ''), counts.failed ? 'warn' : 'ok');
        }
        lastSessionStatus = session.status;
        if (!active && eventSource) stopWatch();
    }

    function resultsSignature(target) {
        if (!target) return '';
        const parts = target.jobs.map((job) => [
            job.id,
            job.status,
            job.favorite ? '1' : '0',
            job.result && job.result.url ? job.result.url : '',
            job.error && job.error.message ? job.error.message : ''
        ].join(':'));
        return String(target.id || '') + '|' + sort + '|' + parts.join('|');
    }

    function renderSessionMeta() {
        const stamp = els.sessionStamp;
        stamp.className = 'arena-session-stamp';
        const status = session.status || 'running';
        if (status === 'running') stamp.classList.add('is-live');
        else if (status === 'completed') stamp.classList.add('is-done');
        else if (status === 'completed_with_errors' || status === 'failed') stamp.classList.add('is-warn');
        else stamp.classList.add('is-muted');
        stamp.textContent = SESSION_LABELS[status] || status;

        const meta = els.sessionMeta;
        clear(meta);
        const counts = session.counts || {};
        const info = el('div', 'arena-session-facts');
        info.appendChild(fact('Mode', session.mode === 'controlled' ? 'Controlled' : 'Native'));
        info.appendChild(fact('Models', String(counts.total || 0)));
        info.appendChild(fact('Completed', String(counts.completed || 0)));
        info.appendChild(fact('Failed', String(counts.failed || 0)));
        info.appendChild(fact('Created', fmtDate(session.createdAt)));
        const matched = session.standardization && session.standardization.matchedResolution;
        if (matched) info.appendChild(fact('Canvas', matched.label + ' · matched'));
        if (session.settings && session.settings.seedUsed !== null && session.settings.seedUsed !== undefined) {
            info.appendChild(fact('Seed', String(session.settings.seedUsed)));
        }
        meta.appendChild(info);

        const prompt = el('div', 'arena-session-prompt');
        prompt.textContent = session.prompt;
        meta.appendChild(prompt);

        if (isSessionActive(session)) {
            const cancel = el('button', 'arena-btn arena-cancel', 'Cancel benchmark');
            cancel.type = 'button';
            cancel.addEventListener('click', cancelSession);
            meta.appendChild(cancel);
        }

        const notes = session.standardization;
        if (notes && notes.mode === 'controlled' && notes.notes && notes.notes.length) {
            const list = el('div', 'arena-standardization');
            list.appendChild(el('span', 'arena-note-label', 'Could not be standardized:'));
            notes.notes.forEach((note) => list.appendChild(el('span', 'arena-note-item', note)));
            meta.appendChild(list);
        }
    }

    function fact(label, value) {
        const node = el('div', 'arena-fact');
        node.appendChild(el('span', 'arena-fact-label', label));
        node.appendChild(el('span', 'arena-fact-value', value));
        return node;
    }

    function progressFor(job) {
        if (!job.progress || !Number.isFinite(job.progress.value) || !Number.isFinite(job.progress.max) || job.progress.max <= 0) {
            return null;
        }
        return Math.max(0, Math.min(100, Math.round((job.progress.value / job.progress.max) * 100)));
    }

    function jobStateText(job) {
        if (job.status === 'queued') {
            return job.queuePosition ? 'Queued · position ' + job.queuePosition : 'Queued';
        }
        if (job.status === 'generating') {
            const pct = progressFor(job);
            return pct === null ? 'Generating' : 'Generating · ' + pct + '%';
        }
        if (job.status === 'completed') return 'Completed';
        if (job.status === 'failed') return 'Failed';
        if (job.status === 'cancelled') return 'Cancelled';
        return STATUS_LABELS[job.status] || job.status;
    }

    function renderJobs() {
        const container = els.jobs;
        clear(container);
        if (!session.jobs.length) {
            container.appendChild(el('div', 'arena-empty', 'No jobs in this benchmark.'));
            return;
        }
        session.jobs.forEach((job) => {
            const row = el('div', 'arena-job is-' + job.status);
            const dot = el('span', 'arena-job-dot');
            const main = el('div', 'arena-job-main');
            const title = el('div', 'arena-job-title');
            title.appendChild(el('strong', '', job.modelLabel));
            title.appendChild(el('span', 'arena-job-state', jobStateText(job)));
            main.appendChild(title);

            const pct = progressFor(job);
            const bar = el('div', 'arena-job-bar');
            if (job.status === 'generating' && pct === null) bar.classList.add('is-indeterminate');
            const fill = el('i', 'arena-job-fill');
            if (pct !== null) fill.style.width = pct + '%';
            bar.appendChild(fill);
            main.appendChild(bar);

            if (job.status === 'failed' && job.error) {
                main.appendChild(el('div', 'arena-job-error', job.error.message || 'Generation failed.'));
            }

            const right = el('div', 'arena-job-right');
            right.appendChild(el('span', 'arena-job-time', job.status === 'completed' ? fmtMs(job.durationMs) : fmtMs(
                job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0
            )));
            if (job.status === 'failed' || job.status === 'cancelled') {
                const retry = el('button', 'arena-link', 'Retry');
                retry.type = 'button';
                retry.addEventListener('click', () => retryJob(job.id));
                right.appendChild(retry);
            }
            row.appendChild(dot);
            row.appendChild(main);
            row.appendChild(right);
            container.appendChild(row);
        });
    }

    function sortedJobs() {
        const jobs = session && Array.isArray(session.jobs) ? session.jobs.slice() : [];
        const statusRank = { completed: 0, generating: 1, saving: 2, initializing: 3, queued: 4, pending: 5, failed: 6, cancelled: 7 };
        if (sort === 'model') {
            jobs.sort((a, b) => String(a.modelLabel).localeCompare(String(b.modelLabel)));
        } else if (sort === 'time') {
            const time = (job) => {
                const value = job.result && job.result.generationMs ? job.result.generationMs : job.durationMs;
                return Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
            };
            jobs.sort((a, b) => time(a) - time(b));
        } else {
            jobs.sort((a, b) => (statusRank[a.status] === undefined ? 99 : statusRank[a.status]) -
                (statusRank[b.status] === undefined ? 99 : statusRank[b.status]));
        }
        return jobs;
    }

    function renderResults() {
        const container = els.results;
        clear(container);
        if (!session || !session.jobs.length) {
            container.appendChild(el('div', 'arena-empty', 'Results appear here as each model finishes.'));
            updateSelectionBar();
            return;
        }
        const jobs = sortedJobs();
        const hasResult = jobs.some((job) => job.status === 'completed');
        jobs.forEach((job) => {
            if (job.status === 'completed' && job.result && job.result.url) {
                container.appendChild(completedCard(job));
            } else if (job.status === 'failed' || job.status === 'cancelled') {
                container.appendChild(failedCard(job));
            }
        });
        if (!hasResult && !jobs.some((job) => job.status === 'failed' || job.status === 'cancelled')) {
            container.appendChild(el('div', 'arena-empty', 'Results appear here as each model finishes.'));
        }
        els.downloadAll.disabled = !hasResult;
        updateSelectionBar();
    }

    function completedCard(job) {
        const card = el('article', 'arena-result');
        const selectWrap = el('label', 'arena-result-select');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = compareSelection.has(job.id);
        checkbox.setAttribute('aria-label', 'Select ' + job.modelLabel + ' for comparison');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) compareSelection.add(job.id);
            else compareSelection.delete(job.id);
            updateSelectionBar();
        });
        selectWrap.appendChild(checkbox);
        selectWrap.appendChild(el('span', '', 'Compare'));
        card.appendChild(selectWrap);

        const thumb = el('button', 'arena-result-thumb');
        thumb.type = 'button';
        thumb.setAttribute('aria-label', 'Open ' + job.modelLabel + ' result');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = job.modelLabel + ' result';
        img.src = thumbUrl(job.result.url);
        img.addEventListener('error', () => { if (img.src.indexOf('/thumb/') !== -1) img.src = job.result.url; });
        thumb.appendChild(img);
        thumb.addEventListener('click', () => openViewer(job));
        card.appendChild(thumb);

        const head = el('div', 'arena-result-head');
        head.appendChild(el('strong', '', job.modelLabel));
        const fav = el('button', 'arena-fav' + (job.favorite ? ' is-on' : ''), job.favorite ? 'Saved' : 'Save');
        fav.type = 'button';
        fav.title = job.favorite ? 'Remove favourite' : 'Favourite image';
        fav.setAttribute('aria-pressed', job.favorite ? 'true' : 'false');
        fav.addEventListener('click', () => toggleFavorite(job));
        head.appendChild(fav);
        card.appendChild(head);

        const meta = el('dl', 'arena-result-meta');
        const add = (label, value) => {
            if (value === null || value === undefined || value === '') return;
            const row = el('div', 'arena-meta-row');
            row.appendChild(el('dt', '', label));
            row.appendChild(el('dd', '', String(value)));
            meta.appendChild(row);
        };
        add('Time', fmtMs(job.result.generationMs));
        add('Resolution', job.result.width + '×' + job.result.height);
        add('Seed', job.result.seed);
        add('Steps', job.config && job.config.steps);
        add('Sampler', job.config && job.config.sampler ? job.config.sampler + (job.config.scheduler ? ' / ' + job.config.scheduler : '') : null);
        add('Status', STATUS_LABELS[job.status] || job.status);
        card.appendChild(meta);

        const actions = el('div', 'arena-result-actions');
        actions.appendChild(actionButton('Settings', () => toggleSettings(card, job)));
        actions.appendChild(actionButton('Copy prompt', () => copyPrompt(job)));
        actions.appendChild(actionButton('Download', () => downloadJob(job)));
        card.appendChild(actions);

        if (job.effectivePromptReason) {
            card.appendChild(el('div', 'arena-prompt-delta', job.effectivePromptReason));
        }
        return card;
    }

    function failedCard(job) {
        const card = el('article', 'arena-result arena-result--failed');
        const head = el('div', 'arena-result-head');
        head.appendChild(el('strong', '', job.modelLabel));
        head.appendChild(el('span', 'arena-result-state', STATUS_LABELS[job.status] || job.status));
        card.appendChild(head);
        card.appendChild(el('p', 'arena-result-error', (job.error && job.error.message) || 'This generation did not complete.'));
        const actions = el('div', 'arena-result-actions');
        actions.appendChild(actionButton('Retry', () => retryJob(job.id)));
        if (job.error && job.error.code) actions.appendChild(el('span', 'arena-note-item', job.error.code));
        card.appendChild(actions);
        return card;
    }

    function actionButton(label, handler) {
        const button = el('button', 'arena-action', label);
        button.type = 'button';
        button.addEventListener('click', handler);
        return button;
    }

    function toggleSettings(card, job) {
        const existing = card.querySelector('.arena-job-settings');
        if (existing) {
            existing.remove();
            return;
        }
        const box = el('pre', 'arena-job-settings');
        box.textContent = JSON.stringify({
            model: job.modelId,
            engineConfig: job.engineConfig,
            config: job.config,
            effectivePrompt: job.effectivePrompt || job.prompt,
            error: job.error || null
        }, null, 2);
        card.appendChild(box);
    }

    function updateSelectionBar() {
        const count = compareSelection.size;
        if (els.selectionBar) els.selectionBar.hidden = count === 0;
        if (els.selectionText) els.selectionText.textContent = count + (count === 1 ? ' image selected' : ' images selected');
        if (els.compare) els.compare.disabled = compareJobs('selected').length < 2;
        if (els.compareAll) els.compareAll.disabled = compareJobs('all').length < 2;
    }

    // --- Action handlers -----------------------------------------------------

    async function generateAll() {
        if (busy) return;
        if (session && isSessionActive(session)) {
            if (window.Dialog) await Dialog.alert('A benchmark is already running. Cancel it or wait for it to finish before starting another.');
            return;
        }
        const prompt = els.prompt.value.trim();
        if (!prompt) {
            if (window.Dialog) await Dialog.alert('Enter a prompt first.');
            els.prompt.focus();
            return;
        }
        const chosen = selectedModelIds();
        if (!chosen.length) {
            if (window.Dialog) await Dialog.alert('Select at least one ready model.');
            return;
        }
        busy = true;
        updateCounts();
        setStatus('Creating ' + chosen.length + ' jobs…', 'busy');
        compareSelection = new Set();
        try {
            const res = await fetch('/api/benchmark', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt,
                    models: chosen,
                    mode: mode,
                    settings: readSettings()
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not start the benchmark.');
            renderSession(data.session);
            setStatus('Benchmark queued — ' + chosen.length + (chosen.length === 1 ? ' job' : ' jobs') +
                '. You can close this sheet; generation continues.', 'ok');
            startWatch(data.session.id);
            loadHistory();
        } catch (err) {
            setStatus(err.message || 'Could not start the benchmark.', 'error');
            if (window.Dialog) await Dialog.alert(err.message || 'Could not start the benchmark.');
        } finally {
            busy = false;
            updateCounts();
        }
    }

    async function cancelSession() {
        if (!session) return;
        if (window.Dialog && !(await Dialog.confirm('Cancel this benchmark? Pending jobs are removed and the active generation is interrupted.'))) return;
        setStatus('Cancelling…', 'busy');
        try {
            const res = await fetch('/api/benchmark/' + encodeURIComponent(session.id) + '/cancel', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not cancel the benchmark.');
            renderSession(data.session);
            setStatus('Benchmark cancelled.', 'warn');
        } catch (err) {
            setStatus(err.message || 'Could not cancel the benchmark.', 'error');
        }
    }

    async function retryJob(jobId) {
        if (!session) return;
        setStatus('Retrying job…', 'busy');
        try {
            const res = await fetch('/api/benchmark/' + encodeURIComponent(session.id) + '/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: jobId })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not retry this job.');
            renderSession(data.session);
            setStatus('Retry queued.', 'ok');
            startWatch(data.session.id);
            loadHistory();
        } catch (err) {
            setStatus(err.message || 'Could not retry this job.', 'error');
            if (window.Dialog) await Dialog.alert(err.message || 'Could not retry this job.');
        }
    }

    async function toggleFavorite(job) {
        if (!session) return;
        try {
            const res = await fetch('/api/benchmark/' + encodeURIComponent(session.id) + '/favorite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: job.id, favorite: !job.favorite })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not update the favourite.');
            renderSession(data.session);
        } catch (err) {
            setStatus(err.message || 'Could not update the favourite.', 'error');
        }
    }

    function copyPrompt(job) {
        const text = job.effectivePrompt || (session && session.prompt) || '';
        const done = () => setStatus('Prompt copied.', 'ok');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else {
            fallbackCopy(text, done);
        }
    }

    function fallbackCopy(text, done) {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (err) { setStatus('Copy failed.', 'error'); }
        area.remove();
    }

    function downloadJob(job) {
        if (!job.result || !job.result.url) return;
        const ext = (job.result.filename || '').split('.').pop() || 'png';
        downloadUrl(job.result.url, 'arena-' + slug(job.modelLabel) + '-' + (job.result.seed || 'seed') + '.' + ext);
    }

    async function downloadAll() {
        if (!session) return;
        const jobs = session.jobs.filter((job) => job.status === 'completed' && job.result && job.result.url);
        for (let i = 0; i < jobs.length; i += 1) {
            downloadJob(jobs[i]);
            await new Promise((resolve) => setTimeout(resolve, 220));
        }
        setStatus('Downloaded ' + jobs.length + ' image' + (jobs.length === 1 ? '' : 's') + '.', 'ok');
    }

    // --- Live updates --------------------------------------------------------

    function stopWatch() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (renderTimer) {
            clearTimeout(renderTimer);
            renderTimer = null;
        }
        pendingSnapshot = null;
    }

    function startWatch(sessionId) {
        stopWatch();
        if (!sessionId) return;
        if (typeof EventSource === 'function') {
            try {
                eventSource = new EventSource('/api/benchmark/' + encodeURIComponent(sessionId) + '/events');
                eventSource.addEventListener('snapshot', (event) => {
                    try {
                        const payload = JSON.parse(event.data);
                        if (payload.deleted) {
                            stopWatch();
                            if (session && session.id === sessionId) {
                                session = null;
                                els.session.hidden = true;
                                updateCounts();
                            }
                            return;
                        }
                        if (payload.session && (!session || payload.session.id === session.id)) {
                            scheduleRender(payload.session);
                        }
                    } catch (err) { /* ignore malformed event */ }
                });
                eventSource.onerror = () => {
                    // EventSource retries by itself; add a polling fallback so a
                    // dropped stream still updates the sheet.
                    if (!pollTimer) startPollingFallback(sessionId);
                };
                return;
            } catch (err) {
                eventSource = null;
            }
        }
        startPollingFallback(sessionId);
    }

    function startPollingFallback(sessionId) {
        if (pollTimer) return;
        pollTimer = setInterval(async () => {
            try {
                const res = await fetch('/api/benchmark/' + encodeURIComponent(sessionId), { cache: 'no-store' });
                if (res.status === 404) { stopWatch(); return; }
                const data = await res.json();
                if (!res.ok || !data.session) return;
                scheduleRender(data.session);
                if (!isSessionActive(data.session)) stopWatch();
            } catch (err) { /* keep trying while the sheet is open */ }
        }, 1500);
    }

    // --- History -------------------------------------------------------------

    async function loadHistory() {
        try {
            const res = await fetch('/api/benchmark/history?limit=40', { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not load benchmark history.');
            history = Array.isArray(data.sessions) ? data.sessions : [];
            renderHistory();
        } catch (err) {
            if (els.history) {
                clear(els.history);
                els.history.appendChild(el('div', 'arena-empty arena-empty--warn', err.message || 'Could not load benchmark history.'));
            }
        }
    }

    function renderHistory() {
        const container = els.history;
        if (!container) return;
        clear(container);
        if (!history.length) {
            container.appendChild(el('div', 'arena-empty', 'No benchmarks yet.'));
            return;
        }
        history.forEach((entry) => {
            const row = el('div', 'arena-history-row' + (session && session.id === entry.id ? ' is-current' : ''));
            if (entry.thumbnail) {
                const img = document.createElement('img');
                img.className = 'arena-history-thumb';
                img.loading = 'lazy';
                img.alt = '';
                img.src = thumbUrl(entry.thumbnail);
                img.addEventListener('error', () => { if (img.src.indexOf('/thumb/') !== -1) img.src = entry.thumbnail; });
                row.appendChild(img);
            } else {
                row.appendChild(el('div', 'arena-history-thumb arena-history-thumb--empty', '—'));
            }
            const main = el('div', 'arena-history-main');
            main.appendChild(el('div', 'arena-history-prompt', entry.prompt || 'Untitled benchmark'));
            const meta = [entry.mode === 'controlled' ? 'Controlled' : 'Native',
                entry.completed + '/' + entry.total + ' completed'];
            if (entry.failed) meta.push(entry.failed + ' failed');
            meta.push(fmtDate(entry.createdAt));
            main.appendChild(el('div', 'arena-history-meta', meta.join(' · ')));
            row.appendChild(main);

            const stamp = el('span', 'arena-history-state is-' + entry.status, SESSION_LABELS[entry.status] || entry.status);
            row.appendChild(stamp);

            const actions = el('div', 'arena-history-actions');
            const openBtn = actionButton('Open', () => openSession(entry.id));
            actions.appendChild(openBtn);
            const del = actionButton('Delete', () => deleteSession(entry.id));
            del.classList.add('arena-action--danger');
            actions.appendChild(del);
            row.appendChild(actions);
            container.appendChild(row);
        });
    }

    // Opening a past benchmark restores the exact prompt it ran, so the user can
    // re-run, tweak or compare it against another model set without retyping.
    function restoreSessionPrompt(target, options) {
        if (!els.prompt || !target || typeof target.prompt !== 'string') return;
        if (!target.prompt.trim()) return;
        if (options && options.onlyIfEmpty && els.prompt.value.trim()) return;
        if (els.prompt.value === target.prompt) return;
        els.prompt.value = target.prompt;
    }

    async function openSession(id) {
        try {
            const res = await fetch('/api/benchmark/' + encodeURIComponent(id), { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok || !data.session) throw new Error(data.error || 'Benchmark not found.');
            renderSession(data.session);
            restoreSessionPrompt(data.session);
            if (isSessionActive(data.session)) startWatch(data.session.id);
            else stopWatch();
            els.session.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            setStatus(err.message || 'Could not open that benchmark.', 'error');
        }
    }

    async function deleteSession(id) {
        if (window.Dialog && !(await Dialog.confirm('Delete this benchmark session and its generated images? This cannot be undone.'))) return;
        try {
            const res = await fetch('/api/benchmark/' + encodeURIComponent(id), { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not delete the benchmark.');
            if (session && session.id === id) {
                stopWatch();
                session = null;
                compareSelection = new Set();
                els.session.hidden = true;
                if (lastSessionId === id) lastSessionId = null;
                savePrefs();
            }
            setStatus('Benchmark deleted.', 'ok');
            loadHistory();
        } catch (err) {
            setStatus(err.message || 'Could not delete the benchmark.', 'error');
            if (window.Dialog) await Dialog.alert(err.message || 'Could not delete the benchmark.');
        }
    }

    // --- Viewer & comparison -------------------------------------------------

    function applyViewerTransform() {
        const img = els.viewerImage;
        if (!img) return;
        img.style.transform = 'translate(' + viewer.x + 'px,' + viewer.y + 'px) scale(' + viewer.scale + ')';
        img.style.cursor = viewer.scale > 1 ? (viewer.dragging ? 'grabbing' : 'grab') : 'zoom-in';
    }

    function resetViewer() {
        viewer.scale = 1;
        viewer.x = 0;
        viewer.y = 0;
        applyViewerTransform();
    }

    function openViewer(job) {
        if (!job || !job.result || !job.result.url) return;
        viewerJob = job;
        els.viewerTitle.textContent = job.modelLabel;
        els.viewerMeta.textContent = [
            job.engine,
            job.result.width + '×' + job.result.height,
            'seed ' + job.result.seed,
            fmtMs(job.result.generationMs)
        ].join(' · ');
        els.viewerImage.src = job.result.url;
        els.viewerImage.alt = job.modelLabel + ' benchmark result';
        resetViewer();
        els.viewerOverlay.hidden = false;
        els.viewerClose.focus();
    }

    function closeViewer() {
        els.viewerOverlay.hidden = true;
        els.viewerImage.removeAttribute('src');
        viewerJob = null;
    }

    function zoomViewer(factor) {
        viewer.scale = Math.max(1, Math.min(6, viewer.scale * factor));
        if (viewer.scale === 1) {
            viewer.x = 0;
            viewer.y = 0;
        }
        applyViewerTransform();
    }

    // Compare panels zoom around the cursor: the wheel scales the picture under
    // the pointer, dragging pans while zoomed, and a click resets to fit (or
    // opens the full viewer at 100%).
    function createPanelZoom(stage, img, onOpen) {
        const pill = el('span', 'arena-compare-zoom', '100%');
        stage.appendChild(pill);

        const ZOOM_MIN = 1;
        const ZOOM_MAX = 6;
        const state = { scale: 1, ox: 50, oy: 50, panX: 0, panY: 0 };
        let drag = null;
        let ignoreClicksUntil = 0;

        // The rendered (object-fit: contain) picture rect, in stage coordinates.
        function picture() {
            const bw = img.offsetWidth || 1;
            const bh = img.offsetHeight || 1;
            const nw = Number(img.naturalWidth) || bw;
            const nh = Number(img.naturalHeight) || bh;
            const fit = Math.min(bw / nw, bh / nh) || 1;
            const width = nw * fit;
            const height = nh * fit;
            return {
                bw, bh,
                x: img.offsetLeft + (bw - width) / 2,
                y: img.offsetTop + (bh - height) / 2,
                width, height
            };
        }

        function originPoint(p) {
            return {
                x: img.offsetLeft + (state.ox / 100) * p.bw,
                y: img.offsetTop + (state.oy / 100) * p.bh
            };
        }

        function panBounds() {
            const p = picture();
            const scale = state.scale;
            const origin = originPoint(p);
            const left = origin.x + (p.x - origin.x) * scale;
            const right = origin.x + (p.x + p.width - origin.x) * scale;
            const top = origin.y + (p.y - origin.y) * scale;
            const bottom = origin.y + (p.y + p.height - origin.y) * scale;
            const width = stage.clientWidth || p.bw;
            const height = stage.clientHeight || p.bh;
            const horizontal = right - left >= width
                ? [width - right, -left]
                : [(width - left - right) / 2, (width - left - right) / 2];
            const vertical = bottom - top >= height
                ? [height - bottom, -top]
                : [(height - top - bottom) / 2, (height - top - bottom) / 2];
            return { minX: horizontal[0], maxX: horizontal[1], minY: vertical[0], maxY: vertical[1] };
        }

        function clampPan() {
            const bounds = panBounds();
            state.panX = Math.max(bounds.minX, Math.min(bounds.maxX, state.panX));
            state.panY = Math.max(bounds.minY, Math.min(bounds.maxY, state.panY));
        }

        function render() {
            const zoomed = state.scale > 1.001;
            img.style.transformOrigin = state.ox + '% ' + state.oy + '%';
            img.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.scale + ')';
            stage.classList.toggle('is-zoomed', zoomed);
            stage.style.touchAction = zoomed ? 'none' : '';
            pill.textContent = Math.round(state.scale * 100) + '%';
            pill.classList.toggle('is-active', zoomed);
        }

        function setZoom(next, clientX, clientY) {
            const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(next) || ZOOM_MIN));
            const scale = clamped < 1.015 ? 1 : clamped;
            if (scale === 1) {
                state.scale = 1;
                state.ox = 50;
                state.oy = 50;
                state.panX = 0;
                state.panY = 0;
                render();
                return;
            }
            const p = picture();
            const rect = stage.getBoundingClientRect();
            const qx = Number.isFinite(clientX) ? clientX - rect.left : (stage.clientWidth || p.bw) / 2;
            const qy = Number.isFinite(clientY) ? clientY - rect.top : (stage.clientHeight || p.bh) / 2;
            if (state.scale <= 1) {
                // First zoom-in anchors the origin at the pointer (kept inside the picture).
                const px = Math.max(p.x, Math.min(p.x + p.width, qx));
                const py = Math.max(p.y, Math.min(p.y + p.height, qy));
                state.ox = Math.max(0, Math.min(100, ((px - img.offsetLeft) / p.bw) * 100));
                state.oy = Math.max(0, Math.min(100, ((py - img.offsetTop) / p.bh) * 100));
                state.panX = 0;
                state.panY = 0;
            } else {
                // Keep the point under the pointer fixed while the scale changes.
                const origin = originPoint(p);
                const ratio = scale / state.scale;
                state.panX = qx - origin.x - (qx - origin.x - state.panX) * ratio;
                state.panY = qy - origin.y - (qy - origin.y - state.panY) * ratio;
            }
            state.scale = scale;
            clampPan();
            render();
        }

        stage.addEventListener('wheel', (event) => {
            event.preventDefault();
            const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? (stage.clientHeight || 1) : 1);
            const delta = Math.max(-240, Math.min(240, (Number(event.deltaY) || 0) * unit));
            if (!delta) return;
            setZoom(state.scale * Math.exp(-delta * 0.002), event.clientX, event.clientY);
        }, { passive: false });

        stage.addEventListener('pointerdown', (event) => {
            if (state.scale <= 1) return;
            if (event.button !== undefined && event.button !== 0) return;
            drag = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                panX: state.panX,
                panY: state.panY,
                moved: false
            };
            try { stage.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
        });

        stage.addEventListener('pointermove', (event) => {
            if (!drag || drag.id !== event.pointerId) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < 3) return;
            drag.moved = true;
            event.preventDefault();
            stage.classList.add('is-panning');
            state.panX = drag.panX + dx;
            state.panY = drag.panY + dy;
            clampPan();
            render();
        });

        const endDrag = (event) => {
            if (!drag || drag.id !== event.pointerId) return;
            if (drag.moved) ignoreClicksUntil = performance.now() + 260;
            drag = null;
            stage.classList.remove('is-panning');
        };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);

        stage.addEventListener('click', () => {
            if (performance.now() < ignoreClicksUntil) return;
            if (state.scale > 1.001) {
                setZoom(1);
                ignoreClicksUntil = performance.now() + 260;
                return;
            }
            if (typeof onOpen === 'function') onOpen();
        });

        render();
    }

    function compareJobs(scope) {
        if (!session) return [];
        return session.jobs.filter((job) => {
            if (job.status !== 'completed' || !job.result || !job.result.url) return false;
            return scope === 'all' ? true : compareSelection.has(job.id);
        });
    }

    // One labelled row in a compare panel's detail block. A missing value is
    // shown as an em dash so panels keep a consistent height.
    function compareFact(label, value) {
        const row = el('div', 'arena-compare-fact');
        row.appendChild(el('dt', '', label));
        row.appendChild(el('dd', '', value === null || value === undefined || value === '' ? '—' : String(value)));
        return row;
    }

    function openCompare(scope) {
        const jobs = compareJobs(scope);
        if (jobs.length < 2) return;
        clear(els.compareGrid);
        els.compareMeta.textContent = jobs.length + ' results · ' + (session.mode === 'controlled' ? 'Controlled' : 'Native') + ' · scroll to zoom';
        jobs.forEach((job) => {
            const panel = el('figure', 'arena-compare-panel');
            const stage = el('div', 'arena-compare-stage');
            const img = document.createElement('img');
            img.src = job.result.url;
            img.alt = job.modelLabel + ' benchmark result';
            img.loading = 'lazy';
            img.draggable = false;
            stage.appendChild(img);
            createPanelZoom(stage, img, () => openViewer(job));
            panel.appendChild(stage);
            const cap = el('figcaption', 'arena-compare-caption');
            cap.appendChild(el('strong', '', job.modelLabel));
            const config = job.config || {};
            const hasDims = job.result.width && job.result.height;
            const sampler = config.sampler
                ? String(config.sampler) + (config.scheduler ? ' / ' + config.scheduler : '')
                : null;
            const facts = el('dl', 'arena-compare-facts');
            facts.appendChild(compareFact('Time', fmtMs(job.result.generationMs || job.durationMs)));
            facts.appendChild(compareFact('Resolution', hasDims ? job.result.width + '×' + job.result.height : null));
            facts.appendChild(compareFact('Seed', job.result.seed));
            facts.appendChild(compareFact('Steps', config.steps));
            facts.appendChild(compareFact('Sampler', sampler));
            facts.appendChild(compareFact('Status', STATUS_LABELS[job.status] || job.status));
            cap.appendChild(facts);
            panel.appendChild(cap);
            els.compareGrid.appendChild(panel);
        });
        els.compareOverlay.hidden = false;
        els.compareClose.focus();
    }

    function closeCompare() {
        els.compareOverlay.hidden = true;
        clear(els.compareGrid);
    }

    // --- Open / close --------------------------------------------------------

    async function open() {
        if (!els.overlay) return;
        els.overlay.hidden = false;
        requestAnimationFrame(() => els.overlay.classList.add('open'));
        if (window.StudioShell) window.StudioShell.open(els.overlay, { initial: '#arenaPrompt' });
        setStatus('');
        loadPrefs();
        syncModeUi();
        await refreshModels(false);
        loadHistory();
        // Restore the last session the user looked at, preferring an active one
        // so a reload of JARVIS returns straight to a running benchmark.
        try {
            const activeRes = await fetch('/api/benchmark/active', { cache: 'no-store' });
            const activeData = activeRes.ok ? await activeRes.json() : {};
            if (activeData.session) {
                renderSession(activeData.session);
                restoreSessionPrompt(activeData.session, { onlyIfEmpty: true });
                startWatch(activeData.session.id);
            } else if (lastSessionId) {
                await openSession(lastSessionId);
            }
        } catch (err) { /* history remains available */ }
    }

    function close() {
        if (!els.overlay) return;
        savePrefs();
        closeCompare();
        closeViewer();
        els.overlay.classList.remove('open');
        if (window.StudioShell) window.StudioShell.close();
        stopWatch();
        setTimeout(() => { els.overlay.hidden = true; }, 180);
    }

    // --- Wiring --------------------------------------------------------------

    function cacheElements() {
        els = {
            overlay: document.getElementById('imageArenaOverlay'),
            close: document.getElementById('imageArenaClose'),
            prompt: document.getElementById('arenaPrompt'),
            clearPrompt: document.getElementById('arenaClearPrompt'),
            selectedCount: document.getElementById('arenaSelectedCount'),
            generate: document.getElementById('arenaGenerate'),
            generateFooter: document.getElementById('arenaGenerateFooter'),
            status: document.getElementById('arenaStatus'),
            mode: document.getElementById('arenaMode'),
            modeSummary: document.getElementById('arenaModeSummary'),
            modeNote: document.getElementById('arenaModeNote'),
            aspectRatio: document.getElementById('arenaAspectRatio'),
            imageSize: document.getElementById('arenaImageSize'),
            matchResolution: document.getElementById('arenaMatchResolution'),
            matchRow: document.getElementById('arenaMatchRow'),
            matchSize: document.getElementById('arenaMatchSize'),
            matchWidth: document.getElementById('arenaMatchWidth'),
            matchHeight: document.getElementById('arenaMatchHeight'),
            matchNote: document.getElementById('arenaMatchNote'),
            seed: document.getElementById('arenaSeed'),
            steps: document.getElementById('arenaSteps'),
            cfg: document.getElementById('arenaCfg'),
            enhance: document.getElementById('arenaEnhance'),
            models: document.getElementById('arenaModels'),
            selectAll: document.getElementById('arenaSelectAll'),
            selectNone: document.getElementById('arenaSelectNone'),
            refreshModels: document.getElementById('arenaRefreshModels'),
            session: document.getElementById('arenaSession'),
            sessionStamp: document.getElementById('arenaSessionStamp'),
            sessionMeta: document.getElementById('arenaSessionMeta'),
            jobs: document.getElementById('arenaJobs'),
            results: document.getElementById('arenaResults'),
            sort: document.getElementById('arenaSort'),
            compare: document.getElementById('arenaCompare'),
            compareAll: document.getElementById('arenaCompareAll'),
            downloadAll: document.getElementById('arenaDownloadAll'),
            selectionBar: document.getElementById('arenaSelectionBar'),
            selectionText: document.getElementById('arenaSelectionText'),
            clearSelection: document.getElementById('arenaClearSelection'),
            history: document.getElementById('arenaHistory'),
            refreshHistory: document.getElementById('arenaRefreshHistory'),
            viewerOverlay: document.getElementById('arenaViewerOverlay'),
            viewerTitle: document.getElementById('arenaViewerTitle'),
            viewerMeta: document.getElementById('arenaViewerMeta'),
            viewerImage: document.getElementById('arenaViewerImage'),
            viewerStage: document.getElementById('arenaViewerStage'),
            viewerClose: document.getElementById('arenaViewerClose'),
            viewerZoomIn: document.getElementById('arenaViewerZoomIn'),
            viewerZoomOut: document.getElementById('arenaViewerZoomOut'),
            viewerReset: document.getElementById('arenaViewerReset'),
            viewerDownload: document.getElementById('arenaViewerDownload'),
            compareOverlay: document.getElementById('arenaCompareOverlay'),
            compareGrid: document.getElementById('arenaCompareGrid'),
            compareMeta: document.getElementById('arenaCompareMeta'),
            compareClose: document.getElementById('arenaCompareClose')
        };
    }

    function init() {
        cacheElements();
        if (!els.overlay) return;
        loadPrefs();
        syncModeUi();

        const trigger = document.getElementById('imageArenaOpen');
        if (trigger) trigger.addEventListener('click', open);
        if (els.close) els.close.addEventListener('click', close);
        els.overlay.addEventListener('click', (event) => { if (event.target === els.overlay) close(); });

        if (els.generate) els.generate.addEventListener('click', generateAll);
        if (els.generateFooter) els.generateFooter.addEventListener('click', generateAll);
        if (els.clearPrompt) els.clearPrompt.addEventListener('click', () => { els.prompt.value = ''; els.prompt.focus(); });
        if (els.mode) els.mode.addEventListener('change', syncModeUi);
        if (els.matchResolution) els.matchResolution.addEventListener('change', syncModeUi);
        if (els.matchSize) els.matchSize.addEventListener('change', syncModeUi);
        [els.matchWidth, els.matchHeight].forEach((input) => {
            if (input) input.addEventListener('change', savePrefs);
        });
        [els.aspectRatio, els.imageSize, els.seed, els.steps, els.cfg, els.enhance].forEach((input) => {
            if (input) input.addEventListener('change', savePrefs);
        });
        if (els.sort) els.sort.addEventListener('change', () => {
            sort = ['model', 'time'].indexOf(els.sort.value) !== -1 ? els.sort.value : 'status';
            savePrefs();
            renderResults();
        });
        if (els.selectAll) els.selectAll.addEventListener('click', () => {
            models.filter((model) => model.available).forEach((model) => selected.add(model.id));
            selectionInitialized = true;
            savePrefs();
            renderModels();
        });
        if (els.selectNone) els.selectNone.addEventListener('click', () => {
            selected = new Set();
            selectionInitialized = true;
            savePrefs();
            renderModels();
        });
        if (els.refreshModels) els.refreshModels.addEventListener('click', () => refreshModels(true));
        if (els.refreshHistory) els.refreshHistory.addEventListener('click', loadHistory);
        if (els.compare) els.compare.addEventListener('click', () => openCompare('selected'));
        if (els.compareAll) els.compareAll.addEventListener('click', () => openCompare('all'));
        if (els.downloadAll) els.downloadAll.addEventListener('click', downloadAll);
        if (els.clearSelection) els.clearSelection.addEventListener('click', () => {
            compareSelection = new Set();
            renderResults();
        });

        // Viewer controls.
        if (els.viewerClose) els.viewerClose.addEventListener('click', closeViewer);
        if (els.viewerOverlay) els.viewerOverlay.addEventListener('click', (event) => {
            if (event.target === els.viewerOverlay) closeViewer();
        });
        if (els.viewerZoomIn) els.viewerZoomIn.addEventListener('click', () => zoomViewer(1.25));
        if (els.viewerZoomOut) els.viewerZoomOut.addEventListener('click', () => zoomViewer(0.8));
        if (els.viewerReset) els.viewerReset.addEventListener('click', resetViewer);
        if (els.viewerDownload) els.viewerDownload.addEventListener('click', () => {
            if (viewerJob) downloadJob(viewerJob);
        });
        if (els.viewerStage) {
            els.viewerStage.addEventListener('wheel', (event) => {
                event.preventDefault();
                zoomViewer(event.deltaY < 0 ? 1.12 : 0.89);
            }, { passive: false });
            els.viewerStage.addEventListener('pointerdown', (event) => {
                if (viewer.scale <= 1) return;
                viewer.dragging = true;
                viewer.startX = event.clientX;
                viewer.startY = event.clientY;
                viewer.baseX = viewer.x;
                viewer.baseY = viewer.y;
                try { els.viewerStage.setPointerCapture(event.pointerId); } catch (err) { /* optional */ }
                applyViewerTransform();
            });
            els.viewerStage.addEventListener('pointermove', (event) => {
                if (!viewer.dragging) return;
                viewer.x = viewer.baseX + (event.clientX - viewer.startX);
                viewer.y = viewer.baseY + (event.clientY - viewer.startY);
                applyViewerTransform();
            });
            const stopDrag = () => {
                if (!viewer.dragging) return;
                viewer.dragging = false;
                applyViewerTransform();
            };
            els.viewerStage.addEventListener('pointerup', stopDrag);
            els.viewerStage.addEventListener('pointercancel', stopDrag);
            els.viewerStage.addEventListener('pointerleave', stopDrag);
        }

        // Comparison controls.
        if (els.compareClose) els.compareClose.addEventListener('click', closeCompare);
        if (els.compareOverlay) els.compareOverlay.addEventListener('click', (event) => {
            if (event.target === els.compareOverlay) closeCompare();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (els.compareOverlay && !els.compareOverlay.hidden) { closeCompare(); return; }
            if (els.viewerOverlay && !els.viewerOverlay.hidden) { closeViewer(); return; }
            if (els.overlay && !els.overlay.hidden) close();
        });

        updateCounts();
        loadHistory();
    }

    return {
        init,
        open,
        close,
        refreshModels,
        // exported for tests / debugging
        _state: () => ({ models, selected, session, compareSelection })
    };
})();

window.ImageArenaUI = ImageArenaUI;
