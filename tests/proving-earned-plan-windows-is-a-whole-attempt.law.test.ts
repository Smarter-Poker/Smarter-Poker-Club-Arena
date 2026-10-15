/**
 * LAW: PROVING EARNED-PLAN WINDOWS IS A WHOLE ATTEMPT (2026-10-15).
 *
 * A chunked weekly close must commit something on every attempt, or it repeats
 * the same work for ever. On 2026-10-15 the original week (union fade0000,
 * 2026-10-05 -> 2026-10-12) proved its earned-plan windows ~120 s at a time
 * until 8 were left. Those 8 fit inside the 120 s cut, so the advance ran off
 * the end of its loop, returned TRUE, and the same attempt went on to re-prove
 * the closing boundary. Together they overran job 272's 240 s statement
 * timeout, which rolls back everything the attempt proved, so every later
 * visit (01:30, 01:35, 01:40, 02:05 UTC) did the same work and lost it.
 *
 * Root: an attempt that proved any window returns false (the report answers
 * 'warming' and the attempt commits as a certifying chunk). The next attempt
 * proves no window and continues with its whole budget. An attempt that proved
 * nothing is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015021138_proving_earned_plan_windows_is_a_whole_attempt.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('proving earned-plan windows is a whole attempt', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_accounting_union_earned_plan_advance\(uuid,timestamp with time zone,timestamp with time zone\)'::regprocedure\)\)='42d6add347b1b942aa79c95d0ec169c7'\)$/m
    );
    expect(CODE).toContain("IF md5(def)<>'b2013d3a482981080cfc7b135aa20dcd' THEN RAISE EXCEPTION");
    expect(CODE).toContain(
      "IF md5(pg_get_functiondef(sig))<>'42d6add347b1b942aa79c95d0ec169c7' THEN RAISE EXCEPTION"
    );
    expect(CODE).toContain('earned_plan_window_step_anchor_refused');
    expect(CODE).toContain('earned_plan_window_step_security_refused');
  });

  it('ends an attempt that proved a window, even the last one, and leaves a no-proof attempt unchanged', () => {
    const replacement = SQL.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    const ends = replacement.indexOf('IF proved THEN RETURN false; END IF;');
    const loop = replacement.indexOf('END LOOP;');
    const tail = replacement.indexOf('RETURN true;');
    expect(loop).toBeGreaterThan(0);
    expect(ends).toBeGreaterThan(loop);
    expect(tail).toBeGreaterThan(ends);
    const original = SQL.split('o text:=$anchor$')[1].split('$anchor$;')[0];
    expect(original).not.toContain('IF proved THEN RETURN false');
    expect(
      replacement
        .replace(/^ *--[^\n]*\n/gm, '')
        .replace(' IF proved THEN RETURN false; END IF;\n', '')
    ).toBe(original);
  });

  it('installs only while the weekly scheduler is idle and never replays', () => {
    expect(CODE).toContain(
      "IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION"
    );
    expect(CODE).toContain(
      "WHERE version='20261015021138') THEN RAISE EXCEPTION 'earned_plan_window_step_history_replay'"
    );
    expect(CODE).toContain("current_setting('ca.break_window_migration_override',true)");
  });

  it('writes no certificate, partial, cache or money', () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
