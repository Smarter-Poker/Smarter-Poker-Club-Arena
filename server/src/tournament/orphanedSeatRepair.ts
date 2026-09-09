/**
 * =========================================================================
 *  A PLAYER LEFT ON A CLOSED TABLE IS A TOURNAMENT THAT CANNOT DEAL
 * =========================================================================
 *
 * Measured live on 2026-09-01, and this module exists for that one row.
 *
 *   "$100 Freeroll - 12:00 AM"  (73ebcc3b)
 *     status RUNNING, 7,844 hands dealt, then NOTHING for 5 hours 21 minutes
 *     tournament_players: 2 'playing'
 *     table 43  status 'running'  1 live seat, stack 4,680,246.92
 *     table 37  status 'closed'   1 live seat, stack 11,481.50
 *
 * The second player was never moved off table 37 and never released from it,
 * so the engine counted two live entrants, the one table that could deal held
 * one of them, and the hand that would end the tournament could never be
 * dealt. 11,482 chips and the whole event sat there.
 *
 * WHY NO EXISTING SWEEP CATCHES IT. There are three and this state falls
 * between all of them, which is why it can sit for hours:
 *
 *   decided-but-running       requires playing <= 1   - this had 2
 *   started-but-never-dealt   requires 0 hands        - this had 7,844
 *   reopen-closed-tables      requires NO open table  - this had one open
 *
 * The third is the closest and it declines deliberately: reopening table 37
 * would put a second felt under a two-player tournament. The repair is not to
 * reopen the closed table, it is to bring the stranded player TO the felt that
 * is already open, which is what the balancer would have done had it ever seen
 * the seat. It cannot: checkTableBalance iterates `tableEngines`, and a closed
 * table has no engine.
 *
 * The planner is pure so every rule below is pinned without a database.
 * TournamentManager owns the reads and hands the plan to `executePlayerMoves`,
 * which is the one hardened move path on the platform (source stack read
 * first, duplicate-seat claim check, update-first seat reuse, false-negative
 * detection on the destination write). This module never writes.
 */

import type { MoveInstruction } from '../engine/TableBalancer.js';

/** A `tables` row belonging to one tournament. */
export interface OrphanTableRow {
  id: string;
  status?: string | null;
  is_deleted?: boolean | null;
  max_players?: number | null;
}

/** A `table_seats` row with `left_at IS NULL` on one of those tables. */
export interface OrphanSeatRow {
  table_id: string;
  user_id: string;
  seat_number?: number | null;
  stack?: number | string | null;
}

/**
 * One pass never moves more than a single table's worth of players. A
 * pathological board cannot turn this repair into its own outage, and the
 * sweep runs every minute, so a genuine backlog drains in minutes.
 */
export const MAX_ORPHAN_RESEATS_PER_PASS = 9;
export const CLOSED_ORPHAN_RESEAT_REASON = 'orphaned_seat_on_closed_table';

/** Seats a table has when the row does not say. Matches the balancer default. */
const DEFAULT_MAX_SEATS = 9;

/** Deleted is gone; closed cannot be dealt at. Everything else is felt. */
export function isOpenTable(row: OrphanTableRow | null | undefined): boolean {
  if (!row) return false;
  if (row.is_deleted === true) return false;
  return String(row.status ?? '').toLowerCase() !== 'closed';
}

function toStack(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decide which stranded players to bring back to an open table.
 *
 * Conservative on every axis, and each of these is a test:
 *
 *   - a live seat on an OPEN table is never touched;
 *   - a player who ALREADY holds a live seat on an open table is never
 *     re-seated. Their extra row is a duplicate-seat problem, and moving one
 *     of two live seats writes a third - the exact failure `mayTakeSeat` was
 *     added to `executePlayerMoves` to stop. It is reported, not moved;
 *   - a stranded seat with no chips is never moved. A zero stack is a busted
 *     player, and the elimination path owns that; re-seating one would put an
 *     empty chair back in the game;
 *   - with no open table there is no plan at all. `liveTournamentTableRecovery`
 *     owns that case and will put felt back first;
 *   - the destination is the emptiest open table with a free seat, ties broken
 *     by table id, and the seat is the lowest free number - deterministic, so
 *     two engines planning the same repair plan the same move rather than two
 *     conflicting ones.
 */
export function planOrphanReseats(
  tables: OrphanTableRow[],
  liveSeats: OrphanSeatRow[],
  budget: number = MAX_ORPHAN_RESEATS_PER_PASS
): MoveInstruction[] {
  const openTables = (tables ?? []).filter((t) => isOpenTable(t));
  if (openTables.length === 0) return [];

  const openIds = new Set(openTables.map((t) => String(t.id)));
  const knownTableIds = new Set((tables ?? []).map((t) => String(t.id)));

  // Live occupancy of the open tables, and who is already safely seated.
  const occupied = new Map<string, Set<number>>();
  const seatedOnOpenFelt = new Set<string>();
  for (const t of openTables) occupied.set(String(t.id), new Set<number>());

  for (const seat of liveSeats ?? []) {
    const tableId = String(seat.table_id ?? '');
    if (!openIds.has(tableId)) continue;
    seatedOnOpenFelt.add(String(seat.user_id));
    const n = Number(seat.seat_number);
    if (Number.isFinite(n)) occupied.get(tableId)?.add(n);
  }

  const orphans = (liveSeats ?? []).filter((seat) => {
    const tableId = String(seat.table_id ?? '');
    // A seat pointing at a table this tournament does not own is not ours to
    // reason about, and an open table is not a strand.
    if (!knownTableIds.has(tableId) || openIds.has(tableId)) return false;
    if (seatedOnOpenFelt.has(String(seat.user_id))) return false;
    return toStack(seat.stack) > 0;
  });

  // One player can only be stranded once. If two closed tables both hold a
  // live row for them, that is the duplicate-seat case again: stand down.
  const orphanCount = new Map<string, number>();
  for (const seat of orphans) {
    const id = String(seat.user_id);
    orphanCount.set(id, (orphanCount.get(id) ?? 0) + 1);
  }

  const movable = orphans
    .filter((seat) => orphanCount.get(String(seat.user_id)) === 1)
    .sort((a, b) => {
      // Biggest stack first: if the budget bites, the chips most likely to
      // still be contesting the tournament get back to the felt first.
      const diff = toStack(b.stack) - toStack(a.stack);
      if (diff !== 0) return diff;
      return String(a.user_id).localeCompare(String(b.user_id));
    });

  const maxSeatsById = new Map<string, number>();
  for (const t of openTables) {
    const max = Number(t.max_players);
    maxSeatsById.set(String(t.id), Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_SEATS);
  }

  const plans: MoveInstruction[] = [];
  for (const seat of movable) {
    if (plans.length >= Math.max(0, budget)) break;

    const destination = openTables
      .slice()
      .sort((a, b) => {
        const an = occupied.get(String(a.id))?.size ?? 0;
        const bn = occupied.get(String(b.id))?.size ?? 0;
        if (an !== bn) return an - bn;
        return String(a.id).localeCompare(String(b.id));
      })
      .find((t) => {
        const taken = occupied.get(String(t.id)) ?? new Set<number>();
        const max = maxSeatsById.get(String(t.id)) ?? DEFAULT_MAX_SEATS;
        return taken.size < max;
      });
    if (!destination) break; // every open table is full - nothing to plan

    const destId = String(destination.id);
    const taken = occupied.get(destId) ?? new Set<number>();
    const max = maxSeatsById.get(destId) ?? DEFAULT_MAX_SEATS;
    let toSeat = 0;
    for (let n = 1; n <= max; n++) {
      if (!taken.has(n)) {
        toSeat = n;
        break;
      }
    }
    if (toSeat === 0) break;

    const fromSeat = Number(seat.seat_number);
    plans.push({
      playerId: String(seat.user_id),
      fromTableId: String(seat.table_id),
      fromSeat: Number.isFinite(fromSeat) ? fromSeat : 0,
      toTableId: destId,
      toSeat,
      reason: CLOSED_ORPHAN_RESEAT_REASON,
    });
    taken.add(toSeat);
  }

  return plans;
}

/**
 * A player still on the roster who holds NO chair at all.
 *
 * `last_stack` is the stack on the most recent seat they left, which is where
 * their chips stand: `executePlayerMoves` reads the source stack before it
 * vacates a chair, and `fn_ca_settle_hand_stacks_absolute` carries a hand
 * result to the chair a player left when they hold none.
 */
export interface SeatlessRosterRow {
  user_id: string;
  last_table_id?: string | null;
  last_seat_number?: number | null;
  last_stack?: number | string | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PLAYER WITH CHIPS AND NO CHAIR IS BROUGHT BACK TO THE FELT (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `planOrphanReseats` above answers "a live seat on a table that cannot deal".
 * This answers the other half of the same failure, and nothing on the platform
 * answered it: a player who is `playing` on the roster and holds no live seat
 * ANYWHERE. Their chips sit on the chair they left, outside every reader that
 * counts open seats, and they cannot be dealt a hand.
 *
 * Measured 2026-09-09: eight players across four running events holding
 * 673,500 chips between them, one of them out of their chair since 04:48 the
 * previous morning. The conservation check saw them only as a bare number -
 * "Midday Free Buy drift -296,000" - which is, to the chip, those five
 * players' stacks.
 *
 * How they get there: `executePlayerMoves` vacates the source chair and then
 * writes the destination. Every failure after the vacate restores the source,
 * and a destination write that failed client-side but committed is detected -
 * but a process that dies between the two leaves nobody to do either, and the
 * player is seatless with their chips on a chair marked left.
 *
 * The rules are `planOrphanReseats`'s rules, for the same reasons:
 *
 *   - no chips, no move. A zero stack is a busted player and the elimination
 *     path owns them; re-seating one would put an empty chair back in the game;
 *   - a player who holds ANY live seat is not seatless and is never touched;
 *   - with no open table there is no plan; `liveTournamentTableRecovery` puts
 *     felt back first;
 *   - the same deterministic destination - emptiest open table with a free
 *     chair, ties by table id, lowest free seat - so two engines planning the
 *     same repair plan the same move;
 *   - the same per-pass budget, shared with the orphan planner by the caller.
 *
 * `fromTableId` and `fromSeat` name the chair they LEFT. That chair is where
 * their stack is, and `executePlayerMoves` reads it there for this reason.
 */
export function planSeatlessReseats(
  tables: OrphanTableRow[],
  liveSeats: OrphanSeatRow[],
  seatless: SeatlessRosterRow[],
  budget: number = MAX_ORPHAN_RESEATS_PER_PASS
): MoveInstruction[] {
  const openTables = (tables ?? []).filter((t) => isOpenTable(t));
  if (openTables.length === 0) return [];

  const openIds = new Set(openTables.map((t) => String(t.id)));

  // Anyone holding a live seat anywhere is not seatless, whatever the roster
  // read said a moment earlier. Reads are not simultaneous.
  const holdsALiveSeat = new Set((liveSeats ?? []).map((s) => String(s.user_id)));

  const occupied = new Map<string, Set<number>>();
  for (const t of openTables) occupied.set(String(t.id), new Set<number>());
  for (const seat of liveSeats ?? []) {
    const tableId = String(seat.table_id ?? '');
    if (!openIds.has(tableId)) continue;
    const n = Number(seat.seat_number);
    if (Number.isFinite(n)) occupied.get(tableId)?.add(n);
  }

  const movable = (seatless ?? [])
    .filter((r) => !holdsALiveSeat.has(String(r.user_id)))
    .filter((r) => toStack(r.last_stack) > 0)
    .filter((r) => String(r.last_table_id ?? '') !== '')
    .sort((a, b) => {
      const diff = toStack(b.last_stack) - toStack(a.last_stack);
      if (diff !== 0) return diff;
      return String(a.user_id).localeCompare(String(b.user_id));
    });

  const maxSeatsById = new Map<string, number>();
  for (const t of openTables) {
    const max = Number(t.max_players);
    maxSeatsById.set(String(t.id), Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_SEATS);
  }

  const plans: MoveInstruction[] = [];
  const planned = new Set<string>();
  for (const row of movable) {
    if (plans.length >= Math.max(0, budget)) break;
    const userId = String(row.user_id);
    if (planned.has(userId)) continue; // one player, one chair

    const destination = openTables
      .slice()
      .sort((a, b) => {
        const an = occupied.get(String(a.id))?.size ?? 0;
        const bn = occupied.get(String(b.id))?.size ?? 0;
        if (an !== bn) return an - bn;
        return String(a.id).localeCompare(String(b.id));
      })
      .find((t) => {
        const taken = occupied.get(String(t.id)) ?? new Set<number>();
        const max = maxSeatsById.get(String(t.id)) ?? DEFAULT_MAX_SEATS;
        return taken.size < max;
      });
    if (!destination) break;

    const destId = String(destination.id);
    const taken = occupied.get(destId) ?? new Set<number>();
    const max = maxSeatsById.get(destId) ?? DEFAULT_MAX_SEATS;
    let toSeat = 0;
    for (let n = 1; n <= max; n++) {
      if (!taken.has(n)) {
        toSeat = n;
        break;
      }
    }
    if (toSeat === 0) break;

    const fromSeat = Number(row.last_seat_number);
    plans.push({
      playerId: userId,
      fromTableId: String(row.last_table_id),
      fromSeat: Number.isFinite(fromSeat) ? fromSeat : 0,
      toTableId: destId,
      toSeat,
      reason: SEATLESS_RESEAT_REASON,
    });
    planned.add(userId);
    taken.add(toSeat);
  }

  return plans;
}

/**
 * The one reason string that tells `executePlayerMoves` the source chair is
 * already vacated, so it must read the stack from the seat they LEFT rather
 * than aborting on a live seat it will never find.
 */
export const SEATLESS_RESEAT_REASON = 'rostered_without_a_chair';

/**
 * The players this repair deliberately will not move, so the caller can say so
 * out loud instead of silently doing nothing. Both shapes are money decisions
 * that belong to a human or to the elimination path, never to a sweep.
 */
export function describeUnmovableOrphans(
  tables: OrphanTableRow[],
  liveSeats: OrphanSeatRow[]
): { duplicateSeat: string[]; noChips: string[] } {
  const openIds = new Set((tables ?? []).filter((t) => isOpenTable(t)).map((t) => String(t.id)));
  const knownTableIds = new Set((tables ?? []).map((t) => String(t.id)));
  const seatedOnOpenFelt = new Set(
    (liveSeats ?? []).filter((s) => openIds.has(String(s.table_id))).map((s) => String(s.user_id))
  );

  const duplicateSeat: string[] = [];
  const noChips: string[] = [];
  for (const seat of liveSeats ?? []) {
    const tableId = String(seat.table_id ?? '');
    if (!knownTableIds.has(tableId) || openIds.has(tableId)) continue;
    const userId = String(seat.user_id);
    if (seatedOnOpenFelt.has(userId)) {
      if (!duplicateSeat.includes(userId)) duplicateSeat.push(userId);
      continue;
    }
    if (toStack(seat.stack) <= 0 && !noChips.includes(userId)) noChips.push(userId);
  }
  return { duplicateSeat, noChips };
}
