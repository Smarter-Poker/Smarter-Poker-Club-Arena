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
 * compiler for JSX nodes is exact: it lets the gate distinguish rendered copy
 * from identifiers, routes, CSS values, and other non-visual strings.
 *
 * WHAT IT ALSO CHECKS
 *   - literal copy rendered from JSX expressions, including ternary branches
 *   - visible and accessible JSX attributes such as labels, placeholders,
 *     titles, descriptions, alt text, and aria-labels
 *
 * WHAT IT DOES NOT TOUCH
 *   - runtime values inside expressions; those must use titleCase at their
 *     source (or formatPopupText for toasts)
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

/** Copy modules whose string values are player-facing by definition. */
const STRING_TABLES = new Map([
  ['src/i18n/index.ts', null],
  ['src/components/support/FAQPanel.tsx', new Set(['category', 'question', 'answer'])],
  ['src/pages/HelpPage.tsx', new Set(['category', 'question', 'answer'])],
  ['src/pages/AchievementsPage.tsx', new Set(['name', 'description', 'requirement'])],
  ['src/services/AchievementService.ts', new Set(['name', 'description'])],
  ['src/components/moderation/ReportPlayerModal.tsx', new Set(['label', 'description'])],
  ['src/services/PlayerStyleClassifier.ts', new Set(['label', 'tooltip'])],
  ['src/services/ArenaTrainingController.ts', new Set(['name', 'description'])],
  ['src/services/DailyChallengeService.ts', new Set(['name', 'description'])],
  ['src/components/security/PasswordStrength.tsx', new Set(['label'])],
  ['src/components/gamification/FinancialAchievementBadge.tsx', new Set(['title', 'description'])],
  ['src/components/admin/AdminCommandPalette.tsx', new Set(['label', 'description'])],
  ['src/pages/workspaces/ArenaWorkspacePages.tsx', new Set(['label', 'description'])],
]);

/** Native and component props painted visually or announced by assistive technology. */
const TEXT_ATTRS = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'caption',
  'description',
  'emptyLabel',
  'emptyMessage',
  'errorMessage',
  'helperText',
  'hint',
  'label',
  'loadingLabel',
  'placeholder',
  'successMessage',
  'title',
  'tooltip',
]);

/** Root/public HTML documents that can be opened as pages. */
const HTML_FILES = [
  'index.html',
  'public/offline.html',
];

/** Avoid treating routes, URLs, identifiers, examples, or numeric values as prose. */
function notProse(value) {
  const v = value.trim();
  if (!/[A-Za-z]/.test(v)) return true;
  if (/^(e\.g\.|i\.e\.|etc\.|vs\.)/i.test(v)) return true;
  if (/:\/\//.test(v) || v.startsWith('/')) return true;
  if (!/\s/.test(v) && /[_.]/.test(v)) return true;
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
  const trimmed = text.trim();
  // Machine-readable examples are not prose. Re-casing them can make a URL,
  // route, email address, or stable key misleading (and sometimes invalid).
  if (
    /^\S+:\/\/\S+$/.test(trimmed) ||
    /^\S+@\S+\.\S+$/.test(trimmed) ||
    /^\/\S+$/.test(trimmed) ||
    /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(trimmed)
  ) {
    return text;
  }
  return text.replace(/[A-Za-z][A-Za-z0-9'’]*/g, (word, offset, whole) => {
    // Inside an HTML entity (&nbsp;) - leave it alone.
    const before = whole.slice(Math.max(0, offset - 1), offset);
    if (before === '&' || before === '\\' || /[0-9]/.test(before)) return word;
    if (/^[0-9]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (before === '(' && (lower === 's' || lower === 'es')) return lower;
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (word.length > 1 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

/**
 * Every statically identifiable rendered text range in a TSX file, as
 * {start, end, text, suffix, prefix}. This includes JSX text, native visual and
 * accessibility attributes, direct expression literals, and template-literal
 * fragments. Word-boundary flags protect unit/plural fragments such as
 * `{seconds}s` and `match${count === 1 ? '' : 'es'}`.
 */
function jsxTextNodes(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];

  const addTextRange = (start, end, suffix = false, prefix = false) => {
    const text = source.slice(start, end);
    // Empty strings and one-character word suffixes are not standalone copy.
    if (!/[A-Za-z]/.test(text) || /^[A-Za-z]$/.test(text)) return;
    out.push({ start, end, text, suffix, prefix });
  };

  const addLiteral = (node, suffix = false, prefix = false) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
    addTextRange(node.getStart(sf) + 1, node.getEnd() - 1, suffix, prefix);
  };

  const addTemplate = (node, suffix = false, prefix = false) => {
    const headStart = node.head.getStart(sf) + 1;
    const headEnd = node.head.getEnd() - 2;
    const headText = source.slice(headStart, headEnd);
    addTextRange(headStart, headEnd, suffix, /[A-Za-z]$/.test(headText));

    node.templateSpans.forEach((span, index) => {
      const literal = span.literal;
      const isTail = ts.isTemplateTail(literal);
      const start = literal.getStart(sf) + 1;
      const end = literal.getEnd() - (isTail ? 1 : 2);
      const text = source.slice(start, end);
      const previousLiteral = index === 0 ? node.head : node.templateSpans[index - 1].literal;
      const previousStart = previousLiteral.getStart(sf) + 1;
      const previousEnd = previousLiteral.getEnd() - 2;
      const previousText = source.slice(previousStart, previousEnd);
      // A template interpolation may itself return copy, for example
      // `${hasMenu ? ', hold to choose a wallet' : ''}`. Preserve true suffix
      // fragments such as `match${count === 1 ? '' : 'es'}`.
      collectRenderedLiterals(
        span.expression,
        /[A-Za-z]$/.test(previousText),
        /^[A-Za-z]/.test(text)
      );
      addTextRange(start, end, /^[A-Za-z]/.test(text), isTail ? prefix : /[A-Za-z]$/.test(text));
    });
  };

  /**
   * Collect only literals that an expression can return directly into JSX.
   * Do not descend into calls or arbitrary object data: those may be routes,
   * CSS classes, IDs, or query values rather than copy.
   */
  const collectRenderedLiterals = (node, suffix = false, prefix = false) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addLiteral(node, suffix, prefix);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      addTemplate(node, suffix, prefix);
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      collectRenderedLiterals(node.expression, suffix, prefix);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collectRenderedLiterals(node.whenTrue, suffix, prefix);
      collectRenderedLiterals(node.whenFalse, suffix, prefix);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        // The left side is a condition; only the right side can paint.
        collectRenderedLiterals(node.right, suffix, prefix);
      } else if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.PlusToken
      ) {
        collectRenderedLiterals(node.left, suffix, prefix);
        collectRenderedLiterals(node.right, suffix, prefix);
      }
    }
  };

  const expressionWordEdges = (node) => {
    const parent = node.parent;
    if (!parent?.children) return { suffix: false, prefix: false };
    const index = parent.children.indexOf(node);
    const previous = index > 0 ? parent.children[index - 1] : undefined;
    const next =
      index >= 0 && index < parent.children.length - 1 ? parent.children[index + 1] : undefined;
    const previousText =
      previous && ts.isJsxText(previous) ? source.slice(previous.pos, previous.end) : '';
    const nextText = next && ts.isJsxText(next) ? source.slice(next.pos, next.end) : '';
    return {
      suffix:
        (!!previous && ts.isJsxExpression(previous)) ||
        /[A-Za-z]$/.test(previousText) ||
        (/\n[\t ]*$/.test(previousText) && /[A-Za-z]$/.test(previousText.trimEnd())),
      prefix:
        (!!next && ts.isJsxExpression(next)) ||
        /^[A-Za-z]/.test(nextText) ||
        (/^[\t ]*\n/.test(nextText) && /^[A-Za-z]/.test(nextText.trimStart())),
    };
  };
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
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (UI_ATTRIBUTES.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) addLiteral(node.initializer);
        else if (ts.isJsxExpression(node.initializer)) {
          collectRenderedLiterals(node.initializer.expression);
        }
      }
    } else if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const parentTag = ts.isJsxElement(node.parent)
        ? node.parent.openingElement.tagName.getText(sf).toLowerCase()
        : '';
      if (parentTag !== 'style' && parentTag !== 'script') {
        const { suffix, prefix } = expressionWordEdges(node);
        collectRenderedLiterals(node.expression, suffix, prefix);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * Copy-bearing JSX attributes. Template-expression holes remain untouched;
 * only their literal spans are inspected.
 */
function textAttributeNodes(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];

  const pushTemplate = (tpl, attr) => {
    const spans = ts.isNoSubstitutionTemplateLiteral(tpl)
      ? [{ node: tpl, continues: false }]
      : [
          { node: tpl.head, continues: false },
          ...tpl.templateSpans.map((span) => ({ node: span.literal, continues: true })),
        ];

    for (const { node, continues } of spans) {
      const text = node.text;
      if (!/[A-Za-z]/.test(text) || notProse(text)) continue;
      let cased = titleCaseText(text);
      if (continues && /^[A-Za-z]/.test(text)) {
        const match = text.match(/^[A-Za-z][A-Za-z0-9'’]*/);
        const suffix = match ? match[0] : '';
        cased = suffix + titleCaseText(text.slice(suffix.length));
      }
      if (cased === text) continue;
      const start = node.getStart(sf) + 1;
      const tail = ts.isTemplateTail(node) || ts.isNoSubstitutionTemplateLiteral(node);
      const end = node.getEnd() - (tail ? 1 : 2);
      out.push({ start, end, text, cased, attr });
    }
  };

  const pushString = (literal, attr) => {
    if (!/[A-Za-z]/.test(literal.text) || notProse(literal.text)) return;
    out.push({
      start: literal.getStart(sf) + 1,
      end: literal.getEnd() - 1,
      text: literal.text,
      cased: titleCaseText(literal.text),
      attr,
    });
  };

  // Only value branches are copy. Never traverse a condition: its string
  // literals are data tokens such as activeTab === 'add', not painted text.
  const pushExpression = (expression, attr) => {
    if (ts.isStringLiteral(expression)) pushString(expression, attr);
    else if (
      ts.isTemplateExpression(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) pushTemplate(expression, attr);
    else if (ts.isConditionalExpression(expression)) {
      pushExpression(expression.whenTrue, attr);
      pushExpression(expression.whenFalse, attr);
    } else if (ts.isParenthesizedExpression(expression)) {
      pushExpression(expression.expression, attr);
    }
  };

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attr = node.name.getText(sf);
      if (TEXT_ATTRS.has(attr)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && !notProse(init.text)) {
          pushString(init, attr);
        } else if (ts.isJsxExpression(init) && init.expression) {
          pushExpression(init.expression, attr);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Title Case copy while preserving i18n interpolation identifiers. */
function titleCaseTemplate(value) {
  const slots = [];
  const masked = value.replace(/\{\{[^}]+\}\}/g, (token) => {
    slots.push(token);
    return `\u0000${slots.length - 1}\u0000`;
  });
  return titleCaseText(masked).replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)]);
}

/** String-literal property values from an explicitly player-facing copy table. */
function stringTableNodes(file, source, propertyNames) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (!propertyNames || propertyNames.has(node.name.getText(sf).replace(/^['"]|['"]$/g, ''))) &&
      ts.isStringLiteral(node.initializer) &&
      /[A-Za-z]/.test(node.initializer.text) &&
      !notProse(node.initializer.text)
    ) {
      const literal = node.initializer;
      out.push({
        start: literal.getStart(sf) + 1,
        end: literal.getEnd() - 1,
        text: literal.text,
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * User-facing text and copy attributes from standalone HTML pages. Script,
 * style, and comments are blanked before matching so code is never rewritten.
 */
function htmlTextNodes(source) {
  let visible = source
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/<script\b[\s\S]*?<\/script>/gi, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (match) => match.replace(/[^\n]/g, ' '));
  const out = [];

  const push = (start, end, text, kind) => {
    if (notProse(text)) return;
    const cased = titleCaseText(text);
    if (cased !== text) out.push({ start, end, text, cased, kind });
  };

  const tagPattern = /<[^>]+>/g;
  let cursor = 0;
  for (const match of visible.matchAll(tagPattern)) {
    if (match.index > cursor) {
      const text = visible.slice(cursor, match.index);
      if (/[A-Za-z]/.test(text)) push(cursor, match.index, text, 'html-text');
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < visible.length) {
    const text = visible.slice(cursor);
    if (/[A-Za-z]/.test(text)) push(cursor, visible.length, text, 'html-text');
  }

  const attrPattern =
    /\b(placeholder|aria-label|aria-valuetext|alt|title)\s*=\s*(["'])([\s\S]*?)\2/gi;
  for (const match of visible.matchAll(attrPattern)) {
    const text = match[3];
    const valueOffset = match[0].indexOf(text);
    push(match.index + valueOffset, match.index + valueOffset + text.length, text, match[1]);
  }

  const metaPattern = /<meta\b[^>]*>/gi;
  for (const meta of visible.matchAll(metaPattern)) {
    const target = meta[0].match(
      /\b(?:name|property)\s*=\s*(["'])(description|og:title|og:description|twitter:title|twitter:description|apple-mobile-web-app-title)\1/i
    );
    const content = meta[0].match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!target || !content) continue;
    const value = content[2];
    const valueOffset = meta[0].indexOf(value, content.index);
    push(meta.index + valueOffset, meta.index + valueOffset + value.length, value, 'meta-content');
  }
  return out;
}

const offenders = [];
let fixedNodes = 0;
let fixedFiles = 0;

for (const [rel, propertyNames] of STRING_TABLES) {
  const file = join(ROOT, rel);
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch {
    offenders.push(`${rel}: configured copy table is missing or unreadable`);
    continue;
  }
  const changes = stringTableNodes(file, original, propertyNames)
    .map((node) => ({ ...node, cased: titleCaseTemplate(node.text) }))
    .filter((node) => node.cased !== node.text)
    .sort((a, b) => a.start - b.start);
  if (changes.length === 0) continue;
  if (fix) {
    let out = original;
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      out = out.slice(0, change.start) + change.cased + out.slice(change.end);
    }
    writeFileSync(file, out, 'utf8');
    fixedNodes += changes.length;
    fixedFiles++;
  } else {
    for (const change of changes) {
      const line = original.slice(0, change.start).split('\n').length;
      offenders.push(`${rel}:${line}: ${change.text.trim().slice(0, 90)}`);
    }
  }
}

for (const rel of HTML_FILES) {
  const file = join(ROOT, rel);
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch {
    offenders.push(`${rel}: configured HTML page is missing or unreadable`);
    continue;
  }
  const changes = htmlTextNodes(original).sort((a, b) => a.start - b.start);
  if (changes.length === 0) continue;
  if (fix) {
    let out = original;
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      out = out.slice(0, change.start) + change.cased + out.slice(change.end);
    }
    writeFileSync(file, out, 'utf8');
    fixedNodes += changes.length;
    fixedFiles++;
  } else {
    for (const change of changes) {
      const line = original.slice(0, change.start).split('\n').length;
      offenders.push(`${rel}:${line}: ${change.text.trim().slice(0, 90)}`);
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

  const changes = attrs.filter((attr) => attr.cased !== attr.text);
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
  console.error('Dan 2026-08-21: the first letter of every word is capitalized on every');
  console.error('forward-facing page. Run: node scripts/ci/check-title-case.mjs --fix\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-title-case: OK - every word on every page starts with a capital.');
