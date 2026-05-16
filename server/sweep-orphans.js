const { Database: nDB } = require('../lib/ndb/napi');
const path = require('path');
const fs = require('fs');

const NDB_PATH = 'server/data/chat_app/data.jsonl';

async function runSweep() {
    console.log(`Loading nDB from ${NDB_PATH}...`);
    const db = nDB.open(NDB_PATH);
    
    const buckets = ['images']; // Add more if there are other buckets
    
    let totalFiles = 0;
    let trashedFiles = 0;

    for (const bucket of buckets) {
        console.log(`\nScanning bucket: ${bucket}...`);
        const files = db.listFiles(bucket);
        console.log(`Found ${files.length} total file(s) in bucket.`);
        
        for (const file of files) {
            totalFiles++;
            const fileRef = `${bucket}:${file}`;
            
            // db.releaseFile() natively iterates over all active DB documents.
            // If the string 'images:hash.ext' is NOT found in any document,
            // the Rust engine safely moves the file to the .trash folder.
            const wasTrashed = db.releaseFile(fileRef);
            
            if (wasTrashed) {
                console.log(`  âœ” Trashed orphaned file: ${file}`);
                trashedFiles++;
            }
        }
    }

    console.log(`\n======================================`);
    console.log(`Sweep Complete!`);
    console.log(`Total files scanned:    ${totalFiles}`);
    console.log(`Orphaned files trashed: ${trashedFiles}`);
    console.log(`======================================\n`);
}

runSweep().catch(e => {
    console.error('Sweep failed:', e);
});
