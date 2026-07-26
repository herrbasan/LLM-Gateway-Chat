// src/client-sdk.js — SSE-only transport for LLM Gateway
// WebSocket transport was removed after the gateway retired /v1/realtime.
class EventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return this;
  }

  once(event, callback) {
    const onceCallback = (...args) => {
      this.off(event, onceCallback);
      callback(...args);
    };
    return this.on(event, onceCallback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
    return this;
  }

  emit(event, ...args) {
    if (this.listeners.has(event)) {
      for (const callback of this.listeners.get(event)) {
        try {
          callback(...args);
        } catch (e) {
          console.error(`Error in event listener for ${event}:`, e);
        }
      }
    }
    return this;
  }
}

export class GatewayClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const base = options.baseUrl || 'http://localhost:3400';
    this.restUrl = base;
    
    this.accessKey = options.accessKey || '';
    // Auto-generate session ID for tracking related requests (e.g., for Kimi CLI Adapter)
    this.sessionId = options.sessionId || `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    
    this.streams = new Map();
    this._streamRegistry = new Map(); // chatId -> { stream, isAborted }
    this.onLog = options.onLog || null; // (category, message, meta) => void
  }

  // ==========================================
  // REST API Methods
  // ==========================================

  async getModels() {
    const headers = this.accessKey ? { 'Authorization': `Bearer ${this.accessKey}` } : {};
    const res = await fetch(`${this.restUrl}/v1/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async getHealth() {
    const res = await fetch(`${this.restUrl}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ==========================================
  // Streaming (SSE)
  // ==========================================

  // Modern Async Iterator over the SSE /v1/chat/completions endpoint.
  // chatId: optional - if provided, registers stream in _streamRegistry for per-chat abort
  // conv:   optional - the conversation object to save when the stream finishes
  // useAppend is accepted for API compatibility but ignored (append was a WS-only method).
  async *streamChatIterable(params, chatId, useAppend = false, conv = null) {
    yield* this._streamChatIterableSSE(params, chatId, conv);
  }

  async *_streamChatIterableSSE(params, chatId, conv = null) {
    const controller = new AbortController();
    const artificialStream = {
      cancel: () => {
        controller.abort();
      }
    };
    
    // Register the SSE stream so it can be aborted via abortStream
    const entry = { stream: artificialStream, isAborted: false, conv };
    if (chatId) {
      this._streamRegistry.set(chatId, entry);
    }
    this._currentIterableStream = artificialStream;

    try {
      const url = `${this.restUrl}/v1/chat/completions`;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      };
      if (this.accessKey) {
        headers['Authorization'] = `Bearer ${this.accessKey}`;
      }

      // Defensive: Ensure sessionId is always set
      if (!this.sessionId) {
        console.warn('[GatewayClient] sessionId was missing, regenerating');
        this.sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      }

      const bodyParams = {
        ...params,
        stream: true,
        session_id: this.sessionId
      };

      console.log('[GatewayClient SSE] POST session_id:', this.sessionId, 'chatId:', chatId);
    if (this.onLog) this.onLog('Transport', 'Transport: SSE', { chatId, sessionId: this.sessionId });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyParams),
        signal: controller.signal
      });

      if (!response.ok) {
        let errStr = await response.text();
        yield { type: 'error', error: `HTTP ${response.status}: ${errStr}` };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      
      const aggregatedToolCalls = {};
      let reasoningContent = '';
      let thinkingSignature = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep partial line in buffer

        let currentEventName = '';
        
        for (const line of lines) {
          const tLine = line.trim();
          if (!tLine) {
            currentEventName = '';
            continue;
          }
          
          if (tLine.startsWith(':')) continue; // heartbeat comment

          if (tLine.startsWith('event:')) {
            currentEventName = tLine.substring(6).trim();
            continue;
          }
          
          if (tLine.startsWith('data:')) {
            const dataStr = tLine.substring(5).trim();
            if (dataStr === '[DONE]') continue;
            
            let dataObj;
            try {
              dataObj = JSON.parse(dataStr);
            } catch (e) { continue; }
            
            // Standard token/chunk event (starts without 'event:' or event: message)
            if (!currentEventName || currentEventName === 'message') {
              const delta = dataObj?.choices?.[0]?.delta;
              if (delta?.content !== undefined) {
                yield { type: 'delta', content: delta.content || '' };
              }
              if (delta?.reasoning_content !== undefined) {
                reasoningContent += delta.reasoning_content;
                yield { type: 'delta', reasoning_content: delta.reasoning_content || '' };
              }
              if (delta?.tool_calls) {
                delta.tool_calls.forEach(tc => {
                  if (!aggregatedToolCalls[tc.index]) {
                    aggregatedToolCalls[tc.index] = {
                      index: tc.index,
                      id: tc.id || `call_${tc.index}`,
                      type: tc.type || 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || ''
                      }
                    };
                  } else {
                    if (tc.function?.name) aggregatedToolCalls[tc.index].function.name += tc.function.name;
                    if (tc.function?.arguments) aggregatedToolCalls[tc.index].function.arguments += tc.function.arguments;
                  }
                });
                yield { type: 'delta', tool_calls: delta.tool_calls };
              }

              // Capture _thinking_signature from ANY chunk, not just the final one
              if (dataObj._thinking_signature) {
                thinkingSignature = dataObj._thinking_signature;
              }

              if (dataObj?.choices?.[0]?.finish_reason) {
                yield { 
                  type: 'done', 
                  finish_reason: dataObj.choices[0].finish_reason,
                  usage: dataObj?.usage || null,
                  context: dataObj?.context || null,
                  tool_calls: Object.keys(aggregatedToolCalls).length > 0 ? Object.values(aggregatedToolCalls) : null,
                  content: dataObj?.content || null,
                  reasoning_content: reasoningContent || null,
                  thinking_signature: thinkingSignature
                };
              }
            } 
            // Gateway specific compaction/progress events
            else if (currentEventName.startsWith('compaction.')) {
               yield { type: currentEventName.replace('.', '-'), data: dataObj };
            }
            else if (currentEventName === 'context.status') {
               yield { type: 'progress', data: { phase: 'context_stats', context: dataObj } };
            }
            else if (currentEventName === 'error') {
               yield { type: 'error', error: dataObj?.error?.message || dataObj.error || 'SSE Error' };
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        yield { type: 'aborted' };
      } else {
        yield { type: 'error', error: err.message };
      }
    } finally {
      if (chatId) {
        const entry = this._streamRegistry.get(chatId);
        const convToSave = entry?.conv;
        this._streamRegistry.delete(chatId);
        if (convToSave?.save) {
          convToSave.save();
        }
      }
      if (this._currentIterableStream === artificialStream) {
        this._currentIterableStream = null;
      }
    }
  }

  // Check if a specific chat has an active stream
  hasActiveStream(chatId) {
    return this._streamRegistry.has(chatId);
  }

  // Abort a specific chat's stream (used by multi-conversation)
  abortStream(chatId) {
    const entry = this._streamRegistry.get(chatId);
    if (entry) {
      entry.isAborted = true;
      entry.stream.cancel();
      this._streamRegistry.delete(chatId);
    }
  }

  abortCurrentIterableStream() {
    if (this._currentIterableStream) {
       this._currentIterableStream.cancel();
    }
  }

  /**
   * Update the session ID for tracking related requests.
   * Used when switching between conversations.
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }
}
