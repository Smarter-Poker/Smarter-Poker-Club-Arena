import { describe, expect, it } from 'vitest';
import { TableBalancer, type BalancerTable } from './TableBalancer.js';

function table(id: string, count: number, reservedSeats: number[] = []): BalancerTable {
  return {
    tableId: id,
    playerCount: count,
    maxSeats: 9,
    buttonSeat: 1,
    reservedSeats,
    players: Array.from({ length: count }, (_, i) => ({
      userId: `${id}-${i + 1}`,
      seat: i + 1,
      stack: 1000,
    })),
  };
}

describe('table breaks use physically available destination chairs', () => {
  it.each([false, true])(
    'tries another table when the emptiest has only reserved chairs (reverse=%s)',
    (reverse) => {
      const planner = new TableBalancer();
      const source = table('source', 3);
      const sourceBefore = structuredClone(source);
      const blocked = table('blocked', 1, [2, 3, 4, 5, 6, 7, 8, 9]);
      const available = table('available', 4);
      const blockedBefore = structuredClone(blocked);
      const control = planner.breakTable(structuredClone(source), [structuredClone(available)]);
      const targets = reverse ? [available, blocked] : [blocked, available];

      const moves = planner.breakTable(source, targets);

      expect(moves).toEqual(control);
      expect(moves).toHaveLength(source.players.length);
      expect(blocked).toEqual(blockedBefore);
      expect(source).toEqual(sourceBefore);
      expect(available.playerCount).toBe(7);
      expect(new Set(available.players.map((p) => p.seat)).size).toBe(7);
      expect(available.players.reduce((sum, p) => sum + p.stack, 0)).toBe(7000);
    }
  );

  it('continues at another destination after the first usable table runs out of unreserved chairs', () => {
    const source = table('source', 3);
    const first = table('first', 1, [3, 4, 5, 6, 7, 8, 9]);
    const second = table('second', 4);
    const moves = new TableBalancer().breakTable(source, [first, second]);

    expect(moves).toHaveLength(3);
    expect(moves.map((move) => move.toTableId)).toEqual(['first', 'second', 'second']);
    expect(moves[0].toSeat).toBe(2);
    expect(new Set(moves.map((move) => move.playerId)).size).toBe(3);
    expect(first.reservedSeats).not.toContain(moves[0].toSeat);
    expect(first.playerCount).toBe(2);
    expect(second.playerCount).toBe(6);
    expect(new Set(second.players.map((p) => p.seat)).size).toBe(6);
  });

  it('returns only the placeable prefix when all remaining destination chairs are unavailable', () => {
    const source = table('source', 3);
    const almostBlocked = table('almost-blocked', 1, [3, 4, 5, 6, 7, 8, 9]);
    const fullyBlocked = table('fully-blocked', 4, [5, 6, 7, 8, 9]);
    const moves = new TableBalancer().breakTable(source, [almostBlocked, fullyBlocked]);

    expect(moves).toHaveLength(1);
    expect(moves[0].toTableId).toBe('almost-blocked');
    expect(moves[0].toSeat).toBe(2);
    expect(fullyBlocked.playerCount).toBe(4);
    expect(source.players).toHaveLength(3);
  });

  it('keeps empty, full and fully reserved destinations unavailable', () => {
    const source = table('source', 3);
    const targets = [
      table('empty', 0),
      table('full', 9),
      table('reserved', 1, [2, 3, 4, 5, 6, 7, 8, 9]),
    ];
    const before = structuredClone(targets);
    expect(new TableBalancer().breakTable(source, targets)).toEqual([]);
    expect(targets).toEqual(before);
  });
});
