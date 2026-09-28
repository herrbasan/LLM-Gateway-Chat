// Load probe for the nDB native binding.
//
// Requires the napi wrapper directory the server actually uses
// (`require('../lib/ndb/napi')` in server/server.js), opens a throwaway
// database, round-trips one document, and exits non-zero on any failure.
//
// Run by sync-ndb.ps1 after every install -- it is the one check a SHA-256
// verification cannot give: that the wrapper and the native binary it resolves
// actually load and work together (the case that breaks on a version rollback,
// where the .node is swapped but the wrapper stays at the submodule's version).
//
// Usage: node lib/ndb-load-probe.js [path/to/napi]

const fs = require('fs');
const os = require('os');
const path = require('path');

const napiDir = path.resolve(process.argv[2] || path.join(__dirname, 'ndb', 'napi'));
if (!fs.existsSync(napiDir)) {
    console.error(`ndb-load-probe: no such directory: ${napiDir}`);
    process.exit(1);
}

const { Database } = require(napiDir);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndb-load-probe-'));
try {
    const db = Database.open(path.join(dir, 'data.jsonl'));
    const id = db.insert({ _type: 'load-probe', ok: true });
    const doc = db.get(id);
    db.close();
    if (!doc || doc.ok !== true) {
        console.error('ndb-load-probe: round-trip failed');
        process.exit(1);
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

const { version } = JSON.parse(fs.readFileSync(path.join(napiDir, 'package.json'), 'utf8'));
if (process.argv[3] !== '--quiet') {
    console.log(`ndb-load-probe: napi ${version} wrapper + native binary loaded, round-trip OK`);
}
