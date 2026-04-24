# LLM Gateway API Documentation v2.0

Complete API reference for the LLM Gateway v2.0 (model-centric, stateless architecture).

---

## Table of Contents

1. [API Design Philosophy](#api-design-philosophy)
2. [Response Patterns](#response-patterns)
3. [Endpoints Reference](#endpoints-reference)
4. [Task-Based Query System](#task-based-query-system)
5. [Ticket-Based API](#ticket-based-api)
6. [System Events](#system-events)
7. [Usage Patterns](#usage-patterns)
8. [Error Handling](#error-handling)
9. [Client Library Design](#client-library-design)

---

## API Design Philosophy

### Stateless Architecture

The gateway is **stateless**. Clients send full message history with each request. There is no session management, no `X-Session-Id` header, and no server-side conversation state.

### Unified Response Model

All chat requests go to one endpoint. By default, all responses are OpenAI-compatible `200 OK` — compaction is transparent. The `202` ticket flow is opt-in only via `X-Async: true` header.

| Prompt Size | Default Response | With `X-Async: true` |
|-------------|-----------------|----------------------|
| Fits in context | `200 OK` — immediate response | `200 OK` — immediate response |
| Exceeds context (≥`minTokensToCompact` AND > available tokens) | `200 OK` — server blocks, compacts transparently, then responds | `202 Accepted` — ticket created, client polls for result |

> **Note:** `minTokensToCompact` (default: 2000) is the minimum threshold for running the compaction algorithm, not the sole trigger. Both conditions must be met: token count ≥ threshold AND tokens exceed available context window.

### Unified Streaming

All streaming uses a single SSE connection:

```bash
POST /v1/chat/completions
{ "stream": true, "messages": [...] }

# Small prompt: tokens stream immediately
data: {"choices":[{"delta":{"content":"Hello"}}]}

# Large prompt (default): compaction progress events, then tokens
event: compaction.progress
data: {"chunk":1,"total":3}

data: {"choices":[{"delta":{"content":"The"}}]}

# With X-Async: true: returns 202 + ticket, client connects to task stream
```

> **Backpressure:** If the client reads slowly, SSE events buffer in memory. For long compaction jobs, the server emits periodic heartbeat comments (`: heartbeat`) to detect stale connections, and caps the internal event buffer to prevent memory exhaustion.

---

## Response Patterns

The LLM Gateway handles three distinct response patterns based on prompt size and headers:

### Pattern 1: Small Prompt → Immediate 200

For prompts that fit within the context window:

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

**Response:**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help you today?" }
  }]
}
```

### Pattern 2: Large Prompt → Transparent Compaction (200)

For oversized prompts, the gateway compacts automatically and returns 200:

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "...(45k tokens)..."}]
}
```

**Response:** Standard OpenAI format (compaction happens transparently on the server).

### Pattern 3: Large Prompt with Async (202 + Ticket)

For non-blocking large prompt processing:

```bash
POST /v1/chat/completions
Content-Type: application/json
X-Async: true

{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "...(45k tokens)..."}]
}
```

**Response:**
```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

## Endpoints Reference

### POST /v1/chat/completions

Main chat completion endpoint. Supports both streaming and non-streaming responses.

If `max_tokens` is omitted, the gateway derives a safe output budget from the model's configured `capabilities.contextWindow`, the estimated prompt size, and an internal safety margin. The resolved value is reported back in the response `context` payload.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |
| `X-Async` | `true` to get 202 + ticket for async processing | No |
| `Accept` | `text/event-stream` for streaming | No |

**Request Body:**

```json
{
  "model": "gemini-flash",
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Explain quantum computing"}
  ],
  "max_tokens": 1000,
  "temperature": 0.7,
  "stream": false,
  "strip_thinking": true,
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "response", "strict": true, "schema": {...} }
  },
  "image_processing": {
    "resize": "auto",
    "transcode": "webp",
    "quality": 85
  }
}
```

> **Thinking Stripper:** When `strip_thinking: true` (or `no_thinking: true`) is provided, and the model outputs reasoning/thinking tokens (like DeepSeek `<think>` blocks or native `reasoning_content`), the gateway will automatically strip the reasoning portion. This works seamlessly for both standard and streaming requests, ensuring clean JSON/markdown outputs.

> **Image Processing:** The `image_processing` field is optional. When provided, images in messages are fetched (remote URLs) and optionally resized/transcoded via MediaService. See [Vision (Image Input)](#vision-image-input) for complete examples.

**Response 200 (Small Prompt or Transparent Compaction):**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1739999999,
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." }
  }],
  "context": {
    "window_size": 1048576,
    "used_tokens": 2800,
    "available_tokens": 1045776,
    "strategy_applied": true,
    "resolved_max_tokens": 835060,
    "max_tokens_source": "implicit"
  }
}
```

`context.max_tokens_source` is `explicit` when the request supplied `max_tokens`, otherwise `implicit`.

**Response 202 (With `X-Async: true`):**

```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "accepted",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream"
}
```

---

### POST /v1/chat/completions (Streaming)

#### Small Prompt Streaming

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "gemini-flash", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

**Response:**
```
data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"...","choices":[{"delta":{"content":" world"}}]}

event: context.status
data: {"window_size":1048576,"used_tokens":2800,"available_tokens":1045776,"strategy_applied":false,"resolved_max_tokens":835060,"max_tokens_source":"implicit"}

data: [DONE]
```

#### Large Prompt Streaming (Transparent Compaction)

```bash
curl http://localhost:3400/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"model": "gemini-flash", "messages": [{"role": "user", "content": "...(45k tokens)"}], "stream": true}'
```

**Response:**
```
event: compaction.start
data: {"estimated_chunks":3}

event: compaction.progress
data: {"chunk":1,"total":3}

event: compaction.complete
data: {"original_tokens":45000,"final_tokens":2800}

data: {"id":"...","choices":[{"delta":{"content":"The"}}]}
data: {"id":"...","choices":[{"delta":{"content":" answer"}}]}

event: context.status
data: {"window_size":1048576,"used_tokens":2800,"available_tokens":1045776,"strategy_applied":true,"resolved_max_tokens":835060,"max_tokens_source":"implicit"}

data: [DONE]
```

> Compaction progress events are non-standard SSE events (prefixed with `compaction.`). Standard OpenAI SDKs will ignore them, receiving only the `data:` token chunks. Clients that understand compaction events get progress visibility for free.

If the HTTP client disconnects during streaming or before a non-streaming response completes, the gateway aborts the upstream provider request for fetch-based chat adapters instead of continuing generation in the background.

**Streaming Error Handling:**
```
event: error
data: {"ticket":"tkt_xxx","error":{"type":"provider_error","message":"Connection lost"}}
```

On error: connection closes, partial content discarded, client can retry.

---

### POST /v1/embeddings

Generate embeddings for text input.

```json
{
  "input": ["text to embed", "second text"],
  "model": "gemini-embedding"
}
```

**Response:**
```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "embedding": [0.0023, ...], "index": 0 }
  ],
  "model": "gemini-embedding",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

---

### GET /v1/models

List available models from config. Supports filtering by type.

```bash
GET /v1/models
GET /v1/models?type=chat
GET /v1/models?type=image
GET /v1/models?type=audio
GET /v1/models?type=video
GET /v1/models?type=embedding
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-flash",
      "object": "model",
      "owned_by": "gemini",
      "type": "chat",
      "capabilities": {
        "contextWindow": 1048576,
        "vision": true,
        "streaming": true
      }
    }
  ]
}
```

---

### POST /v1/images/generations

OpenAI-compatible image generation endpoint.

> **Note:** Currently synchronous (`200 OK`). Asynchronous mode with tickets is planned but not yet implemented.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |
| `X-Async` | `true` for async ticket-based processing (planned) | No |

**Request Body:**

```json
{
  "model": "dall-e-3",
  "prompt": "A cinematic cyberpunk street at night",
  "size": "1024x1024",
  "quality": "high",
  "n": 1,
  "response_format": "b64_json"
}
```

**Response 200:**

```json
{
  "created": 1739999999,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": "A cinematic cyberpunk street..."
    }
  ]
}
```

---

### POST /v1/audio/speech

OpenAI-compatible text-to-speech endpoint.

- Behavior is synchronous by default.
- Returns binary audio directly (`audio/mpeg`, `audio/wav`, etc.).

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |

**Request Body:**

```json
{
  "model": "tts-model",
  "input": "Welcome to the LLM Gateway",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1.0
}
```

**Response 200:**

- Binary audio body
- `Content-Type: audio/<format>`

---

### POST /v1/videos/generations

OpenAI-compatible video generation endpoint.

> **Note:** Currently synchronous (`200 OK`). Asynchronous mode with tickets is planned but not yet implemented.

**Headers:**

| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes |
| `X-Async` | `true` for async ticket-based processing (planned) | No |

**Request Body:**

```json
{
  "model": "video-model",
  "prompt": "A serene landscape with mountains and flowing rivers",
  "duration": 5,
  "resolution": "720p",
  "quality": "high"
}
```

**Response 200:**

```json
{
  "created": 1739999999,
  "data": [{ "url": "https://..." }]
}
```

---

### GET /v1/media/:filename

> **Not Implemented:** Media staging endpoint is planned but not yet available.
>
> Will serve staged media files for generated outputs when `mediaStorage.enabled=true`.

---

### GET /health

Health check endpoint with adapter status.

```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "version": "2.0.0",
  "adapters": {
    "gemini": {
      "state": "CLOSED",
      "failures": 0,
      "successes": 42,
      "lastFailure": null
    },
    "openai": {
      "state": "CLOSED",
      "failures": 0,
      "successes": 15,
      "lastFailure": null
    }
  },
  "models": ["gemini-flash", "local-llama", "openai-gpt4"]
}
```

---

### GET /help

Returns this API documentation rendered as HTML.

```bash
GET /help
```

---

## Task-Based Query System

Tasks provide semantic routing with preset parameters. Instead of specifying a model and tuning parameters for every request, clients reference a named task that encapsulates the model choice, system prompt, temperature, max tokens, and other defaults.

### How Tasks Work

1. Client sends a request with `"task": "task-name"`
2. Gateway looks up the task config and merges its defaults into the request
3. Client-supplied parameters **always override** task defaults
4. If the task defines a `systemPrompt`, it is prepended as the first system message

### GET /v1/tasks

List all available tasks.

```bash
GET /v1/tasks
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "query",
      "object": "task",
      "model": "minimax-chat",
      "description": "General query and conversation"
    },
    {
      "id": "inspect",
      "object": "task",
      "model": "minimax-chat",
      "description": "Code inspection and analysis"
    }
  ]
}
```

### Using Tasks in Chat Requests

```json
POST /v1/chat/completions
{
  "task": "synthesis",
  "messages": [{"role": "user", "content": "Summarize this article..."}],
  "temperature": 0.5
}
```

The `synthesis` task might define `model: "glm5-turbo-chat"`, `temperature: 0.3`, `maxTokens: 2048`. The client's `temperature: 0.5` overrides the task default, while `model` and `maxTokens` come from the task.

### Task Configuration

Tasks are defined in `config.json`:

```json
{
  "tasks": {
    "synthesis": {
      "model": "glm5-turbo-chat",
      "description": "Content synthesis and summarization",
      "systemPrompt": "Summarize the following content concisely.",
      "maxTokens": 2048,
      "temperature": 0.3
    },
    "inspect": {
      "model": "minimax-chat",
      "description": "Code inspection and analysis",
      "maxTokens": 8192,
      "temperature": 0.1,
      "stripThinking": false,
      "extraBody": {
        "chat_template_kwargs": {
          "enable_thinking": true
        }
      }
    }
  }
}
```

### Supported Task Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | **Required.** Model ID to route to |
| `description` | string | Human-readable description |
| `systemPrompt` | string | Prepended as first system message |
| `maxTokens` | number | Default output token limit |
| `temperature` | number | Sampling temperature (0-2) |
| `topP` | number | Nucleus sampling threshold (0-1) |
| `topK` | number | Top-K sampling limit |
| `stripThinking` | boolean | Override global thinking strip |
| `noThinking` | boolean | Disable model reasoning/thinking |
| `responseFormat` | object | Structured output configuration |
| `extraBody` | object | Adapter-specific passthrough params |
| `presencePenalty` | number | Presence penalty (-2.0 to 2.0) |
| `frequencyPenalty` | number | Frequency penalty (-2.0 to 2.0) |
| `seed` | number | Random seed for reproducibility |
| `stop` | array | Stop sequences |
| `extra_body` | object | Adapter-specific passthrough params (merged into upstream payload) |
| `enable_thinking` | boolean | Enable/disable model reasoning/thinking per-request |
| `chat_template_kwargs` | object | Direct passthrough to OpenAI-compatible endpoints (e.g., `{ enable_thinking: false }`) |

### Override Priority

```
final request = { ...taskDefaults, ...clientRequestBody }
```

Client parameters always win. If neither task nor client specifies a value, the model config or adapter default applies.

### Using Tasks with Other Endpoints

Tasks work with embeddings, image generation, and audio endpoints too:

```json
POST /v1/embeddings
{
  "task": "embed",
  "input": ["text to embed"]
}
```

```json
POST /v1/images/generations
{
  "task": "image",
  "prompt": "A cyberpunk city at night"
}
```

```json
POST /v1/audio/speech
{
  "task": "tts",
  "input": "Welcome to the gateway"
}
```

---

## Ticket-Based API

Used for:

- Chat requests when `X-Async: true` header is set
- Future: Image generation jobs (when async is implemented)
- Future: Video generation jobs (when async is implemented)

Without `X-Async`, compaction is transparent and no ticket is created.

### Query Task Status

```bash
GET /v1/tasks/tkt_xyz789
```

**Response:**
```json
{
  "object": "chat.completion.task",
  "ticket": "tkt_xyz789",
  "status": "complete",
  "estimated_chunks": 1,
  "stream_url": "/v1/tasks/tkt_xyz789/stream",
  "result": {
    "content": "The answer is...",
    "usage": {...}
  }
}
```

Notes:

- On first poll, the gateway logs `async_ticket_age_before_poll=<ms>` for observability.
- For failed tickets, response includes `error`.
- Tickets expire after 1 hour and are automatically cleaned up.

### Stream Task Progress

```bash
GET /v1/tasks/tkt_xyz789/stream
Headers: Accept: text/event-stream
```

Task stream emits SSE events:

```
// For streaming chat completions
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: [DONE]

// Status updates
event: status_update
data: {"status":"processing"}

// Completion (non-streaming)
event: completion.result
data: {"choices":[{...}], "usage": {...}}

// Errors
event: completion.error
data: {"error":"Provider connection failed"}
data: [DONE]
```

---

## System Events

Global SSE endpoint for monitoring gateway-wide events.

### GET /v1/system/events

Subscribe to system-level events: task lifecycle, compaction progress, routing metrics.

```bash
GET /v1/system/events
Headers: Accept: text/event-stream
```

**Event Types:**

| Event | Description |
|-------|-------------|
| `connected` | Initial connection acknowledgment |
| `task.created` | New async task created |
| `task.updated` | Task status changed |
| `compaction.started` | Context compaction began |
| `compaction.completed` | Context compaction finished |

**Example Stream:**
```
event: connected
data: {"message":"System events stream connected","timestamp":1739999999000}

event: task.created
data: {"ticket":"tkt_abc123","status":"accepted"}

event: compaction.started
data: {"ticket":"tkt_abc123","estimated_chunks":3}

event: compaction.completed
data: {"ticket":"tkt_abc123","original_tokens":45000,"final_tokens":2800}

event: task.updated
data: {"ticket":"tkt_abc123","status":"complete"}
```

> **Use Case:** Dashboards, monitoring tools, or clients that want real-time visibility into all gateway operations without polling individual tickets.

---

## Usage Patterns

### Model Resolution

| Use Case | Request | Resolution |
|----------|---------|------------|
| Default model | Omit `model` or use configured default | Uses `routing.defaultChatModel` from config |
| Specific model | `"model": "gemini-flash"` | Looks up model by ID in config |
| Task-based | `"task": "synthesis"` | Uses task's model + defaults, client overrides apply |
| List models | `GET /v1/models` | Returns flat list from config |
| List tasks | `GET /v1/tasks` | Returns list of configured tasks |

### Chat Completions

| Use Case | Implementation |
|----------|---------------|
| Small prompt | `200 OK` — immediate response |
| Large prompt (default) | `200 OK` — server compacts transparently, then responds |
| Large prompt (async) | `202 Accepted` — requires `X-Async: true` header |
| Streaming | Unified SSE (small=tokens, large=progress+tokens) |
| Structured output | `response_format: { type: "json_schema" }` — routed only to models with `structuredOutput` capability |
| Token constraints | `max_tokens` respected by all adapters |
| Thinking control | `enable_thinking` per-request or `extraBody` in config/task |
| Image processing | `image_processing: { resize, transcode, quality }` for automatic optimization |

### Thinking Control

Control whether models produce verbose reasoning/thinking output. Works per-request from both REST and WebSocket endpoints. All sources resolve to a single normalized `enable_thinking` field before reaching adapters.

**Resolution priority** (highest wins):
1. Request-level `enable_thinking`
2. Request-level `extra_body.chat_template_kwargs.enable_thinking`
3. Request-level `chat_template_kwargs.enable_thinking`
4. Config-level `extraBody.chat_template_kwargs.enable_thinking`
5. Adapter default (model decides)

**REST usage (OpenAI-compliant — via extra_body):**
```json
POST /v1/chat/completions
{
  "model": "my-llama-model",
  "extra_body": { "chat_template_kwargs": { "enable_thinking": false } },
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**REST usage (gateway convenience):**
```json
POST /v1/chat/completions
{
  "model": "my-llama-model",
  "enable_thinking": false,
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**WebSocket usage:**
```json
{ "method": "chat.create", "params": { "model": "my-llama-model", "enable_thinking": false, "messages": [...] } }
```

**Config default (applies when no request-level param is given):**
```json
"my-llama-model": {
  "adapter": "llamacpp",
  "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
}
```

**Task default:**
```json
"tasks": {
  "fast": { "model": "my-llama-model", "enable_thinking": false }
}
```

**Adapter translation:**

| Adapter | `enable_thinking` becomes |
|---------|--------------------------|
| `openai` | `chat_template_kwargs.enable_thinking` |
| `llamacpp` | `chat_template_kwargs.enable_thinking` |
| `lmstudio` | `chat_template_kwargs.enable_thinking` |
| `alibaba` | `enable_thinking` (top-level) |
| `ollama` | Not supported (native API) |
| `anthropic` | Not supported (different mechanism) |
| `gemini` | Not supported (different mechanism) |

### Vision (Image Input)

Send images to vision-capable models using OpenAI-compatible format.

**Basic Vision Request:**

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What's in this image?" },
      {
        "type": "image_url",
        "image_url": {
          "url": "https://example.com/image.jpg",
          "detail": "auto"
        }
      }
    ]
  }]
}
```

**With Base64 Image:**

```json
{
  "model": "gemini-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      {
        "type": "image_url",
        "image_url": {
          "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
        }
      }
    ]
  }]
}
```

**With Image Processing:**

```json
{
  "model": "gemini-flash",
  "messages": [...],
  "image_processing": {
    "resize": "auto",
    "transcode": "jpg",
    "quality": 85
  }
}
```

| Parameter | Description |
|-----------|-------------|
| `detail` | `"auto"` (default), `"low"` (512px), `"high"` (max resolution) |
| `resize` | `"auto"` (model limit), `"low"` (512px), `"high"` (max), or number (max pixels) |
| `transcode` | `"jpg"`, `"png"`, `"webp"` - converts image format |
| `quality` | 1-100, for lossy formats (default: 85) |

**Notes:**
- The gateway fetches remote URLs automatically
- Private IP addresses are blocked for security - use base64 for local images
- MediaService resizes while preserving aspect ratio
- Only models with `capabilities.vision: true` support image inputs

### Media Generation

| Use Case | Implementation |
|----------|---------------|
| Text-to-image | `POST /v1/images/generations` — currently sync (`200`) |
| Text-to-speech | `POST /v1/audio/speech` — returns synchronous binary audio |
| Text-to-video | `POST /v1/videos/generations` — currently sync (`200`) |
| Async image/video | Planned — will use `202 + ticket` pattern |
| Provider mismatch | Router enforces capability flags (type must match) |

### Tool Use / Function Calling

The gateway supports OpenAI-spec compliant tool use (function calling) across both REST and streaming endpoints. This enables coding assistants, agents, and other tool-calling clients to work through the gateway transparently.

**Request with tools:**

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [{"role": "user", "content": "List files in the project"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a bash command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "The command to run" }
          },
          "required": ["command"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

**Non-streaming response with tool calls:**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "model": "gemini-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "refusal": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "bash",
          "arguments": "{\"command\":\"ls -la\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "system_fingerprint": null,
  "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 }
}
```

**Streaming tool calls** are emitted as incremental `delta.tool_calls` chunks following the OpenAI SSE format:

```
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls -la\"}"}}]},"finish_reason":"tool_calls"}]}
data: [DONE]
```

**Returning tool results** for the next turn:

```json
POST /v1/chat/completions
{
  "model": "gemini-flash",
  "messages": [
    {"role": "user", "content": "List files in the project"},
    {"role": "assistant", "content": null, "tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "bash", "arguments": "{\"command\":\"ls -la\"}"}}]},
    {"role": "tool", "tool_call_id": "call_abc123", "content": "file1.txt\nfile2.txt\nREADME.md"}
  ]
}
```

**Supported parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tools` | array | Tool definitions (OpenAI format) |
| `tool_choice` | string/object | `"auto"`, `"none"`, `"required"`, or `{ type: "function", function: { name: "..." } }` |
| `parallel_tool_calls` | boolean | Allow multiple tool calls in one response |
| `functions` | array | Legacy function calling (deprecated, forwarded as-is) |
| `function_call` | string/object | Legacy function call control (deprecated, forwarded as-is) |

**Adapter support:**

| Adapter | Tool Support | Notes |
|---------|-------------|-------|
| `openai` | Direct passthrough | OpenAI, xAI, and compatible providers |
| `anthropic` | Format conversion | OpenAI tools ↔ Claude tool_use |
| `gemini` | Format conversion | OpenAI tools ↔ Gemini functionDeclarations |
| `kimi` | Direct passthrough | OpenAI-compatible API |
| `ollama` | Direct passthrough | Model-dependent |
| `lmstudio` | Direct passthrough | OpenAI-compatible |
| `llamacpp` | Variable | Model/build dependent |

**Response normalization:** All non-streaming tool-call responses include `refusal: null`, `function_call: null`, `tool_calls: null` (when absent), `annotations: []`, and `system_fingerprint: null` for strict client compatibility (OpenAI SDK, VS Code extensions).

---

## Error Handling

| Code | Meaning |
|------|---------|
| 200 | Success (small prompt or transparent compaction complete) |
| 202 | Accepted (async ticket created) |
| 400 | Bad request (wrong model type, missing fields) |
| 404 | Model not found |
| 413 | Payload too large (even after compaction or compaction disabled) |
| 429 | Rate limit or queue full |
| 502 | Provider unavailable |
| 503 | Circuit breaker open |
| 504 | Timeout |

---

## Client Library Design

The ticket system is designed to be abstracted by a client library. Here's the recommended pattern:

### Conceptual API

```javascript
const client = new GatewayClient({ 
  baseUrl: 'http://localhost:3400',
  autoAsync: { threshold: 10000 }  // Auto-use X-Async when >10k tokens
});

// Simple usage — library handles complexity
const response = await client.chat({
  model: 'gemini-flash',
  messages: conversationHistory,
  onProgress: (chunk) => updateUI(chunk)
});

// Explicit async mode
const ticket = await client.chatAsync({
  model: 'gemini-flash',
  messages: veryLargeHistory
});

// Poll with exponential backoff
const result = await ticket.wait({ 
  pollInterval: 500,
  maxWait: 60000 
});

// Or stream progress
for await (const event of ticket.stream()) {
  if (event.type === 'chunk') updateUI(event.data);
  if (event.type === 'status_update') updateStatus(event.status);
}
```

### Library Responsibilities

| Concern | Implementation |
|---------|---------------|
| **Token Estimation** | Estimate payload size client-side to decide sync vs async |
| **Polling Strategy** | Exponential backoff with jitter for `/v1/tasks/:id` |
| **Stream Reconnection** | Auto-reconnect SSE streams with backoff on disconnect |
| **Event Aggregation** | Subscribe to `/v1/system/events` for multi-task monitoring |
| **Error Recovery** | Retry with circuit breaker awareness |

---

## Configuration

### Model Definition

```json
{
  "models": {
    "model-id": {
      "type": "chat",
      "adapter": "gemini",
      "endpoint": "https://...",
      "apiKey": "${ENV_VAR}",
      "adapterModel": "provider-model-name",
      "capabilities": {
        "contextWindow": 1048576,
        "vision": true,
        "structuredOutput": "json_schema",
        "streaming": true
      },
      "imageInputLimit": {
        "maxDimension": 2048
      }
    }
  }
}
```

### Model Types

- `chat` - Chat completion models
- `embedding` - Text embedding models
- `image` - Image generation models
- `audio` - Audio/speech generation models
- `video` - Video generation models

### Capability Fields

**Chat Models:**
- `contextWindow` (number) - Maximum context window in tokens
- `vision` (boolean) - Supports image inputs
- `structuredOutput` (boolean | string) - Supports JSON output
- `streaming` (boolean) - Supports streaming responses

**Embedding Models:**
- `contextWindow` (number) - Maximum input tokens
- `dimensions` (number) - Output embedding dimensions

**Image Models:**
- `maxResolution` (string) - Maximum image resolution
- `supportedFormats` (array) - Supported output formats

**Audio Models:**
- `maxDuration` (number) - Maximum audio duration in seconds
- `supportedFormats` (array) - Supported output formats

**Video Models:**
- `maxDuration` (number) - Maximum video duration in seconds
- `maxResolution` (string) - Maximum video resolution (e.g., "1080p")

---

## Migration from v1.x

### Removed Features

- **Sessions** - No `X-Session-Id` header, no session endpoints
- **Provider-centric routing** - Models are referenced by ID, not `provider:model`
- **Capability inference** - All capabilities explicitly declared

### Config Changes

**v1.x:**
```json
{
  "providers": {
    "gemini": {
      "type": "gemini",
      "model": "gemini-flash"
    }
  }
}
```

**v2.0:**
```json
{
  "models": {
    "gemini-flash": {
      "type": "chat",
      "adapter": "gemini",
      "capabilities": {...}
    }
  }
}
```

### Client Changes

**v1.x:**
```javascript
// Create session, then use X-Session-Id
const session = await fetch('/v1/sessions', {method: 'POST'});
await fetch('/v1/chat/completions', {
  headers: {'X-Session-Id': session.id}
});
```

**v2.0:**
```javascript
// Send full history each time
await fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: fullHistory
  })
});

// Or use async mode for large payloads
await fetch('/v1/chat/completions', {
  headers: {'X-Async': 'true'},
  body: JSON.stringify({
    model: 'gemini-flash',
    messages: veryLargeHistory
  })
});
// Then poll /v1/tasks/{ticket} or stream /v1/tasks/{ticket}/stream
```
