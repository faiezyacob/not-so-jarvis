/* ============================================
   JARVIS — Markdown Parser
   Lightweight markdown-to-HTML converter
   for chat message formatting.
   ============================================ */

const Markdown = (() => {

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // Only safe URL schemes / local media paths reach an attribute. Blocks
    // javascript:/vbscript:/file: and non-image data: URLs, and rejects any
    // whitespace/quote/angle characters that could break out of the attribute.
    // Apostrophes stay allowed (safe inside a double-quoted attribute).
    function sanitizeUrl(url) {
        const raw = String(url == null ? '' : url).trim();
        if (!raw) return '';
        if (/[\s"<>`]/.test(raw)) return '';
        if (/^(?:javascript|vbscript|file|data):/i.test(raw) && !/^data:image\//i.test(raw)) return '';
        return raw;
    }

    function parseInline(text) {
        // Escape raw angle brackets first so model-emitted tokens render as
        // literal text instead of becoming HTML elements. H3 prompts carry
        // tokens like <Video 1>, <Picture 1>, <S1> and <d>[Language] …</d>;
        // an unescaped "<Video 1>" was parsed as a real <video> tag and broke
        // the media element that followed it. Everything below builds its own
        // tags after this point, so only the original text is escaped.
        let result = escapeHtml(text);

        // Code blocks (``` ... ```) - handle first to prevent inner parsing.
        // The captured code is already escaped by the step above.
        result = result.replace(/```([\s\S]*?)```/g, (match, code) => {
            return '<pre class="md-code-block"><code>' + code.trim() + '</code></pre>';
        });

        // Inline code (` ... `)
        result = result.replace(/`([^`]+)`/g, (match, code) => {
            return '<code class="md-inline-code">' + code + '</code>';
        });

        // Shield the URLs inside image/link markdown so the inline emphasis
        // rules below don't corrupt them (e.g. italic underscores inside a
        // filename like ..._up_2026....png). The label text stays in place so
        // bold/italic formatting inside it still works, then the real URLs are
        // swapped back in before the tags are built.
        const urlTokens = [];
        result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            urlTokens.push(url);
            return '![' + alt + '](\x00URL' + (urlTokens.length - 1) + '\x00)';
        });
        result = result.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
            urlTokens.push(url);
            return '[' + label + '](\x00URL' + (urlTokens.length - 1) + '\x00)';
        });

        // Bold (** ... ** or __ ... __)
        result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');

        // Italic (* ... * or _ ... _) - be careful not to match bold
        result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
        result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

        // Strikethrough (~~ ... ~~)
        result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        // Restore the real URLs now that emphasis is done.
        result = result.replace(/\x00URL(\d+)\x00/g, (match, index) => urlTokens[Number(index)] ?? '');

        // Images ![alt](url) - handle before links so they don't match as links.
        // A video URL is rendered as a real <video> so an uploaded clip embeds
        // as a playable clip instead of a broken <img>.
        result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            const safe = sanitizeUrl(url);
            if (/\.(?:mp4|webm|mov|m4v|avi|mkv)(?:\?.*)?$/i.test(String(url))) {
                return '<video class="md-video" preload="metadata" playsinline src="' + safe + '"></video>';
            }
            return '<img class="md-image" src="' + safe + '" alt="' + alt + '">';
        });

        // Links [text](url)
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
            return '<a href="' + sanitizeUrl(url) + '" target="_blank" rel="noopener noreferrer" class="md-link">' + label + '</a>';
        });

        // Auto-detect URLs (http/https)
        result = result.replace(/(?<!["\'])(https?:\/\/[^\s<]+)/g, (url) => {
            const safe = sanitizeUrl(url);
            return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer" class="md-link">' + safe + '</a>';
        });

        return result;
    }

    function parse(text) {
        if (!text) return '';

        const lines = text.split('\n');
        let html = '';
        let inCodeBlock = false;
        let codeContent = '';
        let inList = false;
        let listType = '';
        let listItems = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Code block toggle
            if (line.trim().startsWith('```')) {
                if (inCodeBlock) {
                    html += '<pre class="md-code-block"><code>' + escapeHtml(codeContent.trim()) + '</code></pre>';
                    codeContent = '';
                    inCodeBlock = false;
                } else {
                    if (inList) {
                        html += renderList(listItems, listType);
                        listItems = [];
                        inList = false;
                    }
                    inCodeBlock = true;
                }
                continue;
            }

            if (inCodeBlock) {
                codeContent += (codeContent ? '\n' : '') + line;
                continue;
            }

            // Headers
            const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headerMatch) {
                if (inList) {
                    html += renderList(listItems, listType);
                    listItems = [];
                    inList = false;
                }
                const level = headerMatch[1].length;
                html += '<h' + level + ' class="md-header md-header-' + level + '">' + parseInline(headerMatch[2]) + '</h' + level + '>';
                continue;
            }

            // Horizontal rule
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
                if (inList) {
                    html += renderList(listItems, listType);
                    listItems = [];
                    inList = false;
                }
                html += '<hr class="md-hr">';
                continue;
            }

            // Unordered list
            const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)/);
            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) {
                        html += renderList(listItems, listType);
                    }
                    listItems = [];
                    listType = 'ul';
                    inList = true;
                }
                listItems.push(parseInline(ulMatch[1]));
                continue;
            }

            // Ordered list
            const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
            if (olMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) {
                        html += renderList(listItems, listType);
                    }
                    listItems = [];
                    listType = 'ol';
                    inList = true;
                }
                listItems.push(parseInline(olMatch[1]));
                continue;
            }

            // Close list if we're no longer in a list
            if (inList) {
                html += renderList(listItems, listType);
                listItems = [];
                inList = false;
            }

            // Regular paragraph line
            // A real media tag emitted by the backend always carries a src.
            // A prompt line like "<Video 1> is the source video…" must NOT
            // match: treating it as a tag injected an unclosed <video>
            // element that swallowed the actual clip rendered below it.
            if (/^<video\b[^>]*\bsrc\s*=/i.test(line.trim())) {
                let tag = line;
                // Strip inline event handlers (onerror, onload, ...) so a
                // model-supplied tag can never execute script.
                tag = tag.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
                // The custom VideoPlayer provides all controls — never use the
                // native browser UI, even if the backend emits it.
                tag = tag.replace(/\scontrols(?:="[^"]*")?/gi, '');
                if (!/class=/i.test(tag)) tag = tag.replace(/<video(\s)/i, '<video class="md-video"$1');
                if (!/preload=/i.test(tag)) tag = tag.replace(/<video/i, '<video preload="metadata"');
                if (!/playsinline/i.test(tag)) tag = tag.replace(/<video/i, '<video playsinline');
                html += tag;
            } else {
                html += '<p class="md-paragraph">' + parseInline(line) + '</p>';
            }
        }

        // Close any open list
        if (inList) {
            html += renderList(listItems, listType);
        }

        // Close any open code block
        if (inCodeBlock) {
            html += '<pre class="md-code-block"><code>' + escapeHtml(codeContent.trim()) + '</code></pre>';
        }

        return html;
    }

    function renderList(items, type) {
        if (items.length === 0) return '';
        const tag = type === 'ol' ? 'ol' : 'ul';
        const className = type === 'ol' ? 'md-list md-list-ol' : 'md-list md-list-ul';
        let html = '<' + tag + ' class="' + className + '">';
        items.forEach(item => {
            html += '<li>' + item + '</li>';
        });
        html += '</' + tag + '>';
        return html;
    }

    return { parse, escapeHtml };
})();
