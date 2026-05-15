// ============================================
// migrate-ndb-to-folder — FUTURE (not yet needed)
// Migrate flat .jsonl file → "database-as-a-folder" nDB format
// ============================================
// This is for the DATABASE EVOLUTION PLAN (docs/database_evolution_plan.md).
// It converts a standalone data.jsonl into the new folder structure:
//   {name}/
//   ├── meta.json      # Database schema, buckets, versioning
//   ├── data.jsonl     # The append-only document store
//   ├── _trash/        # Soft-deleted documents and files
//   └── _files/        # Managed binary buckets
//
// NOTE: This is UNRELATED to the NeDB import pipeline.
//       For importing legacy data, use migrate-import-nedb.js.
//
// Usage: node server/migrate-ndb-to-folder.js <path-to-old-flat.jsonl>
//
// Status: NOT YET EXECUTED. Waiting for nDB Rust core to support folder format natively.
// ============================================

const fs = require('fs');
const path = require('path');

function runMigration(oldDbFile) {
    if (!fs.existsSync(oldDbFile)) {
        console.error(`Error: File not found -> ${oldDbFile}`);
        process.exit(1);
    }

    const stat = fs.statSync(oldDbFile);
    if (stat.isDirectory()) {
        console.error(`Error: Path is already a directory (may already be migrated). -> ${oldDbFile}`);
        process.exit(1);
    }

    console.log(`Starting v3 Migration for: ${oldDbFile}`);

    // Parse paths
    const dbDir = path.dirname(oldDbFile);
    // Remove .jsonl if it exists
    const dbName = path.basename(oldDbFile, '.jsonl');
    let newDbPath = path.join(dbDir, dbName);

    // Conflict resolution: if the target directory name matches the existing file
    if (path.resolve(oldDbFile) === path.resolve(newDbPath)) {
        const backupOldPath = oldDbFile + '.legacy.bak';
        fs.renameSync(oldDbFile, backupOldPath);
        console.log(`[+] Found naming conflict. Renamed original file to: ${backupOldPath}`);
        oldDbFile = backupOldPath;
    }

    // 1. Create the new folder structure
    if (!fs.existsSync(newDbPath)) {
        fs.mkdirSync(newDbPath, { recursive: true });
        console.log(`[+] Created new DB container: ${newDbPath}`);
    }

    fs.mkdirSync(path.join(newDbPath, '_trash'), { recursive: true });
    fs.mkdirSync(path.join(newDbPath, '_files'), { recursive: true });

    // 2. Generate a default meta.json
    const defaultMeta = {
        engine: "ndb",
        version: 3,
        migratedAt: new Date().toISOString(),
        buckets: {},
        schemas: {}
    };
    fs.writeFileSync(
        path.join(newDbPath, 'meta.json'),
        JSON.stringify(defaultMeta, null, 2)
    );
    console.log(`[+] Created default meta.json`);

    // 3. Move the data.jsonl
    const newDataPath = path.join(newDbPath, 'data.jsonl');
    fs.copyFileSync(oldDbFile, newDataPath);
    console.log(`[+] Copied document data -> data.jsonl`);

    console.log(`\nMigration completed successfully.`);
    console.log(`[!] Original data preserved at '${oldDbFile}'.`);
    console.log(`[!] Please review and delete '${oldDbFile}' when safely transitioned.\n`);
}

const target = process.argv[2];
if (!target) {
    console.log("Usage: node migrate-v3.js <path-to-old.jsonl>");
    process.exit(0);
}

runMigration(target);