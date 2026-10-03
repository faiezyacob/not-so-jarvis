/* ============================================
   JARVIS — shared Outfit Pack selector
   The card-grid wardrobe selector used by the
   Creative Playground, Creator Studio and UGC
   Studio. Data-only: it renders whatever compact
   catalog ({ id, label, description, palette }) it
   is given and reports the chosen pack id back to
   its caller. It owns presentation, never the
   outfit itself.
   SPDX-License-Identifier: MIT
   ============================================ */

const OutfitPackUI = (() => {
    // Wardrobe grouping for the selector. Data-only: an unknown/future pack is
    // still rendered (appended after the known groups), so the catalog can grow
    // without touching this list.
    const GROUPS = [
        { label: 'Everyday', ids: ['casual-everyday', 'lounge-home', 'soft-feminine-casual'] },
        { label: 'Scene & Activity', ids: ['vacation-summer', 'gym-activewear', 'casual-smart', 'casual-night-out'] },
        { label: 'Style', ids: ['casual-streetwear', 'minimalist-neutral', 'edgy-alternative', 'glam-boudoir', 'confident-seductive'] }
    ];

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

    function card(id, label, description, palette, active) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'outfit-pack-card';
        el.setAttribute('data-pack', id);
        if (active) el.classList.add('outfit-pack-card--active');

        const name = document.createElement('span');
        name.className = 'outfit-pack-name';
        name.textContent = label;
        el.appendChild(name);

        if (description) {
            const desc = document.createElement('span');
            desc.className = 'outfit-pack-desc';
            desc.textContent = description;
            el.appendChild(desc);
        }
        if (Array.isArray(palette) && palette.length) {
            const dots = document.createElement('span');
            dots.className = 'outfit-pack-palette';
            palette.slice(0, 6).forEach((color) => {
                const dot = document.createElement('span');
                dot.className = 'outfit-pack-dot';
                dot.style.background = swatchColor(color);
                dot.title = color;
                dots.appendChild(dot);
            });
            el.appendChild(dots);
        }
        return el;
    }

    function setActive(container, selected) {
        if (!container) return;
        const value = selected || '';
        container.querySelectorAll('.outfit-pack-card').forEach((el) => {
            el.classList.toggle('outfit-pack-card--active', el.getAttribute('data-pack') === value);
        });
    }

    // render(container, {
    //   packs, selected, onSelect,
    //   autoLabel, autoDescription, customLabel, customDescription
    // })
    // The first card is the "auto" choice (pack id ''); the last is "custom".
    function render(container, config) {
        if (!container) return;
        const options = config || {};
        const packs = Array.isArray(options.packs) ? options.packs : [];
        const selected = options.selected || '';
        const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
        container.innerHTML = '';

        const autoLabel = options.autoLabel || 'Theme decides';
        const autoDescription = options.autoDescription || 'Let the theme choose clothing to suit the scene.';
        container.appendChild(card('', autoLabel, autoDescription, [], selected === ''));

        const byId = new Map(packs.map((pack) => [pack.id, pack]));
        GROUPS.forEach((group) => {
            const groupPacks = group.ids.map((id) => byId.get(id)).filter(Boolean);
            if (!groupPacks.length) return;
            const heading = document.createElement('div');
            heading.className = 'outfit-pack-group';
            heading.textContent = group.label;
            container.appendChild(heading);
            groupPacks.forEach((pack) => container.appendChild(
                card(pack.id, pack.label, pack.description, pack.palette, pack.id === selected)));
        });
        packs
            .filter((pack) => !GROUPS.some((group) => group.ids.includes(pack.id)))
            .forEach((pack) => container.appendChild(
                card(pack.id, pack.label, pack.description, pack.palette, pack.id === selected)));

        const customLabel = options.customLabel || 'Custom';
        const customDescription = options.customDescription || 'Describe the exact outfit yourself.';
        container.appendChild(card('custom', customLabel, customDescription, [], selected === 'custom'));

        container.querySelectorAll('.outfit-pack-card').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = el.getAttribute('data-pack') || '';
                setActive(container, id);
                onSelect(id);
            });
        });
    }

    return { render, setActive, swatchColor, GROUPS };
})();

window.OutfitPackUI = OutfitPackUI;
