// src/websocket/client-sdk.js
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

export class ChatStream extends EventEmitter {
  constructor(client, requestId) {
    super();
    this.client = client;
    this.requestId = requestId;
  }

  cancel() {
    this.client._send('chat.cancel', { request_id: this.requestId });
  }

  // Handle server's cancel acknowledgment - emit 'done' so iterator terminates
  _onCancel() {
    this.emit('cancel', {});
  }
}

export class GatewayClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const base = options.baseUrl || 'http://localhost:3400';
    this.restUrl = base;
    this.wsUrl = base.replace(/^http/, 'ws') + '/v1/realtime';
    
    this.accessKey = options.accessKey || '';
    // Auto-generate session ID for tracking related requests (e.g., for Kimi CLI Adapter)
    this.sessionId = options.sessionId || `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    
    // Operation mode: 'websocket' or 'sse'
    this.operationMode = options.operationMode || 'websocket';
    this.socket = null;
    this.streams = new Map();
    this._streamRegistry = new Map(); // chatId -> { stream, isAborted }
    this.pendingRequests = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectActive = false;
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
  // WebSocket Methods
  // ==========================================

  connect() {
    if (this.socket) return Promise.resolve();

    return new Promise((resolve, reject) => {
      // Use global WebSocket for browser, or require('ws') for Node
      const isBrowser = typeof window !== 'undefined';
      const WS = isBrowser ? window.WebSocket : require('ws');
      
      const headers = this.accessKey ? { 'Authorization': `Bearer ${this.accessKey}` } : {};
      
      // Native browser WebSocket does not support the options object (headers). 
      // In a real scenario for browsers, auth should be passed via URL params or initial message.
      if (isBrowser) {
        this.socket = new WS(this.wsUrl);
      } else {
        this.socket = new WS(this.wsUrl, { headers });
      }

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.reconnectActive = false;
        
        // Initialize session
        this._send('session.initialize', {}, 'init')
          .then((result) => resolve(result))
          .catch(reject);
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this._handleMessage(data);
        } catch (e) {
          // ignore binary for this simplified SDK
        }
      };

      this.socket.onclose = (event) => {
        this.socket = null;
        this.emit('disconnected', event.code, event.reason);
        this._attemptReconnect();
      };

      this.socket.onerror = (error) => {
        if (!this.reconnectActive) {
          reject(error);
        }
      };
    });
  }

  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectActive = true;
    this.reconnectAttempts++;
    
    // Exponential backoff with jitter
    const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000);
    const jitter = Math.random() * 500;
    
    this.emit('reconnect', this.reconnectAttempts);
    
    setTimeout(() => {
      this.connect().catch(() => {}); // catch handled by onerror/onclose loops
    }, delay + jitter);
  }

  _handleMessage(message) {
    if (message.error && message.id && this.pendingRequests.has(message.id)) {
      this.pendingRequests.get(message.id).reject(new Error(message.error.message || 'Unknown error'));
      this.pendingRequests.delete(message.id);
      return;
    }

    if (message.result && message.id && this.pendingRequests.has(message.id)) {
      this.pendingRequests.get(message.id).resolve(message.result);
      this.pendingRequests.delete(message.id);
      return;
    }

    if (message.method) {
      const requestId = message.params?.request_id;
      const stream = this.streams.get(requestId);
      
      if (!stream) return;

      if (message.method === 'chat.progress') {
        stream.emit('progress', message.params);
      } else if (message.method === 'chat.delta') {
        stream.emit('delta', message.params);
      } else if (message.method === 'chat.done') {
        stream.emit('done', message.params);
        this.streams.delete(requestId);
      } else if (message.method === 'chat.error') {
        console.log('[GatewayClient] Received chat.error:', message.params.error);
        stream.emit('error', message.params.error);
        this.streams.delete(requestId);
      }
    }
  }

  _send(method, params = {}, explicitId = null) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) { // 1 = OPEN
        return reject(new Error('WebSocket not connected'));
      }

      const id = explicitId || `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      
      this.pendingRequests.set(id, { resolve, reject });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.socket.send(JSON.stringify(message));
    });
  }

  _createStream(method, params) {
    const requestId = `chat-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const stream = new ChatStream(this, requestId);
    
    this.streams.set(requestId, stream);
    
    // Defensive: Ensure sessionId is always set
    if (!this.sessionId) {
      console.warn('[GatewayClient] sessionId was missing, regenerating');
      this.sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }
    
    const paramsWithSession = { ...params, request_id: requestId, session_id: this.sessionId };
    
    this.connect()
      .then(() => {
        return this._send(method, paramsWithSession, requestId);
      })
      .catch((err) => stream.emit('error', err));
      
    return stream;
  }

  chatStream(params) {
    return this._createStream('chat.create', params);
  }

  chatAppendStream(params) {
    return this._createStream('chat.append', params);
  }

  // Modern Async Iterator natively in the SDK
  // chatId: optional - if provided, registers stream in _streamRegistry for per-chat abort
  // conv: optional - the conversation object to save when the stream finishes
  async *streamChatIterable(params, chatId, useAppend = false, conv = null) {
    if (this.operationMode === 'sse') {
      yield* this._streamChatIterableSSE(params, chatId, conv);
      return;
    }

    let resolveNext;
    let nextPromise = new Promise(r => resolveNext = r);
    const eventQueue = [];
    const pushEvent = (evt) => {
      eventQueue.push(evt);
      resolveNext();
      nextPromise = new Promise(r => resolveNext = r);
    };

    const stream = useAppend
      ? this.chatAppendStream({...params, stream: true})
      : this.chatStream({...params, stream: true});
    let isAborted = false;
    let wsReasoningContent = '';

    // Register stream for per-chat abort support
    const entry = { stream, isAborted: false, conv };
    if (chatId) {
      this._streamRegistry.set(chatId, entry);
    }
    // Also attach to _currentIterableStream for backward compatibility
    this._currentIterableStream = stream;

    stream.on('delta', (data) => {
      const delta = data?.choices?.[0]?.delta;
      if (delta?.content !== undefined) {
        pushEvent({ type: 'delta', content: delta.content || '' });
      }
      if (delta?.reasoning_content !== undefined) {
        wsReasoningContent += delta.reasoning_content;
        pushEvent({ type: 'delta', reasoning_content: delta.reasoning_content || '' });
      }
      if (delta?.tool_calls) {
        pushEvent({ type: 'delta', tool_calls: delta.tool_calls });
      }
    });

    stream.on('progress', (data) => pushEvent({ type: 'progress', data }));

    stream.on('done', (data) => {
      const doneReasoning = data?.reasoning_content || wsReasoningContent || null;
      const doneSignature = data?.thinking_signature ?? null;
      pushEvent({ 
        type: 'done', 
        usage: data?.telemetry?.usage ?? data?.usage ?? null, 
        context: data?.context ?? null,
        finish_reason: data?.finish_reason ?? null,
        tool_calls: data?.tool_calls ?? null,
        content: data?.content ?? null,
        reasoning_content: doneReasoning,
        thinking_signature: doneSignature
      });
    });
    
    stream.on('error', (err) => {
      if (!isAborted) {
        const errorMessage = typeof err === 'string' ? err : (err.message || 'Stream error');
        console.log('[GatewayClient] Stream error event:', errorMessage);
        pushEvent({ type: 'error', error: errorMessage });
      }
    });

    // Handle cancel acknowledgment from server - ensures iterator terminates and finally runs
    stream.on('cancel', () => {
      pushEvent({ type: 'aborted' });
    });

    try {
      while (true) {
        if (eventQueue.length === 0) await nextPromise;
        const evt = eventQueue.shift();
        if (evt) {
          yield evt;
          if (evt.type === 'done' || evt.type === 'error' || evt.type === 'aborted') break;
        }
      }
    } finally {
      // Save the correct conversation (stored per-stream) before cleaning up
      if (chatId) {
        const entry = this._streamRegistry.get(chatId);
        const convToSave = entry?.conv;
        this._streamRegistry.delete(chatId);
        if (convToSave?.save) {
          convToSave.save();
        }
      }
      if (this._currentIterableStream === stream) {
        this._currentIterableStream = null;
      }
    }
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

      const bodyParams = {
        ...params,
        stream: true
      };

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

              if (dataObj?.choices?.[0]?.finish_reason) {
                if (dataObj._thinking_signature) {
                  thinkingSignature = dataObj._thinking_signature;
                }
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

  async chat(params, useAppend = false) {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      const stream = useAppend ? this.chatAppendStream(params) : this.chatStream(params);
      
      stream.on('delta', (data) => {
        if (data.choices && data.choices[0] && data.choices[0].delta.content) {
          fullContent += data.choices[0].delta.content;
        }
      });
      
      stream.on('done', (data) => {
        resolve({ 
          content: fullContent,
          usage: data?.telemetry?.usage ?? data?.usage ?? null,
          context: data?.context ?? null
        });
      });
      
      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  // ==========================================
  // Session / Utility Methods
  // ==========================================

  async ping() {
    await this.connect();
    return this._send('ping');
  }

  async updateSettings(settings) {
    await this.connect();
    return this._send('settings.update', settings);
  }

  // ==========================================
  // Audio Streaming Methods
  // ==========================================

  async startAudioStream(direction = 'duplex') {
    await this.connect();
    return this._send('audio.start', { direction });
  }

  async stopAudioStream(streamId) {
    await this.connect();
    return this._send('audio.stop', { stream_id: streamId });
  }

  async sendVadEvent(streamId, eventType) {
    await this.connect();
    return this._send('audio.vad', { stream_id: streamId, event: eventType });
  }

  sendAudioBinary(streamId, sequenceNum, rawBinaryData, timestamp = Date.now()) {
    this._sendBinary(streamId, sequenceNum, rawBinaryData, timestamp);
  }

  // ==========================================
  // Media Streaming Methods
  // ==========================================

  async startMediaStream(mimeType = 'application/octet-stream', streamId = null) {
    await this.connect();
    const params = { mime_type: mimeType };
    if (streamId) params.stream_id = streamId;
    return this._send('media.start', params);
  }

  async stopMediaStream(streamId) {
    await this.connect();
    return this._send('media.stop', { stream_id: streamId });
  }

  sendMediaBinary(streamId, sequenceNum, rawBinaryData, timestamp = Date.now()) {
    this._sendBinary(streamId, sequenceNum, rawBinaryData, timestamp);
  }

  // ==========================================
  // Shared Binary Transport
  // ==========================================

  _sendBinary(streamId, sequenceNum, rawBinaryData, timestamp) {
    if (!this.socket || this.socket.readyState !== 1) { // 1 = OPEN
      throw new Error('WebSocket not connected');
    }

    const header = JSON.stringify({
      s: streamId,
      t: timestamp,
      seq: sequenceNum
    });

    const isBrowser = typeof window !== 'undefined';
    const textEncoder = isBrowser ? new TextEncoder() : new (require('util').TextEncoder)();
    
    // Encode header and append null byte
    const headerBytes = textEncoder.encode(header + '\x00');
    
    // Combine header and raw binary data
    const payload = new Uint8Array(headerBytes.length + rawBinaryData.length);
    payload.set(headerBytes);
    payload.set(new Uint8Array(rawBinaryData), headerBytes.length);

    this.socket.send(payload);
  }

  close() {
    if (this.socket) {
      this.maxReconnectAttempts = 0; // Prevent reconnection
      this.socket.close();
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
