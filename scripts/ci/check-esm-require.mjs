#!/usr/bin/env node
/**
 * CI GATE — CommonJS require() ban for the ESM server build
 *
 * 2026-08-15 incident: the A2 seating rework shipped four
 * `const { supabase } = require('../services/supabase.js')` lines.
 * The server ships as ESM, so each threw `ReferenceError: require is not
 * defined` AT RUNTIME — tsc cannot catch it because @types/node declares
 * `require`. Result: add-chips/withdraw hard-down and every cash hand's
 * settlement pipeline silently aborted for ~4 hours, invisible until the
 * E8 per-step guards surfaced it as CRITICAL financial alerts.
 *
 * This gate fails the build when `require(` appears in server/src runtime
 * code (tests and sim excluded — vitest runs them in an environment where
 * interop can differ, and they never ship in the Docker image).
 *
 * Escape hatch for a genuinely intentional use (there should be none):
 * append `// esm-require-allow: <reason>` on the same line.
 *
 * Exit codes: 0 clean · 1 violations found · 2 script error
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(process.cwd(), 'server/src');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'sim') continue;
      yield* walk(p);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    ) {
      yield p;
    }
  }
}

/** Strip block comments, line comments, and string/template literals so a
 *  mention of require() in prose or a message can never false-positive. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const skipped = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += skipped.replace(/[^\n]/g, ' ');
      i = end === -1 ? n : end + 2;
    } else if (two === '//') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end; // newline kept by fallthrough
      out += ' ';
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === quote) break;
        else j++;
      }
      out += quote + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + quote;
      i = j + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

let violations = 0;
try {
  for (const file of walk(ROOT)) {
    const raw = readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const codeLines = stripNonCode(raw).split('\n');
    codeLines.forEach((line, idx) => {
      if (/\brequire\s*\(/.test(line)) {
        if (/esm-require-allow:/.test(rawLines[idx] || '')) return;
        violations++;
        console.error(`ESM-REQUIRE VIOLATION: ${file}:${idx + 1}`);
        console.error(`  ${(rawLines[idx] || '').trim()}`);
      }
    });
  }
} catch (err) {
  console.error(`check-esm-require: script error: ${err.message}`);
  process.exit(2);
}

if (violations > 0) {
  console.error(
    `\n${violations} CommonJS require() call(s) in server/src runtime code.` +
      `\nThe server ships as ESM — require throws ReferenceError at runtime` +
      `\nand tsc cannot catch it. Use a static import (or a dynamic import()).`
  );
  process.exit(1);
}
console.log('check-esm-require: clean — no CommonJS require() in server/src runtime code.');
