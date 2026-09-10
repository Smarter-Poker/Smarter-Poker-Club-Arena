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
import { pushFinancialUpdate } from '../financialPush.js';
import { reportError } from '../errorReporter.js';
import { tableCountChangedFilter } from './tables.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CASHING A SEAT OUT LIVES IN THE DATABASE NOW (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════
 * Both functions below share ONE occupancy-bound RPC, `fn_cashout_seat_occupancy`.
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
 * The database assigns each occupancy a UUID, renewed even if a physical
 * seat row and its timestamp are reused. Callers retain that original UUID.
 * The RPC binds authorization, locked credit, exit and durable receipt to it.
 * Repeating a committed request returns its original receipt, even after a
 * rejoin. An unknown identity fails before any financial mutation.
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
 * Departure is confirmed only for the original occupancy.
 */
type CashoutScope = { userId: string; tableId: string; seatNumber: number; occupancyId: string };

export interface SeatCashoutReceipt {
  asset?: 'chips' | 'diamonds';
  ok: true;
  stack: number;
  credited: boolean;
  seat_number: number;
  occupancy_id: string;
  user_id: string;
  table_id: string;
  idempotency_key: string;
  tournament_table: boolean;
}

/** A receipt must prove the exact occupancy this request was authorized for. */
function confirmedCashout(data: unknown, scope: CashoutScope): SeatCashoutReceipt {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Cash-out receipt missing; departure unconfirmed');
  }
  const receipt = data as Record<string, unknown>;
  if (
    receipt.ok !== true ||
    receipt.reason !== undefined ||
    typeof receipt.stack !== 'number' ||
    !Number.isFinite(receipt.stack) ||
    receipt.stack < 0 ||
    Math.round(receipt.stack * 100) / 100 !== receipt.stack ||
    (receipt.asset === 'diamonds' && !Number.isSafeInteger(receipt.stack)) ||
    receipt.seat_number !== scope.seatNumber ||
    receipt.occupancy_id !== scope.occupancyId ||
    receipt.user_id !== scope.userId ||
    receipt.table_id !== scope.tableId ||
    receipt.idempotency_key !== 'cashout:occupancy:' + scope.occupancyId ||
    typeof receipt.credited !== 'boolean' ||
    typeof receipt.tournament_table !== 'boolean'
  ) {
    throw new Error('Cash-out receipt does not confirm the requested occupancy');
  }
  return receipt as unknown as SeatCashoutReceipt;
}

export async function getSeatCashoutReceipt(
  userId: string,
  tableId: string,
  seatNumber: number,
  occupancyId: string
): Promise<SeatCashoutReceipt | null> {
  const { data, error } = await supabase.rpc('fn_get_seat_cashout_receipt', {
    p_user_id: userId,
    p_table_id: tableId,
    p_seat_number: seatNumber,
    p_occupancy_id: occupancyId,
  });
  if (error) throw new Error(String(error.message || 'Cashout outcome lookup failed'));
  return data === null
    ? null
    : confirmedCashout(data, { userId, tableId, seatNumber, occupancyId });
}

/** Only the original authenticated administrator may replay retained authority. */
export async function getAdminSeatCashoutReceipt(
  actorId: string,
  userId: string,
  tableId: string,
  seatNumber: number,
  occupancyId: string
): Promise<SeatCashoutReceipt | null> {
  const { data, error } = await supabase.rpc('fn_get_admin_seat_cashout_receipt', {
    p_actor_id: actorId,
    p_user_id: userId,
    p_table_id: tableId,
    p_seat_number: seatNumber,
    p_occupancy_id: occupancyId,
  });
  if (error) throw new Error(String(error.message || 'Admin cashout outcome lookup failed'));
  return data === null
    ? null
    : confirmedCashout(data, { userId, tableId, seatNumber, occupancyId });
}

export interface AdminDepartureAuthority {
  actorId: string;
  clubId: string;
  reason: string;
}

export async function requestSeatDeparture(
  userId: string,
  tableId: string,
  seatNumber: number,
  occupancyId: string,
  leaveMode: 'voluntary' | 'forced',
  admin?: AdminDepartureAuthority
): Promise<void> {
  if (admin && leaveMode !== 'forced') throw new Error('Admin Departure Must Be Forced');
  const { data, error } = await supabase.rpc(
    admin ? 'fn_request_admin_seat_departure' : 'fn_request_seat_departure',
    {
      p_user_id: userId,
      p_table_id: tableId,
      p_seat_number: seatNumber,
      p_occupancy_id: occupancyId,
      ...(admin
        ? {
            p_actor_id: admin.actorId,
            p_club_id: admin.clubId,
            p_reason: admin.reason,
          }
        : { p_leave_mode: leaveMode }),
    }
  );
  if (error) throw new Error(error.message || 'Departure Request Failed');
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.accepted !== true ||
    data.user_id !== userId ||
    data.table_id !== tableId ||
    data.seat_number !== seatNumber ||
    data.occupancy_id !== occupancyId ||
    !['voluntary', 'forced'].includes(data.leave_mode) ||
    (leaveMode === 'forced' && data.leave_mode !== 'forced') ||
    typeof data.tournament_table !== 'boolean'
  ) {
    throw new Error('Departure Request Was Not Confirmed');
  }
  if (admin) {
    const authority = data.admin_authorization;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !authority ||
      authority.occupancy_id !== occupancyId ||
      typeof authority.actor_id !== 'string' ||
      !uuid.test(authority.actor_id) ||
      authority.club_id !== admin.clubId ||
      typeof authority.reason !== 'string' ||
      authority.reason.trim().length === 0
    ) {
      throw new Error('Admin Departure Authority Was Not Confirmed');
    }
  }
}

export async function markSeatAsLeft(
  tableId: string,
  userId: string,
  seatNumber: number,
  occupancyId: string | undefined
): Promise<void> {
  await atomicCashout(userId, tableId, seatNumber, { occupancyId });
}

/**
 * Atomic cashout for the original occupancy. Returns its committed amount.
 * An unknown or stale occupancy rejects instead of claiming a zero cashout.
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
 * richer return type so handled refusals keep the number contract. Without a
 * failure callback an unconfirmed departure rejects, so awaiting callers
 * cannot accidentally execute success cleanup.
 */
export interface CashoutOptions {
  /** Captured from the original roster/seat read, never refreshed on retry. */
  occupancyId: string | undefined;
  /** 'vpip_evicted' (Dan 2026-09-05): a nit-game eviction - a system exit
      that also bars the player from this game for the rejoin window. */
  leaveMode?: 'voluntary' | 'forced' | 'vpip_evicted';
  onLocked?: (stayRemainingMs: number) => void;
  onFailed?: (message: string) => void;
}

const LEAVE_LOCKED_RE = /LEAVE_LOCKED:(\d+)/;

export async function atomicCashout(
  userId: string,
  tableId: string,
  seatNumber: number,
  opts: CashoutOptions
): Promise<number> {
  // 2026-08-27: read + credit + vacate now happen in ONE transaction, with the
  // seat row held under FOR UPDATE. See the block comment at the top of this
  // file: the old three-round-trip sequence let an add-on commit between the
  // read and the credit, and the difference was destroyed.
  //
  // The RPC verifies the captured occupancy before crediting or exiting.
  // Its durable receipt makes a lost-response retry independent of later seats.
  try {
    const occupancyId = opts.occupancyId;
    if (
      typeof occupancyId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(occupancyId) ||
      !Number.isInteger(seatNumber)
    ) {
      throw new Error('Cash-out requires the original seat occupancy');
    }
    const { data, error } = await supabase.rpc('fn_cashout_seat_occupancy', {
      p_user_id: userId,
      p_table_id: tableId,
      p_seat_number: seatNumber,
      p_occupancy_id: occupancyId,
      p_leave_mode: opts?.leaveMode ?? null,
    });

    if (error) {
      const locked = LEAVE_LOCKED_RE.exec(String(error.message || ''));
      if (locked && opts?.onLocked) {
        // Refused by the stay clock. Not a failure: the player is still in
        // their chair and the caller shows them the countdown.
        opts?.onLocked?.(Number(locked[1]));
        return 0;
      }
      throw new Error(String(error.message || 'cash-out failed'));
    }

    const receipt = confirmedCashout(data, { userId, tableId, seatNumber, occupancyId });
    void notifyWaitlistSeatOpen(tableId);
    pushFinancialUpdate(userId, {
      tableId,
      asset: receipt.asset,
      ledgerEntry:
        receipt.stack > 0 ? { direction: 'in', amount: receipt.stack, kind: 'cashout' } : null,
    });
    return receipt.stack;
  } catch (err: any) {
    console.warn(
      `[atomicCashout] Departure unconfirmed for ${userId} at ${tableId} - retain tracking for retry:`,
      err?.message
    );
    if (!opts?.onFailed) throw err;
    opts.onFailed(String(err?.message || 'transport failure'));
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
   * are now ahead with clock remaining) the seat and durable pending request
   * remain. The caller can show the countdown; losing that in-memory display
   * must not lose an accepted departure after an engine restart.
   */
  onLocked?: (userId: string, stayRemainingMs: number, occupancyId: string) => void
): Promise<Array<{ userId: string; occupancyId: string }>> {
  /* Deliberately does NOT select `stack`. This query only ENUMERATES which
     seats asked to leave; the amount comes from the locked read inside
     atomic_seat_cashout_locked. `stack` was selected here and never used, which
     is precisely the shape that invites someone to "save a round-trip" by
     passing it along - and an unlocked stack read handed to a credit is the
     2026-08-27 race. Do not add it back. */
  const { data: pendingSeats, error: pendingReadError } = await supabase
    .from('table_seats')
    .select('user_id, seat_number, occupancy_id')
    .eq('table_id', tableId)
    .eq('leave_pending', true)
    .is('left_at', null);

  if (pendingReadError)
    throw new Error(pendingReadError.message || 'Pending Departure Read Failed');
  if (!pendingSeats || pendingSeats.length === 0) return [];

  const cashedOut: Array<{ userId: string; occupancyId: string }> = [];
  for (const seat of pendingSeats) {
    const out: { lockedMs: number | null; failed: boolean } = { lockedMs: null, failed: false };
    await atomicCashout(seat.user_id, tableId, seat.seat_number, {
      occupancyId: seat.occupancy_id,
      // The database applies durable forced authority for this exact occupancy.
      leaveMode: 'voluntary',
      onLocked: (ms) => {
        out.lockedMs = ms;
      },
      onFailed: () => {
        out.failed = true;
      },
    });
    if (out.lockedMs !== null) {
      // Refusal does not cancel the accepted departure. Keep the durable
      // pending flag so a new engine process reads the same occupancy after
      // restart; the in-memory countdown callback is presentation only.
      onLocked?.(seat.user_id, out.lockedMs, seat.occupancy_id);
      continue;
    }
    // Any other failure: the seat is untouched (one transaction) and the next
    // sweep retries it. Only a seat that actually left is reported as gone.
    if (out.failed) continue;
    cashedOut.push({ userId: seat.user_id, occupancyId: seat.occupancy_id });
  }

  // Each confirmed atomicCashout already updates the player count in its
  // transaction and offers the seat. A second unlocked recount can overwrite
  // a concurrent join's count and must not be issued here.

  // Round 57: callers use this list to unregister disconnect tracking for
  // players who cashed out. Without this, DisconnectEngine.playerStates leaks.
  return cashedOut;
}
