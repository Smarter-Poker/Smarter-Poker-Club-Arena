/**
 * Supabase helpers — player/horse wallet funding (rebuys and top-ups).
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Auto-rebuy a horse from their Player Wallet atomically.
 * ROUND 34 FIX: Direct UPDATE on public.wallets is rejected by the
 * Phase 4.1.6a wallet guard. All balance changes must flow through
 * whitelisted SECURITY DEFINER RPCs that log to chip_ledger. Replaced
 * the manual 4-step sequence (select + update wallet + update seat +
 * insert audit row) with the atomic_table_rebuy RPC, which performs
 * all 4 atomically and is whitelisted.
 *
 * Caller signature kept stable; clubId is passed but not consumed —
 * the RPC resolves it from tables(id) transitively.
 */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string
): Promise<boolean> {
  void clubId;
  try {
    // Fund the horse rebuy from the TABLE's club treasury (fn_horse_fund_from
    // _treasury derives the club from the table). Horses no longer draw on a
    // globally-minted wallet — the chips come from the club's real bankroll and
    // the rebuy fails cleanly if the treasury is short (the horse busts, correct
    // conservation behavior). Real-player rebuys still use atomic_table_rebuy.
    const { data, error } = await supabase.rpc('fn_horse_fund_from_treasury', {
      p_table_id: tableId,
      p_user_id: userId,
      p_amount: rebuyAmount,
    });

    if (error || !data?.success) {
      const msg = error?.message || data?.error || '';
      if (!msg.includes('insufficient') && !msg.includes('no active seat')) {
        reportError(
          new Error(msg || 'horse treasury rebuy failed'),
          'DB.horse_treasury_rebuy_failed'
        );
      }
      return false;
    }

    return true;
  } catch (err: any) {
    reportError(err, 'DB.Unexpected_horse_treasury_rebuy');
    return false;
  }
}

// REMOVED 2026-08-26: ensureHorseWallet.
//
// It had ZERO call sites in server/src or src - the "called during fleet
// startup" in its doc block had not been true since AutoRebuyService was
// retired. And its first branch was a bare INSERT of `balance: minBalance`
// into public.wallets: a mint, with no ledger row and no offsetting debit.
// public.wallets has been frozen since 2026-08-21 with the chips in it
// stranded and nothing reading it, so this was a loaded gun pointed at chip
// conservation, waiting for someone to wire it up. Horses are funded from the
// club treasury (fn_horse_seat_from_treasury / fn_horse_fund_from_treasury).
