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

import { v5 as uuidv5 } from 'uuid';
import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';
import { isMaintenanceFrozen } from '../../maintenance/freezeState.js';

export type HorseRebuyResult =
  | { status: 'funded'; stack: number }
  | { status: 'declined' }
  | { status: 'unknown' };

/** One bust is one funding operation, including a retry through the idle path. */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string,
  handNumber: number
): Promise<HorseRebuyResult> {
  if (isMaintenanceFrozen()) return { status: 'unknown' };
  if (
    !Number.isSafeInteger(handNumber) ||
    handNumber < 0 ||
    !Number.isFinite(rebuyAmount) ||
    rebuyAmount <= 0 ||
    Math.round(rebuyAmount * 100) / 100 !== rebuyAmount
  ) {
    reportError(
      new Error('Invalid horse rebuy identity or amount'),
      'DB.horse_treasury_rebuy_failed'
    );
    return { status: 'unknown' };
  }
  const opId = uuidv5('horse-rebuy:' + tableId + ':' + userId + ':' + handNumber, uuidv5.URL);
  const payload = { p_table_id: tableId, p_user_id: userId, p_amount: rebuyAmount, p_op_id: opId };
  let lastError = 'missing or mismatched funding receipt';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isMaintenanceFrozen()) return { status: 'unknown' };
    try {
      const { data, error } = await supabase.rpc('fn_horse_fund_from_treasury', payload);
      if (
        !error &&
        data?.success === true &&
        data.op_id === opId &&
        data.table_id === tableId &&
        data.user_id === userId &&
        /* `club_id` IS THE TABLE'S CLUB, AND MUST STAY THAT WAY. The receipt
           names the table's club here and the funding TREASURY separately in
           `treasury_club_id`, because a union table's own club row holds no
           wallets and no treasury worth drawing on: Midway's is 0.50 against
           JAQK's 937k, which is why no Midway horse had reloaded in nine days.
           The database resolves the treasury from `table_seats.club_id` - the
           wallet the seat's buy-in actually left - and the two differ on every
           union table. Do not "simplify" this comparison to the treasury club:
           an engine that ships before the receipt carries the new field must
           still recognise its own funding. */
        data.club_id === clubId &&
        (data.treasury_club_id === undefined ||
          (typeof data.treasury_club_id === 'string' && data.treasury_club_id.length > 0)) &&
        Number(data.amount) === rebuyAmount &&
        typeof data.new_stack === 'number' &&
        Number.isFinite(data.new_stack) &&
        data.new_stack >= rebuyAmount
      ) {
        return { status: 'funded', stack: data.new_stack };
      }
      const message = String(error?.message || data?.error || '');
      if (
        data?.deferred === true ||
        /PLATFORM_FROZEN|scheduled maintenance/i.test(message) ||
        isMaintenanceFrozen()
      ) {
        return { status: 'unknown' };
      }
      if (
        !error &&
        data?.success === false &&
        ['insufficient club treasury', 'no active seat for user at table'].includes(data.error)
      ) {
        return { status: 'declined' };
      }
      lastError = message || 'missing or mismatched funding receipt';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (isMaintenanceFrozen()) return { status: 'unknown' };
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  reportError(new Error(lastError), 'DB.horse_treasury_rebuy_unknown');
  return { status: 'unknown' };
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
/**
 * The club a live seat was bought from - `table_seats.club_id`, the wallet
 * the buy-in actually left. A union table's `tables.club_id` is the union row,
 * which holds no member wallet, so a roll read against it is always unknown.
 * Returns null when the seat cannot be read; the caller falls back.
 */
export async function readSeatWalletClub(tableId: string, userId: string): Promise<string | null> {
  if (!tableId || !userId) return null;
  try {
    const { data, error } = await supabase
      .from('table_seats')
      .select('club_id')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .limit(1)
      .maybeSingle();
    if (error) {
      reportError(error, 'DB.read_seat_wallet_club_failed');
      return null;
    }
    const club = (data as { club_id?: string | null } | null)?.club_id;
    return typeof club === 'string' && club.length > 0 ? club : null;
  } catch (err) {
    reportError(err, 'DB.read_seat_wallet_club_threw');
    return null;
  }
}

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
