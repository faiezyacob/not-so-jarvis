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
    let engine = 'scail2';
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
    let bindingSelection = false;

    const $ = (id) => document.getElementById(id);

    const ENGINE_FEATURES = {
        scail2: {
            peopleSection: true,
            detection: true,
            maskSection: false,
            maskTuning: false,
            anchors: false,
            multiPerson: false,
            describe: false,
            referenceRoles: false,
            referenceViews: false
        },
        h3: {
            peopleSection: true,
            detection: false,
            maskSection: false,
            maskTuning: false,
            anchors: false,
            multiPerson: true,
            describe: true,
            referenceRoles: true,
            referenceViews: true
        }
    };

    function featuresFor(id) {
        return ENGINE_FEATURES[id] || ENGINE_FEATURES.h3;
    }

    function api(url, options = {}) {
        return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options))
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
                return data;
            });
    }

    let taskDepth = 0;

    function setStatus(text, kind) {
        const el = $('csStatus');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'character-swap-status' + (kind ? ' character-swap-status--' + kind : '') +
            (taskDepth > 0 ? ' character-swap-status--busy' : '');
    }

    const TASK_CONTROL_SELECTOR = '.character-swap-sidebar button, .character-swap-sidebar input, ' +
        '.character-swap-sidebar select, .character-swap-sidebar textarea, .character-swap-stage button';

    // Disable individual controls instead of making the whole panel inert:
    // the sidebar still needs to scroll while a render/detection is running.
    function lockTaskControls() {
        document.querySelectorAll(TASK_CONTROL_SELECTOR).forEach((el) => {
            if (el.dataset.taskWasDisabled === undefined) {
                el.dataset.taskWasDisabled = el.disabled ? '1' : '0';
            }
            el.disabled = true;
        });
    }

    function unlockTaskControls() {
        document.querySelectorAll(TASK_CONTROL_SELECTOR).forEach((el) => {
            if (el.dataset.taskWasDisabled !== undefined) {
                el.disabled = el.dataset.taskWasDisabled === '1';
                delete el.dataset.taskWasDisabled;
            }
        });
    }

    function beginTask(label) {
        taskDepth += 1;
        if (taskDepth > 1) return;
        const root = document.querySelector('.character-swap');
        if (root) root.classList.add('is-busy');
        lockTaskControls();
        const startOver = $('csStartOver');
        if (startOver) {
            startOver.dataset.taskWasDisabled = startOver.disabled ? '1' : '0';
            startOver.disabled = true;
        }
        if (label) setStatus(label);
    }

    function endTask() {
        if (taskDepth <= 0) return;
        taskDepth -= 1;
        if (taskDepth > 0) return;
        const root = document.querySelector('.character-swap');
        if (root) root.classList.remove('is-busy');
        unlockTaskControls();
        const startOver = $('csStartOver');
        if (startOver && startOver.dataset.taskWasDisabled !== undefined) {
            startOver.disabled = startOver.dataset.taskWasDisabled === '1';
            delete startOver.dataset.taskWasDisabled;
        }
        const status = $('csStatus');
        if (status) status.classList.remove('character-swap-status--busy');
        // The task lock froze every control's disabled state on the way in.
        // Recompute the real readiness now that the work has finished, or a
        // control that became available during the task (e.g. Render after
        // building the scene reference) would be restored to its stale
        // disabled state.
        updateFlow();
    }

    async function runTask(label, fn) {
        if (taskDepth > 0) {
            setStatus('Another step is still running. Wait for it to finish.', 'error');
            return null;
        }
        beginTask(label);
        try {
            return await fn();
        } catch (err) {
            setStatus(err.message, 'error');
            return null;
        } finally {
            endTask();
        }
    }

    async function waitForProjectReady(label) {
        let guard = 0;
        while (project && ['tracking', 'preparing', 'working'].includes(project.status) && guard < 240) {
            guard += 1;
            setStatus(project.activity || label || 'Working.');
            await new Promise((resolve) => setTimeout(resolve, 1500));
            try {
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id));
                setProject(data);
            } catch {
                break;
            }
        }
    }

    function engineInfo(id) {
        return (engines || []).find((item) => item.id === id) || null;
    }

    function engineLabel(id) {
        const info = engineInfo(id || engine);
        if (info) return info.label;
        if (id === 'h3') return 'MiniMax H3 Recast';
        return 'SCAIL-2';
    }

    function readScailSettings() {
        const duration = $('csWanDuration') ? $('csWanDuration').value : 'match';
        return {
            resolution: $('csWanResolution') ? $('csWanResolution').value : '480p',
            steps: Number($('csWanSteps').value),
            positive: $('csWanPrompt') ? $('csWanPrompt').value : '',
            // SAM 3.1 text detection is the only selectable flow; the clicked
            // mask is an automatic fallback when no description is available.
            sam3Mode: 'text',
            sam3VideoObject: $('csWanSam3Text') ? $('csWanSam3Text').value.trim() : '',
            sam3ImageObject: $('csWanSam3RefText') ? $('csWanSam3RefText').value.trim() : 'human',
            durationMode: duration === 'match' ? 'match' : 'fixed',
            durationSeconds: duration === 'match' ? null : Number(duration)
        };
    }

    function readH3Settings() {
        return {
            quality: $('csQuality') ? $('csQuality').value : 'full',
            h3Size: $('csH3Size') ? $('csH3Size').value : '',
            steps: Number($('csH3Steps') && $('csH3Steps').value) || 20,
            attention: $('csH3Attention') ? $('csH3Attention').value : 'auto',
            lipRepair: {
                person: Number($('csLipPerson') && $('csLipPerson').value) || 1,
                denoise: Number($('csLipDenoise') && $('csLipDenoise').value) || 0.35,
                steps: Number($('csLipSteps') && $('csLipSteps').value) || 20,
                facePick: $('csLipFacePick') ? $('csLipFacePick').value : 'position'
            }
        };
    }

    function collectEngineSettings() {
        const base = project && project.engineSettings ? JSON.parse(JSON.stringify(project.engineSettings)) : {};
        base.scail2 = Object.assign({}, base.scail2 || {}, readScailSettings());
        base.h3 = Object.assign({}, base.h3 || {}, readH3Settings());
        return base;
    }

    function applyEngineUI() {
        document.querySelectorAll('[data-cs-engine]').forEach((button) => {
            button.classList.toggle('active', button.getAttribute('data-cs-engine') === engine);
        });
        const active = project ? project.engine : engine;
        const features = featuresFor(active);
        const isScail = active === 'scail2';
        const isH3 = active === 'h3';
        if ($('csWanSettings')) $('csWanSettings').hidden = !isScail;
        if ($('csH3Settings')) $('csH3Settings').hidden = !isH3;
        if ($('csDetection')) $('csDetection').hidden = !features.detection;
        if ($('csSelectionApply')) $('csSelectionApply').hidden = features.detection;
        if ($('csPeopleSection')) $('csPeopleSection').hidden = !features.peopleSection;
        if ($('csMaskSection')) $('csMaskSection').hidden = !features.maskSection;
        if ($('csAddPerson')) $('csAddPerson').hidden = !features.multiPerson;
        if ($('csAutoPeople')) $('csAutoPeople').hidden = !isH3;
        if ($('csAnchors')) $('csAnchors').hidden = !features.anchors;
        if ($('csDescribe')) $('csDescribe').hidden = !features.describe;
        if ($('csDescription')) $('csDescription').hidden = !features.describe;
        if ($('csViewRow')) $('csViewRow').hidden = !features.referenceViews;
        if ($('csMaskFeatherField')) $('csMaskFeatherField').hidden = !features.maskTuning;
        if ($('csMaskTemporalField')) $('csMaskTemporalField').hidden = !features.maskTuning;
        if ($('csMaskFeather')) $('csMaskFeather').disabled = !features.maskTuning;
        if ($('csMaskTemporal')) $('csMaskTemporal').disabled = !features.maskTuning;
        if ($('csMaskHint')) {
            $('csMaskHint').textContent = 'Select: click the person (Shift-click excludes background). The tint is SAM�?Ts current mask �?" if it covers the scene, add exclude points. Track follows it through the clip. Brush/Eraser fix the tracked mask on the current frame. Keep Grow small (8�?"16); large growth paints a generated halo around the subject.';
        }
        if ($('csDetectionHint')) {
            $('csDetectionHint').textContent = isScail
                ? 'Detect every person, then click the one to replace. SCAIL-2 tracks that person with SAM 3.1 and never replaces the others.'
                : 'Optional: detect people to auto-place targets left-to-right. H3 Recast does not need detection - one character image and one line per person is enough.';
        }
        if ($('csTrack')) $('csTrack').textContent = 'Track';
        if ($('csRetrack')) $('csRetrack').textContent = 'Recalculate';
        const info = engineStatus[active] || null;
        const label = engineLabel(active);
        if ($('csEngineNote')) {
            $('csEngineNote').textContent = isScail
                ? 'SCAIL-2 uses the official replacement flow: SAM 3.1 finds the described person across the whole clip, colored driving/reference masks bind the identity, and the original audio is kept. Click one person to target them; Shift-click adds another.'
                : 'H3 Recast swaps up to three people in one pass with the BFS Character Swap LoRA. It needs one edited scene-reference frame plus one character image and one line per person (no detection required), keeps the clip motion, set and audio, and can run an optional FaceRefine lip pass on a finished take.';
        }
        if ($('csAddRefs')) $('csAddRefs').textContent = features.referenceViews ? 'Upload images' : 'Upload image';
        if ($('csRefFiles')) $('csRefFiles').multiple = features.referenceViews;
        if ($('csCharacterHint')) {
            $('csCharacterHint').textContent = isScail
                ? 'SCAIL-2 uses one clear character image as the replacement identity. A portrait or full-body photo on a plain background works best.'
                : 'Upload one clear portrait per person. H3 Recast edits those identities into the scene reference; extra front/full-body views help that edit.';
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
                    (isScail ? ' You can still switch to MiniMax H3 manually.' : '');
            } else {
                warning.hidden = true;
                warning.textContent = '';
            }
        }
        if ($('csTrimHint')) {
            $('csTrimHint').textContent = isH3
                ? 'H3 Recast renders up to 15 seconds. Trim the clip and detect the people again before rendering.'
                : label + ' matches the original clip length, capped at 15 seconds. Longer imports are trimmed to the selected range.';
        }
        if ($('csTrimEnd')) $('csTrimEnd').max = '15';
        if ($('csRender')) $('csRender').textContent = isH3 ? 'Render H3 Recast' : 'Render';
        updateSectionLabels(features);
        applyToolClass();
        applySettingsToForm();
        if (project) updateMaskInputs();
    }

    function updateSectionLabels(features) {
        let index = 1;
        if ($('csSourceTitle')) $('csSourceTitle').textContent = index + ' · SOURCE';
        index += 1;
        if (features.peopleSection && $('csPeopleTitle')) {
            $('csPeopleTitle').textContent = index + ' · PEOPLE';
            index += 1;
        }
        if (features.maskSection && $('csMaskTitle')) {
            $('csMaskTitle').textContent = index + ' · TRACK & MASK';
            index += 1;
        }
        if ($('csCharacterTitle')) $('csCharacterTitle').textContent = index + ' · CHARACTER';
        index += 1;
        if ($('csGenerateTitle')) $('csGenerateTitle').textContent = index + ' · GENERATE';
    }


    function applySettingsToForm() {
        const settings = (project && project.engineSettings) || {};
        const wan = settings.scail2 || {};
        if ($('csWanResolution')) $('csWanResolution').value = wan.resolution === '720p' ? '720p' : '480p';
        if ($('csWanSteps')) $('csWanSteps').value = String(wan.steps || 6);
        if ($('csWanPrompt')) $('csWanPrompt').value = wan.positive || '';
        if ($('csWanSam3Text')) $('csWanSam3Text').value = wan.sam3VideoObject || '';
        if ($('csWanSam3RefText')) $('csWanSam3RefText').value = wan.sam3ImageObject || 'human';
        if ($('csWanDuration')) {
            const fixed = wan.durationMode === 'fixed' && ['5', '10', '15'].includes(String(wan.durationSeconds));
            $('csWanDuration').value = fixed ? String(wan.durationSeconds) : 'match';
        }
        const h3 = settings.h3 || {};
        if ($('csQuality')) $('csQuality').value = h3.quality || 'full';
        if ($('csH3Size')) $('csH3Size').value = ['S', 'M', 'L', 'XL'].includes(h3.h3Size) ? h3.h3Size : 'L';
        if ($('csH3Steps')) $('csH3Steps').value = String(h3.steps || 20);
        if ($('csH3Attention')) {
            const attention = ['comfy kitchen attention', 'pytorch attention'].includes(h3.attention) ? h3.attention : 'auto';
            $('csH3Attention').value = attention;
        }
        const lip = h3.lipRepair || {};
        if ($('csLipPerson')) $('csLipPerson').value = String(Math.max(1, Math.min(3, Number(lip.person) || 1)));
        if ($('csLipDenoise')) $('csLipDenoise').value = String(Number(lip.denoise) || 0.35);
        if ($('csLipSteps')) $('csLipSteps').value = String(Number(lip.steps) || 20);
        if ($('csLipFacePick')) $('csLipFacePick').value = lip.facePick === 'identity' ? 'identity' : 'position';
        const scene = h3.sceneReference || null;
        if ($('csSceneFrame')) {
            $('csSceneFrame').max = project && project.part ? String(Math.max(0, Number(project.part.frames) - 1)) : '0';
            if (scene && Number.isFinite(Number(scene.frame))) $('csSceneFrame').value = String(scene.frame);
        }
        if ($('csSceneRefPreview')) {
            const url = project && project.sceneReferenceUrl
                ? project.sceneReferenceUrl + (scene && scene.createdAt ? '?v=' + encodeURIComponent(scene.createdAt) : '?v=' + Date.now())
                : '';
            $('csSceneRefPreview').hidden = !url;
            if (url) $('csSceneRefPreview').src = url;
        }
        if ($('csSceneRefMeta')) {
            $('csSceneRefMeta').textContent = (scene && project && project.sceneReferenceUrl)
                ? 'Scene reference ready' + (scene.frame !== null && scene.frame !== undefined ? ' (frame ' + scene.frame + ')' : '') +
                    (scene.width ? ' - ' + scene.width + 'x' + scene.height : '') + '.'
                : 'No scene reference yet. Select the people to replace, then build it from the clip.';
        }
    }

    async function loadEngines() {
        try {
            const data = await api('/api/character-swap/engines');
            engines = Array.isArray(data.engines) ? data.engines : [];
            engineStatus = {};
            engines.forEach((item) => { engineStatus[item.id] = item; });
            if (!engineStatus[engine]) engine = data.default || 'scail2';
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
            engine = project.engine || 'scail2';
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
            updateFlow();
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
        if (project.engine === 'scail2') return false;
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
        if (project.engine === 'scail2') {
            // The project is the source of truth: only bound tracks stay selected,
            // so removing a target can never leak its track back into the next
            // selection request.
            detectionSelection = new Set((project.people || [])
                .map((person) => person.selectionId)
                .filter((id) => id && ids.has(id)));
            return;
        }
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
            card.title = (engine === 'scail2' || engine === 'h3')
                ? 'Click to replace with this person only (Shift-click adds another target, up to three). Remove a target with the x on its person card.'
                : '';
            card.addEventListener('click', (event) => {
                if (bindingSelection) return;
                if (engine === 'scail2' || engine === 'h3') {
                    const owner = (project.people || []).find((person) => person.selectionId === track.id);
                    if (owner) {
                        selectedPersonId = owner.id;
                        renderAll();
                        setStatus(owner.label + ' is focused. Add its character image below.', 'ok');
                        return;
                    }
                    // A plain click targets exactly one person. This prevents a
                    // previously clicked target from staying bound and turning a
                    // single-character request into two replacement passes.
                    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) detectionSelection.clear();
                    detectionSelection.add(track.id);
                    applySelectionTask(track.id);
                    return;
                }
                if (detectionSelection.has(track.id)) {
                    detectionSelection.delete(track.id);
                } else {
                    detectionSelection.add(track.id);
                }
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
            await waitForProjectReady('Detecting people.');
            if (project && project.status === 'ready') setStatus('Detection complete.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function applySelection(focusTrackId) {
        if (!project || bindingSelection) return;
        const trackIds = Array.from(detectionSelection);
        if (!trackIds.length) {
            setStatus('Select at least one detected person.', 'error');
            return;
        }
        bindingSelection = true;
        try {
            setStatus('Binding the selected people…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/selection/select', {
                method: 'POST',
                body: JSON.stringify({ trackIds })
            });
            // Focus the person record for the track just clicked so the next
            // character image uploads to that person, not the previous one.
            const targets = (data.people || []).filter((person) => person.selectionId);
            const focus = (focusTrackId && targets.find((person) => person.selectionId === focusTrackId))
                || targets[targets.length - 1];
            if (focus) selectedPersonId = focus.id;
            setProject(data);
            if (engine === 'scail2' || engine === 'h3') {
                const missing = targets.filter((person) => !(person.refs || []).length);
                setStatus(targets.length > 1
                    ? targets.length + ' targets selected. Reading the subjects' +
                        (missing.length ? ', add a character image for ' + missing[0].label + '.' : '.')
                    : 'Target selected. Reading the subject, add one character image next.', 'ok');
                await describeSubject();
            } else {
                setStatus('Selected ' + trackIds.length + ' person' + (trackIds.length === 1 ? '' : 's') + '. Add a character image, then build the scene reference.', 'ok');
            }
        } catch (err) {
            setStatus(err.message, 'error');
        } finally {
            bindingSelection = false;
        }
    }

    // Runs right after a target is selected so the SCAIL-2 prompt can lead with
    // a description of that subject. Fire-and-forget: the render endpoint holds
    // the turn queue and will finish the description itself if this is missed.
    async function describeSubject() {
        if (!project) return;
        const projectId = project.id;
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(projectId) + '/selection/describe', {
                method: 'POST',
                body: '{}'
            });
            if (project && project.id === projectId) setProject(data);
            const status = $('csStatus');
            if (status && /Reading the subject/.test(status.textContent || '')) {
                const targets = ((project && project.people) || []).filter((person) => person.selectionId);
                const missing = targets.filter((person) => !(person.refs || []).length);
                setStatus(targets.length > 1
                    ? targets.length + ' targets selected. Subjects described' +
                        (missing.length ? ', add a character image for ' + missing[0].label + '.' : '.')
                    : 'Target selected. Subject described. Add one character image, then press Render.', 'ok');
            }
        } catch {
            // Fail-open: the render path retries the description.
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
        engine = project.engine || 'scail2';
        if (!project.people.some((person) => person.id === selectedPersonId)) {
            selectedPersonId = project.people[0] ? project.people[0].id : null;
        }
        frame = Math.max(0, Math.min(frames() - 1, frame));
        renderAll();
        applyEngineUI();
        if (taskDepth > 0) lockTaskControls();
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
        const projectEngine = project ? project.engine : engine;
        const isScail = projectEngine === 'scail2';
        let text = '';
        let target = null;
        if (!project) {
            text = 'Step 1 — Import a video.';
        } else if (project.status === 'tracking' || project.status === 'working') {
            text = 'Working — ' + (project.activity || 'processing the clip') + '…';
        } else if (isScail) {
            const tracks = (project.selection && project.selection.tracks) || [];
            const targets = (project.people || []).filter((item) => item.selectionId);
            const missingReference = targets.filter((item) => !(item.refs || []).length);
            if (!tracks.length) {
                text = 'Step 2 — Detect the people in the clip.';
                target = $('csDetect');
            } else if (!targets.length) {
                text = 'Step 3 — Click the person you want to replace (Shift-click adds a second target).';
                target = $('csDetections');
            } else if (missingReference.length) {
                text = 'Step 4 — Upload one character image for ' + missingReference[0].label +
                    (targets.length > 1 ? ' (repeat for every selected person)' : '') + '.';
                target = $('csAddRefs');
            } else {
                text = targets.length > 1
                    ? 'Ready - render ' + targets.length + ' replacements in one video.'
                    : 'Ready - render with SCAIL-2.';
                target = $('csRender');
            }
        } else if (projectEngine === 'h3') {
            const tracks = (project.selection && project.selection.tracks) || [];
            const targets = (project.people || []).filter((item) =>
                (item.refs || []).length && (tracks.length ? item.selectionId : true));
            const unbound = tracks.length
                ? (project.people || []).filter((item) => (item.refs || []).length && !item.selectionId)
                : [];
            const missingReference = (project.people || []).filter((item) =>
                item.selectionId && !(item.refs || []).length);
            const scene = Boolean(project.sceneReferenceUrl);
            if (!targets.length && unbound.length) {
                text = 'Click the person in the clip you want to replace with this character image, then build the scene reference.';
                target = $('csDetections');
            } else if (!scene) {
                text = targets.length
                    ? 'Step 4 - Build the scene reference from the clip, or upload one you edited.'
                    : 'Step 2 - Optional: upload a character image to replace someone, or build the scene reference from the clip as-is.';
                if (missingReference.length) {
                    text += ' ' + missingReference[0].label + ' has no character image yet and will stay unchanged.';
                }
                target = $('csBuildScene');
            } else if (targets.length) {
                text = 'Ready - render H3 Recast. Lip repair can be run on the take afterwards.';
                target = $('csRender');
            } else {
                text = 'Scene reference ready. Upload a character image for a person to enable rendering.';
                target = $('csAddRefs');
            }
        } else if (!person || !person.anchors.length) {
            text = 'Step 2 - Choose Select, then click directly on the person you want to replace. Click again to add points.';
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
        ['csDetect', 'csSelectionApply', 'csTools', 'csTrack', 'csAddRefs', 'csDescribe', 'csGenerateView', 'csGenerateSheet', 'csWanPrompt', 'csBuildScene', 'csRender'].forEach((id) => {
            const button = $(id);
            if (button) button.classList.remove('is-next');
        });
        if (target) target.classList.add('is-next');
        const scailTargets = project ? (project.people || []).filter((item) => item.selectionId) : [];
        const scailReady = Boolean(project && scailTargets.length &&
            scailTargets.every((item) => (item.refs || []).length) &&
            (project.selection && (project.selection.tracks || []).length));
        const hasTracks = Boolean(project && project.selection && (project.selection.tracks || []).length);
        const h3Targets = project
            ? (project.people || []).filter((item) => (item.refs || []).length && (!hasTracks || item.selectionId))
            : [];
        const h3Ready = Boolean(project && project.sceneReferenceUrl && h3Targets.length);
        const ready = isScail ? scailReady : h3Ready;
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
        if (project && project.engine === 'scail2') {
            bits.push(person.selectionId ? 'replacement target' : 'unassigned');
        } else {
            const tracked = Boolean(project && project.selection && (project.selection.tracks || []).length);
            if (person.selectionId) bits.push('detected target');
            else if (tracked && person.refs.length) bits.push('not selected');
            else if (person.refs.length) bits.push('target');
            else if (person.h3Line) bits.push('unchanged (line only)');
            else bits.push('add a character image');
            if (person.h3Line) bits.push('line set');
        }
        if (person.refs.length) bits.push(person.refs.length + ' refs');
        meta.textContent = bits.join(' · ');
        text.appendChild(name);
        text.appendChild(meta);
        button.appendChild(dot);
        button.appendChild(text);
        button.addEventListener('click', () => {
            selectedPersonId = person.id;
            if (project && project.engine === 'scail2') frame = 0;
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
            if (project.engine === 'h3') {
                const lineWrap = document.createElement('div');
                lineWrap.className = 'character-swap-person-line';
                const input = document.createElement('input');
                input.type = 'text';
                input.value = person.h3Line || '';
                input.placeholder = 'the woman in the red dress becomes an old woman with long silver hair';
                input.title = 'One line per person, left to right. Use "becomes" (or turns into, ->, =) to split who they are now from their new look.';
                input.addEventListener('change', async () => {
                    try {
                        const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id), {
                            method: 'PATCH',
                            body: JSON.stringify({ h3Line: input.value })
                        });
                        setProject(data);
                    } catch (err) {
                        setStatus(err.message, 'error');
                    }
                });
                lineWrap.appendChild(input);
                row.appendChild(lineWrap);
            }
            host.appendChild(row);
        });
        const person = selectedPerson();
        if (project.engine === 'scail2') {
            $('csTrack').disabled = true;
            $('csRetrack').disabled = false;
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
        const features = featuresFor(project && project.engine);
        if (!person.refs.length) {
            const empty = document.createElement('div');
            empty.className = 'character-swap-hint';
            empty.textContent = features.referenceRoles
                ? 'Add front, side, back or close-up views. A plain-background sheet is split automatically.'
                : 'Add one clear character image.';
            host.appendChild(empty);
            return;
        }
        person.refs.forEach((ref) => {
            const card = document.createElement('div');
            card.className = 'character-swap-ref';
            const img = document.createElement('img');
            img.src = ref.url;
            img.alt = ref.role || 'reference';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'character-swap-ref-remove';
            remove.textContent = '×';
            remove.title = 'Remove reference';
            remove.setAttribute('aria-label', 'Remove reference');
            remove.addEventListener('click', async () => {
                try {
                    const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/ref/' + encodeURIComponent(ref.id), { method: 'DELETE' });
                    setProject(data);
                } catch (err) { setStatus(err.message, 'error'); }
            });
            card.appendChild(img);
            card.appendChild(remove);
            if (features.referenceRoles) {
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
                controls.appendChild(select);
                card.appendChild(controls);
            }
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
            badge.textContent = take.engine === 'h3'
                ? 'H3 RECAST'
                : (take.engine === 'scail2' ? 'SCAIL-2' : String(take.engine || 'CHARACTER SWAP').toUpperCase());
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
                    take.upscaleError ? 'upscale failed' : '',
                    take.lipRepair ? 'lip repaired p' + take.lipRepair.person : ''
                ].filter(Boolean);
                meta.textContent = bits.join(' - ');
            }
            card.appendChild(meta);
            if (take.engine === 'h3' && take.url && take.status !== 'failed') {
                const lipRow = document.createElement('div');
                lipRow.className = 'character-swap-take-lip';
                const refine = document.createElement('button');
                refine.type = 'button';
                refine.className = 'character-swap-btn';
                refine.textContent = take.lipRepair ? 'Refine lip again' : 'Refine lip';
                refine.title = 'Run the FaceRefine lip pass on this cached H3 Recast take';
                refine.addEventListener('click', () => {
                    const person = Number($('csLipPerson') && $('csLipPerson').value) || 1;
                    renderTask({ refineTakeId: take.takeId, lipPerson: person });
                });
                lipRow.appendChild(refine);
                if (take.lipRepair && take.lipRepair.sourceUrl) {
                    const original = document.createElement('a');
                    original.href = take.lipRepair.sourceUrl;
                    original.target = '_blank';
                    original.rel = 'noreferrer';
                    original.textContent = 'Original';
                    lipRow.appendChild(original);
                }
                card.appendChild(lipRow);
            }
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
                    // Window redo is an H3-only resume path; SCAIL-2 passes are
                    // rebuilt as a whole take.
                    (take.engine === 'h3' && take.engine === engine ? wins : []).forEach((entry) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'character-swap-window-redo';
                        button.title = 'Regenerate this window and every later window';
                        button.textContent = '↻ ' + (entry.index + 1);
                        button.addEventListener('click', () => renderTask({
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
                resume.addEventListener('click', () => renderTask({ resumeTakeId: take.takeId }));
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
                    engine,
                    conversationId
                })
            });
            frame = 0;
            setProject(data);
            setStatus('Clip ready. Upload a character image to start.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function addGeneratedReferences(entries) {
        if (!project || !entries.length) return;
        let person = selectedPerson();
        if (!person) {
            const created = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/people', { method: 'POST', body: '{}' });
            setProject(created);
            person = selectedPerson();
        }
        if (!person) return;
        try {
            for (const entry of entries) {
                setStatus('Adding generated image…');
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/person/' + encodeURIComponent(person.id) + '/refs', {
                    method: 'POST',
                    body: JSON.stringify({ filename: generatedFilename(entry), source: 'generated' })
                });
                setProject(data);
            }
            const hasTracks = Boolean(project && project.selection && project.selection.tracks && project.selection.tracks.length);
            if (project && project.engine === 'h3') {
                if (!hasTracks) {
                    await autoPeople();
                } else {
                    // Detection already ran. Describe the newly bound character so
                    // the person line gains its target, then rebuild the scene.
                    try {
                        const described = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/describe', { method: 'POST', body: '{}' });
                        setProject(described);
                    } catch {
                        // Fail-open: rendering will describe the character.
                    }
                    setStatus('Character added. Build the scene reference again before rendering.', 'ok');
                }
            } else {
                setStatus('References added.', 'ok');
            }
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

    function applyToolClass() {
        const wrap = $('csCanvasWrap');
        if (!wrap) return;
        const enabled = featuresFor(project ? project.engine : engine).maskSection;
        wrap.classList.toggle('is-select', enabled && tool === 'select');
        wrap.classList.toggle('is-brush', enabled && (tool === 'brush' || tool === 'erase'));
        wrap.classList.toggle('is-point', enabled && (tool === 'include' || tool === 'exclude'));
        const draw = $('csDrawCanvas');
        if (draw) draw.style.cursor = enabled && tool === 'select' ? 'crosshair' : '';
    }

    function setTool(next) {
        tool = next;
        document.querySelectorAll('[data-cs-tool]').forEach((button) => {
            button.classList.toggle('active', button.getAttribute('data-cs-tool') === next);
        });
        applyToolClass();
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
            setStatus('Preparing the clip…');
            const conversationId = window.Conversations && typeof window.Conversations.currentId === 'function'
                ? window.Conversations.currentId()
                : null;
            const data = await api('/api/character-swap/projects', {
                method: 'POST',
                body: JSON.stringify({
                    filename: uploaded.filename,
                    title: file.name,
                    engine,
                    conversationId
                })
            });
            frame = 0;
            setProject(data);
            setStatus('Clip ready. Upload a character image to start.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function addReferences(files) {
        if (!project || !files.length) return;
        let person = selectedPerson();
        if (!person) {
            const created = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/people', { method: 'POST', body: '{}' });
            setProject(created);
            person = selectedPerson();
        }
        if (!person) return;
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
            const hasTracks = Boolean(project && project.selection && project.selection.tracks && project.selection.tracks.length);
            if (project && project.engine === 'h3') {
                if (!hasTracks) {
                    await autoPeople();
                } else {
                    // Detection already ran. Describe the newly bound character so
                    // the person line gains its target, then rebuild the scene.
                    try {
                        const described = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/describe', { method: 'POST', body: '{}' });
                        setProject(described);
                    } catch {
                        // Fail-open: rendering will describe the character.
                    }
                    setStatus('Character added. Build the scene reference again before rendering.', 'ok');
                }
            } else {
                setStatus('References added.', 'ok');
            }
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function autoPeople() {
        if (!project || project.engine !== 'h3') return;
        const projectId = project.id;
        let stopped = false;
        const poll = setInterval(async () => {
            if (stopped) return;
            try {
                const current = await api('/api/character-swap/projects/' + encodeURIComponent(projectId));
                if (current.activity) setStatus(current.activity);
            } catch {
                // The request below owns the final status/error.
            }
        }, 1500);
        try {
            setStatus('Detecting the people in the clip and writing the replacement lines. This uses DWPose and the local vision model.');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(projectId) + '/auto-people', {
                method: 'POST',
                body: JSON.stringify({ provider: project.provider, model: project.model })
            });
            setProject(data);
            setStatus('People detected. Add a character image to the person(s) you want to replace (or leave them unbound to keep them), then build the scene reference.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        } finally {
            stopped = true;
            clearInterval(poll);
        }
    }

    async function buildScene() {
        if (!project) return;
        const button = $('csBuildScene');
        if (button) button.disabled = true;
        try {
            setStatus('Building the scene reference from the clip. People with a character image are edited in; the rest stay unchanged.');
            const rawFrame = $('csSceneFrame') ? $('csSceneFrame').value : '';
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/scene', {
                method: 'POST',
                body: JSON.stringify({
                    frame: rawFrame === '' ? frame : Number(rawFrame)
                })
            });
            setProject(data);
            setStatus('Scene reference ready. Review it, then render.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function uploadSceneFile(file) {
        if (!file || !project) return;
        try {
            setStatus('Uploading the scene reference.');
            const uploaded = await uploadFile(file);
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/scene/upload', {
                method: 'POST',
                body: JSON.stringify({ filename: uploaded.filename })
            });
            setProject(data);
            setStatus('Scene reference uploaded.', 'ok');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    function pickScene() {
        openMediaPicker({
            kind: 'image',
            multiple: false,
            onPick: async (entries) => {
                const entry = entries[0];
                if (!entry || !project) return;
                await runTask('Setting the scene reference.', async () => {
                    try {
                        const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/scene/upload', {
                            method: 'POST',
                            body: JSON.stringify({ filename: generatedFilename(entry) })
                        });
                        setProject(data);
                        setStatus('Scene reference set from the gallery.', 'ok');
                    } catch (err) {
                        setStatus(err.message, 'error');
                    }
                });
            }
        });
    }

    async function clearScene() {
        if (!project) return;
        try {
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/scene', {
                method: 'DELETE'
            });
            setProject(data);
            setStatus('Scene reference cleared.', 'ok');
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
        const person = selectedPerson();
        if (!person || !person.anchors.length) return;
        try {
            setStatus('Tracking the selected people…');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/track', { method: 'POST', body: '{}' });
            setProject(data);
            await waitForProjectReady('Tracking the selected people.');
        } catch (err) {
            setStatus(err.message, 'error');
        }
    }

    async function retrack() {
        if (engine === 'scail2' || (project && project.engine === 'scail2')) {
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
        const isRefine = Boolean(options.refineTakeId);
        try {
            setStatus(isRefine
                ? 'Refining the selected face from the cached take�?�'
                : (engine === 'scail2' ? 'Preparing the SCAIL-2 replacement�?�' : 'Preparing the H3 Recast render�?�'));
            const settings = collectEngineSettings();
            const response = await fetch('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    engine: isRefine ? 'h3' : engine,
                    quality: $('csQuality') ? $('csQuality').value : 'full',
                    takes: Number($('csTakeCount').value),
                    resumeTakeId: options.resumeTakeId || null,
                    redoWindow: options.redoWindow || null,
                    refineTakeId: options.refineTakeId || null,
                    lipPerson: options.lipPerson || null,
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
                        setStatus(payload.refined
                            ? 'Lip repair complete. The original take is still available.'
                            : 'Take ' + payload.take.seed + ' complete.', 'ok');
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

    const autoPeopleTask = () => runTask('Detecting people and writing the replacement lines.', autoPeople);
    const detectPeopleTask = () => runTask('Detecting people with DWPose.', detectPeople);
    const applySelectionTask = (focusTrackId) => runTask('Binding the selected people.', () => applySelection(focusTrackId));
    const describeTask = () => runTask('Describing the character.', describe);
    const addReferencesTask = (files) => runTask('Adding reference images.', () => addReferences(files));
    const addGeneratedReferencesTask = (entries) => runTask('Adding reference images.', () => addGeneratedReferences(entries));
    const createFromFileTask = (file) => runTask('Preparing the clip.', () => createFromFile(file));
    const createFromGeneratedTask = (entry) => runTask('Preparing the clip.', () => createFromGenerated(entry));
    const buildSceneTask = () => runTask('Building the scene reference.', buildScene);
    const uploadSceneFileTask = (file) => runTask('Uploading the scene reference.', () => uploadSceneFile(file));
    const clearSceneTask = () => runTask('Clearing the scene reference.', clearScene);
    const renderTask = (options) => runTask(
        options && options.refineTakeId ? 'Refining the selected face.' : 'Rendering the character swap.',
        () => render(options)
    );
    const generateViewTask = () => runTask('Generating the reference view.', generateView);
    const generateSheetTask = () => runTask('Generating the reference sheet.', generateSheet);
    const trackTask = () => runTask('Tracking the selected people.', track);
    const retrackTask = () => runTask('Recalculating the tracking.', retrack);
    const saveMaskSettingsTask = () => runTask('Saving the mask settings.', saveMaskSettings);
    const switchEngineTask = (next) => runTask('Switching the engine.', () => switchEngine(next));
    const saveEngineSettingsTask = () => runTask('Saving the engine settings.', saveEngineSettings);
    const startOverTask = () => runTask('Starting over.', startOver);

    function bind() {
        $('csChooseVideo').addEventListener('click', () => $('csVideoFile').click());
        $('csVideoFile').addEventListener('change', (event) => {
            createFromFileTask(event.target.files && event.target.files[0]);
            event.target.value = '';
        });
        $('csPickVideo').addEventListener('click', () => openMediaPicker({
            kind: 'video',
            multiple: false,
            onPick: (entries) => createFromGeneratedTask(entries[0])
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
        if ($('csAutoPeople')) $('csAutoPeople').addEventListener('click', autoPeopleTask);
        $('csAddPerson').addEventListener('click', async () => {
            if (!project) return;
            try {
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/people', {
                    method: 'POST',
                    body: '{}'
                });
                if (data.people && data.people.length) selectedPersonId = data.people[data.people.length - 1].id;
                setProject(data);
            } catch (err) {
                setStatus(err.message, 'error');
            }
        });
        $('csTrimApply').addEventListener('click', () => runTask('Applying the trim.', async () => {
            if (!project) return;
            try {
                const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/trim', {
                    method: 'PATCH',
                    body: JSON.stringify({ start: Number($('csTrimStart').value), end: Number($('csTrimEnd').value) })
                });
                frame = 0;
                setProject(data);
                setStatus(featuresFor(project && project.engine).anchors
                    ? 'Trim applied. Re-add anchors for the new range.'
                    : 'Trim applied.', 'ok');
            } catch (err) { setStatus(err.message, 'error'); }
        }));
        document.querySelectorAll('[data-cs-tool]').forEach((button) => {
            button.addEventListener('click', () => setTool(button.getAttribute('data-cs-tool')));
        });
        $('csBrushSize').addEventListener('input', () => { brushSize = Number($('csBrushSize').value); });
        $('csMaskOpacity').addEventListener('input', () => { maskOpacity = Number($('csMaskOpacity').value) / 100; drawMask(); });
        $('csMaskVisible').addEventListener('change', () => { maskVisible = $('csMaskVisible').checked; drawMask(); });
        $('csMaskSync').addEventListener('click', saveMaskSettingsTask);
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
        $('csTrack').addEventListener('click', trackTask);
        $('csRetrack').addEventListener('click', retrackTask);
        if ($('csDetect')) $('csDetect').addEventListener('click', detectPeopleTask);
        if ($('csSelectionApply')) $('csSelectionApply').addEventListener('click', applySelectionTask);
        $('csAddRefs').addEventListener('click', () => $('csRefFiles').click());
        $('csPickRefs').addEventListener('click', () => {
            const person = selectedPerson();
            const features = featuresFor(project && project.engine);
            const limit = features.referenceRoles ? 9 : 1;
            const remaining = limit - (person && person.refs ? person.refs.length : 0);
            if (remaining <= 0) {
                setStatus('This character already has the maximum of ' + limit + ' reference image' + (limit === 1 ? '' : 's') + '.', 'error');
                return;
            }
            openMediaPicker({
                kind: 'image',
                multiple: features.referenceRoles,
                max: remaining,
                onPick: (entries) => addGeneratedReferencesTask(entries)
            });
        });
        $('csRefFiles').addEventListener('change', (event) => {
            addReferencesTask(event.target.files || []);
            event.target.value = '';
        });
        $('csDescribe').addEventListener('click', describeTask);
        $('csGenerateView').addEventListener('click', generateViewTask);
        $('csGenerateSheet').addEventListener('click', generateSheetTask);
        $('csRender').addEventListener('click', () => renderTask());
        if ($('csBuildScene')) $('csBuildScene').addEventListener('click', buildSceneTask);
        if ($('csUploadScene')) $('csUploadScene').addEventListener('click', () => $('csSceneFile').click());
        if ($('csSceneFile')) $('csSceneFile').addEventListener('change', (event) => {
            uploadSceneFileTask(event.target.files && event.target.files[0]);
            event.target.value = '';
        });
        if ($('csPickScene')) $('csPickScene').addEventListener('click', pickScene);
        if ($('csClearScene')) $('csClearScene').addEventListener('click', clearSceneTask);
        $('csStartOver').addEventListener('click', startOverTask);
        document.querySelectorAll('[data-cs-engine]').forEach((button) => {
            button.addEventListener('click', () => switchEngineTask(button.getAttribute('data-cs-engine')));
        });
        const engineInputs = [
            'csWanDuration', 'csWanResolution', 'csWanSteps', 'csQuality',
            'csWanSam3Text', 'csWanSam3RefText',
            'csH3Size', 'csH3Steps', 'csH3Attention', 'csLipPerson',
            'csLipDenoise', 'csLipSteps', 'csLipFacePick'
        ];
        engineInputs.forEach((id) => {
            const input = $(id);
            if (!input) return;
            input.addEventListener('change', saveEngineSettingsTask);
        });
        if ($('csWanPrompt')) {
            $('csWanPrompt').addEventListener('change', saveEngineSettingsTask);
            $('csWanPrompt').addEventListener('input', updateFlow);
        }
        const draw = $('csDrawCanvas');
        draw.addEventListener('pointerdown', async (event) => {
            if (!project || !selectedPerson()) return;
            if (!featuresFor(project.engine).maskSection) return;
            const point = pointFromEvent(event);
            if (tool === 'select') {
                if (project.engine === 'scail2') {
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
            await createFromFileTask(file);
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
