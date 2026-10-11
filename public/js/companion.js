/* ============================================
   JARVIS — Companion UI
   The character companionship surface: a profile
   panel for each saved character (personality +
   fictional state + memory toggles), a memory
   browser (search, filter, edit, pin, delete,
   clear) and a "Start Companion Chat" action that
   opens the existing chat on a character-linked
   conversation. Uses the shared modal + Dialog
   conventions; no second design system.
   ============================================ */

const CompanionUI = (() => {
    let overlay = null;
    let listEl = null;
    let detailEl = null;
    let titleEl = null;

    let characters = [];
    let currentId = null;
    let globalSettings = null;
    let currentConversations = [];
    let memoryQuery = '';
    let memoryType = '';
    let busy = false;

    function stripMarkers(value) {
        return String(value || '')
            .replace(/\n*\[\[(?:director|longvideo|playground|ugc|creator-frame):[^\n]*?\]\]/g, '')
            .replace(/\n*\[\[prompt-suggestion\]\]/g, '')
            .replace(/\n*\[\[photo-actions\]\]/g, '')
            .trim();
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    async function api(method, url, body) {
        const options = { method };
        if (body !== undefined) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    function init() {
        overlay = document.getElementById('companionOverlay');
        listEl = document.getElementById('companionList');
        detailEl = document.getElementById('companionDetail');
        titleEl = document.getElementById('companionCharacterName');
        const openBtn = document.getElementById('companionsBtn');
        if (openBtn) openBtn.addEventListener('click', open);
        const closeBtn = document.getElementById('companionClose');
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay && overlay.classList.contains('open')) close();
        });
    }

    async function open() {
        if (!overlay) return;
        overlay.classList.add('open');
        detailEl.innerHTML = '';
        detailEl.appendChild(el('div', 'companion-empty', 'Loading…'));
        try {
            const [charsRes, settingsRes] = await Promise.all([
                api('GET', '/api/characters'),
                api('GET', '/api/companion/settings')
            ]);
            characters = charsRes.characters || [];
            globalSettings = settingsRes.settings || null;
            if (!currentId || !characters.some((c) => c.id === currentId)) {
                currentId = characters.length ? characters[0].id : null;
            }
        } catch (err) {
            detailEl.innerHTML = '';
            detailEl.appendChild(el('div', 'companion-empty', 'Could not load companions: ' + err.message));
            return;
        }
        renderList();
        await renderDetail();
    }

    function close() {
        if (overlay) overlay.classList.remove('open');
    }

    function renderList() {
        listEl.innerHTML = '';
        if (!characters.length) {
            listEl.appendChild(el('div', 'companion-empty', 'No characters yet. Create one in the Creative Playground.'));
            return;
        }
        characters.forEach((character) => {
            const row = el('button', 'companion-list-item' + (character.id === currentId ? ' active' : ''));
            row.type = 'button';
            if (character.approvedBaseImage && character.approvedBaseImage.url) {
                const img = el('img', 'companion-list-thumb');
                img.src = character.approvedBaseImage.url;
                img.alt = '';
                row.appendChild(img);
            } else {
                row.appendChild(el('span', 'companion-list-thumb companion-list-thumb--empty', (character.name || '?').slice(0, 1).toUpperCase()));
            }
            const meta = el('span', 'companion-list-meta');
            meta.appendChild(el('span', 'companion-list-name', character.name || 'Character'));
            meta.appendChild(el('span', 'companion-list-sub', character.identityText ? 'Companion ready' : 'Basic character'));
            row.appendChild(meta);
            row.addEventListener('click', () => { currentId = character.id; renderList(); renderDetail(); });
            listEl.appendChild(row);
        });
    }

    function triSelect(current, onChange) {
        const select = el('select', 'settings-select companion-input');
        [['', 'Use global default'], ['true', 'On'], ['false', 'Off']].forEach(([value, label]) => {
            const option = el('option', null, label);
            option.value = value;
            if ((current === true && value === 'true') || (current === false && value === 'false') ||
                (current !== true && current !== false && value === '')) {
                option.selected = true;
            }
            select.appendChild(option);
        });
        select.addEventListener('change', () => {
            const value = select.value === '' ? null : select.value === 'true';
            onChange(value);
        });
        return select;
    }

    function field(labelText, input, hint) {
        const wrap = el('label', 'companion-field');
        wrap.appendChild(el('span', 'companion-field-label', labelText));
        wrap.appendChild(input);
        if (hint) wrap.appendChild(el('span', 'companion-field-hint', hint));
        return wrap;
    }

    function textInput(value, placeholder, multiline) {
        const node = el(multiline ? 'textarea' : 'input', 'settings-input companion-input');
        if (multiline) node.rows = 3;
        else node.type = 'text';
        node.value = value || '';
        if (placeholder) node.placeholder = placeholder;
        return node;
    }

    function listValue(value) {
        return Array.isArray(value) ? value.join(', ') : (value || '');
    }

    function splitList(value) {
        return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
    }

    async function renderDetail() {
        if (!detailEl) return;
        detailEl.innerHTML = '';
        if (!currentId) {
            detailEl.appendChild(el('div', 'companion-empty', 'Select a character.'));
            return;
        }
        titleEl.textContent = 'Loading…';
        let profile;
        try {
            profile = await api('GET', '/api/companion/' + encodeURIComponent(currentId));
        } catch (err) {
            detailEl.appendChild(el('div', 'companion-empty', err.message));
            return;
        }
        titleEl.textContent = profile.character.name;
        currentConversations = profile.conversations || [];
        renderProfile(profile);
    }

    function renderProfile(profile) {
        detailEl.innerHTML = '';
        const character = profile.character;
        const settings = profile.settings || {};

        // Header: portrait + identity + primary actions.
        const header = el('div', 'companion-profile-head');
        if (character.image) {
            const img = el('img', 'companion-portrait');
            img.src = character.image;
            img.alt = character.name;
            img.addEventListener('click', () => {
                if (window.Gallery && window.Gallery.openFromUrl) window.Gallery.openFromUrl(character.image);
            });
            header.appendChild(img);
        }
        const headMeta = el('div', 'companion-profile-meta');
        headMeta.appendChild(el('h3', 'companion-profile-name', character.name));
        if (character.identityText) headMeta.appendChild(el('p', 'companion-profile-identity', character.identityText));

        const actions = el('div', 'companion-profile-actions');
        const chatBtn = el('button', 'companion-btn companion-btn--primary', 'Start Companion Chat');
        chatBtn.type = 'button';
        chatBtn.addEventListener('click', startChat);
        actions.appendChild(chatBtn);
        headMeta.appendChild(actions);

        const stats = el('div', 'companion-stats');
        const s = profile.stats || {};
        stats.appendChild(el('span', null, (s.total || 0) + ' memories'));
        stats.appendChild(el('span', null, (s.semantic || 0) + ' facts'));
        stats.appendChild(el('span', null, (s.episodic || 0) + ' experiences'));
        if (s.pinned) stats.appendChild(el('span', null, s.pinned + ' pinned'));
        headMeta.appendChild(stats);
        header.appendChild(headMeta);
        detailEl.appendChild(header);

        // Personality settings.
        const settingsCard = el('section', 'companion-card');
        settingsCard.appendChild(el('h4', 'companion-card-title', 'Personality & Style'));
        const form = el('div', 'companion-form');
        const fields = {
            personality: textInput(settings.personality, 'Warm, curious, a little sarcastic…', true),
            traits: textInput(listValue(settings.traits), 'curious, loyal, dry-witted'),
            communicationStyle: textInput(settings.communicationStyle, 'Casual and direct, uses short sentences'),
            humor: textInput(settings.humor, 'Deadpan, playful teasing'),
            habits: textInput(listValue(settings.habits), 'asks follow-up questions, sends short replies at night'),
            interests: textInput(listValue(settings.interests), 'synth music, sci-fi, urban photography'),
            preferences: textInput(listValue(settings.preferences), 'prefers tea over coffee, loves rainy days'),
            goals: textInput(listValue(settings.goals), 'finishing a short story, learning to cook'),
            background: textInput(settings.background, 'A fictional life history…', true),
            relationship: textInput(settings.relationship, 'A close, easygoing friend you have known for a while'),
            voice: textInput(settings.voice, 'Lower register, unhurried, warm')
        };
        form.appendChild(field('Personality', fields.personality));
        form.appendChild(field('Traits', fields.traits, 'Comma separated'));
        form.appendChild(field('Communication style', fields.communicationStyle));
        form.appendChild(field('Humor', fields.humor));
        form.appendChild(field('Habits', fields.habits, 'Comma separated'));
        form.appendChild(field('Interests', fields.interests, 'Comma separated'));
        form.appendChild(field('Preferences & opinions', fields.preferences, 'Comma separated'));
        form.appendChild(field('Goals', fields.goals, 'Comma separated'));
        form.appendChild(field('Background', fields.background));
        form.appendChild(field('Relationship with you', fields.relationship));
        form.appendChild(field('Voice & tone', fields.voice));

        const toggles = el('div', 'companion-toggles');
        const localToggle = { memoryEnabled: settings.memoryEnabled, autoMemory: settings.autoMemory, lifeProgression: settings.lifeProgression };
        toggles.appendChild(field('Memory for this character', triSelect(settings.memoryEnabled, (v) => { localToggle.memoryEnabled = v; }), 'Overrides the global setting'));
        toggles.appendChild(field('Automatic memory formation', triSelect(settings.autoMemory, (v) => { localToggle.autoMemory = v; })));
        toggles.appendChild(field('Fictional life progression', triSelect(settings.lifeProgression, (v) => { localToggle.lifeProgression = v; })));
        form.appendChild(toggles);

        const saveRow = el('div', 'companion-form-actions');
        const status = el('span', 'companion-status');
        const saveBtn = el('button', 'companion-btn', 'Save personality');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            status.textContent = 'Saving…';
            try {
                const body = {
                    personality: fields.personality.value.trim(),
                    traits: splitList(fields.traits.value),
                    communicationStyle: fields.communicationStyle.value.trim(),
                    humor: fields.humor.value.trim(),
                    habits: splitList(fields.habits.value),
                    interests: splitList(fields.interests.value),
                    preferences: splitList(fields.preferences.value),
                    goals: splitList(fields.goals.value),
                    background: fields.background.value.trim(),
                    relationship: fields.relationship.value.trim(),
                    voice: fields.voice.value.trim(),
                    memoryEnabled: localToggle.memoryEnabled,
                    autoMemory: localToggle.autoMemory,
                    lifeProgression: localToggle.lifeProgression
                };
                await api('POST', '/api/companion/' + encodeURIComponent(currentId), body);
                status.textContent = 'Saved';
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
            } finally {
                saveBtn.disabled = false;
                setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 2000);
            }
        });
        saveRow.appendChild(saveBtn);
        saveRow.appendChild(status);
        form.appendChild(saveRow);
        settingsCard.appendChild(form);
        detailEl.appendChild(settingsCard);

        // Fictional state.
        detailEl.appendChild(buildStateCard(profile.state || {}));

        // Living-character life state (activity/location/outfit/...) + history.
        detailEl.appendChild(buildLifeCard(profile));

        // Global memory settings.
        detailEl.appendChild(buildGlobalSettingsCard());

        // Memory browser.
        detailEl.appendChild(buildMemoryCard());
        renderMemories();
    }

    function buildStateCard(state) {
        const card = el('section', 'companion-card');
        card.appendChild(el('h4', 'companion-card-title', 'Current fictional life'));
        card.appendChild(el('p', 'companion-card-hint', 'Her ongoing in-fiction circumstances. Only what you set here (and what she forms from conversation) is real to her — she never claims to have done anything outside this app.'));

        const form = el('div', 'companion-form');
        const goals = textInput(listValue(state.goals), 'finishing a short story, planning a weekend trip', true);
        const activities = textInput(listValue(state.activities), 'practising guitar most evenings', true);
        const notes = textInput(state.notes, 'Anything else about her current life', true);
        form.appendChild(field('Goals', goals, 'Comma separated'));
        form.appendChild(field('Activities', activities, 'Comma separated'));
        form.appendChild(field('Notes', notes));

        const relBox = el('div', 'companion-relationships');
        relBox.appendChild(el('span', 'companion-field-label', 'People in her life'));
        (state.relationships || []).forEach((rel, index) => {
            const row = el('div', 'companion-relationship-row');
            row.appendChild(el('span', 'companion-relationship-text', (rel.name || '') + (rel.description ? ' — ' + rel.description : '')));
            const del = el('button', 'companion-icon-btn', '\u00d7');
            del.type = 'button';
            del.title = 'Remove';
            del.addEventListener('click', () => {
                const next = (state.relationships || []).filter((_, i) => i !== index);
                saveState({ relationships: next });
            });
            row.appendChild(del);
            relBox.appendChild(row);
        });
        const relName = textInput('', 'Name');
        const relDesc = textInput('', 'How she knows them');
        const relAdd = el('button', 'companion-btn companion-btn--small', 'Add person');
        relAdd.type = 'button';
        relAdd.addEventListener('click', () => {
            const name = relName.value.trim();
            if (!name) return;
            const next = (state.relationships || []).concat([{ name, description: relDesc.value.trim() }]);
            saveState({ relationships: next });
        });
        const relInputs = el('div', 'companion-relationship-add');
        relInputs.appendChild(relName);
        relInputs.appendChild(relDesc);
        relInputs.appendChild(relAdd);
        relBox.appendChild(relInputs);
        form.appendChild(relBox);

        const saveRow = el('div', 'companion-form-actions');
        const status = el('span', 'companion-status');
        const saveBtn = el('button', 'companion-btn', 'Save life state');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', () => saveState({
            goals: splitList(goals.value),
            activities: splitList(activities.value),
            notes: notes.value.trim()
        }, saveBtn, status));
        saveRow.appendChild(saveBtn);
        saveRow.appendChild(status);
        form.appendChild(saveRow);
        card.appendChild(form);

        async function saveState(patch, btn, stat) {
            if (btn) btn.disabled = true;
            if (stat) stat.textContent = 'Saving…';
            try {
                await api('POST', '/api/companion/' + encodeURIComponent(currentId) + '/state', patch);
                if (stat) stat.textContent = 'Saved';
                await renderDetail();
            } catch (err) {
                if (stat) stat.textContent = 'Error: ' + err.message;
            } finally {
                if (btn) btn.disabled = false;
            }
        }
        return card;
    }

    function buildLifeCard(profile) {
        const lifeData = profile.life || {};
        const life = lifeData.life || {};
        const card = el('section', 'companion-card');
        const head = el('div', 'companion-card-head');
        head.appendChild(el('h4', 'companion-card-title', 'Life right now'));
        card.appendChild(head);
        card.appendChild(el('p', 'companion-card-hint', 'What she is doing, where, and wearing. This drives her selfies and photo framing. Fiction she may mention naturally, never a real-world action.'));

        const form = el('div', 'companion-form');
        const fields = {
            activity: textInput(life.activity, 'making a pour-over coffee'),
            location: textInput(life.location, 'the kitchen'),
            outfit: textInput(life.outfit, 'an oversized tee and lounge shorts'),
            context: textInput(life.context, 'a slow morning at home'),
            mood: textInput(life.mood, 'relaxed'),
            tone: textInput(life.tone, 'easygoing, a little sleepy'),
            planned: textInput(life.planned, 'meet a friend for lunch')
        };
        form.appendChild(field('Doing now', fields.activity));
        form.appendChild(field('Location', fields.location));
        form.appendChild(field('Wearing', fields.outfit));
        form.appendChild(field('Context / why', fields.context));
        form.appendChild(field('Mood', fields.mood));
        form.appendChild(field('Texting tone', fields.tone));
        form.appendChild(field('Next planned', fields.planned));

        const meta = el('div', 'companion-life-meta');
        if (life.updatedAt) meta.appendChild(el('span', null, 'Updated ' + new Date(life.updatedAt).toLocaleString()));
        if (life.provenance) meta.appendChild(el('span', 'companion-badge', 'source: ' + life.provenance));
        form.appendChild(meta);

        const saveRow = el('div', 'companion-form-actions');
        const status = el('span', 'companion-status');
        const saveBtn = el('button', 'companion-btn', 'Save life state');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            status.textContent = 'Saving\u2026';
            try {
                await api('POST', '/api/character-life/' + encodeURIComponent(currentId), {
                    activity: fields.activity.value.trim(),
                    location: fields.location.value.trim(),
                    outfit: fields.outfit.value.trim(),
                    context: fields.context.value.trim(),
                    mood: fields.mood.value.trim(),
                    tone: fields.tone.value.trim(),
                    planned: fields.planned.value.trim()
                });
                status.textContent = 'Saved';
                await renderDetail();
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
            } finally {
                saveBtn.disabled = false;
            }
        });
        const advanceBtn = el('button', 'companion-btn companion-btn--small', 'Advance life');
        advanceBtn.type = 'button';
        advanceBtn.title = 'Ask her to move to a new activity now';
        advanceBtn.addEventListener('click', async () => {
            advanceBtn.disabled = true;
            status.textContent = 'Advancing\u2026';
            try {
                await api('POST', '/api/character-life/' + encodeURIComponent(currentId) + '/evolve', {});
                await renderDetail();
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
            } finally {
                advanceBtn.disabled = false;
            }
        });
        saveRow.appendChild(saveBtn);
        saveRow.appendChild(advanceBtn);
        saveRow.appendChild(status);
        form.appendChild(saveRow);
        card.appendChild(form);

        const recent = (lifeData.recentActivities || []).slice(-6).reverse();
        if (recent.length) {
            const recentBox = el('div', 'companion-life-recent');
            recentBox.appendChild(el('span', 'companion-field-label', 'Recent activities'));
            recent.forEach((entry) => {
                recentBox.appendChild(el('span', 'companion-life-recent-item', entry.activity + (entry.location ? ' \u00b7 ' + entry.location : '')));
            });
            card.appendChild(recentBox);
        }
        const scenes = (lifeData.sceneHistory || []).slice(-4).reverse();
        if (scenes.length) {
            const sceneBox = el('div', 'companion-life-scenes');
            const sceneHead = el('div', 'companion-life-scene-head');
            sceneHead.appendChild(el('span', 'companion-field-label', 'Recent photos'));
            const clearBtn = el('button', 'companion-btn companion-btn--small', 'Clear photo history');
            clearBtn.type = 'button';
            clearBtn.addEventListener('click', async () => {
                await api('DELETE', '/api/character-life/' + encodeURIComponent(currentId) + '/scenes');
                await renderDetail();
            });
            sceneHead.appendChild(clearBtn);
            sceneBox.appendChild(sceneHead);
            scenes.forEach((scene) => {
                sceneBox.appendChild(el('span', 'companion-life-scene-item', (scene.summary || scene.intent) + (scene.at ? ' \u00b7 ' + new Date(scene.at).toLocaleDateString() : '')));
            });
            card.appendChild(sceneBox);
        }
        return card;
    }

    function buildGlobalSettingsCard() {
        const card = el('section', 'companion-card');
        card.appendChild(el('h4', 'companion-card-title', 'Memory settings'));
        card.appendChild(el('p', 'companion-card-hint', 'These apply to every companion. Per-character overrides are on the character above. All memory stays on this machine.'));
        const form = el('div', 'companion-form companion-global-form');
        const settings = globalSettings || {};
        const toggleDefs = [
            ['memoryEnabled', 'Enable memory'],
            ['autoMemory', 'Form memories automatically'],
            ['extractionEnabled', 'Run memory extraction'],
            ['retrievalEnabled', 'Recall memories in replies'],
            ['lifeProgression', 'Allow fictional life progression']
        ];
        const checks = {};
        toggleDefs.forEach(([key, label]) => {
            const wrap = el('label', 'companion-check');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = settings[key] !== false;
            checks[key] = input;
            wrap.appendChild(input);
            wrap.appendChild(el('span', null, label));
            form.appendChild(wrap);
        });
        const numberInputs = {};
        [['retentionDays', 'Retention (days, 0 = keep)'], ['maxMemoriesPerCharacter', 'Max memories per character'],
            ['maxContextMemories', 'Memories per reply'], ['maxContextChars', 'Memory context size (chars)'],
            ['lifeIntervalMinutes', 'Advance fictional life every (minutes)'],
            ['proactiveMinIntervalMinutes', 'Minimum time between updates (minutes)'],
            ['quietHoursStart', 'Quiet hours start (hour, 0-23)'], ['quietHoursEnd', 'Quiet hours end (hour, 0-23)']].forEach(([key, label]) => {
            const input = el('input', 'settings-input companion-input companion-number');
            input.type = 'number';
            input.value = settings[key] != null ? settings[key] : '';
            numberInputs[key] = input;
            form.appendChild(field(label, input));
        });

        // Proactive behavior: passive by default.
        const behavior = { initiative: settings.initiative || 'passive', photoSharing: settings.photoSharing || 'ask' };
        const initiativeSelect = el('select', 'settings-select companion-input');
        [['passive', 'Passive - only responds when messaged'], ['conversational', 'Conversational - may offer photos in chat'], ['scheduled', 'Scheduled - may advance her life on a timer']].forEach(([value, label]) => {
            const option = el('option', null, label);
            option.value = value;
            if (value === behavior.initiative) option.selected = true;
            initiativeSelect.appendChild(option);
        });
        initiativeSelect.addEventListener('change', () => { behavior.initiative = initiativeSelect.value; });
        form.appendChild(field('Initiative', initiativeSelect));
        const photoSelect = el('select', 'settings-select companion-input');
        [['ask', 'Ask before sending a photo'], ['auto', 'Send a photo when she offers'], ['off', 'Never send offered photos']].forEach(([value, label]) => {
            const option = el('option', null, label);
            option.value = value;
            if (value === behavior.photoSharing) option.selected = true;
            photoSelect.appendChild(option);
        });
        photoSelect.addEventListener('change', () => { behavior.photoSharing = photoSelect.value; });
        form.appendChild(field('Spontaneous photos', photoSelect));

        const saveRow = el('div', 'companion-form-actions');
        const status = el('span', 'companion-status');
        const saveBtn = el('button', 'companion-btn', 'Save memory settings');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            status.textContent = 'Saving\u2026';
            try {
                const body = {};
                toggleDefs.forEach(([key]) => { body[key] = checks[key].checked; });
                body.initiative = behavior.initiative;
                body.photoSharing = behavior.photoSharing;
                Object.keys(numberInputs).forEach((key) => {
                    const raw = numberInputs[key].value;
                    if (raw !== '') body[key] = Number(raw);
                });
                const result = await api('POST', '/api/companion/settings', body);
                globalSettings = result.settings;
                status.textContent = 'Saved';
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
            } finally {
                saveBtn.disabled = false;
            }
        });
        saveRow.appendChild(saveBtn);
        saveRow.appendChild(status);
        form.appendChild(saveRow);
        card.appendChild(form);
        return card;
    }

    function buildMemoryCard() {
        const card = el('section', 'companion-card');
        const head = el('div', 'companion-card-head');
        head.appendChild(el('h4', 'companion-card-title', 'Memories'));
        const clearBtn = el('button', 'companion-btn companion-btn--danger companion-btn--small', 'Clear all');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', async () => {
            const ok = window.Dialog ? await window.Dialog.confirm({ title: 'Clear memories', message: 'Delete every memory for this character? The conversation history is not affected.', confirmText: 'Clear memories', danger: true }) : confirm('Clear all memories?');
            if (!ok) return;
            await api('DELETE', '/api/companion/' + encodeURIComponent(currentId) + '/memories');
            renderMemories();
        });
        head.appendChild(clearBtn);
        card.appendChild(head);

        const controls = el('div', 'companion-memory-controls');
        const search = el('input', 'settings-input companion-input companion-memory-search');
        search.type = 'search';
        search.placeholder = 'Search memories…';
        search.value = memoryQuery;
        search.addEventListener('input', () => { memoryQuery = search.value; renderMemories(); });
        controls.appendChild(search);
        const typeSelect = el('select', 'settings-select companion-input companion-memory-type');
        [['', 'All types'], ['semantic', 'Facts'], ['episodic', 'Experiences']].forEach(([value, label]) => {
            const option = el('option', null, label);
            option.value = value;
            if (value === memoryType) option.selected = true;
            typeSelect.appendChild(option);
        });
        typeSelect.addEventListener('change', () => { memoryType = typeSelect.value; renderMemories(); });
        controls.appendChild(typeSelect);
        card.appendChild(controls);

        const saveMomentBtn = el('button', 'companion-btn companion-btn--small companion-save-moment', 'Save latest reply as a memory');
        saveMomentBtn.type = 'button';
        saveMomentBtn.addEventListener('click', saveLatestMoment);
        card.appendChild(saveMomentBtn);

        const addRow = el('div', 'companion-memory-add');
        const addInput = el('input', 'settings-input companion-input');
        addInput.type = 'text';
        addInput.placeholder = 'Add a memory she should keep…';
        const addBtn = el('button', 'companion-btn companion-btn--small', 'Add');
        addBtn.type = 'button';
        const addMemory = async () => {
            const value = addInput.value.trim();
            if (!value) return;
            addBtn.disabled = true;
            try {
                await api('POST', '/api/companion/' + encodeURIComponent(currentId) + '/memories', {
                    type: 'semantic',
                    text: value,
                    confidence: 'stated',
                    importance: 3,
                    category: 'user-stated'
                });
                addInput.value = '';
                renderMemories();
            } catch (err) {
                window.Dialog ? window.Dialog.alert({ title: 'Could not add memory', message: err.message }) : alert(err.message);
            } finally {
                addBtn.disabled = false;
            }
        };
        addBtn.addEventListener('click', addMemory);
        addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMemory(); } });
        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);
        card.appendChild(addRow);

        const list = el('div', 'companion-memory-list');
        list.id = 'companionMemoryList';
        card.appendChild(list);
        return card;
    }

    async function saveLatestMoment() {
        const conversation = currentConversations[0];
        if (!conversation) {
            const message = 'Start a companion chat first, then you can save a moment from it.';
            window.Dialog ? window.Dialog.alert({ title: 'Nothing to save', message }) : alert(message);
            return;
        }
        try {
            const data = await api('GET', '/api/conversations/' + encodeURIComponent(conversation.id) + '/messages');
            const messages = data.messages || [];
            const lastAssistant = messages.slice().reverse().find((m) => m.role === 'assistant');
            const text = stripMarkers(lastAssistant && lastAssistant.content);
            if (!text) {
                const message = 'No assistant reply to save yet.';
                window.Dialog ? window.Dialog.alert({ title: 'Nothing to save', message }) : alert(message);
                return;
            }
            await api('POST', '/api/companion/' + encodeURIComponent(currentId) + '/memories', {
                type: 'episodic',
                category: 'shared-moment',
                text: text.slice(0, 500),
                confidence: 'stated',
                importance: 3,
                sourceConversationId: conversation.id,
                sourceMessageId: lastAssistant.id
            });
            renderMemories();
        } catch (err) {
            window.Dialog ? window.Dialog.alert({ title: 'Could not save memory', message: err.message }) : alert(err.message);
        }
    }

    async function renderMemories() {
        const list = document.getElementById('companionMemoryList');
        if (!list || !currentId) return;
        list.innerHTML = '';
        list.appendChild(el('div', 'companion-empty', 'Loading…'));
        let data;
        try {
            const params = new URLSearchParams();
            if (memoryQuery) params.set('query', memoryQuery);
            if (memoryType) params.set('type', memoryType);
            params.set('status', 'all');
            data = await api('GET', '/api/companion/' + encodeURIComponent(currentId) + '/memories?' + params.toString());
        } catch (err) {
            list.innerHTML = '';
            list.appendChild(el('div', 'companion-empty', err.message));
            return;
        }
        list.innerHTML = '';
        const memories = data.memories || [];
        if (!memories.length) {
            list.appendChild(el('div', 'companion-empty', memoryQuery ? 'No matching memories.' : 'No memories yet.'));
            return;
        }
        memories.forEach((memory) => list.appendChild(memoryRow(memory)));
    }

    function memoryRow(memory) {
        const row = el('div', 'companion-memory' + (memory.pinned ? ' pinned' : '') + (memory.status === 'superseded' ? ' superseded' : ''));
        const main = el('div', 'companion-memory-main');
        const badges = el('div', 'companion-memory-badges');
        badges.appendChild(el('span', 'companion-badge', memory.type === 'episodic' ? 'experience' : 'fact'));
        badges.appendChild(el('span', 'companion-badge', memory.category || 'general'));
        if (memory.confidence === 'inferred') badges.appendChild(el('span', 'companion-badge companion-badge--inferred', 'inferred'));
        if (memory.pinned) badges.appendChild(el('span', 'companion-badge companion-badge--pinned', 'pinned'));
        if (memory.status === 'superseded') badges.appendChild(el('span', 'companion-badge companion-badge--superseded', 'superseded'));
        main.appendChild(badges);
        main.appendChild(el('p', 'companion-memory-text', memory.text));
        const meta = el('div', 'companion-memory-meta');
        meta.appendChild(el('span', null, 'Importance ' + (memory.importance || 3) + '/5'));
        if (memory.updatedAt) meta.appendChild(el('span', null, new Date(memory.updatedAt).toLocaleString()));
        main.appendChild(meta);
        row.appendChild(main);

        const actions = el('div', 'companion-memory-actions');
        const pin = el('button', 'companion-icon-btn', memory.pinned ? '\u2605' : '\u2606');
        pin.type = 'button';
        pin.title = memory.pinned ? 'Unpin' : 'Pin';
        pin.addEventListener('click', async () => {
            await api('PATCH', '/api/companion/' + encodeURIComponent(currentId) + '/memories/' + encodeURIComponent(memory.id), { pinned: !memory.pinned });
            renderMemories();
        });
        actions.appendChild(pin);

        const edit = el('button', 'companion-icon-btn', '\u270e');
        edit.type = 'button';
        edit.title = 'Edit';
        edit.addEventListener('click', async () => {
            const value = window.Dialog ? await window.Dialog.prompt({ title: 'Edit memory', value: memory.text, confirmText: 'Save' }) : prompt('Edit memory', memory.text);
            if (value === null || !value.trim()) return;
            await api('PATCH', '/api/companion/' + encodeURIComponent(currentId) + '/memories/' + encodeURIComponent(memory.id), { text: value.trim() });
            renderMemories();
        });
        actions.appendChild(edit);

        const del = el('button', 'companion-icon-btn companion-icon-btn--danger', '\u00d7');
        del.type = 'button';
        del.title = 'Delete';
        del.addEventListener('click', async () => {
            const ok = window.Dialog ? await window.Dialog.confirm({ title: 'Delete memory', message: 'Delete this memory?', confirmText: 'Delete', danger: true }) : confirm('Delete this memory?');
            if (!ok) return;
            await api('DELETE', '/api/companion/' + encodeURIComponent(currentId) + '/memories/' + encodeURIComponent(memory.id));
            renderMemories();
        });
        actions.appendChild(del);
        row.appendChild(actions);
        return row;
    }

    async function startChat() {
        if (!currentId || busy) return;
        busy = true;
        try {
            const result = await api('POST', '/api/companion/' + encodeURIComponent(currentId) + '/conversations', { new: true });
            const conversation = result.conversation;
            close();
            if (conversation && typeof Conversations !== 'undefined') {
                const messages = await Conversations.select(conversation.id);
                if (typeof Chat !== 'undefined') {
                    await Chat.refreshConversationList();
                    Chat.renderMessages(messages || []);
                }
                const input = document.getElementById('chatInput');
                if (input) input.focus();
            }
        } catch (err) {
            window.Dialog ? window.Dialog.alert({ title: 'Could not start chat', message: err.message }) : alert(err.message);
        } finally {
            busy = false;
        }
    }

    return { init, open, close };
})();

window.CompanionUI = CompanionUI;
