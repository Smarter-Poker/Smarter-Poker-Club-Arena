/**
 * Every SQL function that records a Production Alerts event addresses the fleet.
 *
 * The Production Alerts fleet triages public.operational_alert_events by
 * payload.target_task_id. A row without it reaches the store and never reaches
 * the lane that has to act on it. On 2026-09-27, 20260927143752 added a call to
 * fn_record_operational_alert() inside fn_mirror_notification_to_push_outbox()
 * whose payload had no target_task_id, and nothing checked it. 20260928032225
 * addresses that call and makes the store itself refuse an unaddressed row
 * under that source; this reads every other sender before it can merge.
 *
 * WHERE IT RUNS. This module lives under tests/ on purpose: a pull request that
 * changes only this file is sent by scripts/ci/classify-ci-changes.mjs to the
 * required Client Unit Tests (vitest) check, which runs
 * tests/an-operational-alert-sender-addresses-the-fleet.law.test.ts (the corpus)
 * and tests/an-operational-alert-sender-addresses-the-fleet.decisions.test.ts
 * (the decision cases). scripts/ci/check-operational-sender-addressing.mjs is
 * only its command line, for the advisory --added-since job.
 *
 * WHAT IT DECIDES. It reads supabase/migrations/*.sql in version order and finds
 * every CREATE [OR REPLACE] FUNCTION or PROCEDURE, including those held as DDL
 * text inside another dollar-quoted string. A function is keyed by schema, name
 * and argument types. A body that calls the writer is a sender, and it is
 * addressed only when EVERY call it contains proves, at that point of the
 * body's control flow, that payload.target_task_id is the fleet id as text.
 * The body is read as PL/pgSQL (blocks, IF, CASE, loops, EXIT/CONTINUE,
 * exception handlers) and every variable's state is carried along each path;
 * at a join the state is what ALL paths agree on. A payload proves it when it:
 *
 *   - is an inline jsonb_build_object(...) whose last literal 'target_task_id'
 *     key has as its value the fleet id literal (a ::uuid cast of it in any
 *     letter case, since jsonb prints a uuid lower-case), a variable that holds
 *     that value on every path to the call, or <row>.target_task_id of a
 *     %ROWTYPE row filled by SELECT * INTO STRICT from a table whose column is
 *     NOT NULL and CHECKed equal to the fleet id; no key computed at run time
 *     may follow it;
 *   - is a JSON literal carrying it;
 *   - is a || chain whose right-most operand that sets target_task_id proves
 *     it (jsonb keeps the right operand's value). A left operand that is NULL
 *     or not an object makes the result NULL or an array, which the store's own
 *     NOT NULL and object checks refuse, so it cannot store an unaddressed row;
 *   - is a variable proven on every path to the call. An assignment PROVES it
 *     (one of the forms above), PRESERVES it (v || an object that does not set
 *     the key; v - a literal key other than target_task_id) or BREAKS it
 *     (anything else: '{}', NULL, v - 'target_task_id', a || that sets the key
 *     to another value, SELECT INTO, a declaration without a value, a
 *     parameter). v - <key computed at run time> preserves it only as an
 *     ASSUMPTION that the key is not target_task_id; each one is printed, and
 *     the law test pins the list.
 *
 * Refused, each with its reason: every other expression; a name declared more
 * than once (a nested DECLARE or loop variable can shadow it); a call made
 * through dynamic SQL, including a multi-statement EXECUTE; a string that names
 * the writer (format('%I'), EXECUTE 'SELECT ' || '...'); a call to the batch
 * writer fn_record_operational_alerts(jsonb), whose per-event payloads it
 * cannot read; a call with no payload. A body it cannot parse is COULD NOT TELL.
 *
 * It judges twice: the LATEST body of each function, and EVERY migration on its
 * own (version order is not application order: PR #5489 added a body whose
 * version sorts before an addressed one). SUPERSEDED_HISTORY and a verified
 * recording (scripts/ci/recording-only.mjs) are exempt from the second reading
 * only. With --added-since <rev>, an added migration never gets the history
 * exemption, and a pure rename (R100) or a verified recording is not re-judged.
 *
 * WHAT IT CANNOT SEE, and what does: a writer name assembled from pieces at run
 * time ('fn_record_' || 'operational_alert'), a DO block or a top-level SELECT,
 * a direct INSERT INTO operational_alert_events, a body produced at apply time
 * from pg_get_functiondef(), and anything applied outside supabase/migrations
 * (an MCP or dashboard apply). For source 'owner-accounting-notifications' the
 * store refuses such a row whatever wrote it (20260928032225); for every source,
 * scripts/ci/check-operational-alert-addressing.mjs records any unaddressed row
 * that reaches production as a fleet-addressed incident. DROP FUNCTION is not
 * tracked, so a dropped sender is still judged: loud, never silent.
 *
 * Exit: 0 every call it can read proves the address; 1 an unaddressed sender,
 * "UNADDRESSED <fn>(<args>) (<file>): <reason>"; 3 COULD NOT TELL.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { classifyMigration, loadManifest } from '../../scripts/ci/recording-only.mjs';
import {
  NOT_JSON,
  Unreadable,
  adjacent,
  argumentsBetween,
  callArguments,
  codeOnly,
  escapeRe,
  identName,
  identifier,
  isName,
  isObject,
  isPunct,
  isWord,
  jsonLiteral,
  lex,
  matching,
  md5,
  operands,
  parameters,
  parsePlpgsql,
  parseSql,
  partners,
  rowField,
  short,
  splitTop,
  stringLiteral,
  strip,
  tableName,
  tokensOf,
  unparen,
} from './sql-reader.mjs';

export const FLEET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const WRITER = 'fn_record_operational_alert';
export const BATCH_WRITER = 'fn_record_operational_alerts';
export const WRITER_ARGS = 'text,text,text,text,text,jsonb';
export const UNADDRESSED = 1;
export const UNKNOWN = 3;

/**
 * Migrations already on main that are unaddressed on their own and superseded
 * by a later, addressed body. Pinned by the md5 of the file text, so a pure
 * rename keeps its entry and any edit loses it; an entry holds only while
 * exactly one file carries that md5. The latest-body reading still judges them.
 * Closed: every migration written from here on is judged on its own.
 */
export const SUPERSEDED_HISTORY = [
  {
    md5: 'f7ff8cb8c933cc4ad7b326f278afc72a',
    file: '20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql',
    fn: 'fn_mirror_notification_to_push_outbox()',
    supersededBy: '20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql',
  },
];

const MENTIONS_WRITER = new RegExp(WRITER, 'i');
const IN_TEXT = new RegExp(`(?<![A-Za-z0-9_$"])"?(${WRITER}s?)"?\\s*\\(`, 'gi');
const NAMED = new RegExp(`^(?:"?public"?\\s*\\.\\s*)?"?${WRITER}s?"?$`, 'i');
const SIGNATURE = { direct: /\(\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*jsonb\s*\)/iy, batch: /\(\s*jsonb\s*\)/iy };
const HEADER_TEXT = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const JSON_CASTS = /::\s*jsonb?\s*$/i;
const VALUE_CASTS = /::\s*(?:text|uuid|varchar|character\s+varying)\s*$/i;

const writerKind = (tok) => {
  const n = tok && tok.type === 'word' ? tok.value.toLowerCase() : tok && tok.type === 'qident' ? tok.value : null;
  return n === WRITER ? 'direct' : n === BATCH_WRITER ? 'batch' : null;
};
const isSignature = (code, paren, kind) => { const re = SIGNATURE[kind]; re.lastIndex = paren; return re.test(code); };

/** Offsets of the '(' of every writer call in `text` (either writer); signature references are not calls. */
export function writerCalls(text) {
  const out = [];
  for (const m of text.matchAll(IN_TEXT)) {
    const paren = m.index + m[0].length - 1;
    if (!isSignature(text, paren, m[1].toLowerCase() === WRITER ? 'direct' : 'batch')) out.push(paren);
  }
  return out;
}

/**
 * Every CREATE [OR REPLACE] FUNCTION/PROCEDURE in text[start,end) and in the SQL
 * nested inside its dollar-quoted strings, in order of appearance, plus every
 * place where a definition near a writer call could not be read. Offsets are
 * absolute in `text`, so a nested definition's body lies inside its holder's.
 */
export function definitions(text, start = 0, end = text.length, out = [], unreadable = []) {
  const { tokens: t, problems } = lex(text, start, end);
  for (const p of problems) {
    if (writerCalls(text.slice(p.at, p.end)).length) unreadable.push(`${p.what} at offset ${p.at} hides a call to ${WRITER}`);
  }
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (tok.type === 'dollar') { definitions(text, tok.contentStart, tok.contentEnd, out, unreadable); continue; }
    if (tok.type === 'string') {
      const s = text.slice(tok.start, tok.end);
      if (HEADER_TEXT.test(s) && writerCalls(s).length) unreadable.push(`a definition held in a quoted string at offset ${tok.start} calls ${WRITER}`);
      continue;
    }
    if (!isWord(tok, 'create')) continue;
    let j = k + 1;
    if (isWord(t[j], 'or') && isWord(t[j + 1], 'replace')) j += 2;
    if (!isWord(t[j], 'function') && !isWord(t[j], 'procedure')) continue;
    if (!isName(t[j + 1])) continue;
    let schema = 'public';
    let name = identName(t[j + 1]);
    let n = j + 2;
    if (isPunct(t[n], '.') && isName(t[n + 1])) { schema = name; name = identName(t[n + 1]); n += 2; }
    if (!isPunct(t[n], '(')) continue;
    const close = matching(t, n);
    const params = close < 0 ? [] : parameters(text, t, n, close);
    const def = { schema, name, params, args: close < 0 ? '?' : params.filter((p) => p.mode !== 'out' && p.type).map((p) => p.type).join(','), at: tok.start, body: null, bodyStart: -1, bodyEnd: -1, language: null };
    // Walk the header to its AS clause, and the whole statement for LANGUAGE.
    let depth = 0;
    let m = n;
    let bodyToken = -1;
    for (; m < t.length; m++) {
      const h = t[m];
      if (isPunct(h, '(')) depth++;
      else if (isPunct(h, ')')) depth--;
      else if (depth === 0 && (isPunct(h, ';') || isWord(h, 'begin') || isWord(h, 'return') || isWord(h, 'create'))) break;
      else if (depth === 0 && isWord(h, 'as')) {
        const b = t[m + 1];
        if (b && b.type === 'dollar') { def.body = text.slice(b.contentStart, b.contentEnd); def.bodyStart = b.contentStart; def.bodyEnd = b.contentEnd; bodyToken = m + 1; }
        else if (b && b.type === 'string') { def.body = text.slice(b.start + 1, b.end - 1).replace(/''/g, "'"); def.bodyStart = b.start + 1; def.bodyEnd = b.end - 1; bodyToken = m + 1; }
        break;
      }
    }
    for (let q = close + 1, d = 0; close >= 0 && q < t.length; q++) {
      if (q === bodyToken) continue;
      if (isPunct(t[q], '(')) d++;
      else if (isPunct(t[q], ')')) d--;
      else if (d === 0 && (isPunct(t[q], ';') || isWord(t[q], 'create'))) break;
      else if (d === 0 && isWord(t[q], 'language') && t[q + 1]) {
        const l = t[q + 1];
        def.language = (l.type === 'string' ? text.slice(l.start + 1, l.end - 1) : l.type === 'qident' ? l.value : l.value).toLowerCase();
      }
    }
    if (def.body === null) {
      // No body we can read (a SQL-standard BEGIN ATOMIC/RETURN body, or a
      // header cut short). Judge the text up to the next definition instead.
      let stop = m;
      while (stop < t.length && !(stop > k && isWord(t[stop], 'create'))) stop++;
      def.region = text.slice(tok.start, stop < t.length ? t[stop].start : end);
    }
    out.push(def);
  }
  return { definitions: out, unreadable };
}

// ---------------------------------------------------------------------------
// Tables whose target_task_id column the schema pins to the fleet id.
// ---------------------------------------------------------------------------

const TABLE_NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)`;
const CREATE_TABLE = new RegExp(String.raw`\bcreate\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${TABLE_NAME}\s*\(`, 'gi');
const ALTER_TABLE = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${TABLE_NAME}([^;]*)`, 'gi');
const DROP_TABLE = /\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]*)/gi;

/** True when a CHECK in `text` says exactly target_task_id = the fleet id. */
function checksFleet(text) {
  for (const m of text.matchAll(/\bcheck\s*\(/gi)) {
    const inner = callArguments(text, m.index + m[0].length - 1);
    if (!inner || inner.length !== 1) continue;
    const e = inner[0].replace(/::\s*(?:uuid|text)\b/gi, '').replace(/[\s()"]/g, '').toLowerCase();
    if (e === `target_task_id='${FLEET_TASK_ID}'` || e === `'${FLEET_TASK_ID}'=target_task_id`) return true;
  }
  return false;
}

/** The CREATE TABLE column list at `paren` declares target_task_id NOT NULL and CHECKed equal to the fleet id. */
function columnPinned(code, paren) {
  const items = callArguments(code, paren);
  if (!items) return false;
  let column = null;
  let checked = false;
  for (const item of items) {
    const t = tokensOf(item);
    if (!t || !t.length) continue;
    const isColumn = isName(t[0]) && identName(t[0]) === 'target_task_id';
    if (isColumn) column = item;
    if (isColumn || isWord(t[0], 'check') || isWord(t[0], 'constraint')) checked ||= checksFleet(item);
  }
  return column !== null && /\bnot\s+null\b/i.test(column) && checked;
}

const pinCache = new WeakMap();

/** table -> pinned?, over `corpus` in version order: the last CREATE TABLE decides; a later ALTER that touches the column or a constraint, a rename or a DROP unpins it. */
function tablePins(corpus) {
  if (pinCache.has(corpus)) return pinCache.get(corpus);
  const memo = new Map();
  const pinned = (table) => {
    if (memo.has(table)) return memo.get(table);
    const mentions = new RegExp(escapeRe(table.slice(table.indexOf('.') + 1)), 'i');
    let state = false;
    for (const f of corpus) {
      if (!mentions.test(f.sql)) continue;
      const code = codeOnly(f.sql);
      const events = [];
      for (const m of code.matchAll(CREATE_TABLE)) if (tableName(m[1]) === table) events.push({ at: m.index, pin: () => columnPinned(code, m.index + m[0].length - 1) });
      for (const m of code.matchAll(ALTER_TABLE)) if (tableName(m[1]) === table && /\b(?:target_task_id|drop\s+constraint|drop\s+column|rename)\b/i.test(m[2])) events.push({ at: m.index, pin: () => false });
      for (const m of code.matchAll(DROP_TABLE)) if (m[1].split(',').some((x) => tableName(x.replace(/\b(?:cascade|restrict)\b/gi, '')) === table)) events.push({ at: m.index, pin: () => false });
      for (const e of events.sort((a, b) => a.at - b.at)) state = e.pin();
    }
    memo.set(table, state);
    return state;
  };
  pinCache.set(corpus, pinned);
  return pinned;
}

// ---------------------------------------------------------------------------
// Values and payloads, read against the state of the variables at one point.
// A state maps a name to { p, f, r }: p is null or the list of assumptions
// under which it is an object carrying the fleet address; f says it holds the
// fleet id as jsonb_build_object would print it; r says it is a row filled by
// SELECT * INTO STRICT from a table that pins target_task_id to the fleet id.
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze({ p: null, f: false, r: false });

const hex = (s) => s.replace(/^\{|\}$/g, '').replace(/-/g, '').toLowerCase();
const FLEET_HEX = hex(FLEET_TASK_ID);

/** Whether `expr`, stored as `type` (or passed to jsonb_build_object when null), prints as the fleet id. */
function fleetValue(expr, type, ctx, st) {
  let e = expr.trim();
  const casts = [];
  for (;;) {
    const c = /::\s*([a-z_]+(?:\s+varying)?)\s*$/i.exec(e);
    if (c) { casts.unshift(c[1].toLowerCase().replace(/\s+/g, ' ')); e = e.slice(0, c.index).trim(); continue; }
    const s = unparen(e);
    if (s === e) break;
    e = s;
  }
  const s = stringLiteral(e);
  if (s !== null) {
    const first = casts[0] ?? type ?? 'text';
    if (casts.some((c) => !['uuid', 'text', 'varchar', 'character varying'].includes(c))) return false;
    return first === 'uuid' ? /^\{?[0-9a-f-]+\}?$/i.test(s) && hex(s) === FLEET_HEX : s === FLEET_TASK_ID;
  }
  if (casts.some((c) => !['uuid', 'text', 'varchar', 'character varying'].includes(c))) return false;
  const id = identifier(e);
  if (id) return !ctx.shadowed.has(id) && (st.get(id) ?? EMPTY).f;
  const f = rowField(e);
  return f !== null && f.field === 'target_task_id' && !ctx.shadowed.has(f.row) && (st.get(f.row) ?? EMPTY).r;
}

/** An inline jsonb_build_object/json_build_object call spanning all of `e`: its key/value pairs, or null. */
function objectPairs(e) {
  const t = tokensOf(e);
  if (!t) return null;
  const i = isWord(t[0], 'pg_catalog') && isPunct(t[1], '.') ? 2 : 0;
  if (!(isWord(t[i], 'jsonb_build_object') || isWord(t[i], 'json_build_object')) || !isPunct(t[i + 1], '(')) return null;
  if (matching(t, i + 1) !== t.length - 1) return null;
  const args = callArguments(e, t[i + 1].start);
  if (!args) return null;
  const list = args.length === 1 && args[0] === '' ? [] : args;
  if (list.length % 2 || list.some((a) => /^variadic\b/i.test(a))) return { pairs: null };
  const pairs = [];
  for (let p = 0; p < list.length; p += 2) pairs.push({ keyText: list[p], key: stringLiteral(strip(list[p], VALUE_CASTS)), value: list[p + 1] });
  return { pairs };
}

const ok = (assumptions = []) => ({ state: 'fleet', assumptions });
const absent = () => ({ state: 'absent' });
const no = (why) => ({ state: 'fail', why });

/** What an inline object does to target_task_id. */
function objectAddress({ pairs }, ctx, st) {
  if (!pairs) return no('builds an object from an odd or VARIADIC argument list, which cannot be read');
  let target = -1;
  pairs.forEach((p, i) => { if (p.key === 'target_task_id') target = i; });
  const late = pairs.findIndex((p, i) => i > target && p.key === null);
  if (late >= 0) return target < 0 ? { state: 'runtime', why: `builds the key ${short(pairs[late].keyText)} at run time, and it could be target_task_id with any value` } : no(`builds the key ${short(pairs[late].keyText)} at run time after target_task_id, and it could be target_task_id`);
  if (target < 0) return absent();
  if (fleetValue(pairs[target].value, null, ctx, st)) return ok();
  const v = identifier(strip(pairs[target].value, VALUE_CASTS)) ?? rowField(pairs[target].value)?.row;
  const why = v && ctx.shadowed.has(v) ? `, and ${v} is declared more than once, so which one the call reads cannot be proven`
    : v && ctx.params.has(v) ? `, and ${v} is a parameter: its value comes from the caller`
    : v && ctx.rowtypes.has(v) ? `, and ${v} is not filled by SELECT * INTO STRICT from a table that pins the column on every path here` : '';
  return no(`sets target_task_id to ${short(pairs[target].value)}, which is not the fleet id, a variable holding it on every path here, or a column pinned to it${why}`);
}

/** The keys a `-` operand removes: { keys } for literals, { runtime } otherwise. */
function removedKeys(k) {
  const e = strip(k, /::\s*text(?:\[\])?\s*$/i);
  const s = stringLiteral(e);
  if (s !== null) return /^\{.*\}$/.test(s) ? { keys: s.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')) } : { keys: [s] };
  const t = tokensOf(e);
  if (t && isWord(t[0], 'array') && isPunct(t[1], '[') && isPunct(t[t.length - 1], ']')) {
    const items = splitTop(e.slice(t[1].end, t[t.length - 1].start)).map((x) => stringLiteral(strip(x, VALUE_CASTS)));
    if (items.every((x) => x !== null)) return { keys: items };
  }
  if (t && t.length === 1 && t[0].type === 'word' && /^\d+$/.test(t[0].value)) return { index: true };
  return { runtime: short(k) };
}

/** What the expression `e` makes of target_task_id: fleet (with assumptions), absent, runtime, or fail. */
function address(expr, ctx, st) {
  const e = strip(expr, JSON_CASTS);
  if (/^null$/i.test(e)) return no('passes NULL as its payload');
  const chain = operands(e, '||');
  if (chain.length > 1) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = address(chain[i], ctx, st);
      if (a.state === 'fleet') return a;
      if (a.state === 'absent') continue;
      if (a.explicit) return no(a.why);
      return no(`concatenates ${short(chain[i])} with ||, and what that operand does to target_task_id cannot be proven (it ${a.why}); put an object that carries the fleet id right-most, where its keys win`);
    }
    return { state: 'absent', why: 'concatenates payloads with ||, and none of them carries target_task_id' };
  }
  const minus = operands(e, '-');
  if (minus.length > 1) {
    const base = address(minus[0], ctx, st);
    if (base.state !== 'fleet') return base.state === 'absent' ? absent() : { ...base, explicit: true };
    const assumptions = [...base.assumptions];
    for (const k of minus.slice(1)) {
      const r = removedKeys(k);
      if (r.index) return { ...no(`removes ${short(k)} from ${short(minus[0])}, which is not a key`), explicit: true };
      if (r.keys && r.keys.includes('target_task_id')) return { ...no(`removes target_task_id from ${short(minus[0])} (- ${short(k)})`), explicit: true };
      if (r.runtime) assumptions.push(`removes the key ${r.runtime}, computed at run time, and is assumed not to remove target_task_id`);
    }
    return ok(assumptions);
  }
  const obj = objectPairs(e);
  if (obj) return { ...objectAddress(obj, ctx, st), explicit: true };
  const lit = jsonLiteral(e);
  if (lit !== NOT_JSON) {
    if (!isObject(lit)) return { ...no(`passes the literal ${short(e)}, which is not an object`), explicit: true };
    if (!Object.hasOwn(lit, 'target_task_id')) return { state: 'absent', why: `passes the literal ${short(e)}, which does not carry the fleet id as target_task_id` };
    return lit.target_task_id === FLEET_TASK_ID ? ok() : { ...no(`passes the literal ${short(e)}, whose target_task_id is not the fleet id`), explicit: true };
  }
  const id = identifier(e);
  if (id) {
    if (ctx.shadowed.has(id)) return no(`passes ${id}, which is declared more than once, so which one the call reads cannot be proven`);
    const fact = st.get(id) ?? EMPTY;
    return fact.p ? ok(fact.p) : no(`passes ${id}, which is not proven to carry the fleet id on every path to this point`);
  }
  const call = /^((?:[A-Za-z_][\w$]*\s*\.\s*)?[A-Za-z_][\w$]*)\s*\(/.exec(e);
  const form = call ? `a call to ${call[1].replace(/\s+/g, '')}()` : /^case\b/i.test(e) ? 'a CASE expression' : 'an expression this check does not read';
  return no(`passes ${short(e)}, ${form}, which cannot be proven to carry the fleet id`);
}

/** { ok: true, assumptions } or { ok: false, reason } for one payload expression. */
function prove(expr, ctx, st) {
  const a = address(expr, ctx, st);
  if (a.state === 'fleet') return { ok: true, assumptions: a.assumptions };
  if (a.state === 'absent') return { ok: false, reason: a.why ?? 'builds its payload without target_task_id' };
  if (a.state === 'runtime') return { ok: false, reason: 'builds its payload without target_task_id' };
  return { ok: false, reason: a.why };
}

// ---------------------------------------------------------------------------
// PL/pgSQL control flow. The body's tokens are read into blocks, IFs, CASEs,
// loops and plain statements; the state of every variable is carried along
// each path, joined where paths meet, and iterated to a fixed point in loops.
// ---------------------------------------------------------------------------

function joinStates(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const out = new Map();
  for (const [k, x] of a) {
    const y = b.get(k) ?? EMPTY;
    out.set(k, { p: x.p && y.p ? [...new Set([...x.p, ...y.p])].sort() : null, f: x.f && y.f, r: x.r && y.r });
  }
  for (const k of b.keys()) if (!a.has(k)) out.set(k, EMPTY);
  return out;
}
function sameStates(a, b) {
  if (a === null || b === null) return a === b;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) ?? EMPTY;
    const y = b.get(k) ?? EMPTY;
    if (x.f !== y.f || x.r !== y.r || Boolean(x.p) !== Boolean(y.p) || (x.p && x.p.join('\n') !== y.p.join('\n'))) return false;
  }
  return true;
}

/** Every writer call in a sender body, in order: direct (a token call), batch, dynamic (inside a string), named (a string naming the writer). */
function sitesOf(code, t, nested) {
  const sites = [];
  for (let k = 0; k < t.length; k++) {
    const x = t[k];
    if (x.type === 'string' || x.type === 'dollar') {
      const cs = x.type === 'dollar' ? x.contentStart : x.start + 1;
      const content = code.slice(cs, x.type === 'dollar' ? x.contentEnd : x.end - 1);
      if (NAMED.test(content.trim())) { sites.push({ kind: 'named', token: k, offset: x.start }); continue; }
      for (const m of content.matchAll(IN_TEXT)) {
        const at = cs + m.index;
        if (nested.some(([a, b]) => at >= a && at < b)) continue;
        if (isSignature(code, cs + m.index + m[0].length - 1, m[1].toLowerCase() === WRITER ? 'direct' : 'batch')) continue;
        sites.push({ kind: 'dynamic', token: k, offset: at });
      }
      continue;
    }
    const kind = writerKind(x);
    if (!kind || !isPunct(t[k + 1], '(') || isSignature(code, t[k + 1].start, kind)) continue;
    sites.push({ kind, token: k, offset: x.start });
  }
  return sites;
}

/**
 * { sites: [{ line, reason | null, assumptions }], unknown } for one sender body:
 * every call has to prove the address at its own point of the control flow.
 */
export function judgeBody(body, { pinned = () => false, params = [], language = null, nested = [] } = {}) {
  const code = codeOnly(body);
  const { tokens: t } = lex(code);
  const sites = sitesOf(code, t, nested);
  const lines = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lines.push(i + 1);
  const lineOf = (offset) => { let lo = 0; let hi = lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  const verdicts = new Map();
  const unknown = [];
  for (const s of sites) {
    if (s.kind === 'dynamic') verdicts.set(s, { reason: 'runs as dynamic SQL (EXECUTE ... USING, or a multi-statement EXECUTE), whose payload cannot be proven from the text; call fn_record_operational_alert directly' });
    else if (s.kind === 'named') verdicts.set(s, { reason: `names ${WRITER} in a string, which dynamic SQL (EXECUTE, format('%I')) can call; nothing it records can be proven from the text` });
    else if (s.kind === 'batch') verdicts.set(s, { reason: `calls the batch writer ${BATCH_WRITER}(jsonb), whose per-event payloads cannot be proven from the text; call ${WRITER} directly` });
  }
  const direct = sites.filter((s) => s.kind === 'direct');
  const result = () => ({
    sites: sites.map((s) => ({ line: lineOf(s.offset), ...(verdicts.get(s) ?? { reason: null, assumptions: [] }) })),
    unknown,
  });
  if (direct.length === 0) return result();
  let tree;
  try {
    const plpgsql = language === 'plpgsql' || (language === null && (isWord(t[0], 'declare') || isWord(t[0], 'begin') || isPunct(t[0], '<')));
    tree = plpgsql ? parsePlpgsql(t) : parseSql(t);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    unknown.push(`the body could not be read as ${language ?? 'PL/pgSQL'} (${error.message}), and it calls ${WRITER}`);
    return result();
  }
  const pair = partners(t);
  // Names declared more than once (parameters, every DECLARE, integer loop variables) cannot be proven.
  const declared = new Map();
  const count = (name) => declared.set(name, (declared.get(name) ?? 0) + 1);
  for (const p of params) if (p.name) count(p.name);
  const types = new Map(params.filter((p) => p.name).map((p) => [p.name, p.type]));
  const rowtypes = new Map();
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type === 'block') { for (const d of n.decls) { count(d.name); types.set(d.name, d.type); if (d.rowtype) rowtypes.set(d.name, d.rowtype); } walk(n.body); for (const h of n.handlers) walk(h.body); }
      else if (n.type === 'if' || n.type === 'case') { for (const b of n.branches) walk(b.body); if (n.otherwise) walk(n.otherwise); }
      else if (n.type === 'loop') { if (n.counter) for (const v of n.vars) count(v); walk(n.body); }
    }
  })([tree]);
  const ctx = { shadowed: new Set([...declared].filter(([, c]) => c > 1).map(([k]) => k)), params: new Set(params.map((p) => p.name).filter(Boolean)), rowtypes };
  const text = (a, b) => (a < b ? code.slice(t[a].start, t[b - 1].end) : '');
  const protects = [];
  const frames = [];
  let cursor = 0;
  const seen = new Set();
  const evaluate = (range, st) => {
    const live = st ?? new Map();
    for (const p of protects) p.state = joinStates(p.state, st);
    const [a, b] = range;
    while (cursor > 0 && direct[cursor - 1].token >= a) cursor--;
    while (cursor < direct.length && direct[cursor].token < a) cursor++;
    for (let k = cursor; k < direct.length && direct[k].token < b; k++) {
      const s = direct[k];
      seen.add(s);
      const open = s.token + 1;
      const close = pair[open];
      if (close < 0) { verdicts.set(s, { reason: null, unknown: 'its arguments could not be read' }); continue; }
      const args = argumentsBetween(code, t, open, close);
      const named = args.find((x) => /^p_payload\s*(?:=>|:=)/i.test(x));
      const payload = named ? named.replace(/^p_payload\s*(?:=>|:=)\s*/i, '') : args.length >= 6 && !/^[A-Za-z_][\w$]*\s*(?:=>|:=)/.test(args[5]) ? args[5] : null;
      const v = payload === null ? { ok: false, reason: 'passes no payload this check can find' } : prove(payload, ctx, live);
      verdicts.set(s, v.ok ? { reason: null, assumptions: v.assumptions } : { reason: v.reason });
    }
  };
  const assign = (st, name, fact) => { if (st === null) return null; const out = new Map(st); out.set(name, ctx.shadowed.has(name) ? EMPTY : fact); return out; };
  const factOf = (a, b, name, st) => {
    const expr = text(a, b);
    const live = st ?? new Map();
    const p = prove(expr, ctx, live);
    return { p: p.ok ? p.assumptions : null, f: fleetValue(expr, types.get(name) ?? null, ctx, live), r: false };
  };
  const effect = (range, st) => {
    if (st === null) return null;
    const [a, b] = range;
    let k = a;
    if (isName(t[k]) && !isWord(t[k], 'select') && !isWord(t[k], 'perform')) {
      const target = identName(t[k]);
      let field = null;
      let j = k + 1;
      if (isPunct(t[j], '.') && isName(t[j + 1])) { field = identName(t[j + 1]); j += 2; }
      else if (isPunct(t[j], '[')) {
        let d = 0;
        for (; j < b; j++) { if (isPunct(t[j], '[')) d++; else if (isPunct(t[j], ']') && --d === 0) { j++; break; } }
        field = '[]';
      }
      const colon = isPunct(t[j], ':') && isPunct(t[j + 1], '=') && adjacent(t[j], t[j + 1]);
      if (colon || (isPunct(t[j], '=') && !isPunct(t[j + 1], '='))) {
        const from = colon ? j + 2 : j + 1;
        const prior = st.get(target) ?? EMPTY;
        if (field === null) return assign(st, target, factOf(from, b, target, st));
        if (field === 'target_task_id') return assign(st, target, { ...prior, r: false });
        if (field === '[]') return assign(st, target, { ...prior, p: null, f: false });
        return st;
      }
    }
    if (isWord(t[a], 'get')) {
      let out = st;
      for (let q = a; q < b; q++) if (isName(t[q]) && (isPunct(t[q + 1], '=') || (isPunct(t[q + 1], ':') && isPunct(t[q + 2], '=')))) out = assign(out, identName(t[q]), EMPTY);
      return out;
    }
    if (isWord(t[a], 'call')) {
      let out = st;
      for (let q = a + 1; q < b; q++) if (isName(t[q]) && (isPunct(t[q - 1], '(') || isPunct(t[q - 1], ',')) && (isPunct(t[q + 1], ',') || isPunct(t[q + 1], ')'))) out = assign(out, identName(t[q]), EMPTY);
      return out;
    }
    let out = st;
    for (let q = a, d = 0; q < b; q++) {
      if (isPunct(t[q], '(')) { d++; continue; }
      if (isPunct(t[q], ')')) { d--; continue; }
      if (d !== 0 || !isWord(t[q], 'into') || isWord(t[q - 1], 'insert') || isWord(t[q - 1], 'merge')) continue;
      let v = isWord(t[q + 1], 'strict') ? q + 2 : q + 1;
      const strict = v === q + 2;
      const targets = [];
      while (isName(t[v])) { targets.push(identName(t[v])); if (!isPunct(t[v + 1], ',')) break; v += 2; }
      const whole = text(a, b).replace(/\s+/g, ' ').trim();
      for (const name of targets) {
        let r = false;
        if (targets.length === 1 && strict && rowtypes.has(name)) {
          const m = new RegExp(String.raw`^select \* into strict "?${escapeRe(name)}"? from (?:only )?${TABLE_NAME}(?: |$)`, 'i').exec(whole);
          r = m !== null && tableName(m[1]) === rowtypes.get(name) && pinned(rowtypes.get(name));
        }
        out = assign(out, name, { p: null, f: false, r });
      }
    }
    return out;
  };
  function run(nodes, st) {
    let s = st;
    for (const n of nodes) s = node(n, s);
    return s;
  }
  function node(n, st) {
    if (n.type === 'simple') {
      evaluate(n.range, st);
      const out = effect(n.range, st);
      return n.terminates ? null : out;
    }
    if (n.type === 'exit' || n.type === 'continue') {
      if (n.cond) evaluate(n.cond, st);
      const frame = n.target === null ? [...frames].reverse().find((f) => f.loop) : [...frames].reverse().find((f) => f.label === n.target);
      if (!frame) throw new Unreadable(`${n.type.toUpperCase()} outside a loop or labelled block`);
      if (n.type === 'exit') frame.exits = joinStates(frame.exits, st);
      else frame.conts = joinStates(frame.conts, st);
      return n.cond ? st : null;
    }
    if (n.type === 'if' || n.type === 'case') {
      if (n.selector) evaluate(n.selector, st);
      let out = null;
      for (const b of n.branches) { evaluate(b.cond, st); out = joinStates(out, run(b.body, st)); }
      return joinStates(out, n.otherwise ? run(n.otherwise, st) : st);
    }
    if (n.type === 'block') {
      let s = st;
      for (const d of n.decls) {
        if (d.init) evaluate(d.init, s);
        s = assign(s, d.name, d.init ? factOf(d.init[0], d.init[1], d.name, s) : EMPTY);
      }
      const frame = { label: n.label, loop: false, exits: null, conts: null };
      frames.push(frame);
      const guard = n.handlers.length ? { state: null } : null;
      if (guard) protects.push(guard);
      let out = run(n.body, s);
      if (guard) protects.splice(protects.indexOf(guard), 1);
      for (const h of n.handlers) { evaluate(h.cond, guard.state); out = joinStates(out, run(h.body, guard.state)); }
      frames.pop();
      return joinStates(out, frame.exits);
    }
    if (n.type === 'loop') {
      if (n.header) evaluate(n.header, st);
      const entry = st;
      let head = entry;
      const frame = { label: n.label, loop: true, exits: null, conts: null };
      frames.push(frame);
      for (let round = 0; ; round++) {
        if (round > 64) throw new Unreadable('a loop whose state never settles');
        frame.exits = null;
        frame.conts = null;
        if (n.kind === 'while') evaluate(n.header, head);
        let inBody = head;
        for (const v of n.vars) inBody = assign(inBody, v, EMPTY);
        const end = run(n.body, inBody);
        const next = joinStates(entry, joinStates(end, frame.conts));
        if (sameStates(next, head)) break;
        head = next;
      }
      frames.pop();
      return n.kind === 'loop' ? frame.exits : joinStates(head, frame.exits);
    }
    throw new Unreadable(`an unknown node ${n.type}`);
  }
  try {
    let st = new Map();
    for (const p of params) if (p.name) st.set(p.name, EMPTY);
    run([tree], st);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    unknown.push(`the body's control flow could not be followed (${error.message}), and it calls ${WRITER}`);
    return result();
  }
  for (const s of direct) {
    const v = verdicts.get(s);
    if (!seen.has(s) || !v) unknown.push(`the call at body line ${lineOf(s.offset)} could not be placed in the body's control flow`);
    else if (v.unknown) unknown.push(`the call at body line ${lineOf(s.offset)}: ${v.unknown}`);
  }
  return result();
}

const parsed = new WeakMap();
function parse(f) {
  if (!parsed.has(f)) parsed.set(f, definitions(f.sql));
  return parsed.get(f);
}
const excluded = (def) => (def.schema === 'public' && def.name === WRITER && def.args === WRITER_ARGS) || /^pg_temp(?:_\d+)?$/.test(def.schema);
const keyOf = (def) => `${def.schema}.${def.name}(${def.args})`;
const display = (def) => `${def.schema === 'public' ? '' : `${def.schema}.`}${def.name}(${def.args})`;
const nestedIn = (def, all) => all.filter((d) => d !== def && d.bodyStart >= def.bodyStart && d.bodyEnd <= def.bodyEnd && d.bodyStart >= 0).map((d) => [d.bodyStart - def.bodyStart, d.bodyEnd - def.bodyStart]);
const callsIn = (def, all) => (def.body === null ? writerCalls(codeOnly(def.region)).length > 0 : sitesOf(codeOnly(def.body), lex(codeOnly(def.body)).tokens, nestedIn(def, all)).length > 0);

/**
 * Judge migrations given as [{ file, sql }] in version order. By default the
 * latest definition of each function across all of them counts; with
 * eachFileOnItsOwn, the last definition of each function in each file does.
 * `corpus` is the whole schema history a table pin is read from (default: files).
 * Only files that mention the writer, and then only files that mention a
 * function that ever called it, are parsed: a definition spells its own name.
 */
export function audit(files, { eachFileOnItsOwn = false, corpus = files } = {}) {
  const unknown = [];
  const names = new Set();
  for (const f of files) {
    if (!MENTIONS_WRITER.test(f.sql)) continue;
    const found = parse(f);
    for (const u of found.unreadable) unknown.push(`${f.file}: ${u}`);
    for (const def of found.definitions) if (!excluded(def) && callsIn(def, found.definitions)) names.add(def.name);
  }
  const latest = new Map();
  if (names.size) {
    const mentions = new RegExp([...names].map(escapeRe).join('|'), 'i');
    for (const f of files) {
      if (!mentions.test(f.sql)) continue;
      const all = parse(f).definitions;
      for (const def of all) {
        if (excluded(def) || !names.has(def.name)) continue;
        latest.set(eachFileOnItsOwn ? `${f.file}\x00${keyOf(def)}` : keyOf(def), { def, file: f.file, all });
      }
    }
  }
  const pinned = tablePins(corpus);
  const senders = [];
  const unaddressed = [];
  const assumed = [];
  for (const { def, file, all } of latest.values()) {
    const name = display(def);
    if (def.body === null) {
      if (writerCalls(codeOnly(def.region)).length) unknown.push(`${name} (${file}): its body could not be read, and it is followed by a call to ${WRITER}`);
      continue;
    }
    const verdict = judgeBody(def.body, { pinned, params: def.params, language: def.language, nested: nestedIn(def, all) });
    if (verdict.sites.length === 0) continue;
    senders.push({ name, file });
    for (const u of verdict.unknown) unknown.push(`${name} (${file}): ${u}`);
    const reasons = verdict.sites.filter((s) => s.reason).map((s) => `the call at body line ${s.line} ${s.reason}`);
    if (reasons.length) unaddressed.push({ name, file, reason: reasons.join('; ') });
    for (const s of verdict.sites) for (const a of s.assumptions ?? []) assumed.push({ name, file, line: s.line, assumption: a });
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { senders: senders.sort(byName), unaddressed: unaddressed.sort(byName), unknown, assumed: assumed.sort(byName) };
}

/** supabase/migrations/*.sql in version order, as [{ file, sql }]. */
export function readMigrations(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => ({ file: n, sql: readFileSync(join(dir, n), 'utf8') }));
}

/**
 * Offenders from the every-file reading that are not exempt: SUPERSEDED_HISTORY
 * (by md5, only while one file carries it, never for a file in `added`) and
 * verified recordings. `repo` is the root the recordings manifest is read from.
 */
export function withoutExemptions(offenders, files, { repo, added = [] } = {}) {
  const sql = new Map(files.map((f) => [f.file, f.sql]));
  const sums = new Map();
  for (const o of offenders) if (!sums.has(o.file)) sums.set(o.file, md5(sql.get(o.file) ?? ''));
  const copies = new Map();
  for (const s of sums.values()) copies.set(s, (copies.get(s) ?? 0) + 1);
  const manifest = repo ? loadManifest(repo) : null;
  const kept = [];
  const history = [];
  const recorded = [];
  for (const o of offenders) {
    const sum = sums.get(o.file);
    if (!added.includes(o.file) && copies.get(sum) === 1 && SUPERSEDED_HISTORY.some((h) => h.md5 === sum && h.fn === o.name)) { history.push(o); continue; }
    const verdict = manifest ? classifyMigration(`supabase/migrations/${o.file}`, { repo, manifest }) : { state: 'new' };
    if (verdict.state === 'recorded') { recorded.push({ ...o, why: verdict.reason }); continue; }
    kept.push(o);
  }
  return { kept, history, recorded };
}

/** The migration files that `rev..HEAD` adds to `dir` (A, C), and its pure renames (R100), by file name. */
export function changedMigrations(dir, rev) {
  // A hook exports GIT_DIR and friends; they would point git at another repository than `dir`'s.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const rel = relative(root, dir).split('\\').join('/');
  // -M100% pairs only byte-identical renames; an edited rename is a deletion
  // plus an addition, and the addition is judged. A copy is an added file.
  const out = execFileSync('git', ['diff', '--name-status', '-z', '-M100%', '--diff-filter=ACR', rev, 'HEAD', '--', rel], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const own = (p) => (p.endsWith('.sql') && p.startsWith(`${rel}/`) && !p.slice(rel.length + 1).includes('/') ? p.slice(rel.length + 1) : null);
  const fields = out.split('\0');
  const added = [];
  const renamed = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      const to = own(fields[i + 2]);
      if (to && status.startsWith('R')) renamed.push({ from: fields[i + 1], to });
      else if (to) added.push(to);
      i += 3;
    } else {
      const path = own(fields[i + 1]);
      if (path && status === 'A') added.push(path);
      i += 2;
    }
  }
  return { added, renamed };
}

/** The whole check. Returns { code, lines } instead of exiting, so tests can call it. */
export function run(argv) {
  const option = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const dir = resolve(option('--dir') ?? 'supabase/migrations');
  const since = option('--added-since');
  if (argv.includes('--added-since') && !since) return { code: UNKNOWN, lines: ['COULD NOT TELL  --added-since needs a revision'] };
  let files;
  try {
    files = readMigrations(dir);
  } catch (error) {
    return { code: UNKNOWN, lines: [`COULD NOT TELL  cannot read ${dir}: ${error.message}`] };
  }
  if (files.length === 0) return { code: UNKNOWN, lines: [`COULD NOT TELL  no migrations in ${dir}; an empty scan is not a pass`] };
  let changed = null;
  let gitError = null;
  if (since) {
    try {
      changed = changedMigrations(dir, since);
    } catch (error) {
      gitError = String(error.stderr || error.message).trim().split('\n')[0];
    }
  }
  return check(files, { repo: resolve(dir, '..', '..'), since, changed, gitError });
}

/**
 * Both readings over migrations already read, in version order. `repo` is the
 * root the recordings manifest is read from; `changed` is what
 * changedMigrations() returned for `since`, or `gitError` why it could not.
 */
export function check(files, { repo = null, since = null, changed = null, gitError = null } = {}) {
  if (files.length === 0) return { code: UNKNOWN, lines: ['COULD NOT TELL  no migrations; an empty scan is not a pass'], assumed: [] };
  const whole = audit(files);
  const each = audit(files, { eachFileOnItsOwn: true });
  const unknown = [...whole.unknown];
  for (const u of each.unknown) if (!unknown.includes(u)) unknown.push(u);
  if (whole.senders.length === 0) unknown.push(`no function in ${files.length} migration(s) calls ${WRITER}; a scan that finds no sender is not a pass`);
  const lines = [`${whole.senders.length} sender(s) of ${WRITER} across ${files.length} migration(s), by the latest body of each: ${whole.senders.map((s) => s.name).join(', ')}`];
  const added = changed ? changed.added : [];
  if (changed) lines.push(`${added.length} migration(s) added since ${since}, denied the history exemption; ${changed.renamed.length} pure rename(s) not re-judged${changed.renamed.map((r) => ` (${r.to})`).join('')}`);
  if (gitError !== null) unknown.push(`cannot list the migrations added since ${since}: ${gitError}`);
  const own = withoutExemptions(each.unaddressed, files, { repo, added });
  lines.push(`every migration judged on its own: ${each.senders.length} sender definition(s); exempt: ${own.history.length} superseded history, ${own.recorded.length} verified recording(s)`);
  for (const r of own.recorded) lines.push(`recording-only: ${r.file} - ${r.why}`);
  const unaddressed = [...whole.unaddressed];
  for (const u of own.kept) if (!unaddressed.some((w) => w.name === u.name && w.file === u.file)) unaddressed.push(u);
  const assumed = [];
  for (const a of [...whole.assumed, ...each.assumed]) if (!assumed.some((b) => b.name === a.name && b.file === a.file && b.line === a.line && b.assumption === a.assumption)) assumed.push(a);
  for (const a of assumed) lines.push(`ASSUMED ${a.name} (${a.file}): the call at body line ${a.line} ${a.assumption}`);
  for (const u of unaddressed) lines.push(`UNADDRESSED ${u.name} (${u.file}): ${u.reason}; every call must carry 'target_task_id','${FLEET_TASK_ID}'`);
  for (const u of unknown) lines.push(`COULD NOT TELL  ${u}`);
  const code = unaddressed.length ? UNADDRESSED : unknown.length ? UNKNOWN : 0;
  if (code === 0) lines.push(`ok    every writer call this check can read proves the fleet address (${FLEET_TASK_ID})${assumed.length ? `, under the ${assumed.length} assumption(s) printed above` : ''}; what it cannot read is listed in its header`);
  return { code, lines, assumed };
}
