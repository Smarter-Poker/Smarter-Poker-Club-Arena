import { describe, it, expect } from 'vitest';
import { TableBreakEngine, type TableSnapshot } from './TableBreakEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

/**
 * A6 regression suite — "TableBreak drops a player".
 *
 * The old calculateRedistribution walked a round-robin index over a list that
 * was sorted by player count exactly once. When the table at that index AND the
 * one after it were both full it ran `continue`, silently discarding the
 * player — losing their seat and their whole stack from the tournament, even
 * when other tables still had open seats.
 *
 * These tests pin the invariant that matters: every chip that sits down at the
 * broken table is accounted for afterwards, either as a movement or as an
 * explicitly reported `unplaced` player. Never as nothing.
 */

const noopScheduler = {
  start() {},
  stop() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

function engine() {
  return new TableBreakEngine(undefined, noopScheduler);
}

function table(
  tableId: string,
  maxPlayers: number,
  occupiedSeats: number[],
  players: Array<{ playerId: string; seat: number; stack: number }> = []
): TableSnapshot {
  return {
    tableId,
    playerCount: occupiedSeats.length,
    maxPlayers,
    occupiedSeats: [...occupiedSeats],
    players,
  };
}

function broken(...specs: Array<[string, number, number]>): TableSnapshot {
  const players = specs.map(([playerId, seat, stack]) => ({ playerId, seat, stack }));
  return {
    tableId: 'broken',
    playerCount: players.length,
    maxPlayers: 9,
    occupiedSeats: players.map((p) => p.seat),
    players,
  };
}

describe('TableBreakEngine.planRedistribution - A6 chip/seat conservation', () => {
  it('seats every player when capacity exists', () => {
    const b = broken(['p1', 1, 1000], ['p2', 3, 2000], ['p3', 5, 3000]);
    const plan = engine().planRedistribution(b, [
      table('t1', 9, [1, 2, 3]),
      table('t2', 9, [1, 2]),
    ]);

    expect(plan.unplaced).toEqual([]);
    expect(plan.movements).toHaveLength(3);
    expect(new Set(plan.movements.map((m) => m.playerId))).toEqual(new Set(['p1', 'p2', 'p3']));
  });

  it('THE A6 BUG: does not drop a player when the round-robin-adjacent tables are full', () => {
    // t_full_a and t_full_b are the first two tables the old round-robin index
    // landed on, and both are at capacity — the old code hit `continue` and the
    // player evaporated. t_room has three open seats the whole time.
    const b = broken(['victim', 4, 12345]);
    const plan = engine().planRedistribution(b, [
      table('t_full_a', 6, [1, 2, 3, 4, 5, 6]),
      table('t_full_b', 6, [1, 2, 3, 4, 5, 6]),
      table('t_room', 6, [1, 2, 3]),
    ]);

    expect(plan.unplaced).toEqual([]);
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]).toMatchObject({
      playerId: 'victim',
      fromTableId: 'broken',
      fromSeat: 4,
      toTableId: 't_room',
      stack: 12345,
    });
    expect([4, 5, 6]).toContain(plan.movements[0].toSeat);
  });

  it('conserves every chip: moved stacks + unplaced stacks === original total', () => {
    const b = broken(
      ['p1', 1, 500],
      ['p2', 2, 1500],
      ['p3', 3, 2500],
      ['p4', 4, 3500],
      ['p5', 5, 4500]
    );
    const total = 500 + 1500 + 2500 + 3500 + 4500;

    // Only two open seats across the whole tournament.
    const plan = engine().planRedistribution(b, [
      table('t1', 6, [1, 2, 3, 4, 5]),
      table('t2', 6, [1, 2, 3, 4, 5]),
      table('t3', 6, [1, 2, 3, 4, 5, 6]),
    ]);

    const moved = plan.movements.reduce((s, m) => s + m.stack, 0);
    const stranded = plan.unplaced.reduce((s, u) => s + u.stack, 0);

    expect(plan.movements).toHaveLength(2);
    expect(plan.unplaced).toHaveLength(3);
    expect(moved + stranded).toBe(total);
    // and every player is accounted for exactly once
    const seen = [
      ...plan.movements.map((m) => m.playerId),
      ...plan.unplaced.map((u) => u.playerId),
    ];
    expect(new Set(seen).size).toBe(5);
  });

  it('reports every player as unplaced when there are no remaining tables', () => {
    const b = broken(['p1', 1, 100], ['p2', 2, 200]);
    const plan = engine().planRedistribution(b, []);
    expect(plan.movements).toEqual([]);
    expect(plan.unplaced.map((u) => u.playerId)).toEqual(['p1', 'p2']);
    expect(plan.unplaced.reduce((s, u) => s + u.stack, 0)).toBe(300);
  });

  it('never assigns two players the same seat at the same table', () => {
    const b = broken(
      ['p1', 1, 10],
      ['p2', 2, 10],
      ['p3', 3, 10],
      ['p4', 4, 10],
      ['p5', 5, 10],
      ['p6', 6, 10]
    );
    const plan = engine().planRedistribution(b, [table('t1', 9, [1]), table('t2', 9, [1])]);

    expect(plan.unplaced).toEqual([]);
    const keys = plan.movements.map((m) => `${m.toTableId}#${m.toSeat}`);
    expect(new Set(keys).size).toBe(keys.length);
    // and never onto an already-occupied seat
    for (const m of plan.movements) expect(m.toSeat).not.toBe(1);
  });

  it('balances by filling the emptiest table first', () => {
    const b = broken(['p1', 1, 10], ['p2', 2, 10]);
    const plan = engine().planRedistribution(b, [
      table('t_busy', 9, [1, 2, 3, 4, 5, 6, 7]),
      table('t_quiet', 9, [1]),
    ]);
    expect(plan.movements.map((m) => m.toTableId)).toEqual(['t_quiet', 't_quiet']);
  });

  it('does not mutate the caller snapshots, so planning twice is idempotent', () => {
    const b = broken(['p1', 1, 10], ['p2', 2, 10]);
    const targets = [table('t1', 9, [1, 2]), table('t2', 9, [1])];
    const before = JSON.stringify(targets);

    const e = engine();
    const first = e.planRedistribution(b, targets);
    expect(JSON.stringify(targets)).toBe(before);

    const second = e.planRedistribution(b, targets);
    expect(second.movements.map((m) => m.toTableId)).toEqual(
      first.movements.map((m) => m.toTableId)
    );
    expect(second.unplaced).toEqual(first.unplaced);
  });
});

describe('TableBreakEngine.calculateRedistribution - backwards-compatible wrapper', () => {
  it('still returns a plain movement list', () => {
    const b = broken(['p1', 1, 10]);
    const moves = engine().calculateRedistribution(b, [table('t1', 9, [1])]);
    expect(moves).toHaveLength(1);
    expect(moves[0].toTableId).toBe('t1');
  });

  it('returns only the placeable movements when a player cannot be seated', () => {
    const b = broken(['p1', 1, 10], ['p2', 2, 20]);
    const moves = engine().calculateRedistribution(b, [table('t1', 2, [1])]);
    expect(moves).toHaveLength(1);
  });
});

describe('TableBreakEngine.shouldBreak / checkRebalance', () => {
  it('breaks a table only when it is short-handed but not already empty', () => {
    const e = engine();
    expect(e.shouldBreak(0)).toBe(false);
    expect(e.shouldBreak(1)).toBe(true);
    expect(e.shouldBreak(2)).toBe(true);
    expect(e.shouldBreak(3)).toBe(false);
  });

  it('does not propose a rebalance move onto a table with no free seat', () => {
    const e = engine();
    const big = table(
      'big',
      9,
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [{ playerId: 'a', seat: 9, stack: 100 }]
    );
    // smallest has a low playerCount but every seat number is taken
    const small = table('small', 2, [1, 2], [{ playerId: 'b', seat: 1, stack: 50 }]);
    small.playerCount = 2;
    expect(e.checkRebalance([big, small])).toEqual([]);
  });
});
