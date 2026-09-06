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

        const visible = widgetImages.slice(0, 6);
        visible.forEach((img) => {
            const cell = document.createElement('div');
            cell.className = 'generated-thumb';
            cell.title = img.prompt || img.id;
            cell.setAttribute('role', 'button');
            cell.tabIndex = 0;
            cell.addEventListener('click', () => openPreview(img));
            cell.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(img); }
            });
            const thumb = document.createElement('img');
            thumb.src = img.url;
            thumb.alt = img.prompt || 'Generated image';
            thumb.loading = 'lazy';
            thumb.addEventListener('error', () => {
                cell.classList.add('generated-thumb--broken');
                cell.textContent = 'IMG';
            });
            cell.appendChild(thumb);
            cell.appendChild(makeDeleteButton(img, cell));
            gridEl.appendChild(cell);
        });

        infoEl.textContent = widgetImages.length + ' image' + (widgetImages.length === 1 ? '' : 's') + ' · ' + todayLabel(widgetImages);
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

    function formatResolution(img) {
        if (img.width && img.height) return img.width + ' × ' + img.height;
        return '—';
    }

    function formatGeneratedAt(img) {
        const t = Date.parse(img.createdAt);
        if (isNaN(t)) return img.createdAt || '';
        const d = new Date(t);
        return 'Generated ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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
                await deleteImage(img);
                widgetImages = widgetImages.filter((w) => w.id !== img.id);
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
        const { container, body, closeBtn } = buildModalShell('GENERATED IMAGE');
        const modal = openModal(container);
        const close = modal.close;

        const imgWrap = document.createElement('div');
        imgWrap.className = 'gallery-preview-image';
        const imgEl = document.createElement('img');
        imgEl.src = img.url;
        imgEl.alt = img.prompt || 'Generated image';
        imgEl.addEventListener('error', () => {
            imgWrap.classList.add('gallery-preview-broken');
            imgWrap.textContent = 'Image file is missing.';
        });
        imgWrap.appendChild(imgEl);
        body.appendChild(imgWrap);

        const meta = document.createElement('div');
        meta.className = 'gallery-preview-meta';
        meta.innerHTML =
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Model</span><span class="gallery-preview-value">' + escapeHtml(img.model || 'Krea2') + '</span></div>' +
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Resolution</span><span class="gallery-preview-value">' + escapeHtml(formatResolution(img)) + '</span></div>' +
            '<div class="gallery-preview-row"><span class="gallery-preview-label">Time</span><span class="gallery-preview-value">' + escapeHtml(formatGeneratedAt(img)) + '</span></div>';
        body.appendChild(meta);

        if (img.prompt) {
            const promptEl = document.createElement('div');
            promptEl.className = 'gallery-preview-prompt';
            promptEl.innerHTML = '<div class="gallery-preview-label">Prompt</div><div class="gallery-preview-prompt-text">' + escapeHtml(img.prompt) + '</div>';
            body.appendChild(promptEl);
        }

        const footer = document.createElement('div');
        footer.className = 'modal-footer';

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

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'modal-btn modal-btn-danger';
        deleteBtn.textContent = 'Delete Image';
        deleteBtn.addEventListener('click', async () => {
            if (!window.confirm('Delete this generated image permanently?')) return;
            deleteBtn.disabled = true;
            try {
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
            images.forEach((img) => {
                const cell = document.createElement('div');
                cell.className = 'gallery-cell';
                cell.title = img.prompt || img.id;
                cell.setAttribute('role', 'button');
                cell.tabIndex = 0;
                cell.addEventListener('click', () => openPreview(img));
                cell.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(img); }
                });
                const thumb = document.createElement('img');
                thumb.src = img.url;
                thumb.alt = img.prompt || 'Generated image';
                thumb.loading = 'lazy';
                thumb.addEventListener('error', () => {
                    cell.classList.add('gallery-cell--broken');
                    cell.textContent = 'IMG';
                });
                cell.appendChild(thumb);
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

    window.Gallery = Gallery;
})(window, document);