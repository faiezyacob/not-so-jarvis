/* ============================================
   JARVIS — Generation asset next-action card
   Every generated image/video in a conversation
   gets an inline action row beneath it: upscale,
   modify, or turn the image into a video. The
   upscale action is only offered while the asset
   has not been upscaled yet — the generated
   metadata records the upscale source, so once an
   upscaled version exists the button is removed.
   Clicking runs the existing chat pipeline; the
   user is asked what to generate when a prompt is
   needed, and nothing runs silently.
   ============================================ */

const AssetActions = (() => {
    const CACHE_MS = 4000;
    let metaCache = null;
    let metaFetchedAt = 0;

    // Assets with an upscale in flight (optimistic guard so a second click
    // cannot queue another upscale before the first finishes).
    const pendingUpscales = new Set();

    const ICONS = {
        upscale: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg>',
        modify: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>',
        video: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>',
        character: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'
    };

    function generatedMeta(force) {
        if (!force && metaCache && (Date.now() - metaFetchedAt) < CACHE_MS) {
            return Promise.resolve(metaCache);
        }
        return fetch('/api/generated')
            .then((res) => res.json())
            .then((data) => {
                metaCache = Array.isArray(data && data.images) ? data.images : [];
                metaFetchedAt = Date.now();
                return metaCache;
            })
            .catch(() => {
                metaCache = metaCache || [];
                metaFetchedAt = Date.now();
                return metaCache;
            });
    }

    function invalidate() {
        metaCache = null;
    }

    function baseName(url) {
        let value = String(url || '').split('?')[0];
        try { value = decodeURIComponent(value); } catch (err) { /* keep raw */ }
        const idx = value.lastIndexOf('/');
        return idx === -1 ? value : value.slice(idx + 1);
    }

    function isGeneratedSrc(url) {
        return String(url || '').indexOf('/generated/') !== -1;
    }

    function isImageName(name) {
        return /\.(?:png|jpe?g|webp)$/i.test(name);
    }

    function isVideoName(name) {
        return /\.(?:mp4|webm|mov|avi)$/i.test(name);
    }

    function refUrl(filename) {
        return '/generated/' + encodeURIComponent(filename);
    }

    // Metadata records the upscale relationship: the upscaled entry carries
    // `upscale.source` (the original file). An asset is already upscaled when
    // it is the original of such an entry OR is itself an upscaled output.
    function upscaledSets(meta) {
        const sources = new Set();
        const outputs = new Set();
        (meta || []).forEach((entry) => {
            if (!entry || !entry.upscale) return;
            outputs.add(baseName(entry.file));
            if (entry.upscale.source) sources.add(baseName(entry.upscale.source));
        });
        return { sources, outputs };
    }

    function send(text, extra) {
        if (typeof Chat === 'undefined' || !Chat || typeof Chat.sendMessage !== 'function') return false;
        Chat.sendMessage(Object.assign({ text }, extra || {}));
        return true;
    }

    const UPSCALE = {
        id: 'upscale',
        title: 'Upscale',
        run(filename, kind) {
            if (pendingUpscales.has(filename)) return;
            pendingUpscales.add(filename);
            hideUpscaleFor(filename);
            send(kind === 'video' ? 'Upscale this video' : 'Upscale this image', {
                upscaleSource: filename
            });
        }
    };

    const MODIFY = {
        id: 'modify',
        title: 'Modify',
        run(filename) {
            if (typeof Dialog === 'undefined' || !Dialog || typeof Dialog.prompt !== 'function') return;
            Dialog.prompt({
                title: 'Modify image',
                message: 'Describe the change you want to make to this image.',
                placeholder: 'e.g. make the sky a dramatic sunset',
                confirmText: 'Modify'
            }).then((change) => {
                const text = String(change || '').trim();
                if (!text) return;
                send(text, { references: [{ filename, url: refUrl(filename) }] });
            });
        }
    };

    const VIDEO = {
        id: 'video',
        title: 'Generate Video',
        run(filename) {
            if (typeof Dialog === 'undefined' || !Dialog || typeof Dialog.prompt !== 'function') return;
            Dialog.prompt({
                title: 'Generate video',
                message: 'What should happen in the video made from this image?',
                placeholder: 'e.g. she turns and smiles at the camera',
                confirmText: 'Generate video'
            }).then((description) => {
                const text = String(description || '').trim();
                if (!text) return;
                send('Generate a video from this image: ' + text, {
                    references: [{ filename, url: refUrl(filename) }]
                });
            });
        }
    };

    // Promote a generated image into a saved character: the image becomes the
    // approved base portrait, the person's face is captured as structured
    // identity, and the consolidated identity sheet is generated in one turn.
    const CHARACTER = {
        id: 'character',
        title: 'Create Character',
        run(filename) {
            if (typeof Dialog === 'undefined' || !Dialog || typeof Dialog.prompt !== 'function') return;
            Dialog.prompt({
                title: 'Create Character',
                message: 'Name this character. Its identity sheet is generated from this image and the person in it.',
                placeholder: 'e.g. Maya',
                confirmText: 'Create Character'
            }).then((name) => {
                const clean = String(name === null || name === undefined ? '' : name).trim();
                if (!clean) return;
                send('Create a character from this image', {
                    playgroundAction: { type: 'character_from_image', filename, name: clean }
                });
            });
        }
    };

    function makeButton(action, filename, kind) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-suggestion asset-action';
        btn.setAttribute('data-asset-action', action.id);
        const icon = document.createElement('span');
        icon.className = 'chat-suggestion-icon';
        icon.innerHTML = ICONS[action.id] || '';
        const label = document.createElement('span');
        label.className = 'chat-suggestion-label';
        label.textContent = action.title;
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', () => action.run(filename, kind));
        return btn;
    }

    function collect(contentEl) {
        const items = [];
        contentEl.querySelectorAll('img.md-image').forEach((img) => {
            const src = img.getAttribute('src') || '';
            if (!isGeneratedSrc(src)) return;
            const filename = baseName(src);
            if (!isImageName(filename)) return;
            items.push({ anchor: img.closest('p') || img, filename, kind: 'image' });
        });
        contentEl.querySelectorAll('video').forEach((video) => {
            const src = video.getAttribute('src') || video.currentSrc || '';
            if (!isGeneratedSrc(src)) return;
            const filename = baseName(src);
            if (!isVideoName(filename)) return;
            items.push({
                anchor: video.closest('.jv-player') || video.closest('p') || video,
                filename,
                kind: 'video'
            });
        });
        return items;
    }

    // Attach the action row beneath each generated asset in a message. When the
    // message is a companion photo, the companion's own action row already
    // offers "Turn into video", so the generic video action is omitted.
    function attach(contentEl, options) {
        if (!contentEl) return;
        const companion = Boolean(options && options.companion);
        collect(contentEl).forEach((item) => {
            const actions = item.kind === 'video'
                ? [UPSCALE]
                : (companion ? [UPSCALE, MODIFY, CHARACTER] : [UPSCALE, MODIFY, VIDEO, CHARACTER]);
            const row = document.createElement('div');
            row.className = 'chat-suggestion-row asset-action-row';
            row.setAttribute('data-asset', item.filename);
            actions.forEach((action) => row.appendChild(makeButton(action, item.filename, item.kind)));
            if (item.anchor && item.anchor.parentNode) {
                item.anchor.parentNode.insertBefore(row, item.anchor.nextSibling);
            } else {
                contentEl.appendChild(row);
            }
        });
        generatedMeta().then((meta) => applyUpscaleState(contentEl, meta));
    }

    // Remove the upscale action for one filename across every rendered message.
    function hideUpscaleFor(filename) {
        document.querySelectorAll('.asset-action-row').forEach((row) => {
            if (row.getAttribute('data-asset') !== filename) return;
            const upscaleBtn = row.querySelector('[data-asset-action="upscale"]');
            if (upscaleBtn) upscaleBtn.remove();
            if (!row.children.length) row.remove();
        });
    }

    // Hide the upscale action for assets that already have an upscaled version
    // (or one currently in flight).
    function applyUpscaleState(contentEl, meta) {
        if (!contentEl) return;
        const { sources, outputs } = upscaledSets(meta);
        contentEl.querySelectorAll('.asset-action-row').forEach((row) => {
            const filename = row.getAttribute('data-asset');
            const upscaleBtn = row.querySelector('[data-asset-action="upscale"]');
            if (upscaleBtn && filename &&
                (outputs.has(filename) || sources.has(filename) || pendingUpscales.has(filename))) {
                upscaleBtn.remove();
            }
            if (!row.children.length) row.remove();
        });
    }

    // Re-check every rendered message after a generation/upscale so an asset's
    // upscale action disappears as soon as its upscaled version exists. The
    // pending set is cleared: the fresh metadata is now the source of truth, so
    // a failed upscale makes the action available again.
    function refresh() {
        metaCache = null;
        pendingUpscales.clear();
        return generatedMeta(true).then((meta) => {
            document.querySelectorAll('.message-content').forEach((el) => applyUpscaleState(el, meta));
        });
    }

    return { ICONS, attach, applyUpscaleState, refresh, invalidate, upscaledSets };
})();

window.AssetActions = AssetActions;
