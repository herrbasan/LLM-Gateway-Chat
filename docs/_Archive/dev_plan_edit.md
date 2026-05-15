# Dev Plan: User Message Editing (Destructive)

## 1. UI & Styling Updates (chat.js & chat.css)
- **Add Action Buttons:** In enderExchange(), inject a .message-actions container into the user message DOM (similar to the assistant messages). Add an "Edit" button (<nui-icon name="edit">).
- **CSS Hover:** Ensure the edit button only appears on hover of the message block to keep the UI clean.

## 2. Inline Edit Mode (chat.js)
- **startEditMode(exchangeId):** 
  - Find the DOM element for the target user message.
  - Hide the rendered .message-content.
  - Inject a <nui-textarea> pre-filled with the raw Markdown from exchange.user.content.
  - Add "Cancel" and "Save & Resubmit" buttons below the textarea.
- **Cancel Action:** Destroy the textarea, restore the original .message-content, and hide the edit controls.

## 3. State Truncation (conversation.js & image-store.js)
- **	runcateAfter(exchangeId):** Add a helper method in the Conversation class.
  - Find the index of the edited exchange.
  - Collect all exchanges *after* that index.
  - Iterate through those orphaned exchanges and call imageStore.delete(ex.id) to prevent IndexedDB bloat.
  - splice() the 	his.exchanges array to drop everything after the current explicit exchange.

## 4. Execution Logic (chat.js)
- **commitEdit(exchangeId, newContent):**
  1. Update exchange.user.content = newContent.
  2. Call conversation.truncateAfter(exchangeId).
  3. Call conversation.save() to persist to localStorage.
  4. Call the existing enderConversation() to wipe the downstream DOM elements from the screen.
  5. Fire the existing egenerate(exchangeId) function, which will wipe the assistant's old reply for that specific exchange and stream a brand new one based on the new context!
