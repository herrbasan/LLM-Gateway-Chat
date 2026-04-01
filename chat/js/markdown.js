// ============================================
// Markdown Rendering & Thinking Parser
// ============================================

// Main render function using NUI Web Components markdown utility
export function renderMarkdown(content) {
    if (!content) return '';
    
    // Always use declarative Web Component strategy to prevent async loading race conditions
    // This ensures markdown renders correctly even if nui-markdown module loads after history hydration
    const safeContent = content.replace(/<\/script/gi, '<\\/script');
    return `<nui-markdown><script type="text/markdown">\n${safeContent}\n</script></nui-markdown>`;
}

// Copy code function (global) - needed for rendered blocks if any still use this, 
// though nui-code has its own copy mechanism. Kept for backwards compatibility 
// with older messages in history.
window.copyCode = function(codeId) {
    const codeEl = document.getElementById(codeId);
    if (!codeEl) {
        // Fallback for nui-code inner tracking if needed
        return;
    }
    
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

