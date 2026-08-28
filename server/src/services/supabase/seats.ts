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
export async function atomicCashout(
  userId: string,
  tableId: string,
  seatNumber?: number
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
    });

    if (error) {
      // The seat is untouched: the whole thing was one transaction, so a
      // failure here rolled back the credit AND the vacate together. The stack
      // is still on the seat and the next pass retries it. This is the property
      // the old code needed `safeToClearSeat` to approximate.
      console.warn(
        `[atomicCashout] Locked cash-out failed for ${userId} at ${tableId} — seat preserved for retry:`,
        error.message
      );
      return 0;
    }

    const stack = Number((data as any)?.stack ?? 0);
    if ((data as any)?.reason === 'no_active_seat') return 0;

    // Seat opened — notify the waitlist. Unchanged behaviour.
    void notifyWaitlistSeatOpen(tableId);
    return Number.isFinite(stack) ? stack : 0;
  } catch (err: any) {
    console.warn(
      `[atomicCashout] Transport failure for ${userId} at ${tableId} — seat preserved for retry:`,
      err?.message
    );
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
/** An offer a player has not acted on in this long is dead — release the
 *  queue head so the seat can be offered to the next person. Without this a
 *  single unclaimed offer jammed the queue permanently (nothing anywhere
 *  ever expired a 'notified' row). */
const WAITLIST_OFFER_TTL_MS = 3 * 60 * 1000;

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

    // Reclaim dead offers first, or the queue head can jam forever behind
    // one player (or horse) who never sat down.
    await supabase
      .from('table_waitlist')
      .update({ status: 'expired' })
      .eq('table_id', tableId)
      .eq('status', 'notified')
      .lt('notified_at', new Date(Date.now() - WAITLIST_OFFER_TTL_MS).toISOString());

    // Dan 2026-08-26 waitlist fix: the queue can contain horses (the fleet
    // seeds a short "atmosphere" queue behind hot tables). A horse can never
    // act on a seat-open notification, so offering it the seat silently
    // wasted the offer — regularly, since horses were often at the head.
    // Fetch the oldest few and notify the first HUMAN.
    /* ═══ NO ARBITRARY WINDOW ON THE QUEUE (Dan 2026-08-27) ═══════════════
       This fetched the ten oldest entries and then looked for a human among
       them. If the ten oldest all happened to be horses, it returned without
       notifying ANYBODY - while real people waited directly behind them. The
       queue is deliberately horse-seeded ("atmosphere"), so a horse-heavy
       head is the expected shape, not a freak one; the ten was simply a
       number somebody hoped was big enough.

       Measured 2026-08-27 before changing it: 12 tables with a queue, 22
       people waiting, no queue longer than 10 and no table with a human
       stranded behind ten horses - so this was latent, not live. Fixed
       anyway, because "big enough today" is exactly the reasoning that
       eventually is not.

       The window is gone rather than raised: walk the queue in order, a page
       at a time, until a human turns up or the queue runs out. No ceiling,
       and on the normal queue (22 people across 12 tables today) it is still
       exactly one round trip.

       DELIBERATELY NOT an embedded `profiles!inner(is_horse)` filter, which
       would have been one query instead of two: `table_waitlist.user_id`
       carries TWO foreign keys - one to `profiles(id)` and one to
       `auth.users(id)` - and an ambiguous embed resolves at PostgREST's
       discretion. If it ever answered 400, `data` is null, this function
       returns early, and seat offers stop going out ENTIRELY - silently, and
       far worse than the horse-heavy-head case being fixed. Two plain reads
       cannot fail that way. */
    const QUEUE_PAGE = 25;
    let next: { id: string; user_id: string } | undefined;
    for (let page = 0; ; page++) {
      if (page > 10_000) break; // anti-runaway assert, not a queue limit
      const { data: batch } = await supabase
        .from('table_waitlist')
        .select('id, user_id')
        .eq('table_id', tableId)
        .eq('status', 'waiting')
        .order('created_at', { ascending: true })
        .range(page * QUEUE_PAGE, page * QUEUE_PAGE + QUEUE_PAGE - 1);
      if (!batch || batch.length === 0) break;

      const ids = batch.map((r) => r.user_id as string);
      const { data: horseRows } = await supabase
        .from('profiles')
        .select('id')
        .in('id', ids)
        .eq('is_horse', true);
      const horseIds = new Set((horseRows ?? []).map((r) => r.id as string));
      const found = batch.find((r) => !horseIds.has(r.user_id as string));
      if (found) {
        next = found as { id: string; user_id: string };
        break;
      }
      if (batch.length < QUEUE_PAGE) break; // queue exhausted, all horses
    }
    if (!next) return; // nobody human is queued — nothing to offer

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

    // WEB PUSH, via the platform's real delivery path.
    //
    // This used to POST straight to onesignal.com. OneSignal was REMOVED from
    // this platform on 2026-08-19 and replaced by self-hosted VAPID web push —
    // pages/api/notifications/send.js says so in its header and rejects
    // OneSignal device ids outright. This block was written on 2026-08-26, a
    // week after that, so it has never delivered anything: the engine
    // container has no ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY (verified
    // 2026-08-27, `printenv | grep -c ONESIGNAL_APP_ID` returns 0 inside
    // club-arena-engine) and 48h of its logs contain zero OneSignal lines.
    //
    // The correct path needs no credentials at all. push_outbox is the durable
    // queue World Hub's /api/cron/push-dispatch drains every few minutes; it
    // loads the consent gate and calls gateDecision() on every row before
    // delivering, so a row written here is opt-out-respecting by construction
    // rather than by this file remembering to check. That also closes the
    // consent bypass the old raw insert had: send.js enforces preferences and
    // the engine went around it.
    //
    // A crash between the notification insert and this write costs one push,
    // never a duplicate: the outbox row is the only thing that sends.
    try {
      const { error: pushErr } = await supabase.from('push_outbox').insert({
        recipient_user_id: next.user_id,
        title: 'Seat Open',
        body: `A Seat Just Opened At ${tableRow.name || 'Your Waitlisted Table'}. Tap To Claim It.`,
        url: `/hub/club-arena/table/${tableId}`,
        event: 'waitlist_seat_open',
        related_entity_id: tableId,
        // Collapses repeat offers for the same table into one notification
        // shade entry rather than stacking them.
        tag: `seat-open-${tableId}`,
      });
      if (pushErr) {
        console.warn(`[Waitlist] push_outbox insert failed: ${pushErr.message}`);
      }
    } catch (pushErr) {
      console.warn(`[Waitlist] push enqueue threw for ${next.user_id.slice(0, 8)}:`, pushErr);
    }

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
