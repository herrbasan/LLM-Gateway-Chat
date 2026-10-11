// ============================================
// api-view.js — build the gateway API message list from STORED messages.
// Faithful port of chat/js/conversation.js getMessagesForApi into the
// stored-form world (flat messages[], no exchanges): tool-call backfill,
// image URL resolution + attachment manifest, timestamp stripping, role-merge,
// orphan healing (both directions), thinking_signature propagation,
// retirement transform (positional [mN] markers + tombstones — see
// server/retire-view.js).
//
// §2.4 note: assistant top-level fields mirror the current variant
// (appendMessageVariant invariant), so this port needs NO variant logic.
// ============================================
const retireView = require('./retire-view');

function stripExtraTimestamps(content) {
    // Keep the first timestamp, remove any subsequent ones
    const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;
    let first = true;
    return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
        if (first) { first = false; return match; }
        return '';
    });
}

// Canonical per-message time signal (2026-08-31): exactly one
// [YYYY-MM-DD@HH:MM] prefix per message, derived from stored createdAt —
// NEVER from content. Model-echoed prefixes are stripped at the leading edge,
// so a mimicked timestamp can never double up. Server local time, minute
// precision. Returns '' when the message has no text (attachment-only).
const LEADING_TS_REGEX = /^(\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*)+/;
function formatMessageTs(createdAt) {
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}:${p(d.getMinutes())}] `;
}
function withTimestamp(content, createdAt) {
    const clean = (content || '').replace(LEADING_TS_REGEX, '').trim();
    if (!clean) return '';
    return formatMessageTs(createdAt) + clean;
}

// Input-source tag (2026-09-20). Voice formatting is a per-MESSAGE property, not
// a per-session one: a hands-free turn deserves spoken prose, the next typed turn
// deserves normal formatting, and one blanket session block made the model answer
// everything in speech style. Only the SPEAKING case is tagged — an untagged user
// message is typed by definition, so the common case pays no tokens for a tag it
// does not need.
//
// The tag goes AFTER the timestamp, preserving the convention every other message
// follows (`[ts] …`). Inserted by position rather than by call order so it cannot
// end up leading the line if the two helpers are ever composed differently.
const VOICE_TAG = '[voice] ';
const TS_PREFIX = /^(\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*)/;
function withInputSource(content, msg) {
    if (!content || msg?.voice !== true) return content;
    const m = content.match(TS_PREFIX);
    return m ? m[1] + VOICE_TAG + content.slice(m[1].length) : VOICE_TAG + content;
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

// Parse a bucket URL — bare ('/api/buckets/images/43ba3326.jpg') or absolute —
// → { bucket, id, ext }. Tool-result images are stored in this spelling.
function parseBucketPath(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/api\/buckets\/([^/?#]+)\/([^/?#]+)/);
    if (!m) return null;
    const dot = m[2].lastIndexOf('.');
    if (dot === -1) return null;
    return { bucket: m[1], id: m[2].slice(0, dot), ext: m[2].slice(dot + 1).toLowerCase() };
}

// Bucket bytes → data URL, read straight out of nDB. The bucket GET route
// requires cookie auth (issue #5), so handing the gateway a bucket URL means it
// 401s — and on a localhost spelling the gateway's SSRF guard rejects it before
// the request is even made — after which the image is stripped and the model
// answers blind. Reading internally skips HTTP entirely.
function bucketDataUrl(bucket, id, ext, mime, readImageBytes) {
    if (typeof readImageBytes !== 'function') return null;
    try {
        const buffer = readImageBytes(bucket, id, ext);
        if (!buffer) return null;
        const type = mime || EXT_MIME[ext] || 'application/octet-stream';
        return `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
    } catch (e) {
        return null; // unreadable file — caller falls back to the URL it had
    }
}

// Resolve an attachment to a gateway-safe image source. Bucket-backed images are
// read INTERNALLY (readImageBytes) and inlined as base64 data URLs.
function resolveImageDataUrl(att, readImageBytes) {
    if (att?.dataUrl && att.dataUrl.startsWith('data:')) return att.dataUrl;
    const ref = parseFileRef(att?._file);
    if (ref) {
        const inlined = bucketDataUrl(ref.bucket, ref.id, ref.ext, att.type, readImageBytes);
        if (inlined) return inlined;
    }
    if (att?.url && /^https?:\/\//.test(att.url)) return att.url;
    return null;
}

// Tool-result images (runner.extractToolResult stores them as bucket URLs) need
// the same treatment as attachments, or every image a tool returns is dropped
// before the model sees it. Non-bucket URLs stay URLs: remote images are the
// gateway's to fetch, under its own SSRF policy.
function resolveToolImage(url, publicOrigin, readImageBytes) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('data:')) return url;
    const ref = parseBucketPath(url);
    if (ref) {
        const inlined = bucketDataUrl(ref.bucket, ref.id, ref.ext, null, readImageBytes);
        if (inlined) return inlined;
    }
    return resolveImageUrl(url, publicOrigin);
}

// messages: stored-form array (flat, ordered by idx).
// options: { systemPrompt, publicOrigin, chunkTransform, retirements, log }
//   chunkTransform: the per-session retirement flag (name kept for stored-doc
//                   compatibility; the transform is retire-only since 2026-10-11).
//   retirements:    { [contentHash]: { distill, at } } — the session's map.
// Returns { messages, retireStats } — messages is the OpenAI-style API array
// with [mN] markers and tombstones applied; retireStats carries the savings
// numbers for the context report.
function buildApiMessages(messages, options = {}) {
    if (!Array.isArray(messages)) throw new Error('buildApiMessages: messages array required');
    const { systemPrompt = '', publicOrigin, chunkTransform = false, retirements = {}, log = null, readImageBytes = null } = options;
    if (!publicOrigin) throw new Error('buildApiMessages: options.publicOrigin required');

    const retireOn = chunkTransform === true && retirements && Object.keys(retirements).length > 0;
    // Live-chain guard: the last user message and everything after it is the
    // active turn — tombstones never apply there (signed/tool-chain contracts).
    let liveFromIdx = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { liveFromIdx = i; break; }
    }
    const retireStats = { retired: 0, retiredSavedBytes: 0 };
    // Idempotence: one args hash tombstones on BOTH the assistant's
    // tool_calls and the tool-message mirror — count it once per assembly.
    const appliedRetireHashes = new Set();

    const rawMessages = [];
    if (systemPrompt?.trim()) {
        rawMessages.push({ role: 'system', content: systemPrompt.trim() });
    }

    const lastIndex = messages.length - 1;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const isLast = i === lastIndex;
        // Retirement replacements for THIS message ({} when off / live chain).
        const tx = retireOn ? retireView.transformStored(msg, i, retirements, liveFromIdx, formatMessageTs) : {};
        if (tx._retireStats) {
            for (const { hash, saved } of tx._retireStats.hashes) {
                if (appliedRetireHashes.has(hash)) continue;
                appliedRetireHashes.add(hash);
                retireStats.retired++;
                retireStats.retiredSavedBytes += saved;
            }
            delete tx._retireStats;
        }
        // [mN] address markers ride the payload only in retirement chats.
        const mark = (text) => chunkTransform === true ? retireView.stampMarker(text, i) : text;

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
                        const srcArgs = 'toolArgs' in tx ? tx.toolArgs : msg.toolArgs;
                        sanitizedArgs = typeof srcArgs === 'string' ? JSON.parse(srcArgs) : srcArgs;
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

                const toolContent = 'content' in tx
                    ? tx.content
                    : mark(withTimestamp(msg.content, msg.createdAt));
                const toolResultObj = {
                    role: 'tool',
                    tool_call_id: callId,
                    content: toolContent
                };
                if (msg.toolImages && msg.toolImages.length > 0 && !msg.toolImagesStripped) {
                    const resolvedToolImages = msg.toolImages
                        .map(u => resolveToolImage(u, publicOrigin, readImageBytes))
                        .filter(u => u !== null);
                    if (resolvedToolImages.length > 0) {
                        toolResultObj.content = [
                            { type: 'text', text: toolContent },
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

            const cleanUserContent = 'content' in tx
                ? tx.content
                : mark(withInputSource(withTimestamp(msg.content, msg.createdAt), msg));

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
                const cleanAssistantContent = msg.content
                    ? ('content' in tx
                        ? tx.content
                        : mark(withTimestamp(msg.content, msg.createdAt)))
                    : '';
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
                // Retirement exception (retire-view): a tombstoned reasoning is
                // replaced (unsigned) or dropped together with its signature
                // (signed — prior-turn thinking may be dropped, never edited).
                if (msg.reasoning_content && 'reasoning_content' in tx) out.reasoning_content = tx.reasoning_content;
                else if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
                    if (msg.thinking_signature && !('thinking_signature' in tx)) out.thinking_signature = msg.thinking_signature;
                    const callsSrc = tx.toolCalls || msg.tool_calls;
                    if (callsSrc) {
                        out.tool_calls = callsSrc.map(tc => {
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

    // Retirement convention paragraph — rides the first system message
    // whenever the transform is on (the retire tools are offered exactly then).
    if (chunkTransform === true) {
        const para = retireView.RETIREMENT_CONVENTION_PARAGRAPH;
        const sysIdx = merged.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            merged[sysIdx] = { ...merged[sysIdx], content: merged[sysIdx].content + '\n\n' + para };
        } else {
            merged.unshift({ role: 'system', content: para });
        }
        if (retireStats.retired > 0) {
            log?.info?.(`[retire-view] tombstoned=${retireStats.retired} saved=${(retireStats.retiredSavedBytes / 1000).toFixed(1)}K`);
        }
    }

    return { messages: merged, retireStats, rawMessages: merged };
}

module.exports = { buildApiMessages, stripExtraTimestamps, withTimestamp, withInputSource, formatMessageTs, LEADING_TS_REGEX, sanitizeToolArgs, resolveImageUrl, parseFileRef };
