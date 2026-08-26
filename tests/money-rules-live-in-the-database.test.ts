/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MONEY RULES THAT LIVE IN THE DATABASE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CI has no database, so these assert on migration source. That cannot prove
 * the SQL is right - each rule below was proved against production inside a
 * transaction that rolled itself back, and the output is quoted in the
 * migration headers. What these CAN prove is that nobody quietly removes a
 * guard, or ships a client that stops passing the key the guard needs.
 *
 * Why the rules are in the database at all: a dropdown is a suggestion.
 * Anything holding a session calls these RPCs directly and never sees the UI.
 * Every rule here was, at some point, enforced only by the client - and each
 * one turned out to be reachable around it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const CASHOUT_LEGS = read(
  'supabase/migrations/20260826025000_cashout_closing_legs_return_the_escrow_not_the_request.sql'
);
const TWICE = read(
  'supabase/migrations/20260826030000_money_paths_that_could_run_twice_or_destroy_chips.sql'
);
const MINT_UI = read('src/components/wallet/ChipMintModal.tsx');
const CASHOUT_SVC = read('src/services/CashoutService.ts');

describe('a cash out returns the chips that were actually held', () => {
  it('refuses when the request and the escrow disagree', () => {
    /**
     * fn_cashout_approve already treated a disagreement as fatal. Release
     * trusted the request row, so if the two ever diverged a decline paid out
     * a number nobody had debited - silently.
     */
    expect(CASHOUT_LEGS).toContain('v_escrow.amount is distinct from v_req.amount');
    expect(CASHOUT_LEGS).toContain('That Cash Out Does Not Match The Chips Held For It');
  });

  it('credits the escrow amount, not the request amount', () => {
    expect(CASHOUT_LEGS).toContain('coalesce(chip_balance, 0) + v_escrow.amount');
    expect(CASHOUT_LEGS).not.toContain('coalesce(chip_balance, 0) + v_req.amount');
  });

  it('treats a duplicate op id as a replay rather than raising', () => {
    /**
     * The partial unique index spans cashout_denied and cashout_cancelled
     * together. Without a handler, a genuine retry surfaced as a raw 23505
     * instead of the calm "you already did this" every sibling gives.
     */
    expect(CASHOUT_LEGS).toContain('exception when unique_violation');
  });

  it('tells the agent when a player withdraws their own request', () => {
    expect(CASHOUT_LEGS).toContain('Cash Out Withdrawn');
    // And hands the client the id it needs to send a push.
    expect(CASHOUT_LEGS).toContain("'agent_id', v_req.agent_id");
  });
});

describe('the nightly expiry gives back exactly what it took', () => {
  it('does not truncate the refund to a whole number', () => {
    /**
     * It read `r.amount::integer` against numeric. A 40.50 hold refunded 40
     * and destroyed the difference.
     */
    const expiry = TWICE.slice(0) + CASHOUT_LEGS;
    expect(CASHOUT_LEGS).toContain('coalesce(chip_balance, 0) + v_escrow.amount');
    expect(expiry).not.toMatch(
      /chip_balance\s*=\s*coalesce\(chip_balance,\s*0\)\s*\+\s*r\.amount::integer/
    );
  });

  it('actually releases the hold instead of orphaning it', () => {
    expect(CASHOUT_LEGS).toContain("release_type = 'expired'");
    // The CHECK constraint had no word for it, so this had to be widened too.
    expect(CASHOUT_LEGS).toContain("'expired'");
    expect(CASHOUT_LEGS).toContain('chip_escrow_release_type_check');
  });

  it('keys its ledger row so a second run cannot refund twice', () => {
    expect(CASHOUT_LEGS).toContain("'op_id', v_escrow.id");
  });
});

describe('a send cannot destroy chips in the rounding', () => {
  it('refuses anything finer than a hundredth on all three send paths', () => {
    /**
     * agents.agent_wallet_balance is numeric(18,4); club_members.chip_balance
     * is numeric(20,2). 10.00005 was debited as 10.0001 and credited as 10.00,
     * and reconcile_ledger_nightly could not see it because both sides were
     * written by the same rounded arithmetic.
     */
    expect(TWICE).toContain('round(p_amount, 2)');
    expect(TWICE).toContain('Chips Move In Hundredths At Most');
    for (const fn of ['fn_agent_wallet_send', 'fn_club_bank_send', 'fn_promo_wallet_send']) {
      expect(TWICE).toContain(fn);
    }
  });

  it('keeps the existing zero guard rather than replacing it', () => {
    expect(TWICE).toContain('Amount Must Be Greater Than Zero');
    expect(TWICE).toContain('the zero guard was lost from %');
  });
});

describe('every money type is inside an idempotency index', () => {
  it('covers the three types that sat outside all of them', () => {
    for (const t of ['admin_removal', 'mint', 'cashout_expired_refund']) {
      expect(TWICE).toContain(`'${t}'`);
    }
  });

  it('uses the type the mint actually writes, not the one its name suggests', () => {
    /**
     * The mint writes transaction_type 'mint'. 'chip_mint' is the CATEGORY
     * deduct_diamonds stamps on the DIAMOND side. An index on a type nobody
     * writes protects nothing - this was got wrong once already, within an
     * hour, and caught by reading the body rather than the name.
     */
    expect(TWICE).toMatch(/array\['admin_removal', 'mint', 'cashout_expired_refund'\]/);
    expect(TWICE).not.toMatch(/array\['admin_removal', 'chip_mint'/);
  });
});

describe('a retry cannot move the same money twice', () => {
  it('the staff pull takes an op id and replays on it', () => {
    expect(TWICE).toContain('fn_admin_remove_player_chips');
    expect(TWICE).toContain('p_op_id uuid default null::uuid');
    expect(TWICE).toContain("transaction_type = 'admin_removal'");
    // The four-arg version is dropped, not left beside the new one: an
    // overload would keep the unguarded body live for older callers.
    expect(TWICE).toContain(
      'drop function if exists public.fn_admin_remove_player_chips(uuid, uuid, numeric, text)'
    );
  });

  it('the mint locks BEFORE it burns anything', () => {
    /**
     * This one cannot rely on the unique index alone. deduct_diamonds runs
     * before the ledger insert, and an exception caught in a sub-block rolls
     * back only to that block - the diamonds would already be gone. So the
     * advisory lock has to be taken before the deduction, not after.
     */
    // Measure inside the FUNCTION BODY, not the file: the header comment
    // explains deduct_diamonds long before the body reaches it, and comparing
    // whole-file offsets made this assertion pass or fail on prose. The first
    // version of this test did exactly that and failed for the wrong reason.
    const body = TWICE.slice(
      TWICE.indexOf('create or replace function public.fn_mint_chips_from_diamonds')
    );
    const lock = body.indexOf('pg_advisory_xact_lock');
    const burn = body.indexOf('deduct_diamonds');
    expect(lock).toBeGreaterThan(-1);
    expect(burn).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(burn);
  });

  it('the staff pull tells the member their chips were taken', () => {
    // The one movement that happens to a player without them asking.
    expect(TWICE).toContain('Chips Removed By Club Staff');
  });
});

describe('the superseded cashier is no longer callable by a session', () => {
  it('revokes execute from authenticated on both old functions', () => {
    /**
     * They move chip_balance to chip_balance and never touch the agent wallet.
     * The client stopped calling them, but EXECUTE for `authenticated` meant
     * any session could still move chips along a path with no agent wallet, no
     * ten minute window and no downline edge.
     */
    expect(TWICE).toContain(
      'revoke execute on function public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) from authenticated'
    );
    expect(TWICE).toContain(
      'revoke execute on function public.fn_cashier_claim_back(uuid, uuid, numeric, text, text) from authenticated'
    );
  });
});

describe('the client passes the keys the server now expects', () => {
  it('the mint sends p_op_id and holds it across a failure', () => {
    expect(MINT_UI).toContain('p_op_id: opIdRef.current');
    // Held across a failure is the whole point; cleared on success only.
    expect(MINT_UI).toContain('if (!opIdRef.current) opIdRef.current = crypto.randomUUID();');
    expect(MINT_UI).toContain('setDiamondsAndResetKey');
  });

  it('changing the amount retires the key', () => {
    /**
     * Reusing it would make the server replay the ORIGINAL amount and report
     * success for a mint the user did not ask for - a worse bug than the one
     * the key was added to fix.
     */
    expect(MINT_UI).toMatch(
      /setDiamondsAndResetKey = \(v: string\) => \{\s*\n\s*opIdRef\.current = null;/
    );
  });

  it('the staff pull accepts a caller-supplied op id', () => {
    expect(CASHOUT_SVC).toContain('p_op_id: opId || newOpId()');
    expect(CASHOUT_SVC).toMatch(/adminRemovePlayerChips\([\s\S]{0,240}opId\?: string/);
  });
});
