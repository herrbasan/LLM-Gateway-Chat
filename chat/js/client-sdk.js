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
}

export class GatewayClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const base = options.baseUrl || 'http://localhost:3400';
    this.restUrl = base;
    this.wsUrl = base.replace(/^http/, 'ws') + '/v1/realtime';
    
    this.accessKey = options.accessKey || '';
    this.socket = null;
    this.streams = new Map();
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

      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }));
    });
  }

  _createStream(method, params) {
    const requestId = `chat-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const stream = new ChatStream(this, requestId);
    
    this.streams.set(requestId, stream);
    
    this.connect()
      .then(() => {
        return this._send(method, { ...params, request_id: requestId }, requestId);
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
  async *streamChatIterable(params, useAppend = false) {
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

    // We attach an abort method directly so consumers can cancel it
    this._currentIterableStream = stream;

    stream.on('delta', (data) => {
      if (data?.choices?.[0]?.delta?.content !== undefined) {
        pushEvent({ type: 'delta', content: data.choices[0].delta.content || '' });
      }
    });

    stream.on('progress', (data) => pushEvent({ type: 'progress', data }));

    stream.on('done', (data) => pushEvent({ 
      type: 'done', 
      usage: data?.telemetry?.usage ?? data?.usage ?? null, 
      context: data?.context ?? null 
    }));
    
    stream.on('error', (err) => {
      if (!isAborted) pushEvent({ type: 'error', error: err.message || 'Stream error' });
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
      if (this._currentIterableStream === stream) {
        this._currentIterableStream = null;
      }
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
}
