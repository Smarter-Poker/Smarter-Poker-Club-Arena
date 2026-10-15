/**
 * LAW: A PROVING WEEK ADVANCES ON ITS OWN TICK (2026-10-15).
 *
 * Once a weekly close's preparation succeeds it sits in stage 'prepared'
 * while round 2's and round 3's windows are proved. Inside a union close
 * attempt the windows come after 60 to 90 s of scheduler scans and about
 * 50 s of preparation, and the window advance stops starting windows 120 s
 * after the attempt began, so every job 272 tick proved exactly one window
 * (measured 11.7 s each). The original week (fade0000, 2026-10-05) proved 7
 * of 84 round 2 windows in 40 minutes, slower than its 12 hour proofs expire.
 *
 * Root: while a weekly close is in stage 'prepared', a chunked tick proves
 * that book's windows on its own (fn_accounting_window_advance_due) and visits
 * no scope, never starting a step with less than 75 s of its statement left.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015182133_a_proving_week_advances_on_its_own_tick.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const ADVANCE = CODE.split('CREATE FUNCTION public.fn_accounting_window_advance_due()')[1].split(
  '$function$;'
)[0];

describe('a proving week advances on its own tick', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_process_weekly_accounting_scope\(uuid,uuid\)'::regprocedure\)\)='009938740934b24744b35496477d02a1' AND to_regprocedure\('public\.fn_accounting_window_advance_due\(\)'\) IS NOT NULL\)$/m
    );
    // The preimage is the calculating-week advance's postimage, and it must be installed first.
    expect(CODE).toContain("IF md5(def)<>'a497381284a4f68b573cbf08ce1929e3' THEN RAISE EXCEPTION");
    expect(CODE).toContain("version='20261015173123') THEN RAISE EXCEPTION 'window_advance_requires_split_advance'");
    expect(CODE).toContain(
      "IF md5(pg_get_functiondef(sig))<>'009938740934b24744b35496477d02a1' THEN RAISE EXCEPTION"
    );
    expect(CODE).toContain('window_advance_anchor_refused');
    expect(CODE).toContain('window_advance_security_refused');
    expect(CODE).toContain("'536acae0c83352aa3cecf4bd95082f6d' THEN RAISE EXCEPTION 'window_advance_pending_changed'");
  });

  it('proves windows only for a weekly close in stage prepared, through the platform path', () => {
    expect(ADVANCE).toContain("q.status='running' AND q.result->>'chunk_committed'='true' AND q.result->>'stage'='prepared'");
    expect(ADVANCE).toContain('public.fn_accounting_close_windows_pending(');
    expect(ADVANCE).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
  });

  it('never starts a step without 75 s of the statement left, and stops windows 70 s before it ends', () => {
    expect(ADVANCE).toContain(
      "stmt_end:=statement_timestamp()+current_setting('statement_timeout')::interval;"
    );
    expect(ADVANCE).toContain("EXIT WHEN stmt_end-clock_timestamp()<interval '75 seconds';");
    expect(ADVANCE).toContain("(stmt_end-interval '190 seconds'+budget)::text");
    expect(ADVANCE).toContain("OR current_setting('statement_timeout') IN ('0','0ms') THEN");
    expect(ADVANCE).toContain('EXIT WHEN did IS DISTINCT FROM true;');
  });

  it('runs before any scope is visited, only on a chunked tick, and visits nothing when it advanced', () => {
    const replacement = SQL.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    const original = SQL.split('o text:=$anchor$')[1].split('$anchor$;')[0];
    expect(original.trim()).toBe(
      "v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);"
    );
    expect(replacement.endsWith(original)).toBe(true);
    expect(replacement).toContain('IF v_chunked THEN');
    expect(replacement).toContain('public.fn_accounting_window_advance_due()');
    expect(replacement).toContain("'visited_scopes',0,'more_remaining',true");
  });

  it('is callable by no client role', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_window_advance_due() FROM PUBLIC, anon, authenticated;'
    );
  });
});
