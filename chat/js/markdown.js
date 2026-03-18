// ============================================
// Markdown Rendering (adapted from LMChat)
// ============================================

// Configure markdown-it with Prism highlighting
const md = window.markdownit({
    html: false,
    xhtmlOut: false,
    breaks: true,
    linkify: true,
    typographer: true,
    highlight: function (str, lang) {
        if (lang && window.Prism?.languages?.[lang]) {
            try {
                return `<pre class="language-${lang}"><code class="language-${lang}">` +
                    window.Prism.highlight(str, window.Prism.languages[lang], lang) +
                    '</code></pre>';
            } catch (e) {
                console.warn('Prism highlight error:', e);
            }
        }
        return `<pre><code>${escapeHtml(str)}</code></pre>`;
    }
});

// Use markdown-it-prism if available
if (window.markdownitPrism) {
    md.use(window.markdownitPrism);
}

// Override markdown-it table renderers to wrap in nui-table
md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    return '<nui-table>\n' + self.renderToken(tokens, idx, options);
};
md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options) + '\n</nui-table>\n';
};

// Override hr to add class based on markup
md.renderer.rules.hr = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    let className = 'hr-default';
    if (token.markup.includes('*')) className = 'hr-asterisk';
    else if (token.markup.includes('-')) className = 'hr-dash';
    else if (token.markup.includes('_')) className = 'hr-underscore';
    
    return `<hr class="${className}">\n`;
};

// Add copy button to code blocks
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const code = token.content;
    const lang = token.info || '';
    
    let highlighted;
    if (lang && window.Prism?.languages?.[lang]) {
        try {
            highlighted = window.Prism.highlight(code, window.Prism.languages[lang], lang);
        } catch (e) {
            highlighted = escapeHtml(code);
        }
    } else {
        highlighted = escapeHtml(code);
    }
    
    const langClass = lang ? `language-${lang}` : '';
    const codeId = 'code-' + Math.random().toString(36).substr(2, 9);
    
    return `
        <div class="code-block">
            <div class="code-header">
                <nui-badge variant="primary">${lang || 'text'}</nui-badge>
                <nui-button variant="outline" size="small">
                    <button class="code-copy" onclick="copyCode('${codeId}')" title="Copy code">
                        <nui-icon name="content_copy"></nui-icon>
                        Copy
                    </button>
                </nui-button>
            </div>
            <pre class="${langClass}"><code id="${codeId}" class="${langClass}">${highlighted}</code></pre>
        </div>
    `;
};

// Escape HTML helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Copy code function (global)
window.copyCode = function(codeId) {
    const codeEl = document.getElementById(codeId);
    if (!codeEl) return;
    
    const text = codeEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = codeEl.closest('.code-block')?.querySelector('.code-copy');
        if (btn) {
            const original = btn.innerHTML;
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Copied!
            `;
            setTimeout(() => btn.innerHTML = original, 2000);
        }
    });
};

// Main render function
export function renderMarkdown(content) {
    if (!content) return '';
    
    // Render markdown
    let html = md.render(content);
    
    // Sanitize with DOMPurify
    if (window.DOMPurify) {
        html = window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: [
                'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'ul', 'ol', 'li',
                'a', 'img',
                'table', 'thead', 'tbody', 'tr', 'th', 'td',
                'hr', 'div', 'span', 'button', 'svg', 'path', 'rect', 'polyline',
                'nui-table', 'nui-button', 'nui-accordion', 'details', 'summary', 'nui-badge'
            ],
            ALLOWED_ATTR: [
                'href', 'title', 'src', 'alt', 'class', 'id',
                'onclick', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width',
                'variant', 'size', 'open'
            ]
        });
    }
    
    return html;
}

// Parse thinking blocks from content
export function parseThinking(content) {
    let thinking = [];
    let answer = content;
    let isStreaming = false;

    // Extract all closed <think> blocks
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
    let match;
    while ((match = thinkRegex.exec(content)) !== null) {
        thinking.push(match[1].trim());
    }
    answer = answer.replace(thinkRegex, '');

    // Extract unclosed <think> block (for streaming)
    const unclosedRegex = /<think>([\s\S]*)$/;
    const unclosedMatch = answer.match(unclosedRegex);
    if (unclosedMatch) {
        thinking.push(unclosedMatch[1].trim());
        answer = answer.replace(unclosedRegex, '');
        isStreaming = true;
    }

    return {
        thinking: thinking.length > 0 ? thinking.join('\n\n') : null,
        answer: answer.trim() || null,
        isStreaming
    };
}

