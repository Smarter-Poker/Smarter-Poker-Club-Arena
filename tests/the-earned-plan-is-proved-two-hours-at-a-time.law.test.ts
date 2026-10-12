/**
 * THE EARNED PLAN IS PROVED TWO HOURS AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003140241_the_earned_plan_is_proved_two_hours_at_a_time.sql.
 * Inside a chunked union close the earned plan is proved per two-hour window of
 * the closed week by the set path itself, kept in an unlogged cache, and
 * combined into the identical plan (sums of exact numeric sums, the same basis
 * rate and payout, the same ordered md5 fingerprint), so no close transaction
 * proves the whole week's plan in one statement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003140241_the_earned_plan_is_proved_two_hours_at_a_time.sql'
  ),
  'utf8'
);

describe('the earned plan is proved two hours at a time', () => {
  it('is one transaction with live proofs, on exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    for (const m of [
      'c7548ae4cfa6ff517316bee6715447b4',
      '18e01899de9b60bd34ad9f8c15920fbb',
      'b2d68af9c148c5ab69af9a8c2948b9a7',
    ]) {
      expect(sql).toContain(`IF md5(d)<>'${m}' THEN`);
    }
    expect(sql.match(/ THEN RAISE EXCEPTION '[a-z ]+ postimage differs/g)?.length).toBe(3);
  });

  it('derives the window from the set path and keeps its six proofs', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)\n RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)'
    );
    expect(sql).toContain(
      'IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0 OR res.other_types<>0 THEN\n  RETURN;'
    );
  });

  it('combines exact sums, the same basis and the same ordered fingerprint', () => {
    expect(sql).toContain(
      "IF src IS DISTINCT FROM bank THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;"
    );
    expect(sql).toContain(
      "CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate"
    );
    expect(sql).toContain("trunc(sum((e->>'weighted')::numeric),2) AS payout");
    expect(sql).toContain(
      "string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)"
    );
    expect(sql).toContain(
      "AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours'"
    );
  });

  it('runs only inside a chunked close and never starts a window late', () => {
    expect(
      sql.match(
        /IF COALESCE\(current_setting\('app\.weekly_accounting_chunked',true\),''\)<>'on'\n  OR current_setting\('app\.accounting_close_memo',true\) IS DISTINCT FROM 'on'/g
      )?.length
    ).toBe(2);
    expect(sql).toContain(
      "IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;"
    );
    expect(sql).toContain(
      'PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);'
    );
    expect(sql).toContain(
      'IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN'
    );
  });

  it('keeps the cache unlogged, private and out of reach', () => {
    expect(sql).toContain('CREATE UNLOGGED TABLE public.accounting_close_partials (');
    expect(sql).toContain(
      'REVOKE ALL ON public.accounting_close_partials FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });
});
