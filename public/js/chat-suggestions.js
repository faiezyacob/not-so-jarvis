/* ============================================
   JARVIS — Suggested-prompt actions
   When a prompt-writing / prompt-ideation reply
   renders a suggested prompt in a fenced code
   block, the server marks the message with a
   [[prompt-suggestion]] marker. This module
   strips that marker for display/speech/context
   and attaches "Generate Image" / "Generate
   Video" cards beneath each code block. Clicking
   a card drops a ready-to-run request into the
   chat input for review — nothing auto-sends.
   ============================================ */

const ChatSuggestions = (() => {
    const MARKER_RE = /\n*\[\[prompt-suggestion\]\]/g;
    const MARKER_TEST_RE = /\[\[prompt-suggestion\]\]/;

    const SUGGESTIONS = [
        {
            id: 'image',
            title: 'Generate Image',
            prefix: 'Generate an image: ',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
        },
        {
            id: 'video',
            title: 'Generate Video',
            prefix: 'Generate a video: ',
            icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>'
        }
    ];

    // Pull the marker out of persisted markdown. Returns the cleaned text plus
    // whether this message carried a suggested prompt.
    function extract(markdown) {
        const text = String(markdown === undefined || markdown === null ? '' : markdown);
        const suggested = MARKER_TEST_RE.test(text);
        return { text: text.replace(MARKER_RE, ''), suggested };
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
            const end = text.length;
            input.setSelectionRange(end, end);
        }
    }

    function collapse(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function suggestionButton(suggestion, prompt) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-suggestion';
        btn.setAttribute('data-suggestion', suggestion.id);
        btn.title = suggestion.title + ' from this prompt';

        const icon = document.createElement('span');
        icon.className = 'chat-suggestion-icon';
        icon.innerHTML = suggestion.icon;

        const label = document.createElement('span');
        label.className = 'chat-suggestion-label';
        label.textContent = suggestion.title;

        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', () => fillInput(suggestion.prefix + prompt));
        return btn;
    }

    function suggestionRow(prompt) {
        const row = document.createElement('div');
        row.className = 'chat-suggestion-row';
        SUGGESTIONS.forEach((suggestion) => row.appendChild(suggestionButton(suggestion, prompt)));
        return row;
    }

    // Attach the action cards beneath every suggested-prompt code block.
    function attach(contentEl) {
        if (!contentEl) return;
        contentEl.querySelectorAll('.md-code-block').forEach((block) => {
            const prompt = collapse(block.textContent || '');
            if (!prompt) return;
            block.parentNode.insertBefore(suggestionRow(prompt), block.nextSibling);
        });
    }

    return { SUGGESTIONS, extract, strip, attach, fillInput };
})();

window.ChatSuggestions = ChatSuggestions;
