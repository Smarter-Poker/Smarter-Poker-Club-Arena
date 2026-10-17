/**
 * THE COMMISSION EVIDENCE CHECK READS ONLY WHAT IS UNACCRUED (2026-10-16).
 *
 * Pinned on migration
 * 20261016131916_the_commission_evidence_check_reads_only_what_is_unaccrued.sql.
 *
 * fn_assert_cash_commission_period took 77.9 s on the union week of
 * 2026-10-05 because the planner ran its per-row function predicates on all
 * 606,825 cash rake records before it looked for a missing accrued batch, and
 * one union attempt calls it twice inside job 272's 240 s tick. The unaccrued
 * candidates are now found first, in a MATERIALIZED CTE, and only they pay for
 * the function predicates. If you rewrite this check, keep that order.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261016131916_the_commission_evidence_check_reads_only_what_is_unaccrued.sql'
  ),
  'utf8'
);
const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'));

describe('the commission evidence check reads only what is unaccrued', () => {
  it('is one transaction from a pinned preimage, with a live proof and its grants', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("<> '2187b83d511186ee44503c95ff7960c2'");
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fn_assert_cash_commission_period\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_assert_cash_commission_period\([^)]*\) TO service_role;/);
  });

  it('finds unaccrued candidates before any per-row function predicate', () => {
    const cte = body.indexOf('WITH unaccrued AS MATERIALIZED');
    const status = body.indexOf("b.status IS DISTINCT FROM 'accrued'");
    const ghost = body.indexOf('fn_rake_record_is_ghost_twin');
    const launch = body.indexOf('fn_ca_launch_accounting_accepts');
    expect(cte).toBeGreaterThan(0);
    expect(status).toBeGreaterThan(cte);
    expect(ghost).toBeGreaterThan(status);
    expect(launch).toBeGreaterThan(status);
  });

  it('keeps every original condition and the same refusal', () => {
    for (const piece of [
      'r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0',
      'NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL',
      'public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id',
      'public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id',
      "RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'",
    ]) {
      expect(body).toContain(piece);
    }
  });
});
