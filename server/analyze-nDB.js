const fs = require('fs');
const stat = fs.statSync('server/data/chat_app');
const fd = fs.openSync('server/data/chat_app', 'r');
const CHUNK_MB = 50;

// Read from 25%, 50%, 75% positions
const positions = [0.25, 0.50, 0.75];
for (const pct of positions) {
    const offset = Math.floor(stat.size * pct);
    const chunk = Buffer.alloc(CHUNK_MB * 1024 * 1024);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
    const text = chunk.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());
    
    const types = {};
    let maxLen = 0, maxType = '';
    for (const line of lines) {
        const hasDeleted = line.includes('"_deleted"');
        const typeMatch = line.match(/"(_type)":"(\w+)"/);
        const type = hasDeleted ? '_deleted' : (typeMatch ? typeMatch[2] : 'unknown');
        types[type] = (types[type] || 0) + 1;
        if (line.length > maxLen) { maxLen = line.length; maxType = type + ' ' + (typeMatch ? typeMatch[2] : ''); }
        // Stop after first 1000 lines per chunk
        if (Object.values(types).reduce((a,b)=>a+b) > 1000) break;
    }
    console.log(`At ${(pct*100).toFixed(0)}%: ${lines.length} lines, max line ${(maxLen/1024).toFixed(0)}KB [${maxType}]`);
    console.log('  Types:', JSON.stringify(types));
}
fs.closeSync(fd);
