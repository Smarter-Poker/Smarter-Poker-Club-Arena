/**
 * V16 OMAHA RESERVOIR BAND SAMPLING — ground-truth tests.
 *
 * Bands are PERCENTILE-INTENT: [0.85, 1.0] means "a top-15% hand". The old
 * path matched band values against raw omahaPreflopScore, whose compressed
 * distribution puts 0.85 beyond p99.9 — so tight reads selected nothing and
 * every sample degraded to closest-miss noise below the read. The reservoir
 * maps bands through its empirical CDF; these tests prove placements land in
 * the intended PERCENTILE slice and that a read now bites equity in the
 * correct direction.
 */
import { describe, it, expect } from 'vitest';
import {
  seedFastRandom,
  placeOmahaBandCombo,
  omahaPreflopScore,
  simulateEquity,
  variantInfo,
} from './HorseEval.js';
import { SUITS, RANKS } from './PokerEngine.js';
import type { Card } from '../types.js';

const FULL: Card[] = [];
for (const s of SUITS) for (const r of RANKS) FULL.push({ rank: r, suit: s });

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

/** Empirical percentile of the plo score distribution, with a private RNG. */
function empiricalQuantile(holeCount: number, q: number): number {
  let s = 987654321;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const scores: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const d = FULL.slice();
    for (let j = 0; j < holeCount; j++) {
      const k = j + Math.floor(rnd() * (d.length - j));
      const t = d[j];
      d[j] = d[k];
      d[k] = t;
    }
    scores.push(omahaPreflopScore(d.slice(0, holeCount), false));
  }
  scores.sort((a, b) => a - b);
  return scores[Math.floor(q * scores.length)];
}

describe('placeOmahaBandCombo (percentile mapping)', () => {
  it('a [0.85, 1.0] read places top-15% hands, every single time', () => {
    seedFastRandom(424242);
    // Small tolerance: reservoir CDF vs this test's independent sample.
    const p85 = empiricalQuantile(4, 0.83);
    let placed = 0;
    let strongEnough = 0;
    for (let trial = 0; trial < 400; trial++) {
      const heroKeys = new Set(['Ahearts', 'Kdiamonds', '7clubs', '2spades']);
      const deck = FULL.filter((cd) => !heroKeys.has(`${cd.rank}${cd.suit}`));
      if (placeOmahaBandCombo(deck, 0, deck.length, [0.85, 1.0], 4, false)) {
        placed++;
        if (omahaPreflopScore(deck.slice(0, 4), false) >= p85) strongEnough++;
      }
    }
    expect(placed).toBeGreaterThan(350);
    expect(strongEnough).toBe(placed);
  });

  it('places correctly for plo5 and plo6 hole counts', () => {
    seedFastRandom(515151);
    for (const holeCount of [5, 6]) {
      const floor = empiricalQuantile(holeCount, 0.68);
      const deck = FULL.slice();
      const ok = placeOmahaBandCombo(deck, 0, deck.length, [0.7, 1.0], holeCount, false);
      expect(ok).toBe(true);
      expect(omahaPreflopScore(deck.slice(0, holeCount), false)).toBeGreaterThanOrEqual(floor);
    }
  });

  it('swaps by card id even when deck objects are foreign', () => {
    // This test's FULL deck is built from ITS OWN card objects — object
    // identity with the reservoir's cards never matches. If the swap used
    // identity, the window would silently stay uniform.
    seedFastRandom(626262);
    const deck = FULL.slice();
    const floor = empiricalQuantile(4, 0.88);
    const ok = placeOmahaBandCombo(deck, 0, deck.length, [0.9, 1.0], 4, false);
    expect(ok).toBe(true);
    expect(omahaPreflopScore(deck.slice(0, 4), false)).toBeGreaterThanOrEqual(floor);
  });

  it('returns false for an empty/impossible band', () => {
    const deck = FULL.slice();
    expect(placeOmahaBandCombo(deck, 0, deck.length, [1.01, 1.02], 4, false)).toBe(false);
    expect(placeOmahaBandCombo(deck, 0, deck.length, [0.5, 0.5], 4, false)).toBe(false);
  });
});

describe('band bites in Omaha equity', () => {
  it('a top-band read crushes a medium hand on the board that range smashes', () => {
    // Direction matters and it is board-dependent: a top-15% plo4 range is
    // heavy in big pairs and broadways, so it SMASHES A-K-x - while a random
    // range mostly misses it. A medium rundown must therefore read much
    // weaker against the band than against random. (On a LOW board the
    // direction legitimately inverts: big-pair ranges connect less than
    // random there - asserting that way would be testing wrong poker.)
    const vi = variantInfo('plo4');
    const hero = [c('Q', 'spades'), c('J', 'diamonds'), c('T', 'hearts'), c('9', 'clubs')];
    const board = [c('A', 'spades'), c('K', 'hearts'), c('3', 'diamonds')];
    seedFastRandom(777);
    const vsRandom = simulateEquity(hero, board, 1, vi, 3000);
    seedFastRandom(777);
    const vsTop = simulateEquity(hero, board, 1, vi, 3000, [[0.85, 1.0]]);
    expect(vsTop).toBeLessThan(vsRandom - 0.05);
  });

  it('and the same read LIFTS an overpair on a low board - a real range, not a debuff', () => {
    // AAKK on 9-6-2 does BETTER against big-pair-heavy premiums (which it
    // dominates) than against random hands (which make sets, two pair and
    // wraps on a low board). The old closest-miss sampler could not produce
    // this inversion because its "range" was noise.
    const vi = variantInfo('plo4');
    const hero = [c('A', 'spades'), c('A', 'hearts'), c('K', 'spades'), c('K', 'hearts')];
    const board = [c('9', 'clubs'), c('6', 'diamonds'), c('2', 'clubs')];
    seedFastRandom(777);
    const vsRandom = simulateEquity(hero, board, 1, vi, 3000);
    seedFastRandom(777);
    const vsTop = simulateEquity(hero, board, 1, vi, 3000, [[0.85, 1.0]]);
    expect(vsTop).toBeGreaterThan(vsRandom);
  });
});
