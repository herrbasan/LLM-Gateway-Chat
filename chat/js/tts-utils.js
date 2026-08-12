// ============================================
// TTS Text Extraction Utility
// ============================================

export function getPlainText(content) {
    if (!content) return '';
    let text = content;
    // Remove YAML frontmatter (document metadata — never speakable). Only
    // matches a --- fenced block at the very start, same rule as NUI's
    // parseFrontmatter, so mid-document --- rules are untouched.
    text = text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?(\n|$)/, '');
    // Remove thinking blocks including content
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    text = text.replace(/<think>[\s\S]*$/g, '');
    // Remove markdown code blocks (fenced) including content
    text = text.replace(/```[\s\S]*?```/g, '');
    // Remove inline code
    text = text.replace(/`[^`]+`/g, '');
    // Strip remaining XML tags
    text = text.replace(/<[^>]+>/g, '');
    // Strip markdown formatting
    text = text.replace(/[*_~`#]/g, '');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}
