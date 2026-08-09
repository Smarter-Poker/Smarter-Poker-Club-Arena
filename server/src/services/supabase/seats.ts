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
 * Mark a horse as having left the table, cash them out atomically, and sync players count.
 * FIX 208: Replaced RPC with direct queries to avoid PostgREST schema cache "text = uuid" errors
 */
export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number
): Promise<void> {
  try {
    // 1. Get the active seat and its stack
    const { data: seat } = await supabase
      .from('table_seats')
      .select('id, stack')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .eq('seat_number', seatNumber)
      .is('left_at', null)
      .maybeSingle();

    if (!seat) {
      // Seat already gone — just update if stale
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', tableId)
        .eq('user_id', userId)
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
      const { error: creditErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: stack,
        p_category: 'cashout',
        p_description: 'Cash-out from table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
        // P1-2 FIX: idempotency key keyed on the seat-occupancy row id, IDENTICAL
        // to the atomicCashout fix (`cashout:<seat.id>`), so a committed-but-
        // timed-out credit here is a DB-side no-op on retry (no double-credit),
        // and a seat cashed out by either path dedupes against the other.
        p_idempotency_key: `cashout:${seat.id}`,
      });
      if (creditErr) {
        console.error(
          `[markSeatAsLeft] cash-out credit failed for ${userId} — leaving seat occupied to avoid chip loss:`,
          creditErr.message
        );
        return;
      }
    }

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
    console.warn(`[DB] Failed to cash-out horse ${userId} at ${tableId}:`, err.message);
    // Fallback: just mark as left
    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);
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
      .select('id, stack, seat_number')
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
    if (stack > 0) {
      const { error: walletErr } = await supabase.rpc('credit_player_wallet', {
        p_user_id: userId,
        p_amount: stack,
        // A3 site 11: this credit is retried (the failure path below deliberately
        // preserves the seat "for retry"), so a credit that COMMITTED but timed
        // out was being paid twice. Key the credit on the seat-occupancy row id.
        // Sibling markSeatAsLeft writes the IDENTICAL `cashout:<seat.id>` key for
        // the same row, so the two cash-out paths dedupe against each other too —
        // whichever runs second is a DB-side no-op.
        p_idempotency_key: `cashout:${seat.id}`,
      });
      if (walletErr) {
        console.warn(
          `[atomicCashout] Wallet credit failed for ${userId} — preserving seat for retry:`,
          walletErr.message
        );
        return 0; // do NOT soft-delete; stack stays on the seat, retryable
      }
      safeToClearSeat = true; // credit committed — safe to clear the seat now

      // BUG 018 FIX: read new balance for balance_after audit field
      const { data: postWallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', userId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      await supabase.from('wallet_transactions').insert({
        user_id: userId,
        wallet_type: 'PLAYER',
        type: 'credit',
        amount: stack,
        category: 'cashout',
        description: 'Cash-out from table',
        table_id: tableId,
        balance_after: postWallet?.balance ?? null,
      });
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
 * 'notified' and receives a notification row — the player then sits via the
 * normal buy-in flow. Cash games only (tournament entrants are auto-seated by
 * the engine, never queued). Fire-and-forget; failures never block the table.
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
      .from('table_waitlists')
      .select('id, user_id')
      .eq('table_id', tableId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!next) return;

    const { data: claimed } = await supabase
      .from('table_waitlists')
      .update({ status: 'notified', notified_at: new Date().toISOString() })
      .eq('id', next.id)
      .eq('status', 'waiting')
      .select('id');
    if (!claimed || claimed.length === 0) return; // raced — another opener claimed it

    await supabase.from('notifications').insert({
      user_id: next.user_id,
      type: 'waitlist_seat_open',
      title: 'Seat open!',
      message: `A seat just opened at ${tableRow.name || 'your waitlisted table'} — sit down now to claim it.`,
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
