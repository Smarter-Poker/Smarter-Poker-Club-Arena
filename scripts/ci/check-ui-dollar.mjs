#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-ui-dollar - no dollar sign in anything a Club Arena user can read
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-09: "you are forbidden from using $ the dollar sign anywhere in
 * the club arena. it just needs to say 100 Chip Guarantee".
 *
 * The JSX display boundary (src/lib/arenaDisplay) already strips the character
 * at render time, and that is the safety net. It is not the rule. A net that
 * deletes the symbol turns "Cashout Paid You $120" into "Cashout Paid You 120"
 * and "Diamonds For $4.99" into "Diamonds For 4.99": the dollar is gone, but so
 * is the unit. The copy has to be written right at its source, in the words Dan
 * gave: chip amounts say Chips, a guarantee says "100 Chip Guarantee", and a
 * real-money price says "4.99 USD". This gate makes that mechanical, the same
 * way check-ui-text did for the em dash.
 *
 * WHY THIS READS THE SYNTAX TREE AND check-ui-text DOES NOT
 *
 * An em dash is never code, so check-ui-text can match the character. A dollar
 * sign is code all the time: every `${x}` interpolation, every regex anchor,
 * every '$1' back-reference. A character scan would either fail on every file or
 * need an allowlist so wide it stopped meaning anything. So this gate parses
 * each file with the TypeScript compiler and reads only the text that can
 * render: string literals, the static parts of template literals, JSX text and
 * JSX attribute strings. Interpolation syntax and regex literals are not text
 * and are never seen. Comments are not text either.
 *
 * Every spelling that renders as the sign counts: the character, its fullwidth
 * and small forms, `&#36;`, `&#x24;`, `&dollar;`, `\u0024` and `\x24`.
 *
 * In JSX, `<span>${money(x)}</span>` is a JSX text node holding "$" followed by
 * an expression: that "$" renders, and it is caught. In a template literal,
 * `$${amount}` has a static part ending in "$": also caught.
 *
 * WHAT IS ALLOWED, AND WHY EACH ONE IS NARROW
 *   1. A "$" escaped by a backslash (`'\\$'`): regex source, never copy.
 *   2. The source of a regex: any argument of `RegExp(...)`, or the pattern
 *      (first) argument of `.replace` / `.replaceAll`.
 *   3. A replacement that holds only back-references ('$1', '$&', '$<name>'):
 *      the second argument of `.replace` / `.replaceAll`, or the string in a
 *      two-element `[/regex/, '...']` replacement table. `'$' + n` there is
 *      still a price on a screen and still fails.
 *   4. Text inside console.* / logger.* / reportError(...): logs are read by
 *      operators in a terminal, never on a Club Arena screen.
 *   5. A positional SQL parameter (`$1`, `$2::jsonb`) inside a string that is
 *      SQL (an uppercase SELECT / FROM / INSERT / UPDATE / WHERE keyword).
 *   6. A JSONPath: the string begins "$." or "$[", or is a lone "$" root in a
 *      file that uses JSONPath, or the default of a parameter named for a path.
 *   7. Anything inside a type annotation: types never render.
 *   8. One file, named in SKIP_FILES below with its reason. Nothing else
 *      belongs on that list.
 *
 * WHAT IT READS (2026-10-11): src/, server/src, public/, .github/scripts (the
 * estate digest posts its lines into the owner's Club Arena notifications),
 * and migration SQL from SQL_SINCE on (see scanSql).
 *
 * Test files are skipped for the reason check-ui-text gives: a test can only
 * ASSERT a string, and the string is checked at its source.
 *
 * Run:  node scripts/ci/check-ui-dollar.mjs
 *       UI_DOLLAR_SOURCE_DIR=<dir> node scripts/ci/check-ui-dollar.mjs
 *         (scans only <dir>; this is how the law test proves the gate bites)
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;
const SOURCE_OVERRIDE = process.env.UI_DOLLAR_SOURCE_DIR
  ? resolve(process.env.UI_DOLLAR_SOURCE_DIR)
  : null;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const HTML_FILES = ['index.html', 'public/offline.html'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '_to_delete',
  '__tests__',
  'test-results',
  'tests',
  'e2e',
  'testHelpers',
]);
/**
 * src/utils/pokerStarsExport.ts writes the PokerStars hand-history grammar that
 * Hold'em Manager and PokerTracker import. That file is downloaded and read by
 * a tracker, never rendered on a Club Arena screen, and the grammar marks every
 * cash amount with its currency symbol (tests/unit/handSearchAndExport.test.ts
 * pins "No money may be written as a bare number on an action line"). Taking
 * the symbol out would make every exported cash hand unreadable to the tool it
 * is exported for.
 */
const SKIP_FILES = new Set(['src/utils/pokerStarsExport.ts']);
const IS_TEST_FILE = (rel) =>
  /(^|\/)(tests?|e2e|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

function walk(dir, exts, acc = [], deep = true) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (deep) walk(full, exts, acc, deep);
    } else if (exts.has(extname(entry)) && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

const LOG_CALLEE = /^(?:console|logger|this\.logger|log)(?:\.|$)|(?:^|\.)reportError$/;
const SQL_TEXT = /\b(?:SELECT|FROM|INSERT INTO|UPDATE|WHERE|RETURNING)\b/;

function calleeText(call, sf) {
  const text = call.expression.getText(sf).replace(/\s+/g, '');
  return ts.isNewExpression(call) ? `new ${text}` : text;
}

/** Every spelling of the sign that renders as one, folded to "$". */
const DOLLARISH = /\$|&#0*36;|&#x0*24;|&dollar;|\\u0024|\\u\{0*24\}|\\x24|\uFF04|\uFE69/i;
const DOLLARISH_GLOBAL = new RegExp(DOLLARISH.source, 'gi');
const fold = (text) => text.replace(DOLLARISH_GLOBAL, '$$');
/** What is left once the back-references a replacement may hold are removed. */
const withoutBackReferences = (text) => text.replace(/\$(?:\d+|[&`'$]|<\w+>)/g, '');

/** Why this literal may hold a "$", or null when it may not. */
function allowance(node, raw, sf) {
  const text = fold(raw);
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return 'type';
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const callee = calleeText(p, sf);
      if (LOG_CALLEE.test(callee)) return 'log';
      // The literal must be an ARGUMENT of the machine call, not its receiver:
      // `'Pay $5'.replace(...)` is still copy.
      const args = p.arguments ?? [];
      const at = args.findIndex((a) => a.pos <= node.pos && node.end <= a.end);
      const name = callee.replace(/^new /, '');
      if (at >= 0 && /^RegExp$/.test(name)) return 'regex-source';
      if (at === 0 && /(?:^|\.)(?:replace|replaceAll)$/.test(name)) return 'regex-source';
      // A replacement argument may hold back-references and nothing else:
      // `.replace(x, '$' + n)` is still a price on a screen.
      const isReplace = /(?:^|\.)(?:replace|replaceAll)$/.test(name);
      if (at === 1 && isReplace && !withoutBackReferences(text).includes('$')) {
        return 'back-reference';
      }
    }
    if (
      ts.isArrayLiteralExpression(p) &&
      p.elements.length === 2 &&
      ts.isRegularExpressionLiteral(p.elements[0]) &&
      p.elements[1].pos <= node.pos &&
      node.end <= p.elements[1].end &&
      !withoutBackReferences(text).includes('$')
    ) {
      return 'replacement-table';
    }
    if (ts.isBlock(p) || ts.isSourceFile(p)) break;
  }
  if (/^\$[.[]/.test(text)) return 'jsonpath';
  // A lone "$" is a JSONPath root only beside real JSONPath ("$.schema") in the
  // same file, or as the default of a parameter named for a path. A lone "$"
  // anywhere else (`currency = '$'`) is a currency symbol and fails.
  if (text === '$') {
    const p = node.parent;
    if (ts.isParameter(p) && /path/i.test(p.name.getText(sf))) return 'jsonpath';
    if (/(['"`])\$[.[]/.test(sf.text)) return 'jsonpath';
  }
  let rest = text.replace(/\\\$/g, '');
  if (SQL_TEXT.test(text)) rest = rest.replace(/\$\d+/g, '');
  return rest.includes('$') ? null : 'escaped-or-sql';
}

/** Every rendered "$" in one code file, as `rel:line: text`. */
export function scanCode(rel, source) {
  const out = [];
  if (!DOLLARISH.test(source)) return out;
  const ext = extname(rel);
  const kind =
    ext === '.tsx' || ext === '.jsx'
      ? ts.ScriptKind.TSX
      : ext === '.ts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  const visit = (n) => {
    let text = null;
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      // Raw text, so an escaped "\$" stays visibly escaped for rule 1.
      text = ts.isStringLiteral(n) ? n.getText(sf).slice(1, -1) : (n.rawText ?? n.text);
    } else if (ts.isJsxText(n)) {
      text = n.getText(sf);
    }
    if (text !== null && DOLLARISH.test(text) && !allowance(n, text, sf)) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      out.push(`${rel}:${line + 1}: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * SQL: the copy a database function writes. A jackpot notice, a search label
 * and a new club's first schedule name were all built in PL/pgSQL with a "$"
 * in them (fixed by the_jackpot_notice_and_search_show_no_dollar), and none of
 * them was ever seen by a gate that only read src/ and server/src. So the gate
 * reads migration SQL too: every migration from SQL_SINCE on (older ones are
 * history; what they defined was read on the live catalog and fixed by that
 * migration), and every .sql file in an override directory.
 *
 * It reads the single-quoted string literals inside the code, and nothing else:
 * comments are skipped, a dollar-quoted block opened by AS or DO is a function
 * body and is read as code, and any other dollar-quoted block is an opaque
 * string (a patch anchor quoting the old text) and is not read at all.
 *
 * WHAT IS ALLOWED IN A SQL LITERAL, AND WHY
 *   1. The argument of a matching call (replace, regexp_*, position, strpos,
 *      split_part, translate, jsonb_path_*), or the right side of LIKE, ILIKE,
 *      SIMILAR TO or "~": a pattern, never copy. And the argument of
 *      fn_ca_text_without_dollar: the old text it is proved to rewrite.
 *   1b. The text of COMMENT ON ... IS: catalog notes, never on a screen.
 *   1c. A literal quoting code, which holds a dollar-quote tag ($fn$, $$): a
 *      patch anchor, not copy.
 *   2. A positional parameter ($1, $2::uuid) in dynamic SQL: preceded by an
 *      operator, a comma, a parenthesis or a SQL keyword, or followed by "::".
 *   3. A format() argument position (%1$s), a JSONPath root ("$.", "$[",
 *      "strict $", "lax $") and the server's "$libdir".
 *   4. A regex end anchor: a trailing "$" that is not then joined to more text
 *      (followed by "||" or ",").
 *   5. A backslash-escaped "\$".
 * A literal that quotes its own literals (dynamic SQL) is read as SQL itself.
 */
const SQL_SINCE = '20261011200429';
const SQL_MATCH_CALLS =
  /^(?:fn_ca_text_without_dollar|replace|regexp_replace|regexp_match|regexp_matches|regexp_like|regexp_count|regexp_substr|regexp_instr|regexp_split_to_array|regexp_split_to_table|position|strpos|split_part|translate|jsonb_path_query|jsonb_path_query_array|jsonb_path_query_first|jsonb_path_exists|jsonb_path_match)$/i;
const SQL_PARAM_BEFORE =
  /(?:[=<>(,+\-*/]|\b(?:select|between|and|or|limit|offset|in|then|when|values|is|from|return|returning|using|else|not|like|ilike|set|by|any|all|array)\b)\s*$/i;

/** Why this SQL literal may hold a "$", or null when it may not. */
function sqlAllowance(value, before, after, callee) {
  let rest = fold(value).replace(/\\\$/g, '');
  if (!rest.includes('$')) return 'escaped';
  if (SQL_MATCH_CALLS.test(callee)) return 'pattern';
  if (/(?:\b(?:like|ilike)|\bsimilar\s+to|!?~~?\*?)\s*$/i.test(before)) return 'pattern';
  if (/\bCOMMENT\s+ON\b[^;]*\bIS\s*$/i.test(before)) return 'catalog-comment';
  rest = rest
    .replace(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g, '')
    .replace(/%\d+\$/g, '%')
    .replace(/\$libdir\b/g, '')
    .replace(/^\s*(?:(?:strict|lax)\s+)?\$(?=[.[])/i, '')
    .replace(/\$\d+/g, (m, off, s) =>
      SQL_PARAM_BEFORE.test(s.slice(0, off)) || s.slice(off + m.length).startsWith('::') ? '' : m
    );
  if (rest.endsWith('$') && !/^\s*(?:\|\||,)/.test(after) && !/^(?:concat|concat_ws|format)$/i.test(callee)) {
    rest = rest.slice(0, -1);
  }
  return rest.includes('$') ? null : 'sql-machinery';
}

/** Every "$" in the copy one SQL file writes, as `rel:line: text`. */
export function scanSql(rel, source, firstLine = 1) {
  const out = [];
  if (!DOLLARISH.test(source)) return out;
  const n = source.length;
  const calls = [];
  const codeTags = [];
  let code = '';
  let line = firstLine;
  let i = 0;
  const keep = (s) => {
    code = (code + s).slice(-300);
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      line++;
      keep(ch);
      i++;
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          if (source[i] === '\n') line++;
          i++;
        }
      }
      keep(' ');
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i, i + 64));
      if (tag) {
        const t = tag[0];
        if (codeTags.length && codeTags[codeTags.length - 1] === t) {
          codeTags.pop();
          keep(' ');
          i += t.length;
          continue;
        }
        if (/\b(?:AS|DO)\s*$/i.test(code)) {
          codeTags.push(t);
          keep(' ');
          i += t.length;
          continue;
        }
        const close = source.indexOf(t, i + t.length);
        const end = close < 0 ? n : close + t.length;
        for (let k = i; k < end; k++) if (source[k] === '\n') line++;
        keep(' __lit__ ');
        i = end;
        continue;
      }
    }
    if (ch === '(') {
      const m = /([A-Za-z_][A-Za-z0-9_.]*)\s*$/.exec(code);
      calls.push(m ? m[1].split('.').pop().toLowerCase() : '');
      keep(ch);
      i++;
      continue;
    }
    if (ch === ')') {
      calls.pop();
      keep(ch);
      i++;
      continue;
    }
    if (ch === "'") {
      const startLine = line;
      const before = code;
      const escapes = /(?:^|[^A-Za-z0-9_])[eE]$/.test(code);
      let j = i + 1;
      let value = '';
      while (j < n) {
        const c = source[j];
        if (escapes && c === '\\') {
          value += c + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === "'") {
          if (source[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        if (c === '\n') line++;
        value += c;
        j++;
      }
      i = j + 1;
      if (!DOLLARISH.test(value)) {
        // nothing to read
      } else if (value.includes("'")) {
        // Dynamic SQL quoting its own literals: read it as SQL, one level in.
        out.push(...scanSql(rel, value, startLine));
      } else if (!sqlAllowance(value, before, source.slice(i, i + 16), calls[calls.length - 1] ?? '')) {
        out.push(`${rel}:${startLine}: ${value.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
      }
      keep(' __lit__ ');
      continue;
    }
    keep(ch);
    i++;
  }
  return out;
}

/** HTML: visible text and attribute values outside comments and scripts. */
export function scanHtml(rel, source) {
  const out = [];
  const visible = source
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '));
  visible.split('\n').forEach((line, i) => {
    if (DOLLARISH.test(line)) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return out;
}

/** CSS: a generated `content:` value is text on screen. */
export function scanCss(rel, source) {
  const out = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  code.split('\n').forEach((line, i) => {
    if (/content\s*:[^;]*(?:\$|\\0{0,4}24(?![0-9a-fA-F]))/.test(line)) {
      out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
  return out;
}

/** The trees read when no override is given, relative to the repo root. */
export function sourceRoots() {
  return ['src', 'server/src', '.github/scripts'];
}

export { SQL_SINCE };

function main() {
  const base = SOURCE_OVERRIDE ?? ROOT;
  const roots = SOURCE_OVERRIDE ? [SOURCE_OVERRIDE] : sourceRoots().map((r) => join(ROOT, r));
  const codeFiles = roots.flatMap((r) => walk(r, CODE_EXTS));
  if (!SOURCE_OVERRIDE) codeFiles.push(...walk(join(ROOT, 'public'), CODE_EXTS, [], false));
  const cssFiles = roots.flatMap((r) => walk(r, new Set(['.css'])));
  const sqlFiles = SOURCE_OVERRIDE
    ? walk(SOURCE_OVERRIDE, new Set(['.sql']))
    : walk(join(ROOT, 'supabase/migrations'), new Set(['.sql']), [], false).filter((f) => {
        const version = /(\d{14})_[^/]*\.sql$/.exec(f)?.[1];
        return version !== undefined && version >= SQL_SINCE;
      });
  const htmlFiles = SOURCE_OVERRIDE
    ? walk(SOURCE_OVERRIDE, new Set(['.html']))
    : HTML_FILES.map((f) => join(ROOT, f)).filter(existsSync);

  const offenders = [];
  const relOf = (f) => (f.startsWith(base) ? f.slice(base.length).replace(/^\//, '') : f);
  for (const f of codeFiles) {
    const rel = relOf(f);
    if (IS_TEST_FILE(rel) || (!SOURCE_OVERRIDE && SKIP_FILES.has(rel))) continue;
    offenders.push(...scanCode(rel, readFileSync(f, 'utf8')));
  }
  for (const f of cssFiles) offenders.push(...scanCss(relOf(f), readFileSync(f, 'utf8')));
  for (const f of htmlFiles) offenders.push(...scanHtml(relOf(f), readFileSync(f, 'utf8')));
  for (const f of sqlFiles) offenders.push(...scanSql(relOf(f), readFileSync(f, 'utf8')));

  if (offenders.length > 0) {
    console.error('\ncheck-ui-dollar FAILED: a dollar sign in user-facing text.\n');
    console.error(
      'Dan 2026-10-09: "you are forbidden from using $ the dollar sign anywhere in the club arena."'
    );
    console.error(
      'Chips: "120 Chips". Guarantees: "100 Chip Guarantee". Real-money prices: "4.99 USD".\n'
    );
    offenders.slice(0, 80).forEach((o) => console.error('  ' + o));
    if (offenders.length > 80) console.error(`  ... and ${offenders.length - 80} more`);
    console.error('');
    process.exit(1);
  }
  console.log(
    `check-ui-dollar: OK - no dollar sign in UI text (${codeFiles.length + cssFiles.length + htmlFiles.length + sqlFiles.length} files).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
