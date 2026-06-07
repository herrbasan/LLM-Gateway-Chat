## [2026-05-30 Audit] chat/js/config.js is missing from the repo

The file `chat/js/config.js` is referenced in `chat/index.html` line 402-403 but does not exist on disk. The server dynamically generates it in-memory when serving `/chat/js/config.js` (see `server/server.js` L1738-1753). This is by design — the config is injected from `.env`/environment variables — but there's no fallback file in the repo for local development or documentation purposes.

Status: By Design — server dynamically generates the config. However, a sample/template file with comments would help LLMs understand available settings without reading the server code.

## [2026-05-30 Audit] Realtime thinking rendering was reported broken but is implemented

The May 23 handover reported that thinking blocks don't render during active streaming. Code audit shows this IS implemented: `reasoningBuffer` accumulates in `streamResponse()` and `updateAssistantContent(assistantEl, contentBuffer, reasoningBuffer)` is called on a debounced interval (L2221-2230). Both `reasoning_content` and `thinking_signature` are saved to nDB and restored on reload.

Status: Verify at runtime. The implementation is in place — if it doesn't work, the issue may be in the Gateway not sending `reasoning_content` events, or the CSS hiding the thinking blocks.

## [2026-05-30] Arena summaries are not persisted to the backend

When a user generates a conversation summary in the Arena (summarize dialog → Save), the summary (title, condensedVersion, longSummary, shortSummary) is set on `this.arena.summary` and `_saveToStorage()` is called — but `_saveToStorage()` routes through `arenaStorage.saveSession()` which always calls `POST /api/chats` (`bc.createSession()`). On subsequent saves (when `_backendChatId` already exists), it only syncs new messages via `bc.sendMessage()`. The summary is **never PATCHed to the backend** via `bc.updateSession()`.

**Root cause:** `_saveToStorage()` has no path to call `PATCH /api/chats/:id` with `{ summary: {...} }`. The backend endpoint supports `body.summary` on `PATCH /api/chats/:id` (L1207), but the frontend never sends it.

**Consequences:**
1. Summary is lost on page reload (only lives in memory)
2. The generated title is not used for the session's display name in the arena history list
3. `_updateHistory()` reads `sessionData.summary?.title` for the history entry's `title` field, but since summary is never persisted, reload displays "Arena Session" as the title

**Fix needed (in `_saveToStorage()`):** After the summary is updated in the dialog, call `backend.updateSession(effectiveId, { summary: this.summary, title: this.summary.title })` to persist it. The `arenaStorage.saveSession()` path should also check if a session already exists and PATCH rather than re-POST.

Status: Open

---

## System Prompts are not saved with the chat session.

When I select a system prompt from the presets, the added system prompt is not saved, so on reloading the conversation the field is empty.

Status: Resolved — Server `PATCH /api/chats/:id` was ignoring `systemPrompt`, `title`, and `model` fields. Also added `systemPrompt` to session creation endpoint.

## Image attachments are not displayed in the conversation.

When I attach an image to the conversation, the image is not displayed in the chat history, please check the logs. The image pipeline might not be connected to the new database architecture.

Status: Resolved — Server-side file storage implemented. Images persist across reload, export/import works, server URLs stored in DB instead of base64.

## Clicking image thumbnails does not open the image viewer.

When I click on an image thumbnail in the chat history, the image viewer does not open to display the full image. This might be related to the issue with image attachments not being displayed properly.

Status: Resolved — Works as side effect of the image attachment pipeline fix.

## Chat sessions are not sorted automatically after a change

The default sorting of chats are currently by "last updated", which is correct. But when I pick up an old chat, it should be sorted up in the UI immediately, once a message is added, making it the most recently updated chat. Currently, the chat session is only sorted when I reload the page.

Status: Open — `updatedAt` is updated in backend and in `chatHistory.save()`, but `renderHistoryList()` is never called after a message is sent/stream completes, so the sidebar doesn't re-sort until page reload. Fix: call `renderHistoryList()` in `streamResponse()` after `setAssistantComplete()` and/or in `sendMessage()` after `chatHistory.save()`. (Audited 2026-05-30: confirmed still open.)

## Operation mode setting doesn't save
the "operation mode" select does not save the setting to the database. On reload it always defaults to "SSE Rest"

Status: Resolved — Changed event listener from `change` on inner `<select>` to `nui-change` on `<nui-select>` component. Fixed setting initial value on reload to use `.setValue(opMode)`.

## LLM Gateway Issues (external project)

Thinking on the Qwen model produces `nullnullnullnullnullnullnullnullnullnull` as output. This is an issue with the model response parsing in the LLM Gateway. Frontend workaround exists in `Conversation._cleanModelArtifacts`.

The `</think>` content terminator leaks into the response content. Same fix: gateway should split reasoning from content at the `</think>` marker rather than emitting the terminator as content.

Status: Open — requires LLM Gateway backend changes.

---

## Feature - Allow different sortings

This could possibly something we allow to configure in the config pane. Or we add a sort select (using the nui-select component) to the top of the chat list, allowing users to choose how they want their chats sorted (by created time or last updated time or name of the chat).

Status: Backlog

## MCP Vision tool doesnt work

When I try to use the MCP Vision tool to analyze an image, it does not return any results. This might be related to the issue with image attachments not being displayed properly, or there might be a problem with the MCP Vision integration.

Status: Re-opened — It is not working consistently. It might depend on the model adapter acting on the LLM Gateway. Note that it's not entirely done yet.
(Previously marked resolved via `autoCreateVisionSessions()` pipeline, but the fix is intermittent.)


## Arena chats are not automatically embedded

Arena sessions are not picked up by the automatic embedding pipeline. They only get embedded if manually triggered via the arena UI or a separate reindex. This means arena content is missing from semantic search results.

Status: Resolved — Arena `_saveToStorage()` used `this.id` (arena-* format) for `backend.sendMessage()`, but the backend creates sessions with `chat_*` IDs. The 404 responses meant messages were never stored → no embedding. Fix: ensure a backend session mapping (`this._backendChatId`) is created on first sync, and use that ID for all message POSTs.
## Embedding pipeline inactive during chat

Automatic embedding does not seem to trigger when having a conversation in the chat. Monitoring the GPU usage on the embedding backend shows no activity.

Status: Resolved — 
1. Server failed to create the `embeddings` collection inside nVDB internally during mount because the native binding threw a "collection not found" error when attempting to fetch it. Wrapped `getCollection` in a check against `listCollections()` to conditionally invoke `createCollection('embeddings', 2560)`.
2. The `embedUrl` setting inside `server/config.json` was pointing to `http://localhost:3400/v1/embeddings` instead of the required `http://192.168.0.100:3400/v1/embeddings`. After 3 automated retries on `localhost`, the endpoint threw `ECONNREFUSED` internally and permanently disabled the global `embedAvailable` flag for the active backend session, meaning background jobs were silently dropped. Updated the configuration to point to the correct IP.

## "Copy JSON" doesn't copy to clipboard

The "Copy JSON" button in the chat options dialog logs JSON to the console but doesn't copy to the system clipboard. The `nui-action` custom event dispatched by NUI preserves the user gesture (synchronous `dispatchEvent`), and `execCommand('copy')` on an `opacity:0` textarea returns `true` — but the clipboard remains empty. `navigator.clipboard.writeText()` is also unavailable (insecure context on non-localhost IP). The per-message "copy" button works fine using the same approach, so the difference is likely the dialog context or the data volume (~12KB JSON vs short text).

Status: Resolved — Added clipboard fallback (textarea + execCommand) matching the per-message copy approach.

## Model names not persisted across reload

Model names are displayed in the conversation (e.g. "gemini-flash"), but they are not stored with the conversation data. On page reload, the sender label falls back to "Assistant". The model name should be saved alongside each exchange/message and restored on load.

Status: Resolved — `streamResponse()` now sets `exchange.model = streamModel` on the exchange object, which gets persisted via `save()` and restored on reload via `renderConversation()`.
