/* ============================================
   JARVIS — Creative Playground UI
   The composer "Surprise Me" popover (theme,
   character, locks) and the persisted concept card
   rendered inside a chat message. Actions flow
   back through the normal chat stream; the card is
   carried by a [[playground:{...}]] marker so it
   survives reloads.
   ============================================ */

const PlaygroundUI = (() => {
    const MARKER_RE = /\[\[playground:(\{[^\n]*?\})\]\]/g;

    const ICONS = {
        sparkle: '<path d="M12 3v4"></path><path d="M12 17v4"></path><path d="M3 12h4"></path><path d="M17 12h4"></path><path d="m5.6 5.6 2.8 2.8"></path><path d="m15.6 15.6 2.8 2.8"></path><path d="m18.4 5.6-2.8 2.8"></path><path d="m8.4 15.6-2.8 2.8"></path>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
        refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
        pencil: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
        bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
        chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'
    };

    function iconSvg(name, size) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            (ICONS[name] || '') + '</svg>';
    }

    const LOCK_LABELS = {
        identity: 'Identity',
        appearance: 'Face',
        hair: 'Hair',
        outfit: 'Outfit',
        style: 'Style',
        environment: 'Environment'
    };

    const BUTTONS = [
        { type: 'generate', label: 'Generate Image', icon: 'image', variant: 'primary' },
        { type: 'again', label: 'Surprise Me Again', icon: 'refresh', variant: '' },
        { type: 'modify', label: 'Modify Concept', icon: 'pencil', variant: '' },
        { type: 'save', label: 'Save Concept', icon: 'bookmark', variant: '' },
        { type: 'save_character', label: 'Save as Character', icon: 'user', variant: '' },
        { type: 'retry_portrait', label: 'Retry Portrait', icon: 'refresh', variant: '' },
        { type: 'use_context', label: 'Use as Chat Context', icon: 'chat', variant: '' }
    ];

    function extract(markdown) {
        const cards = [];
        const text = String(markdown === undefined || markdown === null ? '' : markdown)
            .replace(MARKER_RE, (match, json) => {
                try {
                    const data = JSON.parse(json);
                    if (data && data.id) cards.push(data);
                } catch (e) { /* ignore malformed markers */ }
                return '';
            });
        return { text, cards };
    }

    function strip(markdown) {
        return extract(markdown).text;
    }

    function detailRow(label, value) {
        if (!value) return null;
        const row = document.createElement('div');
        row.className = 'playground-detail';
        const key = document.createElement('span');
        key.className = 'playground-detail-label';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'playground-detail-value';
        val.textContent = value;
        row.appendChild(key);
        row.appendChild(val);
        return row;
    }

    function lockChips(card) {
        const locks = card.locks || {};
        const active = Object.keys(LOCK_LABELS).filter((k) => locks[k]);
        if (!active.length) return null;
        const wrap = document.createElement('div');
        wrap.className = 'playground-locks';
        active.forEach((k) => {
            const chip = document.createElement('span');
            chip.className = 'playground-lock-chip';
            chip.innerHTML = iconSvg('lock', 11);
            chip.appendChild(document.createTextNode(' ' + LOCK_LABELS[k]));
            wrap.appendChild(chip);
        });
        return wrap;
    }

    function render(contentEl, card) {
        const el = document.createElement('div');
        el.className = 'playground-card';
        el.setAttribute('data-concept-id', card.id);
        el.setAttribute('data-status', card.status || '');

        const head = document.createElement('div');
        head.className = 'playground-card-head';

        const icon = document.createElement('span');
        icon.className = 'playground-card-icon';
        icon.innerHTML = iconSvg('sparkle', 15);

        const titleWrap = document.createElement('div');
        titleWrap.className = 'playground-card-titles';
        const heading = document.createElement('span');
        heading.className = 'playground-card-title';
        heading.textContent = 'Creative Playground';
        const theme = document.createElement('span');
        theme.className = 'playground-card-theme';
        theme.textContent = card.theme || '';
        titleWrap.appendChild(heading);
        if (card.theme) titleWrap.appendChild(theme);

        head.appendChild(icon);
        head.appendChild(titleWrap);
        el.appendChild(head);

        const title = document.createElement('h4');
        title.className = 'playground-concept-title';
        title.textContent = card.title || 'Creative concept';
        el.appendChild(title);

        if (card.description) {
            const desc = document.createElement('p');
            desc.className = 'playground-concept-desc';
            desc.textContent = card.description;
            el.appendChild(desc);
        }

        if (card.characterImage && card.characterImage.url) {
            const figure = document.createElement('figure');
            figure.className = 'playground-face';
            const img = document.createElement('img');
            img.className = 'playground-face-img';
            img.src = card.characterImage.url;
            img.alt = card.characterName ? ('Character \u2014 ' + card.characterName) : 'Character';
            img.loading = 'lazy';
            img.addEventListener('click', () => {
                if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
                    window.Gallery.openFromUrl(card.characterImage.url);
                }
            });
            figure.appendChild(img);
            const caption = document.createElement('figcaption');
            caption.className = 'playground-face-caption';
            caption.textContent = card.characterName ? ('Character \u2014 ' + card.characterName) : 'Character';
            figure.appendChild(caption);
            el.appendChild(figure);
        }

        const c = card.concept || {};
        const hasCharacter = Boolean(card.character || c.subject || c.identitySignature);
        const section = document.createElement('div');
        section.className = 'playground-domain-labels';
        section.innerHTML = '<span>CHARACTER</span><span>SCENE</span><span>PROMPT</span>';
        el.appendChild(section);
        const details = document.createElement('div');
        details.className = 'playground-details';
        const rows = [
            detailRow('Prompt', c.userPrompt),
            detailRow('Scene', c.activity && c.environment ? c.activity + ' — ' + c.environment : (c.activity || c.environment)),
            detailRow('Character', card.character
                ? card.character.name
                : (card.characterName
                    ? card.characterName + (c.subject ? ' \u2014 ' + c.subject : '')
                    : (c.subject || 'No character'))),
            detailRow('Appearance', c.appearanceCategoryLabel),
            detailRow('Category', c.category),
            detailRow('Activity', c.activity),
            detailRow('Outfit', c.outfit),
            detailRow('Outfit pack', c.outfitPackLabel),
            detailRow('Environment', c.environment),
            detailRow('Lighting', c.lighting),
            detailRow('Camera', c.camera),
            detailRow('Composition', c.composition),
            detailRow('Mood', c.mood),
            detailRow('Style', c.style),
            detailRow('Aspect ratio', c.aspectRatio)
        ].filter(Boolean);
        rows.forEach((row) => details.appendChild(row));
        if (rows.length) el.appendChild(details);

        const chips = lockChips(card);
        if (chips) el.appendChild(chips);

        const actions = document.createElement('div');
        actions.className = 'playground-card-actions';
        BUTTONS.forEach((spec) => {
            if (spec.type === 'save_character' && !hasCharacter) return;
            if (spec.type === 'retry_portrait' && (!hasCharacter || card.characterImage)) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'playground-btn' + (spec.variant ? ' playground-btn--' + spec.variant : '');
            btn.innerHTML = iconSvg(spec.icon, 14) +
                '<span class="playground-btn-label">' + spec.label + '</span>';
            btn.addEventListener('click', () => onAction(btn, card, spec.type));
            actions.appendChild(btn);
        });
        el.appendChild(actions);

        contentEl.appendChild(el);
    }

    function onAction(button, card, type) {
        const cardEl = button.closest('.playground-card');
        if (type === 'modify') {
            Dialog.prompt({
                title: 'Modify Concept',
                message: 'Describe how the concept should change.',
                placeholder: 'e.g. Keep the outfit but make it a beach scene.',
                confirmText: 'Update Concept'
            }).then((text) => {
                const direction = String(text === null || text === undefined ? '' : text).trim();
                if (!direction) return;
                lock(cardEl);
                send('Modify the creative concept', { type: 'modify', conceptId: card.id, direction });
            });
            return;
        }
        if (type === 'save_character') {
            saveAsCharacter(button, card);
            return;
        }
        lock(cardEl);
        const labels = {
            generate: 'Generate an image from this concept',
            again: 'Surprise me again',
            save: 'Save this creative concept',
            use_context: 'Use this creative concept as chat context'
        };
        send(labels[type] || type, { type, conceptId: card.id, expectedRevision: card.revision });
    }

    async function saveAsCharacter(button, card) {
        const c = card.concept || {};
        const suggested = card.characterName || card.title || 'Character';
        Dialog.prompt({
            title: 'Save as Character',
            message: 'Name this character so it can be reused in future concepts.',
            value: suggested,
            confirmText: 'Save Character'
        }).then(async (name) => {
            const clean = String(name === null || name === undefined ? '' : name).trim();
            if (!clean) return;
            button.disabled = true;
            try {
                const res = await fetch('/api/characters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: clean,
                        identity: c.identity || c.subject || '',
                        identityText: c.subject || '',
                        identitySignature: c.identitySignature || '',
                        characterIdentity: c.identity || null,
                        appearance: c.appearance || '',
                        hair: c.hair || '',
                        outfit: c.outfit || '',
                        style: c.style || '',
                        appearanceCategory: c.appearanceCategory || '',
                        appearanceCategoryLabel: c.appearanceCategoryLabel || '',
                        // A character's wardrobe personality is saved with the
                        // identity so the pack can be reused (and re-composed)
                        // without regenerating the person.
                        outfitPack: c.outfitPack || '',
                        outfitPackCustom: c.outfitPackCustom || ''
                    })
                });
                if (!res.ok) throw new Error('request failed');
                if (typeof Dialog !== 'undefined' && Dialog.alert) {
                    Dialog.alert({ title: 'Character saved', message: '"' + clean + '" is now available in the Surprise Me picker.' });
                }
                characterCache = null;
            } catch (e) {
                if (typeof Dialog !== 'undefined' && Dialog.alert) {
                    Dialog.alert({ title: 'Could not save character', message: 'Please try again.' });
                }
            } finally {
                button.disabled = false;
            }
        });
    }

    function send(text, playgroundAction) {
        if (typeof Chat !== 'undefined' && Chat && typeof Chat.sendMessage === 'function') {
            Chat.sendMessage({ text, playgroundAction });
        }
    }

    function lock(cardEl) {
        if (!cardEl) return;
        cardEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }

    // Only disable a card when we positively know a *different* concept is the
    // active one. With no known active concept (or a transient state fetch
    // failure) the cards are left interactive rather than dead-ending the UI.
    function applyState(container, activeCard) {
        if (!container) return;
        if (!activeCard) return;
        container.querySelectorAll('.playground-card').forEach((el) => {
            const matches = el.getAttribute('data-concept-id') === activeCard.id;
            el.classList.toggle('playground-card--static', !matches);
            el.querySelectorAll('button').forEach((b) => { b.disabled = !matches; });
        });
    }

    async function hydrate(container, conversationId) {
        if (!container || !conversationId) return;
        try {
            const res = await fetch('/api/playground/state?conversationId=' + encodeURIComponent(conversationId));
            if (!res.ok) return;
            const data = await res.json();
            applyState(container, data.concept || null);
        } catch (e) {
            // Leave the cards as-is on a transient failure.
        }
    }

    // --- Composer popover ----------------------------------------------------

    let popupEl = null;
    let buttonEl = null;
    let themeSelect = null;
    let characterWrap = null;
    let characterTrigger = null;
    let characterValueEl = null;
    let characterMenuEl = null;
    // '', '__random__', or a saved preset id — the native control was replaced
    // by a custom listbox so each saved character can carry its own delete "x".
    let characterChoice = '';
    let appearanceSelect = null;
    let ageSelect = null;
    let genderSelect = null;
    let characterCache = null;
    let profileOptions = null;
    // The user's own prompt: when set, the character is rendered into the
    // user's scene instead of a randomly drawn one.
    let promptEl = null;
    let outfitPacksEl = null;
    let outfitCustomEl = null;
    let outfitPackCache = null;
    // '', a pack id, or 'custom' — an Outfit Pack is a replaceable character
    // attribute, so the popover tracks it alongside the character controls.
    let outfitPackChoice = '';
    let outfitCustomText = '';

    const SWATCHES = {
        white: '#f4f4f2', cream: '#f0e6d2', beige: '#e3d5bd', sand: '#e6d3a7',
        grey: '#9aa0a6', charcoal: '#3c4043', black: '#1b1b1b', navy: '#1f2a44',
        blue: '#4a7fc1', pale: '#d7e4f0', olive: '#6b7043', sage: '#a3b18a',
        green: '#7d9b76', pink: '#e8b4c4', blush: '#ecc9d0', burgundy: '#6d2233',
        brown: '#7a5230', taupe: '#b0a294', denim: '#4f6a92', earth: '#8a6f4e',
        warm: '#d8c3a5', neutral: '#d8d2c8', metallic: '#b8b0a0', washed: '#8a94a6',
        muted: '#b6ac9c', soft: '#d9cfc4', dark: '#4a4a4a'
    };

    function swatchColor(name) {
        const key = String(name || '').toLowerCase();
        if (SWATCHES[key]) return SWATCHES[key];
        for (const token of Object.keys(SWATCHES)) {
            if (key.includes(token)) return SWATCHES[token];
        }
        return '#c9c4bd';
    }

    async function loadCharacters(force) {
        if (characterCache && !force) return characterCache;
        try {
            const res = await fetch('/api/characters');
            const data = await res.json();
            characterCache = Array.isArray(data.characters) ? data.characters : [];
        } catch (e) {
            characterCache = [];
        }
        return characterCache;
    }

    async function loadThemes() {
        try {
            const res = await fetch('/api/playground/themes');
            const data = await res.json();
            return Array.isArray(data.themes) ? data.themes : [];
        } catch (e) {
            return [];
        }
    }

    async function loadProfileOptions() {
        if (profileOptions) return profileOptions;
        try {
            const res = await fetch('/api/playground/options');
            const data = await res.json();
            profileOptions = {
                appearance: Array.isArray(data.appearance) ? data.appearance : [],
                age: Array.isArray(data.age) ? data.age : [],
                gender: Array.isArray(data.gender) ? data.gender : []
            };
        } catch (e) {
            profileOptions = { appearance: [], age: [], gender: [] };
        }
        return profileOptions;
    }

    async function loadOutfitPacks() {
        if (outfitPackCache) return outfitPackCache;
        try {
            const res = await fetch('/api/playground/outfits');
            const data = await res.json();
            outfitPackCache = Array.isArray(data.packs) ? data.packs : [];
        } catch (e) {
            outfitPackCache = [];
        }
        return outfitPackCache;
    }

    function outfitCard(id, label, description, palette) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'playground-outfit-card';
        card.setAttribute('data-pack', id);
        if (id === outfitPackChoice) card.classList.add('playground-outfit-card--active');

        const name = document.createElement('span');
        name.className = 'playground-outfit-name';
        name.textContent = label;
        card.appendChild(name);

        if (description) {
            const desc = document.createElement('span');
            desc.className = 'playground-outfit-desc';
            desc.textContent = description;
            card.appendChild(desc);
        }
        if (Array.isArray(palette) && palette.length) {
            const dots = document.createElement('span');
            dots.className = 'playground-outfit-palette';
            palette.slice(0, 6).forEach((color) => {
                const dot = document.createElement('span');
                dot.className = 'playground-outfit-dot';
                dot.style.background = swatchColor(color);
                dot.title = color;
                dots.appendChild(dot);
            });
            card.appendChild(dots);
        }

        card.addEventListener('click', (e) => {
            e.stopPropagation();
            setOutfitPack(id);
        });
        return card;
    }

    function renderOutfitPacks() {
        if (!outfitPacksEl) return;
        outfitPacksEl.innerHTML = '';
        outfitPacksEl.appendChild(outfitCard('', 'None', 'Let the theme choose the clothing.', []));
        (outfitPackCache || []).forEach((pack) => {
            outfitPacksEl.appendChild(outfitCard(pack.id, pack.label, pack.description, pack.palette));
        });
        outfitPacksEl.appendChild(outfitCard('custom', 'Custom', 'Describe the exact outfit yourself.', []));
        syncOutfitCustom();
    }

    function setOutfitPack(id) {
        outfitPackChoice = id || '';
        if (outfitPacksEl) {
            outfitPacksEl.querySelectorAll('.playground-outfit-card').forEach((el) => {
                el.classList.toggle('playground-outfit-card--active', el.getAttribute('data-pack') === outfitPackChoice);
            });
        }
        syncOutfitCustom();
    }

    function syncOutfitCustom() {
        if (!outfitCustomEl) return;
        const custom = outfitPackChoice === 'custom';
        outfitCustomEl.hidden = !custom;
        if (custom && !outfitCustomEl.value && outfitCustomText) outfitCustomEl.value = outfitCustomText;
    }

    function selectedOutfit() {
        const custom = outfitPackChoice === 'custom';
        return {
            outfitPack: outfitPackChoice || '',
            outfitPackCustom: custom && outfitCustomEl ? String(outfitCustomEl.value || '').trim() : ''
        };
    }

    function fillSelect(select, items, placeholder) {
        if (!select) return;
        select.innerHTML = '';
        // A falsy placeholder means "no blank option" — used by the theme list,
        // whose first entry (Anything) is already a valid default.
        if (placeholder) {
            const base = document.createElement('option');
            base.value = '';
            base.textContent = placeholder;
            select.appendChild(base);
        }
        items.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.value;
            opt.textContent = item.label;
            select.appendChild(opt);
        });
    }

    const CHARACTER_NONE_LABEL = 'No character (general exploration)';
    const CHARACTER_RANDOM_LABEL = 'Random new character';

    function characterLabel(value) {
        if (!value) return CHARACTER_NONE_LABEL;
        if (value === '__random__') return CHARACTER_RANDOM_LABEL;
        const preset = (characterCache || []).find((c) => c.id === value);
        return preset && preset.name ? preset.name : 'Character';
    }

    function setCharacterChoice(value, options) {
        characterChoice = value || '';
        if (characterValueEl) {
            characterValueEl.textContent = (options && options.label) || characterLabel(characterChoice);
        }
        if (characterMenuEl) {
            characterMenuEl.querySelectorAll('.playground-character-option').forEach((row) => {
                const active = row.getAttribute('data-value') === characterChoice;
                row.classList.toggle('playground-character-option--active', active);
                row.setAttribute('aria-selected', active ? 'true' : 'false');
            });
        }
        if (!options || !options.skipLocks) updateLockAvailability();
    }

    function closeCharacterMenu() {
        if (!characterMenuEl) return;
        characterMenuEl.hidden = true;
        if (characterTrigger) characterTrigger.setAttribute('aria-expanded', 'false');
    }

    function openCharacterMenu() {
        if (!characterMenuEl) return;
        characterMenuEl.hidden = false;
        if (characterTrigger) characterTrigger.setAttribute('aria-expanded', 'true');
    }

    function toggleCharacterMenu() {
        if (!characterMenuEl) return;
        if (characterMenuEl.hidden) openCharacterMenu(); else closeCharacterMenu();
    }

    function characterOptionRow(value, label, deletable) {
        const row = document.createElement('div');
        row.className = 'playground-character-option';
        row.setAttribute('data-value', value);
        row.setAttribute('role', 'option');
        if (value === characterChoice) {
            row.classList.add('playground-character-option--active');
            row.setAttribute('aria-selected', 'true');
        } else {
            row.setAttribute('aria-selected', 'false');
        }

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'playground-character-option-main';
        const name = document.createElement('span');
        name.className = 'playground-character-option-label';
        name.textContent = label;
        main.appendChild(name);
        main.addEventListener('click', () => {
            setCharacterChoice(value);
            closeCharacterMenu();
        });
        row.appendChild(main);

        if (deletable) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'playground-character-option-delete';
            del.title = 'Delete "' + label + '"';
            del.setAttribute('aria-label', 'Delete "' + label + '"');
            del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteCharacter(value, label, del);
            });
            row.appendChild(del);
        }
        return row;
    }

    function renderCharacterMenu() {
        if (!characterMenuEl) return;
        characterMenuEl.innerHTML = '';
        characterMenuEl.appendChild(characterOptionRow('', CHARACTER_NONE_LABEL, false));
        characterMenuEl.appendChild(characterOptionRow('__random__', CHARACTER_RANDOM_LABEL, false));
        const characters = characterCache || [];
        if (characters.length) {
            const heading = document.createElement('div');
            heading.className = 'playground-character-menu-heading';
            heading.textContent = 'Saved characters';
            characterMenuEl.appendChild(heading);
            characters.forEach((c) => {
                characterMenuEl.appendChild(characterOptionRow(c.id, c.name || 'Character', true));
            });
        }
    }

    async function deleteCharacter(id, name, button) {
        const label = name || 'this character';
        let confirmed = true;
        if (typeof Dialog !== 'undefined' && Dialog.confirm) {
            confirmed = await Dialog.confirm({
                title: 'Delete Character',
                message: 'Delete "' + label + '" from your saved characters?',
                confirmText: 'Delete',
                danger: true
            });
        }
        if (!confirmed) return;
        if (button) button.disabled = true;
        try {
            const res = await fetch('/api/characters/' + encodeURIComponent(id), { method: 'DELETE' });
            if (!res.ok) throw new Error('request failed');
            characterCache = null;
            await loadCharacters(true);
            if (characterChoice === id) characterChoice = '';
            if (characterValueEl) characterValueEl.textContent = characterLabel(characterChoice);
            renderCharacterMenu();
        } catch (e) {
            if (typeof Dialog !== 'undefined' && Dialog.alert) {
                Dialog.alert({ title: 'Could not delete character', message: 'Please try again.' });
            }
            if (button) button.disabled = false;
        }
    }

    async function refreshPopover() {
        if (!popupEl) return;
        const themes = await loadThemes();
        fillSelect(themeSelect, themes.map((t) => ({ value: t.id, label: t.label })), '');
        await loadCharacters(true);
        renderCharacterMenu();
        const options = await loadProfileOptions();
        fillSelect(appearanceSelect, options.appearance, '');
        fillSelect(ageSelect, options.age, '');
        fillSelect(genderSelect, options.gender, '');
        await loadOutfitPacks();
        renderOutfitPacks();
        applyActiveConcept(await loadActiveConcept());
        updateLockAvailability();
    }

    async function loadActiveConcept() {
        const conversationId = (typeof Conversations !== 'undefined' && Conversations.currentId)
            ? Conversations.currentId()
            : '';
        if (!conversationId) return null;
        try {
            const res = await fetch('/api/playground/state?conversationId=' + encodeURIComponent(conversationId));
            const data = await res.json();
            return data.concept || null;
        } catch (e) {
            return null;
        }
    }

    // Reflect the active concept so its theme, character source and locks are
    // visible — a locked identity silently pinning a random character is the
    // trap this prevents. The user can clear any lock before the next Surprise.
    function applyActiveConcept(concept) {
        if (!popupEl || !concept) return;
        if (themeSelect && concept.themeId) themeSelect.value = concept.themeId;
        if (concept.mode === 'random_character') {
            setCharacterChoice('__random__', { skipLocks: true });
        } else if (concept.mode === 'character' && concept.character) {
            setCharacterChoice(concept.character.id, { skipLocks: true, label: concept.character.name });
        } else {
            setCharacterChoice('', { skipLocks: true });
        }
        // Reflect the generator controls that produced the active random person.
        if (concept.characterProfile) {
            if (appearanceSelect) appearanceSelect.value = concept.characterProfile.appearance;
            if (ageSelect) ageSelect.value = concept.characterProfile.age;
            if (genderSelect) genderSelect.value = concept.characterProfile.gender;
        }
        // Reflect the active Outfit Pack so a pinned wardrobe is visible and
        // clearable before the next Surprise.
        outfitPackChoice = concept.outfitPack || '';
        outfitCustomText = concept.outfitPackCustom || '';
        if (outfitCustomEl) outfitCustomEl.value = outfitCustomText;
        renderOutfitPacks();
        // Reflect the active user prompt so it can be edited and re-run.
        const activePrompt = (concept.concept && concept.concept.userPrompt) || concept.userPrompt || '';
        if (promptEl) promptEl.value = activePrompt;
        syncPromptMode();
        const locks = concept.locks || {};
        popupEl.querySelectorAll('.playground-lock input[type="checkbox"]').forEach((box) => {
            box.checked = locks[box.getAttribute('data-lock')] === true;
        });
        updateLockAvailability();
    }

    // The Identity lock keeps the current random person across "Surprise Me
    // Again"; a brand-new Surprise still casts a new person, so the tooltip
    // explains the difference rather than disabling it.
    function updateLockAvailability() {
        if (!popupEl || !characterMenuEl) return;
        const box = popupEl.querySelector('.playground-lock input[data-lock="identity"]');
        if (!box) return;
        const randomMode = characterChoice === '__random__';
        box.disabled = false;
        const label = box.closest ? box.closest('.playground-lock') : null;
        if (label) {
            label.classList.remove('playground-lock--disabled');
            label.title = randomMode
                ? 'A new Surprise casts a new person; Surprise Me Again keeps this one while Identity is locked.'
                : '';
        }
    }

    function selectedLocks() {
        const locks = {};
        if (!popupEl) return locks;
        popupEl.querySelectorAll('.playground-lock input[type="checkbox"]').forEach((box) => {
            locks[box.getAttribute('data-lock')] = box.checked;
        });
        return locks;
    }

    function selectedProfile() {
        return {
            appearance: appearanceSelect ? appearanceSelect.value : 'random',
            age: ageSelect ? ageSelect.value : 'random',
            gender: genderSelect ? genderSelect.value : 'random'
        };
    }

    function profileConstrained(profile) {
        return profile.appearance !== 'random' || profile.age !== 'random' || profile.gender !== 'random';
    }

    // Choosing an appearance/age/gender means "cast a character with it", so the
    // Character select follows to "Random new character" for visible feedback.
    function syncCharacterMode() {
        if (!characterMenuEl) return;
        if (profileConstrained(selectedProfile()) && !characterChoice) {
            setCharacterChoice('__random__');
        }
    }

    // The submit button reflects the mode: with a prompt it renders the
    // character into the user's own scene instead of a random Surprise.
    function syncPromptMode() {
        if (!promptEl) return;
        const hasPrompt = String(promptEl.value || '').trim().length > 0;
        const label = document.querySelector('#playgroundSurprise .playground-submit-label');
        if (label) label.textContent = hasPrompt ? 'Use My Prompt' : 'Surprise Me';
    }

    function submit() {
        if (!popupEl) return;
        const themeId = themeSelect && themeSelect.value ? themeSelect.value : 'anything';
        const choice = characterChoice;
        const profile = selectedProfile();
        const customPrompt = promptEl ? String(promptEl.value || '').trim() : '';
        let mode = 'none';
        let characterId = null;
        if (choice === '__random__') {
            mode = 'random_character';
        } else if (choice) {
            mode = 'character';
            characterId = choice;
        } else if (profileConstrained(profile)) {
            // A constrained profile implies a random character even if the
            // Character select was left at "No character".
            mode = 'random_character';
        }
        const locks = selectedLocks();
        const outfit = selectedOutfit();
        close();
        send(customPrompt ? 'Use my character with my prompt' : 'Surprise me with a creative concept', {
            type: 'surprise',
            themeId,
            characterId,
            mode,
            locks,
            profile,
            outfitPack: outfit.outfitPack,
            outfitPackCustom: outfit.outfitPackCustom,
            customPrompt
        });
    }

    function open() {
        if (!popupEl) return;
        popupEl.hidden = false;
        if (buttonEl) buttonEl.setAttribute('aria-expanded', 'true');
        refreshPopover();
        syncPromptMode();
    }

    function close() {
        if (!popupEl) return;
        closeCharacterMenu();
        popupEl.hidden = true;
        if (buttonEl) buttonEl.setAttribute('aria-expanded', 'false');
    }

    function isOpen() {
        return Boolean(popupEl && !popupEl.hidden);
    }

    // An app dialog (e.g. the delete-character confirmation) sits above the
    // popover. While it is open, background interactions belong to it — a click
    // or Escape that dismisses the dialog must not also dismiss the popover.
    function isAppDialogOpen() {
        const overlay = document.getElementById('appDialogOverlay');
        return Boolean(overlay && overlay.classList.contains('open'));
    }

    function init() {
        buttonEl = document.getElementById('chatSurprise');
        popupEl = document.getElementById('chatPlaygroundPopup');
        if (!buttonEl || !popupEl) return;
        themeSelect = document.getElementById('playgroundTheme');
        characterWrap = document.getElementById('playgroundCharacter');
        characterTrigger = document.getElementById('playgroundCharacterTrigger');
        characterValueEl = document.getElementById('playgroundCharacterValue');
        characterMenuEl = document.getElementById('playgroundCharacterMenu');
        appearanceSelect = document.getElementById('playgroundAppearance');
        ageSelect = document.getElementById('playgroundAge');
        genderSelect = document.getElementById('playgroundGender');
        outfitPacksEl = document.getElementById('playgroundOutfitPacks');
        outfitCustomEl = document.getElementById('playgroundOutfitCustom');
        promptEl = document.getElementById('playgroundPrompt');
        const submitBtn = document.getElementById('playgroundSurprise');

        buttonEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isOpen()) close(); else open();
        });
        popupEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (characterWrap && !characterWrap.contains(e.target)) closeCharacterMenu();
        });
        if (submitBtn) submitBtn.addEventListener('click', submit);
        if (characterTrigger) characterTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCharacterMenu();
        });
        [appearanceSelect, ageSelect, genderSelect].forEach((sel) => {
            if (sel) sel.addEventListener('change', syncCharacterMode);
        });
        if (promptEl) promptEl.addEventListener('input', syncPromptMode);

        document.addEventListener('click', (e) => {
            if (!isOpen()) return;
            if (isAppDialogOpen()) return;
            if (popupEl.contains(e.target) || buttonEl.contains(e.target)) return;
            close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !isOpen()) return;
            if (isAppDialogOpen()) return;
            if (characterMenuEl && !characterMenuEl.hidden) {
                closeCharacterMenu();
                return;
            }
            close();
        });
    }

    return { extract, strip, render, applyState, hydrate, init, open, close, isOpen };
})();

window.PlaygroundUI = PlaygroundUI;
