import { describe, it, expect } from 'vitest';
import { calculateContestablePot, calculatePots } from './PokerEngine.js';
import type { SeatPlayer } from '../types.js';
function seat(id: string, invested: number, stack: number, folded = false): SeatPlayer {
  return {
    user_id: id,
    username: id,
    seat: 1,
    stack,
    bet: invested,
    totalInvested: invested,
    cards: [{ rank: 'A', suit: 'spades' }],
    is_folded: folded,
    is_all_in: stack === 0,
    is_sitting_out: false,
  };
}
function frozen(players: SeatPlayer[]) {
  for (const p of players) {
    for (const c of p.cards) Object.freeze(c);
    Object.freeze(p.cards);
    Object.freeze(p);
  }
  Object.freeze(players);
  return players;
}
describe('ordered pot rights remain exact across adjacent layers', () => {
  it('merges identical rights across a folded contribution without encoding player IDs', () => {
    const players = frozen([
      seat('comma,inside', 10, 100),
      seat('quote"inside', 10, 100),
      seat('folded', 5, 100, true),
    ]);
    expect(calculatePots(players)).toEqual([
      { amount: 25, eligiblePlayers: ['comma,inside', 'quote"inside'] },
    ]);
  });
  it('keeps a smaller matched layer distinct and returns folded excess to the main pot', () => {
    const players = frozen([
      seat('short', 10, 0),
      seat('deep', 20, 100),
      seat('folded', 30, 100, true),
    ]);
    expect(calculatePots(players)).toEqual([
      { amount: 40, eligiblePlayers: ['short', 'deep'] },
      { amount: 20, eligiblePlayers: ['deep'] },
    ]);
  });
  it('preserves shared-ante-only rights without adding unmatched live chips', () => {
    const anteOnly = seat('ante-only', 5, 0);
    anteOnly.deadInvested = 5;
    anteOnly.bet = 0;
    expect(calculatePots(frozen([anteOnly, seat('a', 10, 100), seat('b', 10, 100)]))).toEqual([
      { amount: 5, eligiblePlayers: ['ante-only', 'a', 'b'] },
      { amount: 20, eligiblePlayers: ['a', 'b'] },
    ]);
  });
});
describe('hypothetical call preserves immutable seat and private-card state', () => {
  it('caps the caller at matched layers while folded money remains in the eligible layer', () => {
    const players = frozen([
      seat('short', 10, 40),
      seat('deep', 100, 100),
      seat('folded', 100, 100, true),
    ]);
    // Three players match the short caller at50:150, less its pending40 call.
    expect(calculateContestablePot(players, 'short', 100)).toBe(110);
    expect(players[0].stack).toBe(40);
    expect(players[0].totalInvested).toBe(10);
  });
  it('keeps individual short-ante rights distinct from a shared blind ante', () => {
    const individual = seat('short', 2, 0);
    individual.deadInvested = 2;
    individual.individualAnteInvested = 2;
    expect(
      calculateContestablePot(
        frozen([individual, seat('a', 100, 100), seat('b', 100, 100)]),
        'short',
        0
      )
    ).toBe(6);
    const shared = seat('short', 5, 0);
    shared.deadInvested = 5;
    expect(
      calculateContestablePot(
        frozen([shared, seat('a', 100, 100), seat('b', 100, 100)]),
        'short',
        0
      )
    ).toBe(5);
  });
  it('preserves zero-call, absent-seat and folded-seat boundaries', () => {
    const players = frozen([seat('a', 20, 100), seat('b', 20, 100), seat('folded', 20, 100, true)]);
    expect(calculateContestablePot(players, 'a', 0)).toBe(60);
    expect(calculateContestablePot(players, 'absent', 100)).toBe(0);
    expect(calculateContestablePot(players, 'folded', 100)).toBe(0);
  });
});
