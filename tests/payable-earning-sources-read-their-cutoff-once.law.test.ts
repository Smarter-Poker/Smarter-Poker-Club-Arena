/**
 * LAW: PAYABLE EARNING SOURCES READ THEIR CUTOFF ONCE (2026-10-15).
 *
 * accounting_payable_earning_sources called the SECURITY DEFINER helper
 * fn_ca_launch_accounting_accepts once per row (twice per tournament row).
 * The planner cannot inline it, so a week of the union's sources took about
 * 175 s and the scheduler's scope selection about 40 s per tick, and the
 * original week (2026-10-05 to 2026-10-12) could never close inside the
 * 240 s tick.
 *
 * Root: the active cutoffs are read once through
 * fn_ca_launch_accounting_club_cutoffs() and joined, with the helper's own
 * predicate. Proved row and md5 identical in production trials.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015094219_payable_earning_sources_read_their_cutoff_once.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const VIEW = CODE.split(
  'CREATE OR REPLACE VIEW public.accounting_payable_earning_sources'
)[1].split('DO $post$')[0];

describe('payable earning sources read their cutoff once', () => {
  it('is one transaction with a live proof and an exact preimage', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT position\('fn_ca_launch_accounting_club_cutoffs'/m
    );
    expect(CODE).toContain("<>'a6fc7948eac00658f2302ad19833719f' THEN RAISE EXCEPTION");
    expect(CODE).toContain('payable_cutoff_one_active_refused');
    expect(CODE).toContain('payable_cutoff_columns_refused');
    expect(CODE).toContain('payable_cutoff_security_refused');
    expect(CODE).toContain('payable_cutoff_postimage_refused');
  });

  it('never calls the per-row helper, and joins the cutoffs once per branch', () => {
    expect(VIEW).not.toContain('fn_ca_launch_accounting_accepts');
    expect(
      VIEW.match(
        /LEFT JOIN public\.fn_ca_launch_accounting_club_cutoffs\(\) bd ON bd\.club_id = s\.club_id/g
      )
    ).toHaveLength(2);
    expect(VIEW).toContain('WITH (security_invoker=true)');
  });

  it('keeps the helper predicate: no cutoff accepts, otherwise finite and at or after it', () => {
    for (const t of ['s.earned_at', 's.charged_at', 'rs.recognized_at']) {
      expect(VIEW).toContain(
        `(bd.cutoff_at IS NULL OR (${t} IS NOT NULL AND isfinite(${t}) AND ${t} >= bd.cutoff_at))`
      );
    }
  });

  it('the cutoff reader is service role only and writes nothing', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_club_cutoffs() FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_launch_accounting_club_cutoffs() TO service_role;'
    );
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
