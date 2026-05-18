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

Status: Pending

## Operation mode setting doesn't save
the "operation mode" select does not save the setting to the database. On reload it always defaults to "SSE Rest"

Status: Resolved — Changed event listener from `change` on inner `<select>` to `nui-change` on `<nui-select>` component. Fixed setting initial value on reload to use `.setValue(opMode)`.

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
