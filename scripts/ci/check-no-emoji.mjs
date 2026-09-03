#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-no-emoji — no emoji in anything a player can see
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * .agent/workflows/design-guidelines.md, rule 1, in capitals: "NO EMOJIS -
 * EVER". CLAUDE.md section 5 repeats it, and the World Hub's build gate fails
 * on bare emoji in JSX because they have broken the SWC compiler here before.
 *
 * It was the only one of the three copy rules nobody had made mechanical.
 * check-ui-text catches em dashes and check-title-case catches sentence case,
 * both by parsing; emoji were left to memory, and memory lost. The 2026-08-27
 * audit found them rendering in gameplay: a chat bubble and a smiley on the
 * profile sheet a player opens by tapping their own avatar mid-hand, a
 * snowflake and a clock as its tab labels, a diamond pricing a mock shop, and
 * a flame in the session HUD's hot-streak badge.
 *
 * ── WHAT COUNTS AS AN EMOJI ────────────────────────────────────────────────
 *
 * Characters that a phone paints as a COLOUR PICTURE - Unicode's
 * Emoji_Presentation set - and any character followed by U+FE0F, the
 * variation selector that demands emoji rendering of whatever precedes it.
 *
 * That definition is the whole point, and it is why this gate does not fire
 * on the glyphs the Club Arena legitimately uses as typography:
 *
 *     the card suits           ♠ ♣ ♥ ♦        poker iconography
 *     arrows                   ← → ↑ ↓        flow, sorting, deltas
 *     the close and the tick   ✕ ✓            CLAUDE.md permits plain
 *     the menu and the gear    ☰ ⚙            Unicode symbols; these are
 *     the shield, the note     ⛨ ✎            text-presentation glyphs that
 *                                             render in the page font
 *
 * Add U+FE0F to any of those and it becomes an emoji, and this gate says so:
 * `⚙` is a gear in your font, `⚙️` is a picture. That distinction is exactly
 * the line the design guidelines draw.
 *
 * ── WHAT IT DELIBERATELY IGNORES ───────────────────────────────────────────
 *
 * Source comments, for the reason check-ui-text gives for the same choice:
 * they never reach a player, this codebase uses them heavily for its decision
 * records, and rewriting the ~30 decorative emoji in gameplay file headers
 * would be a large diff with no user-visible effect that buries the real
 * change under it.
 *
 * The two emoji PICKERS are allowlisted below. Emoji are the product there,
 * not the styling.
 *
 * ── ESCAPES ARE DECODED FIRST ──────────────────────────────────────────────
 *
 * `icon: '\u{1F3AF}'` is a direct hit emoji as surely as pasting the
 * character, and the first cut of this gate could not see it. Two were found
 * that way AFTER this gate went green - in the tournament bounty overlays,
 * shipped and rendering - by decompiling the deployed bundle rather than
 * trusting the scan. A gate a keystroke can walk around is not a gate, so
 * every \u{...} and \uXXXX (surrogate pairs included) is decoded before the
 * scan, and the report prints the escape the author actually wrote.
 *
 * Run:  node scripts/ci/check-no-emoji.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const EXTS = new Set(['.ts', '.tsx', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);

/**
 * Files where emoji ARE the feature. A chat emoji picker without emoji in it
 * is not a stricter picker, it is a broken one.
 *
 * This list is deliberately short and deliberately explicit. Anything added
 * here is a claim that the emoji in that file are content a player chose to
 * send, not decoration an agent reached for.
 */
const ALLOW_FILES = new Set([
  'src/components/emoji/EmojiPicker.tsx',
  'src/components/emoji/EmojiPicker.css',
  'src/components/table/EmojiPicker.tsx',
  'src/components/table/EmojiPicker.css',
  'src/components/table/TableReactions.tsx',
  'src/components/table/TableReactions.css',
  'scripts/ci/check-no-emoji.mjs',
]);

/**
 * Unicode Emoji_Presentation=Yes, plus U+FE0F.
 *
 * Written as explicit ranges rather than a \p{Emoji} property escape on
 * purpose: \p{Emoji} is TRUE for the ASCII digits and for `#` and `*`, so a
 * gate built on it fails on every number in the codebase. \p{Emoji_Presentation}
 * is the correct property, and these ranges are its contents - spelled out so
 * the set this gate enforces is readable here rather than in a spec.
 */
const EMOJI = new RegExp(
  '[' +
    '\\u231A\\u231B' + // watch, hourglass
    '\\u23E9-\\u23EC\\u23F0\\u23F3' + // media, alarm, sand timer
    '\\u25FD\\u25FE' + // small squares
    '\\u2614\\u2615' + // umbrella, hot beverage
    '\\u2648-\\u2653' + // zodiac
    '\\u267F\\u2693\\u26A1\\u26AA\\u26AB' +
    '\\u26BD\\u26BE\\u26C4\\u26C5\\u26CE\\u26D4\\u26EA' +
    '\\u26F2\\u26F3\\u26F5\\u26FA\\u26FD' +
    '\\u2705\\u270A\\u270B\\u2728\\u274C\\u274E' +
    '\\u2753-\\u2755\\u2757\\u2795-\\u2797\\u27B0\\u27BF' +
    '\\u2B1B\\u2B1C\\u2B50\\u2B55' +
    '\\uFE0F' + // variation selector-16: "render the previous char as emoji"
    '\\u{1F000}-\\u{1FAFF}' + // the pictograph planes
    ']',
  'u'
);

/**
 * Turn `\u{1F600}` and `\uD83D\uDE00` into the characters they denote, so an
 * escaped emoji is caught exactly like a pasted one. Line structure is
 * preserved (no escape contains a newline), which keeps reported line numbers
 * honest.
 */
function decodeEscapes(line) {
  return line
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Strip comments so the scan only sees code and copy. Mirrors check-ui-text. */
function stripComments(source, isCss) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
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

for (const file of walk(SRC)) {
  const rel = file.replace(ROOT, '');
  if (ALLOW_FILES.has(rel)) continue;
  const original = readFileSync(file, 'utf8');
  if (!EMOJI.test(original) && !/\\u\{?[0-9a-fA-F]{4}/.test(original)) continue;

  const scannable = stripComments(original, extname(file) === '.css');

  scannable.split('\n').forEach((line, idx) => {
    // Decode per line: an escaped emoji renders identically to a pasted one.
    if (EMOJI.test(decodeEscapes(line))) {
      // Report the ORIGINAL line, so the author sees the escape they wrote
      // rather than a character their editor may not render.
      const shown = [...line.trim()].slice(0, 120).join('');
      offenders.push(`${rel}:${idx + 1}: ${shown}`);
    }
  });
}

if (offenders.length > 0) {
  console.error('\ncheck-no-emoji FAILED: emoji found in player-facing code.\n');
  console.error('design-guidelines.md rule 1: "NO EMOJIS - EVER".');
  console.error('Use a text label, a Unicode text glyph, or an SVG icon instead.');
  console.error('If emoji are genuinely the feature, allowlist the file in this script.\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-no-emoji: OK - no emoji in player-facing code.');
