// ============================================
// Streaming Handler - SSE for Gateway API
// ============================================

export class StreamingHandler {
    constructor(gatewayUrl) {
        this.gatewayUrl = gatewayUrl;
        this.abortController = null;
        this.buffer = '';
    }

    // ============================================
    // Main Stream Method
    // ============================================

    async *streamChat(requestBody) {
        this.abortController = new AbortController();
        this.buffer = '';
        
        try {
            const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({
                    ...requestBody,
                    stream: true
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            let hasYieldedDone = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    const event = this._parseLine(line);
                    if (event) {
                        yield event;
                        if (event.type === 'done') hasYieldedDone = true;
                    }
                }
            }

            // Process remaining buffer
            if (buffer.trim()) {
                const event = this._parseLine(buffer);
                if (event) {
                    yield event;
                    if (event.type === 'done') hasYieldedDone = true;
                }
            }

            if (!hasYieldedDone) {
                yield { type: 'done' };
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                yield { type: 'aborted' };
            } else {
                yield { type: 'error', error: error.message };
            }
        }
    }

    // ============================================
    // SSE Line Parser
    // ============================================

    _parseLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return null;

        // Comment/heartbeat (ignore)
        if (trimmed.startsWith(':')) {
            return null;
        }

        // Event line
        if (trimmed.startsWith('event:')) {
            // Store event type for next data line
            this._pendingEvent = trimmed.slice(6).trim();
            return null;
        }

        // Data line
        if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            
            // End marker
            if (data === '[DONE]') {
                return { type: 'done' };
            }

            // Parse JSON
            try {
                const parsed = JSON.parse(data);
                const eventType = this._pendingEvent || 'message';
                this._pendingEvent = null;

                // Handle different event types
                if (eventType === 'compaction.progress') {
                    return { type: 'compaction', data: parsed };
                }

                if (eventType === 'compaction.start') {
                    return { type: 'compaction-start', data: parsed };
                }

                if (eventType === 'compaction.complete') {
                    return { type: 'compaction-complete', data: parsed };
                }

                // Regular message delta
                if (parsed.choices?.[0]?.delta?.content !== undefined) {
                    return {
                        type: 'delta',
                        content: parsed.choices[0].delta.content || ''
                    };
                }

                // Full message (non-streaming fallback)
                if (parsed.choices?.[0]?.message?.content) {
                    return {
                        type: 'message',
                        content: parsed.choices[0].message.content
                    };
                }

                return { type: 'raw', data: parsed };

            } catch (error) {
                // Partial JSON, accumulate
                return { type: 'partial', data };
            }
        }

        return null;
    }

    // ============================================
    // Abort
    // ============================================

    abort() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    // ============================================
    // Non-streaming fallback
    // ============================================

    async sendNonStreaming(requestBody) {
        try {
            const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ...requestBody,
                    stream: false
                })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            return {
                content: data.choices?.[0]?.message?.content || '',
                context: data.context,
                usage: data.usage
            };

        } catch (error) {
            throw new Error(`Request failed: ${error.message}`);
        }
    }
}
