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
 * ═══════════════════════════════════════════════════════════════════════════
 *  CASHING A SEAT OUT LIVES IN THE DATABASE NOW (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════
 * Both functions below call ONE rpc, `atomic_seat_cashout_locked`.
 *
 * THE BUG THAT MOVED IT. Cash-out used to be three PostgREST round-trips here:
 * read the stack, credit it, stamp `left_at`. Three round-trips are three
 * TRANSACTIONS, and the read took no lock, so `atomic_table_addon` could commit
 * `stack = stack + n` in the gap. The credit paid the PRE-add-on stack while
 * the seat-exit trigger recorded the POST-add-on one, and the difference was
 * destroyed. Three times in 30 days, 205.68 chips, each reconstructing to the
 * penny as `cash-out + add-on == stack`.
 *
 * WHY THE 2026-08-26 FIX MISSED IT. That pass added `FOR UPDATE` to
 * `atomic_table_addon` "so this serialises with atomic_table_cashout" - but the
 * engine never calls `atomic_table_cashout`; its only callers are client-side.
 * One side of a handshake is not a handshake, and the bug recurred the next
 * day. The RPC takes the same lock, so both orderings are now safe: an add-on
 * already in flight commits first and we refund the larger stack; an add-on
 * arriving second finds `left_at` set, its own zero-row guard raises, and its
 * debit rolls back.
 *
 * TWO THINGS THIS FILE LEARNED THE HARD WAY, now enforced inside the RPC:
 *
 *   1. THE IDEMPOTENCY KEY IS SCOPED TO AN OCCUPANCY, NOT A SEAT.
 *      `table_seats` has UNIQUE (table_id, seat_number) - one row per physical
 *      seat, forever. Cash tables are fine because the buy-in deletes and
 *      re-inserts, but the tournament balancer moves a player in by setting an
 *      existing row's `left_at` back to null, REUSING the id. A key of
 *      `cashout:<id>` would let the first occupant to cash out poison that seat
 *      for every occupant after them - their credit would dedupe away to
 *      nothing and their seat would still be cleared. `joined_at` separates
 *      them. The RPC derives that key from the row it locked, so the key can no
 *      longer disagree with the seat being paid for.
 *
 *   2. THE LEGACY-KEY GUARD. Credits written before 2026-08-20 used the
 *      unscoped `cashout:<id>`. A retry asking under the new format would miss
 *      them and pay twice, so the RPC checks the legacy key too - and, being
 *      under the lock, that check can no longer be separated from the credit it
 *      guards. It skips only the CREDIT, never the seat exit: leaving the seat
 *      occupied would double-count the chips in fn_club_chip_circulation.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Mark a seat as left, cash it out atomically, and sync the table's player count.
 *
 * 2026-08-26: the first line used to read "Mark a HORSE as having left". It is
 * not horse-only and has not been for a long time - ServerTableEngineSeating
 * calls it as the last-resort fallback when atomicCashout fails for ANY player,
 * real ones included. Believing the old sentence would lead someone to assume a
 * failure here cannot touch a human's chips. It can.
 *
 * FIX 208: Replaced RPC with direct queries to avoid PostgREST schema cache "text = uuid" errors
 */
export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number
): Promise<void> {
  // 2026-08-27: same single locked transaction as atomicCashout. This function
  // and that one had byte-for-byte the same read/credit/vacate gap, and they
  // have already drifted apart twice while being patched separately (see the
  // 2026-08-26 audit). Sharing one RPC is what stops them drifting a third
  // time - there is now exactly one implementation of "cash a seat out", and it
  // lives in the database where the lock is.
  //
  // Everything the old body defended is now structural rather than earned:
  // a failed credit rolls back with the vacate, so the stack cannot be
  // destroyed; the legacy-key guard runs under the lock; and the write is
  // scoped to the seat the RPC itself locked, so it cannot vacate another seat
  // this call never read.
  try {
    const { error } = await supabase.rpc('atomic_seat_cashout_locked', {
      p_user_id: userId,
      p_table_id: tableId,
      p_seat_number: seatNumber,
    });
    if (error) {
      console.error(
        `[markSeatAsLeft] Locked cash-out failed for ${userId} at ${tableId} seat ${seatNumber} - seat preserved so the stack is not destroyed:`,
        error.message
      );
      return;
    }
    void notifyWaitlistSeatOpen(tableId);
  } catch (err: any) {
    console.error(
      `[markSeatAsLeft] Transport failure for ${userId} at ${tableId} seat ${seatNumber} - seat preserved:`,
      err?.message
    );
  }
}

/**
 * Atomic cashout — direct query version for use by HorseLifecycleManager and index.ts
 * FIX 208: Avoids PostgREST RPC "text = uuid" errors
 * Returns the cashed-out stack amount, or 0 if seat not found
 */
/**
 * CHIP CONTINUITY (2026-09-04). `leaveMode` is what the database enforces the
 * stay clock on: `'voluntary'` is the player's own choice to leave (POST
 * /leave, a horse departure, a leave_pending seat at settlement) and may be
 * REFUSED while they are ahead of their buy-in with clock remaining; omitted
 * (NULL) or `'forced'` is a system exit - eviction, table close, bust, sweep -
 * which the clock never blocks. A refusal is reported through `onLocked` with
 * the remaining milliseconds and the function returns 0 with the seat exactly
 * as it was; any other failure goes to `onFailed`. Callbacks rather than a
 * richer return type so every existing caller keeps its `number` contract.
 */
export interface CashoutOptions {
  leaveMode?: 'voluntary' | 'forced';
  onLocked?: (stayRemainingMs: number) => void;
  onFailed?: (message: string) => void;
}

const LEAVE_LOCKED_RE = /LEAVE_LOCKED:(\d+)/;

export async function atomicCashout(
  userId: string,
  tableId: string,
  seatNumber?: number,
  opts?: CashoutOptions
): Promise<number> {
  // 2026-08-27: read + credit + vacate now happen in ONE transaction, with the
  // seat row held under FOR UPDATE. See the block comment at the top of this
  // file: the old three-round-trip sequence let an add-on commit between the
  // read and the credit, and the difference was destroyed.
  //
  // The RPC derives the occupancy-scoped idempotency key and the legacy key
  // from the row it locked, so this call cannot use a key that disagrees with
  // the seat it is actually paying for.
  try {
    const { data, error } = await supabase.rpc('atomic_seat_cashout_locked', {
      p_user_id: userId,
      p_table_id: tableId,
      p_seat_number: seatNumber ?? null,
      p_leave_mode: opts?.leaveMode ?? null,
    });

    if (error) {
      const locked = LEAVE_LOCKED_RE.exec(String(error.message || ''));
      if (locked) {
        // Refused by the stay clock. Not a failure: the player is still in
        // their chair and the caller shows them the countdown.
        opts?.onLocked?.(Number(locked[1]));
        return 0;
      }
      // The seat is untouched: the whole thing was one transaction, so a
      // failure here rolled back the credit AND the vacate together. The stack
      // is still on the seat and the next pass retries it. This is the property
      // the old code needed `safeToClearSeat` to approximate.
      console.warn(
        `[atomicCashout] Locked cash-out failed for ${userId} at ${tableId} - seat preserved for retry:`,
        error.message
      );
      opts?.onFailed?.(String(error.message || 'cash-out failed'));
      return 0;
    }

    const stack = Number((data as any)?.stack ?? 0);
    if ((data as any)?.reason === 'no_active_seat') return 0;

    // Seat opened — notify the waitlist. Unchanged behaviour.
    void notifyWaitlistSeatOpen(tableId);
    return Number.isFinite(stack) ? stack : 0;
  } catch (err: any) {
    console.warn(
      `[atomicCashout] Transport failure for ${userId} at ${tableId} - seat preserved for retry:`,
      err?.message
    );
    opts?.onFailed?.(String(err?.message || 'transport failure'));
    return 0;
  }
}

/**
 * CASH-GAME SEAT OFFER. When a seat opens at a cash table the longest-waiting
 * HUMAN on that table's queue is offered it. Cash games only — tournament
 * entrants are engine-seated and never queued. Fire-and-forget; a failure here
 * must never block a table.
 *
 * ═══ THIS IS NOW ONE CALL, AND THAT IS THE POINT (2026-08-30) ═══════════════
 *
 * Everything below used to be six round trips of TypeScript: read the table,
 * expire lapsed offers, expire abandoned rows, retire rows for players already
 * seated, page the queue looking for a human, claim the head, write the
 * notification. It ran on EVERY cash-out at EVERY table.
 *
 * Cost was the smaller half. The real problem was a race the old code could
 * only SURVIVE, never avoid: between reading the queue head and claiming it,
 * a concurrent opener could pick the same row. The loser noticed (its claim
 * was scoped `.eq('status','waiting')` and updated nothing) and returned — so
 * the seat went UNOFFERED, silently, until another seat happened to turn over.
 *
 * `fn_offer_open_seat` does the whole thing in one transaction and takes the
 * queue head with `FOR UPDATE ... SKIP LOCKED`, which hands a concurrent caller
 * the NEXT person in line instead of a collision. It also notifies whoever just
 * lost an offer to the TTL, which nothing anywhere used to do.
 *
 * The TTLs live in the function signature as defaults rather than here, so the
 * rule and the code that enforces it cannot drift apart. They are:
 *   offer TTL  3 minutes  — an offer nobody acted on is dead; release the head
 *                           or one unclaimed offer jams the queue forever
 *   entry TTL  24 hours   — a place in line you walked away from is not a
 *                           person waiting for a seat (Dan 2026-08-29)
 */
export async function notifyWaitlistSeatOpen(tableId: string): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('fn_offer_open_seat', {
      p_table_id: tableId,
    });

    if (error) {
      console.warn(`[Waitlist] seat offer failed for ${tableId.slice(0, 8)}: ${error.message}`);
      return;
    }

    const result = (data ?? {}) as {
      ok?: boolean;
      reason?: string;
      user_id?: string;
      table_name?: string;
      offers_expired?: number;
    };

    if (result.offers_expired && result.offers_expired > 0) {
      console.log(
        `[Waitlist] reclaimed ${result.offers_expired} lapsed offer(s) at ${tableId.slice(0, 8)}`
      );
    }

    if (!result.ok) {
      // Every one of these is ordinary: the table filled again, it is a
      // tournament table, or nobody human is queued. Logged at debug volume
      // only for the reasons that are worth seeing.
      if (result.reason && result.reason !== 'nobody_waiting') {
        console.log(`[Waitlist] no offer at ${tableId.slice(0, 8)}: ${result.reason}`);
      }
      return;
    }

    console.log(
      `[Waitlist] Notified ${String(result.user_id ?? '').slice(0, 8)} - seat open at ${tableId.slice(0, 8)}`
    );
  } catch (e) {
    console.warn(`[Waitlist] notify failed for table ${tableId}:`, e);
  }
}

/**
 * Process leave-pending players after hand completion
 */
export async function processLeavePending(
  tableId: string,
  clubId: string,
  /**
   * CHIP CONTINUITY (2026-09-04): a leave_pending seat is the player's OWN
   * request, so it goes through the door the stay clock guards. When the
   * database refuses it (they won the hand they asked to leave during, and
   * are now ahead with clock remaining) the seat stays, `leave_pending` is
   * cleared so this sweep does not re-ask every tick, and the caller is told
   * so it can show the player the countdown instead of an empty seat.
   */
  onLocked?: (userId: string, stayRemainingMs: number) => void,
  /** Seats whose leave is a system exit (admin kick): the clock does not block them. */
  forcedUserIds?: ReadonlySet<string>
): Promise<string[]> {
  /* Deliberately does NOT select `stack`. This query only ENUMERATES which
     seats asked to leave; the amount comes from the locked read inside
     atomic_seat_cashout_locked. `stack` was selected here and never used, which
     is precisely the shape that invites someone to "save a round-trip" by
     passing it along - and an unlocked stack read handed to a credit is the
     2026-08-27 race. Do not add it back. */
  const { data: pendingSeats } = await supabase
    .from('table_seats')
    .select('user_id, seat_number')
    .eq('table_id', tableId)
    .eq('leave_pending', true)
    .is('left_at', null);

  if (!pendingSeats || pendingSeats.length === 0) return [];

  const cashedOut: string[] = [];
  for (const seat of pendingSeats) {
    const out: { lockedMs: number | null; failed: boolean } = { lockedMs: null, failed: false };
    await atomicCashout(seat.user_id, tableId, seat.seat_number, {
      leaveMode: forcedUserIds?.has(seat.user_id) ? 'forced' : 'voluntary',
      onLocked: (ms) => {
        out.lockedMs = ms;
      },
      onFailed: () => {
        out.failed = true;
      },
    });
    if (out.lockedMs !== null) {
      await supabase
        .from('table_seats')
        .update({ leave_pending: false })
        .eq('table_id', tableId)
        .eq('user_id', seat.user_id)
        .is('left_at', null);
      onLocked?.(seat.user_id, out.lockedMs);
      continue;
    }
    // Any other failure: the seat is untouched (one transaction) and the next
    // sweep retries it. Only a seat that actually left is reported as gone.
    if (out.failed) continue;
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
