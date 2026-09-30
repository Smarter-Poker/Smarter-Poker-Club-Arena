/**
 * A DOOR THE ENGINE CALLS BY NAME HAS ONE OVERLOAD (2026-09-28).
 *
 * PostgREST resolves `supabase.rpc('fn_x', { a, b })` by NAME and by the set
 * of named arguments. When two overloads of fn_x both accept that set - the
 * old `(a, b)` and a new `(a, b, c DEFAULT NULL)` - it refuses the call
 * outright with PGRST203 ("Could not choose the best candidate function").
 *
 * That happened on production at 14:49:15Z on 2026-09-28. Migration
 * 20260928144831 meant to add `p_request_id uuid DEFAULT NULL` to
 * fn_consume_time_bank with CREATE OR REPLACE, which in Postgres does not
 * replace a function whose argument list changed: it creates a second one.
 * Every time-bank debit the engine sent from then on was refused, each
 * refusal tainted its table engine's time-bank custody for the life of the
 * process, and 42 decided SNG/Spin events could not be finished because the
 * managers holding them could no longer retire. Fixed by
 * 20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql.
 *
 * Two pins:
 *
 *  1. fn_consume_time_bank specifically: every migration that creates it with
 *     an argument list other than `(uuid, integer)` is followed, in version
 *     order, by a migration that drops `fn_consume_time_bank(uuid, integer)`,
 *     and the drop migration keeps its exact pre-image guard and its
 *     one-overload post-image assertion.
 *
 *  2. From this law forward, any migration that CREATE (OR REPLACE)s a
 *     function which an earlier migration created with a DIFFERENT argument
 *     list must drop the earlier signature, in the same file or a later one.
 *     Older files are history (CLAUDE.md check-migrations-applied: they are
 *     "intentionally stale") and are only read to learn the earlier shape.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const DROP_FILE = '20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql';
/** Files at or after this version must drop what they overload. */
const LAW_FROM = '20260928154352';

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  varchar: 'character varying',
  timestamptz: 'timestamp with time zone',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
};

/** First words of the built-in types that are spelled with a space. */
const MULTIWORD_TYPE_START = new Set(['timestamp', 'time', 'double', 'character', 'bit', 'interval', 'national']);

/** Split a top-level comma list (parentheses, e.g. numeric(12,2), stay whole). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The input types of one argument list, defaults and names removed. */
function inputTypes(args: string): string[] {
  return splitTopLevel(args)
    .map((raw) => raw.replace(/\s+(default|=)\s[\s\S]*$/i, '').trim())
    .filter((a) => !/^out\s/i.test(a))
    .map((a) => a.replace(/^(in|inout|variadic)\s+/i, ''))
    .map((a) => {
      const words = a.toLowerCase().replace(/\s+/g, ' ').split(' ');
      // "p_user_id uuid" -> uuid; a bare type ("uuid", "timestamp with time zone") stays.
      const typeWords =
        words.length > 1 && !MULTIWORD_TYPE_START.has(words[0]) ? words.slice(1) : words;
      const t = typeWords.join(' ').replace(/\(.*\)$/, '').trim();
      return TYPE_ALIASES[t] ?? t;
    });
}

interface Created {
  file: string;
  name: string;
  types: string[];
}

const CREATE_RE =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\)\s*returns/gi;
const DROP_RE = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)/gi;

const parsed = files.map((file) => {
  const sql = stripComments(readFileSync(join(DIR, file), 'utf8'));
  const creates: Created[] = [];
  const drops: Created[] = [];
  for (const m of sql.matchAll(CREATE_RE)) {
    creates.push({ file, name: m[1].toLowerCase(), types: inputTypes(m[2]) });
  }
  for (const m of sql.matchAll(DROP_RE)) {
    drops.push({ file, name: m[1].toLowerCase(), types: inputTypes(m[2]) });
  }
  return { file, sql, creates, drops };
});

const sig = (types: string[]) => types.join(',');

describe('a door the engine calls by name has one overload', () => {
  it('the engine calls fn_consume_time_bank by name with named arguments', () => {
    const engine = readFileSync(
      join(__dirname, '..', 'server', 'src', 'engine', 'ServerTableEngineBase.ts'),
      'utf8'
    );
    expect(engine).toMatch(/rpc\('fn_consume_time_bank',\s*\{/);
  });

  it('every new fn_consume_time_bank signature is followed by the drop of (uuid, integer)', () => {
    const offenders: string[] = [];
    parsed.forEach(({ file, creates }, index) => {
      for (const c of creates) {
        if (c.name !== 'fn_consume_time_bank') continue;
        if (sig(c.types) === 'uuid,integer') continue;
        const dropped = parsed
          .slice(index)
          .some(({ drops }) =>
            drops.some((d) => d.name === 'fn_consume_time_bank' && sig(d.types) === 'uuid,integer')
          );
        if (!dropped) offenders.push(`${file}: fn_consume_time_bank(${sig(c.types)})`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('the drop is guarded on its exact pre-image and asserts one door after', () => {
    const sql = readFileSync(join(DIR, DROP_FILE), 'utf8');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql.trim()).toMatch(/COMMIT;$/);
    expect(sql).toContain("'7832bfb717daaeb625372bdd3ccc7d60'");
    expect(sql).toContain("'6adbdcd86c910c09e56b4f10193d2e55'");
    expect(sql).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(sql).toContain('p_request_id uuid DEFAULT NULL::uuid');
    expect(sql).toMatch(/DROP FUNCTION public\.fn_consume_time_bank\(uuid, integer\)/);
    // Where the three-argument door does not exist, it drops nothing.
    expect(sql).toMatch(/IF v_three IS NULL THEN[\s\S]*?RETURN;/);
    expect(sql).toMatch(/post-image has % overloads, expected exactly one/);
  });

  it('from this law forward, a migration that changes a function signature drops the old one', () => {
    const lastSeen = new Map<string, string>();
    const offenders: string[] = [];
    parsed.forEach(({ file, creates }, index) => {
      for (const c of creates) {
        const previous = lastSeen.get(c.name);
        const now = sig(c.types);
        if (file >= LAW_FROM && previous !== undefined && previous !== now) {
          const dropped = parsed
            .slice(index)
            .some(({ drops }) => drops.some((d) => d.name === c.name && sig(d.types) === previous));
          if (!dropped) offenders.push(`${file}: ${c.name}(${previous}) -> (${now}) without a drop`);
        }
        lastSeen.set(c.name, now);
      }
      // A dropped signature is no longer the one a later file replaces.
      for (const d of parsed[index].drops) {
        if (lastSeen.get(d.name) === sig(d.types)) lastSeen.delete(d.name);
      }
    });
    expect(offenders).toEqual([]);
  });
});
