// ============================================
// api-view.js — build the gateway API message list from STORED messages.
// Faithful port of chat/js/conversation.js getMessagesForApi into the
// stored-form world (flat messages[], no exchanges): tool-call backfill,
// image URL resolution + attachment manifest, timestamp stripping, role-merge,
// orphan healing (both directions), thinking_signature propagation,
// chunk-view transform hook.
//
// §2.4 note: assistant top-level fields mirror the current variant
// (appendMessageVariant invariant), so this port needs NO variant logic.
// ============================================

function stripExtraTimestamps(content) {
    // Keep the first timestamp, remove any subsequent ones
    const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;
    let first = true;
    return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
        if (first) { first = false; return match; }
        return '';
    });
}

// Strip base64 data from tool args for API messages
function sanitizeToolArgs(args) {
    if (!args || typeof args !== 'object') return args;
    const sanitized = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.length > 1000 &&
            (/^[A-Za-z0-9+/]{100,}/.test(value) ||
             value.startsWith('/9j/') ||  // JPEG
             value.startsWith('iVBOR') || // PNG
             value.startsWith('R0lGOD') || // GIF
             value.startsWith('UEsDB')    // Common binary
            )) {
            sanitized[key] = `[BASE64_DATA](${value.length} chars)`;
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

// Stored-form counterpart of _resolveImageUrlForGateway: window.location.origin
// becomes the explicit publicOrigin (deep-dive G4/G6 — the gateway must be able
// to REACH this origin; see issue #5 and architecture §10).
function resolveImageUrl(url, publicOrigin) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return publicOrigin + url;
    return null;
}

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

// Parse a compact _file nURI ("images:43ba3326.jpg") → { bucket, id, ext }.
function parseFileRef(_file) {
    if (!_file || typeof _file !== 'string') return null;
    const idx = _file.indexOf(':');
    if (idx === -1) return null;
    const bucket = _file.slice(0, idx);
    const rest = _file.slice(idx + 1);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return { bucket, id: rest, ext: '' };
    return { bucket, id: rest.slice(0, dot), ext: rest.slice(dot + 1) };
}

// Resolve an attachment to a gateway-safe image source. Bucket-backed images are
// read INTERNALLY (readImageBytes) and inlined as base64 data URLs — the bucket
// GET route requires cookie auth (issue #5), so an absolute bucket URL handed to
// the gateway would 401 when the gateway/adapter fetches it for a vision model.
function resolveImageDataUrl(att, readImageBytes) {
    if (att?.dataUrl && att.dataUrl.startsWith('data:')) return att.dataUrl;
    const ref = parseFileRef(att?._file);
    if (ref && typeof readImageBytes === 'function') {
        try {
            const buffer = readImageBytes(ref.bucket, ref.id, ref.ext);
            if (buffer) {
                const mime = att.type || EXT_MIME[ref.ext] || 'application/octet-stream';
                return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
            }
        } catch (e) { /* fall through to URL */ }
    }
    if (att?.url && /^https?:\/\//.test(att.url)) return att.url;
    return null;
}

// messages: stored-form array (flat, ordered by idx).
// options: { systemPrompt, publicOrigin, chunkTransform, retirements, chunkView, log }
//   chunkView: the (dynamically imported) chat/js/chunk-view.js module, or null.
// Returns { messages, chunkTable } — messages is the OpenAI-style API array;
// chunkTable (Map<label, hash>, empty when transform is off) resolves the
// model's chunk labels to durable content hashes for context_retire.
function buildApiMessages(messages, options = {}) {
    if (!Array.isArray(messages)) throw new Error('buildApiMessages: messages array required');
    const { systemPrompt = '', publicOrigin, chunkTransform = false, retirements = {}, chunkView = null, log = null, readImageBytes = null } = options;
    if (!publicOrigin) throw new Error('buildApiMessages: options.publicOrigin required');

    const rawMessages = [];
    if (systemPrompt?.trim()) {
        rawMessages.push({ role: 'system', content: systemPrompt.trim() });
    }

    const lastIndex = messages.length - 1;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const isLast = i === lastIndex;

        // ---- Tool result messages: backfill tool_calls + emit role:'tool' ----
        if (msg.role === 'tool') {
            if (msg.toolStatus === 'success' || msg.toolStatus === 'error') {
                const callId = msg.tool_call_id || msg.callId || `call_${msg.id}`;

                // Scan backwards for the last assistant, STOP at user/system
                // (providers reject bridging tool_calls across user messages).
                let targetAssistant = null;
                for (let j = rawMessages.length - 1; j >= 0; j--) {
                    const lastMsg = rawMessages[j];
                    if (lastMsg.role === 'assistant') { targetAssistant = lastMsg; break; }
                    else if (lastMsg.role !== 'tool') { break; }
                }

                const buildCall = () => {
                    let sanitizedArgs = {};
                    try {
                        sanitizedArgs = typeof msg.toolArgs === 'string' ? JSON.parse(msg.toolArgs) : msg.toolArgs;
                        sanitizedArgs = sanitizeToolArgs(sanitizedArgs);
                    } catch (e) {
                        sanitizedArgs = msg.toolArgs || {};
                    }
                    return {
                        id: callId,
                        type: 'function',
                        function: {
                            name: msg.toolName || 'unknown_tool',
                            arguments: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs)
                        }
                    };
                };

                if (targetAssistant) {
                    if (!targetAssistant.tool_calls) targetAssistant.tool_calls = [];
                    if (!targetAssistant.tool_calls.some(tc => tc.id === callId)) {
                        targetAssistant.tool_calls.push(buildCall());
                    }
                } else {
                    rawMessages.push({ role: 'assistant', content: null, tool_calls: [buildCall()] });
                }

                const toolResultObj = {
                    role: 'tool',
                    tool_call_id: callId,
                    content: msg.content || ''
                };
                if (msg.toolImages && msg.toolImages.length > 0) {
                    const resolvedToolImages = msg.toolImages
                        .map(u => resolveImageUrl(u, publicOrigin))
                        .filter(u => u !== null);
                    if (resolvedToolImages.length > 0) {
                        toolResultObj.content = [
                            { type: 'text', text: msg.content || '' },
                            ...resolvedToolImages.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))
                        ];
                    }
                }
                rawMessages.push(toolResultObj);
            }
            continue;
        }

        // ---- User messages: text + attachments (last message, or any that had them) ----
        if (msg.role === 'user') {
            const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
            const hasAttachments = atts.some(att => att.dataUrl || att.url || att._file);
            const validAttachments = (isLast || hasAttachments)
                ? atts.filter(att => att.dataUrl || att.url || att._file)
                : [];

            const cleanUserContent = stripExtraTimestamps(msg.content || '');

            if (validAttachments.length > 0) {
                const gatewayImageUrls = validAttachments
                .map(att => resolveImageDataUrl(att, readImageBytes))

                // Attachment manifest: bucket URLs resolved to absolute, so every
                // model (vision or not) gets awareness + a resolvable reference.
                const manifestEntries = validAttachments
                    .map((att, idx) => {
                        const resolved = resolveImageUrl(att.dataUrl || att.url, publicOrigin);
                        if (!resolved) return null;
                        return { index: idx, name: att.name || 'unnamed', mime: att.type || 'unknown', url: resolved };
                    })
                    .filter(e => e !== null);

                if (gatewayImageUrls.length > 0) {
                    let fullText = cleanUserContent;
                    if (manifestEntries.length > 0) {
                        const manifestStr = manifestEntries.map(e =>
                            `[attachment ${e.index}: name="${e.name}" mime="${e.mime}" url="${e.url}"]`
                        ).join(' ');
                        fullText = (cleanUserContent ? cleanUserContent + '\n' : '') + manifestStr;
                    }
                    // Auto-vision (runner-produced, stored on the attachment):
                    // a non-vision model receives the MCP vision analysis as
                    // text — real image understanding, not a false claim.
                    const analysisStr = validAttachments
                        .map((att, idx) => att.visionAnalysis
                            ? `[Auto-vision analysis of attachment ${idx} (name="${att.name || 'unnamed'}"): ${att.visionAnalysis}]`
                            : null)
                        .filter(e => e !== null)
                        .join('\n');
                    if (analysisStr) fullText = (fullText ? fullText + '\n' : '') + analysisStr;
                    rawMessages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: fullText },
                            ...gatewayImageUrls.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } }))
                        ]
                    });
                } else if (cleanUserContent) {
                    rawMessages.push({ role: 'user', content: cleanUserContent });
                }
            } else if (cleanUserContent) {
                rawMessages.push({ role: 'user', content: cleanUserContent });
            }
            continue;
        }

        // ---- Assistant messages (stored = complete by definition) ----
        if (msg.role === 'assistant') {
            if (msg.content || msg.reasoning_content || msg.tool_calls) {
                const cleanAssistantContent = msg.content ? stripExtraTimestamps(msg.content).trim() : '';
                if (cleanAssistantContent || msg.reasoning_content || msg.tool_calls) {
                    const out = { role: 'assistant', content: cleanAssistantContent || null };
                // Prior-reasoning policy is GATEWAY-side now (2026-08-29,
                // capabilities.priorReasoning in LLM-Gateway): the view passes
                // reasoning_content + thinking_signature through verbatim and the
                // provider's adapter decides keep/strip (DeepSeek requires the echo
                // on tool chains, xAI needs it for cache hits, OpenAI ignores it,
                // native Anthropic drops unsigned thinking with a warn). The former
                // global strip-reasoning-without-signature guard broke exactly the
                // providers that needed the echo.
                if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
                    if (msg.thinking_signature) out.thinking_signature = msg.thinking_signature;
                    if (msg.tool_calls) {
                        out.tool_calls = msg.tool_calls.map(tc => {
                            let sanitizedArgs = {};
                            try {
                                if (typeof tc.function?.arguments === 'string') {
                                    sanitizedArgs = sanitizeToolArgs(JSON.parse(tc.function.arguments));
                                } else if (typeof tc.function?.arguments === 'object') {
                                    sanitizedArgs = sanitizeToolArgs(tc.function.arguments);
                                }
                            } catch (e) {
                                sanitizedArgs = tc.function?.arguments;
                            }
                            return {
                                id: tc.id,
                                type: 'function',
                                function: {
                                    name: tc.function?.name,
                                    arguments: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs)
                                }
                            };
                        });
                    }
                    rawMessages.push(out);
                }
            }
            if (msg.error) {
                rawMessages.push({
                    role: 'user',
                    content: `[System Error Notification: The LLM Provider API rejected the payload or execution failed:\n${msg.error}\nPlease correct the issue or state that you cannot proceed.]`
                });
            }
            continue;
        }

        if (msg.role === 'system') {
            rawMessages.push({ role: 'system', content: msg.content || '' });
        }
    }

    // Merge back-to-back same-role messages (never tool/system, string content only)
    const merged = [];
    for (const m of rawMessages) {
        if (merged.length > 0 &&
            merged[merged.length - 1].role === m.role &&
            m.role !== 'tool' && m.role !== 'system' &&
            typeof m.content === 'string' &&
            typeof merged[merged.length - 1].content === 'string' &&
            !m.tool_calls && !merged[merged.length - 1].tool_calls) {
            merged[merged.length - 1].content += '\n' + m.content;
        } else {
            merged.push(m);
        }
    }

    // Auto-heal: strip orphan tool_calls (no matching tool result)
    const validToolCallIds = new Set();
    for (const m of merged) {
        if (m.role === 'tool' && m.tool_call_id) validToolCallIds.add(m.tool_call_id);
    }
    for (const m of merged) {
        if (m.role === 'assistant' && m.tool_calls) {
            m.tool_calls = m.tool_calls.filter(tc => validToolCallIds.has(tc.id));
            if (m.tool_calls.length === 0) delete m.tool_calls;
        }
    }

    // Auto-heal (reverse): drop orphan tool results (no matching assistant tool_calls)
    const validAssistantCallIds = new Set();
    for (const m of merged) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) validAssistantCallIds.add(tc.id);
        }
    }
    for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i].role === 'tool' && merged[i].tool_call_id && !validAssistantCallIds.has(merged[i].tool_call_id)) {
            merged.splice(i, 1);
        }
    }

    // Propagate thinking_signature forward across tool-call chains (DeepSeek 400 guard)
    let lastThinkingSignature = null;
    for (const m of merged) {
        if (m.role === 'assistant') {
            if (m.thinking_signature) lastThinkingSignature = m.thinking_signature;
            else if (lastThinkingSignature && m.tool_calls) m.thinking_signature = lastThinkingSignature;
        }
    }

    // Chunk-store transform (per-chat flag). Fail loud to raw on engine error.
    if (chunkTransform === true && chunkView) {
        try {
            const { messages: tx, stats, chunkTable } = chunkView.buildChunkView(merged, {
                retirements,
                retirementTools: true
            });
            const savedPct = stats.bytesIn ? Math.round((1 - stats.bytesOut / stats.bytesIn) * 100) : 0;
            log?.info?.(`[chunk-view] in=${(stats.bytesIn / 1000).toFixed(0)}K out=${(stats.bytesOut / 1000).toFixed(0)}K (-${savedPct}%) chunks=${stats.chunks} exact=${stats.exactDupes} near=${stats.nearDupes} retired=${stats.retired} dedupSaved=${(stats.dedupSavedBytes / 1000).toFixed(1)}K retiredSaved=${(stats.retiredSavedBytes / 1000).toFixed(1)}K`);
            // rawMessages (pre-transform merged payload) rides along so the
            // runner can count the no-measures number (§5a reporting) without
            // re-running the projection.
            return { messages: tx, chunkTable: chunkTable || new Map(), chunkStats: stats, rawMessages: merged };
        } catch (e) {
            log?.error?.('[chunk-view] transform failed, sending raw:', e);
        }
    }

    return { messages: merged, chunkTable: new Map(), chunkStats: null, rawMessages: merged };
}

module.exports = { buildApiMessages, stripExtraTimestamps, sanitizeToolArgs, resolveImageUrl, parseFileRef };
