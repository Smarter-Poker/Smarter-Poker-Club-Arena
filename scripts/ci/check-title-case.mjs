#!/usr/bin/env node
/**
 * check-title-case - every static player-facing word starts with a capital
 *
 * Dan 2026-08-21: "First letter of every word is capitalized, that's a hard
 * rule for all forward facing pages."
 * Dan 2026-08-31: the rule covers every page and subpage, including accessible
 * names, placeholders, tooltips and conditional copy.
 *
 * The TypeScript parser keeps this safe. It identifies actual render nodes and
 * known copy-bearing fields instead of treating every quoted value as prose.
 * Routes, URLs, emails, translation keys, comments, style/script bodies and
 * dynamic server-fed values are deliberately left alone.
 *
 * Run: node scripts/ci/check-title-case.mjs [--fix]
 */

import { extname, join, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = process.env.TITLE_CASE_SOURCE_DIR
  ? resolve(process.env.TITLE_CASE_SOURCE_DIR)
  : join(ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
const COPY_REGISTRY_FILES = new Set(['src/i18n/index.ts']);

const UI_ATTRIBUTE_NAMES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'caption',
  'description',
  'emptyLabel',
  'emptyMessage',
  'errorMessage',
  'eyebrow',
  'helperText',
  'hint',
  'label',
  'loadingLabel',
  'placeholder',
  'statusText',
  'subtitle',
  'successMessage',
  'title',
  'tooltip',
]);

const UI_PROPERTY_NAMES = new Set([
  'caption',
  'description',
  'emptyLabel',
  'emptyMessage',
  'errorMessage',
  'eyebrow',
  'helperText',
  'hint',
  'label',
  'loadingLabel',
  'placeholder',
  'statusText',
  'subtitle',
  'successMessage',
  'title',
  'tooltip',
]);

/** Initialisms that are shouted, not Title Cased. Mirrors src/utils/titleCase.ts. */
const ACRONYMS = new Set([
  'nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo', 'ofc',
  'nl', 'pl', 'fl', 'sng', 'mtt', 'xmtt', 'pko', 'ko', 'gtd', 'hu', 'wsop',
  'bbj', 'vip', 'id', 'utg', 'sb', 'bb', 'btn', 'co', 'mp', 'hj', 'lj',
  'rit', 'gto', 'ev', 'roi', 'itm', 'usd', 'kyc', 'tos', 'faq', 'api', 'url',
  'pc', 'ios', 'os', 'ui', 'ux', 'qr', 'sms', 'otp', '2fa',
]);

const PLURAL_OR_UNIT_FRAGMENTS = new Set([
  's', 'es', 'ies', 'y', 'st', 'nd', 'rd', 'th', 'x', 'm', 'h',
]);

const fix = process.argv.includes('--fix');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (extname(entry) === '.tsx' || extname(entry) === '.ts') acc.push(full);
  }
  return acc;
}

/** Capitalize every word while preserving acronyms and numeric suffix tokens. */
export function titleCaseText(text) {
  return text.replace(/[A-Za-z0-9][A-Za-z0-9'’]*/g, (word, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 1), offset);
    if (before === '&') return word;
    if (
      whole.slice(Math.max(0, offset - 2), offset) === '{{' &&
      whole.slice(offset + word.length, offset + word.length + 2) === '}}'
    ) {
      return word;
    }
    if (/^[0-9]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (before === '(' && (lower === 's' || lower === 'es')) return lower;
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (word.length > 1 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return '';
}

function isMachineString(text) {
  const value = text.trim();
  if (!/[A-Za-z]/.test(value)) return true;
  if (/^(?:\\u[0-9a-f]{4}|\\x[0-9a-f]{2})+$/i.test(value)) return true;
  if (/^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value)) return true;
  if (/\S+@\S+\.\S+/.test(value)) return true;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value)) return true;
  // Translation keys, event names and dotted identifiers are not prose.
  if (/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(value)) return true;
  return false;
}

function isInsideStyleOrScript(node, sf) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const tag = current.openingElement.tagName.getText(sf).toLowerCase();
      return tag === 'style' || tag === 'script';
    }
    current = current.parent;
  }
  return false;
}

function staticStringLeaves(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node);
    return out;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticStringLeaves(node.expression, out);
  }
  if (ts.isConditionalExpression(node)) {
    staticStringLeaves(node.whenTrue, out);
    staticStringLeaves(node.whenFalse, out);
    return out;
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    staticStringLeaves(node.left, out);
    staticStringLeaves(node.right, out);
  }
  return out;
}

function isPluralOrUnitExpression(node) {
  const leaves = staticStringLeaves(node);
  return (
    leaves.length > 0 &&
    leaves.every((leaf) => {
      const value = leaf.text.trim().toLowerCase();
      return value === '' || PLURAL_OR_UNIT_FRAGMENTS.has(value);
    })
  );
}

function stringChange(node, source, sf, context) {
  const text = node.text;
  if (isMachineString(text)) return null;
  const cased = titleCaseText(text);
  if (cased === text) return null;

  const nodeStart = node.getStart(sf);
  const nodeEnd = node.getEnd();
  const raw = source.slice(nodeStart, nodeEnd);
  const quote = raw[0];
  if (!['"', "'", '`'].includes(quote) || raw.at(-1) !== quote) {
    return { start: nodeStart, end: nodeEnd, text, cased, context, replaceable: false };
  }

  return {
    start: nodeStart + 1,
    end: nodeEnd - 1,
    text,
    cased,
    context,
    // Do not destroy escape sequences during an automatic rewrite.
    replaceable: raw.slice(1, -1) === text,
  };
}

function templateSegmentChange(node, source, sf, context, index, total) {
  const text = node.text;
  if (isMachineString(text)) return null;

  let cased = titleCaseText(text);
  // A segment touching an interpolation may be a unit/plural fragment:
  // `${seconds}s`, `${count} players`, or `Lvl${level}`.
  if (index > 0 && /^[A-Za-z]/.test(text)) {
    const match = text.match(/^[A-Za-z][A-Za-z0-9'’]*/);
    if (match) cased = match[0] + titleCaseText(text.slice(match[0].length));
  }
  if (index < total - 1 && /[A-Za-z]$/.test(text) && !/\s/.test(text)) {
    const match = text.match(/[A-Za-z][A-Za-z0-9'’]*$/);
    if (match) cased = cased.slice(0, cased.length - match[0].length) + match[0];
  }
  if (cased === text) return null;

  const nodeStart = node.getStart(sf);
  const nodeEnd = node.getEnd();
  const raw = source.slice(nodeStart, nodeEnd);
  const isHead = ts.isTemplateHead(node);
  const isTail = ts.isTemplateTail(node);
  const start = nodeStart + 1;
  const end = nodeEnd - (isTail ? 1 : 2);
  const rawText = raw.slice(1, isTail ? -1 : -2);
  return {
    start,
    end,
    text,
    cased,
    context,
    replaceable: (isHead || ts.isTemplateMiddle(node) || isTail) && rawText === text,
  };
}

function copyValueChanges(node, source, sf, context, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const change = stringChange(node, source, sf, context);
    if (change) out.push(change);
    return out;
  }
  if (ts.isTemplateExpression(node)) {
    const segments = [node.head, ...node.templateSpans.map((span) => span.literal)];
    segments.forEach((segment, index) => {
      const change = templateSegmentChange(segment, source, sf, context, index, segments.length);
      if (change) out.push(change);
    });
    for (const span of node.templateSpans) {
      if (!isPluralOrUnitExpression(span.expression)) {
        copyValueChanges(span.expression, source, sf, context, out);
      }
    }
    return out;
  }
  if (ts.isParenthesizedExpression(node)) {
    return copyValueChanges(node.expression, source, sf, context, out);
  }
  if (ts.isConditionalExpression(node)) {
    copyValueChanges(node.whenTrue, source, sf, context, out);
    copyValueChanges(node.whenFalse, source, sf, context, out);
    return out;
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    copyValueChanges(node.left, source, sf, context, out);
    copyValueChanges(node.right, source, sf, context, out);
  }
  return out;
}

/** Every literal JSX text node, with word-prefix/suffix guards. */
function jsxTextNodes(source, sf) {
  const out = [];

  const continuesAWord = (node) => {
    const parent = node.parent;
    if (!parent || !parent.children) return false;
    const index = parent.children.indexOf(node);
    return index > 0 && ts.isJsxExpression(parent.children[index - 1]);
  };

  const precedesAnExpression = (node) => {
    const parent = node.parent;
    if (!parent || !parent.children) return false;
    const index = parent.children.indexOf(node);
    return index >= 0 && index < parent.children.length - 1 &&
      ts.isJsxExpression(parent.children[index + 1]);
  };

  const visit = (node) => {
    if (ts.isJsxText(node) && !isInsideStyleOrScript(node, sf)) {
      const start = node.pos;
      const end = node.end;
      const text = source.slice(start, end);
      if (/[A-Za-z]/.test(text) && !isMachineString(text)) {
        out.push({
          start,
          end,
          text,
          suffix: /^[A-Za-z]/.test(text) && continuesAWord(node),
          prefix: /[A-Za-z]$/.test(text) && precedesAnExpression(node),
          context: 'JSX text',
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function staticCopyChanges(source, sf, file) {
  const changes = [];
  const seen = new Set();

  const add = (change) => {
    if (!change) return;
    const key = `${change.start}:${change.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    changes.push(change);
  };

  const visit = (node) => {
    if (
      COPY_REGISTRY_FILES.has(file.replace(ROOT, '')) &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.initializer === node
    ) {
      add(stringChange(node, source, sf, 'copy registry'));
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (UI_ATTRIBUTE_NAMES.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          add(stringChange(node.initializer, source, sf, `attribute ${name}`));
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          for (const change of copyValueChanges(
            node.initializer.expression,
            source,
            sf,
            `attribute ${name}`
          )) {
            add(change);
          }
        }
      }
    }

    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      !isInsideStyleOrScript(node, sf) &&
      !isPluralOrUnitExpression(node.expression)
    ) {
      for (const change of copyValueChanges(node.expression, source, sf, 'render expression')) {
        add(change);
      }
    }

    if (ts.isPropertyAssignment(node) && UI_PROPERTY_NAMES.has(propertyName(node.name))) {
      for (const change of copyValueChanges(
        node.initializer,
        source,
        sf,
        `property ${propertyName(node.name)}`
      )) {
        add(change);
      }
    }

    node.forEachChild(visit);
  };

  visit(sf);
  return changes;
}

/** Static copy that ships before React: metadata and the fatal boot fallback. */
function indexHtmlTextNodes(source) {
  const scannable = source.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
  const out = [];
  const addGroup = (match, group) => {
    if (!group || !/[A-Za-z]/.test(group) || isMachineString(group)) return;
    const withinMatch = match[0].indexOf(group);
    if (withinMatch < 0) return;
    out.push({
      start: match.index + withinMatch,
      end: match.index + withinMatch + group.length,
      text: group,
      cased: titleCaseText(group),
      context: 'index metadata',
    });
  };

  const metaCopy =
    /<meta\b[^>]*(?:name|property)="(?:description|og:title|og:description|twitter:title|twitter:description|apple-mobile-web-app-title)"[^>]*\bcontent="([^"]*)"[^>]*>/gi;
  for (const match of scannable.matchAll(metaCopy)) addGroup(match, match[1]);

  const staticElementCopy = /<(title|h1|p|button)\b[^>]*>([^<]*)<\/\1>/gi;
  for (const match of scannable.matchAll(staticElementCopy)) addGroup(match, match[2]);
  return out.filter((change) => change.cased !== change.text);
}

const offenders = [];
let fixedNodes = 0;
let fixedFiles = 0;

for (const file of walk(SRC)) {
  const original = readFileSync(file, 'utf8');
  let sf;
  try {
    sf = ts.createSourceFile(
      file,
      original,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
  } catch {
    continue;
  }

  const changes = [];
  if (file.endsWith('.tsx')) {
    for (const node of jsxTextNodes(original, sf)) {
      let cased;
      if (node.suffix) {
        const match = node.text.match(/^[A-Za-z][A-Za-z0-9'’]*/);
        const head = match ? match[0] : '';
        cased = head + titleCaseText(node.text.slice(head.length));
      } else {
        cased = titleCaseText(node.text);
      }
      if (node.prefix) {
        const match = node.text.match(/[A-Za-z][A-Za-z0-9'’]*$/);
        if (match) cased = cased.slice(0, cased.length - match[0].length) + match[0];
      }
      if (cased !== node.text) changes.push({ ...node, cased });
    }
  }
  changes.push(...staticCopyChanges(original, sf, file));

  const uniqueChanges = [
    ...new Map(changes.map((change) => [`${change.start}:${change.end}`, change])).values(),
  ].sort((a, b) => a.start - b.start);
  if (uniqueChanges.length === 0) continue;

  if (fix) {
    let out = original;
    let applied = 0;
    for (let index = uniqueChanges.length - 1; index >= 0; index--) {
      const change = uniqueChanges[index];
      if (change.replaceable === false) continue;
      out = out.slice(0, change.start) + change.cased + out.slice(change.end);
      applied++;
    }
    if (out !== original) {
      writeFileSync(file, out, 'utf8');
      fixedNodes += applied;
      fixedFiles++;
    }
  } else {
    for (const change of uniqueChanges) {
      const line = original.slice(0, change.start).split('\n').length;
      offenders.push(
        `${file.replace(ROOT, '')}:${line}: [${change.context}] ${change.text.trim().slice(0, 90)}`
      );
    }
  }
}

const indexFile = join(ROOT, 'index.html');
const indexOriginal = readFileSync(indexFile, 'utf8');
const indexChanges = indexHtmlTextNodes(indexOriginal);
if (indexChanges.length > 0) {
  if (fix) {
    let out = indexOriginal;
    for (let index = indexChanges.length - 1; index >= 0; index--) {
      const change = indexChanges[index];
      out = out.slice(0, change.start) + change.cased + out.slice(change.end);
    }
    writeFileSync(indexFile, out, 'utf8');
    fixedNodes += indexChanges.length;
    fixedFiles++;
  } else {
    for (const change of indexChanges) {
      const line = indexOriginal.slice(0, change.start).split('\n').length;
      offenders.push(`index.html:${line}: [${change.context}] ${change.text.trim().slice(0, 90)}`);
    }
  }
}

if (fix) {
  console.log(`check-title-case: fixed ${fixedNodes} copy node(s) across ${fixedFiles} file(s).`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error('\ncheck-title-case FAILED: page copy is not Title Cased.\n');
  console.error('The first letter of every word must be capitalized on every forward-facing page.');
  console.error('Run: node scripts/ci/check-title-case.mjs --fix\n');
  offenders.slice(0, 60).forEach((offender) => console.error('  ' + offender));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-title-case: OK - every static word on every page starts with a capital.');
