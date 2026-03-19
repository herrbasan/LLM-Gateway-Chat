# LLM Gateway WebSocket API Documentation

## WebSocket Real-Time API

The WebSocket real-time mode provides a high-performance, bi-directional channel using JSON-RPC 2.0. It is designed for low-latency conversational agents and applications that need stream multiplexing, message interruption (cancellation), and binary audio streaming.

**Endpoint:**
```
ws://localhost:3400/v1/realtime
```
> **Security:** By default, WebSocket access is restricted to local/internal IP addresses only (`WS_LOCAL_ONLY=true`). Local connections (`127.0.0.1`, `::1`) are auto-authenticated.
> 
> You can whitelist trusted IP ranges in `config.json` via:
> `"ws": { "whitelistIps": ["192.168.0.*", "10.0.*"] }`
> Any connections coming from these IPs bypass the global `accessKey` requirements entirely, allowing frictionless private network use.

### Authentication
Authentication can be done via HTTP upgrade headers (preferred) or via the first `session.initialize` message.

> **Important Security Note:** The `GATEWAY_ACCESS_KEY` mentioned below is a **Gateway Access Key** (used to secure access to the Gateway itself when `WS_LOCAL_ONLY` is disabled). It is **not** an OpenAI, Gemini, or provider API key. You should never expose your actual provider keys to clients. The Gateway securely stores the provider keys internal to its configuration and auto-injects them into upstream requests.

**Via Upgrade Header:**
```javascript
const ws = new WebSocket('ws://localhost:3400/v1/realtime', {
  headers: { 'Authorization': 'Bearer GATEWAY_ACCESS_KEY' }
});
```

**Via session.initialize (if upgrade headers are impossible):**
```json
{
  "jsonrpc": "2.0",
  "id": "auth-1",
  "method": "session.initialize",
  "params": {
    "access_key": "GATEWAY_ACCESS_KEY"
  }
}
```

### JSON-RPC Commands

#### `chat.create`
Initiates a new chat completion stream. 

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }
}
```

**Responses:** Server streams multiple `chat.delta` notifications, followed by `chat.done`.

```json
// Server -> Client
{"jsonrpc": "2.0", "method": "chat.progress", "params": {"request_id": "req-1", "phase": "routing"}}
{"jsonrpc": "2.0", "method": "chat.delta", "params": {"request_id": "req-1", "choices": [{"index": 0, "delta": {"content": "Hello! "}}]}}
{"jsonrpc": "2.0", "method": "chat.done", "params": {"request_id": "req-1", "cancelled": false}}
```

If `max_tokens` is omitted from `params`, the gateway resolves a safe output budget automatically and reports it in the `chat.progress` `context_stats` payload.

#### `chat.append`
Efficient incremental context update using a connection-scoped buffer. Appends only the new message to avoid sending massive context histories repeatedly.

```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "method": "chat.append",
  "params": {
    "model": "gemini-flash",
    "message": {"role": "user", "content": "What's next?"}
  }
}
```

#### `chat.cancel`
Cancels an ongoing generation stream.

```json
{
  "jsonrpc": "2.0",
  "id": "cancel-1",
  "method": "chat.cancel",
  "params": {"request_id": "req-1"}
}
```

The cancellation target is the original `chat.create` or `chat.append` request ID. On success, the server stops streaming, aborts the upstream provider request, and finishes with:

```json
{"jsonrpc": "2.0", "method": "chat.done", "params": {"request_id": "req-1", "cancelled": true, "telemetry": {"total_duration_ms": 1234}}}
```

There is no separate acknowledgement response for `chat.cancel`; `chat.done` with `cancelled: true` is the completion signal.

### Stream Notifications

During an active request, the server can emit these JSON-RPC notifications:

- `chat.progress`: lifecycle and context updates such as `routing`, `model_routed`, `context`, `context_stats`, `network_throttled`, and `reasoning_started`
- `chat.delta`: streamed token chunks in OpenAI-compatible `choices[].delta` shape
- `chat.done`: terminal event with `cancelled: false` or `cancelled: true`
- `chat.error`: terminal error event

Example `context_stats` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "chat.progress",
  "params": {
    "request_id": "req-1",
    "phase": "context_stats",
    "context": {
      "window_size": 1048576,
      "used_tokens": 2800,
      "available_tokens": 1045776,
      "strategy_applied": false,
      "resolved_max_tokens": 835060,
      "max_tokens_source": "implicit"
    }
  }
}
```

### Binary Audio Protocol

For high-performance audio transmission without Base64 overhead, use the header-prefixed binary frames.

#### `audio.start`
Negotiates format and opens an audio stream.

```json
{
  "jsonrpc": "2.0",
  "id": "audio-open",
  "method": "audio.start"
}
```
*Server replies with a format map including `stream_id` and the negotiated format (e.g., PCM16 or Opus).*

**Sending Binary Frames:**
Combine a JSON header (null-byte terminated) with a raw audio payload:
```
{"s":"stream_id", "t": 1705312200000, "seq": 1}\x00[RAW BINARY DATA]
```

#### `audio.stop`
Closes the audio stream.

```json
{
  "jsonrpc": "2.0",
  "id": "audio-close",
  "method": "audio.stop",
  "params": {"stream_id": "stream_id"}
}
```

### Sending Images & Files

Currently, raw binary WebSocket frames are reserved exclusively for the high-performance **Audio Protocol**.

To send images or files via the WebSocket interface, you must include them as standard OpenAI-compatible base64 payloads or remote URLs mapped directly inside your JSON-RPC `chat.create` or `chat.append` requests.

**Example Base64 Image:**
```json
{
  "jsonrpc": "2.0",
  "id": "img-req-1",
  "method": "chat.create",
  "params": {
    "model": "gemini-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is in this image?" },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
            }
          }
        ]
      }
    ]
  }
}
```
*Note: Due to JSON serialization overhead, very large base64 image strings may impact WebSocket responsiveness briefly compared to the dedicated HTTP REST API.*

---