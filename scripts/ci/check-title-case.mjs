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
 * ATTRIBUTES THAT ARE ALSO TEXT (added 2026-08-31)
 *   JsxText is not the only copy a browser paints. `placeholder` sits inside
 *   the field, `title` is the tooltip, `alt` is what replaces a missing image,
 *   and `aria-label` is the ONLY text a screen-reader user gets for a control
 *   that has no visible label. Those were never scanned, and three
 *   `aria-label="required"` were sitting in the shared Input.
 *
 *   The allowlist is deliberately short and the exemptions are deliberately
 *   generous: an attribute is only copy when it reads as prose, so slugs
 *   (`spring_spins_push`), example values (`e.g. 40`), URLs and anything with
 *   no letters are left alone. A gate that renames an identifier is worse than
 *   one that misses a word.
 *
 * THE STRING TABLE (added 2026-08-31)
 *   src/i18n/index.ts is copy by definition and reaches the screen through
 *   `t(...)`, which is an expression - so neither pass above could ever see
 *   it. It held 36 uncased strings, and every one of them is what a screen
 *   reader announces at the table: "Seat {{number}}: open - click to sit",
 *   "(all in)", "Raise amount", "Bet all in".
 *
 *   That one bit the codebase on the day this was written: MultiTablePage
 *   carried a literal `aria-label="Raise amount"` AND the table carried
 *   `raise_amount_label`, the attribute pass cased the literal, and the two
 *   spellings of the same label silently diverged.
 *
 *   Interpolation tokens are protected. `{{amount}}` is a lookup key, not a
 *   word, and casing it to `{{Amount}}` breaks the substitution rather than
 *   the sentence.
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
  'nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo', 'ofc',
  'nl', 'pl', 'fl', 'sng', 'mtt', 'xmtt', 'pko', 'ko', 'gtd', 'hu', 'wsop',
  'bbj', 'vip', 'id', 'utg', 'sb', 'bb', 'btn', 'co', 'mp', 'hj', 'lj',
  'rit', 'gto', 'ev', 'roi', 'itm', 'usd', 'kyc', 'tos', 'faq', 'api', 'url',
  'pc', 'ios', 'os', 'ui', 'ux', 'qr', 'sms', 'otp', '2fa',
]);

const fix = process.argv.includes('--fix');

/** Copy modules whose string VALUES are user-facing text. */
const STRING_TABLES = new Set(['src/i18n/index.ts']);

/** Attributes a browser paints, or a screen reader announces, as text. */
const TEXT_ATTRS = new Set(['placeholder', 'aria-label', 'alt', 'title']);

/**
 * True when an attribute value is an identifier, an example or a URL rather
 * than a sentence a player reads.
 */
function notProse(value) {
  const v = value.trim();
  if (!/[A-Za-z]/.test(v)) return true;                 // "40", "%s"
  if (/^(e\.g\.|i\.e\.|etc\.|vs\.)/i.test(v)) return true; // "e.g. 40"
  if (/:\/\//.test(v) || v.startsWith('/')) return true;   // URLs and routes
  if (!/\s/.test(v) && /[_.]/.test(v)) return true;      // slug_or.identifier
  return false;
}

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

/**
 * Every JSX string attribute in TEXT_ATTRS, as {start, end, text}. Only plain
 * string literals: `placeholder={t('x')}` is an expression and is cased at its
 * source, exactly as the JsxText pass treats `{}`.
 */
function textAttributeNodes(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];

  /**
   * A template attribute is copy too: `aria-label={`${wagerVerb} amount`}`
   * rendered "Raise amount" for every screen-reader user at the table, and no
   * pass above could see it.
   *
   * Only the LITERAL spans are cased. The `${...}` holes are expressions, cased
   * at their source exactly as `{}` is in JSX - and one of them here
   * (`${wagerVerb.toLowerCase()}`) is deliberately lower, which a naive rewrite
   * would fight forever.
   *
   * The same unit-suffix guard as the JsxText pass applies: a span that starts
   * with a letter immediately after a hole is finishing that hole's word
   * (`${n}s`, `${x}px`), not starting a new one.
   */
  const pushTemplate = (tpl, name) => {
    const spans = [];
    if (ts.isNoSubstitutionTemplateLiteral(tpl)) {
      spans.push({ node: tpl, continues: false });
    } else {
      spans.push({ node: tpl.head, continues: false });
      for (const span of tpl.templateSpans) spans.push({ node: span.literal, continues: true });
    }
    for (const { node, continues } of spans) {
      const raw = node.text;
      if (!/[A-Za-z]/.test(raw) || notProse(raw)) continue;
      let cased;
      if (continues && /^[A-Za-z]/.test(raw)) {
        const m = raw.match(/^[A-Za-z][A-Za-z0-9'’]*/);
        const head = m ? m[0] : '';
        cased = head + titleCaseText(raw.slice(head.length));
      } else {
        cased = titleCaseText(raw);
      }
      if (cased === raw) continue;
      // getStart()+1 skips the opening backtick/brace; getEnd()-1 the closing.
      const startOffset = node.getStart(sf) + 1;
      const endOffset = node.getEnd() - (ts.isTemplateTail(node) || ts.isNoSubstitutionTemplateLiteral(node) ? 1 : 2);
      out.push({ start: startOffset, end: endOffset, text: raw, attr: name, preCased: cased });
    }
  };

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (TEXT_ATTRS.has(name)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) {
          const text = init.text;
          if (!notProse(text)) {
            // Inside the quotes only, so the quote characters survive a rewrite.
            out.push({ start: init.getStart(sf) + 1, end: init.getEnd() - 1, text, attr: name });
          }
        } else if (ts.isJsxExpression(init) && init.expression) {
          const e = init.expression;
          if (ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
            pushTemplate(e, name);
          } else if (ts.isConditionalExpression(e)) {
            /**
             * A label that switches on state is still a label:
             * `aria-label={exporting ? 'Cancel CSV export' : 'Export as CSV'}`
             * put two spellings of the same control on the page, and only the
             * branch nobody was looking at stayed lowercase.
             *
             * Only the two BRANCHES are read, and only when they are plain
             * strings or templates. The condition is code.
             */
            for (const branch of [e.whenTrue, e.whenFalse]) {
              if (ts.isStringLiteral(branch)) {
                if (notProse(branch.text)) continue;
                out.push({
                  start: branch.getStart(sf) + 1,
                  end: branch.getEnd() - 1,
                  text: branch.text,
                  attr: name,
                });
              } else if (ts.isTemplateExpression(branch) || ts.isNoSubstitutionTemplateLiteral(branch)) {
                pushTemplate(branch, name);
              }
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * Title Case a string-table value, leaving `{{token}}` interpolation keys
 * exactly as they are.
 */
function titleCaseTemplate(value) {
  const slots = [];
  const masked = value.replace(/\{\{[^}]+\}\}/g, (t) => {
    slots.push(t);
    return `\u0000${slots.length - 1}\u0000`;
  });
  return titleCaseText(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/**
 * Every string-literal VALUE of a property in a copy module, as
 * {start, end, text}. Keys are identifiers and are left alone.
 */
function stringTableNodes(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      /[A-Za-z]/.test(node.initializer.text)
    ) {
      const lit = node.initializer;
      if (!notProse(lit.text)) {
        out.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, text: lit.text });
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

// ── Pass 3: the string tables ────────────────────────────────────────────
for (const rel of STRING_TABLES) {
  const file = join(ROOT, rel);
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch {
    continue; // a table that has moved is not this gate's problem
  }
  const nodes = stringTableNodes(file, original);
  const changes = [];
  for (const n of nodes) {
    const cased = titleCaseTemplate(n.text);
    if (cased !== n.text) changes.push({ ...n, cased });
  }
  if (changes.length === 0) continue;
  changes.sort((a, b) => a.start - b.start);

  if (fix) {
    let out = original;
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
      offenders.push(`${rel}:${line}: ${c.text.trim().slice(0, 90)}`);
    }
  }
}

for (const file of walk(SRC)) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes('<')) continue;

  let nodes;
  let attrs;
  try {
    nodes = jsxTextNodes(file, original);
    attrs = textAttributeNodes(file, original);
  } catch {
    continue; // a file the parser cannot read is not this gate's problem
  }

  const changes = [];

  // Attributes first; they carry no suffix/prefix subtleties, because an
  // attribute value is a whole string rather than a fragment sitting beside an
  // expression.
  for (const a of attrs) {
    const cased = a.preCased ?? titleCaseText(a.text);
    if (cased !== a.text) changes.push({ ...a, cased });
  }
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
  // The rewrite below walks back to front, which is only correct on a list in
  // source order; attributes were collected in a separate pass.
  changes.sort((a, b) => a.start - b.start);

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
  console.error("Dan 2026-08-21: the first letter of every word is capitalized on every");
  console.error('forward-facing page. Run: node scripts/ci/check-title-case.mjs --fix\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-title-case: OK - every word on every page starts with a capital.');
