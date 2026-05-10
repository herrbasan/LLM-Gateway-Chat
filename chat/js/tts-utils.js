// ============================================
// TTS Text Extraction Utility
// ============================================

export function getPlainText(content) {
    if (!content) return '';
    let text = content;
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
