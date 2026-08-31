import { describe, it, expect } from 'vitest';
import {
  TableBalancer,
  currentBigBlindSeat,
  hopsToBigBlind,
  type BalancerTable,
  type BalancerPlayer,
} from './TableBalancer.js';

const seats = (list: number[], stackOf: (s: number) => number = () => 1000): BalancerPlayer[] =>
  list.map((seat) => ({ userId: `u${seat}`, seat, stack: stackOf(seat) }));

const table = (
  tableId: string,
  occupied: number[],
  maxSeats = 9,
  buttonSeat?: number
): BalancerTable => ({
  tableId,
  playerCount: occupied.length,
  maxSeats,
  buttonSeat,
  players: seats(occupied),
});

/** A table with N players in seats 1..N. */
const t = (id: string, n: number, maxSeats = 9, buttonSeat?: number): BalancerTable =>
  table(
    id,
    Array.from({ length: n }, (_, i) => i + 1),
    maxSeats,
    buttonSeat
  );

// ═══════════════════════════════════════════════════════════════════════════════
// B1 — consolidation trigger
// ═══════════════════════════════════════════════════════════════════════════════

describe('B1 shouldBreakTable - the field collapses instead of stalling', () => {
  it('breaks a table when the field fits on the others (the live 14-across-3 case)', () => {
    // $100 Freeroll seen live: 14 players over three tables of 4/5/5. Fits on
    // two with four seats spare, but the old rule only fired at <= 3 players so
    // nothing ever broke and the final table could not form.
    const b = new TableBalancer();
    const a = t('aaaa', 4);
    const c = t('bbbb', 5);
    const d = t('cccc', 5);
    const all = [a, c, d];

    expect(b.shouldBreakTable(a, all)).toBe(true);
    // ...and only the emptiest one goes.
    expect(b.shouldBreakTable(c, all)).toBe(false);
    expect(b.shouldBreakTable(d, all)).toBe(false);
  });

  it('never breaks a table whose players do not physically fit elsewhere', () => {
    const b = new TableBalancer();
    const full1 = t('aaaa', 9);
    const full2 = t('bbbb', 9);
    const rump = t('cccc', 2);
    expect(b.shouldBreakTable(rump, [full1, full2, rump])).toBe(false);
  });

  it('takes every seat for the LAST merge so the final table can form', () => {
    // Two tables, 9 players. Reserving a spare seat here would refuse the break
    // and reintroduce the original bug.
    const b = new TableBalancer();
    const a = t('aaaa', 5);
    const c = t('bbbb', 4);
    expect(b.shouldBreakTable(c, [a, c])).toBe(true);
  });

  it('holds a spare seat per surviving table while more than one survives', () => {
    const b = new TableBalancer();
    // 17 across 6/6/5 — fits on two 9-max tables exactly, with zero slack.
    const seventeen = [t('aaaa', 6), t('bbbb', 6), t('cccc', 5)];
    expect(b.shouldBreakTable(seventeen[2], seventeen)).toBe(false);

    // 16 across 6/5/5 — fits with room to breathe, so it goes.
    const sixteen = [t('aaaa', 6), t('bbbb', 5), t('cccc', 5)];
    expect(b.shouldBreakTable(sixteen[1], sixteen)).toBe(true);
  });

  it('is monotone: after the break, the survivors do not want to break again', () => {
    const b = new TableBalancer();
    const before = [t('aaaa', 4), t('bbbb', 5), t('cccc', 5)];
    expect(b.shouldBreakTable(before[0], before)).toBe(true);

    // 14 players land on two tables of 7.
    const after = [t('aaaa', 7), t('bbbb', 7)];
    expect(b.shouldBreakTable(after[0], after)).toBe(false);
    expect(b.shouldBreakTable(after[1], after)).toBe(false);
  });

  it('picks exactly one candidate when two tables tie for emptiest', () => {
    const b = new TableBalancer();
    const all = [t('aaaa', 4), t('bbbb', 4), t('cccc', 8)];
    const breaking = all.filter((x) => b.shouldBreakTable(x, all));
    expect(breaking.map((x) => x.tableId)).toEqual(['aaaa']);
  });

  it('preserves the old short-table rule when the headroom rule declines', () => {
    const b = new TableBalancer();
    // 8/7/3 on 9-max: with a seat reserved per survivor there is room for one,
    // not three, so only the <= 3 rule can fire — and the three players do
    // physically fit into the 1 + 2 seats that actually exist.
    const all = [t('aaaa', 8), t('bbbb', 7), t('cccc', 3)];
    expect(b.shouldBreakTable(all[2], all)).toBe(true);
  });

  it('always breaks an empty table and never treats one as somewhere to sit', () => {
    const b = new TableBalancer();
    const empty = t('aaaa', 0);
    const full1 = t('bbbb', 9);
    const full2 = t('cccc', 9);
    expect(b.shouldBreakTable(empty, [empty, full1, full2])).toBe(true);
    // The 9s cannot break: the only free seats belong to a table that is itself
    // waiting to be closed.
    expect(b.shouldBreakTable(full1, [empty, full1, full2])).toBe(false);
  });

  it('never returns true for a lone table', () => {
    const b = new TableBalancer();
    const only = t('aaaa', 6);
    expect(b.shouldBreakTable(only, [only])).toBe(false);
  });
});

describe('B1 breakTable - every player lands, nobody overfills a table', () => {
  it('moves every player and never exceeds max_players', () => {
    const b = new TableBalancer();
    const broken = table('aaaa', [1, 2, 3, 4], 9, 1);
    const targets = [table('bbbb', [1, 2, 3, 4, 5], 9, 1), table('cccc', [1, 2, 3, 4, 5], 9, 1)];

    const moves = b.breakTable(broken, targets);
    expect(moves).toHaveLength(4);
    for (const t2 of targets) {
      expect(t2.playerCount).toBeLessThanOrEqual(t2.maxSeats);
    }
    // Distinct destination seats — no collisions.
    for (const t2 of targets) {
      const used = t2.players.map((p) => p.seat);
      expect(new Set(used).size).toBe(used.length);
    }
    expect(moves.every((m) => m.toSeat >= 1 && m.toSeat <= 9)).toBe(true);
  });

  it('does not dump a broken table into another empty table', () => {
    const b = new TableBalancer();
    const broken = table('aaaa', [1, 2, 3], 9, 1);
    const emptyOne = t('bbbb', 0);
    const real = table('cccc', [1, 2, 3, 4], 9, 1);

    const moves = b.breakTable(broken, [emptyOne, real]);
    expect(moves).toHaveLength(3);
    expect(moves.every((m) => m.toTableId === 'cccc')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B2 — blind geometry
// ═══════════════════════════════════════════════════════════════════════════════

describe('B2 blind geometry', () => {
  it('finds the current big blind clockwise from the button', () => {
    expect(currentBigBlindSeat([1, 2, 3, 4, 5, 6], 1)).toBe(3);
    expect(currentBigBlindSeat([1, 2, 3, 4, 5, 6], 5)).toBe(1);
    expect(currentBigBlindSeat([2, 4, 6, 9], 4)).toBe(9);
  });

  it('tolerates a button seat vacated by the bust that triggered the rebalance', () => {
    // Button was seat 4, that player busted. Blinds were still posted from 5/7.
    expect(currentBigBlindSeat([1, 3, 5, 7], 4)).toBe(7);
    // Button seat 8 (gone) wraps: SB 1, BB 3.
    expect(currentBigBlindSeat([1, 3, 5, 7], 8)).toBe(3);
  });

  it('declines when there is no meaningful blind order', () => {
    expect(currentBigBlindSeat([1, 2, 3], 0)).toBeNull();
    expect(currentBigBlindSeat([1, 2, 3], undefined)).toBeNull();
    expect(currentBigBlindSeat([1, 2], 1)).toBeNull();
  });

  it('counts hands until a seat posts the big blind', () => {
    // BB is seat 3; clockwise 4,5,6 are 1,2,3 hands away.
    expect(hopsToBigBlind([1, 2, 3, 4, 5, 6], 3, 4)).toBe(1);
    expect(hopsToBigBlind([1, 2, 3, 4, 5, 6], 3, 6)).toBe(3);
    // Seat 2 is the small blind — a full orbit until it is the big blind again.
    expect(hopsToBigBlind([1, 2, 3, 4, 5, 6], 3, 2)).toBe(5);
    // A seat joining the ring is counted as part of it.
    expect(hopsToBigBlind([1, 2, 3, 4, 5, 6], 3, 8)).toBe(4);
  });

  it('treats the vacated big blind seat as the longest wait, not the shortest', () => {
    // Taking the seat the big blind just left means the blinds have gone past
    // you: a whole orbit of free hands unless something is done about it.
    expect(hopsToBigBlind([1, 2, 4, 5], 3, 3)).toBe(5);
  });
});

describe('B2 findOpenSeat via calculateMoves - seated by the button, not by seat number', () => {
  const source = () => table('aaaa', [1, 2, 3, 4, 5, 6], 9, 1); // BB = 3, next BB = 4

  it('seats the big-blind-due player where the big blind arrives soonest', () => {
    const b = new TableBalancer();
    // Destination: seats 1,3,5 occupied, button 1 -> BB = 5. Lowest free seat is
    // 2, which is what the old code always picked. Seat 6 is the one that posts
    // the big blind next.
    const dest = table('bbbb', [1, 3, 5], 6, 1);
    const moves = b.calculateMoves([source(), dest]);

    expect(moves).toHaveLength(1);
    expect(moves[0].fromSeat).toBe(4); // big blind due next at the source
    expect(moves[0].toSeat).toBe(6);
    expect(moves[0].toSeat).not.toBe(2); // the old lowest-free-seat answer
  });

  it('keeps a player deeper in the blind cycle deeper in it at the destination', () => {
    const b = new TableBalancer();
    // Two players move. The first (big blind due next, 1 hop) takes the soonest
    // big blind; the second (2 hops) must not be handed a sooner one.
    const over = table('aaaa', [1, 2, 3, 4, 5, 6, 7, 8], 9, 1); // BB=3, order 4,5,...
    const dest = table('bbbb', [1, 3, 5], 6, 1);
    const moves = b.calculateMoves([over, dest]);

    expect(moves).toHaveLength(2);
    expect(moves.map((m) => m.fromSeat)).toEqual([4, 5]);
    expect(moves[0].toSeat).toBe(6); // 1 hop
    expect(moves[1].toSeat).toBe(2); // 2 hops — later in the cycle, as at source
  });

  it('never seats a moved player in the two seats the big blind has just passed', () => {
    const b = new TableBalancer();
    // Destination ring 1,3,5 with button 1: seat 4 is a full-orbit-away seat
    // (the free-orbit seat). It must be left alone while 2 and 6 are free.
    const dest = table('bbbb', [1, 3, 5], 6, 1);
    const moves = b.calculateMoves([source(), dest]);
    expect(moves[0].toSeat).not.toBe(4);
  });

  it('falls back to the lowest free seat when the destination button is unknown', () => {
    const b = new TableBalancer();
    const dest = table('bbbb', [1, 3, 5], 6, 0);
    const moves = b.calculateMoves([source(), dest]);
    expect(moves).toHaveLength(1);
    expect(moves[0].toSeat).toBe(2);
  });

  it('never places a player above max_players', () => {
    const b = new TableBalancer();
    const dest = table('bbbb', [1, 2, 3], 6, 1);
    const moves = b.calculateMoves([source(), dest]);
    expect(moves.every((m) => m.toSeat >= 1 && m.toSeat <= 6)).toBe(true);
  });

  it('still balances to a gap of one', () => {
    const b = new TableBalancer();
    // 11 players split 8/3 — two moves take it to 6/5, a gap of one.
    const a = table('aaaa', [1, 2, 3, 4, 5, 6, 7, 8], 9, 1);
    const c = table('bbbb', [1, 3, 5], 9, 1);
    const moves = b.calculateMoves([a, c]);
    expect(moves).toHaveLength(2);
    expect(b.shouldRebalance([t('aaaa', 6), t('bbbb', 5)])).toBe(false);
  });
});
