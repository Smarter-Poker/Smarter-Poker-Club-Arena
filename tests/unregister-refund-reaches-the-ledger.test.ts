/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A REFUND THE LEDGER NEVER HEARD ABOUT GETS PAID TWICE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_unregister_from_tournament used to refund through credit_player_wallet,
 * which moves chips and writes no wallet_transactions row. atomic_cancel_tournament
 * decides what each player is owed by reading that ledger:
 *
 *     sum(debit  where category in ('tournament_buyin','rebuy','addon'))
 *   - sum(credit where category = 'refund')
 *
 * so an unoffset buy-in debit survived every unregistration and the cancel paid
 * for it again. K register/unregister cycles paid (K+1) times the buy-in, and a
 * club admin can cancel a RUNNING event.
 *
 * CI has no database, so these assert on migration source. That cannot prove the
 * SQL is right; it was proved against production inside transactions that rolled
 * themselves back, before and after, and both outputs are quoted in the migration
 * header. What these CAN prove is that nobody quietly puts the silent credit back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const UNREG = read('supabase/migrations/20260828031000_unregister_refund_reaches_the_ledger.sql');
const SERVICE = read('src/services/TournamentService.ts');

/** The header quotes the old call on purpose, so a negative assertion has to
 *  read the executable half or it matches the documentation. */
const BODY = UNREG.slice(UNREG.indexOf('CREATE OR REPLACE FUNCTION'));

describe('unregistering writes the row the cancel reads', () => {
  it('refunds through fn_credit_and_log, the helper the cancel itself uses', () => {
    expect(BODY).toContain('public.fn_credit_and_log(');
    // Category and entity must match what atomic_cancel_tournament subtracts:
    // a `refund` credit carrying the tournament as its related entity.
    expect(BODY).toContain("'refund',");
    expect(BODY).toContain('p_tournament_id);');
  });

  it('no longer credits silently through credit_player_wallet', () => {
    // The body still NAMES the old helper in the comment that explains what
    // changed, and it should. What must be gone is the CALL, so this looks for
    // the call shape rather than the word.
    expect(BODY).not.toMatch(/(?:PERFORM\s+)?public\.credit_player_wallet\s*\(/);
  });

  it('keeps the original idempotency key, so an old refund cannot be paid again', () => {
    /**
     * A new key shape would have re-opened the very hole being closed for any
     * unregistration already refunded under the old code, and would have changed
     * which club wallet fn_credit_player_wallet_once resolves.
     */
    expect(BODY).toContain("'tourn_unreg:' || v_reg_id::text");
    expect(BODY).not.toContain("'tourney:' || p_tournament_id");
  });

  it('still reverses the exact entry split, not the raw buy-in', () => {
    // Pool symmetry from 2026-08-26 must survive this change untouched.
    expect(BODY).toContain('public.fn_tournament_entry_split(');
    expect(BODY).toContain('v_amount := v_split.charge;');
    expect(BODY).toContain('prize_pool  = GREATEST(COALESCE(prize_pool, 0)  - v_split.prize, 0)');
  });

  it('still refuses an unauthenticated caller and still derives the actor itself', () => {
    expect(BODY).toContain('v_uid     uuid := auth.uid()');
    expect(BODY).toContain("USING ERRCODE = '28000'");
  });

  it('records both probes, so the claim has a number behind it', () => {
    expect(UNREG).toContain('cancel would refund 10.00');
    expect(UNREG).toContain('cancel refunds 5.00');
  });
});

describe('the client still calls it', () => {
  it('unregisters through the RPC rather than deleting the row itself', () => {
    expect(SERVICE).toContain("supabase.rpc('fn_unregister_from_tournament'");
  });
});
