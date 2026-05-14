# Code Review for `server/server.js`

## 1. The Startup Blocking Issue

**The Issue:**  
On startup, `server.js` calls `const db = nDB.open(NDB_PATH);` synchronously on line 47, which is outside the asynchronous IIFE where the logger is initialized. If the `nDB` database is large, it loads everything into memory synchronously, freezing the thread before `nLogger.init(...)` can ever execute.

**The Fix:**  
Move the database initializations inside the `async IIFE` after the logger is initialized, so the server can report that it is starting and opening databases.

```javascript
// Remove global db instantiation
let db, vdb, embeddingsCol;

(async () => {
  logger = await nLogger.init({ logsDir: path.resolve(LOGS_DIR), sessionPrefix: 'chat' });
  logger.info('Chat Backend starting, loading databases...', { port: PORT }, 'Server');

  // Load databases AFTER logger is ready
  db = nDB.open(NDB_PATH);
  vdb = new nVDB(NVDB_DIR);
  // ...
```

---

## 2. Critical Concurrency / Race Condition

**The Issue:**  
In `embedMessageAsync()`, the `conv` object is fetched, modified, and saved back to the database *after* an `await embedQuery()` call. 
If the user sends another message while the first one is being asynchronously embedded, the new message will be pushed into the database. But when `embedMessageAsync` finishes, it writes your stale `conv` object back into the DB, **overwriting and losing** the new message.

**The Fix:**  
Fetch `conv` immediately before you need to update it, never across `await` yields.

```javascript
// Bad:
// const conv = db.get(convNdbId);
// await embedQuery(...);
// db.update(convNdbId, conv);

// Good:
await embedQuery(...);
// Fetch fresh state from DB right before updating
const freshConv = db.get(convNdbId);
if (freshConv && freshConv.messages[msgIdx]) {
    freshConv.messages[msgIdx].embedStatus = 'embedded';
    db.update(convNdbId, freshConv);
}
```

---

## 3. High CPU Usage / Performance Bottleneck (The `setInterval` Loop)

**The Issue:**  
The maintenance block (`setInterval` on line 866) runs every 5 seconds. Inside this loop, it calls `db.find('_type', 'conversation')` and iterates through **every single conversation and every single message** just to check if `!embeddingsCol.get(m.id)`. As your database grows, this will cause a severe CPU spike every 5 seconds.

**The Fix:**  
- Do not perform full table scans every 5 seconds. 
- You can maintain an in-memory queue (`Set` or `Array`) of pending message IDs when they are created, and have the interval drain that queue. 
- Alternatively, search only active/recent conversations by tracking an `updatedAt` threshold.

---

## 4. Synchronous I/O in the Web Server

**The Issue:**  
The fallback static file handler and the `/files/` endpoint use `fs.existsSync(fullPath)` and `fs.statSync(fullPath)` before calling `fs.readFile(...)`. Synchronous disk I/O in a routing path blocks the node event loop. 

**The Fix:**  
Use `fs.promises.stat` or simply attempt to read the file and catch the `ENOENT` (Error NO ENTry) cleanly.

```javascript
fs.readFile(fullPath, (err, data) => {
    if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal Server Error');
        return;
    }
    // send response...
});
```

---

## 5. Duplicate Code Blocks

**The Issue:**  
Lines 832-841 and Lines 855-864 contain the exact same block of code to flush the database after startup:
```javascript
  // One-time flush + compact after startup
  setTimeout(() => {
    if (!embeddingsCol) return;
    try {
      embeddingsCol.flush(); ...
```

**The Fix:**  
Remove one of the duplicate `setTimeout` blocks.

---

## 6. Duplicate/Large Memory Footprints on Search

**The Issue:**  
On every `POST /api/search` request, all of the user's conversations are mapped into flat memory (`msgIndex`). If a user has thousands of messages, creating this flat array on every request is extremely taxing on the garbage collector.

**The Fix:**  
Store or cache the index mapping out-of-band instead of generating it on the fly, or just rely on the `nVDB` results and perform secondary lookups directly with `db.find('id', ...)` for only the top K matched documents instead of assembling the whole payload upstream.