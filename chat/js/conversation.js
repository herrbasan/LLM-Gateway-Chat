// ============================================
// Conversation — Read-Only Projection
// ============================================
//
// The client is wired to a server-side runner: the browser is a disposable
// attach/detach view over the runner's snapshot + event stream. This module
// no longer owns persistence or the state machine. It holds only the derived
// `exchanges[]` list, built from runner messages by `messagesToExchanges()`.
// All persistence/state methods were removed (no live callers remain).

// Convert the runner's view-form messages (snapshot.messages / msg.* events) into
// the exchange-form the chat renderer consumes. Unlike _backendMessagesToExchanges
// (raw stored form: embedded [ts] prefix + createdAt), the runner already splits
// {content, timestamp} and densifies attachments (blobUrl/url/dataUrl). The renderer
// handles stripped content + a ms `timestamp` the same way it handles the legacy form.
// Preserves each message's id on _userMsgId/_asstMsgId/_toolMsgId so the controller
// can map exchange → message for delete / edit / embed.status.
export function messagesToExchanges(messages) {
    const groups = [];
    let current = [];
    for (const msg of messages) {
        if (msg.role === 'user' && current.length > 0) {
            groups.push(current);
            current = [msg];
        } else {
            current.push(msg);
        }
    }
    if (current.length > 0) groups.push(current);

    const exchanges = [];

    for (const group of groups) {
        let regularExchange = null;
        let lastToolExchange = null;
        const pendingTools = new Map();

        for (const msg of group) {
            if (msg.role === 'user') {
                regularExchange = {
                    id: 'ex_' + (Date.now() + Math.random()),
                    timestamp: msg.timestamp || Date.now(),
                    _userMsgId: msg.id || null,
                    user: { role: 'user', content: msg.content || '', attachments: msg.attachments || [], embedStatus: msg.embedStatus || null, embedError: msg.embedError || null },
                    assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
                };
            } else if (msg.role === 'tool') {
                const toolName = msg.toolName;
                const toolContent = msg.content || '';
                if (!toolName && !toolContent) continue;
                if (msg.toolStatus === 'pending') { pendingTools.set(toolName, msg); continue; }
                if (msg.toolStatus === 'success') pendingTools.delete(toolName);

                const toolEx = {
                    id: 'ex_' + (Date.now() + Math.random()),
                    timestamp: msg.timestamp || Date.now(),
                    type: 'tool',
                    _toolMsgId: msg.id || null,
                    tool: { name: toolName || 'unknown', args: msg.toolArgs || {}, status: msg.toolStatus || 'success', content: toolContent, images: msg.toolImages || [] },
                    user: { role: 'user', content: '', attachments: [] },
                    assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
                };
                exchanges.push(toolEx);
                lastToolExchange = toolEx;
            } else if (msg.role === 'assistant') {
                const content = (msg.content || '').trim();
                if (!content && !msg.reasoning_content) continue;
                const target = lastToolExchange || regularExchange;
                if (target) {
                    target._asstMsgId = msg.id || null;
                    if (content) {
                        target.assistant.content = target.assistant.content ? target.assistant.content + '\n' + content : content;
                    }
                    if (msg.reasoning_content) target.assistant.reasoning_content = msg.reasoning_content;
                    if (msg.thinking_signature) target.assistant.thinking_signature = msg.thinking_signature;
                    if (msg.streamStats) target.assistant.streamStats = msg.streamStats;
                    if (msg.usage) target.assistant.usage = msg.usage;
                    if (msg.context) target.assistant.context = msg.context;
                    if (msg.model) target.model = msg.model;
                    if (msg.embedStatus) target.assistant.embedStatus = msg.embedStatus;
                    if (msg.embedError) target.assistant.embedError = msg.embedError;
                    target.assistant.isComplete = true;
                    target.assistant.isStreaming = false;
                    if (Array.isArray(msg.versions) && msg.versions.length) {
                        target.assistant.versions = msg.versions;
                        target.assistant.currentVersion = msg.currentVersion ?? 0;
                    } else if (!target.assistant.versions.length) {
                        target.assistant.versions = [{ content, timestamp: msg.timestamp || Date.now(), streamStats: msg.streamStats || null, usage: msg.usage || null, context: msg.context || null }];
                    }
                }
            }
        }

        for (const [toolName, toolMsg] of pendingTools) {
            exchanges.push({
                id: 'ex_' + (Date.now() + Math.random()),
                timestamp: toolMsg.timestamp || Date.now(),
                type: 'tool',
                _toolMsgId: toolMsg.id || null,
                tool: { name: toolName || 'unknown', args: toolMsg.toolArgs || {}, status: 'pending', content: toolMsg.content || '', images: toolMsg.toolImages || [] },
                user: { role: 'user', content: '', attachments: [] },
                assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
            });
        }
        if (regularExchange) exchanges.push(regularExchange);
    }

    return exchanges.sort((a, b) => a.timestamp - b.timestamp);
}

export class Conversation {
    constructor(storageKey = 'chat-conversation', sessionId = null) {
        this.exchanges = [];
        this.storageKey = storageKey;
        this.sessionId = sessionId || this._extractId();
    }

    _extractId() {
        return this.storageKey.replace('chat-conversation-', '');
    }

    getExchange(id) {
        return this.exchanges.find(e => e.id === id);
    }

    getVersionInfo(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return null;

        return {
            current: exchange.assistant.currentVersion + 1,
            total: exchange.assistant.versions.length,
            hasMultiple: exchange.assistant.versions.length > 1
        };
    }

    getAll() {
        return this.exchanges;
    }

    get length() {
        return this.exchanges.length;
    }
}


