/**
 * fix-mount-timers.cjs
 *
 * Batch-fixes the systemic untracked `setTimeout(() => setMounted(true), 50)` pattern
 * across all Club Arena components.
 *
 * Pattern being fixed:
 *   setTimeout(() => setMounted(true), 50)   ← bare untracked timer inside useEffect
 *
 * Replacement pattern (inline, no file restructure):
 *   const _t = setTimeout(() => setMounted(true), 50); return () => clearTimeout(_t);
 *
 * This script:
 * 1. Scans all .tsx/.ts files under src/
 * 2. For each bare untracked setTimeout setMounted/setModalVisible call inside a
 *    useEffect that does NOT already have clearTimeout/return, wraps it cleanly.
 * 3. Writes the file back only if changed.
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// Regex: matches the bare setTimeout pattern in a useEffect body
// We look for: setTimeout(() => setState...(true), 50)  without clearTimeout nearby
// The approach: find each useEffect block and check if it has an untracked timer.

// Simple line-by-line transformation:
// Pattern A: standalone line: `    setTimeout(() => setMounted(true), 50);`
// → replace with two lines: `    const _mountTimer = setTimeout(() => setMounted(true), 50); return () => clearTimeout(_mountTimer);`

// But we need to be careful — some files already have `return () => clearTimeout(timer)` after a `const timer = setTimeout(...)`.
// We only fix the BARE form (no `const` assignment, no surrounding return).

const BARE_PATTERN = /^(\s+)setTimeout\(\(\) => (setMounted|setModalVisible)\(true\), (\d+)\);?\s*$/;

let totalFixed = 0;
const files = walk(SRC_DIR);

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  let changed = false;

  // We'll look for useEffect blocks containing the bare pattern
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = BARE_PATTERN.exec(line);
    if (m) {
      const indent = m[1];
      const setter = m[2];
      const delay = m[3];
      
      // Check surrounding context: does the line immediately before or after have clearTimeout?
      const prevLine = lines[i - 1] || '';
      const nextLine = lines[i + 1] || '';
      
      // Already handled if next line is `return () => clearTimeout`
      if (/clearTimeout/.test(prevLine) || /clearTimeout/.test(nextLine) ||
          /const.*Timer/.test(prevLine) || /const timer/.test(prevLine)) {
        out.push(line);
        i++;
        continue;
      }
      
      // Replace the bare timer with a tracked version
      out.push(`${indent}// BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState`);
      out.push(`${indent}const _mountTimer = setTimeout(() => ${setter}(true), ${delay});`);
      out.push(`${indent}return () => clearTimeout(_mountTimer);`);
      changed = true;
      totalFixed++;
    } else {
      out.push(line);
    }
    i++;
  }

  if (changed) {
    fs.writeFileSync(file, out.join('\n'), 'utf8');
    console.log(`✅ Fixed: ${path.relative(SRC_DIR, file)}`);
  }
}

console.log(`\n🎯 Total files with bare mount timers fixed: ${totalFixed}`);
