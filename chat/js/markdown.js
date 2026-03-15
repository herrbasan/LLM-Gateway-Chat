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
                <span class="code-lang">${lang || 'text'}</span>
                <button class="code-copy" onclick="copyCode('${codeId}')" title="Copy code">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy
                </button>
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
                'hr', 'div', 'span', 'button', 'svg', 'path', 'rect', 'polyline'
            ],
            ALLOWED_ATTR: [
                'href', 'title', 'src', 'alt', 'class', 'id',
                'onclick', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width'
            ]
        });
    }
    
    return html;
}

// Parse thinking blocks from content
export function parseThinking(content) {
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
        return {
            thinking: thinkMatch[1].trim(),
            answer: content.replace(/<think>[\s\S]*?<\/think>/, '').trim()
        };
    }
    // Check if we're inside a thinking block (streaming)
    if (content.includes('<think>') && !content.includes('</think>')) {
        const partial = content.match(/<think>([\s\S]*)$/);
        if (partial) {
            return {
                thinking: partial[1].trim(),
                answer: null,
                isStreaming: true
            };
        }
    }
    return { thinking: null, answer: content };
}

// Render thinking block HTML
export function renderThinking(thinking, isStreaming = false) {
    const thinkingId = 'thinking-' + Math.random().toString(36).substr(2, 9);
    
    return `
        <div class="thinking-block ${isStreaming ? 'streaming' : ''}" id="${thinkingId}">
            <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 0.5rem;"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
                <span class="thinking-title">${isStreaming ? 'Thinking...' : 'Thinking'}</span>
                <span class="thinking-toggle">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </span>
            </div>
            <div class="thinking-content">
                ${escapeHtml(thinking)}
            </div>
        </div>
    `;
}

// Toggle thinking block visibility
window.toggleThinking = function(thinkingId) {
    const el = document.getElementById(thinkingId);
    if (el) {
        el.classList.toggle('collapsed');
    }
};

