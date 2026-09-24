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

    function button(label, iconName, variant, onClick) {
        const btn = el('button', 'ugc-btn' + (variant ? ' ugc-btn--' + variant : ''));
        btn.type = 'button';
        if (iconName) btn.innerHTML = iconSvg(iconName, 14);
        const span = el('span', 'ugc-btn-label', label);
        btn.appendChild(span);
        btn.addEventListener('click', onClick);
        return btn;
    }

    function row(label, value) {
        const wrap = el('div', 'ugc-detail');
        wrap.appendChild(el('span', 'ugc-detail-label', label));
        wrap.appendChild(el('span', 'ugc-detail-value', value || '\u2014'));
        return wrap;
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

    function labelWrap(labelText, control) {
        const wrap = el('label', 'ugc-field');
        wrap.appendChild(el('span', 'ugc-field-label', labelText));
        wrap.appendChild(control);
        return wrap;
    }

    function chipRow(items, activeId, onPick, extra) {
        const wrap = el('div', 'ugc-chips');
        items.forEach((item) => {
            const chip = el('button', 'ugc-chip' + (item.id === activeId ? ' ugc-chip--active' : ''));
            chip.type = 'button';
            chip.textContent = item.label;
            chip.addEventListener('click', () => onPick(item.id));
            wrap.appendChild(chip);
        });
        if (extra) wrap.appendChild(extra);
        return wrap;
    }

    function actionRow(buttons) {
        const wrap = el('div', 'ugc-card-actions');
        buttons.forEach((b) => wrap.appendChild(b));
        return wrap;
    }

    function renderProgress(stage, container) {
        const current = STAGE_PHASES.findIndex((phase) => phase.stages.includes(stage));
        const progress = el('ol', 'ugc-progress');
        progress.setAttribute('aria-label', 'UGC workflow progress');
        STAGE_PHASES.forEach((phase, index) => {
            const item = el('li', 'ugc-progress-step');
            const complete = index < current || stage === 'completed';
            if (complete) item.classList.add('ugc-progress-step--done');
            if (index === current && stage !== 'completed') {
                item.classList.add('ugc-progress-step--active');
                item.setAttribute('aria-current', 'step');
            }
            item.appendChild(el('span', 'ugc-progress-marker', complete ? '\u2713' : String(index + 1)));
            item.appendChild(el('span', 'ugc-progress-label', phase.label));
            progress.appendChild(item);
        });
        container.appendChild(progress);
    }

    // --- Stage renderers ---

    function renderSummary(card, container) {
        const details = el('div', 'ugc-summary');
        details.appendChild(row('Product', card.product && card.product.name));
        details.appendChild(row('Creator', card.creator && (card.creator.name || card.creator.identity)));
        details.appendChild(row('Outfit', card.outfit && (card.outfit.outfit || card.outfit.label)));
        details.appendChild(row('Environment', card.environment && (card.environment.description || card.environment.label)));
        const brief = card.brief || {};
        details.appendChild(row('Type', card.contentType && card.contentType.label));
        details.appendChild(row('Duration', brief.duration ? brief.duration + 's' : ''));
        details.appendChild(row('Aspect', brief.aspectRatio));
        details.appendChild(row('Platform', brief.platform));
        container.appendChild(details);
    }

    function renderProductSelection(card, container) {
        const suggested = String(card.suggestedProductName || '').trim();
        const products = Array.isArray(card.products) ? card.products : [];
        const known = suggested && products.some((p) => String(p.name || '').toLowerCase() === suggested.toLowerCase());

        if (suggested && !known) {
            const btn = button('Use "' + suggested + '" as the product', 'plus', 'primary', () => {
                send('Create the product "' + suggested + '"', { type: 'create_product', projectId: card.id, product: { name: suggested } });
            });
            container.appendChild(actionRow([btn]));
        }

        if (products.length) {
            const list = el('div', 'ugc-list');
            products.forEach((p) => {
                const row = el('div', 'ugc-list-row');
                const item = el('button', 'ugc-list-item');
                item.type = 'button';
                item.appendChild(el('span', 'ugc-list-title', p.name || 'Product'));
                const meta = [p.brand, p.category].filter(Boolean).join(' \u00b7 ');
                if (meta) item.appendChild(el('span', 'ugc-list-sub', meta));
                if (p.description) item.appendChild(el('span', 'ugc-list-desc', String(p.description).slice(0, 140)));
                if (p.usageInstructions) item.appendChild(el('span', 'ugc-list-sub', 'Use: ' + String(p.usageInstructions).slice(0, 100)));
                if (p.keySellingPoints && p.keySellingPoints.length) {
                    item.appendChild(el('span', 'ugc-list-sub', 'Selling points: ' + p.keySellingPoints.join(', ')));
                }
                if (p.targetAudience) item.appendChild(el('span', 'ugc-list-sub', 'Audience: ' + String(p.targetAudience).slice(0, 80)));
                if (p.referenceImages && p.referenceImages.length) {
                    item.appendChild(el('span', 'ugc-list-sub', p.referenceImages.length + ' reference image(s)'));
                }
                item.addEventListener('click', () => {
                    lock(container.closest('.ugc-card'));
                    send('Use the product "' + (p.name || '') + '"', { type: 'select_product', projectId: card.id, productId: p.id });
                });
                row.appendChild(item);

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
                });
                del.classList.add('ugc-list-delete');
                del.title = 'Delete product';
                del.setAttribute('aria-label', 'Delete product');
                row.appendChild(del);
                list.appendChild(row);
            });
            container.appendChild(list);
        }

        // Inline "new product" form.
        const form = el('div', 'ugc-form ugc-form--product');
        form.appendChild(el('div', 'ugc-section-title', 'New product'));
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
        form.appendChild(labelWrap('Description', description));
        form.appendChild(labelWrap('How it is used', usage));
        form.appendChild(labelWrap('Key benefits', benefits));
        form.appendChild(labelWrap('Key selling points', sellingPoints));
        form.appendChild(labelWrap('Target audience', audience));
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
        const fileField = el('div', 'ugc-field');
        fileField.appendChild(el('span', 'ugc-field-label', 'Reference images'));
        fileField.appendChild(fileRow);
        form.appendChild(fileField);
        form.appendChild(refThumbs);

        const save = button('Save product', 'check', 'primary', () => {
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
        container.appendChild(form);
    }

    function renderCreatorSelection(card, container) {
        const characters = Array.isArray(card.characters) ? card.characters : [];
        if (characters.length) {
            const list = el('div', 'ugc-list');
            characters.forEach((c) => {
                const item = el('button', 'ugc-list-item');
                item.type = 'button';
                item.appendChild(el('span', 'ugc-list-title', c.name || 'Character'));
                item.addEventListener('click', () => {
                    lock(container.closest('.ugc-card'));
                    send('Use ' + (c.name || 'this character') + ' as the creator', { type: 'select_creator', projectId: card.id, characterId: c.id });
                });
                list.appendChild(item);
            });
            container.appendChild(list);
        } else {
            container.appendChild(el('p', 'ugc-note', 'No saved characters yet. Roll a new creator below, or open the Character Playground to build one.'));
        }

        const form = el('div', 'ugc-form');
        form.appendChild(el('div', 'ugc-section-title', 'Roll a new creator'));
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
        const skip = button('Product only (no creator)', 'box', '', () => {
            lock(container.closest('.ugc-card'));
            send('Skip the creator and make it product-only', { type: 'skip_creator', projectId: card.id });
        });
        const playground = button('Open Character Playground', 'user', '', () => {
            if (window.PlaygroundUI && typeof window.PlaygroundUI.open === 'function') window.PlaygroundUI.open();
        });
        form.appendChild(actionRow([roll, skip, playground]));
        container.appendChild(form);

        if (card.creator && card.creator.source === 'random') {
            const saveWrap = el('div', 'ugc-form');
            saveWrap.appendChild(el('div', 'ugc-section-title', 'Current creator: ' + (card.creator.name || 'Creator')));
            saveWrap.appendChild(el('p', 'ugc-note', card.creator.identity || ''));
            const save = button('Save as character', 'check', '', () => {
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
            });
            saveWrap.appendChild(actionRow([save]));
            container.appendChild(saveWrap);
        }
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

        form.appendChild(labelWrap('Objective', objective));
        form.appendChild(labelWrap('Target audience', audience));
        form.appendChild(labelWrap('Tone', tone));
        form.appendChild(labelWrap('Key message', keyMessage));
        form.appendChild(labelWrap('Call to action', cta));
        form.appendChild(labelWrap('Duration (s)', duration));
        form.appendChild(labelWrap('Additional instructions', extra));

        const save = button('Save brief', 'check', '', () => {
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

        const setup = [];
        setup.push(button('Select product', 'box', '', () => send('Choose the product', { type: 'select_product', projectId: card.id })));
        setup.push(button('Choose creator', 'user', '', () => send('Choose a creator', { type: 'select_creator', projectId: card.id })));
        setup.push(button('Choose outfit', 'pencil', '', () => send('Choose an outfit', { type: 'select_outfit', projectId: card.id })));
        setup.push(button('Choose environment', 'image', '', () => send('Choose an environment', { type: 'select_environment', projectId: card.id })));
        setup.push(button('Choose type', 'film', '', () => send('Choose a content type', { type: 'select_content_type', projectId: card.id })));
        container.appendChild(actionRow(setup));

        container.appendChild(actionRow([
            button('Approve Brief \u2192 Write Script', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the brief', { type: 'approve_brief', projectId: card.id });
            }),
            button('Regenerate Brief', 'refresh', '', () => {
                lock(container.closest('.ugc-card'));
                send('Regenerate the brief', { type: 'regenerate_brief', projectId: card.id });
            })
        ]));
    }

    function scriptBlock(title, value) {
        const wrap = el('div', 'ugc-detail ugc-detail--block');
        wrap.appendChild(el('span', 'ugc-detail-label', title));
        wrap.appendChild(el('span', 'ugc-detail-value', value || '\u2014'));
        return wrap;
    }

    function renderScript(card, container) {
        const script = card.script || {};
        container.appendChild(scriptBlock('Hook', script.hook));
        container.appendChild(scriptBlock('Main message', script.main));
        container.appendChild(scriptBlock('Product interaction', script.productInteraction));
        container.appendChild(scriptBlock('Closing / CTA', script.closing));
        if (script.needsConfirmation) {
            container.appendChild(el('p', 'ugc-note', 'Some lines were removed because they made claims the product facts do not support. Check the script before approving.'));
        }

        const form = el('div', 'ugc-form');
        form.appendChild(el('div', 'ugc-section-title', 'Edit script'));
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
        container.appendChild(form);

        container.appendChild(actionRow([
            button('Approve Script', 'check', 'primary', () => {
                lock(container.closest('.ugc-card'));
                send('Approve the script', { type: 'approve_script', projectId: card.id });
            }),
            button('Regenerate Script', 'refresh', '', () => {
                lock(container.closest('.ugc-card'));
                send('Regenerate the script', { type: 'regenerate_script', projectId: card.id });
            }),
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
    }

    function renderScenes(card, container) {
        const scenes = Array.isArray(card.scenes) ? card.scenes : [];
        const list = el('div', 'ugc-scenes');
        scenes.forEach((scene, index) => {
            const item = el('div', 'ugc-scene');
            const head = el('div', 'ugc-scene-head');
            head.appendChild(el('span', 'ugc-scene-num', String(index + 1).padStart(2, '0')));
            head.appendChild(el('span', 'ugc-scene-dur', scene.duration + 's'));
            head.appendChild(el('span', 'ugc-scene-obj', scene.objective || ''));
            item.appendChild(head);

            const action = textarea(scene.action, 'Scene action', 2);
            const dialogue = textarea(scene.dialogue, 'Dialogue', 2);
            const duration = input(String(scene.duration), 'Seconds');
            const movement = input((scene.camera && scene.camera.movement) || '', 'Camera movement');
            const visibility = input(scene.productVisibility, 'Product visibility');
            item.appendChild(labelWrap('Action', action));
            item.appendChild(labelWrap('Dialogue', dialogue));
            item.appendChild(labelWrap('Duration (s)', duration));
            item.appendChild(labelWrap('Camera movement', movement));
            item.appendChild(labelWrap('Product visibility', visibility));
            if (scene.needsConfirmation) {
                item.appendChild(el('p', 'ugc-note', 'This action uses the product in a way the supplied usage facts do not confirm. Check it before approving.'));
            }

            item.appendChild(actionRow([
                button('Save', 'check', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Update scene ' + (index + 1), {
                        type: 'edit_scene', projectId: card.id, sceneId: scene.id,
                        scene: {
                            action: action.value, dialogue: dialogue.value, duration: duration.value,
                            camera: { movement: movement.value }, productVisibility: visibility.value
                        }
                    });
                }),
                button('Regenerate', 'refresh', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Regenerate only scene ' + (index + 1), { type: 'regenerate_scene', projectId: card.id, sceneId: scene.id });
                }),
                button('Up', 'up', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Move scene ' + (index + 1) + ' up', { type: 'move_scene', projectId: card.id, sceneId: scene.id, direction: 'up' });
                }),
                button('Down', 'down', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Move scene ' + (index + 1) + ' down', { type: 'move_scene', projectId: card.id, sceneId: scene.id, direction: 'down' });
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
        ]));
    }

    function renderReferences(card, container) {
        const refs = Array.isArray(card.references) ? card.references : [];
        const scenes = Array.isArray(card.scenes) ? card.scenes : [];
        const byScene = new Map();
        refs.forEach((r) => { byScene.set(r.sceneId, r); });
        const grid = el('div', 'ugc-refs');
        let hasProblem = false;
        const items = scenes.length
            ? scenes.map((s) => ({ sceneId: s.id, order: s.order, ref: byScene.get(s.id) || null }))
            : refs.map((r) => ({ sceneId: r.sceneId, order: r.order, ref: r }));
        items.forEach((item) => {
            const ref = item.ref || {};
            const tile = el('div', 'ugc-ref ugc-ref--' + (ref.status || 'pending'));
            if (ref.url) {
                const img = el('img', 'ugc-ref-img');
                img.src = ref.url;
                img.alt = 'Scene ' + item.order;
                img.loading = 'lazy';
                const preview = el('a', 'ugc-ref-preview');
                preview.href = ref.url;
                preview.target = '_blank';
                preview.rel = 'noopener';
                preview.title = 'Open reference image';
                preview.appendChild(img);
                tile.appendChild(preview);
            } else {
                tile.appendChild(el('div', 'ugc-ref-missing', ref.status === 'failed' ? 'Failed' : 'No frame'));
            }
            tile.appendChild(el('span', 'ugc-ref-label', 'Scene ' + item.order + ' \u00b7 ' + (ref.status || 'pending')));
            if (ref.status === 'failed' && ref.error) {
                tile.appendChild(el('span', 'ugc-ref-error', ref.error));
            }
            if (ref.status !== 'ready' && ref.status !== 'approved') hasProblem = true;
            if (item.sceneId) {
                tile.appendChild(button('Regenerate', 'refresh', '', () => {
                    lock(container.closest('.ugc-card'));
                    send('Regenerate only scene ' + item.order, { type: 'regenerate_reference', projectId: card.id, sceneId: item.sceneId });
                }));
            }
            grid.appendChild(tile);
        });
        container.appendChild(grid);

        const complete = card.referencesComplete === true;
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
        if (hasProblem) {
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
        container.appendChild(actionRow(actions));
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

        renderProgress(card.stage, el2);

        renderSummary(card, el2);

        if (card.stage === 'product_selection') renderProductSelection(card, el2);
        else if (card.stage === 'creator_selection') renderCreatorSelection(card, el2);
        else if (card.stage === 'creative_direction') renderCreativeDirection(card, el2);
        else if (card.stage === 'script_review') renderScript(card, el2);
        else if (card.stage === 'scene_review') renderScenes(card, el2);
        else if (card.stage === 'reference_approval' || card.stage === 'reference_generation') renderReferences(card, el2);
        else if (card.stage === 'video_generation' || card.stage === 'completed') {
            el2.appendChild(el('p', 'ugc-note', card.stage === 'completed'
                ? 'This UGC production is complete.'
                : 'Handed to Director Mode. Follow the Director card for the final video.'));
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
