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

    function parseInline(text) {
        let result = text;

        // Code blocks (``` ... ```) - handle first to prevent inner parsing
        result = result.replace(/```([\s\S]*?)```/g, (match, code) => {
            return '<pre class="md-code-block"><code>' + escapeHtml(code.trim()) + '</code></pre>';
        });

        // Inline code (` ... `)
        result = result.replace(/`([^`]+)`/g, (match, code) => {
            return '<code class="md-inline-code">' + escapeHtml(code) + '</code>';
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

        // Images ![alt](url) - handle before links so they don't match as links
        result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            return '<img class="md-image" src="' + url + '" alt="' + alt + '">';
        });

        // Links [text](url)
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');

        // Auto-detect URLs (http/https)
        result = result.replace(/(?<!["\'])(https?:\/\/[^\s<]+)/g, (url) => {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="md-link">' + url + '</a>';
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
            html += '<p class="md-paragraph">' + parseInline(line) + '</p>';
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
