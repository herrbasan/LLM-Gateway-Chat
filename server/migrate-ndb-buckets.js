const fs = require('fs');
const path = require('path');
const { Database: nDB } = require('../lib/ndb/napi');

const dbPath = path.join(__dirname, 'data/chat_app/data.jsonl');
const filesDir = path.join(__dirname, 'data/files');

const db = nDB.open(dbPath);

async function migrate() {
  console.log('Starting Phase 3 Migration: data/files -> nDB _files bucket');
  
  if (!fs.existsSync(filesDir)) {
    console.log('No files directory found. Migration complete.');
    return;
  }

  const exchanges = await fs.promises.readdir(filesDir);
  let totalExchanges = 0;
  let totalFiles = 0;

  for (const exchangeId of exchanges) {
    const exPath = path.join(filesDir, exchangeId);
    const stat = await fs.promises.stat(exPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.promises.readdir(exPath);
    for (const file of files) {
      const filePath = path.join(exPath, file);
      const buffer = await fs.promises.readFile(filePath);
      
      let mime = 'application/octet-stream';
      if (file.endsWith('.png')) mime = 'image/png';
      else if (file.endsWith('.jpg') || file.endsWith('.jpeg')) mime = 'image/jpeg';
      else if (file.endsWith('.gif')) mime = 'image/gif';
      else if (file.endsWith('.webp')) mime = 'image/webp';
      else if (file.endsWith('.svg')) mime = 'image/svg+xml';
      
      try {
        const meta = db.storeFile('images', file, buffer, mime);
        const newRef = `images:${meta._file.id}.${meta._file.ext}`;
        console.log(`Migrated file: ${exchangeId}/${file} -> ${newRef}`);
        totalFiles++;
      } catch (err) {
        console.error(`Failed to migrate ${exchangeId}/${file}`, err.message);
      }
    }
    totalExchanges++;
  }

  console.log(`Migrated ${totalFiles} files across ${totalExchanges} exchanges.`);
  
  // Now update conversation documents
  // Find all conversations
  const allConvs = db.find('_type', 'conversation');
  let updatedConvs = 0;

  for (const conv of allConvs) {
    if (!conv.messages) continue;
    let modified = false;

    // Deep update attachments
    for (const msg of conv.messages) {
      if (!msg.attachments || msg.attachments.length === 0) continue;
      
      for (const att of msg.attachments) {
        // Look for legacy blobUrl, url, or dataUrl containing chat directories / files endpoint
        const oldUrl = att.blobUrl || att.url || att.dataUrl;
        if (oldUrl && (oldUrl.includes('/api/chat-files/') || oldUrl.includes('/files/'))) {
          // It's a legacy URL! The file name is usually at the end.
          const parts = oldUrl.split('/');
          const filename = parts[parts.length - 1];
          const exchangeId = parts[parts.length - 2];
          
          // Re-derive hash if the file was just inserted.
          // Problem: If the hash changed or we didn't save the mapping, how to know the new hash?
          // Since filename inside the exchange directory matches what fs readdir found,
          // but hash is based on content. We can recalculate hash if needed, but it's simpler
          // to calculate hash of the file if it exists on disk.
          
          const diskPath = path.join(filesDir, exchangeId, filename);
          if (fs.existsSync(diskPath)) {
            const buffer = await fs.promises.readFile(diskPath);
            let mime = 'application/octet-stream';
            if (filename.endsWith('.png')) mime = 'image/png';
            else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) mime = 'image/jpeg';
            else if (filename.endsWith('.gif')) mime = 'image/gif';
            else if (filename.endsWith('.webp')) mime = 'image/webp';
            else if (filename.endsWith('.svg')) mime = 'image/svg+xml';
            
            // This is idempotent. Doing it again returns same hash.
            const meta = db.storeFile('images', filename, buffer, mime);
            const bucketUrl = `/api/buckets/images/${meta._file.id}.${meta._file.ext}`;
            const nUri = `images:${meta._file.id}.${meta._file.ext}`;
            
            att.url = bucketUrl;
            att._file = nUri;
            if (att.blobUrl) delete att.blobUrl;
            
            modified = true;
            console.log(`Updated legacy attachment link in conversation ${conv.id}`);
          }
        }
      }
    }
    
    if (modified) {
      db.update(conv._id, conv);
      updatedConvs++;
    }
  }
  
  console.log(`Updated ${updatedConvs} conversation records.`);
  
  // Cleanup
  console.log('Data migration complete. You can now safely delete server/data/files/');
}

migrate().catch(e => {
  console.error(e);
  process.exit(1);
});