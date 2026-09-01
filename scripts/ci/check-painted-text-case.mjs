#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-painted-text-case — Title Case in the painted text the JsxText gate cannot see
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
 *   aria-label, aria-description and friends. Not because they are exempt, but
 *   because they already have a gate: check-title-case.mjs lists all three in
 *   UI_ATTRIBUTE_NAMES and cased the whole corpus in PR #2273. As of this
 *   writing 400 literal aria-labels live in src and none of them are lower
 *   case.
 *
 *   So do NOT add them to VISIBLE_ATTRS. This file and check-title-case case a
 *   string by different code -- that one uses the shared ACRONYMS set, this one
 *   uses WORD_START boundaries and isProse() -- and two gates that disagree
 *   about what Title Case IS would each spend forever 'fixing' the other's
 *   output. One attribute, one gate. Six names already appear in both lists
 *   (title, alt, label, placeholder, caption, subtitle); they agree on today's
 *   corpus, and that overlap is a thing to collapse, not to widen.
 *
 *   What is still genuinely uncovered is not the literals: it is the template
 *   -literal aria-labels whose static chunks are lower case. Those are cased at
 *   their source, and a --fix codemod is not safe there -- an earlier run Title
 *   Cased a CSS class name and silently broke the equity overlay.
 *
 *   Attribute values that are not plain string literals ({expr}, template
 *   literals): cased at their source, exactly as check-title-case reasons.
 *
 *   Words already shouting (VIP, BBJ, NLH), words starting with a digit
 *   (6max, 3rd), and anything that is not a letter to begin with.
 *
 * Run:  node scripts/ci/check-painted-text-case.mjs [--fix]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = process.env.PAINTED_TEXT_SOURCE_DIR
  ? resolve(process.env.PAINTED_TEXT_SOURCE_DIR)
  : join(ROOT, 'src');
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

/**
 * Is this string prose a player reads, rather than something that only looks
 * like it?
 *
 * This predicate is the whole safety of the --fix path, and its first version
 * was not careful enough. It capitalised three CSS class names in TablePage:
 *
 *     let eqSide = ' equity-overlay--above';   ->  ' Equity-Overlay--Above'
 *
 * `.equity-overlay--above` is a real rule in TablePage.css, so that silently
 * broke the equity overlay's position on the felt. Nothing caught it: it is
 * valid TypeScript, no test asserts on a class name, and the page still
 * renders. Exactly the hazard check-title-case's header warns about when it
 * says casing arbitrary expressions "renames identifiers".
 *
 * The leading space was what fooled it - " equity-overlay--above" contains
 * whitespace, so a naive "has a space, must be a sentence" test passed. The
 * string is TRIMMED before that test now.
 */
function isProse(value) {
  const v = value.trim();
  if (!/\s/.test(v)) return false; // one token: a key, a class name, a slug
  if (v.length < 6) return false;
  // CSS values, selectors, code.
  if (/[#(){};:]|\d+(px|ms|s|deg|%|em|rem)\b|rgba?\(|linear-gradient|cubic-bezier|monospace|sans-serif|https?:|\/\//.test(v)) {
    return false;
  }
  if (/--/.test(v)) return false; // BEM modifier or a CSS custom property
  if (/[@_]/.test(v)) return false; // an email example, or a snake_case identifier
  if (/^[/.]/.test(v)) return false; // a path: /vip, ./thing
  if (/\.(com|net|org|io|dev|app|png|jpe?g|svg|webp|gif)\b/i.test(v)) return false;
  return /[a-z]{3}/.test(v);
}
const PROSE = { test: isProse };

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


/**
 * AN ESCAPE SEQUENCE IS NOT A LETTER, AND --fix MUST NOT REWRITE ONE (2026-08-31).
 *
 * The rewrite reads `lit.text` - the COOKED value, escapes already resolved -
 * and splices it back into the RAW span between the quotes. For a literal with
 * no escapes those are the same string and nothing is lost. For one containing
 * `\n` they are not, and the fixer writes a REAL NEWLINE into the middle of a
 * single-quoted string:
 *
 *     desc:'Android - HD LCD - Built-in Speaker\nTempered Glass'
 *  -> desc:'Android - HD LCD - Built-In Speaker
 *     Tempered Glass'                            <- unterminated. Build fails.
 *
 * Caught on the World Hub, where this gate was being ported and `\n` is common
 * in painted copy. Club Arena has 78 literals carrying a real escape; none is
 * currently an offender, so the fixer has never reached one. That is luck, not
 * safety - the next lower-case painted string containing `\n` fires it.
 *
 * Same shape as the regex-literal hazard in check-ui-text.mjs, and the same
 * answer: a value this script cannot rewrite BYTE-FOR-BYTE is REPORTED for a
 * human, never guessed at. Detection is exact rather than a regex over escape
 * shapes - if the raw source between the quotes differs from the cooked value
 * at all, splicing the cooked value back in would change something.
 */
function rawMatchesCooked(lit, sf, text) {
  return text.slice(lit.getStart(sf) + 1, lit.getEnd() - 1) === lit.text;
}

const unsafe = [];

const offenders = [];

for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];

  const walk = (node) => {
    /**
     * A string literal inside a JSX EXPRESSION that is a child of an element.
     * Deliberately does NOT descend into a nested JSX element, because that
     * element's own style={{...}} and attributes are not this expression's
     * rendered text - without that guard the scan returns ten times as many
     * CSS values as it does sentences.
     */
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
    /**
     * A literal that is COMPARED is a value, not copy.
     *
     * `{inv.direction === 'union owes club' ? '+' : '-'}` puts an enum inside
     * a JSX expression, and Title Casing it would not change a word on the
     * page - it would break the comparison and flip the sign on every invoice
     * amount. Same for a switch label. The rendered halves of that ternary are
     * still collected; only the operand being tested is skipped.
     */
    const isComparedValue = (lit) => {
      const parent = lit.parent;
      if (!parent) return false;
      if (ts.isCaseClause(parent)) return true;
      if (ts.isBinaryExpression(parent)) {
        const op = parent.operatorToken.kind;
        return (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken
        );
      }
      // .includes('x'), .indexOf('x'), .startsWith('x') and friends
      if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
        return /^(includes|indexOf|startsWith|endsWith|has|get|match|search)$/.test(
          parent.expression.name.getText(sf)
        );
      }
      return false;
    };

      const literals = [];
      const collect = (x) => {
        if (
          ts.isJsxElement(x) ||
          ts.isJsxSelfClosingElement(x) ||
          ts.isJsxFragment(x) ||
          ts.isJsxAttributes(x)
        ) {
          return;
        }
        if (ts.isStringLiteral(x)) literals.push(x);
        ts.forEachChild(x, collect);
      };
      collect(node.expression);
      for (const lit of literals) {
        if (isComparedValue(lit)) continue;
        const value = lit.text;
        if (!PROSE.test(value)) continue;
        const cased = titleCase(value);
        if (cased === value) continue;
        const { line } = sf.getLineAndCharacterOfPosition(lit.getStart(sf));
        if (!rawMatchesCooked(lit, sf, text)) {
          unsafe.push({ file: file.replace(ROOT, ''), line: line + 1, attr: 'rendered text', from: value });
          continue;
        }
        offenders.push({
          file: file.replace(ROOT, ''),
          line: line + 1,
          attr: 'rendered text',
          from: value,
          to: cased,
        });
        edits.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, cased });
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      VISIBLE_ATTRS.has(node.name.getText(sf))
    ) {
      const value = node.initializer.text;
      /**
       * The same prose test the expression path uses. An attribute carries
       * example values as often as it carries copy - placeholder="your@email
       * .com", placeholder="/images/promo.png", placeholder="spring_spins_push"
       * - and Title Casing an example teaches the reader the wrong format.
       * "Your@email.com" is not an email address anybody should type.
       */
      const cased = isProse(value) ? titleCase(value) : value;
      if (cased !== value) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (!rawMatchesCooked(node.initializer, sf, text)) {
          unsafe.push({
            file: file.replace(ROOT, ''),
            line: line + 1,
            attr: node.name.getText(sf),
            from: value,
          });
          ts.forEachChild(node, walk);
          return;
        }
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

/**
 * The escapes are reported whether or not anything else is wrong, and BEFORE
 * the OK line, so a clean run still shows what the fixer declined to touch. A
 * hazard the tool silently swallows is a hazard the next person walks into.
 */
if (unsafe.length > 0) {
  console.error(
    `\ncheck-painted-text-case: ${unsafe.length} lower-case painted string(s) contain an ESCAPE`
  );
  console.error('SEQUENCE and were left alone. --fix would splice the cooked value back');
  console.error('into the raw source and turn \\n into a real newline, breaking the file.');
  console.error('Retype these by hand, or split the escape out of the copy:\n');
  for (const u of unsafe.slice(0, 20)) {
    console.error(`  ${u.file}:${u.line}  ${u.attr}: ${JSON.stringify(u.from).slice(0, 100)}`);
  }
  if (unsafe.length > 20) console.error(`  ... and ${unsafe.length - 20} more`);
  console.error('');
}

if (offenders.length === 0) {
  console.log('check-painted-text-case: OK - every painted string is Title Cased.');
  process.exit(0);
}

if (FIX) {
  console.log(`check-painted-text-case: fixed ${offenders.length} painted string(s).`);
  process.exit(0);
}

console.error('\nLOWER-CASE TEXT A BROWSER PAINTS\n');
console.error('These strings are painted by the browser and are not JsxText, so');
console.error('check-title-case cannot see them. Run with --fix.\n');
for (const o of offenders.slice(0, 40)) {
  console.error(`  ${o.file}:${o.line}  ${o.attr}="${o.from}"  ->  "${o.to}"`);
}
if (offenders.length > 40) console.error(`  ... and ${offenders.length - 40} more`);
console.error(`\n${offenders.length} value(s).`);
process.exit(1);
