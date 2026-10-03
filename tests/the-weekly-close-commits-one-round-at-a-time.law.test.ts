/**
 * THE WEEKLY CLOSE COMMITS ONE ROUND AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003101805_the_weekly_close_commits_one_round_at_a_time.sql.
 * Job 272 closed each weekly book in one transaction (68 minutes for Midway on
 * 2026-10-01). With app.weekly_accounting_chunked on (set only by job 272), a
 * round that moved money commits on its own, the next attempt skips it by its
 * receipt, nothing player-facing beyond a payee's own paid invoice is issued
 * before the attempt that finds every round committed, and the P&L evidence is
 * proved step by step with each problem-free step kept for that close.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003101805_the_weekly_close_commits_one_round_at_a_time.sql'
  ),
  'utf8'
);

describe('the weekly close commits one round at a time', () => {
  it('is one transaction with live proofs, on exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(4);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    for (const m of [
      '54afb66f9cbe3dc0ba581fa9a44e344d',
      '89eb91df6635f987e523ccfe4008c8c5',
      '217f0e8444ce2e50ecf465f2be04feb8',
      'dc4c34a5db70f81222a231c3a2a32406',
      '76a1dd43e9cbb3b47a0420429b7ca8b3',
      'fecd456f7bdadb751c058f7c78a3cc29',
      '9fd829e7f49c1ca187b1fa539d1f5186',
    ]) {
      expect(sql).toContain(`IF md5(d)<>'${m}' THEN`);
    }
    expect(sql.match(/IF pg_get_functiondef\(s\)<>d THEN/g)?.length).toBe(7);
  });

  it('changes nothing unless job 272 turns the chunked close on', () => {
    expect(sql).toContain(
      "v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked', true), '') = 'on';"
    );
    expect(sql).toContain(
      "v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on';"
    );
    expect(sql).toContain(
      "WHERE COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'\n    AND current_setting('app.accounting_close_memo',true)='on'"
    );
  });

  it('commits a round that moved money and skips it by its receipt next time', () => {
    expect(sql).toContain("IF v_chunked AND v_r1->>'success' = 'true' THEN");
    expect(sql).toContain("IF v_chunked AND v_r2->>'duplicate' IS DISTINCT FROM 'true' THEN");
    expect(sql).toContain("IF v_chunked AND v_r3->>'duplicate' IS DISTINCT FROM 'true' THEN");
    expect(sql.match(/'chunk_committed', true, 'committed_round', [123],/g)?.length).toBe(3);
    // Rounds 2 and 3 answered from their unique receipt, as the stage answers a duplicate.
    expect(
      sql.match(
        /SELECT r\.result\|\|jsonb_build_object\('duplicate',true\) INTO v_r[23] FROM public\.accounting_routed_settlement_runs r/g
      )?.length
    ).toBe(2);
    // Round 1 posts its own union wallet debit when chunked.
    expect(sql).toContain(
      "PERFORM set_config('app.union_close_defer_rake_debit', CASE WHEN v_chunked THEN '' ELSE p_union_id::text || ':'"
    );
  });

  it('commits round 2 only without shortfall and round 3 only after conservation', () => {
    const r2 = sql.slice(sql.indexOf("IF v_chunked AND v_r2->>'duplicate'"));
    expect(r2.slice(0, 400)).toContain("IF (v_r2->>'shortfalls')::numeric <> 0 THEN");
    const conservation = sql.indexOf(
      '  PERFORM public.fn_union_settlement_conservation_assert(\n            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);\n\n  -- CHUNKED CLOSE (20261003): round 3'
    );
    expect(conservation).toBeGreaterThan(0);
  });

  it('keeps the run row running for a committed chunk, without a failure or a critical alert', () => {
    expect(sql).toContain(
      "WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END"
    );
    expect(
      sql.match(
        /IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN/g
      )?.length
    ).toBe(2);
    expect(
      sql.match(
        /CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END/g
      )?.length
    ).toBe(2);
    expect(sql).toContain(
      "AND d->'result'->'chunk_committed' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed"
    );
  });

  it('certifies the P&L evidence step by step and keeps only problem-free steps', () => {
    for (const kind of ['pnl_boundary', 'pnl_flows', 'pnl_touched', 'pnl_clubs', 'earned_plan']) {
      expect(sql).toContain(`public.fn_accounting_close_certify('${kind}'`);
      expect(sql).toContain(`public.fn_accounting_close_certificate('${kind}'`);
    }
    expect(sql).toContain(
      "IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify"
    );
    expect(sql).toContain("IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows'");
    expect(sql).toContain(
      "IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched'"
    );
    expect(sql).toContain(
      'IF v_cash_reconciled AND v_accepted_rake IS NOT DISTINCT FROM v_cash_rake THEN'
    );
    expect(sql.match(/'status','warming'/g)?.length).toBe(5);
    expect(sql).toContain('\'["union_pnl_certification_in_progress"]\'::jsonb THEN');
  });

  it('creates a private certificate table and three invoker functions', () => {
    expect(sql).toContain('CREATE TABLE public.accounting_close_certificates (');
    expect(sql).toContain(
      'ALTER TABLE public.accounting_close_certificates ENABLE ROW LEVEL SECURITY;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON public.accounting_close_certificates FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql.match(/^REVOKE ALL ON FUNCTION public\.fn_accounting_close_/gm)?.length).toBe(3);
    expect(sql).toContain(
      "AND c.certified_at>=p_end AND c.certified_at>clock_timestamp()-interval '12 hours'"
    );
  });

  it('runs job 272 every five minutes, idle unless a close is in progress', () => {
    expect(sql).toContain("PERFORM cron.alter_job(j, schedule:='*/5 * * * *',");
    expect(sql).toContain(
      "IF c IS DISTINCT FROM 'SET statement_timeout=''6600s''; SET app.weekly_accounting_attempt_budget=''1''; SET app.weekly_accounting_scope_budget=''100 minutes''; SELECT public.fn_union_settlement_cascade_due();' THEN"
    );
    expect(sql).toContain("set_config(''app.weekly_accounting_chunked'',''on'',false)");
    expect(sql).toContain('WHEN extract(minute FROM now()) BETWEEN 40 AND 44');
    expect(sql).toContain("CASE WHEN x.big THEN ''3600s'' ELSE ''720s'' END");
    expect(sql).not.toMatch(/cron\.schedule\s*\(/);
  });
});
