/**
 * ===========================================================================
 *  LAW - THE OWNER CLASSIFIER KEEPS ITS OPERATIONAL KINDS, FOR THE OWNER ONLY
 * ===========================================================================
 *
 * public.fn_is_owner_operational_notification answers "is this notification to
 * the owner account operational" for every layer of store-only delivery
 * (20260927235053): the capture that files such a row with the Production
 * Alerts task instead of his inbox, the authority trigger, the push mirror's
 * WHEN and the detector. 20260928171444 taught it two notices that were
 * reaching his inbox and his phone: smarter-poker-workers' weekly
 * auto-settlement problem notices and World Hub push-health's 'Push
 * Notifications Are Off'.
 *
 * A later CREATE OR REPLACE written from an older copy of the function - the
 * 20260916111614 text is the one every earlier migration quotes - would send
 * them back to his phone, and nothing else would notice: the probe that proves
 * 20260928171444 runs only when its own paths change, and production accepts
 * any definition.
 *
 * THE RULE, on the newest definition in supabase/migrations - the one a fresh
 * database and production run - found when its text is written out: any case,
 * quoted or not, at the top level, in a DO block or in an EXECUTE string, and
 * never in a comment. A definition assembled at run time (EXECUTE of a
 * replace() over pg_get_functiondef, or of a format() that injects the name)
 * is not seen; such a migration must carry its own proof:
 *   - its whole answer is COALESCE(p_user = <the owner account> AND (...),
 *     false), so it is owner-only whatever the clauses inside say;
 *   - it still classifies engine_break_recovered, a kind from before;
 *   - under type 'system', the title ASCII case and whitespace folded
 *     (translate, regexp_replace, btrim) equal to 'push notifications are off';
 *   - under type 'settlement', the folded title one of the three problem
 *     titles, or the route's marker: component 'workers.auto-settlement' and
 *     one of its three alertnames;
 *   - no plain '...' literal in its body holds a backslash: the body is lexed
 *     in the caller's session, and one with standard_conforming_strings off
 *     reads such a literal differently (an E'...' literal reads the same);
 *   - no later migration drops or renames it.
 * A redefinition that keeps the meaning in another shape fails here as well.
 * Then this law changes beside it, in the same pull request, where a reviewer
 * reads both.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus, type MigrationFile } from './helpers/migrationCorpus';

const OWNER = '47965354-0e56-43ef-931c-ddaab82af765';
const NAME = 'fn_is_owner_operational_notification';
const BACKSLASH = '\\';
const PROBLEM_TITLES = [
  'weekly player p&l needs review',
  'weekly player p&l failed',
  'union rule violation detected',
];
const PROBLEM_ALERTNAMES = [
  'UnionPlayerPnlNeedsReview',
  'UnionPlayerPnlFailed',
  'UnionRuleViolation',
];
/** The ASCII case and whitespace fold of p_title, token by token. */
const FOLD = [
  'btrim',
  '(',
  'regexp_replace',
  '(',
  'translate',
  '(',
  'p_title',
  ',',
  "'ABCDEFGHIJKLMNOPQRSTUVWXYZ'",
  ',',
  "'abcdefghijklmnopqrstuvwxyz'",
  ')',
  ',',
  `'[${['t', 'n', 'v', 'f', 'r'].map((c) => BACKSLASH + c).join('')} ]+'`,
  ',',
  "' '",
  ',',
  "'g'",
  ')',
  ',',
  "' '",
  ')',
];

// -- a SQL reader: enough of PostgreSQL's lexer to tell code from comments ----
type Str = { k: 'str'; v: string; at: number; form: 'plain' | 'escape' | 'dollar'; raw: string };
type Tok =
  | { k: 'word'; v: string; at: number } // unquoted identifier or keyword, lower-cased
  | { k: 'ident'; v: string; at: number } // "quoted" identifier, as written
  | Str // '...', E'...' or $tag$...$tag$, by its value
  | { k: 'sym'; v: string; at: number }; // number, operator or punctuation

const OPERATOR = '+-*/<>=~!@#%^&|`?';
const identStart = (c: string | undefined) => !!c && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127);
const identChar = (c: string | undefined) =>
  !!c && (/[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127);

/** A sticky pattern matched exactly at `index`, or null. */
const matchAt = (pattern: RegExp, text: string, index: number) => {
  pattern.lastIndex = index;
  return pattern.exec(text);
};
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
const OCTAL = /[0-7]{1,3}/y;
const HEX = /[0-9A-Fa-f]{1,2}/y;

/** A quoted literal from its opening quote: its value, and the index after it. */
function quoted(sql: string, open: number, escapes: boolean): { value: string; end: number } {
  let value = '';
  let j = open + 1;
  while (j < sql.length) {
    const c = sql[j]!;
    if (c === "'") {
      if (sql[j + 1] === "'") {
        value += "'";
        j += 2;
        continue;
      }
      return { value, end: j + 1 };
    }
    if (escapes && c === BACKSLASH && j + 1 < sql.length) {
      const e = sql[j + 1]!;
      const named: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      const octal = matchAt(OCTAL, sql, j + 1);
      const hex = e === 'x' ? matchAt(HEX, sql, j + 2) : null;
      if (named[e] !== undefined) {
        value += named[e];
        j += 2;
      } else if (octal) {
        value += String.fromCharCode(parseInt(octal[0], 8));
        j += 1 + octal[0].length;
      } else if (hex) {
        value += String.fromCharCode(parseInt(hex[0], 16));
        j += 2 + hex[0].length;
      } else {
        value += e; // any other escaped character is itself: a quote, a backslash, a v
        j += 2;
      }
      continue;
    }
    value += c;
    j += 1;
  }
  return { value, end: sql.length };
}

/** The tokens of `sql`, comments (nested block comments included) dropped. */
function lex(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol < 0 ? sql.length : eol + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
    } else if ((c === 'e' || c === 'E') && next === "'" && !identChar(sql[i - 1])) {
      const { value, end } = quoted(sql, i + 1, true);
      out.push({ k: 'str', v: value, at: i, form: 'escape', raw: sql.slice(i, end) });
      i = end;
    } else if (c === "'") {
      const { value, end } = quoted(sql, i, false);
      out.push({ k: 'str', v: value, at: i, form: 'plain', raw: sql.slice(i, end) });
      i = end;
    } else if (c === '$' && matchAt(DOLLAR_TAG, sql, i)) {
      const tag = matchAt(DOLLAR_TAG, sql, i)![0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close < 0 ? sql.length : close + tag.length;
      const value = sql.slice(i + tag.length, close < 0 ? sql.length : close);
      out.push({ k: 'str', v: value, at: i, form: 'dollar', raw: sql.slice(i, end) });
      i = end;
    } else if (c === '"') {
      let value = '';
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (sql[j] === '"') {
          j += 1;
          break;
        } else {
          value += sql[j];
          j += 1;
        }
      }
      out.push({ k: 'ident', v: value, at: i });
      i = j;
    } else if (identStart(c)) {
      let j = i + 1;
      while (identChar(sql[j])) j += 1;
      out.push({ k: 'word', v: sql.slice(i, j).toLowerCase(), at: i });
      i = j;
    } else if (/[0-9$]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9.]/.test(sql[j]!)) j += 1;
      out.push({ k: 'sym', v: sql.slice(i, j), at: i });
      i = j;
    } else if (c === ':' && next === ':') {
      out.push({ k: 'sym', v: '::', at: i });
      i += 2;
    } else if (OPERATOR.includes(c)) {
      let j = i + 1;
      while (
        j < sql.length &&
        OPERATOR.includes(sql[j]!) &&
        !(sql[j] === '-' && sql[j + 1] === '-') &&
        !(sql[j] === '/' && sql[j + 1] === '*')
      )
        j += 1;
      out.push({ k: 'sym', v: sql.slice(i, j), at: i });
      i = j;
    } else {
      out.push({ k: 'sym', v: c, at: i });
      i += 1;
    }
  }
  return out;
}

/** One token as SQL means it: keywords lower-cased, literals by their value. */
const render = (t: Tok): string => {
  if (t.k === 'str') return `'${t.v.replace(/'/g, "''")}'`;
  if (t.k === 'ident') return /^[a-z_][a-z0-9_$]*$/.test(t.v) ? t.v : `"${t.v}"`;
  return t.v;
};
const isWord = (t: Tok | undefined, v: string) => t?.k === 'word' && t.v === v;
const isSym = (t: Tok | undefined, v: string) => t?.k === 'sym' && t.v === v;
const isName = (t: Tok | undefined, v: string) =>
  (t?.k === 'word' || t?.k === 'ident') && t.v === v;

/** public.<NAME> or a bare <NAME> at toks[i]: the index after it, or -1. */
function nameAt(toks: Tok[], i: number): number {
  if (isName(toks[i], 'public') && isSym(toks[i + 1], '.') && isName(toks[i + 2], NAME))
    return i + 3;
  if (isName(toks[i], NAME) && !isSym(toks[i + 1], '.') && !isSym(toks[i - 1], '.')) return i + 1;
  return -1;
}

/** The index of the ')' closing the '(' at toks[open], or -1. */
function closing(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i += 1) {
    if (isSym(toks[i], '(')) depth += 1;
    else if (isSym(toks[i], ')') && --depth === 0) return i;
  }
  return -1;
}

const seqAt = (toks: Tok[], k: number, needle: string[]) =>
  needle.every((n, j) => toks[k + j] !== undefined && render(toks[k + j]!) === n);
const findAll = (toks: Tok[], needle: string[]) =>
  toks.map((_, k) => k).filter((k) => seqAt(toks, k, needle));

/** The tokens inside the parentheses that `needle` (ending in '(') opens. */
function group(toks: Tok[], needle: string[]): Tok[] | null {
  const k = findAll(toks, needle)[0];
  if (k === undefined) return null;
  const open = k + needle.length - 1;
  const close = closing(toks, open);
  return close < 0 ? null : toks.slice(open + 1, close);
}

/** The string values of the list `needle` (ending in 'in', '(') opens. */
const listAfter = (toks: Tok[], needle: string[]): string[] =>
  (group(toks, needle) ?? []).filter((t): t is Str => t.k === 'str').map((t) => t.v);

/** The folded title is compared with each of `values`: = one, or IN a list of them all. */
function foldedTo(toks: Tok[], values: string[]): boolean {
  return findAll(toks, FOLD).some((k) => {
    const after = k + FOLD.length;
    const eq = toks[after + 1];
    if (values.length === 1 && isSym(toks[after], '=') && eq?.k === 'str' && eq.v === values[0])
      return true;
    const listed = isWord(toks[after], 'in') ? listAfter(toks.slice(after), ['in', '(']) : [];
    return values.every((v) => listed.includes(v));
  });
}

// -- where the classifier is defined, dropped or renamed ----------------------
interface Site {
  file: string;
  /** Text order: the file's place in version order, then offsets, outermost first. */
  order: number[];
  toks: Tok[];
  at: number;
}

const before = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
};

/**
 * Every definition, drop and rename of the classifier in `files`, in version
 * order. Every string is read again as SQL (a dollar-quoted body, a DO block,
 * an EXECUTE string), so a definition is found wherever it would run.
 */
function survey(files: MigrationFile[]): { definitions: Site[]; removals: Site[] } {
  const definitions: Site[] = [];
  const removals: Site[] = [];
  const read = (file: string, sql: string, order: number[], depth: number) => {
    const toks = lex(sql);
    for (let i = 0; i < toks.length; i += 1) {
      const site = { file, order: [...order, toks[i]!.at], toks, at: i };
      if (isWord(toks[i], 'create')) {
        const f = isWord(toks[i + 1], 'or') && isWord(toks[i + 2], 'replace') ? i + 3 : i + 1;
        const after = isWord(toks[f], 'function') ? nameAt(toks, f + 1) : -1;
        if (after > 0 && isSym(toks[after], '(')) definitions.push(site);
      } else if (
        (isWord(toks[i], 'drop') || isWord(toks[i], 'alter')) &&
        (isWord(toks[i + 1], 'function') || isWord(toks[i + 1], 'routine'))
      ) {
        let end = i + 2;
        while (end < toks.length && !isSym(toks[end], ';')) end += 1;
        const names = toks.slice(i + 2, end).some((_, j) => nameAt(toks, i + 2 + j) > 0);
        const renames = toks.slice(i + 2, end).some((t) => isWord(t, 'rename'));
        if (isWord(toks[i], 'drop') ? names : renames && names) removals.push(site);
      }
    }
    if (depth < 6)
      for (const t of toks) if (t.k === 'str') read(file, t.v, [...order, t.at], depth + 1);
  };
  files.forEach((m, index) => {
    if (m.sql.toLowerCase().includes(NAME)) read(m.name, m.sql, [index], 0);
  });
  const byOrder = (a: Site, b: Site) => (before(a.order, b.order) ? -1 : 1);
  return { definitions: definitions.sort(byOrder), removals: removals.sort(byOrder) };
}

/** The body a definition installs, as tokens: AS '...', AS $$...$$, RETURN or BEGIN ATOMIC. */
function bodyOf(def: Site): Tok[] {
  const { toks } = def;
  let i = def.at;
  while (i < toks.length && !isSym(toks[i], '(')) i += 1;
  i = closing(toks, i);
  if (i < 0) throw new Error('its parameter list does not close');
  let body: Tok[] | null = null;
  for (i += 1; i < toks.length && !isSym(toks[i], ';') && body === null; i += 1) {
    const t = toks[i]!;
    const next = toks[i + 1];
    if (isWord(t, 'as') && next?.k === 'str') body = lex(next.v);
    else if (isWord(t, 'return')) {
      let j = i + 1;
      for (let depth = 0; j < toks.length && !(depth === 0 && isSym(toks[j], ';')); j += 1)
        depth += isSym(toks[j], '(') ? 1 : isSym(toks[j], ')') ? -1 : 0;
      body = toks.slice(i, j);
    } else if (isWord(t, 'begin') && isWord(next, 'atomic')) {
      let j = i + 2;
      for (let depth = 1; j < toks.length; j += 1) {
        depth += isWord(toks[j], 'case') ? 1 : isWord(toks[j], 'end') ? -1 : 0;
        if (depth === 0) break;
      }
      body = toks.slice(i + 2, j);
    }
  }
  if (body === null)
    throw new Error('it has no body this law can read (AS, RETURN or BEGIN ATOMIC)');
  while (body.length > 0 && isSym(body[body.length - 1], ';')) body = body.slice(0, -1);
  if (isWord(body[0], 'return'))
    body = [{ k: 'word', v: 'select', at: body[0]!.at }, ...body.slice(1)];
  return body;
}

/** What the rule finds wrong with a definition; [] when it keeps every kind, owner-only. */
function violations(def: Site): string[] {
  let body: Tok[];
  try {
    body = bodyOf(def);
  } catch (err) {
    return [`${def.file}: ${(err as Error).message}`];
  }
  const out: string[] = [];
  for (const t of body)
    if (t.k === 'str' && t.form === 'plain' && t.raw.includes(BACKSLASH))
      out.push(
        `the literal ${t.raw} holds a backslash, which a caller with standard_conforming_strings off reads differently: write it E'...'`
      );
  const head = ['select', 'coalesce', '(', 'p_user', '=', `'${OWNER}'`, '::', 'uuid', 'and', '('];
  const gate = head.length - 1;
  if (!seqAt(body, 0, head)) return [...out, `its answer does not begin ${head.join(' ')}`];
  const inner = closing(body, gate);
  if (
    inner < 0 ||
    closing(body, 2) !== body.length - 1 ||
    !seqAt(body, inner, [')', ',', 'false', ')'])
  )
    return [
      ...out,
      'the owner test does not govern its whole answer: COALESCE(p_user = the owner AND (...), false)',
    ];
  const clauses = body.slice(gate + 1, inner);
  if (!listAfter(clauses, ['p_type', 'in', '(']).includes('engine_break_recovered'))
    out.push("p_type IN (...) no longer lists 'engine_break_recovered'");
  const system = group(clauses, ['p_type', '=', "'system'", 'and', '(']);
  if (!system || !foldedTo(system, ['push notifications are off']))
    out.push(
      "the system clause no longer compares the folded title with 'push notifications are off'"
    );
  const settlement = group(clauses, ['p_type', '=', "'settlement'", 'and', '(']);
  if (!settlement || !foldedTo(settlement, PROBLEM_TITLES))
    out.push(
      'the settlement clause no longer compares the folded title with the three problem titles'
    );
  const alertnames = settlement
    ? listAfter(settlement, ['p_data', '->>', "'alertname'", 'in', '('])
    : [];
  if (
    !settlement ||
    findAll(settlement, ['p_data', '->>', "'component'", '=', "'workers.auto-settlement'"])
      .length === 0 ||
    !PROBLEM_ALERTNAMES.every((a) => alertnames.includes(a))
  )
    out.push(
      "the settlement clause no longer takes the route's marker (workers.auto-settlement and its three alertnames)"
    );
  return out;
}

describe('LAW: the owner classifier keeps its operational kinds, for the owner only', () => {
  const { definitions, removals } = survey(migrationCorpus());
  const newest = definitions[definitions.length - 1];

  it('the newest definition keeps the settlement problems, the push-off notice and the kinds before, owner-only', () => {
    expect(newest, `no migration defines public.${NAME}`).toBeDefined();
    expect(
      violations(newest!),
      `the newest definition of public.${NAME} is in ${newest!.file}`
    ).toEqual([]);
  });

  it('is not older than the migration that taught it these kinds', () => {
    expect(newest!.file >= '20260928171444', `the newest definition is in ${newest!.file}`).toBe(
      true
    );
  });

  it('no later migration drops or renames it', () => {
    const later = removals.filter((r) => before(newest!.order, r.order)).map((r) => r.file);
    expect(later, `public.${NAME} is dropped or renamed after its newest definition`).toEqual([]);
  });

  describe('the reader', () => {
    const one = (sql: string) => survey([{ name: 'probe.sql', sql }]);
    const params =
      '(p_user uuid, p_type text, p_title text, p_data jsonb) returns boolean language sql immutable';
    const eClass = `E'[${['t', 'n', 'v', 'f', 'r'].map((c) => BACKSLASH + BACKSLASH + c).join('')} ]+'`;
    const fold = `btrim(regexp_replace(translate(p_title,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),${eClass},' ','g'),' ')`;
    const kinds = "p_type IN ('financial_incident','engine_break_recovered')";
    const system = `(p_type='system' AND (p_title IN ('Push Health Alert') OR ${fold}='push notifications are off'))`;
    const settlement =
      `(p_type='settlement' AND (${fold} IN ('weekly player p&l needs review','weekly player p&l failed','union rule violation detected')` +
      " OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='workers.auto-settlement'" +
      " AND p_data->>'alertname' IN ('UnionPlayerPnlNeedsReview','UnionPlayerPnlFailed','UnionRuleViolation'))))";
    const classifier = (...clauses: string[]) =>
      `SELECT COALESCE(p_user='${OWNER}'::uuid AND (${clauses.join(' OR ')}),false);`;
    const quote = (sql: string) => `'${sql.replace(/'/g, "''")}'`;
    const SYSTEM =
      "the system clause no longer compares the folded title with 'push notifications are off'";
    const TITLES =
      'the settlement clause no longer compares the folded title with the three problem titles';
    const MARKER =
      "the settlement clause no longer takes the route's marker (workers.auto-settlement and its three alertnames)";

    it('finds a lower-case definition with quoted names, and none in a comment after it', () => {
      const found = one(
        `create or replace function "public"."${NAME}"${params} as $b$${classifier(kinds, system, settlement)}$b$;\n` +
          `-- CREATE OR REPLACE FUNCTION public.${NAME}(p uuid) AS $x$ select true $x$;\n` +
          `/* create function public.${NAME}(p uuid) /* nested */ as $x$ select true $x$; */`
      );
      expect(found.definitions).toHaveLength(1);
      expect(violations(found.definitions[0]!)).toEqual([]);
    });

    it('finds one in an EXECUTE string of a DO block, however deeply its body is quoted', () => {
      const dollar = one(
        `do $d$ begin execute ${quote(`create or replace function public.${NAME}${params} as $q$${classifier(kinds, system)}$q$`)}; end $d$;`
      );
      expect(dollar.definitions).toHaveLength(1);
      expect(violations(dollar.definitions[0]!)).toEqual([TITLES, MARKER]);
      const quoted = one(
        `DO $d$ BEGIN EXECUTE ${quote(`CREATE FUNCTION PUBLIC.${NAME.toUpperCase()}${params} AS ${quote(classifier(kinds, settlement))}`)}; END $d$;`
      );
      expect(quoted.definitions).toHaveLength(1);
      expect(violations(quoted.definitions[0]!)).toEqual([SYSTEM]);
    });

    it('refuses a plain literal with a backslash, a clause outside the owner test, an unreadable body, and sees a drop', () => {
      const plain = classifier(kinds, system, settlement)
        .split("E'[")
        .join("'[")
        .split(BACKSLASH + BACKSLASH)
        .join(BACKSLASH);
      expect(
        violations(
          one(`create function public.${NAME}${params} as $b$${plain}$b$;`).definitions[0]!
        )
      ).toHaveLength(2);
      const loose = `coalesce(p_user='${OWNER}'::uuid and (${kinds} or ${system} or ${settlement}), false) or p_type='settlement'`;
      expect(
        violations(one(`create function public.${NAME}${params} return ${loose};`).definitions[0]!)
      ).toEqual([
        'the owner test does not govern its whole answer: COALESCE(p_user = the owner AND (...), false)',
      ]);
      expect(violations(one(`create function public.${NAME}${params};`).definitions[0]!)).toEqual([
        'probe.sql: it has no body this law can read (AS, RETURN or BEGIN ATOMIC)',
      ]);
      const dropped = one(
        `create function public.${NAME}${params} as $b$${classifier(kinds, system, settlement)}$b$; ` +
          `drop function if exists public.${NAME}(uuid,text,text,jsonb);`
      );
      expect(dropped.removals).toHaveLength(1);
      expect(before(dropped.definitions[0]!.order, dropped.removals[0]!.order)).toBe(true);
    });

    it('refuses the definition it replaced (20260916111614)', () => {
      const replaced = definitions.find((d) => d.file.startsWith('20260916111614_'));
      expect(replaced).toBeDefined();
      expect(violations(replaced!)).toEqual([SYSTEM, TITLES, MARKER]);
    });
  });
});
