/**
 * A CLOSE ATTEMPT ENDS BEFORE ITS TICK DOES (2026-10-16).
 *
 * Pinned on migration 20261016142840_a_close_attempt_ends_before_its_tick_does.sql.
 *
 * fn_weekly_accounting_attempt_begin measured the attempt's deadline from the
 * start of the visit, so a union visit that began two minutes into job 272's
 * 240 s tick thought it had until 5:07 and was cancelled at 4:00 with nothing
 * kept. The deadline is now the earlier of the scope budget and 60 seconds
 * before the statement's own timeout. Do not measure it from the visit alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261016142840_a_close_attempt_ends_before_its_tick_does.sql'),
  'utf8'
);

describe('a close attempt ends before its tick does', () => {
  it('is one transaction from a pinned preimage with a live proof', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("<> 'bdbe82fff199127130d2f9320236974c'");
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
  });

  it('caps the deadline 60 seconds before the statement timeout', () => {
    expect(sql).toContain("NULLIF(current_setting('statement_timeout'),'0')::interval");
    expect(sql).toContain("LEAST(v_deadline,statement_timestamp()+v_timeout-interval '60 seconds')");
    expect(sql).toContain("PERFORM set_config('app.weekly_accounting_scope_deadline',v_deadline::text,true);");
  });

  it('keeps every memo the attempt clears', () => {
    for (const k of [
      'app.accounting_close_memo',
      'app.accounting_earned_plan_memo',
      'app.union_pnl_evidence_memo',
      'app.accounting_cash_refusal_memo',
      'app.accounting_close_certified',
    ]) {
      expect(sql).toContain(`'${k}'`);
    }
  });
});
