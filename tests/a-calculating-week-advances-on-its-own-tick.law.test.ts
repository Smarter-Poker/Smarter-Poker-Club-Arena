/**
 * LAW: A CALCULATING WEEK ADVANCES ON ITS OWN TICK (2026-10-15).
 *
 * A closed club-week's split recompute is well over a hundred parts. Inside a
 * union close attempt each part sat behind 60 to 90 s of scheduler scans and
 * about 50 s of preparation, so a 240 s job 272 tick had room for one part,
 * and a part that overran the statement rolled the whole attempt back with
 * it. From 15:26 to 16:30 UTC the original week (fade0000, 2026-10-05) gained
 * two parts against a 12 hour part expiry: it could never finish.
 *
 * Root: while a closed club-week is part way through its split, a chunked
 * tick advances those parts (fn_accounting_split_advance_due) and visits no
 * scope, and never starts a part with less than 90 s of its statement left,
 * so every part it starts commits.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015173123_a_calculating_week_advances_on_its_own_tick.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const ADVANCE = CODE.split('CREATE FUNCTION public.fn_accounting_split_advance_due()')[1].split(
  '$function$;'
)[0];

describe('a calculating week advances on its own tick', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_process_weekly_accounting_scope\(uuid,uuid\)'::regprocedure\)\)='a497381284a4f68b573cbf08ce1929e3' AND to_regprocedure\('public\.fn_accounting_split_advance_due\(\)'\) IS NOT NULL\)$/m
    );
    expect(CODE).toContain("IF md5(def)<>'e6960e3960fde66c11578438692c57b1' THEN RAISE EXCEPTION");
    expect(CODE).toContain(
      "IF md5(pg_get_functiondef(sig))<>'a497381284a4f68b573cbf08ce1929e3' THEN RAISE EXCEPTION"
    );
    expect(CODE).toContain('split_advance_anchor_refused');
    expect(CODE).toContain('split_advance_security_refused');
    expect(CODE).toContain(
      "'6b2a9c08ba56ea9f65b31a1cc80c3351' THEN RAISE EXCEPTION 'split_advance_split_changed'"
    );
  });

  it('never starts a part without 90 s of the statement left, and gives each club-week the split\'s own 90 s', () => {
    expect(ADVANCE).toContain(
      "stmt_end:=statement_timestamp()+current_setting('statement_timeout')::interval;"
    );
    expect(ADVANCE).toContain(
      "remaining:=LEAST(interval '90 seconds',stmt_end-interval '75 seconds'-clock_timestamp());"
    );
    expect(ADVANCE).toContain("EXIT WHEN remaining<interval '15 seconds';");
    expect(ADVANCE).toContain(
      "(clock_timestamp()+remaining-interval '90 seconds'+budget)::text"
    );
    expect(ADVANCE).toContain("OR current_setting('statement_timeout') IN ('0','0ms') THEN");
    expect(ADVANCE).toContain('public.fn_rakeback_recompute_split(w.club_id,w.period_start,w.period_end)');
  });

  it('reports a club-week that finishes blocked instead of hiding it', () => {
    expect(ADVANCE).toContain("r->>'status' NOT IN ('in_progress','ready')");
    expect(ADVANCE).toContain("'A weekly club calculation finished blocked'");
  });

  it('runs before any scope is visited, only on a chunked tick, and visits nothing when it advanced', () => {
    const replacement = SQL.split('n text:=$anchor$')[1].split('$anchor$;')[0];
    const original = SQL.split('o text:=$anchor$')[1].split('$anchor$;')[0];
    expect(original.trim()).toBe(
      "v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);"
    );
    expect(replacement.endsWith(original)).toBe(true);
    expect(replacement).toContain('IF v_chunked THEN');
    expect(replacement).toContain("IF v_seal->>'advanced'='true' THEN");
    expect(replacement).toContain("'visited_scopes',0,'more_remaining',true");
  });

  it('is callable by no client role', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_split_advance_due() FROM PUBLIC, anon, authenticated;'
    );
  });
});
