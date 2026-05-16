# nDB Bucket Migration & Lifecycle Plan

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.

## Overview
The original NeDB -> nDB migration failed to move image attachments into nDB's native bucket system. Currently, images are saved as physical files in `server/data/files/` and linked via hardcoded URL strings. This breaks database portability, backup consistency, and leaves orphaned files infinitely when chats are deleted.

This plan details the upgrade path to fully utilize nDB's native binary bucket storage and strict `nURI` (`bucket:hash.ext`) schema links.

---

## Phase 1: Rust Engine Lifecycle Enhancements (`lib/ndb/`)

To safely delete files without breaking deduplicated references, we need garbage collection natively in the Rust engine.

1. **Implement `db.release_file(&str)`:**
   - A targeted, fast short-circuit check.
   - Rust iterates in-memory documents looking for the `bucket:hash.ext` string.
   - If found anywhere, exit immediately (reference count > 0).
   - If not found, call `bucket.delete(fileRef)` to safely move the physical file to `_trash/`.
2. **Implement `db.gc_buckets()`:**
   - A full maintenance sweep.
   - Collects all `bucket:hash.ext` matches from all documents into a `HashSet`.
   - Scans all files in `_files/` and trashes anything not in the set.
3. **N-API Bindings:**
   - Expose both methods to the Node.js bindings in `lib/ndb/napi/`.

---

## Phase 2: Application Integration (`server/server.js`)

We update the server to bridge the gap between HTTP interfaces and nDB's bucket engine, completely transparent to the frontend.

1. **Uploads (`PUT /api/chat-files/:exchangeId`):**
   - Receive base64 as normal.
   - Instead of writing to `fs`, call `db.bucket('images').store(filename, buffer, mimeType)`.
2. **Retrieval (`GET /api/buckets/:bucket/:filename`):**
   - Create a new endpoint to serve native bucket files.
   - Uses `db.bucket(bucket).get_by_id(id, ext)` and returns standard `image/*` payloads.
3. **Translation Layer (`GET /api/chats/:id` & `POST /api/chats/:id/messages`):**
   - When returning a conversation to the client, dynamically translate the compact `_file: "images:a1b2c3d4.png"` nURI into a working `url: "/api/buckets/images/a1b2c3d4.png"`.
   - This keeps the frontend UI completely unmodified.
4. **Lifecycle (`DELETE /api/chats/:id`):**
   - When deleting a chat/message, extract all attached `_file` strings.
   - After deleting the document from nDB, immediately call `db.releaseFile(fileRef)` for each image to trigger safe garbage collection.

---

## Phase 3: Data Migration Script

Once the infrastructure is tested with new chats, we migrate the legacy data.

1. **Standalone Script (`server/migrate-ndb-buckets.js`):**
   - Iterate over all `conversation` documents.
   - Find elements in `messages[].attachments[]` that rely on the old `url: "/files/..."`.
   - Read the corresponding physical file from `server/data/files/`.
   - Store it natively via `db.bucket('images').store()`.
   - Replace the legacy `url` / `dataUrl` properties in the document with the new `_file: "images:hash.ext"` nURI format.
   - Run `db.update()` for each modified conversation.
2. **Cleanup:**
   - Verify UI rendering.
   - Safely `rm -rf server/data/files/`. All data is now encapsulated safely within the `server/data/chat_app/` nDB directory.