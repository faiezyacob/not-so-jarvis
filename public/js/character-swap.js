/* ============================================
   JARVIS — Character Swap workspace
   Interactive anchors, SAM tracking, mask
   painting, reference views and H3 takes.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const CharacterSwapUI = (() => {
    let project = null;
    let engines = [];
    let engineStatus = {};
    let engine = 'wan_animate';
    let selectedPersonId = null;
    let frame = 0;
    let tool = 'select';
    let brushSize = 16;
    let maskVisible = true;
    let maskOpacity = 0.55;
    let dragging = false;
    let strokePoints = [];
    let pollTimer = null;
    let maskImage = null;
    let maskOverlay = null;
    let maskOverlayKey = '';
    let mediaPicker = null;
    let mediaPickerKind = 'video';
    let detectionSelection = new Set();
    let detectionProjectId = null;

    const $ = (id) => document.getElementById(id);

    function api(url, options = {}) {
        return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options))
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
                return data;
            });
    }

    function setStatus(text, kind) {
        const el = $('csStatus');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'character-swap-status' + (kind ? ' character-swap-status--' + kind : '');
    }

    function engineInfo(id) {
        return (engines || []).find((item) => item.id === id) || null;
    }

    function engineLabel(id) {
        const info = engineInfo(id || engine);
        return info ? info.label : (id === 'h3' ? 'MiniMax H3' : 'Wan Animate 2');
    }

    function readWanSettings() {
        const duration = $('csWanDuration') ? $('csWanDuration').value : 'match';
        return {
            resolution: $('csWanResolution') ? $('csWanResolution').value : '480p',
            steps: Number($('csWanSteps').value),
            positive: $('csWanPrompt') ? $('csWanPrompt').value : '',
            durationMode: duration === 'match' ? 'match' : 'fixed',
            durationSeconds: duration === 'match' ? null : Number(duration)
        };
    }

    function readH3Settings() {
        return {
            quality: $('csQuality').value,
            h3Size: ''
        };
    }

    function collectEngineSettings() {
        const base = project && project.engineSettings ? JSON.parse(JSON.stringify(project.engineSettings)) : {};
        base.wanAnimate = Object.assign({}, base.wanAnimate || {}, readWanSettings());
        base.h3 = Object.assign({}, base.h3 || {}, readH3Settings());
        return base;
    }

    function applyEngineUI() {
        document.querySelectorAll('[data-cs-engine]').forEach((button) => {
            button.classList.toggle('active', button.getAttribute('data-cs-engine') === engine);
        });
        const isWan = engine === 'wan_animate';
        if ($('csWanSettings')) $('csWanSettings').hidden = !isWan;
        if ($('csH3Settings')) $('csH3Settings').hidden = isWan;
        if ($('csDetection')) $('csDetection').hidden = true;
        if ($('csPeopleSection')) $('csPeopleSection').hidden = isWan;
        if ($('csMaskSection')) $('csMaskSection').hidden = isWan;
        if ($('csAddPerson')) $('csAddPerson').hidden = isWan;
        if ($('csAnchors')) $('csAnchors').hidden = isWan;
        if ($('csTrack')) $('csTrack').textContent = 'Track';
        if ($('csRetrack')) $('csRetrack').textContent = 'Recalculate';
        const info = engineStatus[engine] || null;
        const label = engineLabel(engine);
        if ($('csEngineNote')) {
            $('csEngineNote').textContent = isWan
                ? 'Wan Animate 2 animates one character image with the performance video. Describe the shot (which person to replace) in the prompt; the original audio is kept.'
                : 'MiniMax H3 uses the existing Ref2VA workflow and Character LoRA v1.5. One clip renders up to 15 seconds.';
        }
        if ($('csAddRefs')) $('csAddRefs').textContent = isWan ? 'Upload image' : 'Upload images';
        if ($('csRefFiles')) $('csRefFiles').multiple = !isWan;
        if ($('csDescribe')) $('csDescribe').hidden = isWan;
        if ($('csCharacterHint')) {
            $('csCharacterHint').textContent = isWan
                ? 'Wan Animate 2 uses the first reference image as the character. A clear portrait or full-body photo works best.'
                : 'Add a full-body front view plus a face close-up. One portrait alone often replaces only the head.';
        }
        const warning = $('csEngineWarning');
        if (warning) {
            const problems = [];
            if (info && info.missing) problems.push(...info.missing);
            if (info && info.warnings) problems.push(...info.warnings);
            if (!info) {
                warning.hidden = true;
            } else if (problems.length) {
                warning.hidden = false;
                warning.textContent = label + ' is not fully ready: ' + problems.join(' · ') +
                    (isWan ? ' You can still switch to MiniMax H3 manually.' : '');
            } else {
                warning.hidden = true;
                warning.textContent = '';
            }
        }
        if ($('csTrimHint')) {
            $('csTrimHint').textContent = isWan
                ? 'Wan Animate 2 matches the original clip length, capped at 15 seconds. Longer imports are trimmed to the selected range.'
                : 'MiniMax H3 replacement renders up to 15 seconds. Trim the clip and re-track before rendering with H3.';
        }
        if ($('csTrimEnd')) $('csTrimEnd').max = '15';
        if ($('csRender')) $('csRender').textContent = 'Render';
        applySettingsToForm();
    }

    function applySettingsToForm() {
        const settings = (project && project.engineSettings) || {};
        const wan = settings.wanAnimate || {};
        if ($('csWanResolution')) $('csWanResolution').value = wan.resolution === '720p' ? '720p' : '480p';
        if ($('csWanSteps')) $('csWanSteps').value = String(wan.steps || 6);
        if ($('csWanPrompt')) $('csWanPrompt').value = wan.positive || '';
        if ($('csWanDuration')) {
            const fixed = wan.durationMode === 'fixed' && ['5', '10', '15'].includes(String(wan.durationSeconds));
            $('csWanDuration').value = fixed ? String(wan.durationSeconds) : 'match';
        }
        const h3 = settings.h3 || {};
        if ($('csQuality')) $('csQuality').value = h3.quality || 'full';
    }

    async function loadEngines() {
        try {
            const data = await api('/api/character-swap/engines');
            engines = Array.isArray(data.engines) ? data.engines : [];
            engineStatus = {};
            engines.forEach((item) => { engineStatus[item.id] = item; });
            if (!engineStatus[engine]) engine = data.default || 'wan_animate';
            applyEngineUI();
        } catch (err) {
            // Availability is advisory; the render endpoint re-validates.
            engines = [];
            engineStatus = {};
            applyEngineUI();
        }
    }

    async function switchEngine(next) {
        if (!next || next === engine) return;
        engine = next;
        if (!project) {
            applyEngineUI();
            return;
        }
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/engine', {
                method: 'PATCH',
                body: JSON.stringify({ engine, settings: collectEngineSettings() })
            });
            setProject(data);
            setStatus('Engine set to ' + engineLabel(engine) + '. Uploads, tracking, masks and references are unchanged.', 'ok');
        } catch (err) {
            engine = project.engine || 'wan_animate';
            applyEngineUI();
            setStatus(err.message, 'error');
        }
    }

    async function saveEngineSettings() {
        if (!project) return;
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/engine', {
                method: 'PATCH',
                body: JSON.stringify({ engine, settings: collectEngineSettings() })
            });
            project = data;
            applyEngineUI();
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function selectedPerson() {
        if (!project) return null;
        return (project.people || []).find((person) => person.id === selectedPersonId) || project.people[0] || null;
    }

    function frames() {
        return Math.max(1, (project && project.part && project.part.frames) || 1);
    }

    function fps() {
        return (project && project.part && project.part.fps) || 24;
    }

    function maskUrl(personId, index) {
        return '/api/character-swap/projects/' + encodeURIComponent(project.id) +
            '/person/' + encodeURIComponent(personId) + '/mask/' + Number(index);
    }

    function sourceFrameUrl(index) {
        return '/api/character-swap/projects/' + encodeURIComponent(project.id) +
            '/frame?index=' + Number(index);
    }

    function hasMask(person) {
        if (!project || !person) return false;
        if (project.engine === 'wan_animate') return false;
        return Boolean(person.masks);
    }

    function syncDetectionSelection() {
        if (!project) {
            detectionSelection = new Set();
            detectionProjectId = null;
            return;
        }
        if (detectionProjectId !== project.id) {
            detectionProjectId = project.id;
            detectionSelection = new Set((project.people || []).map((person) => person.selectionId).filter(Boolean));
        }
        const ids = new Set(((project.selection && project.selection.tracks) || []).map((track) => track.id));
        (project.people || []).forEach((person) => {
            if (person.selectionId && ids.has(person.selectionId)) detectionSelection.add(person.selectionId);
        });
        detectionSelection = new Set(Array.from(detectionSelection).filter((id) => ids.has(id)));
    }

    function renderDetections() {
        const host = $('csDetections');
        if (!host) return;
        host.replaceChildren();
        if (!project) {
            if ($('csSelectionApply')) $('csSelectionApply').disabled = true;
            return;
        }
        syncDetectionSelection();
        const tracks = (project.selection && project.selection.tracks) || [];
        if (!tracks.length) {
            const hint = document.createElement('div');
            hint.className = 'character-swap-hint';
            hint.textContent = project.status === 'tracking'
                ? (project.activity || 'Detecting people…')
                : 'No people detected yet. Press Detect people.';
            host.appendChild(hint);
            if ($('csSelectionApply')) $('csSelectionApply').disabled = true;
            return;
        }
        tracks.forEach((track) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'character-swap-detection-card' + (detectionSelection.has(track.id) ? ' active' : '');
            if (track.thumbUrl) {
                const img = document.createElement('img');
                img.src = track.thumbUrl;
                img.alt = track.label;
                card.appendChild(img);
            }
            const name = document.createElement('strong');
            name.textContent = track.label;
            card.appendChild(name);
            const meta = document.createElement('small');
            const bits = [track.frames + ' frames'];
            if (track.lostSpans && track.lostSpans.length) bits.push(track.lostSpans.length + ' gap' + (track.lostSpans.length === 1 ? '' : 's'));
            const owner = (project.people || []).find((person) => person.selectionId === track.id);
            if (owner) bits.push('→ ' + owner.label);
            meta.textContent = bits.join(' · ');
            card.appendChild(meta);
            card.addEventListener('click', () => {
                if (detectionSelection.has(track.id)) detectionSelection.delete(track.id);
                else detectionSelection.add(track.id);
                renderDetections();
            });
            host.appendChild(card);
        });
        if ($('csSelectionApply')) $('csSelectionApply').disabled = detectionSelection.size === 0;
    }

    async function detectPeople() {
        if (!project) return;
        try {
            setStatus('Detecting people with DWPose…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/selection/detect', { method: 'POST', body: '{}' });
            setProject(data);
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function applySelection() {
        if (!project) return;
        const trackIds = Array.from(detectionSelection);
        if (!trackIds.length) {
            setStatus('Select at least one detected person.', 'error');
            return;
        }
        try {
            setStatus('Binding the selected people…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/selection/select', {
                method: 'POST',
                body: JSON.stringify({ trackIds })
            });
            setProject(data);
            setStatus('Selected ' + trackIds.length + ' person' + (trackIds.length === 1 ? '' : 's') + '. Add a reference, then build the masks.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function buildMasks() {
        if (!project) return;
        try {
            setStatus('Building the person masks…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/segment', { method: 'POST', body: '{}' });
            setProject(data);
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function assignDetection(point) {
        if (!project) return;
        const person = selectedPerson();
        if (!person || !person.selectionId) {
            setStatus('Select a detected person first, then click a detection on the frame to reassign it.', 'error');
            return;
        }
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/selection/correction', {
                method: 'POST',
                body: JSON.stringify({ frame, x: point.x, y: point.y, trackId: person.selectionId })
            });
            setProject(data);
            setStatus('Tracking corrected at frame ' + frame + '.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function setProject(next) {
        project = next;
        if (!project) {
            selectedPersonId = null;
            return;
        }
        engine = project.engine || 'wan_animate';
        if (!project.people.some((person) => person.id === selectedPersonId)) {
            selectedPersonId = project.people[0] ? project.people[0].id : null;
        }
        frame = Math.max(0, Math.min(frames() - 1, frame));
        renderAll();
        applyEngineUI();
        if (project.status === 'failed' && project.error) setStatus(project.error, 'error');
        else if (project.status === 'tracking') setStatus(project.activity || 'Tracking the selected people…');
        schedulePoll();
    }

    function renderAll() {
        renderSource();
        renderPeople();
        renderDetections();
        renderRefs();
        renderDescription();
        renderTakes();
        updateMaskInputs();
        updateFlow();
        loadFrame();
    }

    function updateFlow() {
        const el = $('csNext');
        if (!el) return;
        const person = selectedPerson();
        const isWan = engine === 'wan_animate' || Boolean(project && project.engine === 'wan_animate');
        let text = '';
        let target = null;
        if (!project) {
            text = 'Step 1 — Import a video.';
        } else if (project.status === 'tracking') {
            text = 'Working — ' + (project.activity || 'processing the clip') + '…';
        } else if (isWan) {
            const referencePerson = (project.people || []).find((item) => (item.refs || []).length);
            const promptValue = $('csWanPrompt')
                ? String($('csWanPrompt').value || '').trim()
                : String((project.engineSettings && project.engineSettings.wanAnimate && project.engineSettings.wanAnimate.positive) || '').trim();
            if (!referencePerson) {
                text = 'Step 2 — Upload one character image.';
                target = $('csAddRefs');
            } else if (!promptValue) {
                text = 'Step 3 — Describe the shot, for example “replace the person on the left”.';
                target = $('csWanPrompt');
            } else {
                text = 'Ready — render with Wan Animate 2.';
                target = $('csRender');
            }
        } else if (!person || !person.anchors.length) {
            text = 'Step 2 — Choose Select, then click directly on the person you want to replace. Click again to add points.';
            target = $('csTools');
        } else if (!person.masks) {
            text = 'Step 3 — Check the tinted mask preview, then press Track to follow the person through the clip.';
            target = $('csTrack');
        } else if (!person.refs.length) {
            text = 'Step 4 — Add a full-body front view plus a face close-up. One portrait alone often replaces only the head.';
            target = $('csAddRefs');
        } else if (!person.refs.some((ref) => ['front', 'side', 'back', 'full_body'].includes(ref.role))) {
            text = 'Step 4b — No full-body view yet. Use Generate view (front or full body) so the body and clothing can follow the character.';
            target = $('csGenerateView');
        } else if (!person.description) {
            text = 'Step 5 — Describe the character (optional), or press Render and it will run automatically.';
            target = $('csDescribe');
        } else {
            text = 'Ready — review the mask, then Render a Draft take.';
            target = $('csRender');
        }
        el.textContent = text;
        ['csDetect', 'csSelectionApply', 'csTools', 'csTrack', 'csAddRefs', 'csDescribe', 'csGenerateView', 'csGenerateSheet', 'csWanPrompt', 'csRender'].forEach((id) => {
            const button = $(id);
            if (button) button.classList.remove('is-next');
        });
        if (target) target.classList.add('is-next');
        const ready = isWan
            ? Boolean(project && (project.people || []).some((item) => (item.refs || []).length) &&
                $('csWanPrompt') && String($('csWanPrompt').value || '').trim())
            : Boolean(project && person && person.refs.length);
        $('csRender').disabled = !ready;
        $('csDescribe').disabled = !person || !person.refs.length;
        $('csGenerateView').disabled = !person || !person.refs.length;
        $('csGenerateSheet').disabled = !person || !person.refs.length;
        $('csStartOver').disabled = !project;
    }

    function renderSource() {
        const video = $('csVideo');
        if (video) {
            const hasVideo = Boolean(project && project.videoUrl);
            video.hidden = !hasVideo;
            if (hasVideo && video.getAttribute('src') !== project.videoUrl) {
                video.src = project.videoUrl;
            }
            if (hasVideo) video.currentTime = Math.min((project.source && project.source.duration) || 0, frame / fps());
        }
        const part = (project && project.part) || { width: 0, height: 0, frames: 1 };
        $('csSourceMeta').textContent = project
            ? (project.source.filename + ' · ' + Math.round(project.source.duration * 10) / 10 + 's · ' +
                part.width + '×' + part.height + ' · ' + frames() + ' frames')
            : 'No clip loaded.';
        $('csTrimStart').value = project ? (project.trim && project.trim.start) || 0 : 0;
        $('csTrimEnd').value = project ? (project.trim && project.trim.end) || 0 : 0;
        $('csTrimEnd').max = '15';
        $('csTimeline').max = String(frames() - 1);
        $('csTimeline').value = String(frame);
        $('csFrameLabel').textContent = 'Frame ' + frame + ' / ' + (frames() - 1);
        $('csStageTitle').textContent = project ? (project.title || 'Character Swap') : 'No clip loaded';
        $('csStageEmpty').hidden = Boolean(project);
        $('csCanvasWrap').hidden = !project;
    }

    function personButton(person) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'character-swap-person' + (person.id === selectedPersonId ? ' active' : '');
        const dot = document.createElement('span');
        dot.className = 'character-swap-person-dot';
        dot.style.background = person.tint;
        const text = document.createElement('span');
        text.className = 'character-swap-person-text';
        const name = document.createElement('strong');
        name.textContent = person.label;
        const meta = document.createElement('small');
        const bits = [];
        bits.push(person.status || 'new');
        if (project && project.engine === 'wan_animate') {
            bits.push(person.selectionId ? 'tracked (no SAM)' : 'unassigned');
            const seg = project.segmentation && project.segmentation.people ? project.segmentation.people[person.id] : null;
            if (seg) bits.push(seg.settings && seg.settings.grow !== undefined ? 'mask ready' : 'mask ready');
        } else {
            bits.push(person.anchors.length + ' anchor' + (person.anchors.length === 1 ? '' : 's'));
            if (person.masks) bits.push(person.masks.lostSpans && person.masks.lostSpans.length ? 'tracking gaps' : 'tracked');
        }
        if (person.refs.length) bits.push(person.refs.length + ' refs');
        meta.textContent = bits.join(' · ');
        text.appendChild(name);
        text.appendChild(meta);
        button.appendChild(dot);
        button.appendChild(text);
        button.addEventListener('click', () => {
            selectedPersonId = person.id;
            frame = 0;
            renderAll();
        });
        return button;
    }

    function renderPeople() {
        const host = $('csPeople');
        host.replaceChildren();
        renderAnchors();
        if (!project) return;
        project.people.forEach((person) => {
            const row = document.createElement('div');
            row.className = 'character-swap-person-row';
            row.appendChild(personButton(person));
            if (project.people.length > 1) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'character-swap-remove';
                remove.textContent = '×';
                remove.title = 'Remove person';
                remove.addEventListener('click', async () => {
                    try {
                        const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id), { method: 'DELETE' });
                        setProject(data);
                    } catch (err) { setStatus(err.message, 'error'); }
                });
                row.appendChild(remove);
            }
            host.appendChild(row);
        });
        const person = selectedPerson();
        if (project.engine === 'wan_animate') {
            $('csTrack').disabled = true;
            $('csRetrack').disabled = true;
        } else {
            $('csTrack').disabled = !person || !person.anchors.length;
            $('csRetrack').disabled = !person || !person.anchors.length;
        }
    }

    function renderAnchors() {
        const host = $('csAnchors');
        host.replaceChildren();
        const person = selectedPerson();
        if (!person) return;
        if (!person.anchors.length) {
            const hint = document.createElement('div');
            hint.className = 'character-swap-hint';
            hint.textContent = 'No anchors yet. Use Select and click the person.';
            host.appendChild(hint);
            return;
        }
        person.anchors.slice().sort((a, b) => a.frame - b.frame).forEach((anchor) => {
            const chip = document.createElement('span');
            chip.className = 'character-swap-anchor';
            const jump = document.createElement('button');
            jump.type = 'button';
            jump.textContent = 'frame ' + anchor.frame;
            jump.title = 'Jump to this anchor';
            jump.addEventListener('click', () => {
                frame = anchor.frame;
                renderSource();
                loadFrame();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'Delete this anchor';
            remove.addEventListener('click', async () => {
                try {
                    const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/anchors/' + anchor.frame, { method: 'DELETE' });
                    setProject(data);
                } catch (err) { setStatus(err.message, 'error'); }
            });
            chip.appendChild(jump);
            chip.appendChild(remove);
            host.appendChild(chip);
        });
    }

    function renderRefs() {
        const host = $('csRefs');
        host.replaceChildren();
        const person = selectedPerson();
        if (!person) return;
        if (!person.refs.length) {
            const empty = document.createElement('div');
            empty.className = 'character-swap-hint';
            empty.textContent = 'Add front, side, back or close-up views. A plain-background sheet is split automatically.';
            host.appendChild(empty);
            return;
        }
        person.refs.forEach((ref) => {
            const card = document.createElement('div');
            card.className = 'character-swap-ref';
            const img = document.createElement('img');
            img.src = ref.url;
            img.alt = ref.role || 'reference';
            const controls = document.createElement('div');
            controls.className = 'character-swap-ref-controls';
            const select = document.createElement('select');
            ['front', 'side', 'back', 'close_up', 'full_body', 'other'].forEach((role) => {
                const option = document.createElement('option');
                option.value = role;
                option.textContent = role.replace('_', ' ');
                if (ref.role === role) option.selected = true;
                select.appendChild(option);
            });
            select.addEventListener('change', async () => {
                try {
                    const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/ref/' + encodeURIComponent(ref.id), {
                        method: 'PATCH',
                        body: JSON.stringify({ role: select.value })
                    });
                    setProject(data);
                } catch (err) { setStatus(err.message, 'error'); }
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'Remove reference';
            remove.addEventListener('click', async () => {
                try {
                    const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/ref/' + encodeURIComponent(ref.id), { method: 'DELETE' });
                    setProject(data);
                } catch (err) { setStatus(err.message, 'error'); }
            });
            controls.appendChild(select);
            controls.appendChild(remove);
            card.appendChild(img);
            card.appendChild(controls);
            host.appendChild(card);
        });
    }

    function renderDescription() {
        const host = $('csDescription');
        host.replaceChildren();
        const person = selectedPerson();
        if (!person) return;
        if (!person.description) {
            host.textContent = 'No description yet. Describe after adding references.';
            return;
        }
        const d = person.description;
        const lines = [
            ['Identity', d.identitySummary],
            ['Face', d.face],
            ['Hair', d.hair],
            ['Skin', d.skin],
            ['Build', d.build],
            ['Clothing', d.clothing],
            ['Footwear', d.footwear],
            ['Accessories', d.accessories],
            ['Distinguishing', d.distinguishing],
            ['Carry-over exclusions', (d.unlike || []).join(', ')],
            ['Video orientation', person.facing],
            ['Performer clothing', person.look]
        ];
        lines.forEach(([label, value]) => {
            if (!value) return;
            const row = document.createElement('div');
            row.className = 'character-swap-description-row';
            const strong = document.createElement('strong');
            strong.textContent = label;
            const span = document.createElement('span');
            span.textContent = value;
            row.appendChild(strong);
            row.appendChild(span);
            host.appendChild(row);
        });
    }

    function renderTakes() {
        const host = $('csTakes');
        host.replaceChildren();
        const takes = project && Array.isArray(project.takes) ? project.takes : [];
        host.dataset.count = String(Math.min(3, takes.length));
        const head = $('csTakesHead');
        if (head) head.hidden = !takes.length;
        const count = $('csTakesCount');
        if (count) count.textContent = takes.length ? takes.length + (takes.length === 1 ? ' render' : ' renders') : '';
        if (!takes.length) return;
        takes.slice().reverse().forEach((take) => {
            const card = document.createElement('div');
            card.className = 'character-swap-take';
            if (take.url) {
                const video = document.createElement('video');
                video.controls = true;
                video.playsInline = true;
                video.preload = 'metadata';
                video.src = take.url;
                card.appendChild(video);
            }
            const head = document.createElement('div');
            head.className = 'character-swap-take-head';
            const badge = document.createElement('span');
            badge.className = 'character-swap-take-engine';
            badge.textContent = take.engine === 'h3' ? 'MINIMAX H3' : 'WAN ANIMATE 2';
            head.appendChild(badge);
            if (take.url) {
                const download = document.createElement('a');
                download.className = 'character-swap-take-download';
                download.href = take.url;
                download.download = take.filename || 'character-swap.mp4';
                download.textContent = 'Download';
                head.appendChild(download);
            }
            if (take.takeId) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'character-swap-take-delete';
                remove.title = 'Delete this take and its generated video';
                remove.textContent = 'Delete';
                remove.addEventListener('click', async () => {
                    const confirmed = window.Dialog && typeof window.Dialog.confirm === 'function'
                        ? await window.Dialog.confirm({
                            title: 'Delete take',
                            message: 'Delete this take permanently? Its generated video is removed from the gallery too.',
                            confirmText: 'Delete',
                            danger: true
                        })
                        : window.confirm('Delete this take permanently?');
                    if (!confirmed) return;
                    remove.disabled = true;
                    try {
                        const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/takes/' + encodeURIComponent(take.takeId), {
                            method: 'DELETE'
                        });
                        setProject(data);
                        if (window.Gallery && typeof window.Gallery.refresh === 'function') window.Gallery.refresh();
                        setStatus('Take deleted.', 'ok');
                    } catch (err) {
                        remove.disabled = false;
                        setStatus(err.message, 'error');
                    }
                });
                head.appendChild(remove);
            }
            card.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'character-swap-take-meta';
            if (take.status === 'failed') {
                meta.textContent = 'seed ' + take.seed + ' · failed · ' + (take.error || '');
            } else {
                const bits = [
                    'seed ' + take.seed,
                    take.quality || '',
                    (take.width || '?') + '×' + (take.height || '?'),
                    take.fps ? take.fps + ' fps' : '',
                    take.duration ? (Math.round(take.duration * 10) / 10) + 's' : '',
                    take.metrics && take.metrics.peakVramMB ? 'peak VRAM ' + Math.round(take.metrics.peakVramMB / 1024) + ' GB' : '',
                    take.upscaled ? 'upscaled' : '',
                    take.upscaleError ? 'upscale failed' : ''
                ].filter(Boolean);
                meta.textContent = bits.join(' · ');
            }
            card.appendChild(meta);
            if (Array.isArray(take.windows) && take.windows.length) {
                const list = document.createElement('div');
                list.className = 'character-swap-take-windows';
                const byPass = {};
                take.windows.forEach((window) => {
                    byPass[window.pass] = (byPass[window.pass] || 0) + 1;
                });
                Object.keys(byPass).forEach((pass) => {
                    const passInfo = take.passes && take.passes[pass];
                    const row = document.createElement('div');
                    row.className = 'character-swap-take-window';
                    const label = document.createElement('span');
                    label.textContent = 'Pass ' + (Number(pass) + 1) + ' · ' + byPass[pass] + ' windows';
                    row.appendChild(label);
                    const wins = passInfo && Array.isArray(passInfo.windows) ? passInfo.windows : [];
                    (take.engine === engine ? wins : []).forEach((entry) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'character-swap-window-redo';
                        button.title = 'Regenerate this window and every later window';
                        button.textContent = '↻ ' + (entry.index + 1);
                        button.addEventListener('click', () => render({
                            resumeTakeId: take.takeId,
                            redoWindow: { pass: Number(pass), window: Number(entry.index) }
                        }));
                        row.appendChild(button);
                    });
                    list.appendChild(row);
                });
                card.appendChild(list);
            }
            if (take.status === 'failed' && take.engine === engine && Array.isArray(take.windows) && take.windows.length) {
                const actions = document.createElement('div');
                actions.className = 'character-swap-take-actions';
                const resume = document.createElement('button');
                resume.type = 'button';
                resume.className = 'character-swap-btn';
                resume.textContent = 'Resume take';
                resume.addEventListener('click', () => render({ resumeTakeId: take.takeId }));
                actions.appendChild(resume);
                card.appendChild(actions);
            }
            host.appendChild(card);
        });
    }

    function generatedFilename(entry) {
        const decoded = decodeURIComponent(String((entry && entry.file) || ''));
        const index = decoded.lastIndexOf('/');
        return index === -1 ? decoded : decoded.slice(index + 1);
    }

    function generatedIsVideo(entry) {
        if (entry && entry.video) return true;
        return /\.(?:mp4|webm|mov|m4v|avi|mkv)$/i.test(generatedFilename(entry));
    }

    function mediaThumbUrl(entry) {
        return '/generated/thumb/' + encodeURIComponent(generatedFilename(entry));
    }

    function closeMediaPicker() {
        const overlay = $('csMediaPicker');
        if (overlay) overlay.hidden = true;
        mediaPicker = null;
    }

    function updatePickerSelection() {
        if (!mediaPicker) return;
        const add = $('csMediaAdd');
        if (add) {
            add.hidden = !mediaPicker.multiple;
            add.disabled = !mediaPicker.selected.size;
            add.textContent = mediaPicker.selected.size
                ? 'Add selected (' + mediaPicker.selected.size + ')'
                : 'Add selected';
        }
    }

    function renderPickerGrid() {
        if (!mediaPicker) return;
        const grid = $('csMediaGrid');
        if (!grid) return;
        grid.replaceChildren();
        if (!mediaPicker.entries.length) {
            const empty = document.createElement('div');
            empty.className = 'cs-media-empty';
            empty.textContent = mediaPicker.kind === 'video'
                ? 'No generated videos yet. Upload one instead.'
                : 'No generated images yet. Upload one instead.';
            grid.appendChild(empty);
            return;
        }
        mediaPicker.entries.forEach((entry) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cs-media-item' + (mediaPicker.selected.has(entry.id) ? ' selected' : '');
            const img = document.createElement('img');
            img.alt = entry.prompt || 'Generated media';
            img.loading = 'lazy';
            img.src = mediaThumbUrl(entry);
            img.onerror = () => { img.src = entry.file; };
            button.appendChild(img);
            const meta = document.createElement('span');
            meta.className = 'cs-media-item-meta';
            const kind = generatedIsVideo(entry) ? 'VIDEO' : 'IMAGE';
            const date = entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : '';
            meta.textContent = kind + (date ? ' · ' + date : '');
            button.appendChild(meta);
            if (generatedIsVideo(entry)) {
                const badge = document.createElement('span');
                badge.className = 'cs-media-play';
                badge.textContent = '▶';
                button.appendChild(badge);
            }
            button.addEventListener('click', () => {
                if (!mediaPicker) return;
                if (mediaPicker.multiple) {
                    if (mediaPicker.selected.has(entry.id)) {
                        mediaPicker.selected.delete(entry.id);
                    } else if (mediaPicker.selected.size < mediaPicker.max) {
                        mediaPicker.selected.add(entry.id);
                    } else {
                        setStatus('You can add up to ' + mediaPicker.max + ' more reference image(s).', 'error');
                    }
                    button.classList.toggle('selected', mediaPicker.selected.has(entry.id));
                    updatePickerSelection();
                    return;
                }
                const callback = mediaPickerCallback;
                closeMediaPicker();
                if (typeof callback === 'function') callback([entry]);
            });
            grid.appendChild(button);
        });
    }

    let mediaPickerCallback = null;

    async function openMediaPicker(options) {
        const kind = options.kind === 'image' ? 'image' : 'video';
        mediaPickerKind = kind;
        mediaPickerCallback = options.onPick;
        const picker = {
            kind,
            multiple: Boolean(options.multiple),
            max: Math.max(1, Number(options.max) || 1),
            selected: new Set(),
            entries: []
        };
        mediaPicker = picker;
        const overlay = $('csMediaPicker');
        if (overlay) overlay.hidden = false;
        const title = $('csMediaTitle');
        if (title) title.textContent = kind === 'video' ? 'Choose a generated video' : 'Choose generated images';
        const grid = $('csMediaGrid');
        if (grid) grid.replaceChildren();
        const status = $('csMediaStatus');
        if (status) status.textContent = 'Loading generated media…';
        updatePickerSelection();
        try {
            const data = await api('/api/generated');
            const rows = Array.isArray(data.images) ? data.images : [];
            const filtered = rows.filter((entry) => kind === 'video' ? generatedIsVideo(entry) : !generatedIsVideo(entry));
            if (mediaPicker !== picker) return;
            mediaPicker.entries = filtered;
            if (status) status.textContent = filtered.length ? '' : 'Nothing available.';
            renderPickerGrid();
        } catch (err) {
            if (status) status.textContent = err.message;
        }
    }

    async function createFromGenerated(entry) {
        if (!entry) return;
        try {
            const filename = generatedFilename(entry);
            setStatus('Importing the generated clip…');
            const conversationId = window.Conversations && typeof window.Conversations.currentId === 'function'
                ? window.Conversations.currentId()
                : null;
            const data = await api('/api/character-swap/projects', {
                method: 'POST',
                body: JSON.stringify({
                    filename,
                    source: 'generated',
                    title: filename,
                    conversationId
                })
            });
            frame = 0;
            setProject(data);
            setStatus('Clip ready. Select the person to replace.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function addGeneratedReferences(entries) {
        const person = selectedPerson();
        if (!person || !entries.length) return;
        try {
            for (const entry of entries) {
                setStatus('Adding generated image…');
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/refs', {
                    method: 'POST',
                    body: JSON.stringify({ filename: generatedFilename(entry), source: 'generated' })
                });
                setProject(data);
            }
            setStatus('References added.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function updateMaskInputs() {
        if (!project) return;
        const settings = project.maskSettings || {};
        $('csMaskGrow').value = settings.grow;
        $('csMaskFeather').value = settings.feather;
        $('csMaskTemporal').value = settings.temporal;
        maskOpacity = Number(settings.opacity) || 0.55;
        $('csMaskOpacity').value = Math.round(maskOpacity * 100);
        $('csMaskVisible').checked = maskVisible;
    }

    function setTool(next) {
        tool = next;
        document.querySelectorAll('[data-cs-tool]').forEach((button) => {
            button.classList.toggle('active', button.getAttribute('data-cs-tool') === next);
        });
        const wrap = $('csCanvasWrap');
        wrap.classList.toggle('is-select', next === 'select');
        wrap.classList.toggle('is-brush', next === 'brush' || next === 'erase');
        wrap.classList.toggle('is-point', next === 'include' || next === 'exclude');
        $('csDrawCanvas').style.cursor = next === 'select' ? 'crosshair' : 'crosshair';
    }

    function loadFrame() {
        if (!project || !project.part) return;
        const img = $('csFrameImage');
        const url = sourceFrameUrl(frame);
        img.onload = () => {
            syncCanvasSize();
            drawMask();
        };
        img.src = url;
        const person = selectedPerson();
        if (person && hasMask(person)) {
            maskImage = new Image();
            maskImage.onload = () => drawMask();
            maskImage.src = maskUrl(person.id, frame);
            return;
        }
        const anchor = person && (person.anchors || []).find((item) => item.frame === frame);
        if (anchor) {
            maskImage = new Image();
            maskImage.onload = () => drawMask();
            maskImage.src = anchor.anchorMaskUrl ||
                ('/api/character-swap/projects/' + encodeURIComponent(project.id) +
                    '/person/' + encodeURIComponent(person.id) + '/anchors/' + Number(anchor.frame) + '/mask');
            return;
        }
        maskImage = null;
        drawMask();
    }

    function syncCanvasSize() {
        const img = $('csFrameImage');
        const width = img.naturalWidth || (project && project.part && project.part.width) || 1280;
        const height = img.naturalHeight || (project && project.part && project.part.height) || 720;
        const mask = $('csMaskCanvas');
        const draw = $('csDrawCanvas');
        if (mask.width !== width || mask.height !== height) {
            mask.width = width;
            mask.height = height;
        }
        if (draw.width !== width || draw.height !== height) {
            draw.width = width;
            draw.height = height;
        }
        layoutCanvases();
    }

    function layoutCanvases() {
        const wrap = $('csCanvasWrap');
        const img = $('csFrameImage');
        if (!wrap || !img) return;
        const rect = wrap.getBoundingClientRect();
        const width = img.naturalWidth || (project && project.part && project.part.width) || 1280;
        const height = img.naturalHeight || (project && project.part && project.part.height) || 720;
        if (!rect.width || !rect.height || !width || !height) return;
        const scale = Math.min(rect.width / width, rect.height / height);
        const shownWidth = Math.max(1, width * scale);
        const shownHeight = Math.max(1, height * scale);
        const left = Math.max(0, (rect.width - shownWidth) / 2);
        const top = Math.max(0, (rect.height - shownHeight) / 2);
        [$('csMaskCanvas'), $('csDrawCanvas')].forEach((canvas) => {
            canvas.style.left = left + 'px';
            canvas.style.top = top + 'px';
            canvas.style.width = shownWidth + 'px';
            canvas.style.height = shownHeight + 'px';
            canvas.style.right = 'auto';
            canvas.style.bottom = 'auto';
        });
    }

    function tintRgb(hex) {
        const value = String(hex || '#6CFF9A').replace('#', '');
        const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
        const parsed = parseInt(full, 16);
        if (!Number.isFinite(parsed)) return { r: 108, g: 255, b: 154 };
        return { r: (parsed >> 16) & 255, g: (parsed >> 8) & 255, b: parsed & 255 };
    }

    function buildTintedMask(image, width, height, tint) {
        const temp = document.createElement('canvas');
        temp.width = width;
        temp.height = height;
        const tctx = temp.getContext('2d');
        tctx.drawImage(image, 0, 0, width, height);
        const rgb = tintRgb(tint);
        let pixels;
        try {
            pixels = tctx.getImageData(0, 0, width, height);
        } catch {
            return temp;
        }
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i];
            data[i] = rgb.r;
            data[i + 1] = rgb.g;
            data[i + 2] = rgb.b;
            data[i + 3] = alpha;
        }
        tctx.putImageData(pixels, 0, 0);
        return temp;
    }

    function drawMask() {
        const canvas = $('csMaskCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!maskVisible || !maskImage || !maskImage.naturalWidth) return;
        const tint = (selectedPerson() && selectedPerson().tint) || '#6CFF9A';
        const key = (maskImage.src || '') + '|' + canvas.width + 'x' + canvas.height + '|' + tint;
        if (!maskOverlay || maskOverlayKey !== key) {
            maskOverlay = buildTintedMask(maskImage, canvas.width, canvas.height, tint);
            maskOverlayKey = key;
        }
        ctx.globalAlpha = maskOpacity;
        ctx.drawImage(maskOverlay, 0, 0);
        ctx.globalAlpha = 1;
    }

    function clearDrawing() {
        const canvas = $('csDrawCanvas');
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    }

    function resetWorkspace() {
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
        project = null;
        selectedPersonId = null;
        frame = 0;
        detectionSelection = new Set();
        detectionProjectId = null;
        if (maskImage) maskImage.onload = null;
        maskImage = null;
        maskOverlay = null;
        maskOverlayKey = '';
        dragging = false;
        strokePoints = [];
        const video = $('csVideo');
        if (video) {
            try { video.pause(); } catch { /* not playing */ }
            video.removeAttribute('src');
            try { video.load(); } catch { /* nothing to reload */ }
        }
        const frameImage = $('csFrameImage');
        if (frameImage) {
            frameImage.onload = null;
            frameImage.removeAttribute('src');
        }
        const maskCanvas = $('csMaskCanvas');
        if (maskCanvas) maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        clearDrawing();
        ['csVideoFile', 'csRefFiles'].forEach((id) => {
            const input = $(id);
            if (input) input.value = '';
        });
        $('csMaskGrow').value = '12';
        $('csMaskFeather').value = '2';
        $('csMaskTemporal').value = '3';
        $('csMaskOpacity').value = '55';
        $('csMaskVisible').checked = true;
        maskOpacity = 0.55;
        maskVisible = true;
        setTool('select');
        renderAll();
        setStatus('', '');
    }

    async function startOver() {
        if (!project) {
            resetWorkspace();
            return;
        }
        const projectId = project.id;
        const message = 'Start over? This deletes this Character Swap project, its tracking masks, references and rendered takes. The imported clip stays in your uploads.';
        const confirmed = window.Dialog && typeof window.Dialog.confirm === 'function'
            ? await window.Dialog.confirm({
                title: 'Start over',
                message,
                confirmText: 'Start over',
                cancelText: 'Cancel',
                danger: true
            })
            : window.confirm(message);
        if (!confirmed) return;
        try {
            setStatus('Clearing this Character Swap…');
            await api('/api/character-swap/projects/' + encodeURIComponent(projectId), { method: 'DELETE' });
            resetWorkspace();
            setStatus('Ready for a new clip.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function pointFromEvent(event) {
        const canvas = $('csDrawCanvas');
        const rect = canvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width))),
            y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height)))
        };
    }

    function drawStroke(points, erase) {
        const canvas = $('csDrawCanvas');
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = erase ? 'rgba(198,106,99,0.85)' : 'rgba(108,255,154,0.85)';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = brushSize * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (points.length === 1) {
            ctx.beginPath();
            ctx.arc(points[0].x, points[0].y, brushSize, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
    }

    async function saveStroke(points, isErase) {
        const person = selectedPerson();
        if (!person || !hasMask(person) || !points.length) return;
        try {
            await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/mask/' + frame, {
                method: 'POST',
                body: JSON.stringify({ strokes: [{ tool: isErase ? 'erase' : 'add', radius: brushSize, points }] })
            });
            clearDrawing();
            await refresh();
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function addAnchor(point, negativePoint) {
        const person = selectedPerson();
        if (!person) return;
        const existing = (person.anchors || []).find((anchor) => anchor.frame === frame);
        const positive = negativePoint
            ? (existing ? existing.positive : [])
            : [point];
        const negative = negativePoint ? [point] : [];
        if (!positive.length) {
            setStatus('Add a positive tap on the person first, then Shift-click to exclude.', 'error');
            return;
        }
        try {
            setStatus('Finding the person with SAM 3.1…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/anchors', {
                method: 'POST',
                body: JSON.stringify({ frame, positive, negative })
            });
            setProject(data);
            setStatus('Anchor added. Check the mask preview, add more points, or press Track.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function pointEdit(point, include) {
        const person = selectedPerson();
        if (!person) return;
        if (!hasMask(person)) {
            await addAnchor(point);
            return;
        }
        drawStroke([point], !include);
        await saveStroke([point], !include);
    }

    async function refresh() {
        if (!project) return;
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id));
            setProject(data);
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        if (!project) return;
        if (project.status === 'tracking' || project.status === 'preparing' || project.status === 'working') {
            pollTimer = setTimeout(async () => {
                await refresh();
            }, 2000);
        }
    }

    async function uploadFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('The file could not be read.'));
            reader.onload = async () => {
                try {
                    const data = await api('/api/uploads', {
                        method: 'POST',
                        body: JSON.stringify({ filename: file.name, mime: file.type, data: reader.result })
                    });
                    resolve(data);
                } catch (err) { reject(err); }
            };
            reader.readAsDataURL(file);
        });
    }

    async function createFromFile(file) {
        if (!file) return;
        try {
            setStatus('Uploading the clip…');
            const uploaded = await uploadFile(file);
            setStatus('Preparing the clip at 24 fps…');
            const conversationId = window.Conversations && typeof window.Conversations.currentId === 'function'
                ? window.Conversations.currentId()
                : null;
            const data = await api('/api/character-swap/projects', {
                method: 'POST',
                body: JSON.stringify({
                    filename: uploaded.filename,
                    title: file.name,
                    conversationId
                })
            });
            frame = 0;
            setProject(data);
            setStatus('Clip ready. Select the person to replace.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function addReferences(files) {
        const person = selectedPerson();
        if (!person || !files.length) return;
        try {
            for (const file of Array.from(files)) {
                setStatus('Adding ' + file.name + '…');
                const uploaded = await uploadFile(file);
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/refs', {
                    method: 'POST',
                    body: JSON.stringify({ filename: uploaded.filename })
                });
                setProject(data);
            }
            setStatus('References added.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function describe() {
        const person = selectedPerson();
        if (!person) return;
        try {
            setStatus('Describing the character…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/describe', {
                method: 'POST',
                body: JSON.stringify({})
            });
            setProject(data);
            setStatus('Character described and references ordered.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function generateView() {
        const person = selectedPerson();
        if (!person) return;
        try {
            setStatus('Generating the reference view…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/view', {
                method: 'POST',
                body: JSON.stringify({ view: $('csViewKind').value })
            });
            setProject(data);
            setStatus('Reference view added.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function generateSheet() {
        const person = selectedPerson();
        if (!person) return;
        try {
            setStatus('Generating a character sheet…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/sheet', {
                method: 'POST',
                body: '{}'
            });
            setProject(data);
            setStatus('Sheet generated and split into views.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function track() {
        if (engine === 'wan_animate' || (project && project.engine === 'wan_animate')) {
            await buildMasks();
            return;
        }
        const person = selectedPerson();
        if (!person || !person.anchors.length) return;
        try {
            setStatus('Tracking the selected people…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/track', { method: 'POST', body: '{}' });
            setProject(data);
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function retrack() {
        if (engine === 'wan_animate' || (project && project.engine === 'wan_animate')) {
            await detectPeople();
            return;
        }
        const person = selectedPerson();
        if (!person) return;
        if (!person.anchors.length) {
            setStatus('Add an anchor at the timestamp where tracking needs correction.', 'error');
            return;
        }
        await track();
    }

    async function saveMaskSettings() {
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/mask-settings', {
                method: 'PATCH',
                body: JSON.stringify({
                    grow: Number($('csMaskGrow').value),
                    feather: Number($('csMaskFeather').value),
                    temporal: Number($('csMaskTemporal').value),
                    opacity: Number($('csMaskOpacity').value) / 100
                })
            });
            setProject(data);
            setStatus('Mask settings saved.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function render(options = {}) {
        if (!project) return;
        const button = $('csRender');
        button.disabled = true;
        try {
            setStatus(engine === 'wan_animate' ? 'Preparing the Wan Animate 2 render…' : 'Building the refined mask…');
            const settings = collectEngineSettings();
            const response = await fetch('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    engine,
                    quality: $('csQuality').value,
                    takes: Number($('csTakeCount').value),
                    resumeTakeId: options.resumeTakeId || null,
                    redoWindow: options.redoWindow || null,
                    settings
                })
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                const missing = data.missing && data.missing.length ? '\n\nMissing: ' + data.missing.join('; ') : '';
                throw new Error((data.error || 'Render failed.') + missing);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';
                for (const event of events) {
                    const line = event.split('\n').find((part) => part.startsWith('data: '));
                    if (!line) continue;
                    let payload;
                    try { payload = JSON.parse(line.slice(6)); } catch { continue; }
                    if (payload.generating) setStatus(payload.generating);
                    if (payload.queued) setStatus('Queued at position ' + payload.queued.position + '…');
                    if (payload.progress && payload.progress.max) {
                        setStatus('Rendering… ' + Math.round(payload.progress.value / payload.progress.max * 100) + '%');
                    }
                    if (payload.take) {
                        setStatus('Take ' + payload.take.seed + ' complete.', 'ok');
                    }
                    if (payload.error) throw new Error(payload.error);
                    if (payload.done) {
                        setStatus('Takes complete.', 'ok');
                        setProject(payload.project);
                    }
                }
            }
        } catch (err) {
            setStatus(err.message, 'error');
        } finally {
            button.disabled = false;
            updateFlow();
        }
    }

    function bind() {
        $('csChooseVideo').addEventListener('click', () => $('csVideoFile').click());
        $('csVideoFile').addEventListener('change', (event) => {
            createFromFile(event.target.files && event.target.files[0]);
            event.target.value = '';
        });
        $('csPickVideo').addEventListener('click', () => openMediaPicker({
            kind: 'video',
            multiple: false,
            onPick: (entries) => createFromGenerated(entries[0])
        }));
        $('csMediaClose').addEventListener('click', closeMediaPicker);
        $('csMediaPicker').addEventListener('click', (event) => {
            if (event.target === $('csMediaPicker')) closeMediaPicker();
        });
        $('csMediaUpload').addEventListener('click', () => {
            const kind = mediaPickerKind;
            closeMediaPicker();
            if (kind === 'video') $('csVideoFile').click();
            else $('csRefFiles').click();
        });
        $('csMediaAdd').addEventListener('click', () => {
            if (!mediaPicker || !mediaPicker.selected.size || typeof mediaPickerCallback !== 'function') return;
            const picked = mediaPicker.entries.filter((entry) => mediaPicker.selected.has(entry.id));
            const callback = mediaPickerCallback;
            closeMediaPicker();
            callback(picked);
        });
        $('csAddPerson').addEventListener('click', async () => {
            if (!project) return;
            try {
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/people', {
                    method: 'POST',
                    body: '{}'
                });
                setProject(data);
            } catch (err) {
                setStatus(err.message, 'error');
            }
        });
        $('csTrimApply').addEventListener('click', async () => {
            if (!project) return;
            try {
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/trim', {
                    method: 'PATCH',
                    body: JSON.stringify({ start: Number($('csTrimStart').value), end: Number($('csTrimEnd').value) })
                });
                frame = 0;
                setProject(data);
                setStatus('Trim applied. Re-add anchors for the new range.', 'ok');
            } catch (err) { setStatus(err.message, 'error'); }
        });
        document.querySelectorAll('[data-cs-tool]').forEach((button) => {
            button.addEventListener('click', () => setTool(button.getAttribute('data-cs-tool')));
        });
        $('csBrushSize').addEventListener('input', () => { brushSize = Number($('csBrushSize').value); });
        $('csMaskOpacity').addEventListener('input', () => { maskOpacity = Number($('csMaskOpacity').value) / 100; drawMask(); });
        $('csMaskVisible').addEventListener('change', () => { maskVisible = $('csMaskVisible').checked; drawMask(); });
        $('csMaskSync').addEventListener('click', saveMaskSettings);
        ['csMaskGrow', 'csMaskFeather', 'csMaskTemporal'].forEach((id) => {
            $(id).addEventListener('change', saveMaskSettings);
        });
        $('csPrevFrame').addEventListener('click', () => {
            frame = Math.max(0, frame - 1);
            renderSource();
            loadFrame();
        });
        $('csNextFrame').addEventListener('click', () => {
            frame = Math.min(frames() - 1, frame + 1);
            renderSource();
            loadFrame();
        });
        $('csTimeline').addEventListener('input', () => {
            frame = Number($('csTimeline').value);
            renderSource();
            loadFrame();
        });
        $('csTrack').addEventListener('click', track);
        $('csRetrack').addEventListener('click', retrack);
        if ($('csDetect')) $('csDetect').addEventListener('click', detectPeople);
        if ($('csSelectionApply')) $('csSelectionApply').addEventListener('click', applySelection);
        $('csAddRefs').addEventListener('click', () => $('csRefFiles').click());
        $('csPickRefs').addEventListener('click', () => {
            const person = selectedPerson();
            const remaining = 9 - (person && person.refs ? person.refs.length : 0);
            if (remaining <= 0) {
                setStatus('This character already has the maximum of 9 reference images.', 'error');
                return;
            }
            openMediaPicker({
                kind: 'image',
                multiple: true,
                max: remaining,
                onPick: (entries) => addGeneratedReferences(entries)
            });
        });
        $('csRefFiles').addEventListener('change', (event) => {
            addReferences(event.target.files || []);
            event.target.value = '';
        });
        $('csDescribe').addEventListener('click', describe);
        $('csGenerateView').addEventListener('click', generateView);
        $('csGenerateSheet').addEventListener('click', generateSheet);
        $('csRender').addEventListener('click', () => render());
        $('csStartOver').addEventListener('click', startOver);
        document.querySelectorAll('[data-cs-engine]').forEach((button) => {
            button.addEventListener('click', () => switchEngine(button.getAttribute('data-cs-engine')));
        });
        const engineInputs = ['csWanDuration', 'csWanResolution', 'csWanSteps', 'csQuality'];
        engineInputs.forEach((id) => {
            const input = $(id);
            if (!input) return;
            input.addEventListener('change', saveEngineSettings);
        });
        if ($('csWanPrompt')) {
            $('csWanPrompt').addEventListener('change', saveEngineSettings);
            $('csWanPrompt').addEventListener('input', updateFlow);
        }

        const draw = $('csDrawCanvas');
        draw.addEventListener('pointerdown', async (event) => {
            if (!project || !selectedPerson()) return;
            const point = pointFromEvent(event);
            if (tool === 'select') {
                if (project.engine === 'wan_animate') {
                    await assignDetection(point);
                    return;
                }
                await addAnchor(point, event.shiftKey);
                return;
            }
            if (tool === 'include' || tool === 'exclude') {
                await pointEdit(point, tool === 'include');
                return;
            }
            dragging = true;
            strokePoints = [point];
            drawStroke(strokePoints, tool === 'erase');
            draw.setPointerCapture(event.pointerId);
        });
        draw.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const point = pointFromEvent(event);
            const last = strokePoints[strokePoints.length - 1];
            if (last && Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
            strokePoints.push(point);
            drawStroke([last || point, point], tool === 'erase');
        });
        draw.addEventListener('pointerup', async () => {
            if (!dragging) return;
            dragging = false;
            const points = strokePoints.slice();
            strokePoints = [];
            if (points.length) await saveStroke(points, tool === 'erase');
        });
        draw.addEventListener('pointercancel', () => {
            dragging = false;
            strokePoints = [];
            clearDrawing();
        });
        $('characterSwapClose').addEventListener('click', () => {
            $('characterSwapOverlay').hidden = true;
        });
    }

    async function open() {
        $('characterSwapOverlay').hidden = false;
        await loadEngines();
        try {
            const data = await api('/api/character-swap/projects');
            if (data.projects && data.projects.length) {
                setProject(data.projects[0]);
            } else {
                resetWorkspace();
            }
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function openWithVideo(filename, url) {
        $('characterSwapOverlay').hidden = false;
        await loadEngines();
        try {
            setStatus('Importing this clip into Character Swap…');
            const response = await fetch(url);
            if (!response.ok) throw new Error('The clip could not be loaded.');
            const blob = await response.blob();
            const file = new File([blob], filename || 'clip.mp4', { type: blob.type || 'video/mp4' });
            await createFromFile(file);
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function init() {
        if (!$('characterSwapOverlay')) return;
        bind();
        const button = $('chatCharacterSwap');
        if (button) button.addEventListener('click', open);
        setTool('select');
        loadEngines();
        window.addEventListener('resize', layoutCanvases);
        window.addEventListener('jarvis-generated-deleted', () => {
            if (project && $('characterSwapOverlay') && !$('characterSwapOverlay').hidden) refresh();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const picker = $('csMediaPicker');
            if (picker && !picker.hidden) {
                closeMediaPicker();
                return;
            }
            if (!$('characterSwapOverlay').hidden) {
                $('characterSwapOverlay').hidden = true;
            }
        });
    }

    return { init, open, openWithVideo };
})();

window.CharacterSwapUI = CharacterSwapUI;
