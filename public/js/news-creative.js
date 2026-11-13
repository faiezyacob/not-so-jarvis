/* SPDX-License-Identifier: MIT */
/* ============================================
   JARVIS — News to creative UI
   Two surfaces share one picker:
   - the chat card carried by a persisted
     [[news-creative:{...}]] marker
   - the Creative Playground's "From today's
     news" section
   Selecting a story never invents a prompt
   here: it sends a structured action and the
   server hands the story to the existing image
   or H3 pipeline.
   ============================================ */

const NewsCreativeUI = (() => {
    const MARKER_RE = /\n*\[\[news-creative:(\{[\s\S]*?\})\]\]/;
    const TTL_MS = 60 * 1000;

    let sectionEl = null;
    let listEl = null;
    let statusEl = null;
    let refreshBtn = null;
    let lastLoadedAt = 0;
    let loading = false;

    function extract(text) {
        const source = String(text || '');
        const match = source.match(MARKER_RE);
        if (!match) return { text: source, cards: [] };
        let card = null;
        try {
            card = JSON.parse(match[1]);
        } catch (err) {
            card = null;
        }
        const clean = source.replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        return { text: clean, cards: card && Array.isArray(card.candidates) ? [card] : [] };
    }

    function strip(text) {
        return extract(text).text;
    }

    function truncate(text, max) {
        const value = String(text || '');
        return value.length > max ? value.slice(0, max - 1).trimEnd() + '\u2026' : value;
    }

    function timeAgo(iso) {
        const time = Date.parse(iso || '');
        if (!Number.isFinite(time)) return '';
        const minutes = Math.max(1, Math.round((Date.now() - time) / 60000));
        if (minutes < 60) return minutes + 'm ago';
        const hours = Math.round(minutes / 60);
        if (hours < 24) return hours + 'h ago';
        return Math.round(hours / 24) + 'd ago';
    }

    function metaLine(candidate) {
        return [
            candidate.source,
            timeAgo(candidate.published),
            candidate.category === 'local' ? 'Local' : '',
            candidate.sensitive ? 'Editorial' : ''
        ].filter(Boolean).join(' \u00b7 ');
    }

    function formatClock(iso) {
        const date = iso ? new Date(iso) : new Date();
        if (Number.isNaN(date.getTime())) return '';
        return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    function sendGeneration(candidate, outputType) {
        if (typeof Chat === 'undefined' || !Chat || typeof Chat.sendMessage !== 'function') return;
        const verb = outputType === 'video'
            ? 'Create a short video'
            : (candidate.sensitive ? 'Create an editorial illustration' : 'Create a meme image');
        Chat.sendMessage({
            text: verb + ' from this news story: ' + truncate(candidate.title, 140),
            newsCreativeAction: {
                type: 'generate',
                newsId: candidate.id,
                outputType
            }
        });
        // A pick inside the Playground should reveal the chat log (and the
        // generation progress) rather than sit on top of it.
        if (window.PlaygroundUI && typeof window.PlaygroundUI.isOpen === 'function'
            && window.PlaygroundUI.isOpen() && typeof window.PlaygroundUI.close === 'function') {
            window.PlaygroundUI.close();
        }
    }

    function sendRefresh(card) {
        if (typeof Chat === 'undefined' || !Chat || typeof Chat.sendMessage !== 'function') return;
        const exclude = (card && Array.isArray(card.candidates) ? card.candidates : [])
            .map((candidate) => candidate.id)
            .filter(Boolean)
            .slice(0, 12);
        Chat.sendMessage({
            text: 'Refresh today\'s news picks',
            newsCreativeAction: exclude.length ? { type: 'refresh', exclude } : { type: 'refresh' }
        });
    }

    function makeButton(label, candidate, outputType) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'news-creative-btn';
        button.setAttribute('data-output', outputType);
        button.setAttribute('aria-label', label + ': ' + truncate(candidate.title, 80));
        button.textContent = label;
        button.addEventListener('click', () => {
            const row = button.closest('.news-creative-item');
            if (row) row.classList.add('is-busy');
            button.parentElement.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            sendGeneration(candidate, outputType);
        });
        return button;
    }

    function makeRow(candidate) {
        const row = document.createElement('div');
        row.className = 'news-creative-item';
        row.setAttribute('data-news-id', candidate.id || '');
        if (candidate.sensitive) row.classList.add('news-creative-item--editorial');

        const main = document.createElement('div');
        main.className = 'news-creative-main';

        const headline = document.createElement(candidate.link ? 'a' : 'span');
        headline.className = 'news-creative-headline';
        if (candidate.link) {
            headline.href = candidate.link;
            headline.target = '_blank';
            headline.rel = 'noopener noreferrer';
        }
        headline.textContent = candidate.title;
        main.appendChild(headline);

        const meta = document.createElement('div');
        meta.className = 'news-creative-meta';
        meta.textContent = metaLine(candidate);
        main.appendChild(meta);

        if (candidate.angle) {
            const angle = document.createElement('p');
            angle.className = 'news-creative-angle';
            angle.textContent = candidate.angle;
            main.appendChild(angle);
        }

        if (!candidate.sensitive && candidate.caption) {
            const caption = document.createElement('p');
            caption.className = 'news-creative-caption';
            caption.textContent = 'Suggested caption: \u201c' + candidate.caption + '\u201d';
            main.appendChild(caption);
        }

        row.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'news-creative-actions';
        const imageLabel = candidate.sensitive ? 'Illustration' : 'Image';
        actions.appendChild(makeButton(imageLabel, candidate, 'image'));
        actions.appendChild(makeButton('Video', candidate, 'video'));
        row.appendChild(actions);
        return row;
    }

    function listOf(candidates) {
        const list = document.createElement('div');
        list.className = 'news-creative-list';
        candidates.forEach((candidate) => list.appendChild(makeRow(candidate)));
        return list;
    }

    // --- Chat card -----------------------------------------------------------

    function render(contentEl, card) {
        if (!contentEl || !card || !Array.isArray(card.candidates) || !card.candidates.length) return;

        const wrap = document.createElement('div');
        wrap.className = 'news-creative';

        const head = document.createElement('div');
        head.className = 'news-creative-head';
        const title = document.createElement('span');
        title.className = 'news-creative-title';
        title.textContent = 'From today\'s news';
        head.appendChild(title);

        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'news-creative-refresh';
        refresh.textContent = 'Refresh headlines';
        refresh.addEventListener('click', () => {
            refresh.disabled = true;
            sendRefresh(card);
        });
        head.appendChild(refresh);
        wrap.appendChild(head);

        const hint = document.createElement('p');
        hint.className = 'news-creative-hint';
        const updated = formatClock(card.generatedAt);
        hint.textContent = (updated ? 'Updated ' + updated + ' \u00b7 ' : '') +
            'Pick a story to turn it into a meme image or a short video. You can also answer with "the second one as a video".';
        wrap.appendChild(hint);

        wrap.appendChild(listOf(card.candidates));
        contentEl.appendChild(wrap);
    }

    // --- Creative Playground section ----------------------------------------

    function setStatus(message, isError, isOk) {
        if (!statusEl) return;
        statusEl.hidden = !message;
        statusEl.textContent = message || '';
        statusEl.classList.toggle('playground-news-status--error', Boolean(isError));
        statusEl.classList.toggle('playground-news-status--ok', Boolean(isOk));
    }

    function setLoading(busy) {
        loading = Boolean(busy);
        if (refreshBtn) refreshBtn.disabled = loading;
        if (sectionEl) sectionEl.classList.toggle('news-creative--loading', loading);
    }

    async function load(options) {
        if (!sectionEl || !listEl) return;
        const opts = options || {};
        const currentIds = opts.refresh
            ? Array.from(listEl.querySelectorAll('.news-creative-item'))
                .map((row) => row.getAttribute('data-news-id'))
                .filter(Boolean)
            : [];
        setLoading(true);
        setStatus('Loading today\'s headlines\u2026', false);
        try {
            const params = new URLSearchParams();
            params.set('count', String(opts.count || 3));
            if (opts.refresh) {
                params.set('refresh', '1');
                // Never let a proxy or the browser answer a refresh from cache.
                params.set('_t', String(Date.now()));
                if (currentIds.length) params.set('exclude', currentIds.join(','));
            }
            const conversationId = (typeof Conversations !== 'undefined' && Conversations.currentId)
                ? Conversations.currentId()
                : '';
            if (conversationId) params.set('conversationId', conversationId);
            const res = await fetch('/api/news/creative?' + params.toString(), { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            const card = data && data.card;
            if (!res.ok || !card || !Array.isArray(card.candidates) || !card.candidates.length) {
                throw new Error((data && data.error) || 'No headlines available.');
            }
            listEl.innerHTML = '';
            listEl.appendChild(listOf(card.candidates));
            sectionEl.hidden = false;
            setStatus('Updated ' + formatClock(card.generatedAt), false, true);
            lastLoadedAt = Date.now();
        } catch (err) {
            // A failed refresh must never blank the tab: keep the last set and
            // say so, so the button stays usable.
            if (listEl.childElementCount) {
                setStatus('Could not refresh headlines \u2014 showing the last set.', true);
            } else {
                listEl.innerHTML = '';
                sectionEl.hidden = true;
                setStatus('', false);
            }
        }
        setLoading(false);
        window.dispatchEvent(new CustomEvent('news-creative-updated'));
    }

    function mountPlayground() {
        sectionEl = document.getElementById('playgroundNewsSection');
        listEl = document.getElementById('playgroundNews');
        statusEl = document.getElementById('playgroundNewsStatus');
        refreshBtn = document.getElementById('playgroundNewsRefresh');
        if (!sectionEl || !listEl) return;
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                if (!loading) load({ refresh: true });
            });
        }
    }

    async function openPlayground() {
        if (!sectionEl) return;
        // Reuse the list while it is fresh; refresh on a new open after a while.
        if (listEl && listEl.childElementCount && Date.now() - lastLoadedAt < TTL_MS) {
            sectionEl.hidden = false;
            return;
        }
        await load({ refresh: false });
    }

    return { extract, strip, render, load, mountPlayground, openPlayground };
})();

window.NewsCreativeUI = NewsCreativeUI;
