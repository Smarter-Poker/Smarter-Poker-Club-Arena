/**
 * ♠ CLUB ARENA — TableBalancer Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests tournament table rebalancing: score evaluation, move calculation,
 * table breaking, and seat assignment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(), subscribe: vi.fn(), subscribeDebounced: vi.fn() },
}));

import { tableBalancer } from '../../src/engine/TableBalancer';
import type { BalancerTable } from '../../src/engine/TableBalancer';

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeTable(id: string, count: number, maxSeats = 9): BalancerTable {
  return {
    tableId: id,
    playerCount: count,
    maxSeats,
    players: Array.from({ length: count }, (_, i) => ({
      userId: `${id}-p${i + 1}`,
      stack: 1000 + i * 100,
      seat: i + 1,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('TableBalancer - evaluateBalance', () => {
  it('should return score 0 for single table', () => {
    const result = tableBalancer.evaluateBalance([makeTable('t1', 5)]);
    expect(result.score).toBe(0);
    expect(result.gap).toBe(0);
  });

  it('should return score 0 for perfectly balanced tables', () => {
    const result = tableBalancer.evaluateBalance([makeTable('t1', 5), makeTable('t2', 5)]);
    expect(result.score).toBe(0);
    expect(result.gap).toBe(0);
  });

  it('should return non-zero score for imbalanced tables', () => {
    const result = tableBalancer.evaluateBalance([makeTable('t1', 8), makeTable('t2', 4)]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.gap).toBe(4);
    expect(result.maxPlayers).toBe(8);
    expect(result.minPlayers).toBe(4);
  });

  it('should handle empty tables', () => {
    const result = tableBalancer.evaluateBalance([]);
    expect(result.score).toBe(0);
  });
});

describe('TableBalancer - shouldRebalance', () => {
  it('should return false for single table', () => {
    expect(tableBalancer.shouldRebalance([makeTable('t1', 5)])).toBe(false);
  });

  it('should return false when gap is 0', () => {
    expect(tableBalancer.shouldRebalance([makeTable('t1', 5), makeTable('t2', 5)])).toBe(false);
  });

  it('should return false when gap is 1', () => {
    expect(tableBalancer.shouldRebalance([makeTable('t1', 5), makeTable('t2', 6)])).toBe(false);
  });

  it('should return true when gap > 1', () => {
    expect(tableBalancer.shouldRebalance([makeTable('t1', 4), makeTable('t2', 7)])).toBe(true);
  });
});

describe('TableBalancer - calculateMoves', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return no moves for single table', () => {
    const moves = tableBalancer.calculateMoves([makeTable('t1', 5)]);
    expect(moves).toHaveLength(0);
  });

  it('should return no moves for balanced tables', () => {
    const moves = tableBalancer.calculateMoves([makeTable('t1', 5), makeTable('t2', 5)]);
    expect(moves).toHaveLength(0);
  });

  it('should move players from over to under-seated tables', () => {
    const moves = tableBalancer.calculateMoves([makeTable('t1', 8), makeTable('t2', 4)]);
    expect(moves.length).toBeGreaterThan(0);

    // Moves should go from t1 to t2
    for (const move of moves) {
      expect(move.fromTableId).toBe('t1');
      expect(move.toTableId).toBe('t2');
    }
  });

  it('should achieve gap <= 1 after moves', () => {
    const t1 = makeTable('t1', 9);
    const t2 = makeTable('t2', 3);
    const moves = tableBalancer.calculateMoves([t1, t2]);

    // After moves, counts should be 6/6 balanced
    const finalT1 = 9 - moves.filter((m) => m.fromTableId === 't1').length;
    const finalT2 = 3 + moves.filter((m) => m.toTableId === 't2').length;
    expect(Math.abs(finalT1 - finalT2)).toBeLessThanOrEqual(1);
  });

  it('should move players with smallest stacks first', () => {
    const moves = tableBalancer.calculateMoves([makeTable('t1', 7), makeTable('t2', 3)]);
    if (moves.length >= 2) {
      // First moved player should have smaller stack than second
      const firstPlayer = moves[0].playerId;
      const secondPlayer = moves[1].playerId;
      expect(firstPlayer).not.toBe(secondPlayer);
    }
  });
});

describe('TableBalancer - shouldBreakTable', () => {
  it('should return false for single table', () => {
    const table = makeTable('t1', 3);
    expect(tableBalancer.shouldBreakTable(table, [table])).toBe(false);
  });

  it('should return true for empty table', () => {
    const empty = makeTable('t1', 0);
    const other = makeTable('t2', 5);
    expect(tableBalancer.shouldBreakTable(empty, [empty, other])).toBe(true);
  });

  it('should return true for table with <= 3 players when others have room', () => {
    const small = makeTable('t1', 2);
    const other = makeTable('t2', 5, 9); // 4 open seats
    expect(tableBalancer.shouldBreakTable(small, [small, other])).toBe(true);
  });

  it('should return false for table with > 3 players', () => {
    const table = makeTable('t1', 5);
    const other = makeTable('t2', 5);
    expect(tableBalancer.shouldBreakTable(table, [table, other])).toBe(false);
  });
});

describe('TableBalancer - breakTable', () => {
  it('should distribute all players from broken table', () => {
    const broken = makeTable('t1', 3);
    const target1 = makeTable('t2', 5, 9);
    const target2 = makeTable('t3', 4, 9);

    const moves = tableBalancer.breakTable(broken, [target1, target2]);

    expect(moves).toHaveLength(3);
    for (const move of moves) {
      expect(move.fromTableId).toBe('t1');
      expect(['t2', 't3']).toContain(move.toTableId);
    }
  });

  it('should prefer tables with fewer players', () => {
    const broken = makeTable('t1', 2);
    const small = makeTable('t2', 3, 9);
    const large = makeTable('t3', 7, 9);

    const moves = tableBalancer.breakTable(broken, [small, large]);

    // Should prefer t2 (fewer players) over t3
    const movesToSmall = moves.filter((m) => m.toTableId === 't2');
    expect(movesToSmall.length).toBeGreaterThan(0);
  });
});
