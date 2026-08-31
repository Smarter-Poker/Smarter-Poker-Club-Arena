/**
 * THE BIG BLIND ANTE THAT CHARGED ONE BIG BLIND PER SEAT (2026-08-30).
 *
 * Dan reported two symptoms: tournaments had no sized three-bets, only
 * three-bet jams, and horses were open-shoving forty to seventy big blinds
 * deep with weak aces. Measured in production over forty minutes:
 *
 *     open jams   416   182 deeper than 25bb, max 72bb
 *     3-bets      254   85.4% all-in,         max 184bb
 *     cash                3.7% all-in,        0.0% open jams
 *
 * Cash was healthy, so it was never a range bug. The cause was upstream of
 * the brain entirely: "Sunday $200 Deep Stack" authors `ante == bigBlind`,
 * meaning the big blind ante TOTAL, and HandController multiplied it by the
 * seat count. At a 1,000 big blind the ante actually taken was 7,000-8,000
 * chips PER HAND. The brain then read an orbit as costing 9.5bb and computed
 * a perfectly correct M of 3 for a 39bb stack.
 *
 * The first block pins the convention that 10,301 tournaments already use, so
 * the fix cannot quietly change what they collect.
 */
import { describe, it, expect } from 'vitest';
import { bigBlindAnteTotal, anteOrbitCostBB, BBA_CEILING_BB } from './AnteMath.js';

describe('the per-player convention is untouched', () => {
  it('0.1 x BB at ten seats still collects exactly one big blind', () => {
    expect(bigBlindAnteTotal(100, 10, 1000)).toBe(1000);
  });

  it('scales down with the seat count, as it always did', () => {
    expect(bigBlindAnteTotal(100, 6, 1000)).toBe(600);
    expect(bigBlindAnteTotal(100, 2, 1000)).toBe(200);
  });

  it('reproduces the existing HandController test exactly (ante 2, 2 seats, BB 10)', () => {
    expect(bigBlindAnteTotal(2, 2, 10)).toBe(4);
  });

  it('0.125 x BB stays above one big blind and is NOT clipped', () => {
    // 1.25bb — a real structure, and under the ceiling on purpose
    expect(bigBlindAnteTotal(75, 8, 600)).toBe(600);
    expect(bigBlindAnteTotal(125, 10, 1000)).toBe(1250);
  });
});

describe('a structure that authored the TOTAL is no longer multiplied', () => {
  it('THE PRODUCTION BUG: ante == BB at eight seats took 8,000, not 1,000', () => {
    expect(bigBlindAnteTotal(1000, 8, 1000)).toBe(1000);
    // what it used to be, and what the hand histories actually show
    expect(1000 * 8).toBe(8000);
  });

  it('holds at every level of the broken structure', () => {
    for (const bb of [600, 800, 1000]) {
      expect(bigBlindAnteTotal(bb, 9, bb)).toBe(bb);
    }
  });

  it('is independent of how many seats are dealt in', () => {
    for (const seats of [2, 5, 8, 10]) {
      expect(bigBlindAnteTotal(800, seats, 800)).toBe(800);
    }
  });
});

describe('the ceiling backstops anything neither convention covers', () => {
  it('half a big blind per player cannot collect five big blinds', () => {
    expect(bigBlindAnteTotal(500, 10, 1000)).toBe(1000 * BBA_CEILING_BB);
  });

  it('no ante and no seats collect nothing', () => {
    expect(bigBlindAnteTotal(0, 10, 1000)).toBe(0);
    expect(bigBlindAnteTotal(100, 0, 1000)).toBe(0);
  });
});

describe('anteOrbitCostBB - what Harrington M actually divides by', () => {
  /**
   * A big blind ante costs the table ONE ante per orbit. A traditional ante
   * costs each seat one ante per hand, so seats-many per orbit. They come to
   * the same number when the structure is authored per-player, which is the
   * whole design of the big blind ante — and they diverge violently when it
   * is authored as a total.
   */
  it('the two styles agree when the ante is authored per-player', () => {
    expect(anteOrbitCostBB(100, 10, 1000, true)).toBeCloseTo(1.0, 6);
    expect(anteOrbitCostBB(100, 10, 1000, false)).toBeCloseTo(1.0, 6);
  });

  it('THE FIX: a total-authored BBA costs one big blind an orbit, not eight', () => {
    expect(anteOrbitCostBB(1000, 8, 1000, true)).toBeCloseTo(1.0, 6);
    // the old formula, which is what made a 39bb stack look like an M of 3
    const oldWay = (1000 * 8) / 1000;
    expect(oldWay).toBe(8);
  });

  it('an orbit at the broken table cost 9.5bb and now costs 2.5bb', () => {
    const blinds = 1.5;
    expect(blinds + (1000 * 8) / 1000).toBe(9.5);
    expect(blinds + anteOrbitCostBB(1000, 8, 1000, true)).toBeCloseTo(2.5, 6);
    // M for a 39bb stack, 8-handed (the table-size scalar is min(1, 8/10))
    expect((39 / 9.5) * 0.8).toBeLessThan(6); // push/fold, wrongly
    expect((39 / 2.5) * 0.8).toBeGreaterThan(6); // plays poker, correctly
  });

  it('no ante is no cost, in either style', () => {
    expect(anteOrbitCostBB(0, 9, 1000, true)).toBe(0);
    expect(anteOrbitCostBB(0, 9, 1000, false)).toBe(0);
  });
});
