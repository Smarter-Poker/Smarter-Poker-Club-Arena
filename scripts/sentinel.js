/**
 * SENTINEL - Real-time Build Monitor
 * 
 * Watches the /src directory and runs type checks + linting on file changes.
 * Usage: node scripts/sentinel.js
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

let isChecking = false;
let needsCheck = false;
let lastRun = Date.now();

console.clear();
console.log('\x1b[36m%s\x1b[0m', '🛡️  SENTINEL ACTIVATED');
console.log('\x1b[90m%s\x1b[0m', 'Watching /src for changes...');

function runCheck() {
    if (isChecking) {
        needsCheck = true;
        return;
    }

    isChecking = true;
    console.clear();
    console.log('\x1b[36m%s\x1b[0m', '🛡️  SENTINEL SCANNING...');
    console.log('\x1b[90m%s\x1b[0m', `Time: ${new Date().toLocaleTimeString()}`);

    // Run Type Check
    const tsc = spawn('npm', ['run', 'typecheck'], { cwd: ROOT_DIR, stdio: 'inherit' });

    tsc.on('close', (code) => {
        if (code === 0) {
            console.log('\n\x1b[32m%s\x1b[0m', '✅ TYPE CHECK PASSED');

            // If Types pass, strictly check linting
            console.log('\x1b[90m%s\x1b[0m', 'Running code style check...');
            const lint = spawn('npm', ['run', 'lint'], { cwd: ROOT_DIR, stdio: 'inherit' });

            lint.on('close', (lintCode) => {
                if (lintCode === 0) {
                    console.log('\n\x1b[32m%s\x1b[0m', '✅ ALL SYSTEMS GREEN');
                    console.log('\x1b[90m%s\x1b[0m', 'Waiting for changes...');
                } else {
                    console.log('\n\x1b[33m%s\x1b[0m', '⚠️  LINT NOTICES FOUND');
                    console.log('Tip: Run "npm run lint:fix" to auto-correct style issues.');
                }
                finishRun();
            });

        } else {
            console.log('\n\x1b[31m%s\x1b[0m', '❌ CRITICAL BUILD ERRORS DETECTED');
            console.log('\x1b[31m%s\x1b[0m', 'Fix these errors before committing.');
            finishRun();
        }
    });

}

function finishRun() {
    isChecking = false;
    if (needsCheck) {
        needsCheck = false;
        setTimeout(runCheck, 100);
    }
}

// Simple debounce
let debounceTimer;

fs.watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    // Ignore non-code files to reduce noise
    if (!filename.match(/\.(ts|tsx|css|js|jsx)$/)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        runCheck();
    }, 1000); // 1s debounce to catch "save all" bursts
}); 
