#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-ui-text — no em dashes in anything a player can read
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "forbid the use of em bars anywhere."
 *
 * A style rule that lives only in a person's head gets re-broken by the next
 * agent that writes a label. This makes it mechanical.
 *
 * WHAT IT CHECKS
 *   JSX text nodes            <span>Held in trust — 400</span>
 *   UI-ish string literals    label: 'Hands — played'
 *   CSS `content:` values     content: '—';
 *   The HTML shell            index.html's <title> and its meta tags
 *
 * WHY THE SHELL IS IN SCOPE (added 2026-08-31)
 *   This walked `src/` only, so index.html was never opened - and it carried
 *   three: the meta description, og:title and twitter:title, all reading
 *   "Club Arena — Private Online Poker Clubs". Those are not internal strings.
 *   They are what a search result and a shared link render, which makes them
 *   the most-read copy in the product and the only copy a player sees before
 *   they have an account.
 *
 * WHAT IT DELIBERATELY IGNORES
 *   Source comments (// and block), which never reach a player and which this
 *   codebase uses heavily for its decision records. Rewriting thousands of
 *   them would be a huge diff with zero user-visible effect, and would bury the
 *   real changes in any future review.
 *
 * Run:  node scripts/ci/check-ui-text.mjs [--fix]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const EXTS = new Set(['.ts', '.tsx', '.css']);
/**
 * Root HTML that ships to a browser. `public/*.html` (offline.html and the
 * calibration tools) is deliberately included; the dated audit REPORTS in the
 * repo root are not app UI and are left as the historical records they are.
 */
const HTML_FILES = ['index.html', 'public/offline.html'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
/**
 * The one file that is ALLOWED to contain these characters is the one whose job
 * is to remove them. On the first --fix run this script rewrote titleCase.ts's
 * own character class into `[--]` (a valid, meaningless range) and silently
 * disabled the stripper. titleCase.ts now writes them as \u escapes so there is
 * nothing here to match, and this exemption is the belt to that pair of braces.
 */
const SKIP_FILES = new Set(['src/utils/titleCase.ts', 'scripts/ci/check-ui-text.mjs']);
const EM_DASHES = /[—–―‒]/;

const fix = process.argv.includes('--fix');

/** Strip comments so the scan only sees code and copy. */
function stripComments(source, isCss, isHtml) {
  let out = source;
  if (isHtml) {
    // <!-- ... --> first, then the // and /* */ inside inline <script> blocks:
    // index.html's boot script carries decision notes like any other source.
    out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  }
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (!isCss) {
    // Line comments, but not the // inside a URL like https://
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (EXTS.has(extname(entry))) acc.push(full);
  }
  return acc;
}

const offenders = [];
let fixedCount = 0;

const scanTargets = [...walk(SRC), ...HTML_FILES.map((f) => join(ROOT, f))];

for (const file of scanTargets) {
  const rel = file.replace(ROOT, '');
  if (SKIP_FILES.has(rel)) continue;
  const original = readFileSync(file, 'utf8');
  if (!EM_DASHES.test(original)) continue;

  const isCss = extname(file) === '.css';
  const isHtml = extname(file) === '.html';
  const scannable = stripComments(original, isCss, isHtml);
  if (!EM_DASHES.test(scannable)) continue; // only in comments -> allowed

  if (fix) {
    // Rewrite only OUTSIDE comments: walk the stripped copy to find real
    // offsets, then patch those exact positions in the original.
    let patched = original.split('');
    for (let i = 0; i < scannable.length; i++) {
      if (EM_DASHES.test(scannable[i])) {
        patched[i] = '-';
        fixedCount++;
      }
    }
    writeFileSync(file, patched.join(''), 'utf8');
    continue;
  }

  scannable.split('\n').forEach((line, idx) => {
    if (EM_DASHES.test(line)) {
      offenders.push(`${file.replace(ROOT, '')}:${idx + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

if (fix) {
  console.log(`check-ui-text: replaced ${fixedCount} em dash(es) outside comments.`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error('\ncheck-ui-text FAILED: em dashes found in user-facing text.\n');
  console.error('Dan 2026-08-20: em dashes are forbidden in Club Arena UI copy.');
  console.error('Use a plain hyphen, or run: node scripts/ci/check-ui-text.mjs --fix\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-ui-text: OK - no em dashes in UI text.');
