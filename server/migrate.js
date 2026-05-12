// ============================================
// Migration Script: NeDB → nDB + nVDB
// ============================================
// Run:
//   node server/migrate.js                                    # Local only
//   node server/migrate.js --remote <UNC_path>                # Local + remote
//   node server/migrate.js --dry-run                          # Validate only
// ============================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Database: nDB } = require('../lib/ndb/napi');

// ============================================
// Config
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
const NDB_PATH = path.join(DATA_DIR, 'chat_app');
const FILES_DIR = path.join(DATA_DIR, 'files');

const MIGRATION_USER = {
    _type: 'user',
    id: 'user-migrated-default',
    apiKey: 'migrated-' + crypto.randomUUID(),
    displayName: 'Legacy User',
    createdAt: new Date().toISOString(),
    isMigrated: true
};

// ============================================
// CLI
// ============================================

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        remotePath: null,
        dryRun: false
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--remote' && args[i + 1]) {
            opts.remotePath = args[i + 1];
            i++;
        } else if (args[i] === '--dry-run') {
            opts.dryRun = true;
        }
    }
    return opts;
}

// ============================================
// Helpers
// ============================================

function stripTimestamp(content) {
    if (!content) return '';
    return content.replace(/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/, '').trim();
}

function tsToIso(timestamp) {
    return new Date(timestamp).toISOString();
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen).trim() + '...';
}

function isEmptyContent(content) {
    if (!content) return true;
    const stripped = stripTimestamp(content);
    return stripped === '';
}

// ============================================
// NeDB Reader
// ============================================

function readNeDB(storagePath) {
    const lines = fs.readFileSync(storagePath, 'utf8').trim().split('\n');
    const records = { conv: {}, arena: {}, history: null, activeChatId: null };

    for (const line of lines) {
        let doc;
        try {
            doc = JSON.parse(line);
        } catch (e) {
            console.warn('  Skipping malformed line:', e.message.slice(0, 80));
            continue;
        }

        if (doc.key.startsWith('conv:')) {
            records.conv[doc.key.replace('conv:', '')] = doc.value;
        } else if (doc.key.startsWith('arena:session:')) {
            records.arena[doc.key.replace('arena:session:', '')] = doc.value;
        } else if (doc.key === 'history:') {
            records.history = doc.value;
        } else if (doc.key === 'activeChatId') {
            records.activeChatId = doc.value;
        }
    }

    return records;
}

// ============================================
// File Scanner
// ============================================

function scanFiles(filesDir) {
    const mapping = {};
    if (!fs.existsSync(filesDir)) return mapping;

    const entries = fs.readdirSync(filesDir);
    for (const entry of entries) {
        const fullPath = path.join(filesDir, entry);
        if (!fs.statSync(fullPath).isFile()) continue;

        // File naming: {exchangeId}_{index}.{ext}
        const match = entry.match(/^(ex_\d+_[a-z0-9]+)_(\d+)\.(.+)$/);
        if (!match) continue;

        const exchangeId = match[1];
        const attIndex = parseInt(match[2], 10);
        const ext = match[3];

        if (!mapping[exchangeId]) mapping[exchangeId] = [];
        mapping[exchangeId][attIndex] = {
            filename: entry,
            sourcePath: fullPath,
            ext: ext,
            index: attIndex
        };
    }

    return mapping;
}

// ============================================
// Session Migration
// ============================================

function getTitle(exchanges, historyEntry) {
    if (historyEntry?.title && historyEntry.title !== 'New Chat') return historyEntry.title;
    const firstEx = exchanges[0];
    if (firstEx?.user?.content) {
        return truncate(stripTimestamp(firstEx.user.content), 100);
    }
    return 'Untitled';
}

function getModel(exchanges, historyEntry) {
    if (historyEntry?.model) return historyEntry.model;
    for (const ex of exchanges) {
        if (ex.assistant?.context?.model) return ex.assistant.context.model;
    }
    return 'unknown';
}

function getTimestamps(exchanges) {
    const first = exchanges[0];
    const last = exchanges[exchanges.length - 1];
    return {
        createdAt: first ? tsToIso(first.timestamp) : new Date().toISOString(),
        updatedAt: last ? tsToIso(last.timestamp) : new Date().toISOString()
    };
}

function migrateConversation(chatId, exchanges, db, userId, fileMap, stats) {
    const historyEntry = stats.historyIndex?.find(h => h.id === chatId);
    const timestamps = getTimestamps(exchanges);

    const session = {
        _type: 'session',
        id: chatId,
        userId: userId,
        title: getTitle(exchanges, historyEntry),
        mode: 'direct',
        model: getModel(exchanges, historyEntry),
        createdAt: timestamps.createdAt,
        updatedAt: timestamps.updatedAt,
        messageCount: 0,
        isPublic: false
    };

    if (stats.dryRun) {
        stats.sessions++;
        stats.activeExchanges += exchanges.length;
        return;
    }

    const sessionNdbId = db.insert(session);
    stats.sessions++;

    let turnIndex = 0;
    for (const ex of exchanges) {
        let userExported = false;
        let assistantExported = false;
        let toolExported = false;

        // User message
        if (ex.user && !isEmptyContent(ex.user.content)) {
            const attachments = buildAttachmentRefs(ex.id, ex.user.attachments || [], chatId, fileMap);
            db.insert({
                _type: 'message',
                id: ex.id + '-user',
                sessionId: chatId,
                userId: userId,
                role: 'user',
                model: null,
                content: stripTimestamp(ex.user.content),
                rawContent: ex.user.content,
                attachments: attachments,
                turnIndex: turnIndex,
                createdAt: tsToIso(ex.timestamp)
            });
            session.messageCount++;
            stats.messages++;
            if (attachments.length > 0) stats.filesLinked++;
            userExported = true;
        }

        // Assistant message — skip if stripped content is empty (176 cases)
        if (ex.assistant && ex.assistant.isComplete && !isEmptyContent(ex.assistant.content)) {
            const versions = (ex.assistant.versions || [])
                .filter(v => v.content && !isEmptyContent(v.content))
                .map(v => ({
                    content: stripTimestamp(v.content),
                    context: v.context || null,
                    usage: v.usage || null,
                    timestamp: v.timestamp || null
                }));

            db.insert({
                _type: 'message',
                id: ex.id + '-assistant',
                sessionId: chatId,
                userId: userId,
                role: 'assistant',
                model: getModel([ex], null),
                content: stripTimestamp(ex.assistant.content),
                rawContent: ex.assistant.content,
                versions: versions.length > 0 ? versions : null,
                attachments: [],
                turnIndex: turnIndex,
                createdAt: tsToIso(ex.timestamp)
            });
            session.messageCount++;
            stats.messages++;
            assistantExported = true;
        } else if (ex.assistant && !ex.assistant.isComplete) {
            stats.skippedEmptyAssistant++;
        } else if (ex.assistant && ex.assistant.isComplete && isEmptyContent(ex.assistant.content)) {
            stats.skippedEmptyAssistant++;
        }

        // Tool message
        if (ex.type === 'tool' && ex.tool && ex.tool.content) {
            db.insert({
                _type: 'message',
                id: ex.id + '-tool',
                sessionId: chatId,
                userId: userId,
                role: 'tool',
                model: null,
                content: ex.tool.content || '',
                rawContent: ex.tool.content || '',
                toolName: ex.tool.name || null,
                toolArgs: ex.tool.args || null,
                toolStatus: ex.tool.status || null,
                turnIndex: turnIndex,
                createdAt: tsToIso(ex.timestamp)
            });
            session.messageCount++;
            stats.messages++;
            toolExported = true;
        }

        if (userExported || assistantExported || toolExported) {
            turnIndex++;
        }
    }

    // Update session messageCount
    db.update(sessionNdbId, session);
}

// ============================================
// Attachment Reference Builder
// ============================================

function buildAttachmentRefs(exchangeId, attachments, sessionId, fileMap) {
    if (!attachments || attachments.length === 0) return [];

    const exFiles = fileMap[exchangeId] || [];

    return attachments.map((att, idx) => {
        const fileInfo = exFiles[idx];
        const ref = {
            name: att.name || 'unknown',
            type: att.type || 'application/octet-stream',
            hasImage: att.hasImage || false
        };

        if (fileInfo) {
            ref.blobUrl = '/files/' + sessionId + '/' + fileInfo.filename;
        }

        return ref;
    });
}

// ============================================
// Arena Migration
// ============================================

function migrateArena(arenaId, arenaData, db, userId, stats) {
    const session = {
        _type: 'session',
        id: arenaId,
        userId: userId,
        title: truncate(arenaData.topic || 'Arena Session', 200),
        mode: 'arena',
        arenaConfig: {
            modelA: arenaData.participants?.[0] || 'unknown',
            modelB: arenaData.participants?.[1] || 'unknown',
            promptVersion: 'v1',
            maxTurns: 20,
            autoAdvance: false
        },
        summary: arenaData.summary || null,
        createdAt: arenaData.exportedAt || new Date().toISOString(),
        updatedAt: arenaData.exportedAt || new Date().toISOString(),
        messageCount: 0,
        isPublic: false,
        publicSlug: null
    };

    if (stats.dryRun) {
        stats.arenaSessions++;
        stats.arenaMessages += (arenaData.messages || []).length;
        return;
    }

    const arenaNdbId = db.insert(session);
    stats.arenaSessions++;

    const msgs = arenaData.messages || [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const model = m.speaker === 'Model A' ? session.arenaConfig.modelA :
                      m.speaker === 'Model B' ? session.arenaConfig.modelB : null;

        db.insert({
            _type: 'message',
            id: arenaId + '-msg-' + i,
            sessionId: arenaId,
            userId: userId,
            role: m.role || 'assistant',
            model: model,
            content: m.content || '',
            rawContent: m.content || '',
            speaker: m.speaker || null,
            turnIndex: i,
            createdAt: arenaData.exportedAt || new Date().toISOString()
        });
        session.messageCount++;
        stats.arenaMessages++;
    }

    db.update(arenaNdbId, session);
}

// ============================================
// File Migration
// ============================================

function migrateFiles(fileMap, db, stats) {
    let copied = 0;
    let skipped = 0;

    // Build session lookup: exchangeId → sessionId
    const exchangeToSession = {};
    const messages = db.find('_type', 'message');
    for (const m of messages) {
        const baseId = m.id.replace(/-user$/, '').replace(/-assistant$/, '').replace(/-tool$/, '');
        if (fileMap[baseId]) {
            exchangeToSession[baseId] = m.sessionId;
        }
    }

    for (const [exchangeId, files] of Object.entries(fileMap)) {
        const sessionId = exchangeToSession[exchangeId];
        if (!sessionId) {
            skipped += files.filter(Boolean).length;
            continue;
        }

        for (const fileInfo of files) {
            if (!fileInfo) continue;

            const sessionDir = path.join(FILES_DIR, sessionId);
            ensureDir(sessionDir);

            const destPath = path.join(sessionDir, fileInfo.filename);

            if (fs.existsSync(destPath)) {
                skipped++;
                continue;
            }

            try {
                fs.copyFileSync(fileInfo.sourcePath, destPath);
                copied++;
            } catch (err) {
                console.warn('  File copy failed:', fileInfo.filename, err.message);
                skipped++;
            }
        }
    }

    stats.filesCopied = copied;
    stats.filesSkipped = skipped;
}

// ============================================
// Main Migration
// ============================================

async function migrate() {
    const opts = parseArgs();
    console.log('=== Chat Data Migration ===\n');
    console.log('Dry run:', opts.dryRun ? 'YES' : 'NO');
    if (opts.remotePath) console.log('Remote:', opts.remotePath);
    console.log('');

    ensureDir(DATA_DIR);
    ensureDir(FILES_DIR);

    // Source paths
    const localStoragePath = path.join(__dirname, 'data', 'storage.db');
    const localFilesDir = path.join(__dirname, 'data', 'files');
    let remoteStoragePath = null;
    let remoteFilesDir = null;

    if (opts.remotePath) {
        remoteStoragePath = path.join(opts.remotePath, 'storage.db');
        remoteFilesDir = path.join(opts.remotePath, 'files');
    }

    // Validate sources
    if (!fs.existsSync(localStoragePath)) {
        console.error('ERROR: Local storage.db not found:', localStoragePath);
        process.exit(1);
    }
    if (remoteStoragePath && !fs.existsSync(remoteStoragePath)) {
        console.error('ERROR: Remote storage.db not found:', remoteStoragePath);
        process.exit(1);
    }

    // Open databases
    const db = nDB.open(NDB_PATH);

    // ============================================
    // [1/6] Wipe existing data
    // ============================================

    if (!opts.dryRun) {
        console.log('[1/6] Wiping existing nDB data...');
        for (const doc of db.iter()) {
            db.delete(doc._id);
        }
        console.log('      Cleared.\n');
    }

    // ============================================
    // [2/6] Create migration user
    // ============================================

    let userId;
    if (!opts.dryRun) {
        db.insert(MIGRATION_USER);
        userId = MIGRATION_USER.id;
        console.log('[2/6] Created migration user:', userId);
        console.log('      API Key:', MIGRATION_USER.apiKey);
    } else {
        console.log('[2/6] Would create migration user');
    }

    // ============================================
    // [3/6] Read and process sources
    // ============================================

    const sources = [
        { label: 'local', storagePath: localStoragePath, filesDir: localFilesDir }
    ];
    if (remoteStoragePath) {
        sources.push({ label: 'remote', storagePath: remoteStoragePath, filesDir: remoteFilesDir });
    }

    // Track migrated IDs for dedup
    const migratedConvIds = new Set();
    const migratedArenaIds = new Set();

    const stats = {
        dryRun: opts.dryRun,
        sessions: 0,
        messages: 0,
        arenaSessions: 0,
        arenaMessages: 0,
        skippedDeleted: 0,
        skippedEmptyAssistant: 0,
        skippedDuplicateArena: 0,
        filesCopied: 0,
        filesSkipped: 0,
        filesLinked: 0,
        activeExchanges: 0
    };

    for (const source of sources) {
        console.log('[3/6] Processing', source.label, 'source...');
        const records = readNeDB(source.storagePath);

        const activeSet = new Set();
        if (records.history) {
            for (const h of records.history) {
                activeSet.add(h.id);
            }
        }
        console.log('      History entries:', activeSet.size);

        const historyIndex = records.history || [];
        const fileMap = scanFiles(source.filesDir);
        console.log('      File attachments found:', Object.keys(fileMap).length);

        // Migrate conversations (only active)
        let convMigrated = 0;
        let convSkipped = 0;
        for (const [chatId, exchanges] of Object.entries(records.conv)) {
            if (migratedConvIds.has(chatId)) {
                convSkipped++;
                continue;
            }
            if (!activeSet.has(chatId)) {
                convSkipped++;
                continue;
            }
            if (!exchanges || !Array.isArray(exchanges) || exchanges.length === 0) {
                convSkipped++;
                continue;
            }

            stats.historyIndex = historyIndex;
            migrateConversation(chatId, exchanges, db, userId, fileMap, stats);
            migratedConvIds.add(chatId);
            convMigrated++;
        }
        console.log('      Conversations migrated:', convMigrated, '| skipped:', convSkipped);
        stats.skippedDeleted = convSkipped;

        // Migrate arenas (all, skip arena:history: key)
        let arenaMigrated = 0;
        let arenaDupSkipped = 0;
        for (const [arenaId, arenaData] of Object.entries(records.arena)) {
            if (migratedArenaIds.has(arenaId)) {
                arenaDupSkipped++;
                stats.skippedDuplicateArena++;
                console.log('      Skip duplicate arena:', arenaId);
                continue;
            }
            if (!arenaData || !arenaData.messages || arenaData.messages.length === 0) {
                continue;
            }

            migrateArena(arenaId, arenaData, db, userId, stats);
            migratedArenaIds.add(arenaId);
            arenaMigrated++;
        }
        console.log('      Arenas migrated:', arenaMigrated,
            arenaDupSkipped > 0 ? '| duplicates skipped: ' + arenaDupSkipped : '');
        console.log('');
    }

    // ============================================
    // [4/6] Copy files
    // ============================================

    if (!opts.dryRun) {
        const allFileMap = {};
        for (const source of sources) {
            const fm = scanFiles(source.filesDir);
            Object.assign(allFileMap, fm);
        }
        if (Object.keys(allFileMap).length > 0) {
            console.log('[4/6] Copying files...');
            migrateFiles(allFileMap, db, stats);
            console.log('      Copied:', stats.filesCopied, '| Skipped:', stats.filesSkipped);
        } else {
            console.log('[4/6] No files to copy');
        }
    } else {
        console.log('[4/6] Would copy files');
    }

    // ============================================
    // [5/6] Enrich from history index
    // ============================================

    if (!opts.dryRun) {
        console.log('[5/6] Enriching sessions from history index...');
        let enriched = 0;
        for (const source of sources) {
            const records = readNeDB(source.storagePath);
            const history = records.history || [];
            for (const entry of history) {
                const sessions = db.find('id', entry.id);
                for (const s of sessions) {
                    if (s._type !== 'session') continue;
                    let updated = false;

                    if (entry.title && (!s.title || s.title === 'Untitled')) {
                        s.title = entry.title;
                        updated = true;
                    }
                    if (entry.model && s.model === 'unknown') {
                        s.model = entry.model;
                        updated = true;
                    }
                    if (entry.createdAt && !s.createdAt) {
                        s.createdAt = new Date(entry.createdAt).toISOString();
                        updated = true;
                    }
                    if (entry.updatedAt) {
                        s.updatedAt = new Date(entry.updatedAt).toISOString();
                        updated = true;
                    }

                    if (updated) {
                        db.update(s._id, s);
                        enriched++;
                    }
                }
            }
        }
        console.log('      Enriched:', enriched, 'sessions');
    }

    // ============================================
    // [5/5] Report
    // ============================================

    console.log('\n=== Migration Complete ===');
    console.log('Direct sessions:', stats.sessions);
    console.log('Arena sessions:', stats.arenaSessions);
    console.log('Total sessions:', stats.sessions + stats.arenaSessions);
    console.log('Direct messages:', stats.messages);
    console.log('Arena messages:', stats.arenaMessages);
    console.log('Total messages:', stats.messages + stats.arenaMessages);
    console.log('');
    console.log('Skipped (deleted convs):', stats.skippedDeleted);
    console.log('Skipped (empty assistants):', stats.skippedEmptyAssistant);
    console.log('Skipped (duplicate arenas):', stats.skippedDuplicateArena);
    if (stats.filesCopied !== undefined) {
        console.log('Files copied:', stats.filesCopied, '| skipped:', stats.filesSkipped);
    }
    console.log('');
    console.log('nDB documents:', db.len());

    if (!opts.dryRun) {
        console.log('\nNext step: Generate embeddings');
        console.log('  node server/embed.js');
        console.log('Then enable backend: set enableBackend: true in chat/js/config.js');
    } else {
        console.log('\nDry run complete. Run without --dry-run to execute.');
    }
}

// ============================================
// Run
// ============================================

migrate().catch(err => {
    console.error('Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
