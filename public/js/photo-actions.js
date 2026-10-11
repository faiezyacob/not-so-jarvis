/* ============================================
   JARVIS — Companion photo actions
   A companion photo (Camera Director) reply is
   persisted with a [[photo-actions]] marker. This
   module strips it for display/speech and attaches
   quick follow-up actions beneath the generated
   image: another photo, a different camera
   viewpoint, or turning the scene into a video.
   Clicking fills the chat input for review —
   nothing auto-sends.
   ============================================ */

const PhotoActions = (() => {
    const MARKER_RE = /\n*\[\[photo-actions\]\]/g;
    const MARKER_TEST_RE = /\[\[photo-actions\]\]/;

    const ACTIONS = [
        {
            id: 'another',
            title: 'Another photo',
            request: 'Take another photo',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>'
        },
        {
            id: 'back-camera',
            title: 'Back camera',
            request: 'Use the back camera and show me what is around you',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle></svg>'
        },
        {
            id: 'video',
            title: 'Turn into video',
            request: 'Turn that photo into a video',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>'
        }
    ];

    function extract(markdown) {
        const text = String(markdown === undefined || markdown === null ? '' : markdown);
        return { text: text.replace(MARKER_RE, ''), active: MARKER_TEST_RE.test(text) };
    }

    function strip(markdown) {
        return extract(markdown).text.trim();
    }

    function fillInput(text) {
        const input = document.getElementById('chatInput');
        if (!input) return;
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
            input.setSelectionRange(text.length, text.length);
        }
    }

    function actionButton(action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-suggestion photo-action';
        btn.setAttribute('data-photo-action', action.id);
        const icon = document.createElement('span');
        icon.className = 'chat-suggestion-icon';
        icon.innerHTML = action.icon;
        const label = document.createElement('span');
        label.className = 'chat-suggestion-label';
        label.textContent = action.title;
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', () => fillInput(action.request));
        return btn;
    }

    // Attach the follow-up action row beneath the last generated image.
    function attach(contentEl) {
        if (!contentEl) return;
        const images = contentEl.querySelectorAll('img.md-image');
        if (!images.length) return;
        const target = images[images.length - 1];
        const row = document.createElement('div');
        row.className = 'chat-suggestion-row photo-action-row';
        ACTIONS.forEach((action) => row.appendChild(actionButton(action)));
        target.parentNode.insertBefore(row, target.nextSibling);
    }

    return { ACTIONS, extract, strip, attach, fillInput };
})();

window.PhotoActions = PhotoActions;
