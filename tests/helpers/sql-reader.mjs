/**
 * Reading SQL and PL/pgSQL text the way PostgreSQL does, for checks that judge
 * migrations without a database: a lexer (comments, quoted strings and
 * identifiers, dollar quotes), argument lists, expression operands, and a
 * reader of PL/pgSQL bodies into blocks, IFs, CASEs, loops and statements.
 * It knows nothing about what a check is looking for; see
 * tests/helpers/operational-sender-addressing.mjs for its one user.
 */
import { createHash } from 'node:crypto';

// Every UTF-16 code unit from U+0080 up counts as an identifier character, as in
// scripts/ci/check-unqualified-writes.mjs. It is spelled as a negated ASCII class
// so this file carries no backslash-u escape: the publishing bridge rewrites some.
export const IDENT_START = /[A-Za-z_]|[^\x00-\x7f]/;
export const IDENT_PART = /[A-Za-z0-9_$]|[^\x00-\x7f]/;
export const DOLLAR_TAG = /\$(?:(?:[A-Za-z_]|[^\x00-\x7f])(?:[A-Za-z0-9_]|[^\x00-\x7f])*)?\$/y;

/**
 * The tokens of ONE lexical level of text[start,end): comments are skipped, a
 * quoted string or identifier is one token, and a dollar-quoted string is one
 * token ending at the first occurrence of its closing tag, as PostgreSQL reads
 * it. The SQL inside a dollar quote is lexed by the caller.
 */
export function lex(text, start = 0, end = text.length) {
  const tokens = [];
  const problems = [];
  const comments = [];
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      const n = text.indexOf('\n', i);
      const stop = n < 0 || n >= end ? end : n;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < end && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; } else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      if (depth > 0) problems.push({ at: i, end, what: 'an unterminated block comment' });
      comments.push({ start: i, end: Math.min(j, end) });
      i = Math.min(j, end);
      continue;
    }
    if (c === "'") {
      const prev = tokens[tokens.length - 1];
      const escapes = prev && prev.type === 'word' && prev.end === i && /^e$/i.test(prev.value);
      let j = i + 1;
      let closed = false;
      while (j < end) {
        if (escapes && text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") {
          if (text[j + 1] === "'" && j + 1 < end) { j += 2; continue; }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) problems.push({ at: i, end, what: 'an unterminated string' });
      tokens.push({ type: 'string', start: i, end: Math.min(j, end) });
      i = Math.min(j, end);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < end) {
        if (text[j] === '"') {
          if (text[j + 1] === '"' && j + 1 < end) { value += '"'; j += 2; continue; }
          j++;
          closed = true;
          break;
        }
        value += text[j++];
      }
      if (!closed) problems.push({ at: i, end, what: 'an unterminated quoted identifier' });
      tokens.push({ type: 'qident', value, start: i, end: Math.min(j, end) });
      i = Math.min(j, end);
      continue;
    }
    if (c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(text);
      if (m && i + m[0].length <= end) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        if (close < 0 || close + tag.length > end) {
          problems.push({ at: i, end, what: `an unterminated dollar quote ${tag}` });
          i = end;
          continue;
        }
        tokens.push({ type: 'dollar', tag, start: i, contentStart: i + tag.length, contentEnd: close, end: close + tag.length });
        i = close + tag.length;
        continue;
      }
      tokens.push({ type: 'punct', value: '$', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < end && IDENT_PART.test(text[j])) j++;
      tokens.push({ type: 'word', value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }
  return { tokens, problems, comments };
}

/** `text` with every comment blanked, at every nesting level, keeping offsets and line breaks. */
export function codeOnly(text) {
  const chars = text.split('');
  const level = (start, end) => {
    const { tokens, comments } = lex(text, start, end);
    for (const c of comments) for (let i = c.start; i < c.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
    for (const t of tokens) if (t.type === 'dollar') level(t.contentStart, t.contentEnd);
  };
  level(0, text.length);
  return chars.join('');
}


export const isWord = (t, w) => t !== undefined && t.type === 'word' && t.value.toLowerCase() === w;
export const isPunct = (t, p) => t !== undefined && t.type === 'punct' && t.value === p;
export const isName = (t) => t !== undefined && (t.type === 'word' || t.type === 'qident');
export const identName = (t) => (t.type === 'qident' ? t.value : t.value.toLowerCase());
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const short = (s) => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > 80 ? `${one.slice(0, 77)}...` : one; };
export const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
export const adjacent = (a, b) => a !== undefined && b !== undefined && a.end === b.start;

/** Tokens of a whole expression, or null when it does not lex cleanly. */
export function tokensOf(s) {
  const { tokens, problems } = lex(s);
  return problems.length ? null : tokens;
}

/** For every '(' and ')' in `t`, the index of its partner (-1 when unbalanced). One pass. */
export function partners(t) {
  const m = new Int32Array(t.length).fill(-1);
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    if (isPunct(t[i], '(')) stack.push(i);
    else if (isPunct(t[i], ')') && stack.length) { const o = stack.pop(); m[o] = i; m[i] = o; }
  }
  return m;
}

/** Index of the ')' that closes the '(' at tokens[open], or -1. */
export function matching(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) return i;
  }
  return -1;
}


export const MODES = new Set(['in', 'out', 'inout', 'variadic']);
export const TYPE_FIRST_WORDS = new Set(['double', 'character', 'char', 'national', 'bit', 'timestamp', 'time', 'interval']);
export const TYPE_ALIASES = new Map(Object.entries({
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
  float: 'double precision', float8: 'double precision', float4: 'real', decimal: 'numeric',
  varchar: 'character varying', char: 'character', bpchar: 'character',
  timestamptz: 'timestamp with time zone', 'timestamp without time zone': 'timestamp',
  timetz: 'time with time zone', 'time without time zone': 'time',
}));

/** One argument: { mode, name, type }, the type as PostgreSQL identifies the function by it. */
export function parameter(text, group) {
  let g = group;
  const cut = g.findIndex((t) => isWord(t, 'default') || isPunct(t, '='));
  if (cut >= 0) g = g.slice(0, cut);
  let mode = 'in';
  if (g.length > 1 && g[0].type === 'word' && MODES.has(g[0].value.toLowerCase())) {
    mode = g[0].value.toLowerCase();
    g = g.slice(1);
  }
  let name = null;
  if (g.length > 1 && isName(g[0]) && isName(g[1]) && !(g[0].type === 'word' && TYPE_FIRST_WORDS.has(g[0].value.toLowerCase()))) {
    name = identName(g[0]);
    g = g.slice(1);
  }
  if (g.length === 0) return { mode, name, type: null };
  let s = text.slice(g[0].start, g[g.length - 1].end).replace(/"/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\)/g, '').replace(/\s*\[\s*\d*\s*\]/g, '[]').replace(/^(?:pg_catalog|public)\s*\.\s*/, '');
  const array = /(?:\[\])+$/.exec(s)?.[0] ?? '';
  const base = s.slice(0, s.length - array.length).trim();
  return { mode, name, type: (TYPE_ALIASES.get(base) ?? base) + array };
}

/** The parameters of the list between tokens[open] '(' and tokens[close] ')'. */
export function parameters(text, t, open, close) {
  const out = [];
  let depth = 0;
  let from = open + 1;
  const flush = (to) => { if (to > from) out.push(parameter(text, t.slice(from, to))); };
  for (let i = open + 1; i < close; i++) {
    if (isPunct(t[i], '(') || isPunct(t[i], '[')) depth++;
    else if (isPunct(t[i], ')') || isPunct(t[i], ']')) depth--;
    else if (depth === 0 && isPunct(t[i], ',')) { flush(i); from = i + 1; }
  }
  flush(close);
  return out;
}


/** `schema.table`, unquoted and lower-cased unless quoted; `public` when unqualified. */
export function tableName(s) {
  const parts = s.trim().split(/\s*\.\s*/).map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
}

/** The top-level arguments of the call whose '(' is at `paren` in `text`, or null. Used for CHECKs and objects. */
export function callArguments(text, paren) {
  const { tokens } = lex(text, paren);
  if (!isPunct(tokens[0], '(')) return null;
  const close = matching(tokens, 0);
  return close < 0 ? null : argumentsBetween(text, tokens, 0, close);
}
export function argumentsBetween(text, t, open, close) {
  const args = [];
  let depth = 0;
  let from = t[open].end;
  for (let k = open + 1; k < close; k++) {
    if (isPunct(t[k], '(') || isPunct(t[k], '[')) depth++;
    else if (isPunct(t[k], ')') || isPunct(t[k], ']')) depth--;
    else if (depth === 0 && isPunct(t[k], ',')) { args.push(text.slice(from, t[k].start).trim()); from = t[k].end; }
  }
  args.push(text.slice(from, t[close].start).trim());
  return args;
}


/** `e` without redundant outer parentheses. */
export function unparen(s) {
  let e = s.trim();
  for (;;) {
    const t = tokensOf(e);
    if (t && t.length >= 2 && isPunct(t[0], '(') && matching(t, 0) === t.length - 1) { e = e.slice(t[0].end, t[t.length - 1].start).trim(); continue; }
    return e;
  }
}

/** The top-level comma-separated parts of `e`. */
export function splitTop(e) {
  const t = tokensOf(e);
  if (!t || !t.length) return [];
  const parts = [];
  let depth = 0;
  let from = 0;
  for (const x of t) {
    if (isPunct(x, '(') || isPunct(x, '[')) depth++;
    else if (isPunct(x, ')') || isPunct(x, ']')) depth--;
    else if (depth === 0 && isPunct(x, ',')) { parts.push(e.slice(from, x.start).trim()); from = x.end; }
  }
  parts.push(e.slice(from).trim());
  return parts;
}

/** `s` without redundant outer parentheses and trailing casts matching `casts`. */
export function strip(s, casts) {
  let e = s.trim();
  for (;;) {
    const c = casts.exec(e);
    if (c) { e = e.slice(0, c.index).trim(); continue; }
    const t = tokensOf(e);
    if (t && t.length >= 2 && isPunct(t[0], '(') && matching(t, 0) === t.length - 1) { e = e.slice(t[0].end, t[t.length - 1].start).trim(); continue; }
    return e;
  }
}

/** The operands of a top-level binary operator `op` ('||' or '-') in `e`, or [e]. */
export function operands(e, op) {
  const t = tokensOf(e);
  if (!t) return [e];
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < t.length; i++) {
    if (isPunct(t[i], '(') || isPunct(t[i], '[')) depth++;
    else if (isPunct(t[i], ')') || isPunct(t[i], ']')) depth--;
    else if (depth !== 0) continue;
    else if (op === '||' && isPunct(t[i], '|') && isPunct(t[i + 1], '|') && adjacent(t[i], t[i + 1])) { parts.push(e.slice(from, t[i].start).trim()); from = t[i + 1].end; i++; }
    else if (op === '-' && isPunct(t[i], '-') && i > 0 && !isPunct(t[i - 1], '#') && !(isPunct(t[i + 1], '>') && adjacent(t[i], t[i + 1])) && !(t[i - 1].type === 'punct' && !isPunct(t[i - 1], ')') && !isPunct(t[i - 1], ']'))) { parts.push(e.slice(from, t[i].start).trim()); from = t[i].end; }
  }
  parts.push(e.slice(from).trim());
  return parts;
}

export function stringLiteral(e) {
  const t = tokensOf(e);
  return t && t.length === 1 && t[0].type === 'string' && e[t[0].start] === "'" ? e.slice(t[0].start + 1, t[0].end - 1).replace(/''/g, "'") : null;
}

export const NOT_JSON = Symbol('not a JSON literal');
export function jsonLiteral(e) {
  const t = tokensOf(e);
  if (!t) return NOT_JSON;
  const s = t.length === 1 ? t[0] : t.length === 2 && t[0].type === 'word' && /^jsonb?$/i.test(t[0].value) ? t[1] : null;
  if (!s || s.type !== 'string' || e[s.start] !== "'") return NOT_JSON;
  try { return JSON.parse(e.slice(s.start + 1, s.end - 1).replace(/''/g, "'")); } catch { return NOT_JSON; }
}
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const NOT_VARIABLES = new Set(['null', 'true', 'false', 'default']);
export function identifier(e) {
  const t = tokensOf(e);
  if (!t || t.length !== 1) return null;
  if (t[0].type === 'qident') return t[0].value;
  return t[0].type === 'word' && !NOT_VARIABLES.has(t[0].value.toLowerCase()) ? t[0].value.toLowerCase() : null;
}

export function rowField(e) {
  const t = tokensOf(e);
  return t && t.length === 3 && isName(t[0]) && isPunct(t[1], '.') && isName(t[2]) ? { row: identName(t[0]), field: identName(t[2]) } : null;
}


export class Unreadable extends Error {}
export const TERMINATORS = new Set(['end', 'else', 'elsif', 'elseif', 'when', 'exception']);

export function parsePlpgsql(t) {
  let i = 0;
  const fail = (what) => { throw new Unreadable(`${what} near token ${i}${t[i] ? ` ('${t[i].value ?? t[i].type}')` : ''}`); };
  const semicolon = (from) => {
    let d = 0;
    for (let k = from; k < t.length; k++) {
      if (isPunct(t[k], '(') || isPunct(t[k], '[')) d++;
      else if (isPunct(t[k], ')') || isPunct(t[k], ']')) d--;
      else if (d <= 0 && isPunct(t[k], ';')) return k;
    }
    return fail('a statement without its semicolon');
  };
  const until = (from, words) => {
    let d = 0;
    let c = 0;
    for (let k = from; k < t.length; k++) {
      const x = t[k];
      if (isPunct(x, '(') || isPunct(x, '[')) d++;
      else if (isPunct(x, ')') || isPunct(x, ']')) d--;
      else if (d !== 0) continue;
      else if (isWord(x, 'case')) c++;
      else if (c > 0 && isWord(x, 'end')) c--;
      else if (c === 0 && x.type === 'word' && words.includes(x.value.toLowerCase())) return k;
      else if (isPunct(x, ';')) break;
    }
    return fail(`no ${words.join('/').toUpperCase()} where one was expected`);
  };
  const label = () => {
    if (isPunct(t[i], '<') && isPunct(t[i + 1], '<') && isName(t[i + 2]) && isPunct(t[i + 3], '>') && isPunct(t[i + 4], '>')) { const l = identName(t[i + 2]); i += 5; return l; }
    return null;
  };
  const endWith = (word) => {
    if (!isWord(t[i], 'end')) fail(`END ${word.toUpperCase()} expected`);
    i++;
    if (word && !isWord(t[i], word)) fail(`END ${word.toUpperCase()} expected`);
    if (word) i++;
    if (isName(t[i])) i++;
    if (i >= t.length) return;
    if (!isPunct(t[i], ';')) fail('a semicolon after END expected');
    i++;
  };
  function statements() {
    const out = [];
    while (i < t.length) {
      const x = t[i];
      if (x.type === 'word' && TERMINATORS.has(x.value.toLowerCase())) return out;
      if (isPunct(x, ';')) { i++; continue; }
      out.push(statement());
    }
    return out;
  }
  function block(lbl) {
    const decls = [];
    while (isWord(t[i], 'declare')) {
      i++;
      while (i < t.length && !isWord(t[i], 'begin')) {
        if (isWord(t[i], 'declare')) { i++; continue; }
        if (isPunct(t[i], '<')) { label(); continue; }
        const a = i;
        const b = semicolon(i);
        decls.push(declaration(a, b));
        i = b + 1;
      }
    }
    if (!isWord(t[i], 'begin')) fail('BEGIN expected');
    i++;
    const body = statements();
    const handlers = [];
    if (isWord(t[i], 'exception')) {
      i++;
      while (isWord(t[i], 'when')) {
        const a = i + 1;
        const b = until(a, ['then']);
        i = b + 1;
        handlers.push({ cond: [a, b], body: statements() });
      }
    }
    endWith(null);
    return { type: 'block', label: lbl, decls, body, handlers };
  }
  function declaration(a, b) {
    if (!isName(t[a])) fail('a declaration without a name');
    const name = identName(t[a]);
    let k = a + 1;
    const constant = isWord(t[k], 'constant');
    if (constant) k++;
    let init = null;
    let d = 0;
    let typeEnd = b;
    for (let q = k; q < b; q++) {
      if (isPunct(t[q], '(') || isPunct(t[q], '[')) d++;
      else if (isPunct(t[q], ')') || isPunct(t[q], ']')) d--;
      else if (d === 0 && (isWord(t[q], 'default') || (isPunct(t[q], ':') && isPunct(t[q + 1], '=') && adjacent(t[q], t[q + 1])) || isPunct(t[q], '='))) {
        typeEnd = q;
        init = [isPunct(t[q], ':') ? q + 2 : q + 1, b];
        break;
      }
    }
    const typeTokens = t.slice(k, typeEnd).filter((x) => !(isWord(x, 'not') || isWord(x, 'null') || isWord(x, 'collate')));
    const alias = isWord(t[k], 'alias') || isWord(t[k], 'cursor') || isWord(t[k + 1], 'cursor');
    let type = typeTokens.map((x) => (x.type === 'qident' ? x.value : x.value ?? '')).join(' ').replace(/\s*([.%])\s*/g, '$1').toLowerCase().trim();
    const rowtype = /^(.*)%rowtype$/.exec(type);
    type = TYPE_ALIASES.get(type) ?? type;
    return { name, type: alias ? null : type, rowtype: rowtype ? tableName(rowtype[1]) : null, init };
  }
  function statement() {
    const at = i;
    const lbl = label();
    const x = t[i];
    if (isWord(x, 'declare') || isWord(x, 'begin')) return block(lbl);
    if (isWord(x, 'if')) {
      const branches = [];
      let otherwise = null;
      i++;
      let a = i;
      let b = until(a, ['then']);
      i = b + 1;
      branches.push({ cond: [a, b], body: statements() });
      while (isWord(t[i], 'elsif') || isWord(t[i], 'elseif')) {
        a = i + 1;
        b = until(a, ['then']);
        i = b + 1;
        branches.push({ cond: [a, b], body: statements() });
      }
      if (isWord(t[i], 'else')) { i++; otherwise = statements(); }
      endWith('if');
      return { type: 'if', branches, otherwise };
    }
    if (isWord(x, 'case')) {
      i++;
      const selector = isWord(t[i], 'when') ? null : [i, (i = until(i, ['when']))];
      const branches = [];
      let otherwise = null;
      while (isWord(t[i], 'when')) {
        const a = i + 1;
        const b = until(a, ['then']);
        i = b + 1;
        branches.push({ cond: [a, b], body: statements() });
      }
      if (isWord(t[i], 'else')) { i++; otherwise = statements(); }
      endWith('case');
      return { type: 'case', selector, branches, otherwise };
    }
    if (isWord(x, 'loop') || isWord(x, 'while') || isWord(x, 'for') || isWord(x, 'foreach')) {
      const kind = x.value.toLowerCase();
      let header = null;
      const vars = [];
      let counter = false;
      if (kind !== 'loop') {
        const a = i + 1;
        const b = until(a, ['loop']);
        header = [a, b];
        if (kind !== 'while') {
          for (let q = a; q < b && !isWord(t[q], 'in') && !isWord(t[q], 'slice'); q++) if (isName(t[q])) vars.push(identName(t[q]));
          for (let q = a, d = 0; q < b; q++) {
            if (isPunct(t[q], '(')) d++; else if (isPunct(t[q], ')')) d--;
            else if (d === 0 && isPunct(t[q], '.') && isPunct(t[q + 1], '.') && adjacent(t[q], t[q + 1])) counter = true;
          }
        }
        i = b;
      }
      i++;
      const body = statements();
      endWith('loop');
      return { type: 'loop', kind, label: lbl, header, vars, counter, body };
    }
    if (lbl !== null) fail('a label on a statement that is not a block or loop');
    if (isWord(x, 'exit') || isWord(x, 'continue')) {
      i++;
      const target = isName(t[i]) && !isWord(t[i], 'when') ? identName(t[i++]) : null;
      let cond = null;
      if (isWord(t[i], 'when')) { const a = i + 1; i = semicolon(a); cond = [a, i]; }
      if (!isPunct(t[i], ';')) fail('a semicolon after EXIT/CONTINUE expected');
      i++;
      return { type: x.value.toLowerCase(), target, cond, range: [at, i - 1] };
    }
    const b = semicolon(i);
    const range = [i, b];
    i = b + 1;
    if (isWord(x, 'return')) return { type: 'simple', range, terminates: !(isWord(t[range[0] + 1], 'next') || isWord(t[range[0] + 1], 'query')) };
    if (isWord(x, 'raise')) {
      const level = t[range[0] + 1];
      const soft = level && level.type === 'word' && ['debug', 'log', 'info', 'notice', 'warning'].includes(level.value.toLowerCase());
      return { type: 'simple', range, terminates: !soft };
    }
    return { type: 'simple', range, terminates: false };
  }
  let top;
  const lbl = label();
  if (isWord(t[i], 'declare') || isWord(t[i], 'begin')) top = block(lbl);
  else fail('a PL/pgSQL body must start with DECLARE or BEGIN');
  while (isPunct(t[i], ';')) i++;
  if (i < t.length) fail('text after the final END');
  return top;
}

/** A SQL-language body: plain statements separated by semicolons. */
export function parseSql(t) {
  const body = [];
  for (let i = 0, d = 0, a = 0; i <= t.length; i++) {
    if (i < t.length && (isPunct(t[i], '(') || isPunct(t[i], '['))) d++;
    else if (i < t.length && (isPunct(t[i], ')') || isPunct(t[i], ']'))) d--;
    else if (i === t.length || (d === 0 && isPunct(t[i], ';'))) { if (i > a) body.push({ type: 'simple', range: [a, i], terminates: false }); a = i + 1; }
  }
  return { type: 'block', label: null, decls: [], body, handlers: [] };
}
