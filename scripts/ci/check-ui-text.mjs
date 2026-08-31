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
 * The files ALLOWED to contain these characters are the ones whose job is to
 * REMOVE them. On the first --fix run this script rewrote titleCase.ts's own
 * character class into `[--]` (a valid, meaningless range) and silently
 * disabled the stripper.
 *
 * CORRECTED 2026-08-31. This note used to say titleCase.ts stored the
 * characters as escapes and that the exemption was therefore only a belt to
 * that pair of braces. That was false, and had been for some time:
 * titleCase.ts lines 87-88 hold them as LITERAL characters
 * in `EM_DASH_RUN` and `OTHER_DASHES`. The exemption is therefore still
 * load-bearing, not belt-and-braces - remove it and the next --fix run breaks
 * the stripper exactly as it did the first time. The same is true of
 * popupStyle.ts, lobbyEntries.ts and BBJBasicPanel.tsx, each of which holds a
 * dash class inside a normalising regex.
 *
 * Every one of these was re-read on 2026-08-31: none contains a dash in any
 * position a player can see. If that ever changes, the file has stopped being
 * a stripper and must come off this list.
 */
const SKIP_FILES = new Set([
  'src/utils/titleCase.ts',
  'src/utils/popupStyle.ts',
  'src/components/bbj/BBJBasicPanel.tsx',
  'src/components/lobby/lobbyEntries.ts',
  'scripts/ci/check-ui-text.mjs',
]);
/**
 * THE CSS ESCAPE FORM WAS THE ONE THAT GOT THROUGH.
 *
 * This gate's header says it reads CSS `content:` values, and it did - but it
 * only ever looked for the CHARACTER and for JavaScript's `\\u2014`. CSS does
 * not write it either way. CSS writes `content: '\\2014'`, backslash then bare
 * hex, and that is exactly what sat in HandDetailView.css rendering an em dash
 * on every run-2+ showdown row in production while this gate reported OK.
 *
 * Found 2026-08-31 by scanning the DEPLOYED BUNDLE rather than the source: one
 * reachable stylesheet carried `content:"—"` after the build resolved it.
 *
 * The CSS escape is 1-6 hex digits, so `\\2014`, `\\02014` and `\\002014` are all
 * the same character. The trailing guard stops `\\20145` - a different
 * codepoint entirely - from matching.
 */
const CSS_ESCAPE = String.raw`\\0{0,3}201[2-5](?![0-9a-fA-F])`;
const PATTERN =
  String.raw`[—–―‒]|\\u201[2-5]|\\u\{201[2-5]\}|` +
  CSS_ESCAPE +
  String.raw`|&(?:m|n)dash;|&horbar;|&#(?:8210|8211|8212|8213);|&#x201[2-5];`;
const EM_DASHES = new RegExp(PATTERN, 'i');
const EM_DASHES_GLOBAL = new RegExp(PATTERN, 'gi');

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
