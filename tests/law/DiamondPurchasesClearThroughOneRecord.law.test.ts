/**
 * LAW: A DIAMOND PURCHASE CLEARS THROUGH ONE RECORD, AND A CHARGEBACK IS A
 * DEBT, NOT A NEGATIVE BALANCE
 * ===========================================================================
 * Diamond Accounting Standard (`docs/DIAMOND-ACCOUNTING-STANDARD.md`) 3.2
 * "Purchase", 3.3 DR1 / DR8 / DR9 / DR13, section 5 "Lane D". The evidence is
 * in `docs/audits/2026-09-02-diamond-economy/lane2-ramps-bridge-and-standard.md`
 * parts A and E (gaps G1, G2, G4, G5, G9).
 *
 * Four things were true of the diamond on-ramp before Lane D, every one of
 * them measured in production rather than inferred:
 *
 *   1. The Stripe ORDER ids were not unique. Only the Stripe EVENT id was
 *      (a PK on `stripe_webhook_events`). `handleRefund` correlates by
 *      `stripe_payment_intent_id` with `.maybeSingle()`, which ERRORS the
 *      moment two rows share one, and nothing prevented that.
 *   2. `reconcile_diamond_purchase_refund` wrote `profiles.diamonds` directly
 *      and allowed a NEGATIVE balance BY DESIGN, flagged `chargeback_debt`.
 *      D13 / DR1: a chargeback larger than the balance is a RECEIVABLE.
 *   3. `charge.dispute.*` was neither subscribed at Stripe nor handled. A
 *      chargeback took the money back and the diamonds stayed in the balance.
 *   4. Purchased value was not a sub-ledger, so no customer liability could be
 *      computed and a refund could not know what it was reversing.
 *
 * This law pins the shape of the two migrations that fixed them. It reads the
 * migration TEXT, not a live database, so it runs anywhere and fails in the
 * pull request that would undo the fix.
 *
 * Every pin carries a NEGATIVE CONTROL: the same assertion is run against a
 * counterfeit body of the kind a careless "simplification" would produce, and
 * must fail there. A regex that matches nothing passes vacuously; a regex
 * checked against a counterfeit cannot.
 *
 * WHAT THIS LAW DOES NOT SAY
 *   It does not require the DR7 or DR8 checks to REFUSE anything. They are
 *   log-only by Dan's risk rule 12, and this law pins them as log-only: a
 *   future change that makes a package-price mismatch refuse a paid settle
 *   would strand a charge Stripe has already taken, and the pins below fail on
 *   it deliberately.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLEARING = 'supabase/migrations/20260903003327_diamond_d_purchase_clearing.sql';
const NONNEGATIVE =
  'supabase/migrations/20260903003403_diamond_d_the_balance_cannot_go_negative.sql';

const clearing = fs.readFileSync(path.join(process.cwd(), CLEARING), 'utf8');
const nonnegative = fs.readFileSync(path.join(process.cwd(), NONNEGATIVE), 'utf8');

/** The body of one CREATE OR REPLACE FUNCTION ... $fn$ ... $fn$; block. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('$fn$', start);
  const close = source.indexOf('$fn$;', open + 4);
  expect(open, `${name} body opens with $fn$`).toBeGreaterThan(start);
  expect(close, `${name} body closes with $fn$;`).toBeGreaterThan(open);
  return source.slice(open + 4, close);
}

const REFUND = functionBody(clearing, 'reconcile_diamond_purchase_refund');
const SETTLE = functionBody(clearing, 'settle_diamond_card_purchase_atomic');
const DISPUTE = functionBody(clearing, 'fn_diamond_purchase_dispute');

// ---------------------------------------------------------------------------
// The counterfeits. Each is what the corresponding function looked like, or
// would look like, if the defect this law exists to prevent were reintroduced.
// ---------------------------------------------------------------------------

/** The ACTUAL pre-Lane-D clawback, copied from the live pg_proc body. */
const COUNTERFEIT_REFUND = `
  IF v_delta > 0 THEN
    UPDATE public.profiles
       SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_delta,
           diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_delta, updated_at = now()
     WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata)
    VALUES (v_purchase.user_id,'refund',-v_delta,v_balance,'Stripe refund reconciliation',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_balance < 0));
  END IF;
`;

/** A settle that "validates" the package instead of recording the mismatch. */
const COUNTERFEIT_SETTLE = `
  IF v_purchase.diamonds_amount <> v_pkg.diamonds THEN
    RAISE EXCEPTION 'package_price_mismatch';
  END IF;
  v_credit := public.add_diamonds_to_balance(v_purchase.user_id, v_total, 'purchase', 'x', v_purchase.id::text);
`;

/** A dispute handler that only knows about `created`, and credits back. */
const COUNTERFEIT_DISPUTE = `
  IF p_event = 'charge.dispute.created' THEN
    UPDATE public.diamond_purchase_lots SET frozen_at = now() WHERE purchase_id = p_purchase_id;
    PERFORM public.add_diamonds_to_balance(v_purchase.user_id, 100, 'refund', 'dispute', 'x');
  END IF;
  INSERT INTO public.diamond_purchase_disputes (dispute_id, event, purchase_id, amount_cents)
  VALUES (p_dispute_id, p_event, p_purchase_id, p_amount_cents);
`;

// ===========================================================================
describe('LAW: a diamond purchase clears through one record', () => {
  // -------------------------------------------------------------------------
  // 1. The Stripe order ids are unique (D7, gap G4).
  // -------------------------------------------------------------------------
  it('makes stripe_checkout_session_id UNIQUE where it is not null', () => {
    expect(clearing).toMatch(
      /CREATE UNIQUE INDEX[^;]*ux_diamond_purchases_stripe_session[^;]*\(stripe_checkout_session_id\)[^;]*WHERE stripe_checkout_session_id IS NOT NULL/s
    );
  });

  it('makes stripe_payment_intent_id UNIQUE where it is not null', () => {
    expect(clearing).toMatch(
      /CREATE UNIQUE INDEX[^;]*ux_diamond_purchases_stripe_payment_intent[^;]*\(stripe_payment_intent_id\)[^;]*WHERE stripe_payment_intent_id IS NOT NULL/s
    );
  });

  it('NEGATIVE CONTROL: a plain non-unique index does not satisfy either pin', () => {
    const counterfeit = `
      CREATE INDEX ux_diamond_purchases_stripe_session
        ON public.diamond_purchases (stripe_checkout_session_id);
      CREATE INDEX ux_diamond_purchases_stripe_payment_intent
        ON public.diamond_purchases (stripe_payment_intent_id);
    `;
    expect(counterfeit).not.toMatch(
      /CREATE UNIQUE INDEX[^;]*ux_diamond_purchases_stripe_session[^;]*\(stripe_checkout_session_id\)[^;]*WHERE stripe_checkout_session_id IS NOT NULL/s
    );
    expect(counterfeit).not.toMatch(
      /CREATE UNIQUE INDEX[^;]*ux_diamond_purchases_stripe_payment_intent[^;]*\(stripe_payment_intent_id\)[^;]*WHERE stripe_payment_intent_id IS NOT NULL/s
    );
  });

  it('takes the write grants off anon and authenticated', () => {
    expect(clearing).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.diamond_purchases FROM anon, authenticated/
    );
  });

  it('constrains status to the four values the live code writes, NOT VALID', () => {
    expect(clearing).toMatch(
      /ADD CONSTRAINT diamond_purchases_status_known\s+CHECK \(status IN \('pending', 'completed', 'refunded', 'failed'\)\) NOT VALID/
    );
  });

  // -------------------------------------------------------------------------
  // 2. The balance cannot go negative (DR1 / D13, gap G5).
  // -------------------------------------------------------------------------
  it('adds CHECK (diamonds >= 0) on profiles and VALIDATEs it', () => {
    expect(nonnegative).toMatch(
      /ADD CONSTRAINT profiles_diamonds_nonnegative CHECK \(diamonds >= 0\) NOT VALID/
    );
    expect(nonnegative).toMatch(/VALIDATE CONSTRAINT profiles_diamonds_nonnegative/);
  });

  it('refuses to add the constraint while the refund path still writes negatives', () => {
    // The companion migration must not be applicable on its own: if
    // reconcile_diamond_purchase_refund has not been fixed yet, a chargeback
    // over the balance would raise 23514 inside the Stripe webhook and retry
    // forever. The pre-flight block is what makes the order load-bearing.
    expect(nonnegative).toContain("prosrc LIKE '%diamond_debts%'");
    expect(nonnegative).toMatch(
      /RAISE EXCEPTION 'ABORT: reconcile_diamond_purchase_refund still writes negatives/
    );
  });

  it('NEGATIVE CONTROL: a bare ADD CONSTRAINT without VALIDATE does not pass', () => {
    const counterfeit = `
      ALTER TABLE public.profiles
        ADD CONSTRAINT profiles_diamonds_nonnegative CHECK (diamonds >= 0) NOT VALID;
    `;
    expect(counterfeit).toMatch(
      /ADD CONSTRAINT profiles_diamonds_nonnegative CHECK \(diamonds >= 0\) NOT VALID/
    );
    expect(counterfeit).not.toMatch(/VALIDATE CONSTRAINT profiles_diamonds_nonnegative/);
  });

  // -------------------------------------------------------------------------
  // 3. The refund books a debt instead of a negative (DR1 / DR13).
  // -------------------------------------------------------------------------
  it('clamps the clawback at the balance', () => {
    expect(REFUND).toContain('v_applied := LEAST(v_delta, v_available);');
    expect(REFUND).toContain('v_shortfall := v_delta - v_applied;');
  });

  it('books the remainder as a diamond_debts row', () => {
    expect(REFUND).toMatch(
      /INSERT INTO public\.diamond_debts \(user_id, purchase_id, amount, reason\)/
    );
    expect(REFUND).toContain("'chargeback_exceeds_balance'");
  });

  it('never writes the unguarded negative clawback again', () => {
    // The exact expression the migration replaced. Its absence IS the fix.
    expect(REFUND).not.toContain('- v_delta');
  });

  it('journals what it actually applied, with both sides named (DR3)', () => {
    expect(REFUND).toContain("-v_applied,v_balance,'Stripe refund reconciliation'");
    expect(REFUND).toContain("'purchase_clearing','refund'");
    expect(REFUND).toContain('counterparty,issuance_class');
  });

  it('keeps the chargeback_debt flag in its result for the webhook', () => {
    expect(REFUND).toMatch(/'chargeback_debt',\s*v_shortfall > 0/);
  });

  it('raises the purchase lot refunded figure (DR9)', () => {
    expect(REFUND).toMatch(/UPDATE public\.diamond_purchase_lots\s+SET refunded =/);
  });

  it('NEGATIVE CONTROL: the pre-Lane-D clawback fails every refund pin', () => {
    expect(COUNTERFEIT_REFUND).not.toContain('v_applied := LEAST(v_delta, v_available);');
    expect(COUNTERFEIT_REFUND).not.toMatch(/INSERT INTO public\.diamond_debts/);
    expect(COUNTERFEIT_REFUND).not.toContain("'chargeback_exceeds_balance'");
    expect(COUNTERFEIT_REFUND).toContain('- v_delta'); // the defect itself
    expect(COUNTERFEIT_REFUND).not.toContain("'purchase_clearing','refund'");
    expect(COUNTERFEIT_REFUND).not.toMatch(/'chargeback_debt',\s*v_shortfall > 0/);
    expect(COUNTERFEIT_REFUND).not.toMatch(/UPDATE public\.diamond_purchase_lots\s+SET refunded =/);
  });

  // -------------------------------------------------------------------------
  // 4. The settle writes the lot and REPORTS, never refuses (DR7 / DR8 / DR9).
  // -------------------------------------------------------------------------
  it('writes one purchase lot per settle, idempotently', () => {
    expect(SETTLE).toMatch(
      /INSERT INTO public\.diamond_purchase_lots \(user_id, purchase_id, issued, settled_at\)/
    );
    expect(SETTLE).toContain('ON CONFLICT (purchase_id) DO NOTHING');
  });

  it('stamps the purchase journal row with its counterparty and class', () => {
    expect(SETTLE).toMatch(/SET counterparty = 'purchase_clearing', issuance_class = 'purchased'/);
  });

  it('records a test-mode session rather than refusing it (DR7, log-only)', () => {
    expect(SETTLE).toContain("'DR7:test_mode_session_settled', 'warning'");
    expect(SETTLE).toContain("left(p_session_id, 8) = 'cs_test_'");
  });

  it('records a package-price disagreement rather than refusing it (DR8, log-only)', () => {
    expect(SETTLE).toContain("'DR8:purchase_price_disagrees_with_package', 'warning'");
    expect(SETTLE).toContain('FROM public.diamond_packages');
  });

  it('never lets a warning fail a paid settle', () => {
    // The DR7 block, the DR8 block and the lot block each swallow their own
    // errors. A charge Stripe has already taken must not be undone because an
    // incident row could not be written.
    const guards = SETTLE.match(/EXCEPTION WHEN OTHERS/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('NEGATIVE CONTROL: a settle that refuses on a price mismatch fails the pins', () => {
    expect(COUNTERFEIT_SETTLE).not.toContain(
      "'DR8:purchase_price_disagrees_with_package', 'warning'"
    );
    expect(COUNTERFEIT_SETTLE).not.toMatch(/INSERT INTO public\.diamond_purchase_lots/);
    expect(COUNTERFEIT_SETTLE).toMatch(/RAISE EXCEPTION 'package_price_mismatch'/); // the defect
    expect((COUNTERFEIT_SETTLE.match(/EXCEPTION WHEN OTHERS/g) || []).length).toBeLessThan(3);
  });

  // -------------------------------------------------------------------------
  // 5. Disputes are handled, all three events (D10, gap G2).
  // -------------------------------------------------------------------------
  it('handles created, funds_withdrawn and closed (won and lost)', () => {
    for (const event of [
      'charge.dispute.created',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.closed:won',
      'charge.dispute.closed:lost',
    ]) {
      expect(DISPUTE, `${event} is handled`).toContain(`'${event}'`);
    }
  });

  it('claims the idempotency key BEFORE any side effect', () => {
    const claim = DISPUTE.indexOf('ON CONFLICT (dispute_id, event) DO NOTHING');
    const firstEffect = DISPUTE.indexOf('UPDATE public.diamond_purchase_lots');
    expect(claim).toBeGreaterThan(0);
    expect(firstEffect).toBeGreaterThan(claim);
    expect(DISPUTE).toContain('GET DIAGNOSTICS v_claimed = ROW_COUNT;');
  });

  it('freezes the lot on created and unfreezes it only on a win', () => {
    expect(DISPUTE).toMatch(/SET frozen_at = COALESCE\(frozen_at, now\(\)\)/);
    expect(DISPUTE).toMatch(/SET frozen_at = NULL WHERE purchase_id = p_purchase_id/);
  });

  it('reverses funds_withdrawn through the same path a refund uses', () => {
    expect(DISPUTE).toContain('public.reconcile_diamond_purchase_refund(');
    // The charge amount comes from the server-side price on the purchase row,
    // never from the webhook payload.
    expect(DISPUTE).toContain(
      'v_charge_cents := round(COALESCE(v_purchase.price_usd, 0) * 100)::integer;'
    );
  });

  it('never credits a balance', () => {
    // A dispute handler that can credit is a dispute handler that can be
    // replayed into free diamonds. Restoring a reversal after a win is a human
    // decision, recorded as an incident, not an automatic write.
    expect(DISPUTE).not.toContain('add_diamonds_to_balance');
  });

  it('is service_role only', () => {
    expect(clearing).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_diamond_purchase_dispute\(uuid, text, text, integer\) FROM PUBLIC, anon, authenticated/
    );
    expect(clearing).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_diamond_purchase_dispute\(uuid, text, text, integer\) TO service_role/
    );
  });

  it('NEGATIVE CONTROL: a created-only handler that credits fails the pins', () => {
    expect(COUNTERFEIT_DISPUTE).not.toContain("'charge.dispute.funds_withdrawn'");
    expect(COUNTERFEIT_DISPUTE).not.toContain("'charge.dispute.closed:won'");
    expect(COUNTERFEIT_DISPUTE).toContain('add_diamonds_to_balance'); // the defect
    const claim = COUNTERFEIT_DISPUTE.indexOf('INSERT INTO public.diamond_purchase_disputes');
    const firstEffect = COUNTERFEIT_DISPUTE.indexOf('UPDATE public.diamond_purchase_lots');
    expect(firstEffect).toBeLessThan(claim); // the side effect runs first
  });

  // -------------------------------------------------------------------------
  // 6. The price oracle lives in the database (DR8 / D16, gap G9).
  // -------------------------------------------------------------------------
  it('seeds all eight store packages from the World Hub constant', () => {
    for (const row of [
      "('micro',    'Micro',       100,    0,   1.00, true, 1)",
      "('small',    'Small',       500,    0,   5.00, true, 2)",
      "('medium',   'Medium',     1000,    0,  10.00, true, 3)",
      "('standard', 'Standard',   2500,    0,  25.00, true, 4)",
      "('large',    'Large',      5000,    0,  50.00, true, 5)",
      "('value',    'Value',     10000,  500, 100.00, true, 6)",
      "('premium',  'Premium',   25000, 1250, 250.00, true, 7)",
      "('whale',    'Whale',     50000, 2500, 500.00, true, 8)",
    ]) {
      expect(clearing, `${row} is seeded`).toContain(row);
    }
  });

  it('keeps every new table locked to service_role, with RLS on', () => {
    for (const table of ['diamond_purchase_lots', 'diamond_debts', 'diamond_purchase_disputes']) {
      expect(clearing).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(clearing).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(clearing).toContain(`GRANT ALL ON public.${table} TO service_role;`);
    }
    // diamond_packages is the exception: the store page may read it.
    expect(clearing).toContain('GRANT SELECT ON public.diamond_packages TO authenticated;');
  });

  it('never lets a lot be drawn past what it issued', () => {
    expect(clearing).toContain(
      'CONSTRAINT diamond_purchase_lots_not_over_drawn CHECK (consumed + refunded <= issued)'
    );
  });
});
