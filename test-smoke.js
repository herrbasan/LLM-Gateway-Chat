// Smoke test for nDB and nVDB on Windows
// Run: node test-smoke.js

const fs = require('fs');
const path = require('path');

console.log('=== nDB / nVDB Smoke Test ===\n');

const TEST_DIR = './.test-data-smoke';
if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
}
fs.mkdirSync(TEST_DIR, { recursive: true });

// ============================================
// Test 1: nDB loads
// ============================================
console.log('[1/6] Loading nDB module...');
try {
    const ndb = require('./lib/ndb/napi');
    console.log('  nDB exports:', Object.keys(ndb));
    console.log('  nDB loaded:', typeof ndb.Database);
} catch (e) {
    console.error('  FAILED:', e.message);
    process.exit(1);
}

// ============================================
// Test 2: nDB basic operations
// ============================================
console.log('\n[2/6] Testing nDB basic operations...');
try {
    const { Database } = require('./lib/ndb/napi');
    const db = Database.open(path.join(TEST_DIR, 'ndb_test'));
    
    const id = db.insert({ name: 'Alice', age: 30, _type: 'user' });
    console.log('  Inserted:', id);
    
    const doc = db.get(id);
    console.log('  Get by ID:', doc.name, 'age', doc.age);
    
    const found = db.find('name', 'Alice');
    console.log('  Find count:', found.length);
    
    db.createIndex('name');
    const indexed = db.find('name', 'Alice');
    console.log('  Indexed find count:', indexed.length);
    
    console.log('  nDB: OK');
} catch (e) {
    console.error('  FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
}

// ============================================
// Test 3: nVDB loads
// ============================================
console.log('\n[3/6] Loading nVDB module...');
try {
    const nvdb = require('./lib/nvdb/napi');
    console.log('  nVDB exports:', Object.keys(nvdb));
    console.log('  nVDB loaded:', typeof nvdb.Database);
} catch (e) {
    console.error('  FAILED:', e.message);
    process.exit(1);
}

// ============================================
// Test 4: nVDB basic operations
// ============================================
console.log('\n[4/6] Testing nVDB basic operations...');
try {
    const { Database } = require('./lib/nvdb/napi');
    const db = new Database(path.join(TEST_DIR, 'nvdb_test'));
    const col = db.createCollection('embeddings', 4096, { durability: 'sync' });
    
    const vec = new Array(4096).fill(0.001);
    col.insert('doc1', vec, JSON.stringify({ text: 'Hello world' }));
    console.log('  Inserted vector: doc1 (4096 dims)');
    
    // Exact search (works on memtable)
    const results = col.search({
        vector: vec,
        topK: 5,
        distance: 'cosine',
        approximate: false
    });
    console.log('  Search results:', results.length, 'matches');
    console.log('  Top match:', results[0]?.id, 'score:', results[0]?.score?.toFixed(4));
    
    console.log('  nVDB: OK');
} catch (e) {
    console.error('  FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
}

// ============================================
// Test 5: nDB query with AST
// ============================================
console.log('\n[5/6] Testing nDB AST query...');
try {
    const { Database } = require('./lib/ndb/napi');
    const db = Database.open(path.join(TEST_DIR, 'ndb_test'));
    
    db.insert({ name: 'Bob', age: 25, _type: 'user' });
    db.insert({ name: 'Charlie', age: 35, _type: 'user' });
    db.insert({ title: 'Hello', _type: 'post' });
    
    // Simple field query via AST
    const ast = { field: 'age', op: 'gt', value: 25 };
    const results = db.query(ast);
    console.log('  Query age > 25:', results.length, 'results');
    
    console.log('  nDB Query: OK');
} catch (e) {
    console.error('  FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
}

// ============================================
// Test 6: Cleanup
// ============================================
console.log('\n[6/6] Cleanup...');
try {
    fs.rmSync(TEST_DIR, { recursive: true });
    console.log('  Cleaned up test data');
} catch (e) {
    console.log('  Cleanup skipped:', e.message);
}

console.log('\n=== ALL TESTS PASSED ===');
console.log('nDB and nVDB are ready for migration.');
