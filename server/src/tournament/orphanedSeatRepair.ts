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
      reason: 'orphaned_seat_on_closed_table',
    });
    taken.add(toSeat);
  }

  return plans;
}

/**
 * =========================================================================
 *  TWO PLAYERS, TWO TABLES, NOBODY CAN DEAL (2026-09-02)
 * =========================================================================
 *
 * The second live stall of the same night, and a DIFFERENT shape from the one
 * above:
 *
 *   "$100 Freeroll - 6:00 PM"  (f1b134c0)
 *     status RUNNING, 314 hands dealt, then nothing for 35 minutes
 *     2 players still 'playing', 2 live seats
 *     TWO OPEN TABLES - one player on each
 *
 * Nothing here is orphaned: both seats are on open felt, so the repair above
 * plans nothing. And neither table can deal, because a table needs two.
 *
 * This is the balancer's job - `checkTableBalance` breaks a table and moves
 * its players - and the balancer had not done it for thirty-five minutes.
 * Whether its manager is wedged or its cycle is not firing cannot be
 * diagnosed from here; what can be said is that the outcome is identical to
 * the orphan case, and so is the repair.
 *
 * WHY THIS IS SAFE, AND WHY IT IS GATED ON A STALL. Moving a player off an
 * OPEN table is dangerous in a way that moving one off a CLOSED table is not:
 * a hand may be in flight, and `executePlayerMoves` reads the seat stack, so
 * a move mid-hand carries a pre-hand stack (the 2026-07-19 incident). The
 * balancer guards that with `waitForHandComplete`.
 *
 * So this is offered ONLY for a tournament the caller has already established
 * is stalled - no hand dealt for a long time - where no hand can be in
 * flight to disturb. `stalled` is not a hint; it is the whole licence.
 */
export interface ConsolidationInput {
  /** Every table row this tournament owns. */
  tables: OrphanTableRow[];
  /** Every seat with `left_at IS NULL` on those tables. */
  liveSeats: OrphanSeatRow[];
  /**
   * The caller's finding that this tournament has not dealt for long enough
   * that no hand can be in flight. Without it, nothing is planned at all.
   */
  stalled: boolean;
  /** Seats a table needs before it can deal. Two, everywhere on this platform. */
  minPlayersToDeal?: number;
}

/**
 * Bring a stalled, scattered field back onto one table.
 *
 * Refuses unless ALL of these hold, and each is a test:
 *
 *   - the caller says the tournament is stalled;
 *   - more than one table is open, so there is something to consolidate;
 *   - NO open table currently holds enough players to deal. If one does, the
 *     game can play on and this must keep its hands off it - that is the
 *     balancer's ordinary work, done with its own hand-boundary guard;
 *   - every live player fits on the destination.
 *
 * The destination is the open table that already holds the most players, ties
 * broken by id, so the fewest people move and two engines planning the same
 * repair plan the same one.
 */
export function planStalledConsolidation(input: ConsolidationInput): MoveInstruction[] {
  const minToDeal = Math.max(2, Math.trunc(input.minPlayersToDeal ?? 2));
  if (!input.stalled) return [];

  const openTables = (input.tables ?? []).filter((t) => isOpenTable(t));
  if (openTables.length < 2) return [];

  const openIds = new Set(openTables.map((t) => String(t.id)));
  const seatsOnOpen = (input.liveSeats ?? []).filter((s) => openIds.has(String(s.table_id)));

  const byTable = new Map<string, OrphanSeatRow[]>();
  for (const t of openTables) byTable.set(String(t.id), []);
  for (const seat of seatsOnOpen) byTable.get(String(seat.table_id))?.push(seat);

  /* If any open table can already deal, the game is not blocked on seating and
     this is not its problem. Leave it to the balancer, which waits for a hand
     boundary before it moves anybody. */
  for (const [, seats] of byTable) {
    if (seats.length >= minToDeal) return [];
  }

  /* A player holding two live seats is a money question, not a seating one -
     the same stance the orphan planner takes. */
  const seatCount = new Map<string, number>();
  for (const seat of seatsOnOpen) {
    const id = String(seat.user_id);
    seatCount.set(id, (seatCount.get(id) ?? 0) + 1);
  }
  if ([...seatCount.values()].some((n) => n > 1)) return [];

  const destination = openTables.slice().sort((a, b) => {
    const an = byTable.get(String(a.id))?.length ?? 0;
    const bn = byTable.get(String(b.id))?.length ?? 0;
    if (an !== bn) return bn - an; // most populated first: fewest moves
    return String(a.id).localeCompare(String(b.id));
  })[0];
  if (!destination) return [];

  const destId = String(destination.id);
  const destMax = (() => {
    const n = Number(destination.max_players);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SEATS;
  })();
  if (seatsOnOpen.length > destMax) return []; // they do not all fit; not this repair's call

  const taken = new Set<number>();
  for (const seat of byTable.get(destId) ?? []) {
    const n = Number(seat.seat_number);
    if (Number.isFinite(n)) taken.add(n);
  }

  const plans: MoveInstruction[] = [];
  for (const seat of seatsOnOpen) {
    if (String(seat.table_id) === destId) continue;
    let toSeat = 0;
    for (let n = 1; n <= destMax; n++) {
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
      reason: 'stalled_field_consolidation',
    });
    taken.add(toSeat);
  }
  return plans;
}

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
