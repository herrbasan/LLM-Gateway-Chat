# LLM Gateway Chat — Tool Use Migration Guide

The LLM Gateway now supports OpenAI-spec compliant tool use (`tools`, `tool_choice`, `tool_calls`) natively across both REST and WebSocket endpoints. The Chat app's current `__TOOL_CALL__` text-based approach can be replaced with structured tool calls.

---

## Current Architecture (Hacky)

The Chat app implements tool calling through **text parsing**:

1. **`mcp-client.js:generateToolPrompt()`** — injects a system prompt telling the LLM to output `__TOOL_CALL__({"name": "...", "args": {...}})` syntax
2. **`chat.js`** — during streaming, detects `__TOOL_CALL__` in the accumulated text buffer via regex
3. **`conversation.js:getMessagesForApi()`** — serializes tool exchanges back into the message history as fake `assistant` + `user` messages containing the `__TOOL_CALL__` text and `<tool_result>` XML
4. **`client-sdk.js`** — the SDK only extracts `delta.content` from streaming chunks; it has no awareness of `tool_calls`

**Problems with this approach:**
- Relies on the LLM faithfully outputting a specific text pattern (brittle, model-dependent)
- Consumes output tokens on the tool call syntax itself
- Cannot leverage provider-native tool calling (Gemini functionDeclarations, Claude tool_use, etc.)
- No `tool_choice` or `parallel_tool_calls` control
- Broken with models that don't follow the text pattern reliably

---

## Target Architecture (OpenAI-spec Structured Tools)

### What the Gateway Now Provides

The gateway's WebSocket endpoint now:

1. **Accepts `tools`** in `chat.create` / `chat.append` params — forwarded to the model adapter
2. **Streams `delta.tool_calls`** chunks in `chat.delta` — each chunk carries `{index, id, type, function: {name, arguments}}`
3. **Returns aggregated `tool_calls`** in `chat.done` — no need to reconstruct from deltas
4. **Accepts `role: "tool"` messages** — preserved in `conversationBuffer` for multi-turn
5. **Respects `tool_choice`** and `parallel_tool_calls` parameters

### `chat.done` New Fields

```json
{
  "request_id": "req-1",
  "cancelled": false,
  "finish_reason": "tool_calls",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"config.json\"}"
      }
    }
  ],
  "context": {...},
  "telemetry": {...}
}
```

When no tools are called: `tool_calls: null`, `content: "text response"`, `finish_reason: "stop"`.

---

## Required Changes

### 1. `client-sdk.js` — Add tool_calls to `streamChatIterable`

**Current** (line ~300): Only extracts `delta.content`:
```js
stream.on('delta', (data) => {
  if (data?.choices?.[0]?.delta?.content !== undefined) {
    pushEvent({ type: 'delta', content: data.choices[0].delta.content || '' });
  }
});
```

**Add**: Also forward `delta.tool_calls`:
```js
stream.on('delta', (data) => {
  const delta = data?.choices?.[0]?.delta;
  if (delta?.content !== undefined) {
    pushEvent({ type: 'delta', content: delta.content || '' });
  }
  if (delta?.tool_calls) {
    pushEvent({ type: 'delta', tool_calls: delta.tool_calls });
  }
});
```

**Also in `done` handler**: Surface `tool_calls` and `finish_reason`:
```js
stream.on('done', (data) => pushEvent({ 
  type: 'done', 
  usage: data?.telemetry?.usage ?? data?.usage ?? null,
  context: data?.context ?? null,
  finish_reason: data?.finish_reason ?? null,
  tool_calls: data?.tool_calls ?? null,
  content: data?.content ?? null
}));
```

### 2. `mcp-client.js` — Replace `generateToolPrompt()` with `getFormattedToolsForLLM()`

**Current**: `generateToolPrompt()` returns a text block instructing the LLM to use `__TOOL_CALL__` syntax.

**Change**: Remove `generateToolPrompt()` entirely. The `getFormattedToolsForLLM()` method already returns the correct OpenAI `tools` array format:
```js
// Already exists - returns OpenAI tools format
getFormattedToolsForLLM() {
    return this.availableTools.map(tool => ({
        type: "function",
        function: {
            name: tool.llmName,
            description: tool.definition.description,
            parameters: tool.definition.inputSchema
        }
    }));
}
```

This array gets passed as `params.tools` to `chatStream()` / `chatAppendStream()`.

### 3. `chat.js` — Pass tools to the gateway request

**Current** (around line 1207): System prompt injection with `__TOOL_CALL__` instructions:
```js
const mcpPrompt = mcpClient.generateToolPrompt(excludedToolPrefixes);
const allMcpTools = mcpClient.getFormattedToolsForLLM();
// mcpPrompt goes into system prompt, tools are NOT sent to gateway
```

**Change**: Send tools as a structured parameter, remove prompt injection:
```js
const tools = mcpClient.getFormattedToolsForLLM();

// Filter out excluded tools (vision etc.)
const filteredTools = excludedToolPrefixes.length > 0
    ? tools.filter(t => !excludedToolPrefixes.some(p => 
        t.function?.name?.toLowerCase().startsWith(p.toLowerCase())))
    : tools;

// Pass to gateway as params.tools
const streamParams = {
    model: selectedModel,
    messages: conv.getMessagesForApi(systemPrompt),
    tools: filteredTools.length > 0 ? filteredTools : undefined,
    tool_choice: filteredTools.length > 0 ? 'auto' : undefined
};
```

### 4. `chat.js` — Detect tool calls from `chat.done`, not text parsing

**Current** (lines 1250-1353): Regex scanning of accumulated text buffer for `__TOOL_CALL__`:
```js
const TOOL_CALL_REGEX = /__TOOL_CALL__\(([\\s\\S]*?)\\)\\s*$/;
// ... scans contentBuffer during streaming ...
const toolMatch = contentBuffer.match(TOOL_CALL_REGEX);
```

**Change**: Listen for `finish_reason: "tool_calls"` in the `done` event:
```js
// In streamResponse iterator:
for await (const evt of client.streamChatIterable(params, chatId, useAppend, conv)) {
    if (evt.type === 'delta') {
        if (evt.content !== undefined) {
            // Accumulate text as before
            conv.updateAssistantResponse(exchangeId, evt.content);
        }
        // tool_calls deltas can be shown in UI as "calling tool..." if desired
    }
    
    if (evt.type === 'done') {
        if (evt.finish_reason === 'tool_calls' && evt.tool_calls?.length > 0) {
            // Execute tools via MCP
            for (const tc of evt.tool_calls) {
                const args = JSON.parse(tc.function.arguments);
                handleToolExecution(exchangeId, {
                    name: tc.function.name,
                    args: args,
                    id: tc.id  // needed for role: "tool" messages
                }, chatId);
            }
            return; // Don't finalize — tool execution will continue the loop
        }
        
        // Normal completion
        conv.setAssistantComplete(exchangeId, evt.usage, evt.context);
    }
}
```

### 5. `conversation.js:getMessagesForApi()` — Use OpenAI tool message format

**Current** (line 326): Injects fake `__TOOL_CALL__` text:
```js
rawMessages.push({
    role: 'assistant',
    content: `__TOOL_CALL__({"name": "${exchange.tool.name}", "args": ${JSON.stringify(sanitizedArgs)}})`
});
```

**Change**: Use proper OpenAI `tool_calls` + `role: "tool"` format:
```js
// Store the tool call ID when creating tool exchanges
if (exchange.type === 'tool' && (exchange.tool.status === 'success' || exchange.tool.status === 'error')) {
    // Assistant message with tool_calls
    rawMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: exchange.tool.callId || `call_${exchange.id}`,
            type: 'function',
            function: {
                name: exchange.tool.name,
                arguments: JSON.stringify(exchange.tool.args)
            }
        }]
    });

    // Tool result message
    rawMessages.push({
        role: 'tool',
        tool_call_id: exchange.tool.callId || `call_${exchange.id}`,
        content: exchange.tool.content || ''
    });
}
```

### 6. `conversation.js:addToolExchange()` — Store `callId`

Add a `callId` field to track the tool call ID from the gateway:
```js
async addToolExchange(toolName, toolArgs, callId = null, userId = null) {
    const exchange = {
        id: this._generateId(),
        timestamp: Date.now(),
        type: 'tool',
        userId: userId,
        tool: {
            role: 'tool',
            callId: callId,       // NEW: links back to the gateway's tool_calls[].id
            name: toolName,
            args: toolArgs,
            status: 'pending',
            content: '',
            images: []
        },
        // ... rest unchanged
    };
}
```

---

## Migration Strategy

### Option A: Clean Break (Recommended)
Replace all `__TOOL_CALL__` logic in one pass. The `generateToolPrompt()` method and all regex scanning are removed. Tool calls come exclusively through the structured gateway flow.

### Option B: Dual Mode
Keep `__TOOL_CALL__` as a fallback for models/adapters that don't support structured tools. Check `chat.done.tool_calls` first; if null and `content` contains `__TOOL_CALL__`, fall back to text parsing. This is more resilient but adds complexity.

---

## What NOT to Change

- **`mcp-client.js:executeTool()`** — Unchanged. MCP tool execution on the client side works the same regardless of how the LLM invokes the tool.
- **`mcp-client.js:getFormattedToolsForLLM()`** — Already returns OpenAI format. No changes needed.
- **`client-sdk.js:_handleMessage()`** — Already passes `chat.done` params through to the stream. The new `tool_calls` and `content` fields arrive automatically.
- **Chat UI (tool rendering, pending indicators)** — Unchanged. The UI shows tool execution status regardless of invocation method.

---

## Files to Modify

| File | Change |
|------|--------|
| `chat/js/client-sdk.js` | Extract `delta.tool_calls` in iterable, surface `tool_calls`/`finish_reason` in done event |
| `chat/js/chat.js` | Send `params.tools` to gateway, detect `finish_reason: "tool_calls"` from done event, remove `__TOOL_CALL__` regex scanning, remove prompt injection |
| `chat/js/conversation.js` | `getMessagesForApi()` uses OpenAI `tool_calls` + `role: "tool"` format, `addToolExchange()` stores `callId` |
| `chat/js/mcp-client.js` | Remove or deprecate `generateToolPrompt()` |
