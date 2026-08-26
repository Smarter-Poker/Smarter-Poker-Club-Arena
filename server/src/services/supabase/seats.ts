/**
 * Supabase helpers — seat lifecycle: leaving, cashing out, the waitlist.
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';

/**
 * REVIEW FIX (2026-08-20): the cash-out idempotency key must identify an
 * OCCUPANCY, not a seat.
 *
 * `table_seats` has UNIQUE (table_id, seat_number) — one row per physical seat,
 * forever. On cash tables that is harmless because `atomic_table_buyin` deletes
 * the vacated row and inserts a new one, so every occupancy gets a fresh id.
 * The tournament balancer does NOT: it moves a player in by UPDATE-ing the
 * existing row's `left_at` back to null, so the id is REUSED across occupants.
 *
 * With a key of `cashout:<seat.id>` that meant the first player ever to cash
 * out of a tournament seat permanently poisoned the key. The next occupant's
 * cash-out would hit ON CONFLICT DO NOTHING, return with NO error, be treated
 * as credited, and have their seat cleared — silently destroying their whole
 * stack. Not yet triggered in production (zero seats have been re-joined after
 * their key was written), which is exactly why it is worth closing now.
 *
 * `joined_at` distinguishes occupancies of the same row.
 */
function cashoutKey(seat: { id: string; joined_at?: string | null }): string {
  return seat.joined_at ? `cashout:${seat.id}:${seat.joined_at}` : `cashout:${seat.id}`;
}

/**
 * Transition guard for the key-format change above.
 *
 * A cash-out whose credit COMMITTED but whose response timed out before this
 * change would have written `cashout:<id>`; the retry after it lands would ask
 * for `cashout:<id>:<joined_at>`, match nothing, and pay a second time — the
 * fix causing the exact bug it exists to prevent, for a window of minutes.
 *
 * So: if the legacy key is already present, this seat was credited under the
 * old format and must not be credited again. One indexed point-read on a path
 * that runs per cash-out, not per hand.
 */
async function alreadyCreditedUnderLegacyKey(seatId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('wallet_credit_idempotency')
      .select('key')
      .eq('key', `cashout:${seatId}`)
      .maybeSingle();
    if (error) return false; // unknown -> fall through to the normal keyed path
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Mark a horse as having left the table, cash them out atomically, and sync players count.
 * FIX 208: Replaced RPC with direct queries to avoid PostgREST schema cache "text = uuid" errors
 */
export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number
): Promise<void> {
  // AUDIT 2026-08-26: mirrors the `safeToClearSeat` guard atomicCashout has had
  // since SWEEP #4 P0-3. Without it the catch block below vacated the seat
  // unconditionally, so any throw after the seat was read - a transport error on
  // the credit RPC, a timeout - destroyed the stack. That is seat exit 6522:
  // 85.85 chips, exit_kind 'left', no matching wallet credit.
  let safeToClearSeat = false;
  try {
    // 1. Get the active seat and its stack
    const { data: seat } = await supabase
      .from('table_seats')
      .select('id, stack, joined_at')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('seat_number', seatNumber)
      .is('left_at', null)
      .maybeSingle();

    if (!seat) {
      // Seat already gone — just update if stale.
      // AUDIT 2026-08-26: scoped to seat_number. Without it this vacated EVERY
      // active seat this player held at the table, including one still holding
      // a stack that this call never read and therefore never credited.
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .eq('seat_number', seatNumber)
        .is('left_at', null);
      return;
    }

    const stack = seat.stack ?? 0;

    // 2. Credit wallet if stack > 0 — atomically (balance += stack AND the audit
    //    log row in one transaction). The old read-then-upsert lost chips under
    //    concurrent credits (e.g. leaving two tables at once, or a simultaneous
    //    buy-in on the same wallet). If the credit fails we do NOT vacate the
    //    seat below, so the player's stack is never destroyed — a retry re-runs
    //    the leave and re-attempts the credit.
    if (stack > 0) {
      // Transition guard for the key-format change (see cashoutKey above): a
      // cash-out credited under the legacy `cashout:<id>` key must not be paid
      // again just because this retry asks under the new occupancy-scoped key.
      if (await alreadyCreditedUnderLegacyKey(seat.id)) {
        console.warn(
          `[markSeatAsLeft] Seat ${seat.id} was already credited under the legacy cash-out key — skipping credit`
        );
        return;
      }
      const { error: creditErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: stack,
        p_category: 'cashout',
        p_description: 'Cash-out from table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
        // P1-2 FIX: keyed on the seat OCCUPANCY (see cashoutKey), IDENTICAL to
        // the key atomicCashout writes, so a committed-but-timed-out credit here
        // is a DB-side no-op on retry (no double-credit), and a seat cashed out
        // by either path dedupes against the other.
        p_idempotency_key: cashoutKey(seat),
      });
      if (creditErr) {
        console.error(
          `[markSeatAsLeft] cash-out credit failed for ${userId} — leaving seat occupied to avoid chip loss:`,
          creditErr.message
        );
        return;
      }
    }

    // Every failure path above returns, so reaching here means the credit
    // committed or there was no stack to credit. Only now may the seat be cleared.
    safeToClearSeat = true;

    // 3. Soft-delete the seat
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString(), leave_pending: false })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('seat_number', seatNumber)
      .is('left_at', null);

    // 4. Update player count
    const { count } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('left_at', null);

    await supabase
      .from('tables')
      .update({ current_players: count ?? 0 })
      .eq('id', tableId);
  } catch (err: any) {
    // AUDIT 2026-08-26: this used to vacate the seat unconditionally. A throw
    // between reading the stack and crediting it therefore erased the stack -
    // the wallet was never credited and the chips existed nowhere afterwards.
    // atomicCashout has guarded this since SWEEP #4 P0-3; this path had not.
    if (safeToClearSeat) {
      console.warn(`[DB] Failed to cash-out horse ${userId} at ${tableId}:`, err?.message);
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .eq('seat_number', seatNumber)
        .is('left_at', null);
    } else {
      console.error(
        `[markSeatAsLeft] Exception before the cash-out credit committed for ${userId} at ${tableId} - preserving the seat so the stack is not destroyed:`,
        err?.message
      );
    }
  }
}

/**
 * Atomic cashout — direct query version for use by HorseLifecycleManager and index.ts
 * FIX 208: Avoids PostgREST RPC "text = uuid" errors
 * Returns the cashed-out stack amount, or 0 if seat not found
 */
export async function atomicCashout(
  userId: string,
  tableId: string,
  seatNumber?: number
): Promise<number> {
  // SWEEP #4 P0-3: track whether it is SAFE to soft-delete the seat in the
  // catch fallback. It is only safe once the wallet credit succeeded (or there
  // was nothing to credit). If we throw before that, deleting the seat would
  // destroy the stack, so the fallback must preserve it instead.
  let safeToClearSeat = false;
  try {
    // 1. Find active seat
    let query = supabase
      .from('table_seats')
      .select('id, stack, seat_number, joined_at')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (seatNumber !== undefined) {
      query = query.eq('seat_number', seatNumber);
    }

    const { data: seat } = await query.maybeSingle();
    if (!seat) return 0;

    const stack = seat.stack ?? 0;
    if (stack <= 0) safeToClearSeat = true; // nothing at risk if there is no stack

    // 2. Credit wallet — FIX-232: Atomic increment via RPC (eliminates race condition)
    // SWEEP #4 P0-3 FIX (2026-07-23): the credit error was only logged, then the
    // seat was soft-deleted UNCONDITIONALLY below — so a transient 502/timeout on
    // credit_player_wallet destroyed the player's entire stack (seat gone, wallet
    // not credited, unrecoverable). Sibling markSeatAsLeft already returns early
    // on credit failure "to avoid chip loss"; mirror that here. On failure we
    // preserve the seat (left_at stays null) so the cashout is retried next pass.
    if (stack > 0 && (await alreadyCreditedUnderLegacyKey(seat.id))) {
      // Legacy-key transition guard (see cashoutKey above). Already paid under
      // the old format — clear the seat, do not credit a second time.
      console.warn(
        `[atomicCashout] Seat ${seat.id} was already credited under the legacy cash-out key — skipping credit`
      );
      safeToClearSeat = true;
    } else if (stack > 0) {
      // LEDGER-INTEGRITY 2026-08-22: this used to be `credit_player_wallet`
      // followed by an unconditional `wallet_transactions` insert, and it
      // shares its idempotency key with markSeatAsLeft ON PURPOSE. Two
      // consequences, both live:
      //
      //   1. DOUBLE LEDGER ROW. The shared key makes the CREDIT a no-op for
      //      whichever path runs second — and this one then wrote a second
      //      'cashout' row for chips it did not move. Same defect the
      //      tournament prize paths carried until 2026-08-22.
      //
      //   2. THE TWO PATHS CREDITED DIFFERENT WALLETS. `credit_player_wallet`
      //      resolves the club through fn_player_home_club only; the sibling's
      //      `atomic_credit_wallet_and_log` resolves the SEAT's club first and
      //      falls back to home. For a player seated at a club that is not
      //      their home club those are different wallets, so which club's
      //      books the stack landed in depended on which path happened to run.
      //      It also skipped the `chip_transactions` row the sibling writes.
      //
      // Calling the same RPC the sibling calls fixes all of it: one credit,
      // one ledger row, one club, written in one transaction. The RPC computes
      // balance_after itself, so the extra wallet read is gone too.
      const { error: walletErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: stack,
        p_category: 'cashout',
        p_description: 'Cash-out from table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
        // Keyed on the seat OCCUPANCY (see cashoutKey), IDENTICAL to the key
        // markSeatAsLeft writes, so a committed-but-timed-out credit is a
        // DB-side no-op on retry and the two paths dedupe against each other.
        p_idempotency_key: cashoutKey(seat),
      });
      if (walletErr) {
        console.warn(
          `[atomicCashout] Wallet credit failed for ${userId} — preserving seat for retry:`,
          walletErr.message
        );
        return 0; // do NOT soft-delete; stack stays on the seat, retryable
      }
      safeToClearSeat = true; // credit committed — safe to clear the seat now
    }

    // 3. Soft-delete seat
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString(), leave_pending: false })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    // 4. Update player count
    const { count } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('left_at', null);

    await supabase
      .from('tables')
      .update({ current_players: count ?? 0 })
      .eq('id', tableId);

    // TOURNEY-AUDIT 2026-07-24 (sweep 6): seat opened — notify the waitlist.
    void notifyWaitlistSeatOpen(tableId);

    return stack;
  } catch (err: any) {
    // SWEEP #4 P0-3 FIX: only soft-delete on exception if the credit already
    // committed (or there was no stack). Otherwise preserve the seat so the
    // stack is not destroyed on a transient failure — it will be retried.
    if (safeToClearSeat) {
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
        .is('left_at', null);
    } else {
      console.warn(
        `[atomicCashout] Exception before credit committed for ${userId} — preserving seat:`,
        err?.message
      );
    }
    return 0;
  }
}

/**
 * TOURNEY-AUDIT 2026-07-24 (sweep 6): cash-game waitlist notifier. When a seat
 * opens at a cash table, the longest-waiting 'waiting' entry is flipped to
 * 'notified' and receives a notification row. The player then sits via the
 * normal buy-in flow. Cash games only (tournament entrants are auto-seated by
 * the engine, never queued). Fire-and-forget; failures never block the table.
 *
 * TABLE NAME, 2026-08-21: this read `table_waitlists` (plural) while every
 * client path wrote `table_waitlist` (singular). The engine was therefore
 * watching an empty queue that nothing ever joined, and no seat offer could
 * ever have fired. Both tables were empty, so the reconciliation cost no data.
 */
export async function notifyWaitlistSeatOpen(tableId: string): Promise<void> {
  try {
    // Only cash tables have waitlists
    const { data: tableRow } = await supabase
      .from('tables')
      .select('id, name, tournament_id, max_players, current_players')
      .eq('id', tableId)
      .maybeSingle();
    if (!tableRow || tableRow.tournament_id) return;
    if ((tableRow.current_players ?? 0) >= (tableRow.max_players ?? 9)) return;

    const { data: next } = await supabase
      .from('table_waitlist')
      .select('id, user_id')
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!next) return;

    const { data: claimed } = await supabase
      .from('table_waitlist')
      .update({ status: 'notified', notified_at: new Date().toISOString() })
      .eq('id', next.id)
      .eq('status', 'waiting')
      .select('id');
    if (!claimed || claimed.length === 0) return; // raced — another opener claimed it

    await supabase.from('notifications').insert({
      user_id: next.user_id,
      type: 'waitlist_seat_open',
      title: 'Seat Open',
      message: `A Seat Just Opened At ${tableRow.name || 'Your Waitlisted Table'}. Sit Down Now To Claim It.`,
      data: { table_id: tableId },
    });
    console.log(
      `[Waitlist] Notified ${next.user_id.slice(0, 8)} — seat open at ${tableId.slice(0, 8)}`
    );
  } catch (e) {
    console.warn(`[Waitlist] notify failed for table ${tableId}:`, e);
  }
}

/**
 * Process leave-pending players after hand completion
 */
export async function processLeavePending(tableId: string, clubId: string): Promise<string[]> {
  const { data: pendingSeats } = await supabase
    .from('table_seats')
    .select('user_id, stack, seat_number')
    .eq('table_id', tableId)
    .eq('leave_pending', true)
    .is('left_at', null);

  if (!pendingSeats || pendingSeats.length === 0) return [];

  const cashedOut: string[] = [];
  for (const seat of pendingSeats) {
    // FIX 208: Use direct atomicCashout instead of RPC
    await atomicCashout(seat.user_id, tableId, seat.seat_number);
    cashedOut.push(seat.user_id);
  }

  // Authoritative recount after all departures
  const { count } = await supabase
    .from('table_seats')
    .select('*', { count: 'exact', head: true })
    .eq('table_id', tableId)
    .is('left_at', null);

  await supabase
    .from('tables')
    .update({ current_players: count || 0 })
    .eq('id', tableId);

  // TOURNEY-AUDIT 2026-07-24 (sweep 6): a seat opened — offer it to the
  // longest-waiting waitlisted player (cash tables only; no-op otherwise).
  if (cashedOut.length > 0) {
    void notifyWaitlistSeatOpen(tableId);
  }

  // Round 57: callers use this list to unregister disconnect tracking for
  // players who cashed out. Without this, DisconnectEngine.playerStates leaks.
  return cashedOut;
}
