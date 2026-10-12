/**
 * ===========================================================================
 *  LAW: A CANCELLED FEE THAT WAS NEVER CAPTURED IS CANCELLED, NOT DEFERRED
 *  (2026-10-06)
 * ===========================================================================
 *
 * Four cancelled satellites stopped the 2026-09-28 weekly close for Midway
 * Union and Deep Stack Society. Their entry fees were charged before fee-source
 * capture existed (no accounting_tournament_fee_batches row, no fee sources)
 * and atomic_cancel_tournament refunded them in full under an exact-zero
 * cancellation receipt. fn_accounting_tournament_fee_net_plan demanded a
 * captured batch for every positive fee row BEFORE it looked at the refunds,
 * raised 55000 tournament_fee_sources_require_reconciliation, and the
 * cancellation path filed each event 'banked_accrual_deferred', which
 * fn_accounting_tournament_week_quality refuses for ever.
 *
 * The rule is fixed in the net plan itself (20261006140724): only when the
 * tournament's raw fee total is exactly zero, a positive row with no batch and
 * no source that an atomic_cancel_tournament reversal names, under a receipt
 * with total_rake_after = 0 and fees_reversed = total_rake_before, is excused
 * from the capture check, and must then be proved refunded by the unchanged
 * refund loop. An earnable or partially reversed fee, a captured fee, a fee
 * with sources, or an unregistration refund is judged exactly as before.
 *
 * This pins the substitution and its guards, the in-transaction restatement
 * of exactly the four recognitions, and refuses any later migration that
 * re-declares the net plan without the rule.
 */
import { describe, expect, it } from 'vitest';
import { migrationFiles, readMigration } from './helpers/migrations';

const FIXED_IN = '20261006140724_a_cancelled_fee_that_was_never_captured_is_cancelled_not_def.sql';
const FOUR = [
  '097e3601-ccf9-4035-af40-eb35068d2652',
  '20c75b67-7f78-4b29-b7df-9594faf62af0',
  '92c93927-614f-4168-a1f9-918849c0be19',
  'a4262ba0-cd5f-4a94-a0f8-915a028cf3a7',
];

const sql = () => readMigration(FIXED_IN);

describe('a cancelled fee that was never captured is cancelled, not deferred', () => {
  it('exists, in one transaction, outside nothing', () => {
    expect(migrationFiles()).toContain(FIXED_IN);
    const s = sql();
    expect(s.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(s.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(s).toContain("SET LOCAL lock_timeout = '5s';");
    expect(s).toContain('@live-proof:');
  });

  it('patches the pinned net plan by exact-count substitution and proves the postimage', () => {
    const s = sql();
    expect(s).toContain("v_pin constant text := '9b1147a5b373e2a01e3374b8dd2cc2fa'");
    expect(s).toContain("IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S1 anchor");
    expect(s).toContain("IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S2 anchor");
    expect(s).toContain("IF v_n <> 1 THEN RAISE EXCEPTION 'net_plan: S3 anchor");
    expect(s).toContain('the reverse substitution does not reproduce the pinned text');
  });

  it('excuses a positive row only when every guard holds', () => {
    const s = sql();
    // only a tournament that nets to exactly zero
    expect(s).toContain("E' IF raw_total=0 THEN\\n'");
    // never a row that was captured, or that has a source
    expect(s).toContain('NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)');
    expect(s).toContain('NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)');
    // only an atomic cancellation reversal, listed in an exact-zero receipt
    expect(s).toContain("n.source=''atomic_cancel_tournament'' AND n.rake_amount<0");
    expect(s).toContain('n.id=ANY(c.fee_reversal_ids)');
    expect(s).toContain('c.total_rake_after=0 AND c.fees_reversed=c.total_rake_before');
    // the capture check itself is untouched for every other row
    expect(s).toContain('WHERE r.id=ANY(positive_ids) AND NOT(r.id=ANY(cancelled_uncaptured)) AND ((b.status');
    // and every excused row must be refunded by the unchanged loop
    expect(s).toContain('IF NOT(cancelled_uncaptured<@refunded) THEN');
    expect(s).toContain('tournament_fee_uncaptured_cancellation_not_reversed');
  });

  it('never excuses an unregistration refund', () => {
    const s = sql();
    const excused = s.slice(s.indexOf("E' IF raw_total=0 THEN"), s.indexOf("E' END IF;\\n'"));
    expect(excused).not.toContain('fn_unregister_from_tournament');
  });

  it('restates exactly the four recognitions read on 2026-10-06, through the proven plan', () => {
    const s = sql();
    for (const id of FOUR) expect(s).toContain(`'${id}'`);
    expect(s).toContain('expected exactly the four deferred recognitions read on 2026-10-06');
    expect(s).toContain('v_plan := public.fn_accounting_tournament_fee_net_plan(v_id);');
    expect(s).toContain("SET status = 'cancelled'");
    expect(s).toContain("net_rake = (v_plan->>'net_fee')::numeric");
    // recognized_at, the original cancellation instant, is never rewritten
    expect(s).not.toMatch(/SET[\s\S]{0,200}recognized_at\s*=/);
    // no money: the restatement writes no wallet, ledger or commission row
    const restate = s.slice(s.indexOf('DO $r$'));
    expect(restate).not.toMatch(/INSERT INTO public\.(agent_commissions|chip_ledger|union_wallet_transactions|accounting_tournament_recognized_sources)/);
  });

  it('turns the immutability trigger off only inside the transaction, and back on', () => {
    const s = sql();
    const off = s.indexOf('DISABLE TRIGGER accounting_tournament_fee_recognitions_immutable');
    const on = s.indexOf('ENABLE TRIGGER accounting_tournament_fee_recognitions_immutable');
    expect(off).toBeGreaterThan(s.indexOf('BEGIN;'));
    expect(on).toBeGreaterThan(off);
    expect(on).toBeLessThan(s.lastIndexOf('COMMIT;'));
    expect(s).toContain('the recognition immutability trigger is not enabled');
  });

  it('is not silently undone by a later declaration of the net plan', () => {
    const later = migrationFiles().filter((f) => f > FIXED_IN);
    for (const f of later) {
      const body = readMigration(f);
      if (body.includes('FUNCTION public.fn_accounting_tournament_fee_net_plan(')) {
        expect(body, `${f} re-declares the net plan`).toContain('cancelled_uncaptured');
      }
    }
  });
});
