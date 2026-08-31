import { describe, it, expect } from 'vitest';
import { orderPlayersForMove, type BalancerPlayer } from './TableBalancer.js';

const mk = (seat: number, stack = 100): BalancerPlayer => ({ userId: `p${seat}`, seat, stack });

describe('orderPlayersForMove (B6 - big blind due next)', () => {
  it('moves the big-blind-due-next player first and the current BB last', () => {
    // Seats 1..6 occupied, button on seat 1.
    // SB = seat 2, BB = seat 3. Next BB = seat 4.
    // Expected move order: 4, 5, 6, 1, 2, 3  (current BB = 3 last).
    const players = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
    const ordered = orderPlayersForMove(players, 1)!;
    expect(ordered.map((p) => p.seat)).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('handles a button that is not the lowest seat (wraps correctly)', () => {
    // Occupied 1..6, button on seat 5. SB=6, BB=1, nextBB=2.
    // Move order: 2, 3, 4, 5, 6, 1 (current BB=1 last).
    const players = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
    const ordered = orderPlayersForMove(players, 5)!;
    expect(ordered.map((p) => p.seat)).toEqual([2, 3, 4, 5, 6, 1]);
  });

  it('handles sparse (non-contiguous) occupied seats', () => {
    // Occupied 2,4,6,9 (button on 4). SB=6, BB=9, nextBB=2.
    // Move order clockwise from after BB(9): 2, 4, 6, 9.
    const players = [mk(9), mk(2), mk(6), mk(4)];
    const ordered = orderPlayersForMove(players, 4)!;
    expect(ordered.map((p) => p.seat)).toEqual([2, 4, 6, 9]);
  });

  it('returns null (fallback) when button seat is unknown / zero', () => {
    const players = [mk(1), mk(2), mk(3)];
    expect(orderPlayersForMove(players, 0)).toBeNull();
    expect(orderPlayersForMove(players, undefined)).toBeNull();
  });

  it('returns null (fallback) for fewer than 3 players (no blind order)', () => {
    expect(orderPlayersForMove([mk(1), mk(2)], 1)).toBeNull();
  });

  it('returns null when the button seat is not occupied', () => {
    const players = [mk(2), mk(4), mk(6)];
    expect(orderPlayersForMove(players, 3)).toBeNull();
  });

  it('returns every player exactly once', () => {
    const players = [mk(1), mk(2), mk(3), mk(4), mk(5)];
    const ordered = orderPlayersForMove(players, 2)!;
    expect(ordered).toHaveLength(5);
    expect(new Set(ordered.map((p) => p.seat)).size).toBe(5);
  });
});
