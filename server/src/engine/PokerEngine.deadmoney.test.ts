/**
 * DEAD-MONEY-ONLY ALL-IN — pot eligibility regression guard (2026-08-18).
 *
 * Side-pot levels come from LIVE investment, and eligibility was
 * `getInvestment(p) >= level` for every level > 0. A non-folded player whose
 * entire stack went to the ante, or to a dead small blind on return from
 * sit-out, has live investment 0 — so they were excluded from every pot,
 * including the main pot their own chips had just been folded into.
 *
 * They were dealt in, could make the best hand, and won nothing.
 */
import { describe, it, expect } from 'vitest';
import { calculatePots } from './PokerEngine.js';
import type { SeatPlayer } from '../types.js';

function mk(
  seat: number,
  over: Partial<SeatPlayer> & { totalInvested: number; deadInvested?: number }
): SeatPlayer {
  return {
    seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: 0,
    bet: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    deadInvested: 0,
    ...over,
  } as SeatPlayer;
}

const sum = (pots: { amount: number }[]) =>
  Math.round(pots.reduce((s, p) => s + p.amount, 0) * 100) / 100;

describe('dead-money-only all-in (Bible V8 §4.3)', () => {
  it('a player all-in for the ante alone is eligible for the main pot', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100 }),
      // Stack was 5, the ante was 5: all of it is dead money, live = 0.
      mk(3, { totalInvested: 5, deadInvested: 5, is_all_in: true }),
    ];
    const pots = calculatePots(players);

    expect(pots.length).toBeGreaterThan(0);
    expect(pots[0].eligiblePlayers).toContain('u3');
  });

  it('every chip contributed is still accounted for', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100 }),
      mk(3, { totalInvested: 5, deadInvested: 5, is_all_in: true }),
    ];
    expect(sum(calculatePots(players))).toBe(205);
  });

  it('a dead small blind that consumed the whole stack also stays eligible', () => {
    const players = [
      mk(1, { totalInvested: 50 }),
      mk(2, { totalInvested: 50 }),
      mk(3, { totalInvested: 1, deadInvested: 1, is_all_in: true }),
    ];
    expect(calculatePots(players)[0].eligiblePlayers).toContain('u3');
  });

  it('a FOLDED player is never made eligible, but their dead money stays in', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100 }),
      mk(3, { totalInvested: 5, deadInvested: 5, is_folded: true }),
    ];
    const pots = calculatePots(players);
    expect(pots[0].eligiblePlayers).not.toContain('u3');
    expect(sum(pots)).toBe(205);
  });

  it('a non-folded player who contributed nothing is not made eligible', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 100, deadInvested: 2 }),
      mk(3, { totalInvested: 0 }),
    ];
    expect(calculatePots(players)[0].eligiblePlayers).not.toContain('u3');
  });

  it('normal side pots are unchanged when there is no dead money', () => {
    const players = [
      mk(1, { totalInvested: 100 }),
      mk(2, { totalInvested: 40, is_all_in: true }),
      mk(3, { totalInvested: 100 }),
    ];
    const pots = calculatePots(players);
    expect(sum(pots)).toBe(240);
    // Short stack contests only the first pot.
    expect(pots[0].eligiblePlayers).toContain('u2');
    expect(pots[pots.length - 1].eligiblePlayers).not.toContain('u2');
  });
});
