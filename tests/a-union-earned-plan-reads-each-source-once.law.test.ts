/**
 * A UNION'S EARNED PLAN READS EACH SOURCE ONCE (2026-10-03).
 *
 * Pinned on migration 20261003081000_a_union_earned_plan_reads_each_source_once.sql. fn_accounting_union_earned_plan_v3 proved a
 * union's earned plan in nine statements that re-read the week's sources and
 * probed three tables per bank receipt (~3.4 ms a receipt, ~28 minutes for the
 * open week). fn_accounting_union_earned_plan_sets certifies the identical
 * plan in one statement; the wrapper asks it first and runs v3 whenever it
 * answers NULL, so every refusal is still v3's own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003081000_a_union_earned_plan_reads_each_source_once.sql'
  ),
  'utf8'
);

const fnStart = sql.indexOf(
  'CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_sets('
);
const fnEnd = sql.indexOf('$function$;', fnStart);
const fn = sql.slice(fnStart, fnEnd);

describe("a union's earned plan reads each source once", () => {
  it('is one transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('creates a STABLE invoker function that no client role can execute', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fn).toMatch(/\n STABLE\n/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toContain("SET enable_indexscan TO 'off'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_sets(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('only certifies: any finding, failed conservation or error answers NULL', () => {
    expect(fn).toContain('EXCEPTION WHEN OTHERS THEN\n  RETURN NULL;');
    expect(fn).toContain(
      'IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0'
    );
    expect(fn).toContain(
      'OR res.bank_total IS NULL OR res.source_total IS DISTINCT FROM res.bank_total THEN'
    );
    // A NULL agreement verdict is treated as a finding, never as a pass.
    expect(fn).toContain('WHERE s.agreement_bad IS NOT FALSE');
    // Every cash source of a receipt's rake record is counted, in or out of the window.
    expect(fn).toContain(
      '(SELECT count(*) FROM public.accounting_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n'
    );
  });

  it('returns the same plan shape as v3', () => {
    expect(fn).toContain(
      "RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,"
    );
    expect(fn).toContain(
      "'period_rake',res.bank_total,'earned_rake',res.source_total,'house_rake',res.house_total,'source_fingerprint',res.fingerprint,'basis_detail',res.detail);"
    );
    expect(fn).toContain(
      'md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.cj)::text) AS row_md5'
    );
    expect(fn).toContain("md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),''))");
    expect(fn).toContain(
      'trunc(sum(rake_credit*rate),2) AS payout FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type'
    );
  });

  it('puts the set path in front of v3 in the wrapper, by exact anchor on the 2026-10-03 preimage', () => {
    expect(sql).toContain("IF md5(d)<>'409eade1f18decea288db84784f127b2' THEN");
    expect(sql).toContain(
      ' plan:=public.fn_accounting_union_earned_plan_sets(p_union_id,p_start,p_end);\n IF plan IS NULL THEN plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end); END IF;'
    );
    expect(sql).toMatch(/anchor count/);
  });

  it('changes no table, index or schedule', () => {
    expect(sql).not.toMatch(/^\s*(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
