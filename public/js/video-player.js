/* ============================================
   JARVIS — Video Player
   Custom video controls matching the system
   theme (accent, mono labels, card borders).
   Enhances <video> in chat + gallery previews.
   No native controls are used.
   ============================================ */

(function (window, document) {
    'use strict';

    var SVG_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>';
    var SVG_PAUSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"></path></svg>';
    var SVG_VOLUME = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg>';
    var SVG_MUTED = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
    var SVG_FULL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>';

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        var s = Math.floor(seconds);
        var m = Math.floor(s / 60);
        s = s % 60;
        return m + ':' + String(s).padStart(2, '0');
    }

    function makeButton(label, html, cls) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'jv-btn ' + (cls || '');
        btn.setAttribute('aria-label', label);
        btn.title = label;
        btn.innerHTML = html;
        return btn;
    }

    function enhance(video) {
        if (!video || video.nodeName !== 'VIDEO') return null;
        if (video.dataset.jvEnhanced === '1') return video.closest('.jv-player') || null;
        // Thumbnail previews are muted loops, not players.
        if (video.closest('.generated-thumb') || video.closest('.gallery-cell')) return null;
        video.dataset.jvEnhanced = '1';

        video.removeAttribute('controls');
        video.controls = false;
        if (!video.hasAttribute('preload')) video.preload = 'metadata';
        video.playsInline = true;

        var wrap = document.createElement('div');
        wrap.className = 'jv-player';
        video.parentNode.insertBefore(wrap, video);
        wrap.appendChild(video);

        var bigPlay = document.createElement('button');
        bigPlay.type = 'button';
        bigPlay.className = 'jv-bigplay';
        bigPlay.setAttribute('aria-label', 'Play video');
        bigPlay.innerHTML = SVG_PLAY;
        wrap.appendChild(bigPlay);

        var spinner = document.createElement('div');
        spinner.className = 'jv-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        wrap.appendChild(spinner);

        var bar = document.createElement('div');
        bar.className = 'jv-bar';

        var playBtn = makeButton('Play', SVG_PLAY, 'jv-play');
        var timeEl = document.createElement('span');
        timeEl.className = 'jv-time';
        timeEl.textContent = '0:00 / 0:00';

        var seek = document.createElement('input');
        seek.type = 'range';
        seek.className = 'jv-seek';
        seek.min = '0';
        seek.max = '1000';
        seek.value = '0';
        seek.step = '1';
        seek.setAttribute('aria-label', 'Seek');

        var muteBtn = makeButton('Mute', SVG_VOLUME, 'jv-mute');
        var vol = document.createElement('input');
        vol.type = 'range';
        vol.className = 'jv-vol';
        vol.min = '0';
        vol.max = '100';
        vol.value = String(Math.round((video.muted ? 0 : (video.volume || 1)) * 100));
        vol.setAttribute('aria-label', 'Volume');

        var fullBtn = makeButton('Fullscreen', SVG_FULL, 'jv-full');
        var openBtn = null;
        // In chat, offer a one-click hop into the gallery lightbox preview.
        if (!video.closest('.gallery-preview-image')) {
            openBtn = makeButton('Open preview', SVG_FULL, 'jv-open');
            openBtn.setAttribute('aria-label', 'Open preview');
            openBtn.title = 'Open preview';
        }

        bar.appendChild(playBtn);
        bar.appendChild(timeEl);
        bar.appendChild(seek);
        bar.appendChild(muteBtn);
        bar.appendChild(vol);
        if (openBtn) bar.appendChild(openBtn);
        bar.appendChild(fullBtn);
        wrap.appendChild(bar);

        var hideTimer = 0;
        function poke() {
            wrap.classList.remove('jv-idle');
            window.clearTimeout(hideTimer);
            if (!video.paused && !video.ended) {
                hideTimer = window.setTimeout(function () {
                    wrap.classList.add('jv-idle');
                }, 2200);
            }
        }

        function syncPlay() {
            var playing = !video.paused && !video.ended;
            wrap.classList.toggle('jv-playing', playing);
            playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
            playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
            playBtn.title = playing ? 'Pause' : 'Play';
            bigPlay.style.display = playing ? 'none' : '';
            poke();
        }

        function syncTime() {
            var dur = video.duration || 0;
            var cur = video.currentTime || 0;
            timeEl.textContent = formatTime(cur) + ' / ' + formatTime(dur);
            if (dur > 0 && document.activeElement !== seek) {
                seek.value = String(Math.round((cur / dur) * 1000));
            }
            seek.style.setProperty('--jv-fill', (dur > 0 ? (cur / dur) * 100 : 0) + '%');
        }

        function syncVolume() {
            var muted = video.muted || video.volume === 0;
            muteBtn.innerHTML = muted ? SVG_MUTED : SVG_VOLUME;
            muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
            muteBtn.title = muted ? 'Unmute' : 'Mute';
            vol.value = String(video.muted ? 0 : Math.round(video.volume * 100));
            vol.style.setProperty('--jv-fill', vol.value + '%');
            wrap.classList.toggle('jv-muted', muted);
        }

        function toggle() {
            if (video.paused || video.ended) {
                var p = video.play();
                if (p && typeof p.catch === 'function') p.catch(function () {});
            } else {
                video.pause();
            }
        }

        playBtn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
        bigPlay.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
        video.addEventListener('click', function () { toggle(); });
        video.addEventListener('dblclick', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleFullscreen();
        });
        muteBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            video.muted = !video.muted;
            if (!video.muted && video.volume === 0) video.volume = 0.5;
        });
        vol.addEventListener('input', function () {
            var v = Number(vol.value) / 100;
            video.volume = Math.max(0, Math.min(1, v));
            video.muted = v <= 0;
        });
        seek.addEventListener('input', function () {
            var dur = video.duration || 0;
            if (!dur) return;
            video.currentTime = (Number(seek.value) / 1000) * dur;
            syncTime();
        });
        fullBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleFullscreen(); });
        if (openBtn) {
            openBtn.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M15 3h6v6"></path><path d="M10 14l11-11"></path>' +
                '<path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path></svg>';
            openBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var src = video.getAttribute('src') || video.currentSrc;
                if (window.Gallery && typeof window.Gallery.openFromUrl === 'function' && src) {
                    video.pause();
                    window.Gallery.openFromUrl(src);
                }
            });
        }

        function toggleFullscreen() {
            try {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else if (wrap.requestFullscreen) {
                    wrap.requestFullscreen();
                } else if (video.requestFullscreen) {
                    video.requestFullscreen();
                }
            } catch (err) {}
        }

        ['play', 'pause', 'ended'].forEach(function (evt) { video.addEventListener(evt, syncPlay); });
        video.addEventListener('timeupdate', syncTime);
        video.addEventListener('loadedmetadata', syncTime);
        video.addEventListener('durationchange', syncTime);
        video.addEventListener('volumechange', syncVolume);
        ['waiting', 'stalled'].forEach(function (evt) {
            video.addEventListener(evt, function () { wrap.classList.add('jv-buffering'); });
        });
        ['playing', 'canplay', 'error'].forEach(function (evt) {
            video.addEventListener(evt, function () { wrap.classList.remove('jv-buffering'); });
        });
        video.addEventListener('error', function () {
            wrap.classList.add('jv-error');
            bigPlay.style.display = 'none';
        });

        wrap.addEventListener('mousemove', poke);
        wrap.addEventListener('pointerdown', poke, true);
        wrap.addEventListener('focusin', poke);
        wrap.addEventListener('mouseleave', function () {
            if (!video.paused && !video.ended) wrap.classList.add('jv-idle');
        });
        wrap.addEventListener('keydown', function (e) {
            if (e.key === ' ' && e.target === wrap) { e.preventDefault(); toggle(); }
            else if (e.key === 'ArrowRight' && e.target !== seek) { video.currentTime += 5; }
            else if (e.key === 'ArrowLeft' && e.target !== seek) { video.currentTime -= 5; }
            else if ((e.key === 'f' || e.key === 'F') && e.target !== seek && e.target !== vol) { toggleFullscreen(); }
            else if ((e.key === 'm' || e.key === 'M') && e.target !== seek && e.target !== vol) { video.muted = !video.muted; }
        });
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', 'Video player');

        syncPlay();
        syncTime();
        syncVolume();
        poke();
        return wrap;
    }

    function scan(root) {
        var scope = root && root.querySelectorAll ? root : document;
        var videos = scope.querySelectorAll ? scope.querySelectorAll('video') : [];
        for (var i = 0; i < videos.length; i++) {
            try { enhance(videos[i]); } catch (err) {}
        }
    }

    function init() {
        scan(document);
        if (window.MutationObserver) {
            // Queue added nodes across batches: chat streaming replaces
            // message HTML on every chunk, so batches arriving while a
            // drain is pending must be kept, not dropped, or the final
            // video node would never get enhanced.
            var pending = false;
            var queue = [];
            var observer = new MutationObserver(function (mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var nodes = mutations[m].addedNodes || [];
                    for (var n = 0; n < nodes.length; n++) {
                        if (nodes[n] && nodes[n].nodeType === 1) queue.push(nodes[n]);
                    }
                }
                if (pending) return;
                pending = true;
                window.setTimeout(drain, 30);
            });
            observer.observe(document.body, { childList: true, subtree: true });

            function drain() {
                var nodes = queue;
                queue = [];
                for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    if (!node || node.nodeType !== 1) continue;
                    // Skip nodes already detached by a newer render.
                    if (!node.isConnected) continue;
                    try {
                        if (node.nodeName === 'VIDEO') {
                            enhance(node);
                        } else if (node.querySelectorAll) {
                            var vids = node.querySelectorAll('video');
                            for (var v = 0; v < vids.length; v++) enhance(vids[v]);
                        }
                    } catch (err) {}
                }
                if (queue.length) {
                    window.setTimeout(drain, 30);
                } else {
                    pending = false;
                }
            }
        }
    }

    var api = { enhance: enhance, scan: scan, init: init };
    window.VideoPlayer = api;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window, document);
