#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const Datastore = require('@seald-io/nedb');

const PORT = process.argv[2] || 8080;
const ROOT = path.join(__dirname, '..');

// ============================================
// NeDB Storage Setup
// ============================================

const STORAGE_DIR = path.join(ROOT, 'server', 'data');
const FILES_DIR = path.join(STORAGE_DIR, 'files');
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

const storageDb = new Datastore({ filename: path.join(STORAGE_DIR, 'storage.db'), autoload: true });

// ============================================
// Express App
// ============================================

const app = express();
app.use(express.json({ limit: '50mb' }));

// Serve project root as static
app.use(express.static(ROOT));

// Root redirects to /chat/
app.get('/', (req, res) => {
  res.redirect('/chat/');
});

// ============================================
// Storage API
// ============================================

app.get('/api/storage/:key', (req, res) => {
  storageDb.findOne({ key: req.params.key }, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(doc ? doc.value : null);
  });
});

app.put('/api/storage/:key', (req, res) => {
  const { value } = req.body;
  storageDb.update({ key: req.params.key }, { key: req.params.key, value }, { upsert: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.delete('/api/storage/:key', (req, res) => {
  storageDb.remove({ key: req.params.key }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/storage', (req, res) => {
  storageDb.find({}, (err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    const obj = {};
    docs.forEach(d => obj[d.key] = d.value);
    res.json(obj);
  });
});

// Server type endpoint for client detection
app.get('/api/server-type', (req, res) => {
  res.json({ type: 'node-minimal' });
});

// ============================================
// File API (file-based, supports any binary type)
// ============================================

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

const EXT_MIME = {};
for (const [mime, ext] of Object.entries(MIME_EXT)) {
  EXT_MIME[ext] = mime;
}

// Get list of files for an exchange - returns [{ url, name, type }]
app.get('/api/chat-files/:exchangeId', (req, res) => {
  fs.readdir(FILES_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const prefix = req.params.exchangeId + '_';
    const fileList = [];
    files.forEach(file => {
      if (file.startsWith(prefix)) {
        const ext = path.extname(file).toLowerCase();
        const type = EXT_MIME[ext] || 'application/octet-stream';
        fileList.push({
          url: `/api/file/${file}`,
          name: file,
          type: type
        });
      }
    });
    res.json(fileList);
  });
});

// Save files for an exchange
app.put('/api/chat-files/:exchangeId', (req, res) => {
  const { files } = req.body;
  // Delete existing files for this exchange
  fs.readdir(FILES_DIR, (err, existingFiles) => {
    if (err) return res.status(500).json({ error: err.message });
    const prefix = req.params.exchangeId + '_';
    existingFiles.forEach(file => {
      if (file.startsWith(prefix)) {
        fs.unlinkSync(path.join(FILES_DIR, file));
      }
    });
    // Write new files
    files.forEach((f, i) => {
      const ext = MIME_EXT[f.type] || '.bin';
      const filename = req.params.exchangeId + '_' + i + ext;
      const filePath = path.join(FILES_DIR, filename);
      const buf = Buffer.from(f.data, 'base64');
      fs.writeFileSync(filePath, buf);
    });
    res.json({ ok: true });
  });
});

// Delete all files for an exchange
app.delete('/api/chat-files/:exchangeId', (req, res) => {
  fs.readdir(FILES_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const prefix = req.params.exchangeId + '_';
    files.forEach(file => {
      if (file.startsWith(prefix)) {
        fs.unlinkSync(path.join(FILES_DIR, file));
      }
    });
    res.json({ ok: true });
  });
});

// Serve file directly
app.get('/api/file/:filename', (req, res) => {
  const filename = req.params.filename;
  // Prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(403).send('Forbidden');
  }
  const filePath = path.join(FILES_DIR, filename);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = EXT_MIME[ext] || 'application/octet-stream';
  res.set('Content-Type', mimeType);
  res.sendFile(filePath);
});

// Get storage stats
app.get('/api/files', (req, res) => {
  fs.readdir(FILES_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    let totalBytes = 0;
    files.forEach(file => {
      const filePath = path.join(FILES_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        totalBytes += stat.size;
      } catch {}
    });
    res.json({ entries: files.length, bytes: totalBytes, mb: (totalBytes / 1024 / 1024).toFixed(2) });
  });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
  console.log(`ChatStandalone running at http://localhost:${PORT}`);
  console.log(`Open: http://localhost:${PORT}/chat/`);
  console.log(`Storage: ${STORAGE_DIR}`);
  console.log(`Image files: ${FILES_DIR}`);
  console.log('Press Ctrl+C to stop');
});
