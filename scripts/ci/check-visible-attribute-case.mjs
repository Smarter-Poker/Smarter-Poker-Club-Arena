#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-visible-attribute-case — Title Case in the text JSX paints from ATTRIBUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "First letter of every word is capitalized, that's a hard rule
 * for all forward facing pages." Repeated 2026-08-31: "MAKE SURE THE FIRST
 * LETTER OF EVERY WORD ON EVERY SINGLE PAGE AND SUB PAGE IS CAPITALIZED."
 *
 * WHY A SECOND SCRIPT
 *
 * check-title-case already enforces this, and enforces it well, but it reads
 * JsxText nodes ONLY and says so deliberately: "String literals inside a child
 * expression" are out of scope because casing them blindly renames identifiers.
 *
 * That leaves a real hole. A browser paints plenty of text that never appears
 * as a JsxText node:
 *
 *     <input placeholder="Enter table name here..." />
 *     <Toggle label="Auto restart" />
 *     <span title="Playing now" />
 *     <img alt="Club logo preview" />
 *
 * Every one of those is a string ATTRIBUTE, invisible to the existing gate, and
 * every one of them is words on a page. 109 of them were lower case when this
 * was written.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *
 *   aria-label, aria-description and friends. Those are read aloud, not
 *   painted, and a screen reader pronounces a word the same in any case. They
 *   are assistive text rather than page text, they are the majority of the
 *   corpus (252 against 109), and mass-rewriting them would put a large
 *   accessibility-adjacent diff through files this change has no other reason
 *   to touch. If Dan wants them included, add the names to VISIBLE_ATTRS and
 *   run with --fix.
 *
 *   Attribute values that are not plain string literals ({expr}, template
 *   literals): cased at their source, exactly as check-title-case reasons.
 *
 *   Words already shouting (VIP, BBJ, NLH), words starting with a digit
 *   (6max, 3rd), and anything that is not a letter to begin with.
 *
 * Run:  node scripts/ci/check-visible-attribute-case.mjs [--fix]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
const FIX = process.argv.includes('--fix');

/** Attributes a browser paints as text a player reads. */
const VISIBLE_ATTRS = new Set([
  'placeholder',
  'title',
  'alt',
  'label',
  'heading',
  'subtitle',
  'caption',
  'emptyText',
  'buttonText',
  'confirmLabel',
  'cancelLabel',
  'submitLabel',
]);

function sourceFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
    else if (['.tsx', '.ts'].includes(extname(entry)) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Word boundaries, following popupStyle.formatPopupText with ONE correction.
 *
 * popupStyle treats a straight apostrophe as a word boundary, which is right
 * for a quoted phrase and wrong for a contraction: it turns "what you'd like"
 * into "What You'D Like". Every rule here is the same as popupStyle's except
 * that an apostrophe only opens a word when it FOLLOWS a boundary itself, so
 * 'quoted' still capitalises and You'd is left alone.
 *
 * Interior capitals are preserved throughout, so acronyms (VIP, BBJ, NLH)
 * survive untouched.
 */
const WORD_START = /(^|[\s([{"‘“\-/])([a-z])/g;
const QUOTED_WORD_START = /(^|[\s([{])(['’])([a-z])/g;
const titleCase = (s) =>
  s
    .replace(WORD_START, (_, boundary, letter) => boundary + letter.toUpperCase())
    .replace(QUOTED_WORD_START, (_, boundary, quote, letter) => boundary + quote + letter.toUpperCase());

const offenders = [];

for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];

  const walk = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      VISIBLE_ATTRS.has(node.name.getText(sf))
    ) {
      const value = node.initializer.text;
      const cased = titleCase(value);
      if (cased !== value) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push({
          file: file.replace(ROOT, ''),
          line: line + 1,
          attr: node.name.getText(sf),
          from: value,
          to: cased,
        });
        edits.push({
          start: node.initializer.getStart(sf) + 1,
          end: node.initializer.getEnd() - 1,
          cased,
        });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  if (FIX && edits.length) {
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.cased + out.slice(e.end);
    }
    writeFileSync(file, out);
  }
}

if (offenders.length === 0) {
  console.log('check-visible-attribute-case: OK - every painted attribute is Title Cased.');
  process.exit(0);
}

if (FIX) {
  console.log(`check-visible-attribute-case: fixed ${offenders.length} attribute value(s).`);
  process.exit(0);
}

console.error('\nLOWER-CASE TEXT IN A PAINTED ATTRIBUTE\n');
console.error('These strings are painted by the browser and are not JsxText, so');
console.error('check-title-case cannot see them. Run with --fix.\n');
for (const o of offenders.slice(0, 40)) {
  console.error(`  ${o.file}:${o.line}  ${o.attr}="${o.from}"  ->  "${o.to}"`);
}
if (offenders.length > 40) console.error(`  ... and ${offenders.length - 40} more`);
console.error(`\n${offenders.length} value(s).`);
process.exit(1);
