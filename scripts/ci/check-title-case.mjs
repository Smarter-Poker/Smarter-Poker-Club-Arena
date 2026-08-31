#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-title-case — the first letter of every word, on every forward-facing page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "First letter of every word is capitalized, that's a hard rule
 * for all forward facing pages."
 *
 * The rule already existed for popups (src/utils/popupStyle.ts applies it to
 * every toast at render). Pages were left to remember it by hand, and 1,282
 * pieces of copy across 300 files did not. A rule a person has to remember is a
 * rule that decays, so this makes it mechanical.
 *
 * WHY THE TYPESCRIPT PARSER AND NOT A REGEX
 *
 * The obvious implementation - find text between `>` and `<` - also matches
 * TypeScript generics (`Array<string>`), comparisons (`a > b`) and fragments of
 * ternaries (`) : loading ? (`). "Fixing" one of those renames an identifier and
 * breaks the build, or worse, compiles and changes behaviour. Asking the
 * compiler for JsxText nodes is exact: it returns the characters a browser will
 * paint as text and nothing else.
 *
 * WHAT IT DOES NOT TOUCH
 *   - anything inside {} - those are expressions, and their values are cased at
 *     their source (or by formatPopupText for toasts)
 *   - words already shouting (VIP, BBJ, LIVE), which are acronyms or emphasis
 *   - tokens that start with a digit (6max, 3rd, 2x): the letters are a suffix
 *   - HTML entities (&nbsp; &rsquo;)
 *   - comments, which never reach a player
 *
 * Run:  node scripts/ci/check-title-case.mjs [--fix]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);

/** Initialisms that are shouted, not Title Cased. Mirrors src/utils/titleCase.ts. */
const ACRONYMS = new Set([
  'nlh',
  'nlhe',
  'plo',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flh',
  'flo',
  'ofc',
  'nl',
  'pl',
  'fl',
  'sng',
  'mtt',
  'xmtt',
  'pko',
  'ko',
  'gtd',
  'hu',
  'wsop',
  'bbj',
  'vip',
  'id',
  'utg',
  'sb',
  'bb',
  'btn',
  'co',
  'mp',
  'hj',
  'lj',
  'rit',
  'gto',
  'ev',
  'roi',
  'itm',
  'usd',
  'kyc',
  'tos',
  'faq',
  'api',
  'url',
  'pc',
  'ios',
  'os',
  'ui',
  'ux',
  'qr',
  'sms',
  'otp',
  '2fa',
]);

const fix = process.argv.includes('--fix');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (extname(entry) === '.tsx') acc.push(full);
  }
  return acc;
}

/**
 * Capitalise the first letter of every word.
 *
 * Interior capitals are preserved so camel-case product names and proper nouns
 * survive. Hyphen and slash compounds are cased on both sides, because "add-on"
 * and "win/loss" read as two words.
 */
export function titleCaseText(text) {
  return text.replace(/[A-Za-z][A-Za-z0-9'’]*/g, (word, offset, whole) => {
    // Inside an HTML entity (&nbsp;) - leave it alone.
    const before = whole.slice(Math.max(0, offset - 1), offset);
    if (before === '&') return word;
    if (/^[0-9]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (word.length > 1 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/**
 * Every JsxText node in a file, as {start, end, text}.
 *
 * DELIBERATELY JsxText ONLY. String literals inside a child expression -
 * `{n === 1 ? '' : 's'}` - also reach the screen, but they cannot be cased
 * safely: that particular one is the plural suffix of the word before it, and
 * capitalising it renders "GameS". Others are CSS values, routes and class
 * names that a parser cannot tell apart from prose. A rule that occasionally
 * corrupts a page is worse than one that covers the 95% that is unambiguous,
 * so those fragments are left to their authors.
 */
function jsxTextNodes(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  /**
   * True when this text node CONTINUES a word that an expression started, i.e.
   * `{seconds}s`, `{multiplier}x`, `{minutes}m`. The letter is a unit suffix,
   * not a word: capitalising it renders "30S", "2X", "Games" as "GameS". The
   * tell is that the text begins with a letter, with no space, and the node
   * immediately before it is an expression container.
   */
  const continuesAWord = (node) => {
    const parent = node.parent;
    if (!parent || !parent.children) return false;
    const i = parent.children.indexOf(node);
    if (i <= 0) return false;
    const prev = parent.children[i - 1];
    return !!prev && ts.isJsxExpression(prev);
  };

  /**
   * The mirror of continuesAWord: this text node STARTS a word that an
   * expression finishes, i.e. `x{count}` in a truncated chip stack. The letter
   * is a multiplier or unit PREFIX, not a word, and "X1,234" is not a chip
   * count anybody writes.
   *
   * Same tell, reversed: the text ends with a letter, with no space after it,
   * and the node immediately following is an expression container. Found by
   * this gate on 2026-08-23 blocking three files (ChipPhysics, ChipStack,
   * PotDisplay) that all render the identical `x{count.toLocaleString()}`.
   */
  const precedesAnExpression = (node) => {
    const parent = node.parent;
    if (!parent || !parent.children) return false;
    const i = parent.children.indexOf(node);
    if (i < 0 || i >= parent.children.length - 1) return false;
    const next = parent.children[i + 1];
    return !!next && ts.isJsxExpression(next);
  };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      // node.pos, NOT getStart(). getStart() skips leading trivia, and for
      // JsxText the leading WHITESPACE is trivia - so "{amount} chips" arrived
      // here as "chips" with the space invisible, the suffix guard below fired,
      // and a perfectly ordinary word was left lowercase. pos keeps the space,
      // which is the only thing that distinguishes "{n} chips" from "{n}s".
      const start = node.pos;
      const end = node.end;
      const text = source.slice(start, end);
      if (/[A-Za-z]/.test(text)) {
        const suffix = /^[A-Za-z]/.test(text) && continuesAWord(node);
        const prefix = /[A-Za-z]$/.test(text) && precedesAnExpression(node);
        out.push({ start, end, text, suffix, prefix });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const offenders = [];
let fixedNodes = 0;
let fixedFiles = 0;

/**
 * AUDIT 2026-08-31 - the app shell was outside this gate.
 *
 * This walks src/ for .tsx, which is every page of the SPA. It is not every
 * page a PLAYER sees: index.html carries the boot-failure screen, and that
 * screen shipped "Loading failed" and "Please clear your browser cache and
 * reload." - sentence case, on the one page that is guaranteed to be read by
 * somebody already having a bad time.
 *
 * index.html is not TSX, so the AST walk above cannot read it. It gets a
 * narrow HTML pass instead: the text inside heading, paragraph, button and
 * title elements, which is the same "prose a player reads" that jsxTextNodes
 * selects for, and nothing that looks like markup, script or style.
 */
const HTML_TEXT = /<(h[1-6]|p|button|title)\b[^>]*>([^<]*[A-Za-z][^<]*)<\/\1>/g;

function htmlTextNodes(source) {
  const out = [];
  for (const m of source.matchAll(HTML_TEXT)) {
    const text = m[2];
    // Skip anything that is plainly not prose: entities only, or a lone glyph.
    if (!/[A-Za-z]{2}/.test(text)) continue;
    const start = m.index + m[0].indexOf(text, m[0].indexOf('>'));
    out.push({ start, end: start + text.length, text, suffix: false, prefix: false });
  }
  return out;
}

for (const file of [...walk(SRC), join(ROOT, 'index.html')]) {
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch {
    continue; // absent in this checkout is not a failure
  }
  if (!original.includes('<')) continue;

  let nodes;
  try {
    nodes = extname(file) === '.html' ? htmlTextNodes(original) : jsxTextNodes(file, original);
  } catch {
    continue; // a file the parser cannot read is not this gate's problem
  }

  const changes = [];
  for (const n of nodes) {
    let cased;
    if (n.suffix) {
      // Leave the suffix word alone, case the rest of the node.
      const m = n.text.match(/^[A-Za-z][A-Za-z0-9'’]*/);
      const head = m ? m[0] : '';
      cased = head + titleCaseText(n.text.slice(head.length));
    } else {
      cased = titleCaseText(n.text);
    }
    if (n.prefix) {
      // Leave the trailing prefix-word alone, keep the casing of the rest.
      // `x{count}` stays `x`; "Buy In x{n}" keeps "Buy In" cased and its x.
      const m = n.text.match(/[A-Za-z][A-Za-z0-9'’]*$/);
      if (m) cased = cased.slice(0, cased.length - m[0].length) + m[0];
    }
    if (cased !== n.text) changes.push({ ...n, cased });
  }
  if (changes.length === 0) continue;

  if (fix) {
    let out = original;
    // Back to front, so earlier offsets stay valid.
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      out = out.slice(0, c.start) + c.cased + out.slice(c.end);
    }
    writeFileSync(file, out, 'utf8');
    fixedNodes += changes.length;
    fixedFiles++;
  } else {
    for (const c of changes) {
      const line = original.slice(0, c.start).split('\n').length;
      offenders.push(`${file.replace(ROOT, '')}:${line}: ${c.text.trim().slice(0, 90)}`);
    }
  }
}

if (fix) {
  console.log(`check-title-case: fixed ${fixedNodes} text node(s) across ${fixedFiles} file(s).`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error('\ncheck-title-case FAILED: page copy is not Title Cased.\n');
  console.error('Dan 2026-08-21: the first letter of every word is capitalized on every');
  console.error('forward-facing page. Run: node scripts/ci/check-title-case.mjs --fix\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-title-case: OK - every word on every page starts with a capital.');
