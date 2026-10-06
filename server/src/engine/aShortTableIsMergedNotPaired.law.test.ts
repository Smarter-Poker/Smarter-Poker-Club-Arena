/**
 * A SHORT TABLE IS MERGED, NOT PAIRED (2026-10-02).
 *
 * breakTable sent every broken table's players to the LEAST-full table. When a
 * tournament's field is spread one player per table, every other table is the
 * least full, so checkTableBalance (which plans all its breaks on one
 * simulated board) paired each lone player with another lone player. The pairs
 * played heads-up down to one each and were paired again: the field shrank by
 * elimination and never formed a full table.
 *
 * Production 2026-10-02 18:31-20:05 UTC: Midday Free Buy (b800c632) held 23
 * players on 23 tables, Coffee Break PLO4 (81775fa0) 14 on 14, the $100
 * Freeroll (4995e9aa) 36 on 33; tournament_seat_move_receipts show each break
 * moving one player onto another lone table.
 *
 * A short table (SHORT_TABLE_PLAYERS or fewer) now fills the fullest table
 * with a free chair; a bigger break still spreads to the least full.
 */
import { describe, it, expect } from 'vitest';
import { TableBalancer, SHORT_TABLE_PLAYERS, type BalancerTable } from './TableBalancer.js';

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
  players: occupied.map((seat) => ({ userId: `${tableId}-${seat}`, seat, stack: 1000 })),
});
const t = (id: string, n: number, maxSeats = 9, buttonSeat?: number): BalancerTable =>
  table(
    id,
    Array.from({ length: n }, (_, i) => i + 1),
    maxSeats,
    buttonSeat
  );

describe('a short table is merged, not paired (2026-10-02)', () => {
  /** checkTableBalance STEP 1: every break planned on one simulated board. */
  const plan = (board: BalancerTable[]): BalancerTable[] => {
    const b = new TableBalancer();
    let planned = board.map((x) => ({ ...x, players: x.players.map((p) => ({ ...p })) }));
    for (;;) {
      const source = planned.find((x) => x.playerCount > 0 && b.shouldBreakTable(x, planned));
      if (!source) return planned;
      const remaining = planned.filter((x) => x.tableId !== source.tableId);
      const moves = b.breakTable(source, remaining);
      expect(moves).toHaveLength(source.playerCount);
      planned = remaining;
    }
  };
  const lone = (n: number) =>
    Array.from({ length: n }, (_, i) => table(`t${String(i).padStart(2, '0')}`, [1], 9, 1));

  it('plans 23 lone players into full tables, not a dozen heads-up pairs', () => {
    // Midday Free Buy (b800c632), 2026-10-02 18:31-20:05 UTC: 23 players on
    // 23 tables. Least-full spreading planned every lone player onto another
    // lone player.
    const after = plan(lone(23));
    expect(after.map((x) => x.playerCount).sort((a, c) => c - a)).toEqual([9, 9, 5]);
    expect(after.reduce((sum, x) => sum + x.playerCount, 0)).toBe(23);
  });

  it('sends a short table to the fullest table that still has a chair', () => {
    const b = new TableBalancer();
    const source = table('src', [4], 9, 4);
    const moves = b.breakTable(source, [
      t('aaaa', 3, 9, 1),
      t('bbbb', 6, 9, 1),
      t('cccc', 9, 9, 1),
    ]);
    expect(moves.map((m) => m.toTableId)).toEqual(['bbbb']);
  });

  it('breaks a tie between equally full destinations by table id', () => {
    const b = new TableBalancer();
    const moves = b.breakTable(table('src', [2], 9, 2), [
      t('cccc', 1, 9, 1),
      t('aaaa', 1, 9, 1),
      t('bbbb', 1, 9, 1),
    ]);
    expect(moves.map((m) => m.toTableId)).toEqual(['aaaa']);
  });

  it('keeps every player of a short table together while one destination has room', () => {
    const b = new TableBalancer();
    const moves = b.breakTable(table('src', [1, 4, 7], 9, 1), [
      t('aaaa', 2, 9, 1),
      t('bbbb', 5, 9, 1),
    ]);
    expect(moves.map((m) => m.toTableId)).toEqual(['bbbb', 'bbbb', 'bbbb']);
  });

  it('is the same short-table threshold the break rule uses', () => {
    expect(SHORT_TABLE_PLAYERS).toBe(3);
  });

  it('still spreads a big break across the least-full tables', () => {
    const b = new TableBalancer();
    const targets = [t('aaaa', 5, 9, 1), t('bbbb', 7, 9, 1)];
    const moves = b.breakTable(table('src', [1, 2, 3, 4], 9, 1), targets);
    expect(moves).toHaveLength(4);
    expect(targets.map((x) => x.playerCount)).toEqual([8, 8]);
  });
});
