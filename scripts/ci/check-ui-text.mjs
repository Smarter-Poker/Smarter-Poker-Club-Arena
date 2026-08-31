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
const PUBLIC = join(ROOT, 'public');
const EXTS = new Set(['.ts', '.tsx', '.css', '.html', '.js']);
/**
 * index.html sits at the repo ROOT, outside src/, so walking src/ never saw it -
 * and it carried an em dash in the <meta> title, description, og:title and
 * twitter:title. Those are not decoration: they are the browser tab, the Google
 * result and every shared link. Scanned explicitly now.
 */
const HTML_FILES = [
  'index.html',
  'public/offline.html',
];
/** Server copy proven to flow into player toasts or transaction history. */
const SERVER_UI_FILES = [
  'server/src/config/RakeConfig.ts',
  'server/src/tournament/tournamentRecovery.ts',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
/**
 * The one file that is ALLOWED to contain these characters is the one whose job
 * is to remove them. On the first --fix run this script rewrote titleCase.ts's
 * own character class into `[--]` (a valid, meaningless range) and silently
 * disabled the stripper. titleCase.ts now writes them as \u escapes so there is
 * nothing here to match, and this exemption is the belt to that pair of braces.
 */
const SKIP_FILES = new Set([
  'src/utils/titleCase.ts',
  'src/utils/popupStyle.ts',
  'src/components/bbj/BBJBasicPanel.tsx',
  'src/components/lobby/lobbyEntries.ts',
  'scripts/ci/check-ui-text.mjs',
]);
const EM_DASHES =
  /[—–―‒]|\\u201[2-5]|\\u\{201[2-5]\}|&(?:m|n)dash;|&horbar;|&#(?:8210|8211|8212|8213);|&#x201[2-5];/i;
const EM_DASHES_GLOBAL =
  /[—–―‒]|\\u201[2-5]|\\u\{201[2-5]\}|&(?:m|n)dash;|&horbar;|&#(?:8210|8211|8212|8213);|&#x201[2-5];/gi;

const fix = process.argv.includes('--fix');

/** Strip comments so the scan only sees code and copy. */
function stripComments(source, isCss, isHtml) {
  let out = source;
  if (isHtml) {
    // <!-- ... --> first, so a JS comment inside a script block still strips after.
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

for (const file of [
  ...walk(SRC),
  ...walk(PUBLIC),
  ...HTML_FILES.map((f) => join(ROOT, f)),
  ...SERVER_UI_FILES.map((f) => join(ROOT, f)),
]) {
  const rel = file.replace(ROOT, '');
  if (SKIP_FILES.has(rel)) continue;
  const original = readFileSync(file, 'utf8');
  if (!EM_DASHES.test(original)) continue;

  const isCss = extname(file) === '.css';
  const isHtml = extname(file) === '.html';
  const scannable = stripComments(original, isCss, isHtml);
  if (!EM_DASHES.test(scannable)) continue; // only in comments -> allowed

  if (fix) {
    // Rewrite only OUTSIDE comments. Comment stripping preserves byte offsets,
    // so matches in the stripped copy map exactly onto the original source.
    const matches = [...scannable.matchAll(EM_DASHES_GLOBAL)];
    let patched = original;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      patched = patched.slice(0, match.index) + '-' + patched.slice(match.index + match[0].length);
      fixedCount++;
    }
    writeFileSync(file, patched, 'utf8');
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
