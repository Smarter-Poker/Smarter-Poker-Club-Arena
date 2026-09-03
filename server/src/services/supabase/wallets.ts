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

/**
 * What each of these players could actually bring back to a CASH table.
 *
 * Dan 2026-08-28: "IN A CASH GAME, CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY,
 * (40 BB MINIMUM). IF THEY DO, YOU GIVE THEM THE 5 SECOND PERIOD TO REBUY OR
 * DECLINE." This is the read behind that check.
 *
 * `club_members.chip_balance` is the live chip pool — the same column
 * `atomic_table_buyin` debits and `atomic_seat_cashout_locked` credits.
 * NOT `public.wallets`, which has been frozen since 2026-08-21 with 732m chips
 * stranded in it and nothing reading it (CLAUDE.md 11.5).
 *
 * Returns a Map so a caller can distinguish "balance is zero" from "we could
 * not read this player" — an ABSENT key means unknown. That distinction is the
 * whole point: an unreadable balance must never be treated as "cannot afford a
 * rebuy", because the consequence of that mistake is standing a player up who
 * had the money all along. Callers treat unknown as CAN afford, and the worst
 * case is then a five-second pause nobody needed.
 */
export async function readClubChipBalances(
  clubId: string,
  userIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!clubId || userIds.length === 0) return out;
  try {
    const { data, error } = await supabase
      .from('club_members')
      .select('user_id, chip_balance')
      .eq('club_id', clubId)
      .in('user_id', userIds);
    if (error) {
      reportError(error, 'DB.read_club_chip_balances_failed');
      return out; // Empty -> every player reads as UNKNOWN -> nobody is stood up.
    }
    for (const row of (data ?? []) as Array<{ user_id: string; chip_balance: number | null }>) {
      out.set(String(row.user_id), Number(row.chip_balance ?? 0));
    }
  } catch (err) {
    reportError(err, 'DB.read_club_chip_balances_threw');
  }
  return out;
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
