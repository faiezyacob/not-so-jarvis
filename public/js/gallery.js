/* ============================================
   JARVIS — Generated Image Gallery
   Compact widget in the system monitor that shows
   the latest generated Krea2 images, plus a "View
   All" overlay gallery and a preview lightbox.
   Image metadata comes from /api/generated.
   ============================================ */

(function (window, document) {
    'use strict';

    const Gallery = {};

    // Decorate records with a "url" for easy <img> use ("file" is the raw
    // metadata field from the backend).
    function withUrl(meta) {
        return Object.assign({}, meta, { url: meta.file });
    }

    function isVideo(meta) {
        return /\.(mp4|webm|mov)$/i.test(meta.file || '');
    }

    // --- Fetching ---

    async function fetchImages() {
        const res = await fetch('/api/generated');
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        return (data.images || []).map(withUrl);
    }

    // --- Widget rendering (system monitor) ---

    const widgetEl = document.getElementById('generatedWidget');
    let widgetImages = [];

    function renderWidget() {
        if (!widgetEl) return;
        const gridEl = widgetEl.querySelector('.generated-grid');
        const infoEl = widgetEl.querySelector('.generated-info');
        const emptyEl = widgetEl.querySelector('.generated-empty');

        gridEl.innerHTML = '';
        if (!widgetImages.length) {
            infoEl.textContent = '0 images';
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        const children = upscaleChildMap(widgetImages);
        let count = 0;
        for (const img of widgetImages) {
            if (count >= 6) break;
            // An upscaled output replaces its original in the grid — hide the
            // original tile and show the upscaled output with a compare badge.
            if (!img.upscale && children.has(lastSegment(img.file))) continue;

            const cell = document.createElement('div');
            cell.className = 'generated-thumb';
            cell.title = img.prompt || img.id;
            cell.setAttribute('role', 'button');
            cell.tabIndex = 0;
            cell.addEventListener('click', () => openPreview(img));
            cell.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(img); }
            });
            if (isVideo(img)) {
                cell.classList.add('generated-thumb--video');
                const vid = document.createElement('video');
                vid.src = img.url;
                vid.preload = 'metadata';
                vid.muted = true;
                vid.playsInline = true;
                vid.addEventListener('error', () => {
                    cell.classList.add('generated-thumb--broken');
                    cell.textContent = 'VID';
                });
                cell.appendChild(vid);
            } else {
                const thumb = document.createElement('img');
                thumb.src = img.url;
                thumb.alt = img.prompt || 'Generated image';
                thumb.loading = 'lazy';
                thumb.addEventListener('error', () => {
                    cell.classList.add('generated-thumb--broken');
                    cell.textContent = 'IMG';
                });
                cell.appendChild(thumb);
            }
            if (!isVideo(img) && img.upscale && img.upscale.source) cell.appendChild(makeCompareBadge('generated-compare-badge'));
            cell.appendChild(makeDeleteButton(img, cell));
            gridEl.appendChild(cell);
            count += 1;
        }

        const imgCount = widgetImages.filter((i) => !isVideo(i)).length;
        const vidCount = widgetImages.filter(isVideo).length;
        const parts = [];
        if (imgCount) parts.push(imgCount + ' image' + (imgCount === 1 ? '' : 's'));
        if (vidCount) parts.push(vidCount + ' video' + (vidCount === 1 ? '' : 's'));
        infoEl.textContent = (parts.join(' · ') || '0 items') + ' · ' + todayLabel(widgetImages);
    }

    function todayLabel(images) {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const todayCount = images.filter((img) => {
            const t = Date.parse(img.createdAt);
            return !isNaN(t) && t >= startOfToday;
        }).length;
        return todayCount > 0 ? 'Today' : 'Recent';
    }

    async function refreshWidget() {
        try {
            widgetImages = await fetchImages();
        } catch (err) {
            widgetImages = [];
        }
        renderWidget();
    }

    // --- Modal helpers ---

    function openModal(container, onClose) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay gallery-overlay open';
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        const close = () => {
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
            if (onClose) onClose();
        };
        const onKeyDown = (e) => {
            if (e.key !== 'Escape') return;
            const openOverlays = document.querySelectorAll('.modal-overlay.open');
            if (openOverlays.length && openOverlays[openOverlays.length - 1] !== overlay) return;
            close();
        };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', onKeyDown);
        return { overlay, close };
    }

    function buildModalShell(title) {
        const container = document.createElement('div');
        container.className = 'modal gallery-modal';

        const header = document.createElement('div');
        header.className = 'modal-header gallery-modal-header';
        const h = document.createElement('div');
        h.className = 'modal-title';
        h.textContent = title;
        header.appendChild(h);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'model-library-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'modal-body gallery-modal-body';

        container.appendChild(header);
        container.appendChild(body);
        return { container, body, closeBtn, close: () => closeBtn.click() };
    }

    // --- Preview lightbox ---

    function lastSegment(src) {
        const decoded = decodeURIComponent(String(src || ''));
        const idx = decoded.lastIndexOf('/');
        return idx === -1 ? decoded : decoded.slice(idx + 1);
    }

    // Map original filename → the upscaled entry that references it (entries
    // recorded with an "upscale.source" field pointing at the original file).
    // Used to hide the original tile so the grid only shows the upscaled
    // output. Videos included here too so legacy video pairs also collapse to
    // just the upscaled video (compare UI itself stays image-only below).
    function upscaleChildMap(images) {
        const map = new Map();
        images.forEach((img) => {
            if (img.upscale && img.upscale.source) {
                map.set(lastSegment(img.upscale.source), img);
            }
        });
        return map;
    }

    // Resolve the { original, upscaled } URLs for a gallery entry: either the
    // entry IS the upscaled one (has .upscale.source) or it has an upscaled
    // child in the list. Returns null when no pairing exists. Videos never
    // compare — upscales replace the original file instead.
    function compareTargetFor(img, images) {
        if (isVideo(img)) return null;
        if (img.upscale && img.upscale.source) {
            const originalMeta = (images || []).find((x) =>
                lastSegment(x.file) === lastSegment(img.upscale.source)) || null;
            return {
                original: '/generated/' + encodeURIComponent(lastSegment(img.upscale.source)),
                upscaled: img.url,
                originalMeta: originalMeta,
                upscaledMeta: img
            };
        }
        const child = (images || []).find((x) =>
            !isVideo(x) && x.upscale && x.upscale.source && lastSegment(x.upscale.source) === lastSegment(img.url));
        if (child) {
            return { original: img.url, upscaled: child.url, originalMeta: img, upscaledMeta: child };
        }
        return null;
    }

    // Badge shown on tiles that have an upscaled version.
    function makeCompareBadge(className) {
        const badge = document.createElement('span');
        badge.className = className;
        badge.textContent = '\u21c4';
        badge.title = 'Has an upscaled version \u2014 compare in preview';
        return badge;
    }

    // Open the same preview lightbox for an image referenced by URL (e.g. a
    // markdown image in chat). Resolves the file to its history metadata so
    // the widget-style preview (prompt, copy, delete) is shown; falls back to
    // a raw image-only preview when no metadata exists.
    async function findMetaByUrl(src) {
        try {
            const res = await fetch('/api/generated');
            if (!res.ok) return null;
            const data = await res.json();
            const fileName = lastSegment(src);
            const images = (data.images || []).map(withUrl);
            return images.find((img) => lastSegment(img.file) === fileName) || null;
        } catch (err) {
            return null;
        }
    }

    function openFromUrl(src) {
        findMetaByUrl(src).then((meta) => {
            if (meta) {
                openPreview(meta);
            } else {
                openRawPreview(src);
            }
        });
    }

    function openRawPreview(src) {
        const video = /\.(mp4|webm|mov)$/i.test(src);
        const { container, body, closeBtn } = buildModalShell(video ? 'GENERATED VIDEO' : 'GENERATED IMAGE');
        const modal = openModal(container);

        const imgWrap = document.createElement('div');
        imgWrap.className = 'gallery-preview-image';
        if (video) {
            const vidEl = document.createElement('video');
            vidEl.src = src;
            vidEl.preload = 'metadata';
            vidEl.playsInline = true;
            vidEl.addEventListener('error', () => {
                imgWrap.classList.add('gallery-preview-broken');
                imgWrap.textContent = 'Video file is missing.';
            });
            imgWrap.appendChild(vidEl);
        } else {
            const imgEl = document.createElement('img');
            imgEl.src = src;
            imgEl.alt = 'Generated image';
            imgEl.addEventListener('error', () => {
                imgWrap.classList.add('gallery-preview-broken');
                imgWrap.textContent = 'Image file is missing.';
            });
            imgWrap.appendChild(imgEl);
        }
        body.appendChild(imgWrap);

        if (window.VideoPlayer && typeof window.VideoPlayer.scan === 'function') {
            window.VideoPlayer.scan(imgWrap);
        }

        if (video) {
            const vidEl = imgWrap.querySelector('video');
            if (vidEl) {
                vidEl.addEventListener('loadedmetadata', () => {
                    const w = Number(vidEl.videoWidth) || 0;
                    const h = Number(vidEl.videoHeight) || 0;
                    if (!(w > 0 && h > 0)) return;
                    let dimsEl = body.querySelector('[data-raw-dims]');
                    if (!dimsEl) {
                        dimsEl = document.createElement('div');
                        dimsEl.className = 'gallery-preview-meta';
                        dimsEl.innerHTML =
                            '<div class="gallery-preview-row"><span class="gallery-preview-label">Resolution</span>' +
                            '<span class="gallery-preview-value" data-raw-dims></span></div>';
                        body.insertBefore(dimsEl, body.querySelector('.modal-footer'));
                        dimsEl = dimsEl.querySelector('[data-raw-dims]');
                    }
                    dimsEl.textContent = w + ' × ' + h;
                });
            }
        }

        const zoomApi = video ? null : attachInlineZoom(imgWrap, imgWrap.querySelector('img'));

        function close() {
            document.removeEventListener('keydown', onPreviewKey);
            modal.close();
        }

        const onPreviewKey = (e) => {
            const openOverlays = document.querySelectorAll('.modal-overlay.open');
            if (openOverlays.length && openOverlays[openOverlays.length - 1] !== modal.overlay) return;
            if (zoomApi) {
                if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomApi.setZoom(zoomApi.scale * 1.25); }
                else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomApi.setZoom(zoomApi.scale / 1.25); }
                else if (e.key === '0') { e.preventDefault(); zoomApi.reset(); }
            }
        };
        document.addEventListener('keydown', onPreviewKey);

        const footer = document.createElement('div');
        footer.className = 'modal-footer';

        if (src) {
            const downloadLink = document.createElement('a');
            downloadLink.className = 'modal-btn';
            downloadLink.textContent = video ? 'Download Video' : 'Download Image';
            downloadLink.title = 'Save this file to your downloads';
            downloadLink.href = src;
            const downloadName = lastSegment(src);
            if (downloadName) downloadLink.setAttribute('download', downloadName);
            footer.appendChild(downloadLink);
        }

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-btn modal-btn-cancel';
        closeButton.textContent = 'Close';
        closeButton.addEventListener('click', close);
        footer.appendChild(closeButton);

        body.appendChild(footer);
        closeBtn.addEventListener('click', close);
    }

    // --- Inline preview zoom (Mix Studio lightbox style) ---
    //
    // The preview image supports wheel zoom immediately on open — no button
    // required. Zoom is anchored at the cursor (scale 1 = fit), and once
    // zoomed in the image can be dragged (or trackpad-scrolled) to pan. A
    // small pill in the corner shows the current scale.

    function attachInlineZoom(wrap, imgEl) {
        const pct = document.createElement('span');
        pct.className = 'gallery-zoom-pill';
        pct.textContent = '100%';
        wrap.appendChild(pct);

        const state = { active: false, scale: 1, x: 50, y: 50, panX: 0, panY: 0 };
        const ZOOM_MIN = 1;
        const ZOOM_MAX = 4;
        let panPointer = null;
        let wheelGesture = null;
        let wheelTimer = 0;

        // The visible ("object-fit: contain") rect of the image inside the wrap,
        // used to anchor zoom origins and clamp panning to the content.
        function containedContent() {
            const rect = wrap.getBoundingClientRect();
            const width = Math.max(0, rect.width || 0);
            const height = Math.max(0, rect.height || 0);
            const naturalWidth = Number(imgEl.naturalWidth) || width || 1;
            const naturalHeight = Number(imgEl.naturalHeight) || height || 1;
            const fit = Math.min(width / naturalWidth, height / naturalHeight);
            const contentWidth = naturalWidth * fit;
            const contentHeight = naturalHeight * fit;
            return {
                width, height,
                left: (width - contentWidth) / 2,
                top: (height - contentHeight) / 2,
                contentWidth, contentHeight
            };
        }

        function render() {
            wrap.classList.toggle('gallery-preview-zoomed', state.active);
            imgEl.style.setProperty('--zoom-x', state.x + '%');
            imgEl.style.setProperty('--zoom-y', state.y + '%');
            imgEl.style.setProperty('--zoom-scale', String(state.scale));
            imgEl.style.setProperty('--zoom-pan-x', state.panX + 'px');
            imgEl.style.setProperty('--zoom-pan-y', state.panY + 'px');
            pct.textContent = Math.round(state.scale * 100) + '%';
            pct.classList.toggle('gallery-zoom-pill--active', state.active);
        }

        function panBounds() {
            const c = containedContent();
            const scale = state.scale;
            const originX = (state.x / 100) * c.width;
            const originY = (state.y / 100) * c.height;
            const left = originX + (c.left - originX) * scale;
            const right = originX + (c.left + c.contentWidth - originX) * scale;
            const top = originY + (c.top - originY) * scale;
            const bottom = originY + (c.top + c.contentHeight - originY) * scale;
            const horizontal = c.contentWidth * scale <= c.width
                ? [c.width / 2 - (left + right) / 2, c.width / 2 - (left + right) / 2]
                : [c.width - right, -left];
            const vertical = c.contentHeight * scale <= c.height
                ? [c.height / 2 - (top + bottom) / 2, c.height / 2 - (top + bottom) / 2]
                : [c.height - bottom, -top];
            return { minX: horizontal[0], maxX: horizontal[1], minY: vertical[0], maxY: vertical[1] };
        }

        function setPan(x, y) {
            if (!state.active) {
                state.panX = 0;
                state.panY = 0;
                render();
                return false;
            }
            const b = panBounds();
            state.panX = Math.round(Math.max(b.minX, Math.min(b.maxX, Number(x) || 0)) * 100) / 100;
            state.panY = Math.round(Math.max(b.minY, Math.min(b.maxY, Number(y) || 0)) * 100) / 100;
            render();
            return true;
        }

        function setZoom(scale, clientX, clientY) {
            const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(scale) || ZOOM_MIN));
            const snapped = next < 1.015 ? 1 : Math.round(next * 1000) / 1000;
            if (snapped > 1 && state.scale <= 1) {
                // First zoom-in anchors the origin at the pointer.
                const rect = wrap.getBoundingClientRect();
                const c = containedContent();
                const localX = Number.isFinite(clientX)
                    ? Math.max(c.left, Math.min(c.left + c.contentWidth, clientX - rect.left))
                    : c.width / 2;
                const localY = Number.isFinite(clientY)
                    ? Math.max(c.top, Math.min(c.top + c.contentHeight, clientY - rect.top))
                    : c.height / 2;
                state.x = c.width ? (localX / c.width) * 100 : 50;
                state.y = c.height ? (localY / c.height) * 100 : 50;
                state.panX = 0;
                state.panY = 0;
            }
            state.scale = snapped;
            state.active = snapped > 1;
            if (!state.active) {
                state.x = 50;
                state.y = 50;
                state.panX = 0;
                state.panY = 0;
            } else {
                const b = panBounds();
                state.panX = Math.max(b.minX, Math.min(b.maxX, state.panX));
                state.panY = Math.max(b.minY, Math.min(b.maxY, state.panY));
            }
            render();
            return state.active;
        }

        function adjustZoom(deltaY, clientX, clientY, deltaMode) {
            const rawDelta = Number(deltaY);
            if (!Number.isFinite(rawDelta) || rawDelta === 0) return state.active;
            const pixels = rawDelta * (deltaMode === 1 ? 16 : (deltaMode === 2 ? Math.max(1, wrap.clientHeight) : 1));
            const bounded = Math.max(-160, Math.min(160, pixels));
            return setZoom(state.scale * Math.exp(-bounded * 0.002), clientX, clientY);
        }

        function wheelMode(event) {
            const now = performance.now();
            if (event.ctrlKey || (state.active && event.shiftKey)) {
                wheelGesture = { mode: event.ctrlKey ? 'zoom' : 'pan', at: now };
                return wheelGesture.mode;
            }
            if (wheelGesture && now - wheelGesture.at < 180) {
                wheelGesture.at = now;
                return wheelGesture.mode;
            }
            const deltaX = Math.abs(Number(event.deltaX) || 0);
            const deltaY = Math.abs(Number(event.deltaY) || 0);
            const trackpadLike = event.deltaMode === 0 && Math.max(deltaX, deltaY) < 50;
            wheelGesture = { mode: state.active && (deltaX > 0 || trackpadLike) ? 'pan' : 'zoom', at: now };
            return wheelGesture.mode;
        }

        wrap.addEventListener('wheel', (event) => {
            const mode = wheelMode(event);
            if (mode === 'zoom' && !event.deltaY) return;
            event.preventDefault();
            if (mode === 'pan') {
                const horizontal = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
                const vertical = event.shiftKey ? 0 : event.deltaY;
                setPan(state.panX - horizontal, state.panY - vertical);
                wrap.classList.add('gallery-preview-wheel-panning');
                clearTimeout(wheelTimer);
                wheelTimer = setTimeout(() => wrap.classList.remove('gallery-preview-wheel-panning'), 120);
                return;
            }
            adjustZoom(event.deltaY, event.clientX, event.clientY, event.deltaMode);
        }, { passive: false });

        // Drag to pan once zoomed in (mouse or touch).
        wrap.addEventListener('pointerdown', (event) => {
            if (!state.active || !event.isPrimary || (event.button !== undefined && event.button !== 0)) return;
            panPointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, panX: state.panX, panY: state.panY, moved: false };
            try { wrap.setPointerCapture(event.pointerId); } catch (err) {}
        });
        wrap.addEventListener('pointermove', (event) => {
            const pan = panPointer;
            if (!pan || pan.id !== event.pointerId) return;
            const deltaX = event.clientX - pan.startX;
            const deltaY = event.clientY - pan.startY;
            if (!pan.moved && Math.hypot(deltaX, deltaY) < 5) return;
            if (!pan.moved) {
                pan.moved = true;
                wrap.classList.add('gallery-preview-panning');
            }
            event.preventDefault();
            setPan(pan.panX + deltaX, pan.panY + deltaY);
        });
        function endPan(event) {
            const pan = panPointer;
            if (!pan || (event && event.pointerId != null && pan.id !== event.pointerId)) return;
            panPointer = null;
            wrap.classList.remove('gallery-preview-panning');
            try { if (wrap.hasPointerCapture(pan.id)) wrap.releasePointerCapture(pan.id); } catch (err) {}
        }
        wrap.addEventListener('pointerup', endPan);
        wrap.addEventListener('pointercancel', endPan);

        wrap.addEventListener('dblclick', (event) => {
            event.preventDefault();
            setZoom(state.scale > 1.15 ? 1 : 2, event.clientX, event.clientY);
        });

        function resetZoom() { setZoom(1); }

        return { setZoom, reset: resetZoom, get scale() { return state.scale; } };
    }

    function formatResolution(img) {
        if (img.width && img.height) return img.width + ' × ' + img.height;
        return '—';
    }

    // "before → after" label for an upscaled video. The source entry is
    // deleted on upscale, so the before-size comes from the stored upscale
    // metadata; the after-size prefers the recorded dimensions and falls back
    // to probedDims (the live video element's intrinsic size).
    function videoUpscaleLabel(img, probedDims) {
        const up = (img && img.upscale) || {};
        const base = (up.sourceWidth && up.sourceHeight)
            ? up.sourceWidth + ' × ' + up.sourceHeight
            : (up.source ? lastSegment(up.source) : null);
        const after = (img.width && img.height)
            ? img.width + ' × ' + img.height
            : (probedDims && probedDims.width && probedDims.height
                ? probedDims.width + ' × ' + probedDims.height
                : null);
        if (base && after) return base + ' → ' + after;
        if (after) return '→ ' + after;
        if (base) return base + ' → …';
        return '—';
    }

    // --- Before/after compare lightbox ---
    //
    // Mirrors Mix Studio's detail-comparison viewer: the original fills the
    // stage and the upscaled version is clipped inside a mask revealed by the
    // divider. "Reveal" mode drags the divider, "Move" mode pans when zoomed.
    // Wheel / pinch / keyboard zoom is cursor-anchored and works immediately
    // at 100% fit — no zoom button required.

    function openCompare(pair) {
        const original = pair.original;
        const upscaled = pair.upscaled;
        const sameSource = lastSegment(original) === lastSegment(upscaled);

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay gallery-overlay compare-overlay open';

        const shell = document.createElement('div');
        shell.className = 'compare-shell';

        // Header
        const header = document.createElement('div');
        header.className = 'compare-header';
        const heading = document.createElement('div');
        heading.className = 'compare-heading';
        const title = document.createElement('div');
        title.className = 'compare-title';
        title.textContent = 'DETAIL COMPARISON';
        const dims = document.createElement('div');
        dims.className = 'compare-dims';
        dims.textContent = 'Original \u2194 Upscaled';
        heading.appendChild(title);
        heading.appendChild(dims);
        header.appendChild(heading);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'compare-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        header.appendChild(closeBtn);
        shell.appendChild(header);

        // Stage: both images stack full-stage; the upscaled sits inside a
        // clipped mask, and only the images transform (never the mask), so the
        // divider stays aligned at any zoom level.
        const stage = document.createElement('div');
        stage.className = 'compare-stage';
        stage.setAttribute('role', 'application');
        stage.setAttribute('aria-label', 'Compare original and upscaled image');
        stage.tabIndex = 0;

        const imgOriginal = document.createElement('img');
        imgOriginal.className = 'compare-img';
        imgOriginal.src = original;
        imgOriginal.alt = 'Original';
        imgOriginal.draggable = false;

        const mask = document.createElement('div');
        mask.className = 'compare-mask';
        const imgUpscaled = document.createElement('img');
        imgUpscaled.className = 'compare-img';
        imgUpscaled.src = upscaled;
        imgUpscaled.alt = 'Upscaled';
        imgUpscaled.draggable = false;
        mask.appendChild(imgUpscaled);

        const divider = document.createElement('div');
        divider.className = 'compare-divider';
        divider.innerHTML =
            '<span class="compare-handle">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M15 18l-6-6 6-6"></path><path d="M13 18l-6-6 6-6"></path></svg>' +
            '</span>';

        stage.appendChild(imgOriginal);
        stage.appendChild(mask);
        stage.appendChild(divider);

        const tagOriginal = document.createElement('span');
        tagOriginal.className = 'compare-tag compare-tag--a';
        tagOriginal.textContent = 'Original';
        const tagUpscaled = document.createElement('span');
        tagUpscaled.className = 'compare-tag compare-tag--b';
        tagUpscaled.textContent = 'Upscaled';

        stage.appendChild(tagOriginal);
        stage.appendChild(tagUpscaled);

        if (sameSource) {
            const notice = document.createElement('div');
            notice.className = 'compare-stage-missing';
            notice.textContent = 'Both sides are the same file \u2014 the upscaled output was not found.';
            stage.appendChild(notice);
        }
        shell.appendChild(stage);

        // Console: Reveal/Move modes + zoom controls + hint/reveal readout.
        const consoleEl = document.createElement('div');
        consoleEl.className = 'compare-console';

        const consoleRow = document.createElement('div');
        consoleRow.className = 'compare-console-row';

        const modeGroup = document.createElement('div');
        modeGroup.className = 'compare-mode';
        const revealModeBtn = document.createElement('button');
        revealModeBtn.type = 'button';
        revealModeBtn.className = 'active';
        revealModeBtn.setAttribute('aria-pressed', 'true');
        revealModeBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
            '<path d="M4 5h7v14H4z"></path><path d="M13 5h7v14h-7z"></path></svg>' +
            '<span>Reveal</span>';
        const moveModeBtn = document.createElement('button');
        moveModeBtn.type = 'button';
        moveModeBtn.setAttribute('aria-pressed', 'false');
        moveModeBtn.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M9 3l-6 6h4v6H3l6 6 6-6h-4V9h4z"></path></svg>' +
            '<span>Move</span>';
        modeGroup.appendChild(revealModeBtn);
        modeGroup.appendChild(moveModeBtn);

        const zoomGroup = document.createElement('div');
        zoomGroup.className = 'compare-zoom';
        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.type = 'button';
        zoomOutBtn.textContent = '\u2212';
        zoomOutBtn.setAttribute('aria-label', 'Zoom out');
        const zoomValue = document.createElement('output');
        zoomValue.textContent = '100%';
        const zoomInBtn = document.createElement('button');
        zoomInBtn.type = 'button';
        zoomInBtn.textContent = '+';
        zoomInBtn.setAttribute('aria-label', 'Zoom in');
        const fitBtn = document.createElement('button');
        fitBtn.type = 'button';
        fitBtn.className = 'compare-text-btn';
        fitBtn.textContent = 'Fit';
        const actualBtn = document.createElement('button');
        actualBtn.type = 'button';
        actualBtn.className = 'compare-text-btn';
        actualBtn.textContent = '1:1';
        zoomGroup.appendChild(zoomOutBtn);
        zoomGroup.appendChild(zoomValue);
        zoomGroup.appendChild(zoomInBtn);
        zoomGroup.appendChild(fitBtn);
        zoomGroup.appendChild(actualBtn);

        consoleRow.appendChild(modeGroup);
        consoleRow.appendChild(zoomGroup);

        const consoleMeta = document.createElement('div');
        consoleMeta.className = 'compare-console-meta';
        const hint = document.createElement('span');
        hint.className = 'compare-hint';
        hint.textContent = 'Drag the divider \u00b7 scroll to zoom';
        const revealValue = document.createElement('span');
        revealValue.className = 'compare-reveal-value';
        revealValue.textContent = '50% reveal';
        consoleMeta.appendChild(hint);
        consoleMeta.appendChild(revealValue);

        consoleEl.appendChild(consoleRow);
        consoleEl.appendChild(consoleMeta);
        shell.appendChild(consoleEl);

        overlay.appendChild(shell);
        document.body.appendChild(overlay);

        const state = { split: 50, zoom: 1, x: 0, y: 0, mode: 'reveal' };
        const ZOOM_MIN = 1;
        const ZOOM_MAX = 6;

        // Fit scale: how the upscaled image's natural size maps onto the stage.
        function fitSize() {
            const rect = stage.getBoundingClientRect();
            const naturalWidth = imgUpscaled.naturalWidth || rect.width || 1;
            const naturalHeight = imgUpscaled.naturalHeight || rect.height || 1;
            const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
            return {
                stageWidth: rect.width,
                stageHeight: rect.height,
                width: naturalWidth * scale,
                height: naturalHeight * scale,
                naturalWidth,
                naturalHeight
            };
        }

        function clampPan() {
            const fit = fitSize();
            const maxX = Math.max(0, (fit.width * state.zoom - fit.stageWidth) / 2);
            const maxY = Math.max(0, (fit.height * state.zoom - fit.stageHeight) / 2);
            state.x = Math.max(-maxX, Math.min(maxX, state.x));
            state.y = Math.max(-maxY, Math.min(maxY, state.y));
        }

        function renderTransform() {
            clampPan();
            const transform = 'translate3d(' + state.x + 'px, ' + state.y + 'px, 0) scale(' + state.zoom + ')';
            imgOriginal.style.transform = transform;
            imgUpscaled.style.transform = transform;
            zoomValue.textContent = Math.round(state.zoom * 100) + '%';
            zoomOutBtn.disabled = state.zoom <= 1.001;
            zoomInBtn.disabled = state.zoom >= ZOOM_MAX - 0.001;
            stage.classList.toggle('compare-zoomed', state.zoom > 1.001);
        }

        function setSplit(pct) {
            state.split = Math.max(0, Math.min(100, pct));
            mask.style.clipPath = 'inset(0 0 0 ' + state.split + '%)';
            divider.style.left = state.split + '%';
            revealValue.textContent = Math.round(state.split) + '% reveal';
        }

        function setMode(mode) {
            state.mode = mode === 'pan' ? 'pan' : 'reveal';
            const reveal = state.mode === 'reveal';
            revealModeBtn.classList.toggle('active', reveal);
            moveModeBtn.classList.toggle('active', !reveal);
            revealModeBtn.setAttribute('aria-pressed', String(reveal));
            moveModeBtn.setAttribute('aria-pressed', String(!reveal));
            stage.classList.toggle('mode-pan', !reveal);
            hint.textContent = reveal
                ? 'Drag the divider \u00b7 pinch or scroll to zoom'
                : (state.zoom > 1 ? 'Drag to inspect \u00b7 pinch or scroll to zoom' : 'Zoom in, then drag to inspect details');
        }

        function setZoom(value, clientX, clientY) {
            const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(value) || ZOOM_MIN));
            const previous = state.zoom;
            if (Math.abs(next - previous) < 0.001) return;
            const rect = stage.getBoundingClientRect();
            const anchorX = Number.isFinite(clientX) ? clientX - rect.left - rect.width / 2 : 0;
            const anchorY = Number.isFinite(clientY) ? clientY - rect.top - rect.height / 2 : 0;
            const ratio = next / previous;
            state.x = anchorX - (anchorX - state.x) * ratio;
            state.y = anchorY - (anchorY - state.y) * ratio;
            state.zoom = next;
            renderTransform();
            setMode(state.mode);
        }

        function fitCompare() {
            state.zoom = 1;
            state.x = 0;
            state.y = 0;
            renderTransform();
            setMode(state.mode);
        }

        function actualSizeCompare() {
            const fit = fitSize();
            const pixelZoom = fit.width ? fit.naturalWidth / fit.width : 1;
            setZoom(Math.max(1, Math.min(ZOOM_MAX, pixelZoom)));
            if (state.zoom > 1) setMode('pan');
        }

        // --- Gestures: single-pointer divider/pan, two-pointer pinch ---

        const pointers = new Map();
        let gesture = null;
        let lastTouchTap = null;
        let ignoreDoubleClickUntil = 0;

        function pointerCenter(values) {
            return {
                x: values.reduce((sum, p) => sum + p.x, 0) / values.length,
                y: values.reduce((sum, p) => sum + p.y, 0) / values.length
            };
        }

        function pointerDistance(values) {
            return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
        }

        function beginSingle(point) {
            gesture = {
                kind: state.mode,
                startX: point.x,
                startY: point.y,
                panX: state.x,
                panY: state.y
            };
        }

        function beginPinch() {
            const values = Array.from(pointers.values()).slice(0, 2);
            const rect = stage.getBoundingClientRect();
            const center = pointerCenter(values);
            gesture = {
                kind: 'pinch',
                distance: Math.max(1, pointerDistance(values)),
                zoom: state.zoom,
                panX: state.x,
                panY: state.y,
                anchorX: center.x - rect.left - rect.width / 2,
                anchorY: center.y - rect.top - rect.height / 2
            };
        }

        stage.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            try { stage.setPointerCapture(event.pointerId); } catch (err) {}
            pointers.set(event.pointerId, {
                x: event.clientX, y: event.clientY,
                downX: event.clientX, downY: event.clientY,
                at: performance.now(), type: event.pointerType
            });
            stage.classList.add('interacting');
            if (pointers.size === 1) {
                beginSingle(Array.from(pointers.values())[0]);
                if (state.mode === 'reveal') {
                    const rect = stage.getBoundingClientRect();
                    setSplit(((event.clientX - rect.left) / rect.width) * 100);
                }
            } else if (pointers.size === 2) {
                beginPinch();
            }
        });

        stage.addEventListener('pointermove', (event) => {
            if (!pointers.has(event.pointerId)) return;
            event.preventDefault();
            const previous = pointers.get(event.pointerId);
            pointers.set(event.pointerId, Object.assign({}, previous, { x: event.clientX, y: event.clientY }));
            if (pointers.size >= 2 && gesture && gesture.kind === 'pinch') {
                const values = Array.from(pointers.values()).slice(0, 2);
                const center = pointerCenter(values);
                const rect = stage.getBoundingClientRect();
                const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, gesture.zoom * (pointerDistance(values) / gesture.distance)));
                const currentX = center.x - rect.left - rect.width / 2;
                const currentY = center.y - rect.top - rect.height / 2;
                const localX = (gesture.anchorX - gesture.panX) / gesture.zoom;
                const localY = (gesture.anchorY - gesture.panY) / gesture.zoom;
                state.zoom = nextZoom;
                state.x = currentX - localX * nextZoom;
                state.y = currentY - localY * nextZoom;
                renderTransform();
                return;
            }
            if (pointers.size !== 1 || !gesture) return;
            if (gesture.kind === 'pan') {
                state.x = gesture.panX + event.clientX - gesture.startX;
                state.y = gesture.panY + event.clientY - gesture.startY;
                renderTransform();
            } else {
                const rect = stage.getBoundingClientRect();
                setSplit(((event.clientX - rect.left) / rect.width) * 100);
            }
        });

        function endPointer(event) {
            const point = pointers.get(event.pointerId);
            pointers.delete(event.pointerId);
            if (point && point.type === 'touch' && performance.now() - point.at < 280
                && Math.hypot(event.clientX - point.downX, event.clientY - point.downY) < 10) {
                const now = performance.now();
                if (lastTouchTap && now - lastTouchTap.at < 330
                    && Math.hypot(event.clientX - lastTouchTap.x, event.clientY - lastTouchTap.y) < 28) {
                    setZoom(state.zoom > 1.15 ? 1 : 2, event.clientX, event.clientY);
                    ignoreDoubleClickUntil = now + 500;
                    lastTouchTap = null;
                } else {
                    lastTouchTap = { at: now, x: event.clientX, y: event.clientY };
                }
            }
            if (pointers.size === 1) beginSingle(Array.from(pointers.values())[0]);
            else if (!pointers.size) {
                gesture = null;
                stage.classList.remove('interacting');
            }
        }
        stage.addEventListener('pointerup', endPointer);
        stage.addEventListener('pointercancel', endPointer);

        stage.addEventListener('wheel', (event) => {
            event.preventDefault();
            setZoom(state.zoom * (event.deltaY < 0 ? 1.16 : 0.86), event.clientX, event.clientY);
        }, { passive: false });

        stage.addEventListener('dblclick', (event) => {
            event.preventDefault();
            if (performance.now() < ignoreDoubleClickUntil) return;
            setZoom(state.zoom > 1.15 ? 1 : 2, event.clientX, event.clientY);
        });

        function close() {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        }

        const onKey = (e) => {
            const openOverlays = document.querySelectorAll('.modal-overlay.open');
            if (openOverlays.length && openOverlays[openOverlays.length - 1] !== overlay) return;
            const key = e.key;
            if (key === 'Escape') { close(); return; }
            if (['+', '=', '-', '_', '0', '1', 'f', 'F', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(key) !== -1) e.preventDefault();
            if (key === '+' || key === '=') setZoom(state.zoom * 1.25);
            else if (key === '-' || key === '_') setZoom(state.zoom / 1.25);
            else if (key === '0' || key === 'f' || key === 'F') fitCompare();
            else if (key === '1') actualSizeCompare();
            else if (state.mode === 'reveal' && key === 'ArrowLeft') setSplit(state.split - 2);
            else if (state.mode === 'reveal' && key === 'ArrowRight') setSplit(state.split + 2);
            else if (state.mode === 'pan' && key.indexOf('Arrow') === 0) {
                if (key === 'ArrowLeft') state.x -= 28;
                else if (key === 'ArrowRight') state.x += 28;
                else if (key === 'ArrowUp') state.y -= 28;
                else if (key === 'ArrowDown') state.y += 28;
                renderTransform();
            }
        };
        document.addEventListener('keydown', onKey);

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        revealModeBtn.addEventListener('click', () => setMode('reveal'));
        moveModeBtn.addEventListener('click', () => setMode('pan'));
        zoomOutBtn.addEventListener('click', () => setZoom(state.zoom / 1.35));
        zoomInBtn.addEventListener('click', () => setZoom(state.zoom * 1.35));
        fitBtn.addEventListener('click', fitCompare);
        actualBtn.addEventListener('click', actualSizeCompare);

        // Fill in the real dimensions once both images are loaded.
        function updateDims() {
            if (imgOriginal.naturalWidth && imgUpscaled.naturalWidth) {
                dims.textContent =
                    imgOriginal.naturalWidth + ' \u00d7 ' + imgOriginal.naturalHeight +
                    ' \u2194 ' + imgUpscaled.naturalWidth + ' \u00d7 ' + imgUpscaled.naturalHeight;
            }
        }
        imgOriginal.addEventListener('load', updateDims);
        imgUpscaled.addEventListener('load', updateDims);

        // Name which side failed instead of silently showing the surviving
        // image on both halves (which reads as "the same image").
        function onStageError(side) {
            if (stage.querySelector('.compare-stage-missing')) return;
            const missing = document.createElement('div');
            missing.className = 'compare-stage-missing';
            missing.textContent = side + ' image file is missing.';
            stage.appendChild(missing);
        }
        imgOriginal.addEventListener('error', () => onStageError('Original'));
        imgUpscaled.addEventListener('error', () => onStageError('Upscaled'));

        setSplit(50);
        setMode('reveal');
        renderTransform();
    }

    function formatGenerationDuration(img) {
        const ms = Number(img.generationMs);
        if (!Number.isFinite(ms) || ms <= 0) return '—';
        const totalSeconds = Math.round(ms / 1000);
        if (totalSeconds < 60) return totalSeconds + 's';
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return minutes + 'm ' + seconds + 's';
    }

    function copyPrompt(img) {
        const prompt = img.prompt || '';
        if (!prompt) return false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(prompt);
            return true;
        }
        return false;
    }

    async function deleteImage(img) {
        const res = await fetch('/api/generated/' + encodeURIComponent(img.id), { method: 'DELETE' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Delete failed');
        }
    }

    // Find the linked partner for grouped delete (either side of an
    // original ↔ upscaled pair). Separate from compareTargetFor so videos —
    // which never show compare UI — still clean up their hidden original.
    function deletePartnerFor(img, images) {
        const list = images || [];
        if (img.upscale && img.upscale.source) {
            return list.find((x) =>
                x.id !== img.id && lastSegment(x.file) === lastSegment(img.upscale.source)) || null;
        }
        return list.find((x) =>
            x.id !== img.id && x.upscale && x.upscale.source &&
            lastSegment(x.upscale.source) === lastSegment(img.file)) || null;
    }

    // Build a delete button wired to img.id. On success it removes the image
    // from the in-memory widget list and re-renders the grid; the cell DOM
    // node is also removed when present (e.g. inside the View All overlay).
    function makeDeleteButton(img, cell) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gallery-delete-btn';
        btn.setAttribute('aria-label', 'Delete image');
        btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '<line x1="10" y1="11" x2="10" y2="17"></line>' +
            '<line x1="14" y1="11" x2="14" y2="17"></line></svg>';
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm('Delete this generated image permanently?')) return;
            btn.disabled = true;
            try {
                const partner = deletePartnerFor(img, widgetImages);
                const removedIds = [img.id];
                if (partner && partner.id !== img.id) {
                    await deleteImage(partner);
                    removedIds.push(partner.id);
                }
                await deleteImage(img);
                widgetImages = widgetImages.filter((w) => removedIds.indexOf(w.id) === -1);
                renderWidget();
                if (cell && cell.parentNode) cell.remove();
            } catch (err) {
                window.alert('Delete failed: ' + err.message);
                btn.disabled = false;
            }
        });
        return btn;
    }

    function openPreview(img) {
        const compare = compareTargetFor(img, widgetImages);
        const video = isVideo(img);

        const { container, body, closeBtn } = buildModalShell(video ? 'GENERATED VIDEO' : 'GENERATED IMAGE');
        const modal = openModal(container);

        const imgWrap = document.createElement('div');
        imgWrap.className = 'gallery-preview-image';
        if (video) {
            const vidEl = document.createElement('video');
            vidEl.src = img.url;
            vidEl.preload = 'metadata';
            vidEl.playsInline = true;
            vidEl.addEventListener('error', () => {
                imgWrap.classList.add('gallery-preview-broken');
                imgWrap.textContent = 'Video file is missing.';
            });
            imgWrap.appendChild(vidEl);
        } else {
            const imgEl = document.createElement('img');
            imgEl.src = img.url;
            imgEl.alt = img.prompt || 'Generated image';
            imgEl.addEventListener('error', () => {
                imgWrap.classList.add('gallery-preview-broken');
                imgWrap.textContent = 'Image file is missing.';
            });
            imgWrap.appendChild(imgEl);
        }
        body.appendChild(imgWrap);

        if (window.VideoPlayer && typeof window.VideoPlayer.scan === 'function') {
            window.VideoPlayer.scan(imgWrap);
        }

        const zoomApi = video ? null : attachInlineZoom(imgWrap, imgWrap.querySelector('img'));

        function close() {
            document.removeEventListener('keydown', onPreviewKey);
            modal.close();
        }

        const onPreviewKey = (e) => {
            const openOverlays = document.querySelectorAll('.modal-overlay.open');
            if (openOverlays.length && openOverlays[openOverlays.length - 1] !== modal.overlay) return;
            if (zoomApi) {
                if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomApi.setZoom(zoomApi.scale * 1.25); }
                else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomApi.setZoom(zoomApi.scale / 1.25); }
                else if (e.key === '0') { e.preventDefault(); zoomApi.reset(); }
            }
        };
        document.addEventListener('keydown', onPreviewKey);

        const meta = document.createElement('div');
        meta.className = 'gallery-preview-meta';
        meta.innerHTML =
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Model</span><span class="gallery-preview-value">' + escapeHtml(img.model || 'Krea2') + '</span></div>' +
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Resolution</span><span class="gallery-preview-value" data-resolution-value>' + escapeHtml(formatResolution(img)) + '</span></div>' +
            (img.seed !== undefined && img.seed !== null
                ? '<div class="gallery-preview-row"><span class="gallery-preview-label">Seed</span><span class="gallery-preview-value">' + escapeHtml(String(img.seed)) + '</span></div>'
                : '') +
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Duration</span><span class="gallery-preview-value">' + escapeHtml(formatGenerationDuration(img)) + '</span></div>';
        if (compare) {
            const originalMeta = img.upscale ? compare.originalMeta : img;
            const upscaledMeta = img.upscale ? img : compare.upscaledMeta;
            const baseDims = formatResolution(originalMeta);
            const otherDims = formatResolution(upscaledMeta);
            meta.innerHTML += '<div class="gallery-preview-row"><span class="gallery-preview-label">Upscale</span><span class="gallery-preview-value">' + escapeHtml(baseDims + ' \u2192 ' + otherDims) + '</span></div>';
        } else if (video && img.upscale) {
            // Video upscales replace the original file (no compare UI), so
            // show the before → after sizes from the stored upscale metadata
            // instead. The "after" side is filled in from the video element
            // itself once its metadata loads (covers entries recorded before
            // dimensions were stored).
            meta.innerHTML += '<div class="gallery-preview-row"><span class="gallery-preview-label">Upscale</span><span class="gallery-preview-value" data-upscale-value>' + escapeHtml(videoUpscaleLabel(img, null)) + '</span></div>';
        }
        body.appendChild(meta);

        if (video) {
            const vidEl = imgWrap.querySelector('video');
            const resolutionEl = meta.querySelector('[data-resolution-value]');
            const upscaleEl = meta.querySelector('[data-upscale-value]');
            if (vidEl && (resolutionEl || upscaleEl)) {
                vidEl.addEventListener('loadedmetadata', () => {
                    const w = Number(vidEl.videoWidth) || 0;
                    const h = Number(vidEl.videoHeight) || 0;
                    if (!(w > 0 && h > 0)) return;
                    if (resolutionEl && !img.width) resolutionEl.textContent = w + ' × ' + h;
                    if (upscaleEl) upscaleEl.textContent = videoUpscaleLabel(img, { width: w, height: h });
                });
            }
        }

        if (img.prompt) {
            const promptEl = document.createElement('div');
            promptEl.className = 'gallery-preview-prompt';
            promptEl.innerHTML = '<div class="gallery-preview-label">Prompt</div><div class="gallery-preview-prompt-text">' + escapeHtml(img.prompt) + '</div>';
            body.appendChild(promptEl);
        }

        const footer = document.createElement('div');
        footer.className = 'modal-footer';

        if (compare) {
            const compareBtn = document.createElement('button');
            compareBtn.type = 'button';
            compareBtn.className = 'modal-btn modal-btn-primary';
            compareBtn.textContent = '\u21c4 Compare';
            compareBtn.addEventListener('click', () => openCompare(compare));
            footer.appendChild(compareBtn);
        }

        if (img.prompt) {
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'modal-btn modal-btn-primary';
            copyBtn.textContent = 'Copy Prompt';
            copyBtn.addEventListener('click', () => {
                if (copyPrompt(img)) {
                    copyBtn.textContent = 'Copied!';
                    copyBtn.disabled = true;
                    setTimeout(() => { copyBtn.textContent = 'Copy Prompt'; copyBtn.disabled = false; }, 1500);
                }
            });
            footer.appendChild(copyBtn);
        }

        // Reproducibility actions: lock this image's seed.
        if (!video && img.seed !== undefined && img.seed !== null) {
            const seedBtn = document.createElement('button');
            seedBtn.type = 'button';
            seedBtn.className = 'modal-btn';
            seedBtn.textContent = 'Use Seed';
            seedBtn.title = 'Lock this seed for the next generation';
            seedBtn.addEventListener('click', async () => {
                try {
                    const res = await fetch('/api/settings/image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seedMode: 'fixed', seed: Number(img.seed) })
                    });
                    seedBtn.textContent = res.ok ? 'Seed locked' : 'Failed';
                    seedBtn.disabled = true;
                } catch {
                    seedBtn.textContent = 'Failed';
                }
            });
            footer.appendChild(seedBtn);
        }

        if (img.url) {
            const downloadLink = document.createElement('a');
            downloadLink.className = 'modal-btn';
            downloadLink.textContent = video ? 'Download Video' : 'Download Image';
            downloadLink.title = 'Save this file to your downloads';
            downloadLink.href = img.url;
            const downloadName = lastSegment(img.url);
            if (downloadName) downloadLink.setAttribute('download', downloadName);
            footer.appendChild(downloadLink);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'modal-btn modal-btn-danger';
        deleteBtn.textContent = 'Delete Image';
        deleteBtn.addEventListener('click', async () => {
            if (!window.confirm('Delete this generated image permanently?')) return;
            deleteBtn.disabled = true;
            try {
                // Deleting either side of a group also deletes its partner, so
                // the tile (now the upscaled output) removes the pair as one.
                // Videos use the same cleanup without any compare UI.
                const partner = deletePartnerFor(img, widgetImages);
                if (partner && partner.id !== img.id) {
                    await deleteImage(partner);
                    widgetImages = widgetImages.filter((w) => w.id !== partner.id);
                }
                await deleteImage(img);
                widgetImages = widgetImages.filter((w) => w.id !== img.id);
                renderWidget();
                close();
            } catch (err) {
                window.alert('Delete failed: ' + err.message);
                deleteBtn.disabled = false;
            }
        });
        footer.appendChild(deleteBtn);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-btn modal-btn-cancel';
        closeButton.textContent = 'Close';
        closeButton.addEventListener('click', close);
        footer.appendChild(closeButton);

        body.appendChild(footer);
        closeBtn.addEventListener('click', close);
    }

    // --- View All overlay ---

    function openGallery() {
        const { container, body, closeBtn } = buildModalShell('GENERATED IMAGES');
        const modal = openModal(container);
        const close = modal.close;

        const grid = document.createElement('div');
        grid.className = 'gallery-grid';
        body.appendChild(grid);

        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = 'No generated images yet.';
        body.appendChild(empty);

        fetchImages().then((images) => {
            empty.remove();
            if (!images.length) {
                empty.textContent = 'No generated images yet.';
                body.appendChild(empty);
                return;
            }
            const children = upscaleChildMap(images);
            images.forEach((img) => {
                // An upscaled output replaces its original in the grid — hide
                // the original tile and show the upscaled output instead.
                if (!img.upscale && children.has(lastSegment(img.file))) return;

                const cell = document.createElement('div');
                cell.className = 'gallery-cell';
                cell.title = img.prompt || img.id;
                cell.setAttribute('role', 'button');
                cell.tabIndex = 0;
                cell.addEventListener('click', () => openPreview(img));
                cell.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(img); }
                });
                if (isVideo(img)) {
                    cell.classList.add('gallery-cell--video');
                    const vid = document.createElement('video');
                    vid.src = img.url;
                    vid.preload = 'metadata';
                    vid.muted = true;
                    vid.playsInline = true;
                    vid.addEventListener('error', () => {
                        cell.classList.add('gallery-cell--broken');
                        cell.textContent = 'VID';
                    });
                    cell.appendChild(vid);
                } else {
                    const thumb = document.createElement('img');
                    thumb.src = img.url;
                    thumb.alt = img.prompt || 'Generated image';
                    thumb.loading = 'lazy';
                    thumb.addEventListener('error', () => {
                        cell.classList.add('gallery-cell--broken');
                        cell.textContent = 'IMG';
                    });
                    cell.appendChild(thumb);
                }
                if (!isVideo(img) && img.upscale && img.upscale.source) cell.appendChild(makeCompareBadge('gallery-compare-badge'));
                cell.appendChild(makeDeleteButton(img, cell));
                grid.appendChild(cell);
            });
        }).catch(() => {
            empty.textContent = 'Could not load generated images.';
        });

        closeBtn.addEventListener('click', close);
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // --- Init ---

    function init() {
        const viewAllBtn = document.getElementById('generatedViewAll');
        if (viewAllBtn) viewAllBtn.addEventListener('click', openGallery);
        refreshWidget();
        setInterval(refreshWidget, 60000);
    }

    Gallery.init = init;
    Gallery.refresh = refreshWidget;
    Gallery.openFromUrl = openFromUrl;
    Gallery.openCompare = openCompare;

    window.Gallery = Gallery;
})(window, document);