/**
 * Thin HTTP/1.1 client for `nvdb serve` (nVDB v2).
 *
 * Every non-2xx response throws NvdbHttpError with the server's explicit
 * HTTP status and structured error `code`. No retries, no silent fallbacks.
 */

class NvdbHttpError extends Error {
    constructor(status, code, message, route) {
        super(`nvdb ${route} (${status} ${code}): ${message}`);
        this.name = 'NvdbHttpError';
        this.status = status;
        this.code = code;
        this.route = route;
    }
}

function createV2Client(baseUrl, { timeoutMs = 30_000 } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
        throw new Error('createV2Client: baseUrl is required (e.g. http://127.0.0.1:3510)');
    }
    const root = baseUrl.replace(/\/+$/, '');

    async function request(method, path, body = undefined, reqTimeoutMs = timeoutMs) {
        const url = `${root}${path}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), reqTimeoutMs);
        const init = { method, signal: ctrl.signal };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }

        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`nvdb ${method} ${path} timed out after ${reqTimeoutMs}ms (${root})`);
            }
            throw new Error(`nvdb ${method} ${path} unreachable at ${root}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }

        const raw = await res.text();
        let data = null;
        if (raw.length > 0) {
            try {
                data = JSON.parse(raw);
            } catch {
                if (!res.ok) {
                    throw new NvdbHttpError(res.status, 'non_json_error', raw.slice(0, 300), `${method} ${path}`);
                }
                throw new Error(`nvdb ${method} ${path} returned non-JSON body: ${raw.slice(0, 200)}`);
            }
        }

        if (!res.ok) {
            const code = data?.code || `http_${res.status}`;
            const message = data?.error || raw.slice(0, 300) || res.statusText;
            throw new NvdbHttpError(res.status, code, message, `${method} ${path}`);
        }
        return data;
    }

    function encodeCollection(name) {
        if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') {
            throw new TypeError(`Invalid collection name: ${String(name)}`);
        }
        return encodeURIComponent(name);
    }

    return {
        baseUrl: root,

        /** GET /health -> { ok, engine, collections, reranker_loaded? } */
        health() {
            return request('GET', '/health');
        },

        /** GET /v2/collections -> { collections: [{ name, doc_count, acl_generation, watermark }] } */
        listCollections() {
            return request('GET', '/v2/collections');
        },

        /** POST /v2/collections -> { ok, collection } */
        createCollection(name, config = undefined) {
            encodeCollection(name);
            const body = config === undefined ? { name } : { name, config };
            return request('POST', '/v2/collections', body);
        },

        /** POST /v2/collections/:name/upsert -> { upserted } */
        upsert(name, docs, { commit = true, timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/upsert`, { docs, commit }, t);
        },

        /** POST /v2/collections/:name/delete -> { deleted } */
        deleteIds(name, ids, { commit = true, timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/delete`, { ids, commit }, t);
        },

        /** POST /v2/collections/:name/acl -> { ok, acl_generation } */
        updateAcl(name, id, acl, { commit = true } = {}) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/acl`, { id, acl, commit });
        },

        /** POST /v2/collections/:name/commit -> { ok, doc_count } */
        commit(name, { timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/commit`, undefined, t);
        },

        /** POST /v2/collections/:name/search -> { hits, took_ms } */
        search(name, query) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/search`, query);
        },

        /** POST /v2/collections/:name/hybrid_search -> { hits, took_ms } */
        hybridSearch(name, query) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/hybrid_search`, query);
        },

        /** GET /v2/collections/:name/pending_embeddings?limit=N -> { count, pending } */
        pendingEmbeddings(name, limit = 100) {
            const c = encodeCollection(name);
            const n = Number(limit);
            if (!Number.isInteger(n) || n <= 0) {
                throw new TypeError(`pendingEmbeddings: limit must be a positive integer (got ${limit})`);
            }
            return request('GET', `/v2/collections/${c}/pending_embeddings?limit=${n}`);
        },

        /** POST /v2/collections/:name/attach_vectors -> { attached, vec_generation } */
        attachVectors(name, attachments, { timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/attach_vectors`, { attachments }, t);
        },

        /** GET /v2/collections/:name/fingerprints -> { doc_count, watermark, entries } */
        fingerprints(name, { timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request('GET', `/v2/collections/${c}/fingerprints`, undefined, t);
        },

        /** POST /v2/collections/:name/integrity_check -> { clean, missing, extra, content_mismatched, envelope_mismatched, missing_vectors } */
        integrityCheck(name, expected, { checkVectors = false, timeoutMs: t } = {}) {
            const c = encodeCollection(name);
            return request(
                'POST',
                `/v2/collections/${c}/integrity_check`,
                { expected, check_vectors: checkVectors },
                t ?? 60_000
            );
        },

        /** POST /v2/collections/:name/watermark -> { ok, watermark } */
        setWatermark(name, watermark) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/watermark`, watermark);
        },

        /** POST /v2/collections/:name/level2 -> { rejected, best_rerank_score, hits } */
        level2(name, payload) {
            const c = encodeCollection(name);
            return request('POST', `/v2/collections/${c}/level2`, payload);
        },
    };
}

module.exports = { NvdbHttpError, createV2Client };
