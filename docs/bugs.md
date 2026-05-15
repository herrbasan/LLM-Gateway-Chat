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

## Feature - Allow different sortings

This could possibly something we allow to configure in the config pane. Or we add a sort select (using the nui-select component) to the top of the chat list, allowing users to choose how they want their chats sorted (by created time or last updated time or name of the chat).

Status: Backlog

## MCP Vision tool doesnt work

When I try to use the MCP Vision tool to analyze an image, it does not return any results. This might be related to the issue with image attachments not being displayed properly, or there might be a problem with the MCP Vision integration.

Status: Resolved — `autoCreateVisionSessions()` now does the full pipeline (create session + analyze image) inline, injects analysis text into assistant response. Vision tools filtered from LLM's tools array to prevent hallucination/redundant calls. No tool exchanges injected into conversation history.

## Question: What happens when a conversation containing images is deleted?

When I delete a conversation that contains images, I want to know if the images are also deleted from the server or if they remain stored. This is important for understanding how data is managed and ensuring that there are no orphaned files taking up space.

**Answer:** Images ARE cleaned up on UI deletion. `deleteChat()` iterates exchanges and calls `imageStore.delete(ex.id)` → `DELETE /api/chat-files/:exchangeId` → server `rm -rf server/data/files/{exchangeId}/`. No orphaned files from normal UI deletion.

The nDB evolution plan describes a future Rust-level feature where link-type schema fields trigger cascading file deletion and TTL-based trash sweeps, but that's not implemented yet. Currently only the UI-triggered deletion path cleans up files — direct nDB manipulation would leave orphans.

## Arena chats are not automatically embedded

Arena sessions are not picked up by the automatic embedding pipeline. They only get embedded if manually triggered via the arena UI or a separate reindex. This means arena content is missing from semantic search results.

Status: Resolved — Arena `_saveToStorage()` used `this.id` (arena-* format) for `backend.sendMessage()`, but the backend creates sessions with `chat_*` IDs. The 404 responses meant messages were never stored → no embedding. Fix: ensure a backend session mapping (`this._backendChatId`) is created on first sync, and use that ID for all message POSTs.