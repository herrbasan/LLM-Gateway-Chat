/**
 * nDB → nVDB incremental sync for the `chat` collection (Phase 4b).
 *
 * The collection is ONE shared nVDB collection; each user owns the chunk ids
 * prefixed `<userId>:`. Two ways to make it match the user's `chat_<username>`
 * database:
 *
 *   incremental — replay `GET /v2/dbs/:n/changes?since=<watermark>` and rebuild
 *                 only the touched conversations (the steady state).
 *   rebuild     — read one pinned `snapshot` and BLAKE3-diff every chunk
 *                 (no watermark, epoch changed, `409 cursor_expired`).
 *
 * The watermark lives in `chat_users` — deliberately NOT in the user's own DB,
 * because writing it there would advance that DB's own `last_seq` and the sync
 * would chase its own tail forever. nDB assigns `_id`, so the watermark is
 * addressed by `key` (`nvdb_wm_<username>`).
 *
 * Everything here is injected so the engine can run against a throwaway
 * `ndb serve` in tests exactly as it runs in the live server.
 */

const NVDB_WM_BATCH = 250;
const UPSERT_BATCH = 200;
const DRAIN_PAGE = 256;
const SNAPSHOT_RETRIES = 2;

function createNvdbSync({ usersDb, log, chunkOpts, expectedDocsFromDocs, parseChatChunkId, afterSync }) {
    if (typeof usersDb !== 'function') throw new Error('createNvdbSync: usersDb accessor required');
    if (typeof log !== 'function') throw new Error('createNvdbSync: log accessor required');

    const usersHandle = () => {
        const handle = usersDb();
        if (!handle) throw new Error('nvdb-sync: chat_users handle not available');
        return handle;
    };

    function watermarkKey(username) {
        if (typeof username !== 'string' || !username) throw new Error('nvdb-sync: username required');
        return `nvdb_wm_${username}`;
    }

    async function readWatermark(username) {
        const key = watermarkKey(username);
        const rows = await usersHandle().findAll('key', key);
        return rows.find(r => r._type === 'nvdb_watermark') || null;
    }

    /** Persist the watermark AFTER the nVDB commit — never before. */
    async function writeWatermark(username, sourceEpochUuid, syncedSeq) {
        const key = watermarkKey(username);
        const db = usersHandle();
        const rows = await db.findAll('key', key);
        const existing = rows.find(r => r._type === 'nvdb_watermark');
        const doc = {
            _type: 'nvdb_watermark',
            key,
            username,
            source_epoch_uuid: sourceEpochUuid,
            synced_seq: syncedSeq,
            updatedAt: new Date().toISOString()
        };
        if (existing) {
            doc._id = existing._id;
            await db.update(existing._id, doc);
        } else {
            await db.insert(doc);
        }
        return doc;
    }

    /** Upsert/delete a diff in bounded batches, one commit at the end. */
    async function applyDiff(instance, toUpsert, toDelete) {
        const client = instance.nvdbClient;
        const collection = instance.nvdbCollection;
        let upserted = 0;
        let deleted = 0;
        for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
            const chunk = toUpsert.slice(i, i + UPSERT_BATCH);
            await client.upsert(collection, chunk, { commit: false });
            upserted += chunk.length;
        }
        for (let i = 0; i < toDelete.length; i += UPSERT_BATCH) {
            const chunk = toDelete.slice(i, i + UPSERT_BATCH);
            await client.deleteIds(collection, chunk, { commit: false });
            deleted += chunk.length;
        }
        if (upserted > 0 || deleted > 0) await client.commit(collection);
        return { upserted, deleted };
    }

    /** This user's slice of the collection's envelope fingerprints, by chunk id. */
    async function userFingerprints(instance) {
        const prefix = `${instance.userId}:`;
        const fp = await instance.nvdbClient.fingerprints(instance.nvdbCollection);
        const existing = new Map();
        for (const entry of fp?.entries || []) {
            if (typeof entry?.id === 'string' && entry.id.startsWith(prefix)) existing.set(entry.id, entry);
        }
        return existing;
    }

    /**
     * Re-write the v2 documents of these session ids (a changed conversation or
     * session doc), deleting the chunk ids the changed state no longer owns.
     * `existing` (chunk id -> fingerprint) is kept current for the caller.
     */
    async function syncSessionIds(instance, sessionIds, existing) {
        const toUpsert = [];
        const toDelete = [];
        let unchanged = 0;

        for (const sessionId of sessionIds) {
            const docs = await instance.db.findAll('id', sessionId);
            const expected = expectedDocsFromDocs({ userId: instance.userId, docs, chunkOpts });
            const newIds = new Set();
            for (const [id, rec] of expected.byId) {
                newIds.add(id);
                const known = existing.get(id);
                if (known && known.envelope_hash === rec.envelope_hash) { unchanged++; continue; }
                toUpsert.push(rec.doc);
                existing.set(id, { id, envelope_hash: rec.envelope_hash, has_vector: false });
            }
            for (const id of [...existing.keys()]) {
                if (!id.startsWith(`${instance.userId}:${sessionId}:`) || newIds.has(id)) continue;
                toDelete.push(id);
                existing.delete(id);
            }
        }

        const { upserted, deleted } = await applyDiff(instance, toUpsert, toDelete);
        return { upserted, deleted, unchanged };
    }

    /**
     * Delete this user's chunk ids whose session no longer exists — the only
     * sound way to handle a `delete` change event, which carries no document
     * body (and therefore no session id).
     */
    async function sweepDeletedSessions(instance, existing) {
        const live = new Set(
            (await instance.db.queryAll({ filter: { _type: 'session' }, fields: ['id'] })).map(d => d.id)
        );
        const toDelete = [];
        for (const id of [...existing.keys()]) {
            const parsed = parseChatChunkId(id, instance.userId);
            if (!parsed) continue;
            if (live.has(parsed.sessionId)) continue;
            toDelete.push(id);
            existing.delete(id);
        }
        if (toDelete.length === 0) return { deleted: 0 };
        const { deleted } = await applyDiff(instance, [], toDelete);
        return { deleted };
    }

    /** Replay the change feed from the watermark and rebuild what changed. */
    async function drainIncremental(instance, watermark, lineage) {
        const db = instance.db;
        if (watermark.source_epoch_uuid !== lineage.source_epoch_uuid) {
            throw new Error(
                `nVDB incremental sync: watermark epoch ${watermark.source_epoch_uuid} != source epoch ` +
                `${lineage.source_epoch_uuid} (db ${instance.dbName})`
            );
        }
        const existing = await userFingerprints(instance);
        let cursor = watermark.synced_seq;
        const startSeq = cursor;
        let sawDelete = false;
        let totalUpserted = 0;
        let totalDeleted = 0;

        while (cursor < lineage.last_seq) {
            const batch = await db.changes(cursor, { limit: NVDB_WM_BATCH });
            if (batch.source_epoch_uuid !== watermark.source_epoch_uuid) {
                throw new Error(
                    `nVDB incremental sync: source epoch changed mid-drain ` +
                    `(${watermark.source_epoch_uuid} -> ${batch.source_epoch_uuid})`
                );
            }
            if (batch.changes.length === 0) {
                if (batch.has_more) {
                    throw new Error(`ndb changes: empty batch at seq ${cursor} with has_more=true (db ${instance.dbName})`);
                }
                break;
            }
            const touched = new Set();
            for (const change of batch.changes) {
                if (change.kind === 'delete') { sawDelete = true; continue; }
                const doc = change.doc;
                if (!doc || (doc._type !== 'conversation' && doc._type !== 'session')) continue;
                if (doc.id) touched.add(doc.id);
            }
            if (touched.size > 0) {
                const res = await syncSessionIds(instance, [...touched], existing);
                totalUpserted += res.upserted;
                totalDeleted += res.deleted;
            }
            if (sawDelete) {
                const res = await sweepDeletedSessions(instance, existing);
                totalDeleted += res.deleted;
                sawDelete = false;
            }
            // The watermark advances only after this batch's nVDB commit.
            cursor = batch.to_seq;
            watermark = await writeWatermark(instance.username, batch.source_epoch_uuid, cursor);
            if (!batch.has_more) break;
        }

        log().info('nVDB incremental sync complete', {
            userId: instance.userId,
            db: instance.dbName,
            fromSeq: startSeq,
            syncedSeq: cursor,
            lastSeq: lineage.last_seq,
            upserted: totalUpserted,
            deleted: totalDeleted
        }, 'Server');
        return { mode: 'incremental', syncedSeq: cursor, upserted: totalUpserted, deleted: totalDeleted };
    }

    /**
     * Pinned-snapshot rebuild: one frozen read, hash-diffed against the stored
     * fingerprints so unchanged chunks keep their vectors (zero re-embeds).
     * A 410 `snapshot_expired` (the 300 s pin timed out mid-page) is retried
     * from scratch — a fresh snapshot is the only sound restart point.
     */
    async function rebuildFromSnapshot(instance, reason, attempt = 0) {
        const db = instance.db;
        let snap;
        try {
            snap = await db.fullSnapshot();
        } catch (err) {
            if (err && err.code === 'snapshot_expired' && attempt < SNAPSHOT_RETRIES) {
                log().warn('nDB snapshot expired mid-rebuild — retrying from a fresh snapshot', {
                    userId: instance.userId,
                    db: instance.dbName,
                    reason,
                    attempt: attempt + 1
                }, 'Server');
                return rebuildFromSnapshot(instance, reason, attempt + 1);
            }
            throw err;
        }
        const expected = expectedDocsFromDocs({ userId: instance.userId, docs: snap.docs, chunkOpts });
        const existing = await userFingerprints(instance);

        const toUpsert = [];
        const toDelete = [];
        for (const [id, rec] of expected.byId) {
            const known = existing.get(id);
            if (!known || known.envelope_hash !== rec.envelope_hash) toUpsert.push(rec.doc);
        }
        for (const id of existing.keys()) {
            if (!expected.byId.has(id)) toDelete.push(id);
        }
        const { upserted, deleted } = await applyDiff(instance, toUpsert, toDelete);
        await writeWatermark(instance.username, snap.source_epoch_uuid, snap.watermark_seq);
        log().info('nVDB rebuilt from pinned snapshot', {
            userId: instance.userId,
            db: instance.dbName,
            reason,
            snapshotSeq: snap.watermark_seq,
            total: expected.docs.length,
            upserted,
            deleted,
            unchanged: expected.docs.length - upserted
        }, 'Server');

        // One incremental catch-up pass for everything written while the
        // snapshot was being diffed. A second epoch change here is a real
        // anomaly, not a race we retry silently.
        const lineage = await db.lineage();
        if (lineage.last_seq > snap.watermark_seq) {
            if (lineage.source_epoch_uuid !== snap.source_epoch_uuid) {
                throw new Error(
                    `nVDB rebuild: source epoch changed during the catch-up window ` +
                    `(${snap.source_epoch_uuid} -> ${lineage.source_epoch_uuid}, db ${instance.dbName}) — rerun the sync`
                );
            }
            const wm = await readWatermark(instance.username);
            return await drainIncremental(instance, wm, lineage);
        }
        return { mode: 'rebuild', syncedSeq: snap.watermark_seq, upserted, deleted };
    }

    /**
     * Bring this user's slice of the shared nVDB collection in line with the
     * user's `chat_<username>` database. Single-flight per instance: a mount, a
     * timer and a write-through advance never run two reconciliations at once.
     *
     * `forceVerify` (watchdog path) also proves the slice still EXISTS: an nVDB
     * that was restarted with a wiped collection reports the same watermark and
     * seq, so the noop branch would happily leave every vector missing.
     */
    async function reconcileUserNvdb(instance, { forceVerify = false } = {}) {
        if (instance.reconcileRunning) return instance.reconcileRunning;
        const run = doReconcile(instance, { forceVerify }).finally(() => { instance.reconcileRunning = null; });
        instance.reconcileRunning = run;
        return run;
    }

    /**
     * A wiped collection leaves the watermark intact (it lives in `chat_users`),
     * so `synced_seq === last_seq` would short-circuit to noop forever. The test
     * is per-user: the SHARED collection's doc_count being 0 proves nothing with
     * several users mounted.
     */
    async function verifyUserSlicePresent(instance) {
        const existing = await userFingerprints(instance);
        if (existing.size > 0) return false;
        const docs = await instance.db.query({
            filter: { _type: 'conversation' },
            limit: 1,
            fields: ['_id']
        });
        return (docs.count || 0) > 0 || (docs.results || []).length > 0;
    }

    async function doReconcile(instance, { forceVerify = false } = {}) {
        if (!instance?.nvdbClient) throw new Error('reconcileUserNvdb: instance needs nvdbClient');
        if (!instance.userId) throw new Error('reconcileUserNvdb: instance.userId required');
        if (!instance.username) throw new Error('reconcileUserNvdb: instance.username required (watermark key)');
        if (!instance.db || typeof instance.db.lineage !== 'function') {
            throw new Error('reconcileUserNvdb: instance.db must be an nDB handle');
        }

        const lineage = await instance.db.lineage();
        const watermark = await readWatermark(instance.username);

        let result;
        if (!watermark) {
            result = await rebuildFromSnapshot(instance, 'no_watermark');
        } else if (watermark.source_epoch_uuid !== lineage.source_epoch_uuid) {
            log().warn('nVDB sync: source epoch changed — rebuilding', {
                userId: instance.userId,
                db: instance.dbName,
                fromEpoch: watermark.source_epoch_uuid,
                toEpoch: lineage.source_epoch_uuid
            }, 'Server');
            result = await rebuildFromSnapshot(instance, 'epoch_changed');
        } else if (watermark.synced_seq > lineage.last_seq) {
            throw new Error(
                `nVDB sync watermark '${watermark.key}' is AHEAD of the source ` +
                `(synced_seq ${watermark.synced_seq} > last_seq ${lineage.last_seq}, ` +
                `epoch ${lineage.source_epoch_uuid}, db ${instance.dbName}) — monotonic seq invariant violated`
            );
        } else if (watermark.synced_seq === lineage.last_seq) {
            const wiped = forceVerify && watermark.synced_seq > 0 && await verifyUserSlicePresent(instance);
            if (wiped) {
                log().warn('nVDB appears wiped for user; rebuilding from snapshot', {
                    userId: instance.userId,
                    db: instance.dbName,
                    syncedSeq: watermark.synced_seq
                }, 'Server');
                result = await rebuildFromSnapshot(instance, 'nvdb_wiped');
            } else {
                result = { mode: 'noop', syncedSeq: watermark.synced_seq };
            }
        } else {
            try {
                result = await drainIncremental(instance, watermark, lineage);
            } catch (err) {
                if (err && err.code === 'cursor_expired') {
                    log().warn('nVDB sync cursor expired — falling back to a pinned-snapshot rebuild', {
                        userId: instance.userId,
                        db: instance.dbName,
                        requestedSeq: watermark.synced_seq,
                        minAvailableSeq: err.body?.min_available_seq,
                        lastSeq: err.body?.last_seq
                    }, 'Server');
                    result = await rebuildFromSnapshot(instance, 'cursor_expired');
                } else if (err && err.code === 'cursor_ahead') {
                    throw new Error(
                        `nVDB sync watermark '${watermark.key}' is AHEAD of the source ` +
                        `(ndb 409 cursor_ahead at seq ${watermark.synced_seq}, last_seq ${err.body?.last_seq}, ` +
                        `db ${instance.dbName}) — monotonic seq invariant violated`
                    );
                } else {
                    throw err;
                }
            }
        }

        if (typeof afterSync === 'function') await afterSync(instance, result);
        return result;
    }

    return { reconcileUserNvdb, readWatermark, writeWatermark, watermarkKey, userFingerprints };
}

/**
 * The vector-drain half of a reconciliation: after the lexical documents exist,
 * every nVDB chunk this user owns that is still missing a vector gets one here.
 *
 * A factory (not a method on createNvdbSync) so the server can wire the REAL
 * function — the one its timers and afterSync hooks call — and a test can call
 * that same function with stub embedding deps instead of a copy of the loop.
 */
function createVectorDrainer({
    buildUserExpectedDocs,
    userFingerprints,
    acquireEmbedSlot,
    releaseEmbedSlot,
    embedBatch,
    attachVectorsQuietly,
    isEmbedAvailable,
    buildChatVectorInput,
    parseChatChunkId,
    embeddingDims,
    embedModelVersion,
    log,
    onNvdbError = null,
    isNvdbUnavailableError = () => false
}) {
    const required = {
        buildUserExpectedDocs, userFingerprints, acquireEmbedSlot, releaseEmbedSlot,
        embedBatch, attachVectorsQuietly, isEmbedAvailable, buildChatVectorInput,
        parseChatChunkId, log
    };
    for (const [name, value] of Object.entries(required)) {
        if (typeof value !== 'function') throw new Error(`createVectorDrainer: ${name} must be a function`);
    }
    if (!Number.isInteger(embeddingDims) || embeddingDims <= 0) {
        throw new Error(`createVectorDrainer: embeddingDims must be a positive integer (got ${embeddingDims})`);
    }
    if (typeof embedModelVersion !== 'string' || !embedModelVersion) {
        throw new Error('createVectorDrainer: embedModelVersion required');
    }

    function countAttached(attachments, counts) {
        for (const att of attachments) {
            const parsed = parseChatChunkId(att.id, undefined);
            if (!parsed) continue;
            const key = `${parsed.sessionId}\u0000${parsed.msgIdx}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    async function drainPendingVectors(instance, syncResult) {
        // Guard BEFORE any work: a concurrent drain owns this instance, and an
        // unavailable embed endpoint means nothing can be attached anyway.
        if (!isEmbedAvailable()) return;
        if (instance.drainRunning) return;
        instance.drainRunning = true;
        try {
            await runDrain(instance, syncResult);
        } catch (err) {
            // nVDB transport/5xx mid-drain is an outage, not a bug: report it to
            // the caller's outage tracker and leave the rest to the next tick.
            if (onNvdbError && isNvdbUnavailableError(err)) {
                onNvdbError(instance, err, 'drainPendingVectors');
                return;
            }
            throw err;
        } finally {
            instance.drainRunning = false;
        }
    }

    async function runDrain(instance, syncResult) {
        const { nvdbClient: client, userId, db } = instance;
        const collection = instance.nvdbCollection;
        const prefix = `${userId}:`;

        const probe = await client.pendingEmbeddings(collection, DRAIN_PAGE);
        const hasOwnWork = (probe?.pending || []).some(item => typeof item?.id === 'string' && item.id.startsWith(prefix));
        if (!hasOwnWork) {
            log().info('nVDB sync complete', { userId, db: instance.dbName, mode: syncResult?.mode, pending: 0 }, 'Embed');
            return;
        }

        const { byId } = await buildUserExpectedDocs({ userId, db, chunkOpts: instance.nvdbChunkOpts });
        const existing = await userFingerprints(instance);

        const expectedChunks = new Map();
        const attachedCounts = new Map();
        for (const [id, rec] of byId) {
            const key = `${rec.session.id}\u0000${rec.msgIdx}`;
            const cur = expectedChunks.get(key);
            if (cur) cur.count++;
            else expectedChunks.set(key, { count: 1, convNdbId: rec.convNdbId, msgId: rec.msg?.id || null, sessionId: rec.session.id, msgIdx: rec.msgIdx });
            const known = existing.get(id);
            if (known && known.has_vector === true && known.envelope_hash === rec.envelope_hash) {
                attachedCounts.set(key, (attachedCounts.get(key) || 0) + 1);
            }
        }
        let lastPendingKey = null;

        for (;;) {
            if (!isEmbedAvailable()) break;
            const res = await client.pendingEmbeddings(collection, DRAIN_PAGE);
            const pending = Array.isArray(res?.pending) ? res.pending : [];
            // Only this user's items, and only those whose stored text still matches.
            const work = [];
            for (const item of pending) {
                const rec = byId.get(item?.id);
                if (!rec) continue;
                if (item.content_hash && item.content_hash !== rec.content_hash) continue;
                work.push({ id: item.id, content_hash: rec.content_hash, doc: rec.doc });
            }
            if (work.length === 0) break;
            // A batch the service keeps re-reporting never drains (it rejected
            // some ids) — stop instead of spinning on it.
            const pendingKey = work.map(w => w.id).join(',');
            if (pendingKey === lastPendingKey) {
                log().warn('nVDB drain made no progress — stopping', { userId, pending: work.length }, 'Embed');
                break;
            }
            lastPendingKey = pendingKey;

            const attachments = [];
            for (let i = 0; i < work.length; i += 8) {
                const slice = work.slice(i, i + 8);
                await acquireEmbedSlot(instance);
                let vectors;
                try {
                    vectors = await embedBatch(slice.map(w => buildChatVectorInput(w.doc)));
                } finally {
                    releaseEmbedSlot(instance);
                }
                for (let j = 0; j < slice.length; j++) {
                    const vector = vectors[j];
                    if (!Array.isArray(vector) || vector.length !== embeddingDims) {
                        throw new Error(`invalid_vector_shape (${slice[j].id}): expected ${embeddingDims} dims`);
                    }
                    attachments.push({
                        id: slice[j].id,
                        content_hash: slice[j].content_hash,
                        model_version: embedModelVersion,
                        vector
                    });
                }
                if (attachments.length >= DRAIN_PAGE) {
                    if (!(await attachVectorsQuietly(instance, attachments))) return;
                    countAttached(attachments, attachedCounts);
                    attachments.length = 0;
                }
            }
            if (attachments.length > 0) {
                if (!(await attachVectorsQuietly(instance, attachments))) return;
                countAttached(attachments, attachedCounts);
            }
        }

        // A message is only 'embedded' once every one of its chunks has a vector.
        // Skip writes when nDB already matches so a clean mount stays write-free.
        const convCache = new Map();
        const opsByConv = new Map();
        for (const [key, info] of expectedChunks) {
            if ((attachedCounts.get(key) || 0) < info.count) continue;
            if (!info.convNdbId || !info.msgId) continue;
            let conv = convCache.get(info.sessionId);
            if (conv === undefined) {
                conv = (await instance.db.findAll('id', info.sessionId)).find(d => d._type === 'conversation') || null;
                convCache.set(info.sessionId, conv);
            }
            const stored = conv?.messages?.[info.msgIdx];
            if (!stored || stored.id !== info.msgId) continue;
            if (stored.embedStatus === 'embedded' && stored.embedChunks === info.count && !stored.embedError) continue;
            const ops = opsByConv.get(info.convNdbId) || [];
            ops.push(
                { op: 'set', path: `messages.${info.msgIdx}.embedStatus`, value: 'embedded' },
                { op: 'set', path: `messages.${info.msgIdx}.embedChunks`, value: info.count },
                { op: 'set', path: `messages.${info.msgIdx}.embedError`, value: null }
            );
            opsByConv.set(info.convNdbId, ops);
        }
        let marked = 0;
        for (const [convNdbId, ops] of opsByConv) {
            try {
                await instance.db.patch(convNdbId, ops);
                marked += ops.length / 3;
            } catch (err) {
                // The message was deleted between the read and the write: the
                // mark is moot, but the rejection stays visible.
                log().warn('Embed status mark skipped', { userId, convNdbId, error: err.message }, 'Embed');
            }
        }
        if (marked > 0) log().info('nVDB reconciliation marked messages embedded', { userId, marked }, 'Embed');
    }

    return drainPendingVectors;
}

module.exports = { createNvdbSync, createVectorDrainer };
