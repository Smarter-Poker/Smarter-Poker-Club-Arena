/**
 * LAW: THE SETTLEMENT CHECK COUNTS NO REFUND (2026-10-11).
 *
 * fn_ca_tournament_settlement_mismatch compares what a finished event paid
 * against GREATEST(prize_pool, guaranteed_prize). It summed every non-bounty
 * wallet credit as "paid", so a registration refund (a buy-in handed back
 * before it became prize money) read as an overpay of exactly that refund:
 * 22 events in 30 days, each over by 5 to 480 chips, every excess equal to the
 * event's refunds to the cent, and nobody overpaid. The same refund could hide
 * a real underpayment from the CRITICAL ratchet tournament_underpaid_48h.
 *
 * Its sibling fn_ca_prize_overpay_unexplained already excluded refunds
 * (2026-10-05). Both readers must agree on what a payout is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const FIX = read('supabase/migrations/20261011200528_the_settlement_check_counts_no_refund.sql');

describe('the settlement check counts no refund', () => {
  it('one transaction, a live proof, a pinned preimage, an exact-once anchor and a proof block', () => {
    expect(FIX.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FIX.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FIX).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(FIX).toMatch(/^-- @live-proof: /m);
    expect(FIX).toMatch(/REFUND_NOT_PRIZE_PREIMAGE_CHANGED/);
    expect(FIX).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION 'REFUND_NOT_PRIZE_ANCHOR_CHANGED/);
    expect(FIX).toMatch(/DO \$prove\$/);
    expect(FIX.replace(/--[^\n]*/g, '')).not.toMatch(
      /\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT|REVOKE)\b/i
    );
  });

  it('a refund credit is not counted as paid, exactly as the overpay reader already reads it', () => {
    expect(FIX).toContain("AND COALESCE(w.category, '') NOT IN ('bounty', 'refund')), 0)");
    // The anchor it replaces is the old bounty-only exclusion, matched once.
    expect(FIX).toContain("AND COALESCE(w.category, '') <> 'bounty'), 0)\n$a$,");
  });

  it('the proof re-measures the whole 30 days and expects no mismatch', () => {
    expect(FIX).toContain("FROM public.fn_ca_tournament_settlement_mismatch('30 days'::interval);");
    expect(FIX).toMatch(/IF v_bad <> 0 THEN\s*RAISE EXCEPTION 'REFUND_NOT_PRIZE_RESULT_CHANGED/);
  });

  it('moves no money and writes no row: only the read-only check function changes', () => {
    const body = FIX.replace(/--[^\n]*/g, '');
    expect(body).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
    expect(body).not.toMatch(/fn_credit_and_log|fn_tournament_payout_reconcile/);
  });
});
