# Database Architecture Evolution Plan

## Background & Motivation
Recent deep-dives into data bloat issues (e.g., the O(N²) scaling problem caused by appending 3MB conversation documents for every new message) revealed architectural limitations in the `nDB` and `nVDB` implementations. 

Originally, `nGDB` was conceived as a management wrapper to provide schemas, database-as-a-folder bundling, and metadata. However, rubbing the system against real-world data and usage patterns has highlighted that these management concepts shouldn't live in a Node.js wrapper—they need to be native features of the Rust-based databases themselves.

This document outlines the strategic refactor for `nDB` and `nVDB`, officially dropping `nGDB` as a logical management layer and folding its best ideas into the native Rust cores.

---

## 1. Dropping nGDB
**Insight:** `nGDB` was designed to be the orchestrator—bundling `.jsonl` files, metadata, and binary buckets together, while providing display mappings (schemas). 
**Decision:** Drop `nGDB` as a database wrapper constraint. 
* Any network-serving requirements (REST/WebSockets) should just be standard Node.js server routes. 
* All database structure definitions and folder management should be handled by `nDB` natively.

---

## 2. nDB Native Feature Refactor

### 2.1 Database as a Folder (Native)
Instead of relying on an external wrapper, `nDB` will natively treat a path as a comprehensive database environment.
* `nDB.open('./my-app-db')` will natively generate:
  ```text
  my-app-db/
  ├── meta.json         # Database schema, bucket declarations, versioning
  ├── data.jsonl        # The append-only document store
  ├── _trash/           # Soft-deleted documents and files
  └── _files/           # Managed binary buckets
  ```
* Native Rust methods will be provided to query and update `meta.json` directly.

### 2.2 Atomic Updates vs Full Replacements (The Hammer vs The Scalpel)
To prevent massive I/O bloat, `nDB` will support two distinct write patterns natively:

**1. Full Replacements (The Standard approach):**
For normal-sized documents (user settings, simple records), the application calls `db.update("id", fullNewObject)`. The Rust engine simply appends the new full JSON object to the log file. It remains fast, simple, and pure.

**2. Atomic Delta Updates (The Scalpel):**
For extremely large documents (like a 3MB Conversation object being streamed word-by-word), replacing the full document is catastrophic for disk I/O.
* **Implementation:** Introduce patch operations natively into the `nDB` Append-Only Log.
* **Format:** Instead of appending the full doc, `nDB` appends a lightweight instruction:
  `{"_id": "chat_123", "_op": "array_push", "field": "messages", "value": {...}}`
* **In-Memory Merging:** On load (`open`), `nDB` reads the base document and replays the patches in memory.
* **Compaction:** `db.compact()` will "bake" the patches into a fresh base document, cleaning up the append-only log.

This allows developers to choose the right tool for the job: overwrite when it's easy, patch when it's heavy.

### 2.3 Opt-in Schema Validation
Leverage the `meta.json` file to define simple structural expectations. This removes defensive runtime checks during delta writes and allows the Rust layer to aggressively optimize array manipulation.

```json
// Example nDB meta.json
{
  "engine": "ndb",
  "version": 1,
  "buckets": {
    "avatars": { "onDocumentDelete": "restrict" },
    "attachments": { "onDocumentDelete": "trash", "ttl_seconds": 2592000 },
    "temp_exports": { "ttl_seconds": 86400 }
  },
  "schemas": {
    "conversation": {
      "fields": {
        "title": { "type": "string" },
        "messages": { "type": "array" },
        "avatar": { "type": "link" },
        "exportFile": { "type": "link" }
      }
    }
  }
}
```

### 2.4.1 File Buckets: Hash Deduplication & The Trash System (nGDB Port)
Carrying over the fleshed-out specifications from the original nGDB concept, `nDB` file buckets will implement intelligent deduplication and safe deletions natively in Rust:
* **SHA-256 Deduplication:** Files aren't stored by arbitrary names; they are stored using the first 8 characters of their SHA-256 content hash (e.g., `_files/avatars/a1b2c3d4.png`). If two documents upload the exact same image, it's only written to disk once.
* **The Trash System ("Soft Deletion"):** When a file needs to be deleted (either via a TTL expiring, or via an `"onDocumentDelete": "trash"` cascading rule), the file is **not** permanently deleted. It is safely moved to `_trash/files/{bucket_name}/{hash}.{ext}`.
* **Garbage Collection (Purging):** An Admin or a scheduled cronjob can run `ndb purge <path>` to permanently clean out the trash and enforce the `ttl_seconds` sweeps.

Because Rust `nDB` natively tracks which fields are `"link"` types, it can safely sweep through all documents, identify orphaned files, apply TTL policies, and move dead weight to the trash folder without risking data loss.

### 2.4.2 Bucket Management & Restrictions (Admin Only)
Buckets act as isolated file stores (like S3 buckets). 
* **Declarative > Imperative:** Buckets should ideally be declared upfront in `meta.json`. Dynamic runtime creation at the application level should be restricted.
* **Low-Level CLI Tooling:** Bucket management should be treated as an "Admin" action using the existing Rust CLI (`ndb.rs`):
  * `ndb config set buckets.name '{...}'` (updates `meta.json` policies)
  * `ndb purge <path>` (clears out the Trash folder)
This ensures that the database structure is managed by the system administrator, not accidentally mutated by the Node web application during runtime.

### 2.5 The Universal "Link" Schema Type (nURI)
*The most powerful addition to the schema.*
Instead of having arbitrary strings representing attachments, introduce a `"link"` type in the schema validator. A `link` enforces a strict formulation so frontends and admin UIs know exactly how to render or fetch a resource without guessing.

**Stored Data Format (Compact Strings):**
Leveraging the original nGDB concept, a `link` is stored as a simple primitive string. For internal buckets, it uses the fast `bucket:hash.ext` format. The Rust schema validator ensures it strictly matches the nURI format before writing to disk:
```json
{
  "_id": "chat_123",
  "_type": "conversation",
  "title": "Project Planning",
  "exportFile": "attachments:m3n4o5p6.pdf",
  "referenceUrl": "https://example.com/api"
}
```

**Supported Protocols:**
* `avatars:a1b2c3d4.png` (nDB natively resolves this to the internal `_files/avatars/a1b2c3d4.png` deduplicated blob)
* `https://example.com/file.pdf` (nDB just validates the format; the client/Node handles the network fetch)

* **The Rule:** Rust `nDB` does **not** fetch remote URLs or arbitrary absolute paths (to prevent massive security/SSRF holes). It only stores the string, validates the regex, and handles the `bucket:id.ext` compact strings natively natively alongside its trash/deduplication engine.

---

## 3. nVDB Optimization

While `nVDB` doesn't require binary file buckets, it heavily benefits from similar atomic concepts to stay efficient.

### 3.1 Metadata & Schema Bundling
Like `nDB`, an `nVDB` collection should be an encapsulated folder.
* Native tracking of Collection schemas, vector dimensions, and metric types inside `meta.json`.

### 3.2 Delta Payload Updates
Currently, `nVDB` ties the vector and the JSON payload together. If the payload simply needs to be updated (without recalculating the vector), `nVDB` should support a `patchPayload` delta operation rather than rewriting the dimensional floats to disk.

---

## Evolving the Current Codebase
1. **Immediate Step:** We have already successfully decoupled `embedStatus` tracking from the `nDB` event loop in the LLM Gateway Chat app, mitigating the immediate disk failure. 
2. **Short Term:** Polish the `array_push` proof-of-concept inside `nDB` Rust core. *(Note: Our recent test run flagged that queries fail—this is because NAPI wraps Rust tasks in async Promises, which requires updating the JavaScript test suite to await the queries).*
3. **Mid Term:** Port the `nGDB` folder/metadata handling fully down to `nDB` in Rust.
4. **Documentation & Spec Updates:** As part of this sweeping refactor, we must update the project's core files—`README.md`, `Agents.md` (and/or `AGENTS.md`), and the API specifications under `lib/ndb/documentation/`.
5. **Migration Strategy:** These architectural changes (folder structuring, `meta.json`, atomic ops) will constitute a **Breaking Change**. The `README.md` must clearly flag this. We will design a migration strategy and supply a migration script (`migrate-ndb-to-folder.js`) to seamlessly transition pre-refactor flat `.jsonl` data and loose buckets into the newly formatted database-as-a-folder structures.