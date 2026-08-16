// ============================================
// TTS Text Extraction Utility
// ============================================

export function getPlainText(content) {
    if (!content) return '';
    let text = content;
    // Markdown cleanup is now delegated to nSpeech (extra_body.markdown), so we
    // no longer strip markdown syntax here. We still remove structural things
    // that are never meant to be spoken and that the regex clean won't handle.
    // Remove YAML frontmatter (document metadata — never speakable). Only
    // matches a --- fenced block at the very start, same rule as NUI's
    // parseFrontmatter, so mid-document --- rules are untouched.
    text = text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?(\n|$)/, '');
    // Remove thinking blocks including content
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    text = text.replace(/<think>[\s\S]*$/g, '');
    return text.trim();
}
