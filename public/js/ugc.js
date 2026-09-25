/* ============================================
   JARVIS — UGC Studio UI
   The conversational UGC workflow rendered inside
   the existing chat: inline cards for product,
   creator, outfit, environment, content type, the
   creative brief, the script, the scene plan and
   the reference frames, plus a subtle "UGC Studio"
   mode bar. Actions flow back through the normal
   chat stream; each card is carried by a
   [[ugc:{...}]] marker so it survives reloads.
   ============================================ */

const UGCUI = (() => {
    const MARKER_RE = /\[\[ugc:(\{[^\n]*?\})\]\]/g;

    const ICONS = {
        clapper: '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1-.3 2.2.3 2.5 1.3Z"></path><path d="m6.2 5.3 3.1 3.9"></path><path d="m12.4 3.4 3.1 4"></path><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path><path d="m8 11 3 4"></path><path d="m14 11 3 4"></path>',
        check: '<polyline points="20 6 9 17 4 12"></polyline>',
        refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
        pencil: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
        film: '<rect x="2" y="3" width="20" height="18" rx="2"></rect><line x1="7" y1="3" x2="7" y2="21"></line><line x1="17" y1="3" x2="17" y2="21"></line><line x1="2" y1="9" x2="22" y2="9"></line><line x1="2" y1="15" x2="22" y2="15"></line>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
        box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"></path><polyline points="3.3 7 12 12 20.7 7"></polyline><line x1="12" y1="22" x2="12" y2="12"></line>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
        x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
        up: '<polyline points="18 15 12 9 6 15"></polyline>',
        down: '<polyline points="6 9 12 15 18 9"></polyline>'
    };

    function iconSvg(name, size) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            (ICONS[name] || '') + '</svg>';
    }

    const STAGE_LABELS = {
        idle: 'Idle',
        brief: 'Creative brief',
        product_selection: 'Choose a product',
        creator_selection: 'Choose a creator',
        creative_direction: 'Creative direction',
        script_review: 'Script review',
        scene_review: 'Scene plan',
        reference_generation: 'Generating references',
        reference_approval: 'Reference approval',
        video_generation: 'Director handoff',
        completed: 'Complete'
    };

    const STAGE_PHASES = [
        { id: 'setup', label: 'Setup', stages: ['product_selection', 'creator_selection', 'creative_direction'] },
        { id: 'brief', label: 'Brief', stages: ['brief'] },
        { id: 'script', label: 'Script', stages: ['script_review'] },
        { id: 'scenes', label: 'Scenes', stages: ['scene_review'] },
        { id: 'references', label: 'References', stages: ['reference_generation', 'reference_approval'] },
        { id: 'handoff', label: 'Render', stages: ['video_generation', 'completed'] }
    ];

    function stageLabel(stage) {
        return STAGE_LABELS[stage] || 'UGC Studio';
    }

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

    // The version of the newest rendered card. Every action from an interactive
    // card carries it so the server can reject a stale card.
    let activeVersion = 0;

    function send(text, ugcAction) {
        let action = ugcAction;
        if (action && action.projectId && action.version === undefined) {
            action = Object.assign({}, action, { version: activeVersion });
        }
        if (typeof Chat !== 'undefined' && Chat && typeof Chat.sendMessage === 'function') {
            Chat.sendMessage({ text, ugcAction: action });
        }
    }

    function lock(card) {
        if (!card) return;
        card.classList.add('ugc-card--pending');
        card.setAttribute('aria-busy', 'true');
        if (!card.querySelector('.ugc-card-pending')) {
            const status = el('div', 'ugc-card-pending', 'Updating your UGC plan...');
            status.setAttribute('role', 'status');
            const head = card.querySelector('.ugc-card-head');
            if (head) head.after(status);
        }
        card.querySelectorAll('button, input, select, textarea').forEach((b) => { b.disabled = true; });
    }

    // --- Small DOM helpers ---

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function button(label, iconName, variant, onClick, opts) {
        const options = opts || {};
        const btn = el('button', 'ugc-btn' + (variant ? ' ugc-btn--' + variant : '')
            + (options.iconOnly ? ' ugc-btn--icon' : ''));
        btn.type = 'button';
        if (iconName) btn.innerHTML = iconSvg(iconName, 14);
        if (label) btn.appendChild(el('span', 'ugc-btn-label', label));
        if (options.ariaLabel) btn.setAttribute('aria-label', options.ariaLabel);
        if (options.title) btn.title = options.title;
        if (options.pressed !== undefined) btn.setAttribute('aria-pressed', options.pressed ? 'true' : 'false');
        if (options.expanded !== undefined) btn.setAttribute('aria-expanded', options.expanded ? 'true' : 'false');
        if (options.controls) btn.setAttribute('aria-controls', options.controls);
        btn.addEventListener('click', onClick);
        return btn;
    }

    // A short, in-card heading + hint per stage so the card is scannable without
    // duplicating the longer server-side stage intro above it.
    const STAGE_HELP = {
        product_selection: { title: 'Choose the product', hint: 'Pick one from your library, or create a new one. Only details you supply are used.' },
        creator_selection: { title: 'Choose who is on camera', hint: 'Use a saved character, roll a new creator, or run it product-only.' },
        creative_direction: { title: 'Set the creative direction', hint: 'Choose a content type, an outfit and an environment.' },
        brief: { title: 'Review the brief', hint: 'Adjust anything, then approve it to write the script.' },
        script_review: { title: 'Review the script', hint: 'Edit the lines or ask for a rewrite, then approve to plan the scenes.' },
        scene_review: { title: 'Review the scene plan', hint: 'Tune each scene, then approve to generate the reference frames.' },
        reference_generation: { title: 'Generating reference frames', hint: 'Frames render one at a time. This card updates as they finish.' },
        reference_approval: { title: 'Review reference frames', hint: 'Every scene needs one current frame. Approve to hand off to Director Mode.' },
        video_generation: { title: 'Director handoff', hint: 'The approved plan is being produced. Follow the Director card for the video.' },
        completed: { title: 'Production complete', hint: 'Your UGC video is ready.' }
    };

    function stageHelp(stage) {
        return STAGE_HELP[stage] || STAGE_HELP.brief;
    }

    function input(value, placeholder) {
        const i = el('input', 'ugc-input');
        i.type = 'text';
        i.value = value || '';
        if (placeholder) i.placeholder = placeholder;
        return i;
    }

    function textarea(value, placeholder, rows) {
        const t = el('textarea', 'ugc-input ugc-textarea');
        t.value = value || '';
        t.rows = rows || 2;
        if (placeholder) t.placeholder = placeholder;
        return t;
    }

    function labelWrap(labelText, control, extraClass) {
        const wrap = el('label', 'ugc-field' + (extraClass ? ' ' + extraClass : ''));
        wrap.appendChild(el('span', 'ugc-field-label', labelText));
        wrap.appendChild(control);
        return wrap;
    }

    function chipRow(items, activeId, onPick, extra) {
        const wrap = el('div', 'ugc-chips');
        wrap.setAttribute('role', 'group');
        items.forEach((item) => {
            const active = item.id === activeId;
            const chip = el('button', 'ugc-chip' + (active ? ' ugc-chip--active' : ''));
            chip.type = 'button';
            chip.textContent = item.label;
            chip.setAttribute('aria-pressed', active ? 'true' : 'false');
            if (item.description) chip.title = item.description;
            chip.addEventListener('click', () => onPick(item.id));
            wrap.appendChild(chip);
        });
        if (extra) wrap.appendChild(extra);
        return wrap;
    }

    function actionRow(buttons, variant) {
        const wrap = el('div', 'ugc-card-actions' + (variant ? ' ugc-card-actions--' + variant : ''));
        buttons.forEach((b) => wrap.appendChild(b));
        return wrap;
    }

    // A native disclosure: keyboard-accessible, no custom focus management.
    function disclosure(labelText, iconName, className) {
        const details = el('details', 'ugc-disclosure' + (className ? ' ' + className : ''));
        const summary = el('summary', 'ugc-disclosure-summary');
        if (iconName) {
            const icon = el('span', 'ugc-disclosure-icon');
            icon.innerHTML = iconSvg(iconName, 14);
            summary.appendChild(icon);
        }
        summary.appendChild(el('span', 'ugc-disclosure-label', labelText));
        details.appendChild(summary);
        return details;
    }

    // Compact segmented workflow progress: never overflows a narrow card, and the
    // current phase is stated in text for screen readers.
    function renderProgress(stage, container) {
        const complete = stage === 'completed';
        const found = STAGE_PHASES.findIndex((phase) => phase.stages.includes(stage));
        const current = complete ? STAGE_PHASES.length : Math.max(0, found);
        const progress = el('div', 'ugc-progress');
        progress.setAttribute('role', 'group');
        progress.setAttribute('aria-label', 'Workflow progress: '
            + STAGE_PHASES.map((phase, index) => phase.label + ' '
                + ((complete || index < current) ? 'done' : (index === current ? 'current' : 'upcoming'))).join(', '));
        const track = el('div', 'ugc-progress-track');
        STAGE_PHASES.forEach((phase, index) => {
            const seg = el('span', 'ugc-progress-seg');
            if (complete || index < current) seg.classList.add('ugc-progress-seg--done');
            else if (index === current) seg.classList.add('ugc-progress-seg--active');
            track.appendChild(seg);
        });
        progress.appendChild(track);
        const label = complete ? 'Complete' : (STAGE_PHASES[current] ? STAGE_PHASES[current].label : 'Setup');
        const step = Math.min(current + 1, STAGE_PHASES.length);
        progress.appendChild(el('span', 'ugc-progress-caption', label + ' \u00b7 step ' + step + ' of ' + STAGE_PHASES.length));
        container.appendChild(progress);
    }

    // --- Stage renderers ---

    // Per-scene reference status counts used by the context strip and the
    // reference progress header.
    function frameStats(card) {
        const scenes = Array.isArray(card.scenes) ? card.scenes : [];
        const refs = Array.isArray(card.references) ? card.references : [];
        const byScene = new Map();
        refs.forEach((r) => { if (r && r.sceneId) byScene.set(r.sceneId, r); });
        const stats = { total: scenes.length || refs.length, ready: 0, failed: 0, stale: 0, pending: 0 };
        const source = scenes.length ? scenes.map((s) => byScene.get(s.id) || null) : refs;
        source.forEach((r) => {
            const status = r && r.status ? r.status : 'pending';
            if (status === 'ready' || status === 'approved') stats.ready += 1;
            else if (status === 'failed') stats.failed += 1;
            else if (status === 'stale') stats.stale += 1;
            else stats.pending += 1;
        });
        return stats;
    }

    // The context strip: only populated values, with the current stage's most
    // relevant selections emphasized. Never renders an empty placeholder.
    function contextEntries(card) {
        const brief = card.brief || {};
        const entries = [];
        if (card.product && card.product.name) {
            entries.push({ key: 'product', label: 'Product', value: card.product.name });
        }
        if (card.creator && (card.creator.name || card.creator.identity)) {
            entries.push({ key: 'creator', label: 'Creator', value: card.creator.name || String(card.creator.identity).slice(0, 40) });
        } else if (card.creatorSkipped || card.creatorMode === 'none') {
            entries.push({ key: 'creator', label: 'Creator', value: 'Product only' });
        }
        if (card.contentType && card.contentType.label) {
            entries.push({ key: 'contentType', label: 'Type', value: card.contentType.label });
        }
        if (card.outfit && (card.outfit.label || card.outfit.outfit)) {
            entries.push({ key: 'outfit', label: 'Outfit', value: card.outfit.label || card.outfit.outfit });
        }
        if (card.environment && (card.environment.label || card.environment.description)) {
            entries.push({ key: 'environment', label: 'Setting', value: card.environment.label || card.environment.description });
        }
        if (brief.duration) entries.push({ key: 'duration', label: 'Length', value: brief.duration + 's' });
        if (brief.aspectRatio) entries.push({ key: 'aspectRatio', label: 'Aspect', value: brief.aspectRatio });
        if (brief.platform) entries.push({ key: 'platform', label: 'Platform', value: brief.platform });
        if (card.scenes && card.scenes.length) entries.push({ key: 'scenes', label: 'Scenes', value: String(card.scenes.length) });
        if (card.stage === 'reference_generation' || card.stage === 'reference_approval') {
            const stats = frameStats(card);
            entries.push({ key: 'frames', label: 'Frames', value: stats.ready + ' of ' + stats.total + ' ready' });
        }
        return entries;
    }

    const STAGE_KEY_FIELDS = {
        product_selection: ['product'],
        creator_selection: ['creator'],
        creative_direction: ['contentType', 'outfit', 'environment'],
        brief: ['product', 'creator', 'duration'],
        script_review: ['product', 'creator', 'duration'],
        scene_review: ['duration', 'scenes'],
        reference_generation: ['frames'],
        reference_approval: ['frames'],
        video_generation: ['product', 'duration'],
        completed: ['product', 'duration']
    };

    function renderContext(card, container) {
        const entries = contextEntries(card);
        if (!entries.length) return;
        const keys = STAGE_KEY_FIELDS[card.stage] || [];
        const wrap = el('div', 'ugc-context');
        entries.forEach((entry) => {
            const item = el('div', 'ugc-context-item'
                + (keys.indexOf(entry.key) !== -1 ? ' ugc-context-item--key' : ''));
            item.appendChild(el('span', 'ugc-context-label', entry.label));
            item.appendChild(el('span', 'ugc-context-value', entry.value));
            wrap.appendChild(item);
        });
        container.appendChild(wrap);
    }

    function renderProductSelection(card, container) {
        const suggested = String(card.suggestedProductName || '').trim();
        const products = Array.isArray(card.products) ? card.products : [];
        const known = suggested && products.some((p) => String(p.name || '').toLowerCase() === suggested.toLowerCase());
        const activeId = card.product && card.product.id;

        if (suggested && !known) {
            const callout = el('div', 'ugc-callout');
            callout.appendChild(el('p', 'ugc-callout-text',
                'The brief named "' + suggested + '", which is not in your library yet.'));
            callout.appendChild(actionRow([
                button('Create "' + suggested + '"', 'plus', 'primary', () => {
                    lock(container.closest('.ugc-card'));
                    send('Create the product "' + suggested + '"', { type: 'create_product', projectId: card.id, product: { name: suggested } });
                })
            ]));
            container.appendChild(callout);
        }

        if (products.length) {
            container.appendChild(el('div', 'ugc-section-title', 'Your products'));
            const grid = el('div', 'ugc-choices');
            products.forEach((p) => {
                const selected = p.id === activeId;
                const tile = el('div', 'ugc-choice ugc-choice--product' + (selected ? ' ugc-choice--selected' : ''));
                const main = el('button', 'ugc-choice-main');
                main.type = 'button';
                main.setAttribute('aria-pressed', selected ? 'true' : 'false');
                main.setAttribute('aria-label', 'Use product ' + (p.name || ''));

                const thumb = el('span', 'ugc-choice-thumb');
                if (p.referenceImages && p.referenceImages.length) {
                    const img = el('img', 'ugc-choice-img');
                    img.src = p.referenceImages[0];
                    img.alt = '';
                    img.loading = 'lazy';
                    thumb.appendChild(img);
                } else {
                    thumb.classList.add('ugc-choice-thumb--placeholder');
                    thumb.innerHTML = iconSvg('box', 20);
                }
                main.appendChild(thumb);

                const body = el('span', 'ugc-choice-body');
                body.appendChild(el('span', 'ugc-choice-title', p.name || 'Product'));
                const meta = [p.brand, p.category].filter(Boolean).join(' \u00b7 ');
                if (meta) body.appendChild(el('span', 'ugc-choice-meta', meta));
                if (p.description) body.appendChild(el('span', 'ugc-choice-desc', String(p.description).slice(0, 120)));
                const tags = el('span', 'ugc-choice-tags');
                if (p.referenceImages && p.referenceImages.length) {
                    tags.appendChild(el('span', 'ugc-tag',
                        p.referenceImages.length + ' reference' + (p.referenceImages.length > 1 ? 's' : '')));
                }
                const benefitCount = p.keyBenefits ? p.keyBenefits.length : 0;
                if (benefitCount) tags.appendChild(el('span', 'ugc-tag',
                    benefitCount + ' benefit' + (benefitCount > 1 ? 's' : '')));
                if (tags.childNodes.length) body.appendChild(tags);
                main.appendChild(body);

                main.addEventListener('click', () => {
                    lock(container.closest('.ugc-card'));
                    send('Use the product "' + (p.name || '') + '"', { type: 'select_product', projectId: card.id, productId: p.id });
                });
                tile.appendChild(main);

                if (selected) {
                    const check = el('span', 'ugc-choice-check');
                    check.innerHTML = iconSvg('check', 14);
                    check.setAttribute('aria-hidden', 'true');
                    tile.appendChild(check);
                }

                const del = button('', 'x', 'danger', () => {
                    Dialog.confirm({
                        title: 'Delete product',
                        message: 'Delete "' + (p.name || 'this product') + '" from your product library? This cannot be undone.',
                        confirmText: 'Delete'
                    }).then((ok) => {
                        if (!ok) return;
                        // A successful delete re-emits the card (and the new card
                        // scrolls into view); a failed one leaves this card usable.
                        send('Delete the product "' + (p.name || '') + '"', { type: 'delete_product', projectId: card.id, productId: p.id });
                    });
                }, { iconOnly: true, ariaLabel: 'Delete product ' + (p.name || ''), title: 'Delete product' });
                del.classList.add('ugc-choice-delete');
                tile.appendChild(del);
                grid.appendChild(tile);
            });
            container.appendChild(grid);
        } else {
            container.appendChild(el('p', 'ugc-note', 'Your product library is empty. Create the first product below.'));
        }

        // The full "new product" form is a secondary action: collapsed until the
        // user asks for it (and opened by default only when nothing is selectable).
        const formDisclosure = disclosure('Create a new product', 'plus', 'ugc-disclosure--create');
        if (!products.length) formDisclosure.open = true;
        const form = el('div', 'ugc-form ugc-form--product');
        const name = input(suggested, 'Product name');
        const brand = input('', 'Brand');
        const category = input('', 'Category (e.g. skincare, home)');
        const description = textarea('', 'Short description (what it is, what it looks like). Type @ to add a generated image.', 2);
        const usage = textarea('', 'How the product is used (facts you supply)', 2);
        const benefits = input('', 'Key benefits (comma separated)');
        const sellingPoints = input('', 'Key selling points (comma separated)');
        const audience = input('', 'Target audience');
        const colors = input('', 'Brand colors (comma separated)');
        const avoid = input('', 'Claims to avoid (comma separated)');

        form.appendChild(labelWrap('Name', name));
        form.appendChild(labelWrap('Brand', brand));
        form.appendChild(labelWrap('Category', category));
        form.appendChild(labelWrap('Description', description, 'ugc-field--wide'));
        form.appendChild(labelWrap('How it is used', usage, 'ugc-field--wide'));
        form.appendChild(labelWrap('Key benefits', benefits));
        form.appendChild(labelWrap('Key selling points', sellingPoints));
        form.appendChild(labelWrap('Target audience', audience, 'ugc-field--wide'));
        form.appendChild(labelWrap('Brand colors', colors));
        form.appendChild(labelWrap('Claims to avoid', avoid));

        // Reference images: a styled button drives a hidden file input, and
        // attached images preview as removable thumbnails — matching the UGC
        // button/chip language instead of the native "Choose File" control.
        const fileInput = el('input', 'ugc-file-hidden');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.multiple = true;
        fileInput.hidden = true;
        const refs = [];
        const refThumbs = el('div', 'ugc-ref-uploads');
        const uploadBtn = button('Add reference images', 'image', '', () => fileInput.click());
        const REF_NOTE = 'PNG, JPEG or WebP, or type @ in the description.';
        const refNote = el('span', 'ugc-file-note', REF_NOTE);

        function renderRefThumbs() {
            refThumbs.innerHTML = '';
            refs.forEach((url, index) => {
                const thumb = el('div', 'ugc-ref-thumb');
                const img = el('img', 'ugc-ref-thumb-img');
                img.src = url;
                img.alt = 'reference image';
                img.loading = 'lazy';
                thumb.appendChild(img);
                const remove = el('button', 'ugc-ref-thumb-remove');
                remove.type = 'button';
                remove.title = 'Remove reference image';
                remove.setAttribute('aria-label', 'Remove reference image');
                remove.innerHTML = iconSvg('x', 12);
                remove.addEventListener('click', () => {
                    refs.splice(index, 1);
                    renderRefThumbs();
                    refNote.textContent = refs.length ? refs.length + ' attached.' : REF_NOTE;
                });
                thumb.appendChild(remove);
                refThumbs.appendChild(thumb);
            });
        }

        // Add a reference by URL (from an upload or an @ mention), de-duplicated
        // and capped at the same limit the server enforces.
        function addReferenceUrl(url) {
            if (!url || refs.includes(url)) return;
            if (refs.length >= 6) {
                refNote.textContent = 'Up to 6 reference images.';
                return;
            }
            refs.push(url);
            renderRefThumbs();
            refNote.textContent = refs.length + ' attached.';
        }

        // Typing "@" in the description opens the generated-image picker from
        // the current conversation; the chosen image becomes a reference.
        if (typeof MentionPicker !== 'undefined' && MentionPicker) {
            MentionPicker.attach(description, (item) => addReferenceUrl(item.url));
        }

        fileInput.addEventListener('change', async () => {
            uploadBtn.disabled = true;
            refNote.textContent = 'Uploading\u2026';
            try {
                for (const file of Array.from(fileInput.files || [])) {
                    const url = await uploadImage(file);
                    addReferenceUrl(url);
                }
                refNote.textContent = refs.length ? refs.length + ' attached.' : REF_NOTE;
            } catch (e) {
                refNote.textContent = 'Upload failed.';
            } finally {
                uploadBtn.disabled = false;
                fileInput.value = '';
            }
        });

        const fileRow = el('div', 'ugc-file-row');
        fileRow.appendChild(uploadBtn);
        fileRow.appendChild(fileInput);
        fileRow.appendChild(refNote);
        const fileField = el('div', 'ugc-field ugc-field--wide');
        fileField.appendChild(el('span', 'ugc-field-label', 'Reference images'));
        fileField.appendChild(fileRow);
        form.appendChild(fileField);
        form.appendChild(refThumbs);

        const save = button('Save product', 'check', products.length ? '' : 'primary', () => {
            if (!String(name.value || '').trim()) {
                name.focus();
                return;
            }
            lock(container.closest('.ugc-card'));
            send('Save the product "' + name.value.trim() + '"', {
                type: 'create_product',
                projectId: card.id,
                product: {
                    name: name.value.trim(),
                    brand: brand.value.trim(),
                    category: category.value.trim(),
                    description: description.value.trim(),
                    usageInstructions: usage.value.trim(),
                    keyBenefits: benefits.value.trim(),
                    keySellingPoints: sellingPoints.value.trim(),
                    targetAudience: audience.value.trim(),
                    brandColors: colors.value.trim(),
                    claimsToAvoid: avoid.value.trim(),
                    referenceImages: refs
                }
            });
        });
        form.appendChild(actionRow([save]));
        formDisclosure.appendChild(form);
        container.appendChild(formDisclosure);
    }

    function creatorChoice(card, c, container) {
        const selected = Boolean(card.creator && (card.creator.characterId === c.id
            || (c.name && card.creator.name === c.name)));
        const tile = el('div', 'ugc-choice ugc-choice--creator' + (selected ? ' ugc-choice--selected' : ''));
        const main = el('button', 'ugc-choice-main');
        main.type = 'button';
        main.setAttribute('aria-pressed', selected ? 'true' : 'false');
        main.setAttribute('aria-label', 'Use ' + (c.name || 'character') + ' as the creator');

        const thumb = el('span', 'ugc-choice-thumb ugc-choice-thumb--portrait');
        if (c.image) {
            const img = el('img', 'ugc-choice-img');
            img.src = c.image;
            img.alt = '';
            img.loading = 'lazy';
            thumb.appendChild(img);
        } else {
            thumb.classList.add('ugc-choice-thumb--placeholder');
            thumb.innerHTML = iconSvg('user', 20);
        }
        main.appendChild(thumb);

        const body = el('span', 'ugc-choice-body');
        body.appendChild(el('span', 'ugc-choice-title', c.name || 'Character'));
        if (c.appearanceCategoryLabel) body.appendChild(el('span', 'ugc-choice-meta', c.appearanceCategoryLabel));
        const tags = el('span', 'ugc-choice-tags');
        tags.appendChild(el('span', 'ugc-tag' + (c.hasIdentity ? ' ugc-tag--good' : ''),
            c.hasIdentity ? 'Identity ready' : 'No identity yet'));
        body.appendChild(tags);
        main.appendChild(body);

        main.addEventListener('click', () => {
            lock(container.closest('.ugc-card'));
            send('Use ' + (c.name || 'this character') + ' as the creator', { type: 'select_creator', projectId: card.id, characterId: c.id });
        });
        tile.appendChild(main);
        if (selected) {
            const check = el('span', 'ugc-choice-check');
            check.innerHTML = iconSvg('check', 14);
            check.setAttribute('aria-hidden', 'true');
            tile.appendChild(check);
        }
        return tile;
    }

    function renderCreatorSelection(card, container) {
        const characters = Array.isArray(card.characters) ? card.characters : [];

        if (card.creator && card.creator.source === 'random') {
            const current = el('div', 'ugc-callout ugc-callout--creator');
            current.appendChild(el('p', 'ugc-callout-text', 'Current creator: ' + (card.creator.name || 'Creator')));
            if (card.creator.identity) current.appendChild(el('p', 'ugc-note', card.creator.identity));
            current.appendChild(actionRow([
                button('Save as character', 'check', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Save this creator as a character', {
                        type: 'create_creator', projectId: card.id,
                        creator: {
                            name: card.creator.name,
                            identity: card.creator.identity,
                            appearance: card.creator.appearance,
                            hair: card.creator.hair,
                            appearanceCategory: card.creator.appearanceCategory,
                            appearanceCategoryLabel: card.creator.appearanceCategoryLabel
                        }
                    });
                })
            ]));
            container.appendChild(current);
        }

        if (characters.length) {
            container.appendChild(el('div', 'ugc-section-title', 'Your characters'));
            const grid = el('div', 'ugc-choices');
            characters.forEach((c) => grid.appendChild(creatorChoice(card, c, container)));
            container.appendChild(grid);
        } else {
            container.appendChild(el('p', 'ugc-note', 'No saved characters yet. Roll a new creator below, or open the Character Playground to build one.'));
        }

        const rollDisclosure = disclosure('Roll a new creator', 'refresh');
        if (!characters.length) rollDisclosure.open = true;
        const form = el('div', 'ugc-form');
        const appearance = el('select', 'ugc-input');
        const age = el('select', 'ugc-input');
        const gender = el('select', 'ugc-input');
        [[appearance, 'appearance'], [age, 'age'], [gender, 'gender']].forEach(([node]) => {
            const random = el('option', null, 'Random');
            random.value = 'random';
            node.appendChild(random);
        });
        fillProfileOptions(appearance, age, gender);
        form.appendChild(labelWrap('Appearance', appearance));
        form.appendChild(labelWrap('Age', age));
        form.appendChild(labelWrap('Gender', gender));

        const roll = button('Roll a creator', 'refresh', 'primary', () => {
            lock(container.closest('.ugc-card'));
            send('Roll a new creator', {
                type: 'random_creator', projectId: card.id,
                creator: { profile: { appearance: appearance.value, age: age.value, gender: gender.value } }
            });
        });
        form.appendChild(actionRow([roll]));
        rollDisclosure.appendChild(form);
        container.appendChild(rollDisclosure);

        const skip = button('Product only (no creator)', 'box', '', () => {
            lock(container.closest('.ugc-card'));
            send('Skip the creator and make it product-only', { type: 'skip_creator', projectId: card.id });
        });
        const playground = button('Open Character Playground', 'user', '', () => {
            if (window.PlaygroundUI && typeof window.PlaygroundUI.open === 'function') window.PlaygroundUI.open();
        });
        container.appendChild(actionRow([skip, playground]));
    }

    function renderCreativeDirection(card, container) {
        const contentTypes = Array.isArray(card.contentTypes) ? card.contentTypes : [];
        const envs = Array.isArray(card.environments) ? card.environments : [];
        const packs = Array.isArray(card.outfitPacks) ? card.outfitPacks : [];

        container.appendChild(el('div', 'ugc-section-title', 'Content type'));
        container.appendChild(chipRow(contentTypes, card.contentType && card.contentType.id,
            (id) => send('Use the ' + id + ' content type', { type: 'select_content_type', projectId: card.id, contentTypeId: id })));

        container.appendChild(el('div', 'ugc-section-title', 'Outfit'));
        container.appendChild(chipRow(packs, card.outfit && card.outfit.packId,
            (id) => send('Use that outfit', { type: 'select_outfit', projectId: card.id, outfitPack: id })));
        if (card.outfit && card.outfit.outfit) {
            const current = el('p', 'ugc-note ugc-note--tight');
            current.appendChild(el('span', 'ugc-note-label', 'Current: '));
            current.appendChild(document.createTextNode(card.outfit.outfit));
            container.appendChild(current);
        }
        const customOutfit = el('div', 'ugc-inline');
        const customInput = input('', 'Custom outfit (describe exact clothing)');
        const customBtn = button('Use custom', 'pencil', '', () => {
            if (!String(customInput.value || '').trim()) { customInput.focus(); return; }
            send('Use this outfit: ' + customInput.value.trim(), { type: 'select_outfit', projectId: card.id, outfitPack: 'custom', outfitPackCustom: customInput.value.trim() });
        });
        customOutfit.appendChild(customInput);
        customOutfit.appendChild(customBtn);
        container.appendChild(customOutfit);

        container.appendChild(el('div', 'ugc-section-title', 'Environment'));
        container.appendChild(chipRow(envs.map((e) => ({ id: e.id, label: e.label })), card.environment && card.environment.id,
            (id) => {
                if (id === 'custom') {
                    Dialog.prompt({ title: 'Custom environment', message: 'Describe the environment.', placeholder: 'e.g. a sunlit modern bathroom with marble tiles', confirmText: 'Use environment' })
                        .then((text) => {
                            const value = String(text || '').trim();
                            if (!value) return;
                            send('Change the environment to ' + value, { type: 'select_environment', projectId: card.id, environmentId: 'custom', direction: value });
                        });
                    return;
                }
                send('Use that environment', { type: 'select_environment', projectId: card.id, environmentId: id });
            }));
    }

    function renderBrief(card, container) {
        const brief = card.brief || {};
        const form = el('div', 'ugc-form ugc-form--brief');
        const objective = textarea(brief.objective, 'What this video is for', 2);
        const audience = input(brief.targetAudience, 'Target audience');
        const tone = input(brief.tone, 'Tone (e.g. natural, upbeat)');
        const keyMessage = input(brief.keyMessage, 'Key message');
        const cta = input(brief.callToAction, 'Call to action');
        const duration = input(brief.duration || '', 'Duration (seconds)');
        const extra = textarea(brief.additionalInstructions, 'Additional instructions', 2);

        form.appendChild(labelWrap('Objective', objective, 'ugc-field--wide'));
        form.appendChild(labelWrap('Target audience', audience));
        form.appendChild(labelWrap('Tone', tone));
        form.appendChild(labelWrap('Key message', keyMessage));
        form.appendChild(labelWrap('Call to action', cta));
        form.appendChild(labelWrap('Duration (s)', duration));
        form.appendChild(labelWrap('Additional instructions', extra, 'ugc-field--wide'));

        const save = button('Save changes', 'check', '', () => {
            lock(container.closest('.ugc-card'));
            send('Update the brief', {
                type: 'edit_brief', projectId: card.id,
                brief: {
                    objective: objective.value,
                    targetAudience: audience.value,
                    tone: tone.value,
                    keyMessage: keyMessage.value,
                    callToAction: cta.value,
                    duration: duration.value,
                    additionalInstructions: extra.value
                }
            });
        });
        form.appendChild(actionRow([save]));
        container.appendChild(form);

        const setupDisclosure = disclosure('Adjust setup', 'pencil');
        const setup = [];
        setup.push(button('Select product', 'box', '', () => send('Choose the product', { type: 'select_product', projectId: card.id })));
        setup.push(button('Choose creator', 'user', '', () => send('Choose a creator', { type: 'select_creator', projectId: card.id })));
        setup.push(button('Choose outfit', 'pencil', '', () => send('Choose an outfit', { type: 'select_outfit', projectId: card.id })));
        setup.push(button('Choose environment', 'image', '', () => send('Choose an environment', { type: 'select_environment', projectId: card.id })));
        setup.push(button('Choose type', 'film', '', () => send('Choose a content type', { type: 'select_content_type', projectId: card.id })));
        setupDisclosure.appendChild(actionRow(setup));
        container.appendChild(setupDisclosure);

        container.appendChild(actionRow([
            button('Approve Brief \u2192 Write Script', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the brief', { type: 'approve_brief', projectId: card.id });
            }),
            button('Regenerate Brief', 'refresh', '', () => {
                lock(container.closest('.ugc-card'));
                send('Regenerate the brief', { type: 'regenerate_brief', projectId: card.id });
            })
        ], 'footer'));
    }

    function scriptBlock(title, value) {
        const wrap = el('div', 'ugc-script-line');
        wrap.appendChild(el('span', 'ugc-script-label', title));
        wrap.appendChild(el('span', 'ugc-script-text', value || '\u2014'));
        return wrap;
    }

    function renderScript(card, container) {
        const script = card.script || {};
        // One review surface (read-only). Editing lives behind an explicit
        // affordance so the script is never shown twice at once.
        const review = el('div', 'ugc-script');
        review.appendChild(scriptBlock('Hook', script.hook));
        review.appendChild(scriptBlock('Main message', script.main));
        review.appendChild(scriptBlock('Product interaction', script.productInteraction));
        review.appendChild(scriptBlock('Closing / CTA', script.closing));
        container.appendChild(review);
        if (script.needsConfirmation) {
            container.appendChild(el('p', 'ugc-note ugc-note--warn', 'Some lines were removed because they made claims the product facts do not support. Check the script before approving.'));
        }

        const editDisclosure = disclosure('Edit script', 'pencil');
        const form = el('div', 'ugc-form');
        const hook = textarea(script.hook, 'Hook', 2);
        const main = textarea(script.main, 'Main message', 3);
        const interaction = textarea(script.productInteraction, 'Product interaction', 2);
        const closing = textarea(script.closing, 'Closing / CTA', 2);
        form.appendChild(labelWrap('Hook', hook));
        form.appendChild(labelWrap('Main', main));
        form.appendChild(labelWrap('Interaction', interaction));
        form.appendChild(labelWrap('Closing', closing));
        form.appendChild(actionRow([
            button('Save script', 'check', '', () => {
                lock(container.closest('.ugc-card'));
                send('Save the script', {
                    type: 'edit_script', projectId: card.id,
                    script: {
                        hook: hook.value, main: main.value,
                        productInteraction: interaction.value, closing: closing.value
                    }
                });
            })
        ]));
        editDisclosure.appendChild(form);
        container.appendChild(editDisclosure);

        const rewriteDisclosure = disclosure('Rewrite options', 'refresh');
        rewriteDisclosure.appendChild(actionRow([
            button('Change Tone', 'pencil', '', () => {
                Dialog.prompt({ title: 'Change Tone', message: 'Describe the tone you want.', placeholder: 'e.g. more casual and upbeat', confirmText: 'Rewrite' })
                    .then((text) => {
                        const value = String(text || '').trim();
                        if (!value) return;
                        lock(container.closest('.ugc-card'));
                        send('Change the tone to ' + value, { type: 'change_tone', projectId: card.id, direction: value });
                    });
            }),
            button('Change Hook', 'refresh', '', () => {
                Dialog.prompt({ title: 'Change Hook', message: 'Describe the new hook.', placeholder: 'e.g. open with a surprising question', confirmText: 'Rewrite' })
                    .then((text) => {
                        const value = String(text || '').trim();
                        if (!value) return;
                        lock(container.closest('.ugc-card'));
                        send('Change the hook: ' + value, { type: 'change_hook', projectId: card.id, direction: value });
                    });
            })
        ]));
        container.appendChild(rewriteDisclosure);

        container.appendChild(actionRow([
            button('Approve Script', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the script', { type: 'approve_script', projectId: card.id });
            }),
            button('Regenerate Script', 'refresh', '', () => {
                lock(container.closest('.ugc-card'));
                send('Regenerate the script', { type: 'regenerate_script', projectId: card.id });
            })
        ], 'footer'));
    }

    function renderScenes(card, container) {
        const scenes = Array.isArray(card.scenes) ? card.scenes : [];
        const list = el('div', 'ugc-scenes');
        scenes.forEach((scene, index) => {
            const item = el('div', 'ugc-scene');
            const head = el('div', 'ugc-scene-head');
            head.appendChild(el('span', 'ugc-scene-num', String(index + 1).padStart(2, '0')));
            head.appendChild(el('span', 'ugc-scene-dur', (Number(scene.duration) || 0) + 's'));
            if (scene.objective) head.appendChild(el('span', 'ugc-scene-obj', scene.objective));
            const tools = el('div', 'ugc-scene-tools');
            tools.appendChild(button('', 'up', '', () => {
                lock(container.closest('.ugc-card'));
                send('Move scene ' + (index + 1) + ' up', { type: 'move_scene', projectId: card.id, sceneId: scene.id, direction: 'up' });
            }, { iconOnly: true, ariaLabel: 'Move scene ' + (index + 1) + ' up', title: 'Move scene up' }));
            tools.appendChild(button('', 'down', '', () => {
                lock(container.closest('.ugc-card'));
                send('Move scene ' + (index + 1) + ' down', { type: 'move_scene', projectId: card.id, sceneId: scene.id, direction: 'down' });
            }, { iconOnly: true, ariaLabel: 'Move scene ' + (index + 1) + ' down', title: 'Move scene down' }));
            head.appendChild(tools);
            item.appendChild(head);

            if (scene.action) item.appendChild(el('p', 'ugc-scene-action', scene.action));
            if (scene.dialogue) {
                const line = el('p', 'ugc-scene-dialogue');
                line.appendChild(el('span', 'ugc-scene-dialogue-mark', '\u201c'));
                line.appendChild(document.createTextNode(scene.dialogue));
                line.appendChild(el('span', 'ugc-scene-dialogue-mark', '\u201d'));
                item.appendChild(line);
            }
            const meta = el('div', 'ugc-scene-meta');
            const movementText = scene.camera && scene.camera.movement;
            if (movementText) meta.appendChild(el('span', 'ugc-tag', 'Camera: ' + movementText));
            if (scene.productVisibility) meta.appendChild(el('span', 'ugc-tag', 'Product: ' + scene.productVisibility));
            if (meta.childNodes.length) item.appendChild(meta);

            if (scene.needsConfirmation) {
                item.appendChild(el('p', 'ugc-note ugc-note--warn', 'This action uses the product in a way the supplied usage facts do not confirm. Check it before approving.'));
            }

            const editDisclosure = disclosure('Edit scene ' + (index + 1), 'pencil');
            const editForm = el('div', 'ugc-form');
            const action = textarea(scene.action, 'Scene action', 2);
            const dialogue = textarea(scene.dialogue, 'Dialogue', 2);
            const duration = input(String(scene.duration), 'Seconds');
            const movementInput = input(movementText || '', 'Camera movement');
            const visibility = input(scene.productVisibility, 'Product visibility');
            editForm.appendChild(labelWrap('Action', action, 'ugc-field--wide'));
            editForm.appendChild(labelWrap('Dialogue', dialogue, 'ugc-field--wide'));
            editForm.appendChild(labelWrap('Duration (s)', duration));
            editForm.appendChild(labelWrap('Camera movement', movementInput));
            editForm.appendChild(labelWrap('Product visibility', visibility));
            editForm.appendChild(actionRow([
                button('Save changes', 'check', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Update scene ' + (index + 1), {
                        type: 'edit_scene', projectId: card.id, sceneId: scene.id,
                        scene: {
                            action: action.value, dialogue: dialogue.value, duration: duration.value,
                            camera: { movement: movementInput.value }, productVisibility: visibility.value
                        }
                    });
                })
            ]));
            editDisclosure.appendChild(editForm);
            item.appendChild(editDisclosure);

            item.appendChild(actionRow([
                button('Regenerate', 'refresh', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Regenerate only scene ' + (index + 1), { type: 'regenerate_scene', projectId: card.id, sceneId: scene.id });
                }),
                button('Delete', 'x', 'danger', () => {
                    lock(container.closest('.ugc-card'));
                    send('Delete scene ' + (index + 1), { type: 'delete_scene', projectId: card.id, sceneId: scene.id });
                })
            ]));
            list.appendChild(item);
        });
        container.appendChild(list);

        container.appendChild(actionRow([
            button('Add Scene', 'plus', '', () => {
                lock(container.closest('.ugc-card'));
                send('Add a scene', { type: 'add_scene', projectId: card.id });
            }),
            button('Approve Scene Plan', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the scene plan', { type: 'approve_scenes', projectId: card.id });
            })
        ], 'footer'));
    }

    const REF_STATUS_LABELS = {
        ready: 'Ready', approved: 'Approved', pending: 'Pending', failed: 'Failed', stale: 'Stale'
    };

    function renderReferences(card, container) {
        const refs = Array.isArray(card.references) ? card.references : [];
        const scenes = Array.isArray(card.scenes) ? card.scenes : [];
        const byScene = new Map();
        refs.forEach((r) => { byScene.set(r.sceneId, r); });
        const items = scenes.length
            ? scenes.map((s) => ({ sceneId: s.id, order: s.order, ref: byScene.get(s.id) || null }))
            : refs.map((r) => ({ sceneId: r.sceneId, order: r.order, ref: r }));
        const stats = frameStats(card);
        const complete = card.referencesComplete === true;
        const recovering = stats.failed > 0 || stats.stale > 0;

        // Overall progress: an exact count plus a bar, so several frames being
        // generated or retried read at a glance.
        const summary = el('div', 'ugc-refs-summary');
        const head = el('div', 'ugc-refs-progress-head');
        head.appendChild(el('span', 'ugc-refs-progress-label', stats.ready + ' of ' + stats.total + ' frames ready'));
        const badges = el('span', 'ugc-refs-badges');
        if (stats.failed) badges.appendChild(el('span', 'ugc-tag ugc-tag--warn', stats.failed + ' failed'));
        if (stats.stale) badges.appendChild(el('span', 'ugc-tag ugc-tag--warn', stats.stale + ' stale'));
        if (stats.pending) badges.appendChild(el('span', 'ugc-tag', stats.pending + ' pending'));
        head.appendChild(badges);
        summary.appendChild(head);
        const bar = el('div', 'ugc-refs-bar');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(stats.total || 0));
        bar.setAttribute('aria-valuenow', String(stats.ready));
        bar.setAttribute('aria-label', stats.ready + ' of ' + stats.total + ' reference frames ready');
        const fill = el('span', 'ugc-refs-bar-fill');
        fill.style.width = stats.total ? Math.round((stats.ready / stats.total) * 100) + '%' : '0%';
        bar.appendChild(fill);
        summary.appendChild(bar);
        container.appendChild(summary);

        const grid = el('div', 'ugc-refs');
        items.forEach((item) => {
            const ref = item.ref || {};
            const status = ref.status || 'pending';
            const tile = el('div', 'ugc-ref ugc-ref--' + status);
            const frame = el('div', 'ugc-ref-frame');
            if (ref.url) {
                const img = el('img', 'ugc-ref-img');
                img.src = ref.url;
                img.alt = '';
                img.loading = 'lazy';
                const preview = el('a', 'ugc-ref-preview');
                preview.href = ref.url;
                preview.target = '_blank';
                preview.rel = 'noopener';
                preview.title = 'Open reference image';
                preview.appendChild(img);
                frame.appendChild(preview);
            } else {
                frame.appendChild(el('div', 'ugc-ref-missing', status === 'failed' ? 'Failed' : 'No frame'));
            }
            tile.appendChild(frame);
            const foot = el('div', 'ugc-ref-foot');
            foot.appendChild(el('span', 'ugc-ref-label', 'Scene ' + item.order));
            foot.appendChild(el('span', 'ugc-ref-status ugc-ref-status--' + status,
                REF_STATUS_LABELS[status] || status));
            tile.appendChild(foot);
            if (status === 'failed' && ref.error) {
                tile.appendChild(el('span', 'ugc-ref-error', ref.error));
            }
            if (item.sceneId) {
                tile.appendChild(button(status === 'failed' ? 'Retry' : 'Regenerate', 'refresh', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Regenerate only scene ' + item.order, { type: 'regenerate_reference', projectId: card.id, sceneId: item.sceneId });
                }));
            }
            grid.appendChild(tile);
        });
        container.appendChild(grid);

        const actions = [];
        if (complete) {
            actions.push(button('Approve All \u2192 Director', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the references and continue in Director Mode', { type: 'approve_references', projectId: card.id });
            }));
        } else {
            actions.push(button('Approve All (needs every scene)', 'check', '', () => {
                Dialog.alert({ title: 'Reference frames incomplete', message: 'Every scene needs exactly one current frame before the production can be approved. Retry the failed scenes first.' });
            }));
        }
        if (recovering) {
            actions.push(button('Retry failed', 'refresh', '', () => {
                lock(container.closest('.ugc-card'));
                send('Retry the failed reference frames', { type: 'retry_failed', projectId: card.id });
            }));
        }
        actions.push(button('Regenerate All', 'refresh', '', () => {
            lock(container.closest('.ugc-card'));
            send('Regenerate the references', { type: 'regenerate_references', projectId: card.id });
        }));
        actions.push(button('Edit Direction', 'pencil', '', () => {
            Dialog.prompt({ title: 'Edit Direction', message: 'Describe the change for the reference frames.', placeholder: 'e.g. make the lighting warmer and move the camera closer', confirmText: 'Apply' })
                .then((text) => {
                    const value = String(text || '').trim();
                    if (!value) return;
                    lock(container.closest('.ugc-card'));
                    send('Edit the direction: ' + value, { type: 'edit_direction', projectId: card.id, direction: value });
                });
        }));
        container.appendChild(actionRow(actions, 'footer'));
    }

    function render(contentEl, card) {
        const container = contentEl;
        const el2 = el('div', 'ugc-card ugc-card--' + (card.stage || 'unknown'));
        el2.setAttribute('data-project-id', card.id);
        el2.setAttribute('data-stage', card.stage || '');
        el2.setAttribute('data-version', String(card.version || 0));
        // Only the newest card is interactive; it owns the version actions carry.
        activeVersion = Number(card.version) || 0;

        const head = el('div', 'ugc-card-head');
        const icon = el('span', 'ugc-card-icon');
        icon.innerHTML = iconSvg('clapper', 15);
        const title = el('span', 'ugc-card-title', 'UGC Studio');
        const stage = el('span', 'ugc-card-stage', stageLabel(card.stage));
        head.appendChild(icon);
        head.appendChild(title);
        head.appendChild(stage);
        el2.appendChild(head);

        const help = stageHelp(card.stage);
        const lead = el('div', 'ugc-card-lead');
        lead.appendChild(el('h3', 'ugc-card-heading', help.title));
        if (help.hint) lead.appendChild(el('p', 'ugc-card-hint', help.hint));
        el2.appendChild(lead);

        renderProgress(card.stage, el2);

        renderContext(card, el2);

        if (card.stage === 'product_selection') renderProductSelection(card, el2);
        else if (card.stage === 'creator_selection') renderCreatorSelection(card, el2);
        else if (card.stage === 'creative_direction') renderCreativeDirection(card, el2);
        else if (card.stage === 'script_review') renderScript(card, el2);
        else if (card.stage === 'scene_review') renderScenes(card, el2);
        else if (card.stage === 'reference_approval' || card.stage === 'reference_generation') renderReferences(card, el2);
        else if (card.stage === 'video_generation' || card.stage === 'completed') {
            if (card.stage === 'completed' && card.videoUrl) {
                el2.appendChild(actionRow([
                    button('View video', 'film', 'primary', () => {
                        if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
                            window.Gallery.openFromUrl(card.videoUrl);
                        }
                    })
                ]));
            }
        } else {
            renderBrief(card, el2);
        }

        container.appendChild(el2);
    }

    // --- Data helpers ---

    async function uploadImage(file) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        const res = await fetch('/api/uploads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, mime: file.type, data: base64 })
        });
        if (!res.ok) throw new Error('upload failed');
        const data = await res.json();
        return data.url || null;
    }

    let profileOptionsCache = null;
    async function fillProfileOptions(appearance, age, gender) {
        if (!profileOptionsCache) {
            try {
                const res = await fetch('/api/playground/options');
                const data = await res.json();
                profileOptionsCache = {
                    appearance: Array.isArray(data.appearance) ? data.appearance : [],
                    age: Array.isArray(data.age) ? data.age : [],
                    gender: Array.isArray(data.gender) ? data.gender : []
                };
            } catch (e) {
                profileOptionsCache = { appearance: [], age: [], gender: [] };
            }
        }
        const fill = (select, items) => {
            items.forEach((item) => {
                const opt = document.createElement('option');
                opt.value = item.value;
                opt.textContent = item.label;
                select.appendChild(opt);
            });
        };
        fill(appearance, profileOptionsCache.appearance);
        fill(age, profileOptionsCache.age);
        fill(gender, profileOptionsCache.gender);
    }

    // --- State / mode bar ---

    // Only the newest card for the project is interactive. Every earlier card
    // for the same project is marked static and its controls disabled, so a
    // stale card can never be mistaken for (or act as) the active one.
    function applyState(container, project) {
        if (!container) return null;
        const cards = Array.from(container.querySelectorAll('.ugc-card'));
        let active = null;
        if (project) {
            for (let i = cards.length - 1; i >= 0; i--) {
                if (cards[i].getAttribute('data-project-id') === project.id) { active = cards[i]; break; }
            }
        }
        cards.forEach((node) => {
            const isActive = node === active;
            node.classList.toggle('ugc-card--static', !isActive);
            node.querySelectorAll('button, input, select, textarea').forEach((control) => {
                control.disabled = !isActive;
            });
        });
        return active;
    }

    // Smoothly bring a card to the top of the chat scroll area (used after a
    // card action emits the next active card).
    function scrollToCard(container, card) {
        if (!container || !card || typeof container.scrollTo !== 'function') return;
        const offset = card.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        container.scrollTo({ top: Math.max(0, offset - 12), behavior: 'smooth' });
    }

    async function fetchState(conversationId) {
        if (!conversationId) return null;
        try {
            const res = await fetch('/api/ugc/state?conversationId=' + encodeURIComponent(conversationId));
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    async function hydrate(container, conversationId, opts) {
        if (!container) return;
        const data = await fetchState(conversationId);
        const active = applyState(container, data && data.project ? data.project : null);
        updateBar(data);
        if (opts && opts.scroll && active) scrollToCard(container, active);
        return active;
    }

    // The subtle "UGC Studio · Active" indicator above the chat.
    let barEl = null;
    let barLabelEl = null;
    let barStageEl = null;

    function barButton(label, onClick, variant) {
        const btn = el('button', 'ugc-bar-btn' + (variant ? ' ugc-bar-btn--' + variant : ''), label);
        btn.type = 'button';
        btn.addEventListener('click', onClick);
        return btn;
    }

    function updateBar(data) {
        if (!barEl) return;
        const project = data && data.project ? data.project : null;
        if (!project) {
            barEl.hidden = true;
            barEl.innerHTML = '';
            return;
        }
        barEl.hidden = false;
        const isDraft = project.status === 'draft';
        const isComplete = project.status === 'completed';
        // The bar always reflects the live project, so its actions must carry the
        // live version (a completed production advances the version after the last
        // UGC card was rendered, which would otherwise look stale).
        activeVersion = Number(project.version) || 0;
        barEl.classList.toggle('ugc-bar--draft', isDraft);
        barEl.classList.toggle('ugc-bar--complete', isComplete);
        barEl.innerHTML = '';
        const dot = el('span', 'ugc-bar-dot');
        const label = el('span', 'ugc-bar-label',
            isDraft ? 'UGC STUDIO \u00b7 DRAFT' : (isComplete ? 'UGC STUDIO \u00b7 COMPLETE' : 'UGC STUDIO \u00b7 ACTIVE'));
        const stage = el('span', 'ugc-bar-stage', stageLabel(project.stage));
        barEl.appendChild(dot);
        barEl.appendChild(label);
        barEl.appendChild(stage);
        const actions = el('span', 'ugc-bar-actions');
        if (isDraft) {
            actions.appendChild(barButton('Resume', () => send('Resume the UGC project', { type: 'resume', projectId: project.id })));
            actions.appendChild(barButton('Discard', () => send('Discard the UGC project', { type: 'discard', projectId: project.id }), 'danger'));
        } else if (isComplete) {
            if (project.videoUrl) {
                actions.appendChild(barButton('View video', () => {
                    if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
                        window.Gallery.openFromUrl(project.videoUrl);
                    }
                }));
            }
            actions.appendChild(barButton('View brief', () => send('Show the UGC brief', { type: 'view_brief', projectId: project.id })));
            actions.appendChild(barButton('New project', () => send('Start a new UGC project', { type: 'new_project', projectId: project.id })));
        } else {
            actions.appendChild(barButton('View brief', () => send('Show the UGC brief', { type: 'view_brief', projectId: project.id })));
            actions.appendChild(barButton('Save draft', () => send('Save the UGC project as a draft', { type: 'save_draft', projectId: project.id })));
            actions.appendChild(barButton('Exit', () => send('Exit UGC mode', { type: 'exit', projectId: project.id }), 'danger'));
        }
        barEl.appendChild(actions);
    }

    async function refreshBar() {
        const conversationId = (typeof Conversations !== 'undefined' && Conversations.currentId)
            ? Conversations.currentId()
            : '';
        const data = await fetchState(conversationId);
        updateBar(data);
    }

    function init() {
        barEl = document.getElementById('ugcBar');
        if (!barEl) return;
        // The bar is refreshed by Chat.renderMessages (via hydrate) on a
        // conversation switch and by the send flow's finally block after each
        // turn, so no extra listeners are needed here.
        refreshBar();
    }

    return {
        extract, strip, render, applyState, hydrate, refreshBar, updateBar, stageLabel, init
    };
})();

window.UGCUI = UGCUI;
