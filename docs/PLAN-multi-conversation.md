# Multi-Conversation Architecture Plan

## Overview

Refactor the chat system using the **"Hidden Container" (Document Fragment) pattern**. Instead of destroying and recreating the DOM every time a user switches chats, the UI maintains a dictionary of DOM containers (one `<div>` per conversation). Switching chats simply toggles `display: none` and `display: flex` between these containers.

This strategy elegantly solves the complexities of background activity:
1. **Background tools survive:** Any running MCP tool callback naturally continues updating its bound DOM element, even while hidden.
2. **Instant switching:** Toggling visibility means zero CPU cost for re-parsing markdown, re-running syntax highlighters, or re-fetching images. Scroll position is natively preserved.

```text
┌─────────────────────────────────────────────────────────────┐
│                         SDK Layer                           │
│   WebSocket → routes to Conversation by sessionId           │
│   streamChatIterable() → per-chat stream tracking          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Data Layer (in memory)                   │
│                                                             │
│   activeConversations: Map<chatId, Conversation>           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  View Layer (chatContainers)                │
│                                                             │
│   Map<chatId, HTMLDivElement>                               │
│                                                             │
│   [Chat A Container] (display: flex)  <-- Visible          │
│      ├─ User Message Node                                   │
│      └─ Assistant Message Node (streaming...)               │
│                                                             │
│   [Chat B Container] (display: none)  <-- Background       │
│      ├─ User Message Node                                   │
│      └─ Tool Progress Node (spinning...)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Architecture Status: IN PROGRESS

### What's Implemented ✅

1. **Per-chat DOM containers** (`chatContainers` Map)
2. **Per-chat Conversation objects** (`activeConversations` Map)
3. **Per-chat stream registry** in SDK (`_streamRegistry`)
4. **`switchChat`** toggles visibility without aborting streams
5. **Per-chat send button state** via `client.hasActiveStream(currentChatId)`
6. **`handleToolExecution`** uses `toolConversation = activeConversations.get(toolChatId)` for all data operations
7. **Tool continuation routing** via `streamResponse(exchangeId, toolChatId)` with passed chatId
8. **`showPendingToolUI(exchangeId, chatId)`** correctly scopes DOM ops to target chat
9. **`streamResponse`** syncs `conversation = activeConversations.get(chatId)` at start
10. **JSON clipboard export** reads from `activeConversations.get(chatId)` (in-memory), not backend storage
11. **Error/aborted saves** - `conversation.save()` called in all termination paths
12. **MCP Tool Continuation Routing** - `streamChatIterable` called with `chatId` (not `currentChatId`) so SDK stream registry uses correct key; `client.setSessionId()` called before continuation so server routes WS messages correctly

---

## 1. DOM Container Management (Render Layer)

### 1.1 Container Dictionary
The view layer maintains a map of containers and a getter function.

```javascript
// In chat.js
const chatContainers = new Map(); // chatId -> HTMLDivElement
const mainChatArea = document.getElementById('chat-messages-wrapper');

function getOrCreateContainer(chatId) {
    if (chatContainers.has(chatId)) {
        return chatContainers.get(chatId);
    }
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.dataset.chatId = chatId;
    container.style.display = 'none';
    mainChatArea.appendChild(container);
    chatContainers.set(chatId, container);
    return container;
}

// Returns the VISIBLE chat's container (for active UI operations)
function getActiveContainer() {
    return chatContainers.get(currentChatId) || elements.messages;
}
```

### 1.2 switchChat Implementation
```javascript
async function switchChat(targetChatId) {
    currentChatId = targetChatId;

    // 1. Ensure container exists
    const targetContainer = getOrCreateContainer(targetChatId);

    // 2. Load conversation from cache or create new
    let conv = activeConversations.get(targetChatId);
    if (!conv) {
        conv = new Conversation(`chat-conversation-${targetChatId}`);
        await conv.load();
        activeConversations.set(targetChatId, conv);
    }
    conversation = conv;

    // 3. Sync SDK session ID
    const chatInfo = chatHistory.get(targetChatId);
    if (chatInfo?.sessionId) {
        client.setSessionId(chatInfo.sessionId);
    }

    // 4. Toggle container visibility
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === targetChatId ? 'flex' : 'none';
    }

    // 5. Update UI
    renderHistoryList();
    updateOverallContext();

    // 6. Sync send button state for new active chat
    const targetChatIsStreaming = client.hasActiveStream(targetChatId);
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        btn.innerHTML = targetChatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}
```

---

## 2. Background Streaming & Tool Execution

### 2.1 Tool Execution Flow (Critical Path)

```javascript
// streamResponse receives chatId from caller
async function streamResponse(exchangeId, streamChatId) {
    const chatId = streamChatId || currentChatId;

    // CRITICAL: Sync conversation to correct chat in case user switched during async
    conversation = activeConversations.get(chatId) || conversation;

    // ... create assistant element in correct container ...
    const targetContainer = getOrCreateContainer(chatId);
    let assistantEl = targetContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    // ...

    for await (const event of client.streamChatIterable(requestBody, chatId, false, conversation)) {
        switch (event.type) {
            case 'delta':
                // ...
                if (toolCallIndex !== -1 && !isReceivingTool) {
                    isReceivingTool = true;
                    // Pass chatId so handleToolExecution knows which chat this belongs to
                    handleToolExecution(exchangeId, parsedObj, chatId);
                    break;
                }
                // ...
        }
    }
}
```

### 2.2 handleToolExecution (Chat-Scoped)

```javascript
async function handleToolExecution(originalExchangeId, parsedObj, forcedChatId) {
    // Use forcedChatId if provided, otherwise fall back to currentChatId
    const toolChatId = forcedChatId || currentChatId;
    // Use specific container, not getActiveContainer() (user may have switched)
    const toolContainer = getOrCreateContainer(toolChatId);
    // Use specific conversation object for ALL operations
    const toolConversation = activeConversations.get(toolChatId);

    // Guard: if exchange not found, abort
    const oldEx = toolConversation.getExchange(originalExchangeId);
    if (!oldEx) {
        console.warn('[handleToolExecution] Original exchange not found in expected conversation');
        return;
    }

    // Finalize original exchange
    oldEx.assistant.content = oldEx.assistant.content.replace(/__TOOL_CALL__\([\s\S]*$/, '').trim();
    toolConversation.setAssistantComplete(originalExchangeId);

    // Create tool exchange
    const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args);
    const exchange = toolConversation.getExchange(toolExchangeId);

    // Render tool UI in correct container
    toolContainer?.appendChild(toolEl);

    // Execute MCP tool - chatId is now passed for scoping
    const result = await mcpClient.executeTool(parsedObj.name, parsedObj.args, callback, toolChatId);

    // On result: update exchange, save, continue LLM stream
    exchange.tool.status = 'success';
    exchange.tool.content = resultText;
    toolConversation.save();

    // CRITICAL: streamResponse continuation with correct chatId
    await streamResponse(toolExchangeId, toolChatId);
}
```

### 2.3 showPendingToolUI (Chat-Scoped)

```javascript
function showPendingToolUI(exchangeId, chatId) {
    const container = getOrCreateContainer(chatId);
    const userPendingEl = container?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
    if (userPendingEl) userPendingEl.classList.remove('visible');

    const toolEl = document.createElement('div');
    toolEl.className = 'chat-message tool pending-tool-element';
    toolEl.dataset.pendingExchangeId = exchangeId;
    // ...
    container?.appendChild(toolEl);
    scrollToBottom();
}
```

---

## 3. SDK Layer Changes

### 3.1 Per-Chat Stream Tracking

```javascript
// In GatewayClient
_streamRegistry = new Map(); // chatId -> { stream, isAborted, conv }

async function streamChatIterable(params, chatId, useAppend = false, conv = null) {
  const stream = useAppend
    ? this.chatAppendStream({...params, stream: true})
    : this.chatStream({...params, stream: true});

  const entry = { stream, isAborted: false, conv };
  this._streamRegistry.set(chatId, entry);

  // ... yield events (delta, progress, done, error, cancel, aborted) ...

  } finally {
    const entry = this._streamRegistry.get(chatId);
    const convToSave = entry?.conv;
    this._streamRegistry.delete(chatId);
    if (convToSave?.save) {
      convToSave.save();
    }
  }
}

hasActiveStream(chatId) {
  return this._streamRegistry.has(chatId);
}

abortStream(chatId) {
  const entry = this._streamRegistry.get(chatId);
  if (entry) {
    entry.isAborted = true;
    entry.stream.cancel();
    this._streamRegistry.delete(chatId);
  }
}
```

**ChatStream cancel flow:** `stream.cancel()` → `chat.cancel` WS message → server ack → `ChatStream._onCancel()` → `cancel` event → iterator receives `aborted` event → breaks → `finally` saves.

---

## 4. Per-Chat Abort Behavior

| Action | New Behavior |
|--------|--------------|
| User clicks "stop" (send button) | Aborts stream for active chat—calls `client.abortStream(currentChatId)` |
| User switches chats | **Does NOT abort** — stream continues in hidden container |
| User starts new chat | **Does NOT abort** — all streams continue |
| Page unload | Aborts stream |

### 4.1 Per-Chat Input UI State

All UI operations that check streaming state use per-chat checks via `client.hasActiveStream(currentChatId)`:

```javascript
// sendMessage() - blocks if current chat is streaming
if (client.hasActiveStream(currentChatId)) return;

// send button click
if (client.hasActiveStream(currentChatId)) {
    abortStream();
} else {
    sendMessage();
}

// regenerate()
if (client.hasActiveStream(currentChatId)) return;

// startEditMode()
if (client.hasActiveStream(currentChatId) && currentExchangeId === exchangeId) return;

// updateSendButton() - shows correct icon for visible chat's state
function updateSendButton() {
    const chatIsStreaming = client.hasActiveStream(currentChatId);
    btn.innerHTML = chatIsStreaming
        ? '<nui-icon name="close"></nui-icon>'
        : '<nui-icon name="send"></nui-icon>';
}
```

---

## 5. Sidebar Indicators

```javascript
function markChatAsStreaming(chatId, isStreaming) {
    const item = elements.chatHistoryList?.querySelector(`[data-chat-id="${chatId}"]`);
    if (item) {
        item.classList.toggle('streaming', isStreaming);
    }
}
```

CSS: `.chat-history-item.streaming::before` shows pulsing green dot.

---

## 6. Summary of File Changes

| File | Changes |
|------|---------|
| `chat.js` | `chatContainers` Map + `getOrCreateContainer()`. `getActiveContainer()` for visible UI. `switchChat` syncs all state. `streamResponse` syncs `conversation` at start and passes `chatId` to `handleToolExecution`. `handleToolExecution` uses `toolConversation = activeConversations.get(toolChatId)` for all data ops and `getOrCreateContainer(toolChatId)` for DOM. `showPendingToolUI(exchangeId, chatId)`. All per-chat `isStreaming` checks via `client.hasActiveStream(currentChatId)`. `conversation.save()` in `done`, `error`, `aborted` paths. JSON export from `activeConversations.get(chatId)`. |
| `client-sdk.js` | `_streamRegistry` Map with `{ stream, isAborted, conv }`. `hasActiveStream(chatId)`. `streamChatIterable(params, chatId, useAppend, conv)` with conv for correct save. `ChatStream._onCancel()` + `cancel` event for clean iterator termination. `finally` saves via registry. |
| `mcp-client.js` | `executeTool(llmToolName, parameters, onProgress, chatId)` — chatId stored in `pendingRequests` for scoping. |
| `conversation.js` | `addToolExchange()` creates with `isStreaming: true, isComplete: false` and calls `this.save()`. `updateAssistantResponse()` does NOT save during streaming. `setAssistantComplete()` saves. |

---

## 7. Key Invariants

1. **DOM Elements Live On:** Once constructed, a conversation's DOM elements persist until the session ends or the tab is closed.
2. **Contextual Updates:** All updates from SDK or Tool executions use `getOrCreateContainer(chatId)` and `activeConversations.get(chatId)` for container and data operations respectively.
3. **Scroll Protection:** The auto-scroll function uses `getActiveContainer()` which reflects the visible chat only.
4. **Independent Aborts:** `abortStream(chatId)` only affects the specified chat; background streams continue.
5. **Conversation Sync:** At the start of `streamResponse`, `conversation` is immediately synced to `activeConversations.get(chatId)` to handle async handoffs correctly.
6. **Stream Registry Key:** `streamChatIterable` must be called with `chatId` (not `currentChatId`) so the SDK's `_streamRegistry` uses the correct key for the stream.
7. **Session Routing:** Before any continuation stream (tool result or dismiss), `client.setSessionId(chatHistory.get(chatId).sessionId)` must be called so the server routes WS messages to the correct session.

---

## 8. Open Issues

### ✅ MCP Tool Execution Scoping (FIXED)

Both routing issues are now resolved:

1. **`streamChatIterable` key bug** ([chat.js:1155](chat/js/chat.js#L1155)): Changed `currentChatId` → `chatId` so the SDK's `_streamRegistry` entry is keyed to the correct chat's stream.

2. **Session ID routing** ([chat.js:1885-1888](chat/js/chat.js#L1885)): Added `client.setSessionId(toolChatInfo.sessionId)` before calling `streamResponse(toolExchangeId, toolChatId)` so the server routes the continuation WS messages correctly.

---

## 9. Storage Layer

Storage is abstracted behind a `storage` facade with two backends:

| Backend | Used when | Methods |
|---------|-----------|---------|
| IndexedDB | Browser standalone | `storage.saveConversation()`, `storage.loadConversation()` |
| API (`/api/storage`) | Node.js server mode | Same interface, `PUT/GET /api/storage/:key` |

**Important:** JSON clipboard export uses `activeConversations.get(chatId).getAll()` (in-memory), NOT `storage.loadConversation()` (backend). This ensures exports reflect current session state including any pending streaming content.
