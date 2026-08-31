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
import { join, extname, resolve } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
/**
 * UI_TEXT_SOURCE_DIR points the scan at a throwaway tree, the same override
 * check-title-case has carried since it was written. It exists so the --fix
 * safety property can be proven by RUNNING the gate over a stripper-shaped file
 * rather than by grepping this source for a filename: a regex over source
 * passes on a line that is present and wrong.
 */
const SOURCE_OVERRIDE = process.env.UI_TEXT_SOURCE_DIR
  ? resolve(process.env.UI_TEXT_SOURCE_DIR)
  : null;
const SRC = SOURCE_OVERRIDE ?? join(ROOT, 'src');
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
/**
 * THE WHOLE ENGINE, NOT TWO FILES OF IT (2026-08-31).
 *
 * This started as a two-file list - RakeConfig and tournamentRecovery - because
 * those were the server files someone had traced to a player's screen. Scanning
 * all of server/src found 38 em dashes in string literals, and nine of them are
 * copy a player reads that the two-file list did not cover: every fixed-limit
 * and pot-limit betting refusal in PokerEngine, "Rate limited" in the action
 * handler, "Action already being processed", "Add-on exceeded table max buy-in
 * - refunded", "Bet was placed - auto-check cleared", and "Bad Beat Jackpot -
 * you got paid!".
 *
 * A list of the files somebody happened to check is a cleanup. The directory is
 * the gate. Comments are still ignored, so the engine's decision records are
 * untouched.
 */
const SERVER_SRC = join(ROOT, 'server/src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
/**
 * A WHOLE-FILE EXEMPTION IS A SWEEP WHERE A GUARD BELONGS (2026-08-31, later).
 *
 * Four files were skipped ENTIRELY: titleCase.ts, popupStyle.ts,
 * BBJBasicPanel.tsx and lobbyEntries.ts. The reason was real: they are the code
 * that REMOVES the character, so each holds a dash class inside a normalising
 * regex, and on the first --fix run this script rewrote titleCase.ts's own
 * class into `[--]` and silently disabled the stripper. An audit earlier today
 * re-read all four and confirmed none of them shows a dash where a player can
 * see it.
 *
 * That audit is the problem. It was true on the day it was written and has to
 * be re-done by hand every time anyone edits those files, because two of the
 * four - BBJBasicPanel.tsx and lobbyEntries.ts - render copy a player reads.
 * A `<span>Held in trust - 400</span>` added to either one would be invisible
 * to this gate forever. That is the same shape as a cron watcher scoped to
 * three job-name prefixes, or a definer sweep that a new view walks straight
 * past: a list of the exceptions that happened to be true once.
 *
 * So the exemption is now the LINE, not the FILE. A regex literal in regex
 * position holding a dash is the stripper's own machinery and is blanked before
 * scanning; every string and JSX node in those four files is checked again.
 * Blanking rather than filtering the report is deliberate: --fix takes its
 * offsets from the same blanked copy, so the failure that broke titleCase.ts
 * cannot come back through a second code path.
 */
const SKIP_FILES = new Set([
  // This gate's own PATTERN is a literal list of the characters, so it can only
  // ever match itself. Nothing else belongs on this list.
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

/**
 * A regex literal in regex position that carries a dash is the code that
 * strips the character, never copy that shows it: a dash character class in a
 * normalising replace. Required to sit where a regex can legally begin
 * (after = ( , [ : ! & | ? { ; return, or at the start of a line) so that a
 * date or a fraction in JSX text is not mistaken for one, and required to hold
 * a dash at all so ordinary regexes are untouched. Blanked, not skipped: --fix
 * reads its offsets from this same copy.
 */
const REGEX_LITERAL = /(^|[=(,[:!&|?{;\n]|\breturn)(\s*)(\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[gimsuy]*)/g;

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
    // ...then the strippers' own regexes, which by now cannot be comment text.
    out = out.replace(REGEX_LITERAL, (m, pre, gap, body) =>
      EM_DASHES.test(body) ? pre + gap + ' '.repeat(body.length) : m
    );
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

for (const file of SOURCE_OVERRIDE
  ? walk(SRC)
  : [...walk(SRC), ...walk(PUBLIC), ...HTML_FILES.map((f) => join(ROOT, f)), ...walk(SERVER_SRC)]) {
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
