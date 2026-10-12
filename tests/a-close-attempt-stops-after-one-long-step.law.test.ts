/**
 * A CLOSE ATTEMPT STOPS AFTER ONE LONG STEP (2026-10-03).
 *
 * Pinned on migration 20261003105926_a_close_attempt_stops_after_one_long_step.sql.
 * A chunked union close attempt that proved and kept a P&L step stops once 60
 * seconds have passed since it began, so a long step (the earned plan, 440-740 s
 * at the week closing 2026-10-05) is always proved alone and never shares a
 * transaction, or job 272's 720 s statement timeout, with another one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003105926_a_close_attempt_stops_after_one_long_step.sql'
  ),
  'utf8'
);

describe('a close attempt stops after one long step', () => {
  it('is one transaction with a live proof, on the exact preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("IF md5(d)<>'c155de2fa07f15a206a5b69fbc99da19' THEN");
  });

  it('stops 60 seconds after the attempt began, or 6 minutes before its deadline', () => {
    expect(sql).toContain(
      "-COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval\n        +interval '60 seconds')"
    );
    expect(sql).toContain(
      "AND (clock_timestamp()>NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz-interval '6 minutes'"
    );
  });

  it('still stops only inside a chunked close attempt that proved a step', () => {
    expect(sql).toContain(
      "SELECT COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'\n    AND current_setting('app.accounting_close_certified',true)='on'"
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_close_warm_stop() FROM PUBLIC, anon, authenticated;'
    );
  });
});
