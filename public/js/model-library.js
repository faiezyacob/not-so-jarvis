/* ============================================
   JARVIS — Model Library (Server-Driven)
   Fetches catalog from server API, shows
   install status, real download with progress.
   ============================================ */

const ModelLibrary = (function () {
    let isOpen = false;
    let cachedHardware = null;
    let activeDownloads = new Map();

    function init() {
        var btn = document.getElementById('modelLibraryBtn');
        var closeBtn = document.getElementById('modelLibraryClose');
        var overlay = document.getElementById('modelLibraryOverlay');

        if (btn) btn.addEventListener('click', open);
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (overlay) overlay.addEventListener('click', function (e) {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isOpen) close();
        });
    }

    function open() {
        isOpen = true;
        var overlay = document.getElementById('modelLibraryOverlay');
        if (overlay) {
            overlay.classList.add('open');
            document.body.style.overflow = 'hidden';
        }
        refreshLibrary();
    }

    function close() {
        isOpen = false;
        var overlay = document.getElementById('modelLibraryOverlay');
        if (overlay) {
            overlay.classList.remove('open');
            document.body.style.overflow = '';
        }
    }

    async function refreshLibrary() {
        var hardwareEl = document.getElementById('modelLibraryHardware');
        var gridEl = document.getElementById('modelLibraryGrid');
        if (!hardwareEl || !gridEl) return;

        hardwareEl.innerHTML = '<div class="ml-hardware-loading">Fetching hardware data...</div>';
        gridEl.innerHTML = '';

        var hardware = await HardwareCompat.fetchLatestStats();
        cachedHardware = hardware;

        renderHardwareBanner(hardwareEl, hardware);

        try {
            var resp = await fetch('/api/ai/models');
            var data = await resp.json();
            renderModelCards(gridEl, data.models || [], hardware, data.extraInstalled || []);
        } catch (err) {
            gridEl.innerHTML = '<div class="ml-error">Failed to load model catalog: ' + err.message + '</div>';
        }
    }

    function renderHardwareBanner(container, hardware) {
        if (!hardware) {
            container.innerHTML = '<div class="ml-hardware-unknown">Unable to detect system hardware</div>';
            return;
        }
        var gpuName = (hardware.gpu && hardware.gpu.name) || 'No GPU detected';
        var vramAvailable = hardware.vram && hardware.vram.available;
        var vramTotal = vramAvailable ? hardware.vram.total : 0;
        var vramFree = vramAvailable ? hardware.vram.free : 0;
        var vramUsed = vramAvailable ? hardware.vram.used : 0;
        var ramTotal = (hardware.ram && hardware.ram.total) || 0;
        var ramFree = (hardware.ram && hardware.ram.free) || 0;

        var gpuSection;
        if (vramAvailable) {
            gpuSection = '<div class="ml-hardware-block">'
                + '<div class="ml-hardware-label">GPU</div>'
                + '<div class="ml-hardware-value">' + gpuName + '</div>'
                + '<div class="ml-hardware-detail">' + vramTotal + ' GB VRAM</div>'
                + '<div class="ml-hardware-detail">Available: ' + vramFree + ' GB</div>'
                + '<div class="ml-hardware-detail ml-hardware-dim">Used: ' + vramUsed + ' GB</div>'
                + '</div>';
        } else {
            gpuSection = '<div class="ml-hardware-block">'
                + '<div class="ml-hardware-label">GPU</div>'
                + '<div class="ml-hardware-value ml-hardware-dim">No GPU detected</div>'
                + '<div class="ml-hardware-detail">Models will run on CPU</div>'
                + '</div>';
        }
        var ramSection = '<div class="ml-hardware-block">'
            + '<div class="ml-hardware-label">SYSTEM</div>'
            + '<div class="ml-hardware-value">' + ramTotal + ' GB RAM</div>'
            + '<div class="ml-hardware-detail">Available: ' + ramFree + ' GB</div>'
            + '</div>';

        container.innerHTML = '<div class="ml-hardware-title">YOUR SYSTEM</div>'
            + '<div class="ml-hardware-row">' + gpuSection + ramSection + '</div>';
    }

    function renderModelCards(container, models, hardware, extraInstalled) {
        var catalogModels = models.filter(function (m) { return !m.installed; });
        var installedModels = models.filter(function (m) { return m.installed; });

        if (installedModels.length > 0 || extraInstalled.length > 0) {
            var hdr = document.createElement('div');
            hdr.className = 'ml-section-header';
            hdr.textContent = 'Installed Models';
            container.appendChild(hdr);

            installedModels.forEach(function (m) {
                container.appendChild(createModelCard(m, hardware, true));
            });
            extraInstalled.forEach(function (m) {
                container.appendChild(createInstalledExtraCard(m, hardware));
            });

            var divider = document.createElement('div');
            divider.className = 'ml-section-divider';
            container.appendChild(divider);
        }

        var catalogHdr = document.createElement('div');
        catalogHdr.className = 'ml-section-header';
        catalogHdr.textContent = 'Available to Download';
        container.appendChild(catalogHdr);

        var sorted = catalogModels.slice().sort(function (a, b) {
            return (a.estimatedVramBytes || a.downloadSizeBytes || 0) - (b.estimatedVramBytes || b.downloadSizeBytes || 0);
        });
        sorted.forEach(function (m) {
            container.appendChild(createModelCard(m, hardware, false));
        });
    }

    function createModelCard(model, hardware, installed) {
        var card = document.createElement('div');
        card.className = 'ml-model-card';
        card.setAttribute('data-model-id', model.id);

        var compat = HardwareCompat.checkModelHardwareCompatibility(model, hardware);
        var compatClass = HardwareCompat.getCompatibilityClass(compat.level);
        card.classList.add('ml-card-' + compatClass);

        var downloadSize = HardwareCompat.formatBytes(model.downloadSizeBytes);

        var vramLine = model.estimatedVramBytes != null
            ? 'Estimated VRAM: ~' + compat.estimatedVram + ' GB'
            : 'Estimated VRAM: unknown';

        var gpuLine = '';
        if (compat.gpuName && compat.vramTotal > 0) {
            gpuLine = 'Your GPU: ' + compat.vramTotal + ' GB';
        } else if (!compat.gpuName) {
            gpuLine = 'No GPU detected';
        }

        var compatBadge = '<div class="ml-compat-badge ' + compatClass + '">' + compat.label + '</div>';

        var capabilitiesHtml = '';
        if (model.capabilities && model.capabilities.length > 0) {
            capabilitiesHtml = '<div class="ml-capabilities">'
                + model.capabilities.map(function (c) { return '<span class="ml-cap-tag">' + c + '</span>'; }).join('')
                + '</div>';
        }

        var categoryBadge = model.category
            ? '<span class="ml-category-badge">' + model.category + '</span>'
            : '';
        var recommendedBadge = model.recommended
            ? '<span class="ml-recommended-badge">★</span>'
            : '';

        var statusHtml = installed
            ? '<div class="ml-status-badge ml-installed">Installed</div>'
            : '';

        var notesHtml = model.hardwareNotes
            ? '<div class="ml-hardware-notes">' + model.hardwareNotes + '</div>'
            : '';

        card.innerHTML = '<div class="ml-card-top">'
            + '<div class="ml-card-title">' + recommendedBadge + model.displayName + ' ' + statusHtml + '</div>'
            + '<div class="ml-card-specs">' + model.parameterSize + ' · ' + categoryBadge + '</div>'
            + '</div>'
            + '<div class="ml-card-description">' + model.description + '</div>'
            + capabilitiesHtml
            + notesHtml
            + '<div class="ml-card-hardware">'
            + '<div class="ml-card-hardware-row">' + vramLine + '</div>'
            + (gpuLine ? '<div class="ml-card-hardware-row ml-card-hardware-dim">' + gpuLine + '</div>' : '')
            + '<div class="ml-card-hardware-row ml-card-hardware-dim">Download size: ' + downloadSize + '</div>'
            + '</div>'
            + compatBadge
            + '<div class="ml-card-actions">'
            + (installed
                ? '<button class="ml-use-btn" data-model-id="' + model.id + '" data-provider="' + model.provider + '">Use Model</button>'
                    + '<button class="ml-remove-btn" data-model-id="' + model.id + '" data-provider="' + model.provider + '">Remove</button>'
                : '<button class="ml-download-btn" data-model-id="' + model.id + '" data-provider="' + model.provider + '">Download</button>'
            )
            + '</div>';

        if (installed) {
            card.querySelector('.ml-use-btn').addEventListener('click', function () {
                handleUseModelClick(model);
            });
            card.querySelector('.ml-remove-btn').addEventListener('click', function () {
                handleRemoveClick(model);
            });
        } else {
            card.querySelector('.ml-download-btn').addEventListener('click', function () {
                handleDownloadClick(model);
            });
        }

        return card;
    }

    function createInstalledExtraCard(model, hardware) {
        var card = document.createElement('div');
        card.className = 'ml-model-card ml-card-extra-installed';
        card.setAttribute('data-model-id', model.id);

        card.innerHTML = '<div class="ml-card-top">'
            + '<div class="ml-card-title">' + model.displayName + ' <div class="ml-status-badge ml-installed">Installed</div></div>'
            + '<div class="ml-card-specs">' + model.provider + (model.sizeDisplay ? ' · ' + model.sizeDisplay : '') + '</div>'
            + '</div>'
            + '<div class="ml-card-description">Not in JARVIS catalog. Available on your provider.</div>'
            + '<div class="ml-card-actions">'
            + '<button class="ml-use-btn" data-model-id="' + model.id + '" data-provider="' + model.provider + '">Use Model</button>'
            + '</div>';

        card.querySelector('.ml-use-btn').addEventListener('click', function () {
            applyModel(model);
            close();
        });

        return card;
    }

    async function handleDownloadClick(model) {
        var hardware = cachedHardware || await HardwareCompat.fetchLatestStats();
        var compat = HardwareCompat.checkModelHardwareCompatibility(model, hardware);

        if (compat.level === 'good') {
            showSimpleDownloadConfirm(model, compat);
        } else {
            showWarningDownloadConfirm(model, compat, hardware);
        }
    }

    async function handleUseModelClick(model) {
        var hardware = cachedHardware || await HardwareCompat.fetchLatestStats();
        var compat = HardwareCompat.checkModelHardwareCompatibility(model, hardware);

        if (compat.level === 'good') {
            applyModel(model);
            close();
        } else {
            showUseModelConfirm(model, compat, hardware);
        }
    }

    function showSimpleDownloadConfirm(model, compat) {
        var header = document.getElementById('modalHeader');
        var body = document.getElementById('modalBody');
        var footer = document.getElementById('modalFooter');

        header.innerHTML = '<div class="modal-title">Download ' + model.displayName + '</div>';
        body.innerHTML = '<div class="modal-model-info">'
            + '<div class="modal-model-specs">Parameter size: ' + model.parameterSize + '</div>'
            + '<div class="modal-model-size">Model size: ~' + HardwareCompat.formatBytes(model.downloadSizeBytes) + '</div>'
            + '<div class="modal-compat-badge compat-good">' + compat.label + '</div>'
            + '</div>';

        footer.innerHTML = '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>'
            + '<button class="modal-btn modal-btn-primary" id="modalConfirm">Download</button>';

        showModal();

        document.getElementById('modalCancel').addEventListener('click', hideModal);
        document.getElementById('modalConfirm').addEventListener('click', function () {
            hideModal();
            startRealDownload(model);
        });
    }

    function showWarningDownloadConfirm(model, compat, hardware) {
        var header = document.getElementById('modalHeader');
        var body = document.getElementById('modalBody');
        var footer = document.getElementById('modalFooter');

        var gpuName = compat.gpuName || 'Unknown GPU';
        var vramTotal = compat.vramTotal || 0;
        var vramFree = compat.vramFree || 0;
        var estVram = compat.estimatedVram || 0;
        var ramTotal = compat.ramTotal || 0;
        var ramFree = compat.ramFree || 0;

        var titleText = compat.level === 'critical' ? 'VRAM WARNING' : 'High VRAM Usage';
        var iconClass = compat.level === 'critical' ? 'modal-icon-warning' : 'modal-icon-caution';

        body.innerHTML = '<div class="modal-model-info">'
            + '<div class="modal-model-specs">' + model.parameterSize + '</div>'
            + '</div>'
            + '<div class="modal-hardware-details">'
            + '<div class="modal-detail-row">'
            + '<span class="modal-detail-label">Estimated VRAM:</span>'
            + '<span class="modal-detail-value">~' + estVram + ' GB</span>'
            + '</div>'
            + '<div class="modal-detail-row">'
            + '<span class="modal-detail-label">Currently available:</span>'
            + '<span class="modal-detail-value">' + vramFree + ' GB</span>'
            + '</div>'
            + (vramTotal > 0 ? '<div class="modal-detail-row">'
                + '<span class="modal-detail-label">Your GPU:</span>'
                + '<span class="modal-detail-value">' + gpuName + ' · ' + vramTotal + ' GB</span>'
                + '</div>' : '')
            + (ramTotal > 0 ? '<div class="modal-detail-row">'
                + '<span class="modal-detail-label">System RAM:</span>'
                + '<span class="modal-detail-value">' + ramTotal + ' GB (' + ramFree + ' GB free)</span>'
                + '</div>' : '')
            + '</div>'
            + '<div class="modal-warning-text">' + compat.message + '</div>'
            + (compat.level === 'critical' ? '<div class="modal-note">'
                + '<span class="modal-note-title">Note:</span> Another application may be using VRAM.'
                + '</div>' : '');

        header.innerHTML = '<div class="modal-title"><span class="modal-title-icon ' + iconClass + '">⚠</span> ' + titleText + '</div>';

        footer.innerHTML = '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>'
            + '<button class="modal-btn modal-btn-warning" id="modalConfirm">Download Anyway</button>';

        showModal();

        document.getElementById('modalCancel').addEventListener('click', hideModal);
        document.getElementById('modalConfirm').addEventListener('click', function () {
            hideModal();
            startRealDownload(model);
        });
    }

    function showUseModelConfirm(model, compat, hardware) {
        var header = document.getElementById('modalHeader');
        var body = document.getElementById('modalBody');
        var footer = document.getElementById('modalFooter');

        header.innerHTML = '<div class="modal-title"><span class="modal-title-icon modal-icon-caution">⚠</span> VRAM Warning</div>';
        body.innerHTML = '<div class="modal-model-info">'
            + '<div class="modal-model-name">' + model.displayName + '</div>'
            + '<div class="modal-model-specs">Already installed</div>'
            + '</div>'
            + '<div class="modal-warning-text">Current VRAM may be insufficient for this model.</div>'
            + '<div class="modal-hardware-details">'
            + '<div class="modal-detail-row">'
            + '<span class="modal-detail-label">Available VRAM:</span>'
            + '<span class="modal-detail-value">' + (compat.vramFree || 0) + ' GB</span>'
            + '</div>'
            + '<div class="modal-detail-row">'
            + '<span class="modal-detail-label">Estimated requirement:</span>'
            + '<span class="modal-detail-value">~' + (compat.estimatedVram || 0) + ' GB</span>'
            + '</div>'
            + '</div>';

        footer.innerHTML = '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>'
            + '<button class="modal-btn modal-btn-warning" id="modalConfirm">Load Anyway</button>';

        showModal();

        document.getElementById('modalCancel').addEventListener('click', hideModal);
        document.getElementById('modalConfirm').addEventListener('click', function () {
            hideModal();
            applyModel(model);
            close();
        });
    }

    async function handleRemoveClick(model) {
        var header = document.getElementById('modalHeader');
        var body = document.getElementById('modalBody');
        var footer = document.getElementById('modalFooter');

        header.innerHTML = '<div class="modal-title">Remove ' + model.displayName + '</div>';
        body.innerHTML = '<div class="modal-model-info">'
            + '<div class="modal-model-specs">' + model.parameterSize + '</div>'
            + '</div>'
            + '<div class="modal-warning-text">This will uninstall "' + model.id + '" from ' + model.provider + '. This cannot be undone.</div>';

        footer.innerHTML = '<button class="modal-btn modal-btn-cancel" id="modalCancel">Cancel</button>'
            + '<button class="modal-btn modal-btn-danger" id="modalConfirm">Remove Model</button>';

        showModal();

        document.getElementById('modalCancel').addEventListener('click', hideModal);
        document.getElementById('modalConfirm').addEventListener('click', async function () {
            hideModal();
            var removeBtn = document.querySelector('[data-model-id="' + model.id + '"].ml-remove-btn');
            if (removeBtn) {
                removeBtn.disabled = true;
                removeBtn.textContent = 'Removing...';
            }
            try {
                var resp = await fetch('/api/ai/models/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modelId: model.id, provider: model.provider })
                });
                var result = await resp.json();
                if (result.error) {
                    if (removeBtn) {
                        removeBtn.textContent = 'Error';
                        removeBtn.disabled = false;
                    }
                    return;
                }
                var gridEl = document.getElementById('modelLibraryGrid');
                if (gridEl) refreshLibrary();
            } catch (err) {
                if (removeBtn) {
                    removeBtn.textContent = 'Error';
                    removeBtn.disabled = false;
                }
            }
        });
    }

    async function startRealDownload(model) {
        var btn = document.querySelector('[data-model-id="' + model.id + '"].ml-download-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Starting...';
            btn.classList.add('ml-downloading');
        }

        try {
            var resp = await fetch('/api/ai/models/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: model.id, provider: model.provider })
            });
            var status = await resp.json();

            if (status.state === 'error') {
                if (btn) {
                    btn.textContent = 'Error';
                    btn.classList.remove('ml-downloading');
                    btn.classList.add('ml-download-error');
                }
                return;
            }

            activeDownloads.set(model.id, status.id);
            pollDownloadProgress(model, status.id, btn);
        } catch (err) {
            if (btn) {
                btn.textContent = 'Error';
                btn.classList.remove('ml-downloading');
                btn.classList.add('ml-download-error');
            }
        }
    }

    async function pollDownloadProgress(model, downloadId, btn) {
        var done = false;
        while (!done) {
            await new Promise(function (r) { setTimeout(r, 1000); });
            try {
                var resp = await fetch('/api/ai/models/download/' + downloadId);
                var status = await resp.json();

                if (btn) {
                    var pct = status.progress || 0;
                    btn.textContent = pct > 0 ? 'Downloading... ' + pct + '%' : status.status || 'Downloading...';
                }

                if (status.state === 'completed') {
                    done = true;
                    activeDownloads.delete(model.id);
                    if (btn) {
                        btn.textContent = 'Downloaded ✓';
                        btn.classList.remove('ml-downloading');
                        btn.classList.add('ml-downloaded');
                        btn.disabled = true;
                    }
                    var gridEl = document.getElementById('modelLibraryGrid');
                    if (gridEl) refreshLibrary();
                } else if (status.state === 'error') {
                    done = true;
                    activeDownloads.delete(model.id);
                    if (btn) {
                        btn.textContent = 'Error: ' + (status.error || 'Failed');
                        btn.classList.remove('ml-downloading');
                        btn.classList.add('ml-download-error');
                        btn.disabled = false;
                    }
                }
            } catch {
                done = true;
                activeDownloads.delete(model.id);
            }
        }
    }

    async function applyModel(model) {
        var provider = model.provider || 'ollama';
        var modelId = model.id;

        try {
            await fetch('/api/ai/models/use', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: modelId, provider: provider })
            });
        } catch {}

        var providerSelect = document.getElementById('chatProvider');
        var modelInput = document.getElementById('chatModel');
        if (providerSelect) providerSelect.value = provider;
        if (modelInput) {
            modelInput.value = modelId;
            modelInput.dispatchEvent(new Event('change'));
        }
        if (providerSelect) providerSelect.dispatchEvent(new Event('change'));
    }

    function showModal() {
        var overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.classList.add('open');
    }

    function hideModal() {
        var overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.classList.remove('open');
    }

    return {
        init: init,
        open: open,
        close: close,
        refreshLibrary: refreshLibrary
    };
})();
