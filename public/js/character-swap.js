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
    let highlightRequest = 0;
    let detectionOverlay = null;
    let detectionOverlayKey = '';
    let detectionOverlayPromise = null;
    const DETECTION_PALETTE = ['#6CFF9A', '#5FC8FF', '#FFB56B', '#FF8FD0', '#C8A6FF', '#FFE066', '#7DF0D0', '#FF9B8A'];

    const $ = (id) => document.getElementById(id);

    // Last-used workspace settings, kept per device so reopening the workspace
    // or starting a new clip never silently falls back to defaults.
    const PREF_KEY = 'jarvis-character-swap-prefs';

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

    // Only the workflow buttons are locked while a step runs. Inputs, the
    // timeline, the video and the local selection tools stay usable so the
    // user can keep reviewing/scrubbing the clip during a render.
    const TASK_CONTROL_SELECTOR = '.character-swap-sidebar .character-swap-btn, ' +
        '.character-swap-sidebar [data-cs-engine], ' +
        '.character-swap-stage .character-swap-btn:not(#csPrevFrame):not(#csNextFrame), ' +
        '.character-swap-stage .character-swap-take-delete';

    // Disable the action buttons instead of making the whole panel inert:
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
            attention: $('csH3Attention') ? $('csH3Attention').value : 'auto'
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
            $('csMaskHint').textContent = 'Select: click the person (Shift-click excludes background). The tint is SAM’s current mask — if it covers the scene, add exclude points. Track follows it through the clip. Brush/Eraser fix the tracked mask on the current frame. Keep Grow small (8–16); large growth paints a generated halo around the subject.';
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
                : 'H3 Recast swaps up to three people in one pass with the BFS Character Swap LoRA. It needs one edited scene-reference frame plus one character image and one line per person (no detection required), keeps the clip motion, set and audio, and refines lip sync automatically before upscaling.';
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
                ? 'H3 Recast renders up to 15 seconds. Pick the window to swap, then detect the people again before rendering.'
                : label + ' renders up to 15 seconds. Pick any window of the clip; the preview and frame timeline use the trimmed range.';
        }
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


    function applyScailSettings(wan) {
        const settings = wan || {};
        if ($('csWanResolution')) $('csWanResolution').value = settings.resolution === '720p' ? '720p' : '480p';
        if ($('csWanSteps')) $('csWanSteps').value = String(settings.steps || 6);
        if ($('csWanPrompt')) $('csWanPrompt').value = settings.positive || '';
        if ($('csWanSam3Text')) $('csWanSam3Text').value = settings.sam3VideoObject || '';
        if ($('csWanSam3RefText')) $('csWanSam3RefText').value = settings.sam3ImageObject || 'human';
        if ($('csWanDuration')) {
            const fixed = settings.durationMode === 'fixed' && ['5', '10', '15'].includes(String(settings.durationSeconds));
            $('csWanDuration').value = fixed ? String(settings.durationSeconds) : 'match';
        }
    }

    function applyH3Settings(h3) {
        const settings = h3 || {};
        if ($('csQuality')) $('csQuality').value = settings.quality || 'full';
        if ($('csH3Size')) $('csH3Size').value = ['S', 'M', 'L', 'XL'].includes(settings.h3Size) ? settings.h3Size : 'L';
        if ($('csH3Steps')) $('csH3Steps').value = String(settings.steps || 20);
        if ($('csH3Attention')) {
            const attention = ['comfy kitchen attention', 'pytorch attention'].includes(settings.attention) ? settings.attention : 'auto';
            $('csH3Attention').value = attention;
        }
    }

    function applyMaskSettings(mask) {
        const settings = mask || {};
        if ($('csMaskGrow')) $('csMaskGrow').value = String(Number.isFinite(Number(settings.grow)) ? Number(settings.grow) : 12);
        if ($('csMaskFeather')) $('csMaskFeather').value = String(Number.isFinite(Number(settings.feather)) ? Number(settings.feather) : 2);
        if ($('csMaskTemporal')) $('csMaskTemporal').value = String(Number.isFinite(Number(settings.temporal)) ? Number(settings.temporal) : 3);
        if ($('csMaskOpacity')) $('csMaskOpacity').value = String(Math.round((Number(settings.opacity) || 0.55) * 100));
        maskOpacity = Number(settings.opacity) || 0.55;
        maskVisible = settings.visible !== false;
        if ($('csMaskVisible')) $('csMaskVisible').checked = maskVisible;
    }

    function currentPreferences() {
        const h3 = readH3Settings();
        return {
            engine,
            engineSettings: { scail2: readScailSettings(), h3 },
            maskSettings: {
                grow: Number($('csMaskGrow') && $('csMaskGrow').value),
                feather: Number($('csMaskFeather') && $('csMaskFeather').value),
                temporal: Number($('csMaskTemporal') && $('csMaskTemporal').value),
                opacity: Number($('csMaskOpacity') && $('csMaskOpacity').value) / 100,
                visible: Boolean($('csMaskVisible') && $('csMaskVisible').checked)
            },
            takes: Math.max(1, Math.min(3, Number($('csTakeCount') && $('csTakeCount').value) || 1)),
            brushSize: Math.max(1, Math.min(64, Number($('csBrushSize') && $('csBrushSize').value) || 16))
        };
    }

    function loadPreferences() {
        try {
            const raw = localStorage.getItem(PREF_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    function savePreferences() {
        try {
            localStorage.setItem(PREF_KEY, JSON.stringify(currentPreferences()));
        } catch {
            // Storage can be unavailable; the project still persists its settings.
        }
    }

    function applySettingsToForm() {
        const prefs = loadPreferences();
        const settings = project
            ? (project.engineSettings || {})
            : ((prefs && prefs.engineSettings) || {});
        applyScailSettings(settings.scail2 || {});
        applyH3Settings(settings.h3 || {});
        if (prefs) {
            if (prefs.takes != null && $('csTakeCount')) $('csTakeCount').value = String(prefs.takes);
            if (prefs.brushSize != null && $('csBrushSize')) {
                brushSize = Math.max(1, Math.min(64, Number(prefs.brushSize) || 16));
                $('csBrushSize').value = String(brushSize);
            }
            if (!project && prefs.maskSettings) {
                applyMaskSettings(prefs.maskSettings);
            } else if (prefs.maskSettings && $('csMaskVisible')) {
                maskVisible = prefs.maskSettings.visible !== false;
                $('csMaskVisible').checked = maskVisible;
            }
        }
        const h3 = settings.h3 || {};
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
        savePreferences();
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
            savePreferences();
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
            savePreferences();
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
            const owner = (project.people || []).find((person) => person.selectionId === track.id);
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'character-swap-detection-card' +
                (detectionSelection.has(track.id) ? ' active' : '') +
                (owner && owner.id === selectedPersonId ? ' focused' : '');
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
            if (owner) bits.push('→ ' + owner.label);
            meta.textContent = bits.join(' · ');
            card.appendChild(meta);
            card.title = (engine === 'scail2' || engine === 'h3')
                ? 'Click to replace with this person only (Shift-click adds another target, up to three). Remove a target with the x on its person card.'
                : '';
            card.addEventListener('click', (event) => {
                if (engine === 'scail2' || engine === 'h3') {
                    const owner = (project.people || []).find((person) => person.selectionId === track.id);
                    if (owner) {
                        // Focusing an already-bound person is local and must stay
                        // responsive even while a background describe/bind is
                        // still running.
                        selectedPersonId = owner.id;
                        renderAll();
                        focusPerson(owner, { jump: true });
                        setStatus(owner.label + ' is focused. Add its character image below.', 'ok');
                        return;
                    }
                    if (bindingSelection) return;
                    // A plain click targets exactly one person. This prevents a
                    // previously clicked target from staying bound and turning a
                    // single-character request into two replacement passes.
                    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) detectionSelection.clear();
                    detectionSelection.add(track.id);
                    applySelectionTask(track.id);
                    return;
                }
                if (bindingSelection) return;
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
            if (focus) focusPerson(selectedPerson(), { jump: true });
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

    function selectionSignature() {
        if (!project) return '';
        const selection = project.selection;
        return [project.id, selection ? (selection.createdAt || '') : '',
            selection ? (selection.corrections || []).length : 0,
            selection ? (selection.version || '') : ''].join(':');
    }

    function setProject(next) {
        // Ignore an async response that lost the race against newer state.
        if (next && project && next.id === project.id) {
            const previousTime = Date.parse(project.updatedAt) || 0;
            const nextTime = Date.parse(next.updatedAt) || 0;
            if (previousTime && nextTime && nextTime < previousTime) return;
        }
        const previousProjectId = project ? project.id : null;
        const previousSelected = project ? selectedPerson() : null;
        project = next;
        if (!project) {
            selectedPersonId = null;
            detectionOverlay = null;
            detectionOverlayKey = '';
            detectionOverlayPromise = null;
            highlightRequest += 1;
            return;
        }
        engine = project.engine || 'scail2';
        const signature = selectionSignature();
        if (signature !== detectionOverlayKey) {
            detectionOverlay = null;
            detectionOverlayKey = signature;
            detectionOverlayPromise = null;
            highlightRequest += 1;
        }
        if (!project.people.some((person) => person.id === selectedPersonId)) {
            const sameProject = Boolean(previousProjectId && previousProjectId === project.id);
            // Person records can be recreated by a new detection/auto-people
            // pass. Keep the same subject selected by its stable track id, then
            // by its label, instead of silently snapping back to people[0].
            const byTrack = sameProject && previousSelected && previousSelected.selectionId
                ? project.people.find((person) => person.selectionId === previousSelected.selectionId)
                : null;
            const byLabel = sameProject && previousSelected && previousSelected.label
                ? project.people.find((person) => person.label === previousSelected.label)
                : null;
            const preserved = byTrack || byLabel || project.people[0];
            selectedPersonId = preserved ? preserved.id : null;
        }
        frame = Math.max(0, Math.min(frames() - 1, frame));
        renderAll();
        applyEngineUI();
        if (project.selection && (project.selection.tracks || []).length) {
            ensureDetectionOverlay().then(() => drawHighlight()).catch(() => {});
        }
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
                text = 'Ready - render H3 Recast. Lip sync is refined automatically before upscaling.';
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
        markStep(text);
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

    const TRIM_MAX_SECONDS = 15;

    function trimClipDuration() {
        if (!project) return 0;
        const source = Number(project.source && project.source.duration) || 0;
        const footage = project.footage && Number(project.footage.frames) && Number(project.footage.fps)
            ? Number(project.footage.frames) / Number(project.footage.fps)
            : 0;
        return Math.max(0, Math.min(source || footage, footage || source));
    }

    function trimOffset() {
        return Number(project && project.trim && project.trim.start) || 0;
    }

    function updateTrimMeta() {
        const startInput = $('csTrimStart');
        const endInput = $('csTrimEnd');
        if (!startInput || !endInput) return;
        const duration = trimClipDuration();
        startInput.max = String(duration);
        endInput.max = String(duration);
        const start = Number(startInput.value) || 0;
        const end = Number(endInput.value) || 0;
        const video = $('csVideo');
        const playhead = project && video && video.getAttribute('src')
            ? trimOffset() + (Number(video.currentTime) || 0)
            : null;
        const range = $('csTrimRange');
        if (range) {
            if (!project) {
                range.textContent = 'No clip loaded';
            } else {
                const bits = [Math.max(0, end - start).toFixed(1) + 's selected'];
                if (playhead !== null) bits.push('playhead ' + playhead.toFixed(1) + 's');
                bits.push('max ' + TRIM_MAX_SECONDS + 's');
                range.textContent = bits.join(' · ');
            }
        }
        const apply = $('csTrimApply');
        if (apply && taskDepth === 0) apply.disabled = !project || !(end > start);
    }

    function normalizeTrimInputs() {
        const duration = trimClipDuration();
        if (!duration) return;
        let start = Number($('csTrimStart').value) || 0;
        let end = Number($('csTrimEnd').value) || 0;
        start = Math.max(0, Math.min(start, Math.max(0, duration - 0.1)));
        end = Math.max(0, Math.min(end, duration));
        if (end <= start) end = Math.min(duration, start + 1);
        if (end - start > TRIM_MAX_SECONDS) end = Math.min(duration, start + TRIM_MAX_SECONDS);
        $('csTrimStart').value = String(Math.round(start * 10) / 10);
        $('csTrimEnd').value = String(Math.round(end * 10) / 10);
        updateTrimMeta();
    }

    function setTrimFromPlayhead(which) {
        if (!project) {
            setStatus('Import a clip first.', 'error');
            return;
        }
        const video = $('csVideo');
        const duration = trimClipDuration();
        const playhead = Math.max(0, Math.min(duration,
            trimOffset() + (video ? Number(video.currentTime) || 0 : 0)));
        const value = String(Math.round(playhead * 10) / 10);
        if (which === 'start') {
            $('csTrimStart').value = value;
            if ((Number($('csTrimEnd').value) || 0) <= playhead) {
                $('csTrimEnd').value = String(Math.round(Math.min(duration, playhead + 1) * 10) / 10);
            }
        } else {
            $('csTrimEnd').value = value;
            if ((Number($('csTrimStart').value) || 0) >= playhead) {
                $('csTrimStart').value = String(Math.round(Math.max(0, playhead - 1) * 10) / 10);
            }
        }
        normalizeTrimInputs();
    }

    function seekVideoToFrame() {
        const video = $('csVideo');
        if (!video || !video.getAttribute('src') || video.hidden) return;
        const seek = () => {
            const target = Math.max(0, Math.min(Number(video.duration) || frame / fps(), frame / fps()));
            try { video.currentTime = target; } catch { /* metadata not ready yet */ }
            updateTrimMeta();
        };
        if (video.readyState >= 1) seek();
        else video.addEventListener('loadedmetadata', seek, { once: true });
    }

    function renderSource() {
        const video = $('csVideo');
        const src = project && project.videoUrl ? project.videoUrl : '';
        if (video) {
            video.hidden = !src;
            if (!src) {
                try { video.pause(); } catch { /* not playing */ }
                if (video.getAttribute('src')) {
                    video.removeAttribute('src');
                    try { video.load(); } catch { /* nothing to reload */ }
                }
            } else if (video.getAttribute('src') !== src) {
                // A re-trim points at a fresh part file, so the immutable media
                // URL changes and the player reloads instead of serving stale
                // cached bytes. Only a genuine source change seeks the video;
                // background task refreshes leave playback alone.
                video.src = src;
                try { video.load(); } catch { /* src already triggers load */ }
                seekVideoToFrame();
            }
        }
        const part = (project && project.part) || { width: 0, height: 0, frames: 1 };
        $('csSourceMeta').textContent = project
            ? (project.source.filename + ' · ' + Math.round(project.source.duration * 10) / 10 + 's · ' +
                part.width + '×' + part.height + ' · ' + frames() + ' frames')
            : 'No clip loaded.';
        const trimStart = project ? (project.trim && project.trim.start) || 0 : 0;
        const trimEnd = project ? (project.trim && project.trim.end) || 0 : 0;
        $('csTrimStart').value = trimStart;
        $('csTrimEnd').value = project && trimEnd > trimStart
            ? trimEnd
            : (project ? Math.min(trimClipDuration(), trimStart + TRIM_MAX_SECONDS) : 0);
        updateTrimMeta();
        const lastFrame = Math.max(0, frames() - 1);
        const timeline = $('csTimeline');
        timeline.max = String(lastFrame);
        timeline.value = String(frame);
        timeline.style.setProperty('--cs-progress', (lastFrame ? (frame / lastFrame) * 100 : 0) + '%');
        $('csFrameLabel').textContent = 'Frame ' + frame + ' / ' + lastFrame;
        $('csFrameLabel').hidden = !project;
        $('csStageTitle').textContent = project ? (project.title || 'Character Swap') : 'Preview';
        $('csStageEmpty').hidden = Boolean(project);
        $('csCanvasWrap').hidden = !project;
        const transport = $('csTransport');
        if (transport) transport.hidden = !project;
        const fullscreen = $('csFullscreen');
        if (fullscreen) fullscreen.disabled = !project;
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
            if (project && project.engine === 'scail2' && !person.selectionId) frame = 0;
            renderAll();
            focusPerson(person, { jump: true });
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
                seekVideoToFrame();
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
        const caption = String(person.subjectSummary || '').trim();
        if (!person.description) {
            host.textContent = caption || 'No description yet. Describe after adding references.';
            return;
        }
        const d = person.description;
        const lines = [
            ['Auto caption', caption],
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
                    take.lipRepair ? 'lip refined' : ''
                ].filter(Boolean);
                meta.textContent = bits.join(' - ');
            }
            card.appendChild(meta);
            if (take.lipRepair && take.lipRepair.sourceUrl) {
                const lipRow = document.createElement('div');
                lipRow.className = 'character-swap-take-lip';
                const original = document.createElement('a');
                original.href = take.lipRepair.sourceUrl;
                original.target = '_blank';
                original.rel = 'noreferrer';
                original.textContent = 'Original (before lip refine)';
                lipRow.appendChild(original);
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
            const prefs = currentPreferences();
            const data = await api('/api/character-swap/projects', {
                method: 'POST',
                body: JSON.stringify({
                    filename,
                    source: 'generated',
                    title: filename,
                    engine,
                    conversationId,
                    settings: prefs.engineSettings,
                    maskSettings: prefs.maskSettings
                })
            });
            frame = 0;
            setProject(data);
            savePreferences();
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
            drawHighlight();
        };
        img.src = url;
        const person = selectedPerson();
        if (person && hasMask(person)) {
            maskImage = new Image();
            maskImage.onload = () => drawMask();
            maskImage.src = maskUrl(person.id, frame);
            drawHighlight();
            return;
        }
        const anchor = person && (person.anchors || []).find((item) => item.frame === frame);
        if (anchor) {
            maskImage = new Image();
            maskImage.onload = () => drawMask();
            maskImage.src = anchor.anchorMaskUrl ||
                ('/api/character-swap/projects/' + encodeURIComponent(project.id) +
                    '/person/' + encodeURIComponent(person.id) + '/anchors/' + Number(anchor.frame) + '/mask');
            drawHighlight();
            return;
        }
        maskImage = null;
        drawMask();
        drawHighlight();
    }

    function syncCanvasSize() {
        const img = $('csFrameImage');
        const width = img.naturalWidth || (project && project.part && project.part.width) || 1280;
        const height = img.naturalHeight || (project && project.part && project.part.height) || 720;
        const mask = $('csMaskCanvas');
        const draw = $('csDrawCanvas');
        const highlight = $('csHighlightCanvas');
        [mask, highlight, draw].forEach((canvas) => {
            if (!canvas) return;
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
        });
        layoutCanvases();
    }

    // The displayed image content rect inside the canvas wrap. Mirrors
    // object-fit: contain exactly, including the wrap border, so the overlay
    // canvases always sit on the image (never on the letterbox).
    function canvasView() {
        const wrap = $('csCanvasWrap');
        const img = $('csFrameImage');
        if (!wrap || !img) return null;
        const naturalWidth = img.naturalWidth || (project && project.part && project.part.width) || 0;
        const naturalHeight = img.naturalHeight || (project && project.part && project.part.height) || 0;
        if (!naturalWidth || !naturalHeight) return null;
        const wrapRect = wrap.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        const boxWidth = Math.max(1, imgRect.width || img.clientWidth || 0);
        const boxHeight = Math.max(1, imgRect.height || img.clientHeight || 0);
        const objectFit = (window.getComputedStyle ? window.getComputedStyle(img).objectFit : '') || 'contain';
        const cover = objectFit === 'cover';
        const scale = cover
            ? Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight)
            : Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
        if (!Number.isFinite(scale) || scale <= 0) return null;
        const shownWidth = Math.max(1, naturalWidth * scale);
        const shownHeight = Math.max(1, naturalHeight * scale);
        // Absolute offsets are relative to the wrap's padding box, not its
        // border box, so subtract the border before centering.
        const paddingLeft = wrapRect.left + (wrap.clientLeft || 0);
        const paddingTop = wrapRect.top + (wrap.clientTop || 0);
        const left = cover
            ? (imgRect.left - paddingLeft) - (shownWidth - boxWidth) / 2
            : (imgRect.left - paddingLeft) + (boxWidth - shownWidth) / 2;
        const top = cover
            ? (imgRect.top - paddingTop) - (shownHeight - boxHeight) / 2
            : (imgRect.top - paddingTop) + (boxHeight - shownHeight) / 2;
        return { naturalWidth, naturalHeight, scale, shownWidth, shownHeight, left, top };
    }

    function layoutCanvases() {
        const view = canvasView();
        if (!view) return;
        [$('csMaskCanvas'), $('csHighlightCanvas'), $('csDrawCanvas')].forEach((canvas) => {
            if (!canvas) return;
            canvas.style.left = view.left + 'px';
            canvas.style.top = view.top + 'px';
            canvas.style.width = view.shownWidth + 'px';
            canvas.style.height = view.shownHeight + 'px';
            canvas.style.right = 'auto';
            canvas.style.bottom = 'auto';
        });
    }

    function detectionTrackMeta(trackId) {
        if (!detectionOverlay) return null;
        return (detectionOverlay.tracks || []).find((track) => track.id === trackId) || null;
    }

    function detectionIndex(trackId) {
        if (!detectionOverlay) return 0;
        return Math.max(0, (detectionOverlay.tracks || []).findIndex((track) => track.id === trackId));
    }

    async function ensureDetectionOverlay() {
        if (!project) return null;
        const signature = selectionSignature();
        if (detectionOverlay && detectionOverlay.key === signature) return detectionOverlay;
        if (detectionOverlayPromise && detectionOverlayPromise.key === signature) return detectionOverlayPromise.promise;
        if (!project.selection || !(project.selection.tracks || []).length) {
            detectionOverlay = null;
            detectionOverlayKey = signature;
            return null;
        }
        const projectId = project.id;
        const promise = api('/api/character-swap/projects/' + encodeURIComponent(projectId) + '/selection/frames')
            .then((data) => {
                if (!project || project.id !== projectId || selectionSignature() !== signature) return null;
                const byFrame = new Map();
                (Array.isArray(data.frames) ? data.frames : []).forEach((entry) => {
                    const index = Number(entry && entry.frame);
                    const people = (Array.isArray(entry && entry.people) ? entry.people : [])
                        .filter((person) => person && person.trackId && person.bbox);
                    if (!Number.isFinite(index) || !people.length) return;
                    byFrame.set(index, people);
                });
                const byTrack = new Map();
                byFrame.forEach((people, index) => {
                    people.forEach((person) => {
                        if (!byTrack.has(person.trackId)) byTrack.set(person.trackId, []);
                        byTrack.get(person.trackId).push({ frame: index, bbox: person.bbox });
                    });
                });
                byTrack.forEach((list) => list.sort((a, b) => a.frame - b.frame));
                detectionOverlay = {
                    key: signature,
                    width: Number(data.width) || (project.part && project.part.width) || 0,
                    height: Number(data.height) || (project.part && project.part.height) || 0,
                    tracks: Array.isArray(data.tracks) ? data.tracks : [],
                    byFrame,
                    byTrack
                };
                return detectionOverlay;
            })
            .catch(() => null)
            .finally(() => {
                if (detectionOverlayPromise && detectionOverlayPromise.key === signature) detectionOverlayPromise = null;
            });
        detectionOverlayPromise = { key: signature, promise };
        return promise;
    }

    function detectionEntries() {
        if (!detectionOverlay) return [];
        return detectionOverlay.byFrame.get(frame) || [];
    }

    // The canvas must mirror the PEOPLE list exactly. Only tracks bound to a
    // person record are "active"; unbound DWPose tracks (and leftovers from an
    // earlier detection) must never get a box, whichever engine is selected.
    function visibleTrackIds() {
        if (!project) return new Set();
        const tracks = new Set(((project.selection && project.selection.tracks) || []).map((track) => track.id));
        const bound = new Set();
        (project.people || []).forEach((person) => {
            if (person.selectionId && tracks.has(person.selectionId)) bound.add(person.selectionId);
        });
        return bound;
    }

    function visibleDetectionEntries() {
        const allowed = visibleTrackIds();
        return detectionEntries().filter((entry) => allowed.has(entry.trackId));
    }

    function nearestTrackFrame(trackId, target) {
        if (!detectionOverlay) return null;
        const list = detectionOverlay.byTrack.get(trackId) || [];
        if (!list.length) return null;
        return list.reduce((best, item) => {
            const distance = Math.abs(Number(item.frame) - target);
            return distance < Math.abs(Number(best.frame) - target) ? item : best;
        }, list[0]).frame;
    }

    // Focuses a person and, when requested, jumps the timeline to the closest
    // frame they actually appear in.
    async function focusPerson(person, options = {}) {
        const token = ++highlightRequest;
        if (!person || !person.selectionId || !project) {
            drawHighlight();
            return;
        }
        const projectId = project.id;
        await ensureDetectionOverlay();
        if (token !== highlightRequest) return;
        if (!project || project.id !== projectId || selectedPersonId !== person.id) {
            if (token === highlightRequest) drawHighlight();
            return;
        }
        if (!visibleTrackIds().has(person.selectionId)) {
            drawHighlight();
            return;
        }
        const list = detectionOverlay ? (detectionOverlay.byTrack.get(person.selectionId) || []) : [];
        if (options.jump && detectionOverlay && !list.length) {
            setStatus((person.label || 'Selected person') + ' has no reliable detection in this clip.', 'error');
            drawHighlight();
            return;
        }
        if (options.jump && list.length && !list.some((item) => item.frame === frame)) {
            const target = Number(nearestTrackFrame(person.selectionId, frame));
            if (Number.isFinite(target) && target !== frame) {
                frame = Math.max(0, Math.min(frames() - 1, target));
                renderSource();
                seekVideoToFrame();
                loadFrame();
                setStatus((person.label || 'Selected person') + ' is visible at frame ' + frame + '.', 'ok');
                return;
            }
        }
        drawHighlight();
    }

    function roundRectPath(ctx, x, y, width, height, radius) {
        const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function boxToCanvas(box) {
        const canvas = $('csHighlightCanvas');
        const sourceWidth = (detectionOverlay && detectionOverlay.width) || (canvas && canvas.width) || 1;
        const sourceHeight = (detectionOverlay && detectionOverlay.height) || (canvas && canvas.height) || 1;
        const scaleX = (canvas ? canvas.width : sourceWidth) / sourceWidth;
        const scaleY = (canvas ? canvas.height : sourceHeight) / sourceHeight;
        return {
            x: Number(box.x) * scaleX,
            y: Number(box.y) * scaleY,
            width: Number(box.width) * scaleX,
            height: Number(box.height) * scaleY
        };
    }

    function personCaption(person) {
        if (!person) return '';
        const text = person.subjectSummary
            || (person.description && person.description.identitySummary)
            || person.identitySummary
            || '';
        return String(text).trim();
    }

    function wrapCanvasText(ctx, text, maxWidth, maxLines) {
        if (!text) return [];
        const words = String(text).split(/\s+/);
        const lines = [];
        let line = '';
        for (const word of words) {
            const candidate = line ? line + ' ' + word : word;
            if (ctx.measureText(candidate).width <= maxWidth) {
                line = candidate;
                continue;
            }
            if (line) lines.push(line);
            line = word;
            if (lines.length >= maxLines) break;
        }
        if (line && lines.length < maxLines) lines.push(line);
        if (lines.length >= maxLines) {
            let last = lines[maxLines - 1];
            while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
            lines[maxLines - 1] = last + '…';
        }
        return lines;
    }

    function drawDetectionBox(ctx, canvas, box, style) {
        const rect = boxToCanvas(box);
        const x = Math.max(0, Math.min(canvas.width, rect.x));
        const y = Math.max(0, Math.min(canvas.height, rect.y));
        const width = Math.max(1, Math.min(canvas.width - x, rect.width));
        const height = Math.max(1, Math.min(canvas.height - y, rect.height));
        if (width < 2 || height < 2) return;
        const rgb = tintRgb(style.tint);
        const lineWidth = style.selected
            ? Math.max(3, Math.round(canvas.width / 280))
            : Math.max(2, Math.round(canvas.width / 460));
        const stroke = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (style.selected ? '0.98' : '0.72') + ')';
        const fill = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (style.selected ? '0.17' : '0.06') + ')';
        ctx.save();
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = stroke;
        ctx.fillStyle = fill;
        ctx.setLineDash(style.selected ? [] : [lineWidth * 2, lineWidth * 2]);
        roundRectPath(ctx, x, y, width, height, Math.max(5, lineWidth * 2));
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        const fontSize = Math.max(12, Math.round(canvas.width / (style.selected ? 52 : 62)));
        const captionFontSize = Math.max(10, Math.round(fontSize * 0.74));
        const padding = Math.max(5, Math.round(fontSize * 0.42));
        ctx.font = (style.selected ? '700 ' : '600 ') + fontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';
        const label = style.label || 'Person';
        const labelWidth = ctx.measureText(label).width;
        let captionLines = [];
        if (style.selected && style.caption) {
            const maxWidth = Math.min(canvas.width * 0.6, Math.max(width * 1.4, canvas.width * 0.32));
            ctx.font = '500 ' + captionFontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
            captionLines = wrapCanvasText(ctx, style.caption, maxWidth, 2);
        }
        let captionWidth = 0;
        if (captionLines.length) {
            ctx.font = '500 ' + captionFontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
            captionWidth = Math.max(...captionLines.map((line) => ctx.measureText(line).width));
        }
        const chipWidth = Math.max(labelWidth, captionWidth) + padding * 2;
        const chipHeight = fontSize + padding * 1.4 +
            (captionLines.length ? captionLines.length * captionFontSize * 1.32 + padding * 0.5 : 0);
        const chipX = Math.max(0, Math.min(canvas.width - chipWidth, x));
        let chipY = y - chipHeight - lineWidth * 2;
        if (chipY < 0) chipY = Math.min(canvas.height - chipHeight, y + lineWidth * 2);
        chipY = Math.max(0, chipY);
        ctx.fillStyle = style.selected ? 'rgba(9,12,16,0.9)' : 'rgba(9,12,16,0.72)';
        roundRectPath(ctx, chipX, chipY, chipWidth, chipHeight, Math.min(8, chipHeight / 3));
        ctx.fill();
        if (style.selected) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = Math.max(1, lineWidth / 2);
            roundRectPath(ctx, chipX, chipY, chipWidth, chipHeight, Math.min(8, chipHeight / 3));
            ctx.stroke();
        }
        ctx.fillStyle = stroke;
        ctx.font = (style.selected ? '700 ' : '600 ') + fontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        const textY = chipY + padding * 0.7 + fontSize / 2;
        ctx.fillText(label, chipX + padding, textY);
        if (captionLines.length) {
            ctx.fillStyle = 'rgba(232,238,244,0.86)';
            ctx.font = '500 ' + captionFontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
            captionLines.forEach((line, index) => {
                ctx.fillText(line, chipX + padding,
                    textY + fontSize * 0.72 + padding * 0.4 + index * captionFontSize * 1.3);
            });
        }
        ctx.restore();
    }

    function debugEnabled() {
        try { return localStorage.getItem('jarvis-character-swap-debug') === '1'; } catch { return false; }
    }

    function drawDebugOverlay(ctx, canvas) {
        const view = canvasView();
        const detectionWidth = (detectionOverlay && detectionOverlay.width) || canvas.width || 1;
        const detectionHeight = (detectionOverlay && detectionOverlay.height) || canvas.height || 1;
        const scaleX = canvas.width / detectionWidth;
        const scaleY = canvas.height / detectionHeight;
        const lines = [
            'frame ' + frame,
            'detection ' + detectionWidth + '×' + detectionHeight + ' → canvas ' + canvas.width + '×' + canvas.height,
            'scale x' + scaleX.toFixed(3) + ' y' + scaleY.toFixed(3),
            view
                ? 'display ' + Math.round(view.shownWidth) + '×' + Math.round(view.shownHeight) +
                    ' @ ' + view.left.toFixed(1) + ',' + view.top.toFixed(1) + ' dpr ' + (window.devicePixelRatio || 1)
                : 'display n/a'
        ];
        const fontSize = Math.max(11, Math.round(canvas.width / 70));
        ctx.save();
        ctx.font = '500 ' + fontSize + 'px monospace';
        ctx.textBaseline = 'top';
        const pad = Math.round(fontSize * 0.5);
        const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + pad * 2;
        const height = lines.length * fontSize * 1.35 + pad * 2;
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#9df5b6';
        lines.forEach((line, index) => ctx.fillText(line, pad, pad + index * fontSize * 1.35));
        ctx.restore();
        visibleDetectionEntries().forEach((entry) => {
            const rect = boxToCanvas(entry.displayBbox || entry.bbox);
            console.debug('[character-swap] detection', entry.trackId, 'source', entry.bbox,
                'display', entry.displayBbox, 'canvas', rect);
        });
    }

    function drawHighlight() {
        const canvas = $('csHighlightCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!project || !detectionOverlay) {
            updateHighlightPointer(false);
            return;
        }
        const entries = visibleDetectionEntries();
        if (!entries.length) {
            updateHighlightPointer(false);
            return;
        }
        const selected = selectedPerson();
        const selectedTrackId = selected && selected.selectionId;
        const ordered = entries.slice().sort((a, b) => {
            if (a.trackId === selectedTrackId) return 1;
            if (b.trackId === selectedTrackId) return -1;
            return 0;
        });
        ordered.forEach((entry) => {
            const owner = (project.people || []).find((person) => person.selectionId === entry.trackId);
            const index = detectionIndex(entry.trackId);
            const meta = detectionTrackMeta(entry.trackId);
            const selectedEntry = entry.trackId === selectedTrackId;
            drawDetectionBox(ctx, canvas, entry.displayBbox || entry.bbox, {
                tint: (owner && owner.tint) || DETECTION_PALETTE[index % DETECTION_PALETTE.length],
                label: (owner && owner.label) || (meta && meta.label) || ('Person ' + (index + 1)),
                selected: selectedEntry,
                caption: selectedEntry && owner ? personCaption(owner) : ''
            });
        });
        if (debugEnabled()) drawDebugOverlay(ctx, canvas);
        updateHighlightPointer(true);
    }

    function updateHighlightPointer(hasBoxes) {
        const canvas = $('csHighlightCanvas');
        if (!canvas) return;
        const interactive = Boolean(hasBoxes) && Boolean(project) && !featuresFor(project.engine).maskSection;
        canvas.style.pointerEvents = interactive ? 'auto' : 'none';
        canvas.style.cursor = interactive ? 'pointer' : '';
    }

    function detectionFromEvent(event) {
        if (!detectionOverlay) return null;
        const canvas = $('csHighlightCanvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const px = (event.clientX - rect.left) * canvas.width / rect.width;
        const py = (event.clientY - rect.top) * canvas.height / rect.height;
        let hit = null;
        visibleDetectionEntries().forEach((entry) => {
            const box = boxToCanvas(entry.displayBbox || entry.bbox);
            if (px < box.x || py < box.y || px > box.x + box.width || py > box.y + box.height) return;
            const area = box.width * box.height;
            if (!hit || area < hit.area) hit = { entry, area };
        });
        return hit ? hit.entry : null;
    }

    async function onHighlightClick(event) {
        if (!project || featuresFor(project.engine).maskSection) return;
        const detection = detectionFromEvent(event);
        if (!detection) return;
        const owner = (project.people || []).find((person) => person.selectionId === detection.trackId);
        if (owner) {
            selectedPersonId = owner.id;
            renderAll();
            focusPerson(owner, { jump: false });
            return;
        }
        detectionSelection.clear();
        detectionSelection.add(detection.trackId);
        await applySelectionTask(detection.trackId);
    }

    function clearHighlightCanvas() {
        const canvas = $('csHighlightCanvas');
        if (!canvas) return;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
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
        detectionOverlay = null;
        detectionOverlayKey = '';
        detectionOverlayPromise = null;
        highlightRequest += 1;
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
        clearHighlightCanvas();
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
        applySettingsToForm();
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
            const prefs = currentPreferences();
            const data = await api('/api/character-swap/projects', {
                method: 'POST',
                body: JSON.stringify({
                    filename: uploaded.filename,
                    title: file.name,
                    engine,
                    conversationId,
                    settings: prefs.engineSettings,
                    maskSettings: prefs.maskSettings
                })
            });
            frame = 0;
            setProject(data);
            savePreferences();
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
            savePreferences();
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
            setStatus(engine === 'scail2' ? 'Preparing the SCAIL-2 replacement…' : 'Preparing the H3 Recast render…');
            const settings = collectEngineSettings();
            const response = await fetch('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    engine,
                    quality: $('csQuality') ? $('csQuality').value : 'full',
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
    const renderTask = (options) => runTask('Rendering the character swap.', () => render(options));
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
        if ($('csEmptyUpload')) $('csEmptyUpload').addEventListener('click', () => $('csVideoFile').click());
        if ($('csEmptyGenerated')) $('csEmptyGenerated').addEventListener('click', () => openMediaPicker({
            kind: 'video',
            multiple: false,
            onPick: (entries) => createFromGeneratedTask(entries[0])
        }));
        if ($('csFullscreen')) $('csFullscreen').addEventListener('click', () => {
            const viewport = $('csViewport');
            if (!viewport) return;
            if (document.fullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                return;
            }
            if (typeof viewport.requestFullscreen === 'function') {
                viewport.requestFullscreen().catch(() => {});
            }
        });
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
            normalizeTrimInputs();
            const start = Number($('csTrimStart').value);
            const end = Number($('csTrimEnd').value);
            if (!(end > start)) throw new Error('Trim end must be after the trim start.');
            const data = await api('/api/character-swap/projects/' + encodeURIComponent(project.id) + '/trim', {
                method: 'PATCH',
                body: JSON.stringify({ start, end })
            });
            frame = 0;
            setProject(data);
            setStatus(featuresFor(project && project.engine).anchors
                ? 'Trim applied. Re-add anchors for the new range.'
                : 'Trim applied.', 'ok');
        }));
        ['csTrimStart', 'csTrimEnd'].forEach((id) => {
            $(id).addEventListener('input', updateTrimMeta);
            $(id).addEventListener('change', normalizeTrimInputs);
        });
        if ($('csTrimStartPlayhead')) $('csTrimStartPlayhead').addEventListener('click', () => setTrimFromPlayhead('start'));
        if ($('csTrimEndPlayhead')) $('csTrimEndPlayhead').addEventListener('click', () => setTrimFromPlayhead('end'));
        if ($('csTrimReset')) $('csTrimReset').addEventListener('click', () => {
            if (!project) return;
            $('csTrimStart').value = '0';
            $('csTrimEnd').value = String(Math.round(Math.min(trimClipDuration(), TRIM_MAX_SECONDS) * 10) / 10);
            updateTrimMeta();
        });
        ['timeupdate', 'loadedmetadata', 'seeked'].forEach((event) => {
            $('csVideo').addEventListener(event, updateTrimMeta);
        });
        document.querySelectorAll('[data-cs-tool]').forEach((button) => {
            button.addEventListener('click', () => setTool(button.getAttribute('data-cs-tool')));
        });
        $('csBrushSize').addEventListener('input', () => {
            brushSize = Number($('csBrushSize').value);
            savePreferences();
        });
        $('csMaskOpacity').addEventListener('input', () => {
            maskOpacity = Number($('csMaskOpacity').value) / 100;
            drawMask();
        });
        $('csMaskOpacity').addEventListener('change', savePreferences);
        $('csMaskVisible').addEventListener('change', () => {
            maskVisible = $('csMaskVisible').checked;
            drawMask();
            savePreferences();
        });
        $('csMaskSync').addEventListener('click', saveMaskSettingsTask);
        ['csMaskGrow', 'csMaskFeather', 'csMaskTemporal'].forEach((id) => {
            $(id).addEventListener('change', () => {
                savePreferences();
                saveMaskSettings();
            });
        });
        if ($('csTakeCount')) {
            $('csTakeCount').addEventListener('change', savePreferences);
        }
        $('csPrevFrame').addEventListener('click', () => {
            frame = Math.max(0, frame - 1);
            renderSource();
            seekVideoToFrame();
            loadFrame();
        });
        $('csNextFrame').addEventListener('click', () => {
            frame = Math.min(frames() - 1, frame + 1);
            renderSource();
            seekVideoToFrame();
            loadFrame();
        });
        $('csTimeline').addEventListener('input', () => {
            frame = Number($('csTimeline').value);
            renderSource();
            seekVideoToFrame();
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
            'csH3Size', 'csH3Steps', 'csH3Attention'
        ];
        engineInputs.forEach((id) => {
            const input = $(id);
            if (!input) return;
            input.addEventListener('change', () => {
                savePreferences();
                saveEngineSettingsTask();
            });
        });
        if ($('csWanPrompt')) {
            $('csWanPrompt').addEventListener('change', () => {
                savePreferences();
                saveEngineSettingsTask();
            });
            $('csWanPrompt').addEventListener('input', updateFlow);
        }
        const draw = $('csDrawCanvas');
        const highlight = $('csHighlightCanvas');
        if (highlight) highlight.addEventListener('click', onHighlightClick);
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
            closeWorkspace();
        });
    }

    function closeWorkspace() {
        $('characterSwapOverlay').hidden = true;
        if (window.StudioShell) window.StudioShell.close();
    }

    // The five numbered sections are a sequence, so they get a step rail:
    // one press scrolls the workspace to that part of the flow.
    function bindSteps() {
        const nav = $('csSteps');
        if (!nav) return;
        nav.addEventListener('click', (event) => {
            const button = event.target.closest('[data-cs-step]');
            if (!button) return;
            const section = $(button.dataset.csStep);
            if (!section) return;
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const first = section.nextElementSibling;
            const control = first && first.querySelector
                ? first.querySelector('input, select, textarea, button:not(:disabled)')
                : null;
            if (control) control.focus({ preventScroll: true });
        });
    }

    function markStep(text) {
        const nav = $('csSteps');
        if (!nav) return;
        const match = /step\s*([1-5])/i.exec(text || '');
        const ready = /^ready/i.test(text || '');
        const index = ready ? 5 : (match ? Number(match[1]) : 0);
        nav.querySelectorAll('[data-cs-step]').forEach((button, position) => {
            if (position + 1 === index) {
                button.setAttribute('aria-current', 'step');
            } else {
                button.removeAttribute('aria-current');
            }
        });
    }

    async function open() {
        $('characterSwapOverlay').hidden = false;
        if (window.StudioShell) window.StudioShell.open($('characterSwapOverlay'));
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
        if (window.StudioShell) window.StudioShell.open($('characterSwapOverlay'));
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
        bindSteps();
        const button = $('chatCharacterSwap');
        if (button) button.addEventListener('click', open);
        const prefs = loadPreferences();
        if (prefs && (prefs.engine === 'scail2' || prefs.engine === 'h3')) engine = prefs.engine;
        setTool('select');
        loadEngines();
        window.addEventListener('resize', () => {
            layoutCanvases();
            drawHighlight();
        });
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => {
                layoutCanvases();
                drawHighlight();
            });
            if ($('csCanvasWrap')) observer.observe($('csCanvasWrap'));
            if ($('csFrameImage')) observer.observe($('csFrameImage'));
        }
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
                closeWorkspace();
            }
        });
    }

    return { init, open, openWithVideo };
})();

window.CharacterSwapUI = CharacterSwapUI;
