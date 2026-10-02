/* ============================================
   JARVIS — Creator Studio UI
   Character-led interface for personality-led
   talking-video sessions. The
   studio sends structured content to the shared
   chat/video orchestrator.
   ============================================ */

const CreatorStudioUI = (() => {
    const $ = (id) => document.getElementById(id);
    let catalogs = null;
    let pollTimer = null;
    let characters = [];
    let session = null;
    let generationPending = false;
    let progressPercent = 0;
    let progressConversationId = null;

    function option(value, label) {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        return node;
    }

    function fillSelect(select, items, selected, includeAuto) {
        if (!select) return;
        select.replaceChildren();
        if (includeAuto) select.appendChild(option('', includeAuto));
        (items || []).forEach((item) => select.appendChild(option(item.id || item.value, item.name || item.label || item.id || item.value)));
        if (selected !== undefined && selected !== null) select.value = selected;
    }

    function selectedTraits() {
        const root = $('creatorPersonalityTraits');
        return root ? Array.from(root.querySelectorAll('input:checked')).map((el) => el.value) : [];
    }

    // The Scene selector reads the shared Scene/Location Library. "Auto" lets
    // the concept decide; "Custom scene…" reveals a free-text field. An explicit
    // library selection sends its sceneId so the exact shared Scene object is used.
    function syncSceneCustom() {
        const select = $('creatorScene');
        const field = $('creatorSceneCustomField');
        if (!select || !field) return;
        field.hidden = select.value !== '__custom__';
    }

    function scenePayload() {
        const select = $('creatorScene');
        const value = select ? String(select.value || '') : '';
        if (value === '__custom__') {
            const custom = $('creatorSceneCustom') ? $('creatorSceneCustom').value.trim() : '';
            return { sceneId: '', scene: custom || 'Auto' };
        }
        const scene = (catalogs && Array.isArray(catalogs.scenes) ? catalogs.scenes : [])
            .find((item) => item.id === value) || null;
        return { sceneId: value || '', scene: scene ? scene.name : 'Auto' };
    }

    function renderTraits(selected) {
        const root = $('creatorPersonalityTraits');
        if (!root || !catalogs) return;
        const active = new Set(selected || []);
        root.replaceChildren();
        root.setAttribute('aria-label', 'Creator personality');
        catalogs.personalityTraits.forEach((trait) => {
            const label = document.createElement('label');
            label.className = 'creator-trait';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = trait;
            checkbox.checked = active.has(trait);
            const text = document.createElement('span');
            text.textContent = trait.replace(/_/g, ' ');
            label.append(checkbox, text);
            root.appendChild(label);
        });
    }

    function paintCharacter() {
        const character = characters.find((item) => item.id === $('creatorCharacterSelect').value) || null;
        const image = $('creatorCharacterImage');
        const name = $('creatorCharacterName');
        const identity = $('creatorCharacterIdentity');
        const sheet = $('creatorCharacterSheet');
        if (sheet) sheet.hidden = !character;
        if (!character) {
            image.hidden = true;
            image.removeAttribute('src');
            name.textContent = 'Choose a Character';
            identity.textContent = 'The Character record and approved portrait anchor identity, appearance and wardrobe.';
            return;
        }
        name.textContent = character.name || 'Character';
        const status = character.identityStatus === 'ready' ? 'Identity sheet ready'
            : character.identityStatus === 'generating' ? 'Identity sheet generating'
                : character.identityStatus === 'failed' ? 'Identity sheet needs attention'
                    : 'Character identity';
        identity.textContent = status + (character.adult ? ' · adult age recorded' : '');
        if (character.image) {
            image.src = character.image;
            image.hidden = false;
        } else {
            image.hidden = true;
            image.removeAttribute('src');
        }
    }

    async function loadOptions() {
        const response = await fetch('/api/creator-studio/options');
        if (!response.ok) throw new Error('Creator Studio options could not be loaded.');
        catalogs = await response.json();
        characters = catalogs.characters || [];
        fillSelect($('creatorCharacterSelect'), characters, characters[0] && characters[0].id, 'Choose a Character…');
        paintCharacter();
        renderTraits(['playful']);
        fillSelect($('creatorContentType'), catalogs.contentTypes, 'talking');
        fillSelect($('creatorSpeechBehavior'), catalogs.speechBehaviors, 'direct_to_camera');
        fillSelect($('creatorCamera'), catalogs.cameraPresets, 'front_on_eye_level');
        fillSelect($('creatorCameraMotion'), catalogs.cameraMotions, 'static');
        fillSelect($('creatorExpressionArc'), catalogs.expressionArcs, 'auto');
        fillSelect($('creatorBodyAction'), catalogs.bodyActions, 'conversational_gesture');
        fillSelect($('creatorOutfit'), catalogs.outfitPacks, '', 'Auto · Character wardrobe');
        fillSelect($('creatorScene'), catalogs.scenes, '', 'Auto · let the concept decide');
        const sceneSelect = $('creatorScene');
        if (sceneSelect) sceneSelect.appendChild(option('__custom__', 'Custom scene…'));
        syncSceneCustom();
    }

    async function refreshSession() {
        const conversationId = typeof Conversations !== 'undefined' && Conversations.currentId
            ? Conversations.currentId() : '';
        if (!conversationId) {
            session = null;
            renderSession();
            return;
        }
        const response = await fetch('/api/creator-studio/state?conversationId=' + encodeURIComponent(conversationId));
        if (!response.ok) return;
        const data = await response.json();
        session = data.session || null;
        if (session && characters.some((character) => character.id === session.characterId)) {
            $('creatorCharacterSelect').value = session.characterId;
            paintCharacter();
            if (session.content) renderTraits(session.content.personality || ['playful']);
            const sceneSelect = $('creatorScene');
            if (sceneSelect && session.content && session.content.sceneId
                && Array.from(sceneSelect.options).some((opt) => opt.value === session.content.sceneId)) {
                sceneSelect.value = session.content.sceneId;
                syncSceneCustom();
            }
        }
        renderSession();
        if (session && session.status === 'generating') {
            if (!generationPending) {
                generationPending = true;
                setProgress('Creator Studio video is rendering…', Math.max(progressPercent, 68));
            }
        } else if (session && session.status === 'failed') {
            generationPending = false;
            setProgress(session.error || 'Generation failed.', progressPercent, 'failed');
        } else if (session && session.status === 'ready') {
            generationPending = false;
            if (progressPercent < 100 || !progressPercent) setProgress('Video added to this content session.', 100, 'complete');
        }
    }

    function renderSession() {
        const title = $('creatorSessionTitle');
        const list = $('creatorSessionVideos');
        if (!title || !list) return;
        $('creatorRegenerateLayers').querySelectorAll('button').forEach((button) => { button.disabled = !session; });
        if (!session) {
            list.replaceChildren();
            delete list.dataset.videoKey;
            title.textContent = 'Your generated videos will appear here.';
            return;
        }
        title.textContent = (session.creatorName || 'Creator') + ' · ' + (session.content && session.content.concept || 'Content session');
        const videos = (session.videos || []).filter((video) => video && typeof video === 'object').slice().reverse();
        const videoKey = JSON.stringify(videos.map((video) => [video.id, video.url]));
        if (list.dataset.videoKey !== videoKey) {
            list.replaceChildren();
            videos.forEach((video, index) => {
                const card = document.createElement('article');
                card.className = 'creator-session-video';
                const label = document.createElement('div');
                label.className = 'creator-session-video-title';
                label.textContent = 'Video ' + (videos.length - index) + ' · ' + (video.title || 'Creator video');
                card.appendChild(label);
                if (video.url) {
                    const player = document.createElement('video');
                    player.controls = true;
                    player.preload = 'metadata';
                    player.playsInline = true;
                    player.src = video.url;
                    card.appendChild(player);
                } else {
                    const unavailable = document.createElement('div');
                    unavailable.className = 'creator-session-video-error';
                    unavailable.textContent = 'This video is unavailable.';
                    card.appendChild(unavailable);
                }
                list.appendChild(card);
            });
            list.dataset.videoKey = videoKey;
        }
        const pending = list.querySelector('.creator-session-pending');
        if (session.status === 'generating') {
            if (!pending) {
                const indicator = document.createElement('div');
                indicator.className = 'creator-session-pending';
                indicator.textContent = 'A new performance is rendering…';
                list.prepend(indicator);
            }
        } else if (pending) {
            pending.remove();
        }
    }

    function setStatus(text) {
        const status = $('creatorStudioStatus');
        if (status) status.textContent = text || '';
    }

    function setProgress(label, percent, state) {
        const panel = $('creatorStudioProgress');
        const bar = $('creatorStudioProgressBar');
        const fill = $('creatorStudioProgressFill');
        const caption = $('creatorStudioProgressLabel');
        if (!panel || !bar || !fill || !caption) return;
        const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        progressPercent = value;
        panel.hidden = false;
        panel.dataset.state = state || (generationPending ? 'running' : '');
        bar.setAttribute('aria-valuenow', String(value));
        fill.style.width = value + '%';
        caption.textContent = label || '';
    }

    function suggestionState() {
        return {
            characterId: $('creatorCharacterSelect').value,
            contentType: $('creatorContentType').value,
            concept: $('creatorConcept').value.trim(),
            personality: selectedTraits(),
            speechBehavior: $('creatorSpeechBehavior').value,
            duration: Number($('creatorDuration').value),
            camera: $('creatorCamera').value,
            cameraMotion: $('creatorCameraMotion').value,
            expressionArc: $('creatorExpressionArc').value,
            bodyAction: $('creatorBodyAction').value,
            onCameraAction: $('creatorOnCameraAction').value.trim(),
            ...scenePayload(),
            outfit: 'Auto',
            outfitPack: $('creatorOutfit').value,
            voice: {
                voiceId: $('creatorVoice').value,
                tone: $('creatorVoiceTone').value,
                speed: $('creatorVoiceSpeed').value,
                pitch: $('creatorVoicePitch').value,
                energy: $('creatorEnergy').value,
                emotion: $('creatorVoiceEmotion').value
            },
            energy: $('creatorEnergy').value,
            pacing: $('creatorPacing').value,
            pauseFrequency: $('creatorPauses').value,
            eyeContact: $('creatorEyeContact').value
        };
    }

    function closeSuggestions() {
        const panel = $('creatorSuggestionPanel');
        const button = $('creatorSuggestionButton');
        if (!panel || !button) return;
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
    }

    function renderSuggestions(data) {
        const list = $('creatorSuggestionList');
        const based = $('creatorSuggestionBased');
        const message = $('creatorSuggestionMessage');
        const more = $('creatorSuggestionMore');
        list.replaceChildren();
        message.hidden = true;
        based.textContent = 'Based on: ' + (data.basedOn || 'your Creator Studio selections');
        based.hidden = false;
        (Array.isArray(data.suggestions) ? data.suggestions : []).forEach((suggestion) => {
            if (!suggestion || !suggestion.text) return;
            const card = document.createElement('article');
            card.className = 'creator-suggestion-item';
            const text = document.createElement('p');
            text.className = 'creator-suggestion-text';
            const concept = suggestion.concept || suggestion.text || '';
            const action = suggestion.action || '';
            const conceptLine = document.createElement('span');
            conceptLine.className = 'creator-suggestion-part';
            const conceptLabel = document.createElement('strong');
            conceptLabel.textContent = 'Dialogue concept';
            conceptLine.append(conceptLabel, document.createTextNode(' ' + concept));
            text.appendChild(conceptLine);
            if (action) {
                const actionLine = document.createElement('span');
                actionLine.className = 'creator-suggestion-part';
                const actionLabel = document.createElement('strong');
                actionLabel.textContent = 'On-camera action';
                actionLine.append(actionLabel, document.createTextNode(' ' + action));
                text.appendChild(actionLine);
            }
            card.appendChild(text);
            if (suggestion.reason) {
                const reason = document.createElement('span');
                reason.className = 'creator-suggestion-reason';
                reason.textContent = suggestion.reason;
                card.appendChild(reason);
            }
            const use = document.createElement('button');
            use.className = 'creator-suggestion-use';
            use.type = 'button';
            use.dataset.concept = concept;
            use.dataset.action = action;
            use.textContent = 'Use this';
            card.appendChild(use);
            list.appendChild(card);
        });
        more.hidden = list.childElementCount === 0;
    }

    async function requestSuggestions() {
        const panel = $('creatorSuggestionPanel');
        const trigger = $('creatorSuggestionButton');
        const more = $('creatorSuggestionMore');
        const message = $('creatorSuggestionMessage');
        const list = $('creatorSuggestionList');
        const based = $('creatorSuggestionBased');
        const conversationId = typeof Conversations !== 'undefined' && Conversations.currentId
            ? Conversations.currentId() : '';
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        trigger.disabled = true;
        more.disabled = true;
        trigger.textContent = '✨ Thinking…';
        message.textContent = 'Finding ideas for these settings…';
        message.hidden = false;
        list.replaceChildren();
        based.hidden = true;
        more.hidden = true;
        try {
            if (!conversationId) throw new Error('Open a conversation first.');
            const response = await fetch('/api/creator-studio/suggestions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversationId, state: suggestionState() })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not generate suggestions.');
            renderSuggestions(data);
            if (!list.childElementCount) throw new Error('No suggestions were returned.');
        } catch (_) {
            list.replaceChildren();
            based.hidden = true;
            message.textContent = "Couldn't generate suggestions. Try again.";
            message.hidden = false;
            more.hidden = true;
        } finally {
            trigger.disabled = false;
            more.disabled = false;
            trigger.textContent = '✨ AI Suggestion';
        }
    }

    function onProgressEvent(event) {
        if (!event || !event.detail) return;
        const detail = event.detail;
        const currentConversationId = typeof Conversations !== 'undefined' && Conversations.currentId
            ? Conversations.currentId()
            : '';
        if (detail.conversationId) {
            if (progressConversationId && detail.conversationId !== progressConversationId) return;
            if (currentConversationId && detail.conversationId !== currentConversationId) return;
            progressConversationId = detail.conversationId;
        }
        if (detail.stage) {
            generationPending = true;
            setProgress(detail.label, detail.percent, detail.state);
            return;
        }
        if (!generationPending) return;
        if (detail.queued) {
            const position = detail.queued.position || 1;
            setProgress('Waiting in the shared generation queue · position ' + position, Math.min(progressPercent, 5));
            return;
        }
        if (detail.generating) {
            setProgress(detail.generating, Math.max(progressPercent, 68));
            return;
        }
        if (detail.progress) {
            if (detail.progress.idle) {
                setProgress('H3 is finishing the video…', 98);
            } else if (detail.progress.max > 0) {
                const pct = Math.round((detail.progress.value / detail.progress.max) * 100);
                setProgress('Rendering creator video · ' + pct + '%', 68 + pct * 0.28);
            }
            return;
        }
        if (detail.complete) {
            generationPending = false;
            setProgress('Creator video complete.', 100, 'complete');
            return;
        }
        if (detail.message) {
            generationPending = false;
            setProgress(detail.message, progressPercent, 'failed');
            return;
        }
        if (detail.error) {
            generationPending = false;
            setProgress(detail.error, progressPercent, 'failed');
        }
    }

    function open() {
        const overlay = $('creatorStudioOverlay');
        closeSuggestions();
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add('open'));
        setStatus('');
        loadOptions().then(refreshSession).catch((error) => setStatus(error.message));
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!$('creatorStudioOverlay').classList.contains('open')) return;
            refreshSession().catch(() => {});
        }, 2500);
    }

    function close() {
        const overlay = $('creatorStudioOverlay');
        closeSuggestions();
        overlay.classList.remove('open');
        setTimeout(() => { overlay.hidden = true; }, 180);
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
    }

    async function generate() {
        try {
            const characterId = $('creatorCharacterSelect').value;
            const character = characters.find((item) => item.id === characterId);
            if (!character) throw new Error('Choose a saved Character first.');
            generationPending = true;
            progressConversationId = typeof Conversations !== 'undefined' && Conversations.currentId
                ? Conversations.currentId()
                : null;
            setProgress('Using ' + character.name + ' as the creator identity…', 3);
            const personality = selectedTraits();
            if (personality.includes('flirty') && !character.adult) {
                throw new Error('Flirty presentation requires an explicitly adult Character identity.');
            }
            const concept = $('creatorConcept').value.trim();
            if (!concept) throw new Error('Add a short idea for what your creator wants to say.');
            const onCameraAction = $('creatorOnCameraAction').value.trim();
            setProgress('Building the script and performance beats…', 8);
            if (typeof Chat === 'undefined' || !Chat.sendMessage) throw new Error('Chat is not ready yet.');
            Chat.sendMessage({
                text: 'Create a ' + ($('creatorContentType').selectedOptions[0]?.textContent || 'talking') + ' for @' + character.name + ' about ' + concept + '.',
                characters: [{ id: character.id }],
                creatorStudioAction: {
                    type: 'generate', characterId: character.id, concept,
                    onCameraAction,
                    contentType: $('creatorContentType').value,
                    personality,
                    speechBehavior: $('creatorSpeechBehavior').value,
                    duration: Number($('creatorDuration').value),
                    voice: {
                        voiceId: $('creatorVoice').value,
                        tone: $('creatorVoiceTone').value,
                        speed: $('creatorVoiceSpeed').value,
                        pitch: $('creatorVoicePitch').value, energy: $('creatorEnergy').value,
                        emotion: $('creatorVoiceEmotion').value
                    },
                    ...scenePayload(),
                    outfit: 'Auto',
                    outfitPack: $('creatorOutfit').value,
                    camera: $('creatorCamera').value,
                    cameraMotion: $('creatorCameraMotion').value,
                    expressionArc: $('creatorExpressionArc').value,
                    bodyAction: $('creatorBodyAction').value,
                    energy: $('creatorEnergy').value,
                    pacing: $('creatorPacing').value,
                    pauseFrequency: $('creatorPauses').value,
                    eyeContact: $('creatorEyeContact').value,
                    expressionVariation: 'high'
                }
            });
            setProgress('Request sent. Creator Studio stays in your chat while this window is closed.', 10);
            setTimeout(() => refreshSession().catch(() => {}), 1000);
        } catch (error) {
            generationPending = false;
            setProgress(error.message, progressPercent, 'failed');
        }
    }

    function bind() {
        $('creatorStudioOpen').addEventListener('click', open);
        $('creatorStudioClose').addEventListener('click', close);
        $('creatorStudioOverlay').addEventListener('click', (event) => { if (event.target === $('creatorStudioOverlay')) close(); });
        $('creatorCharacterSelect').addEventListener('change', () => {
            paintCharacter();
        });
        if ($('creatorScene')) $('creatorScene').addEventListener('change', syncSceneCustom);
        const sheetButton = $('creatorCharacterSheet');
        if (sheetButton) sheetButton.addEventListener('click', () => {
            const characterId = $('creatorCharacterSelect').value;
            if (characterId && window.CharacterIdentityUI && typeof window.CharacterIdentityUI.open === 'function') {
                window.CharacterIdentityUI.open(characterId);
            }
        });
        $('creatorGenerate').addEventListener('click', generate);
        $('creatorSuggestionButton').addEventListener('click', () => {
            if (!$('creatorSuggestionPanel').hidden) {
                closeSuggestions();
                return;
            }
            requestSuggestions();
        });
        $('creatorSuggestionClose').addEventListener('click', closeSuggestions);
        $('creatorSuggestionMore').addEventListener('click', requestSuggestions);
        $('creatorSuggestionList').addEventListener('click', (event) => {
            const button = event.target.closest('button[data-concept]');
            if (!button) return;
            $('creatorConcept').value = button.dataset.concept || '';
            $('creatorConcept').dispatchEvent(new Event('input', { bubbles: true }));
            $('creatorOnCameraAction').value = button.dataset.action || '';
            $('creatorOnCameraAction').dispatchEvent(new Event('input', { bubbles: true }));
            closeSuggestions();
            $('creatorConcept').focus();
        });
        $('creatorNewSession').addEventListener('click', () => {
            if (typeof Chat !== 'undefined' && Chat.sendMessage) {
                Chat.sendMessage({ text: 'Start a new Creator Studio session.', creatorStudioAction: { type: 'new_session' } });
                setTimeout(() => refreshSession().catch(() => {}), 600);
            }
        });
        $('creatorRegenerateLayers').addEventListener('click', (event) => {
            const button = event.target.closest('button[data-dimension]');
            if (!button || !session || !session.content) return;
            const dimension = button.dataset.dimension;
            if (typeof Chat === 'undefined' || !Chat.sendMessage) return;
            generationPending = true;
            progressConversationId = typeof Conversations !== 'undefined' && Conversations.currentId
                ? Conversations.currentId()
                : null;
            setProgress('Preparing to regenerate ' + dimension.replace(/_/g, ' ') + '…', 5);
            Chat.sendMessage({
                text: 'Regenerate the ' + dimension.replace(/_/g, ' ') + ' only for @' + (session.creatorName || 'creator') + '.',
                characters: [{ id: session.characterId }],
                creatorStudioAction: {
                    type: 'generate', characterId: session.characterId,
                    dimension, concept: session.content.concept, onCameraAction: session.content.onCameraAction,
                    duration: session.content.duration,
                    voice: dimension === 'voice' ? session.content.voice : undefined
                }
            });
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !$('creatorStudioOverlay').hidden) {
                if (!$('creatorSuggestionPanel').hidden) {
                    closeSuggestions();
                    event.stopPropagation();
                } else {
                    close();
                }
            }
        });
        window.addEventListener('creator-studio-progress', onProgressEvent);
    }

    document.addEventListener('DOMContentLoaded', bind);
    return { open, close, refresh: refreshSession };
})();
