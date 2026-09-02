import { describe, it, expect } from 'vitest';
import {
  planOrphanReseats,
  planStalledConsolidation,
  describeUnmovableOrphans,
  isOpenTable,
  MAX_ORPHAN_RESEATS_PER_PASS,
  type OrphanSeatRow,
  type OrphanTableRow,
} from './orphanedSeatRepair.js';

/**
 * Every case below is a rule the repair must keep. The first one is the live
 * tournament this module was written for; the rest are the ways a repair like
 * this has cost money before, borrowed from the incidents already recorded in
 * executePlayerMoves.
 */

const open = (id: string, max = 9): OrphanTableRow => ({ id, status: 'running', max_players: max });
const closed = (id: string, max = 9): OrphanTableRow => ({
  id,
  status: 'closed',
  max_players: max,
});
const seat = (
  table_id: string,
  user_id: string,
  seat_number: number,
  stack: number | string
): OrphanSeatRow => ({ table_id, user_id, seat_number, stack });

describe('planOrphanReseats', () => {
  it('brings the $100 Freeroll stall back to life: one player left on a closed table', () => {
    // 2026-09-01, tournament 73ebcc3b: table 43 open with the chip leader,
    // table 37 closed and still holding the other entrant.
    const tables = [open('t43'), closed('t37')];
    const seats = [seat('t43', 'chipleader', 2, 4680246.92), seat('t37', 'stranded', 2, 11481.5)];

    const plan = planOrphanReseats(tables, seats);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      playerId: 'stranded',
      fromTableId: 't37',
      fromSeat: 2,
      toTableId: 't43',
      reason: 'orphaned_seat_on_closed_table',
    });
    // Seat 2 is taken on the destination, so the lowest free seat is 1.
    expect(plan[0].toSeat).toBe(1);
  });

  it('never moves a player who is already sitting on open felt', () => {
    const tables = [open('t1'), closed('t2')];
    const seats = [seat('t1', 'p1', 3, 500), seat('t2', 'p1', 4, 900)];

    // Two live seats is a money question (which stack is real), not a repair.
    expect(planOrphanReseats(tables, seats)).toEqual([]);
    expect(describeUnmovableOrphans(tables, seats).duplicateSeat).toEqual(['p1']);
  });

  it('never moves a stranded seat with no chips', () => {
    const tables = [open('t1'), closed('t2')];
    const seats = [seat('t1', 'p1', 1, 1000), seat('t2', 'busted', 5, 0)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
    expect(describeUnmovableOrphans(tables, seats).noChips).toEqual(['busted']);
  });

  it('plans nothing when there is no open table - the reopen sweep owns that', () => {
    const tables = [closed('t1'), closed('t2')];
    const seats = [seat('t1', 'p1', 1, 1000), seat('t2', 'p2', 1, 2000)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('leaves players on open tables alone', () => {
    const tables = [open('t1'), open('t2')];
    const seats = [seat('t1', 'p1', 1, 100), seat('t2', 'p2', 1, 100)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('fills the emptiest open table first and never doubles up a seat number', () => {
    const tables = [open('busy'), open('quiet'), closed('gone')];
    const seats = [
      seat('busy', 'a', 1, 10),
      seat('busy', 'b', 2, 10),
      seat('quiet', 'c', 1, 10),
      seat('gone', 'x', 4, 50),
      seat('gone', 'y', 5, 40),
    ];

    const plan = planOrphanReseats(tables, seats);

    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.playerId)).toEqual(['x', 'y']); // biggest stack first
    // 'quiet' holds one player against 'busy' with two, so it takes the first
    // arrival; that fills it to two, and the tie then breaks by table id.
    expect(plan[0]).toMatchObject({ toTableId: 'quiet', toSeat: 2 });
    expect(plan[1]).toMatchObject({ toTableId: 'busy', toSeat: 3 });
  });

  it('does not overfill a table past max_players', () => {
    const tables = [open('small', 2), closed('gone')];
    const seats = [seat('small', 'a', 1, 10), seat('small', 'b', 2, 10), seat('gone', 'x', 1, 50)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('a deleted table is not felt, however its status reads', () => {
    const tables: OrphanTableRow[] = [
      { id: 'ghost', status: 'running', is_deleted: true, max_players: 9 },
      closed('gone'),
    ];
    const seats = [seat('gone', 'x', 1, 50)];

    expect(isOpenTable(tables[0])).toBe(false);
    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('stands down when the same player is stranded on two closed tables', () => {
    const tables = [open('t1'), closed('t2'), closed('t3')];
    const seats = [seat('t2', 'twice', 1, 100), seat('t3', 'twice', 2, 250)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('ignores a seat pointing at a table this tournament does not own', () => {
    const tables = [open('t1')];
    const seats = [seat('someone-elses-table', 'p1', 1, 100)];

    expect(planOrphanReseats(tables, seats)).toEqual([]);
  });

  it('respects the per-pass budget so a broken board cannot become an outage', () => {
    const tables = [open('felt', 30), closed('gone', 30)];
    const seats: OrphanSeatRow[] = [];
    for (let i = 0; i < MAX_ORPHAN_RESEATS_PER_PASS + 5; i++) {
      seats.push(seat('gone', `p${i}`, i + 1, 100 + i));
    }

    expect(planOrphanReseats(tables, seats)).toHaveLength(MAX_ORPHAN_RESEATS_PER_PASS);
    expect(planOrphanReseats(tables, seats, 3)).toHaveLength(3);
  });

  it('reads a stack that arrives as a numeric string, as Supabase sends it', () => {
    const tables = [open('t1'), closed('t2')];
    const seats = [seat('t2', 'p1', 1, '11481.50')];

    expect(planOrphanReseats(tables, seats)).toHaveLength(1);
  });
});

/**
 * TWO PLAYERS, TWO TABLES, NOBODY CAN DEAL (2026-09-02).
 *
 * The second live stall of the same night, a different shape from the orphan:
 * "$100 Freeroll - 6:00 PM" (f1b134c0), RUNNING, 314 hands then nothing for 35
 * minutes, two players still playing, two live seats, TWO OPEN TABLES with one
 * player on each. Nothing is orphaned, so the planner above sees nothing - and
 * neither table can deal, because a table needs two.
 *
 * Moving a player off OPEN felt is dangerous in a way that moving one off a
 * closed table is not: a hand may be in flight and `executePlayerMoves` reads
 * the seat stack, which is the 2026-07-19 pre-hand-stack incident. So `stalled`
 * is not a hint, it is the entire licence, and every refusal below exists to
 * keep this off a game that can still play.
 */
describe('planStalledConsolidation', () => {
  const open = (id: string, max = 9): OrphanTableRow => ({
    id,
    status: 'running',
    max_players: max,
  });
  const seat = (table_id: string, user_id: string, seat_number: number): OrphanSeatRow => ({
    table_id,
    user_id,
    seat_number,
    stack: 1000,
  });

  it('brings the 6:00 PM freeroll back together', () => {
    const plan = planStalledConsolidation({
      tables: [open('tA'), open('tB')],
      liveSeats: [seat('tA', 'p1', 4), seat('tB', 'p2', 2)],
      stalled: true,
    });
    expect(plan).toHaveLength(1);
    // tA and tB hold one each, so the tie breaks by id: tA is the destination.
    expect(plan[0]).toMatchObject({
      playerId: 'p2',
      fromTableId: 'tB',
      toTableId: 'tA',
      reason: 'stalled_field_consolidation',
    });
  });

  it('does NOTHING unless the caller says the tournament is stalled', () => {
    expect(
      planStalledConsolidation({
        tables: [open('tA'), open('tB')],
        liveSeats: [seat('tA', 'p1', 1), seat('tB', 'p2', 1)],
        stalled: false,
      })
    ).toEqual([]);
  });

  it('keeps its hands off a table that can already deal', () => {
    // Two on tA means the game is not blocked on seating. That is the
    // balancer's ordinary work, and the balancer waits for a hand boundary.
    expect(
      planStalledConsolidation({
        tables: [open('tA'), open('tB')],
        liveSeats: [seat('tA', 'p1', 1), seat('tA', 'p2', 2), seat('tB', 'p3', 1)],
        stalled: true,
      })
    ).toEqual([]);
  });

  it('has nothing to do with one table open', () => {
    expect(
      planStalledConsolidation({
        tables: [open('tA')],
        liveSeats: [seat('tA', 'p1', 1)],
        stalled: true,
      })
    ).toEqual([]);
  });

  it('moves the fewest people: the most populated table wins', () => {
    const plan = planStalledConsolidation({
      tables: [open('tSmall'), open('tBig')],
      // Neither can deal at a 3-handed floor, and tBig already holds two.
      liveSeats: [seat('tSmall', 'p1', 1), seat('tBig', 'p2', 1), seat('tBig', 'p3', 2)],
      stalled: true,
      minPlayersToDeal: 3,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ playerId: 'p1', toTableId: 'tBig' });
  });

  it('never seats two people in the same chair', () => {
    const plan = planStalledConsolidation({
      tables: [open('tA'), open('tB'), open('tC')],
      liveSeats: [seat('tA', 'p1', 1), seat('tB', 'p2', 1), seat('tC', 'p3', 1)],
      stalled: true,
      minPlayersToDeal: 4,
    });
    const dests = plan.map((m) => `${m.toTableId}:${m.toSeat}`);
    expect(new Set(dests).size).toBe(dests.length);
    expect(dests).not.toContain('tA:1');
  });

  it('stands down when a player holds two live seats', () => {
    // Which of two stacks is real is a money question, not a seating one.
    expect(
      planStalledConsolidation({
        tables: [open('tA'), open('tB')],
        liveSeats: [seat('tA', 'twice', 1), seat('tB', 'twice', 1)],
        stalled: true,
      })
    ).toEqual([]);
  });

  it('stands down when the field does not fit on the destination', () => {
    expect(
      planStalledConsolidation({
        tables: [open('tA', 2), open('tB', 2), open('tC', 2)],
        liveSeats: [seat('tA', 'p1', 1), seat('tB', 'p2', 1), seat('tC', 'p3', 1)],
        stalled: true,
        minPlayersToDeal: 4,
      })
    ).toEqual([]);
  });
});
