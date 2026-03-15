#!/usr/bin/env node
/**
 * Update vendor libraries from WebAdmin to ChatStandalone
 * Run: node update-vendor.js
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'WebAdmin', 'public', 'shared');
const DEST = path.join(__dirname, 'shared');

function formatSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

function copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            copyRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function listFiles(dir, baseDir = dir) {
    const files = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(fullPath, baseDir));
        } else {
            const stat = fs.statSync(fullPath);
            files.push({
                path: fullPath.replace(baseDir, '').replace(/^\\/, ''),
                size: formatSize(stat.size)
            });
        }
    }
    
    return files;
}

// Main
console.log('\x1b[36mUpdating vendor libraries...\x1b[0m');
console.log('\x1b[90mSource: ' + SOURCE + '\x1b[0m');
console.log('\x1b[90mDest:   ' + DEST + '\x1b[0m');
console.log('');

if (!fs.existsSync(SOURCE)) {
    console.error('\x1b[31mError: Source not found: ' + SOURCE + '\x1b[0m');
    console.error('Make sure to run this from the ChatStandalone directory');
    process.exit(1);
}

// Remove old directory
if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
    console.log('\x1b[33mRemoved old vendor directory\x1b[0m');
}

// Copy files
copyRecursive(SOURCE, DEST);
console.log('\x1b[32mCopied vendor files\x1b[0m');

// List files
console.log('');
console.log('\x1b[36mUpdated files:\x1b[0m');
const files = listFiles(DEST);
files.forEach(f => {
    console.log('  \x1b[90m' + f.path + '\x1b[0m \x1b[2m(' + f.size + ')\x1b[0m');
});

console.log('');
console.log('\x1b[32mDone! Vendor libraries updated.\x1b[0m');
