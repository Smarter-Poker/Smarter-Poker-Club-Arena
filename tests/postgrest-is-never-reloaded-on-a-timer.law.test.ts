/**
 * ===========================================================================
 *  LAW: POSTGREST IS NEVER RELOADED ON A TIMER
 * ===========================================================================
 *
 * 2026-08-31: PostgREST answered live traffic with 503 PGRST002 ("Could not
 * query the database for the schema cache") in bursts of thousands, 81,329 in
 * the 24 hours from 12:00 UTC. The cause was measured that day and fixed at
 * its source by 20260831142242_fix_pgrst002_schema_cache_timeout: PostgREST
 * loads its schema cache over a connection logged in as `authenticator`,
 * which carried an 8s statement_timeout, and the load needed 18-31s, so every
 * reload was killed half way. `ALTER ROLE authenticator SET statement_timeout
 * = '5min'` gave the load room to finish.
 *
 * Five hours later a timer was added on top of it:
 * 20260831193507_the_pgrst_watchdog_learns_to_bark scheduled
 * ca-pgrst-reload-if-stale, which sends `NOTIFY pgrst, 'reload schema'` every
 * five minutes whenever any reload-triggering DDL ran in the last fifteen.
 * PostgREST is already told about every DDL by the pgrst_ddl_watch event
 * trigger, so the timer re-sends a reload PostgREST has already done.
 *
 * MEASURED 2026-09-22 (Supabase postgrest logs, one 24h window at a time):
 *   - PostgREST recovers from a failed load BY ITSELF. 2026-09-09 04:40:07 a
 *     DDL-triggered reload failed on a lock ("Failed to load the schema cache
 *     ... 55P03"); PostgREST retried on its own and loaded at 04:41:19. Again
 *     04:55:18 -> 04:56:00. The timer's sends in that window (04:45:00,
 *     05:00:00) each loaded normally and ended no burst.
 *   - 2026-09-10 02:34:35 the database restarted. PostgREST logged "Retrying
 *     listening for database notifications in 1/1/2/4/8 seconds", reconnected
 *     at 02:35:05 and loaded at 02:35:09. The timer sent nothing between 02:30
 *     and 02:40.
 *   - PGRST002 per day, 2026-09-11 through 2026-09-22: 0 every day.
 *   - The timer sent 269 reloads in the last 7 days, each minutes after
 *     PostgREST had already loaded the same schema, and each one
 *     re-introspecting 1,351 relations and 2,814 functions and re-initialising
 *     the connection pool.
 *
 * So the recovery the timer was built to force is one PostgREST performs on
 * its own, the timer ended no burst in any window measured, and the failure
 * that made the original wedge permanent (a load killed at 8s, every time) is
 * gone while the authenticator timeout holds.
 *
 * WHAT THIS LAW PINS
 *
 *   1. The root fix stays: the 5min authenticator timeout is present, and no
 *      migration after it sets that timeout below two minutes or resets it.
 *      (pgrst-reload-watchdog, an observer that is kept, checks the same
 *      thing on the live role every fifteen minutes.)
 *   2. From 20260922141524 no migration schedules a reload: no cron job whose
 *      command notifies pgrst, calls fn_ca_pgrst_reload_if_stale, or calls a
 *      function declared to notify pgrst; and fn_ca_pgrst_reload_if_stale is
 *      not declared again. A migration may still send ONE reload when it lands.
 *   3. The detectors are live against the shapes they refuse and allow.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): the watchdog's own body
 * quotes "ALTER ROLE authenticator SET statement_timeout = ''5min''" inside a
 * string literal, and headers quote everything. Statements are therefore
 * LOCATED in a copy with comments and literals blanked, and their values are
 * READ from a copy with only comments blanked, at the same offsets.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ROOT_FIX = '20260831142242_fix_pgrst002_schema_cache_timeout.sql';
const FORWARD_GUARD_FROM = '20260922141524';
const MIN_AUTHENTICATOR_TIMEOUT_MS = 2 * 60 * 1000;

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

/**
 * Blank SQL comments always, and single-quoted literals when `literals` is
 * true. Offsets and newlines are preserved, so an index found in one copy is
 * valid in the other. Dollar quotes are transparent: a function body is code.
 */
const blankSql = (sql: string, literals: boolean): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      if (literals) blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

/** A statement_timeout value as Postgres reads it, in milliseconds. */
const toMs = (raw: string): number | null => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(raw);
  if (!m) return null;
  const unit = (m[2] ?? 'ms').toLowerCase();
  const scale: Record<string, number> = {
    us: 0.001,
    ms: 1,
    s: 1000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(m[1]) * scale[unit];
};

const AUTHENTICATOR_SETTING =
  /\bALTER\s+(?:ROLE|USER)\s+"?authenticator"?\s+(?:IN\s+DATABASE\s+\S+\s+)?(SET|RESET)\s+(statement_timeout|ALL)\b/gi;

/** Every statement in `sql` that would leave authenticator under two minutes. */
const timeoutOffendersIn = (sql: string): string[] => {
  const code = blankSql(sql, true);
  const values = blankSql(sql, false);
  const found: string[] = [];
  for (const m of code.matchAll(AUTHENTICATOR_SETTING)) {
    const verb = m[1].toUpperCase();
    const what = m[2].toLowerCase();
    if (verb === 'RESET') {
      found.push(`resets authenticator ${what}, which drops the 5min schema-cache timeout`);
      continue;
    }
    if (what !== 'statement_timeout') continue;
    const after = values.substring((m.index ?? 0) + m[0].length);
    const v = /^\s*(?:=|TO)\s*(?:'([^']*)'|([0-9][0-9a-z.]*))/i.exec(after);
    const ms = v ? toMs(v[1] ?? v[2] ?? '') : null;
    if (ms === null) {
      found.push('sets an authenticator statement_timeout this law cannot read');
    } else if (ms < MIN_AUTHENTICATOR_TIMEOUT_MS) {
      found.push(`sets authenticator statement_timeout to ${v?.[1] ?? v?.[2]}, under two minutes`);
    }
  }
  return found;
};

/** Functions this SQL declares whose body sends a PostgREST reload. */
const notifyingFunctionsIn = (sql: string): string[] => {
  const code = blankSql(sql, true);
  const values = blankSql(sql, false);
  const names: string[] = [];
  for (const m of code.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(/gi
  )) {
    const from = (m.index ?? 0) + m[0].length;
    const as = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(values.substring(from));
    if (!as) continue;
    const bodyStart = from + (as.index ?? 0) + as[0].length;
    const bodyEnd = values.indexOf(as[1], bodyStart);
    const body = values.substring(bodyStart, bodyEnd < 0 ? values.length : bodyEnd);
    if (/\bNOTIFY\s+pgrst\b|\bpg_notify\s*\(\s*'pgrst'/i.test(body)) names.push(m[1].toLowerCase());
  }
  return names;
};

/** The full text of every cron.schedule(...) call, literals included. */
const cronCallsIn = (sql: string): string[] => {
  const code = blankSql(sql, true);
  const values = blankSql(sql, false);
  const calls: string[] = [];
  for (const m of code.matchAll(/\bcron\s*\.\s*schedule\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    calls.push(values.substring(m.index ?? 0, close < 0 ? values.length : close + 1));
  }
  return calls;
};

const RELOAD = /\bNOTIFY\s+pgrst\b|\bpg_notify\s*\(\s*'pgrst'|\bfn_ca_pgrst_reload_if_stale\b/i;

/** Every way a migration could put PostgREST reloads back on a timer. */
const timerOffendersIn = (sql: string, notifying: ReadonlySet<string>): string[] => {
  const found: string[] = [];
  for (const call of cronCallsIn(sql)) {
    const named = [...notifying].find((fn) => new RegExp(`\\b${fn}\\b`, 'i').test(call));
    if (RELOAD.test(call) || named) {
      found.push(`schedules a PostgREST reload: ${call.replace(/\s+/g, ' ').trim()}`);
    }
  }
  if (
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?fn_ca_pgrst_reload_if_stale\b/i.test(
      blankSql(sql, true)
    )
  ) {
    found.push('declares fn_ca_pgrst_reload_if_stale again');
  }
  return found;
};

describe('PostgREST is never reloaded on a timer', () => {
  describe('the root fix stays', () => {
    it('the 5min authenticator timeout is declared in code, not only in prose', () => {
      const code = blankSql(read(ROOT_FIX), true);
      const values = blankSql(read(ROOT_FIX), false);
      const m = /\bALTER\s+ROLE\s+authenticator\s+SET\s+statement_timeout\b/i.exec(code);
      expect(m).not.toBeNull();
      const after = values.substring((m?.index ?? 0) + (m?.[0].length ?? 0));
      expect(after).toMatch(/^\s*=\s*'5min'/);
      expect(timeoutOffendersIn(read(ROOT_FIX))).toEqual([]);
    });

    it('no migration since the root fix sets it under two minutes or resets it', () => {
      const offenders: string[] = [];
      for (const file of readdirSync(MIGRATIONS)) {
        if (!file.endsWith('.sql') || file < ROOT_FIX) continue;
        for (const why of timeoutOffendersIn(read(file))) offenders.push(`${file}: ${why}`);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('the detectors are live', () => {
    it.each([
      ["ALTER ROLE authenticator SET statement_timeout = '8s';"],
      ['ALTER ROLE authenticator SET statement_timeout TO 60000;'],
      ["ALTER ROLE authenticator IN DATABASE postgres SET statement_timeout = '90s';"],
      ['ALTER ROLE authenticator RESET statement_timeout;'],
      ['ALTER ROLE authenticator RESET ALL;'],
    ])('refuses the timeout shape: %s', (shape) => {
      expect(timeoutOffendersIn(shape).length).toBeGreaterThan(0);
    });

    it.each([
      ["ALTER ROLE authenticator SET statement_timeout = '5min';"],
      ["ALTER ROLE authenticator SET statement_timeout TO '300s';"],
      ["ALTER ROLE authenticator SET pgrst.db_pre_request = 'smarter_private.fn_x';"],
      // Prose inside a literal - the watchdog's restore hint - is not a statement.
      ["SELECT 'ALTER ROLE authenticator SET statement_timeout = ''8s''';"],
    ])('allows the timeout shape: %s', (shape) => {
      expect(timeoutOffendersIn(shape)).toEqual([]);
    });

    it.each([
      ["SELECT cron.schedule('r', '*/5 * * * *', $$NOTIFY pgrst, 'reload schema'$$);"],
      ["SELECT cron.schedule('r', '*/5 * * * *', 'select public.fn_ca_pgrst_reload_if_stale();');"],
      ["SELECT cron.schedule('r', '* * * * *', $c$select pg_notify('pgrst', 'reload schema')$c$);"],
      [
        'CREATE OR REPLACE FUNCTION public.fn_ca_pgrst_reload_if_stale() RETURNS jsonb LANGUAGE sql AS $$ select null::jsonb $$;',
      ],
    ])('refuses the timer shape: %s', (shape) => {
      expect(timerOffendersIn(shape, new Set(notifyingFunctionsIn(shape))).length).toBeGreaterThan(
        0
      );
    });

    it('refuses a timer that reaches the reload through a function of its own', () => {
      const shape =
        "CREATE FUNCTION public.fn_x() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN NOTIFY pgrst, 'reload schema'; END $f$;\n" +
        "SELECT cron.schedule('y', '0 * * * *', $$select public.fn_x()$$);";
      expect(notifyingFunctionsIn(shape)).toEqual(['fn_x']);
      expect(timerOffendersIn(shape, new Set(notifyingFunctionsIn(shape))).length).toBeGreaterThan(
        0
      );
    });

    it.each([
      // The observer that stays: it reads the reload rate, it never reloads.
      [
        "SELECT cron.schedule('pgrst-reload-watchdog', '6,21,36,51 * * * *', $$select public.fn_pgrst_reload_watchdog()$$);",
      ],
      // One reload when a migration lands is not a timer.
      ["NOTIFY pgrst, 'reload schema';"],
      // Retiring the timer is the point of this law.
      ["SELECT cron.unschedule('ca-pgrst-reload-if-stale');"],
      ['DROP FUNCTION IF EXISTS public.fn_ca_pgrst_reload_if_stale(interval, interval);'],
      // Prose is not a schedule.
      ["-- SELECT cron.schedule('r', '*/5 * * * *', $$NOTIFY pgrst$$);\nSELECT 1;"],
    ])('allows: %s', (shape) => {
      expect(timerOffendersIn(shape, new Set(notifyingFunctionsIn(shape)))).toEqual([]);
    });
  });

  it('THE ONE THAT MATTERS LATER: nothing from 20260922141524 puts a reload on a timer', () => {
    const forward = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f >= FORWARD_GUARD_FROM)
      .sort();
    const notifying = new Set(forward.flatMap((f) => notifyingFunctionsIn(read(f))));
    const offenders: string[] = [];
    for (const file of forward) {
      for (const why of timerOffendersIn(read(file), notifying)) offenders.push(`${file}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });
});
