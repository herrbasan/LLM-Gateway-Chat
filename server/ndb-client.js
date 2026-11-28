/**
 * Thin HTTP/1.1 client for `ndb serve` (nDB v2, multi-DB service).
 *
 * The chat backend's ONLY nDB interface. There is no NAPI binding: every
 * document, index, change feed and bucket byte crosses this module. Every
 * non-2xx response throws NdbError with the server's explicit HTTP status and
 * structured error `code` — no retries, no silent fallbacks.
 *
 * Wire shapes verified against D:\DEV\nDB\src\server.rs (v2 routes):
 *   GET    /health                        -> { ok, engine, version, dbs, allow_create }
 *   GET    /v2/dbs                        -> { ok, dbs: [descriptor] }
 *   POST   /v2/dbs                        -> 201 { ok, db } ({ name, persistence?, format? })
 *   GET    /v2/dbs/:n/stats               -> { ok, documents, lineage }
 *   GET    /v2/dbs/:n/lineage             -> { ok, source_epoch_uuid, last_seq, min_available_seq }
 *   GET    /v2/dbs/:n/doc/:id             -> { ok, doc } | 404 not_found
 *   PUT    /v2/dbs/:n/doc?prefix=         -> 201 { ok, id, doc, seq }
 *   PUT    /v2/dbs/:n/doc/:id             -> { ok, id, doc, seq }   (full replace)
 *   PATCH  /v2/dbs/:n/doc/:id             -> { ok, applied, seq, doc }  (transactional ops)
 *   DELETE /v2/dbs/:n/doc/:id             -> { ok, deleted, seq }
 *   POST   /v2/dbs/:n/doc/:id/restore     -> { ok, doc, seq }
 *   POST   /v2/dbs/:n/doc/:id/peek        -> { ok, id, seq, doc, ranges }  (v3 seq-pinned read)
 *   POST   /v2/dbs/:n/docs/mget           -> { ok, docs: { id: doc }, missing: [id] }
 *   POST   /v2/dbs/:n/query               -> { ok, total, count, results, took_ms }
 *   POST   /v2/dbs/:n/search              -> { ok, total, count, results, took_ms,
 *                                              scanned_docs, used_indexes, next_cursor }
 *   GET    /v2/dbs/:n/schema              -> { ok, schema }
 *   PUT    /v2/dbs/:n/schema              -> { ok, schema }
 *   POST   /v2/dbs/:n/find                -> { ok, count, results, took_ms }
 *   POST   /v2/dbs/:n/facets              -> { ok, facets }
 *   POST   /v2/dbs/:n/index               -> { ok, index, type }
 *   POST   /v2/dbs/:n/compact             -> { ok, lineage }
 *   POST   /v2/dbs/:n/flush               -> { ok }
 *   GET    /v2/dbs/:n/changes?since=      -> { ok, source_epoch_uuid, from_seq, to_seq,
 *                                              last_seq, has_more, changes }
 *   GET    /v2/dbs/:n/snapshot?offset=&limit=&snapshot_id=
 *                                         -> { ok, source_epoch_uuid, watermark_seq,
 *                                              snapshot_id, total, count, docs }
 *   PUT    /v2/dbs/:n/files/:bucket       -> 201 { ok, ref, hash, ext, size }
 *   GET    /v2/dbs/:n/files/:bucket       -> { ok, files }
 *   GET    /v2/dbs/:n/files/:bucket/:f    -> raw bytes (Content-Type from extension)
 *   DELETE /v2/dbs/:n/files/:bucket/:f    -> { ok, deleted } | 409 { error: file_referenced }
 *   POST   /v2/dbs/:n/files/gc            -> { ok, moved }
 * Error bodies under /v2/ are { ok: false, error: <code>, message }.
 */

const MGET_MAX_IDS = 1_000;
const QUERY_PAGE_LIMIT = 1_000;

class NdbError extends Error {
    constructor(status, code, message, route, body) {
        super(`ndb ${route} (${status} ${code}): ${message}`);
        this.name = 'NdbError';
        this.status = status;
        this.code = code;
        this.body = body;
        this.route = route;
    }
}

function encodeName(kind, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        throw new TypeError(`Invalid ${kind} name: ${String(name)}`);
    }
    return encodeURIComponent(name);
}

function encodeComponent(kind, name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\]/.test(name)) {
        throw new TypeError(`Invalid ${kind}: ${String(name)}`);
    }
    return encodeURIComponent(name);
}

function assertPositiveInt(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new TypeError(`${label} must be a positive integer, got ${String(value)}`);
    }
    return n;
}

function createNdbClient(baseUrl, { token = null, timeoutMs = 30_000 } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
        throw new Error('createNdbClient: baseUrl is required (e.g. http://127.0.0.1:8323)');
    }
    const root = baseUrl.replace(/\/+$/, '');
    const auth = token ? { Authorization: `Bearer ${token}` } : {};

    async function send(method, path, { json, body, headers = {}, timeoutMs: reqTimeoutMs } = {}) {
        const url = `${root}${path}`;
        const ctrl = new AbortController();
        const budget = reqTimeoutMs === undefined ? timeoutMs : reqTimeoutMs;
        const timer = setTimeout(() => ctrl.abort(), budget);
        const init = { method, signal: ctrl.signal, headers: { ...auth, ...headers } };
        if (json !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(json);
        } else if (body !== undefined) {
            init.body = body;
        }

        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`ndb ${method} ${path} timed out after ${budget}ms (${root})`);
            }
            throw new Error(`ndb ${method} ${path} unreachable at ${root}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
        return res;
    }

    async function request(method, path, opts = {}) {
        const res = await send(method, path, opts);
        const raw = await res.text();
        let data = null;
        if (raw.length > 0) {
            try {
                data = JSON.parse(raw);
            } catch {
                if (!res.ok) {
                    throw new NdbError(res.status, 'non_json_error', raw.slice(0, 300), `${method} ${path}`, raw.slice(0, 300));
                }
                throw new Error(`ndb ${method} ${path} returned non-JSON body: ${raw.slice(0, 200)}`);
            }
        }

        if (!res.ok) {
            const code = (data && data.error) || `http_${res.status}`;
            const message = (data && (data.message || data.error)) || raw.slice(0, 300) || res.statusText;
            throw new NdbError(res.status, code, message, `${method} ${path}`, data);
        }
        return data;
    }

    async function requestRaw(method, path, opts = {}) {
        const res = await send(method, path, opts);
        if (res.status === 404) return null;
        if (!res.ok) {
            const raw = await res.text();
            let data = null;
            try {
                data = raw.length > 0 ? JSON.parse(raw) : null;
            } catch {
                data = raw.slice(0, 300);
            }
            const code = (data && data.error) || `http_${res.status}`;
            const message = (data && (data.message || data.error)) || (typeof data === 'string' ? data : null) || res.statusText;
            throw new NdbError(res.status, code, message, `${method} ${path}`, data);
        }
        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: res.headers.get('content-type') || 'application/octet-stream'
        };
    }

    function db(name) {
        const dbName = encodeName('database', name);
        const base = `/v2/dbs/${dbName}`;

        const handle = {
            name,
            baseUrl: root,

            /** GET /stats -> { documents, lineage } */
            async stats() {
                const r = await request('GET', `${base}/stats`);
                return { documents: r.documents, lineage: r.lineage };
            },

            /** GET /lineage -> { source_epoch_uuid, last_seq, min_available_seq } */
            async lineage() {
                const r = await request('GET', `${base}/lineage`);
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    last_seq: r.last_seq,
                    min_available_seq: r.min_available_seq
                };
            },

            /** GET /doc/:id -> doc | null (404) */
            async get(id, { fields } = {}) {
                const qs = fields && fields.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
                try {
                    const r = await request('GET', `${base}/doc/${encodeURIComponent(id)}${qs}`);
                    return r.doc;
                } catch (err) {
                    if (err instanceof NdbError && err.status === 404 && err.code === 'not_found') return null;
                    throw err;
                }
            },

            /** POST /docs/mget -> { docs: { id: doc }, missing: [id] } */
            async mget(ids, { fields } = {}) {
                if (!Array.isArray(ids)) throw new TypeError(`mget: ids must be an array (got ${typeof ids})`);
                const unique = [...new Set(ids)];
                const docs = {};
                const missing = [];
                for (let i = 0; i < unique.length; i += MGET_MAX_IDS) {
                    const chunk = unique.slice(i, i + MGET_MAX_IDS);
                    const body = { ids: chunk };
                    if (fields && fields.length) body.fields = fields;
                    const r = await request('POST', `${base}/docs/mget`, { json: body });
                    Object.assign(docs, r.docs || {});
                    if (r.missing) missing.push(...r.missing);
                }
                return { docs, missing };
            },

            /** PUT /doc?prefix= -> { id, doc, seq } */
            async insert(doc, { prefix } = {}) {
                const qs = prefix === undefined ? '' : `?prefix=${encodeURIComponent(prefix)}`;
                const r = await request('PUT', `${base}/doc${qs}`, { json: doc });
                return { id: r.id, doc: r.doc, seq: r.seq };
            },

            /** PUT /doc/:id -> { id, doc, seq } */
            async update(id, doc, { ifSeq } = {}) {
                const qs = ifSeq === undefined ? '' : `?if_seq=${ifSeq}`;
                const r = await request('PUT', `${base}/doc/${encodeURIComponent(id)}${qs}`, { json: doc });
                return { id: r.id, doc: r.doc, seq: r.seq };
            },

            /** PATCH /doc/:id -> { applied, seq, doc } */
            async patch(id, ops, { ifSeq } = {}) {
                if (!Array.isArray(ops) || ops.length === 0) {
                    throw new TypeError('patch: ops must be a non-empty array');
                }
                const qs = ifSeq === undefined ? '' : `?if_seq=${ifSeq}`;
                const r = await request('PATCH', `${base}/doc/${encodeURIComponent(id)}${qs}`, { json: { ops } });
                return { applied: r.applied, seq: r.seq, doc: r.doc };
            },

            /** Single-`set` PATCH convenience (one atomic journal commit). */
            async set(id, path, value) {
                return handle.patch(id, [{ op: 'set', path, value }]);
            },

            /** Single-`array_push` PATCH convenience. */
            async arrayPush(id, path, value) {
                return handle.patch(id, [{ op: 'array_push', path, value }]);
            },

            /** Single-`remove` PATCH convenience. */
            async remove(id, path) {
                return handle.patch(id, [{ op: 'remove', path }]);
            },

            /** DELETE /doc/:id -> { deleted, seq } */
            async delete(id) {
                const r = await request('DELETE', `${base}/doc/${encodeURIComponent(id)}`);
                return { deleted: r.deleted, seq: r.seq };
            },

            /** POST /doc/:id/restore -> { doc, seq } */
            async restore(id) {
                const r = await request('POST', `${base}/doc/${encodeURIComponent(id)}/restore`);
                return { doc: r.doc, seq: r.seq };
            },

            /**
             * POST /doc/:id/peek -> { id, seq, doc, ranges }.
             * A `seq`-pinned partial read. The engine rejects unknown body keys
             * (`deny_unknown_fields`), so only the keys the caller actually
             * asked for are sent.
             */
            async peek(id, { fields, textRanges, arraySlices, expectedSeq } = {}) {
                const body = {};
                if (fields !== undefined) body.fields = fields;
                if (textRanges !== undefined) body.text_ranges = textRanges;
                if (arraySlices !== undefined) body.array_slices = arraySlices;
                if (expectedSeq !== undefined) body.expected_seq = expectedSeq;
                const r = await request('POST', `${base}/doc/${encodeURIComponent(id)}/peek`, { json: body });
                return { id: r.id, seq: r.seq, doc: r.doc, ranges: r.ranges || {} };
            },

            /**
             * POST /search -> text-matching page.
             * `text` is required by the engine; `textFields` narrows the scan to
             * named fields. Cursor paging (`nextCursor`) is what makes a bounded
             * scan resumable — v3 (RAM-first) databases only.
             */
            async searchText({ query, textFields, filter, sort, sortKeys, fields, limit, offset, cursor, maxScanDocs } = {}) {
                if (typeof query !== 'string' || !query.trim()) {
                    throw new TypeError('searchText: query must be a non-empty string');
                }
                const body = { text: textFields ? { query, fields: textFields } : { query } };
                if (filter !== undefined) body.filter = filter;
                if (sort !== undefined) body.sort = sort;
                if (sortKeys !== undefined) body.sort_keys = sortKeys;
                if (fields !== undefined) body.fields = fields;
                if (limit !== undefined) body.limit = limit;
                if (offset !== undefined) body.offset = offset;
                if (cursor !== undefined) body.cursor = cursor;
                if (maxScanDocs !== undefined) body.max_scan_docs = maxScanDocs;
                const r = await request('POST', `${base}/search`, { json: body });
                return {
                    data: r.results || [],
                    total: r.total ?? 0,
                    count: r.count ?? (r.results?.length || 0),
                    tookMs: r.took_ms ?? 0,
                    scannedDocs: r.scanned_docs ?? 0,
                    nextCursor: r.next_cursor || null
                };
            },

            /** GET /schema -> { classification_profile, field_mapping, indexes } */
            async getSchema() {
                const r = await request('GET', `${base}/schema`);
                return r.schema;
            },

            /** PUT /schema -> the replaced schema (`{ field_mapping: [...] }`) */
            async setFieldMapping(fieldMapping) {
                if (!Array.isArray(fieldMapping)) {
                    throw new TypeError('setFieldMapping: fieldMapping must be an array');
                }
                const r = await request('PUT', `${base}/schema`, { json: { field_mapping: fieldMapping } });
                return r.schema;
            },

            /**
             * POST /query -> { total, count, results, took_ms }
             * `sort` is ONE `{ field, dir }` object (`dir`: "asc" | "desc") —
             * the engine has a single sort key per query and rejects anything
             * else, so an array here is a caller bug, not a preference.
             */
            async query({ filter = {}, sort = null, offset = 0, limit = QUERY_PAGE_LIMIT, fields = null } = {}) {
                const body = { filter, offset, limit };
                if (sort) {
                    if (typeof sort !== 'object' || Array.isArray(sort) || typeof sort.field !== 'string' || !sort.field) {
                        throw new TypeError('query: sort must be { field, dir: "asc"|"desc" }');
                    }
                    if (sort.dir !== undefined && sort.dir !== 'asc' && sort.dir !== 'desc') {
                        throw new TypeError(`query: sort.dir must be "asc" or "desc" (got ${String(sort.dir)})`);
                    }
                    body.sort = sort;
                }
                if (fields && fields.length) body.fields = fields;
                const r = await request('POST', `${base}/query`, { json: body });
                return { total: r.total, count: r.count, results: r.results, took_ms: r.took_ms };
            },

            /**
             * Pages a query until every matching document is collected. Offset
             * pagination is only safe for a stable sort (default: document
             * order); every listing caller here sorts by an immutable-ish key
             * (createdAt/updatedAt) and re-reads on the next request anyway.
             */
            async queryAll({ filter = {}, sort = null, fields = null, pageSize = QUERY_PAGE_LIMIT } = {}) {
                const size = assertPositiveInt(pageSize, 'queryAll: pageSize');
                const all = [];
                let total = null;
                for (;;) {
                    const page = await handle.query({ filter, sort, offset: all.length, limit: size, fields });
                    if (total === null) total = page.total;
                    if (page.results.length === 0) {
                        if (all.length < total) {
                            throw new Error(`ndb queryAll: empty page at ${all.length} of ${total} (db ${name})`);
                        }
                        break;
                    }
                    all.push(...page.results);
                    if (all.length >= total) break;
                }
                return all;
            },

            /** POST /find -> results array (field = value) */
            async findAll(field, value) {
                if (typeof field !== 'string' || !field) throw new TypeError('find: field is required');
                const out = [];
                // The legacy /find route returns everything at once (no cap), so
                // there is no paging here — just unwrap the envelope.
                const r = await request('POST', `${base}/find`, { json: { field, value } });
                out.push(...r.results);
                return out;
            },

            /** POST /find -> { count, results, took_ms } */
            async find(field, value) {
                if (typeof field !== 'string' || !field) throw new TypeError('find: field is required');
                const r = await request('POST', `${base}/find`, { json: { field, value } });
                return { count: r.count, results: r.results, took_ms: r.took_ms };
            },

            /** POST /find (range form) -> { count, results, took_ms } */
            async findRange(field, min, max) {
                if (typeof field !== 'string' || !field) throw new TypeError('findRange: field is required');
                const r = await request('POST', `${base}/find`, { json: { field, min, max } });
                return { count: r.count, results: r.results, took_ms: r.took_ms };
            },

            /** POST /facets -> facets object */
            async facets(fields) {
                if (!Array.isArray(fields) || fields.length === 0) {
                    throw new TypeError('facets: fields must be a non-empty string array');
                }
                const r = await request('POST', `${base}/facets`, { json: { fields } });
                return r.facets;
            },

            /** POST /index -> { field, type, created } (idempotent) */
            async createIndex(field, type = 'hash') {
                if (typeof field !== 'string' || !field) throw new TypeError('createIndex: field is required');
                if (type !== 'hash' && type !== 'btree') {
                    throw new TypeError(`createIndex: type must be "hash" or "btree" (got ${type})`);
                }
                const r = await request('POST', `${base}/index`, { json: { field, type } });
                return { field: r.index, type: r.type, created: r.created === undefined ? null : r.created };
            },

            /** POST /compact -> lineage */
            async compact() {
                const r = await request('POST', `${base}/compact`, { timeoutMs: 300_000 });
                return r.lineage;
            },

            /** POST /flush -> { ok } */
            async flush() {
                const r = await request('POST', `${base}/flush`);
                return { ok: r.ok };
            },

            /** GET /changes?since=&limit= -> change batch */
            async changes(since, { limit } = {}) {
                if (!Number.isInteger(since) || since < 0) {
                    throw new TypeError(`changes: since must be a non-negative integer (got ${String(since)})`);
                }
                const qs = new URLSearchParams({ since: String(since) });
                if (limit !== undefined) qs.set('limit', String(assertPositiveInt(limit, 'changes: limit')));
                const r = await request('GET', `${base}/changes?${qs}`);
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    from_seq: r.from_seq,
                    to_seq: r.to_seq,
                    last_seq: r.last_seq,
                    has_more: r.has_more,
                    changes: r.changes
                };
            },

            /** GET /snapshot -> one page of a pinned snapshot */
            async snapshot({ offset, limit, snapshotId } = {}) {
                const qs = new URLSearchParams();
                if (offset !== undefined) qs.set('offset', String(offset));
                if (limit !== undefined) qs.set('limit', String(assertPositiveInt(limit, 'snapshot: limit')));
                if (snapshotId !== undefined) qs.set('snapshot_id', snapshotId);
                const suffix = qs.toString() ? `?${qs}` : '';
                const r = await request('GET', `${base}/snapshot${suffix}`, { timeoutMs: 120_000 });
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    watermark_seq: r.watermark_seq,
                    snapshot_id: r.snapshot_id,
                    total: r.total,
                    count: r.count,
                    docs: r.docs
                };
            },

            /**
             * Every document of one frozen state, plus the seq that state was
             * taken at. The pin (server-side, 300 s) is what keeps the pages
             * drift-free while writes continue.
             */
            async fullSnapshot({ pageSize = 5_000 } = {}) {
                const size = assertPositiveInt(pageSize, 'fullSnapshot: pageSize');
                const first = await handle.snapshot({ offset: 0, limit: size });
                const docs = [...first.docs];
                if (docs.length >= first.total) {
                    return {
                        docs,
                        total: first.total,
                        source_epoch_uuid: first.source_epoch_uuid,
                        watermark_seq: first.watermark_seq,
                        snapshot_id: first.snapshot_id
                    };
                }
                if (!first.snapshot_id) {
                    throw new Error(`ndb snapshot: ${first.total} docs but no snapshot_id to page with (would drift)`);
                }
                while (docs.length < first.total) {
                    const page = await handle.snapshot({ offset: docs.length, limit: size, snapshotId: first.snapshot_id });
                    if (page.docs.length === 0) {
                        throw new Error(`ndb snapshot ${first.snapshot_id}: empty page at offset ${docs.length} of ${first.total}`);
                    }
                    docs.push(...page.docs);
                }
                return {
                    docs,
                    total: first.total,
                    source_epoch_uuid: first.source_epoch_uuid,
                    watermark_seq: first.watermark_seq,
                    snapshot_id: first.snapshot_id
                };
            },

            /** Convenience: just the documents of one frozen state. */
            async allSnapshotDocs(opts) {
                return (await handle.fullSnapshot(opts)).docs;
            },

            /** PUT /files/:bucket -> { ref, hash, ext, size } */
            async storeFile(bucket, buffer, filename) {
                if (!Buffer.isBuffer(buffer)) throw new TypeError('storeFile: buffer must be a Buffer');
                const b = encodeComponent('bucket', bucket);
                encodeComponent('filename', filename);
                const r = await request('PUT', `${base}/files/${b}`, {
                    body: buffer,
                    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename },
                    timeoutMs: 120_000
                });
                return { ref: r.ref, hash: r.hash, ext: r.ext, size: r.size };
            },

            /** GET /files/:bucket/:filename -> { buffer, contentType } | null (404) */
            async getFile(bucket, filename) {
                const b = encodeComponent('bucket', bucket);
                const f = encodeComponent('filename', filename);
                return requestRaw('GET', `${base}/files/${b}/${f}`, { timeoutMs: 120_000 });
            },

            /** DELETE /files/:bucket/:filename -> { deleted } (409 file_referenced unless force) */
            async releaseFile(bucket, filename, { force = false } = {}) {
                const b = encodeComponent('bucket', bucket);
                const f = encodeComponent('filename', filename);
                const qs = force ? '?force=true' : '';
                const r = await request('DELETE', `${base}/files/${b}/${f}${qs}`);
                return { deleted: r.deleted };
            },

            /** GET /files/:bucket -> [filename] */
            async listFiles(bucket) {
                const b = encodeComponent('bucket', bucket);
                const r = await request('GET', `${base}/files/${b}`);
                return r.files;
            },

            /** POST /files/gc -> { moved } */
            async gcBuckets() {
                const r = await request('POST', `${base}/files/gc`, { timeoutMs: 120_000 });
                return { moved: r.moved };
            }
        };

        return handle;
    }

    return {
        baseUrl: root,

        /** GET /health -> { ok, engine, version, dbs, allow_create } */
        health() {
            return request('GET', '/health');
        },

        /** GET /v2/dbs -> [descriptor] */
        async listDbs() {
            const r = await request('GET', '/v2/dbs');
            return r.dbs;
        },

        /** POST /v2/dbs -> db descriptor (201) */
        async createDb(name, { persistence, format } = {}) {
            encodeName('database', name);
            const body = { name };
            if (persistence !== undefined) body.persistence = persistence;
            if (format !== undefined) body.format = format;
            const r = await request('POST', '/v2/dbs', { json: body });
            return r.db;
        },

        db
    };
}

module.exports = { NdbError, createNdbClient };
