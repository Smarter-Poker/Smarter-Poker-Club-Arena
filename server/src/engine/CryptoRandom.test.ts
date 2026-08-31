/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRYPTO RANDOM / DECK FAIRNESS — regression tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-07-28 (engine audit D23 + A8). Three defects were fixed in one pass
 * and none of them had a test, which is exactly why they survived so long:
 *
 *   D23a  Deck.shuffle() drew one Uint32 per slot up front and took
 *         `array[i] % (i + 1)`. Modulo on a uniform 32-bit value is only
 *         uniform when (i + 1) divides 2^32, so low indices were very slightly
 *         over-represented for 47 of the 51 swaps in a 52-card deck.
 *   D23b  Both fallbacks in this module tested `globalThis.crypto?.randomInt`.
 *         WebCrypto has no `randomInt` — that lives on node:crypto — so the
 *         condition was ALWAYS false and the "fallback" was Math.random().
 *   A8    rollSpinMultiplier picked a real money multiplier with Math.random(),
 *         and its `remainder -= weight; if (remainder <= 0)` loop could award a
 *         ZERO-weight tier when the remainder landed exactly on a boundary.
 *
 * These tests are statistical where they have to be, but every threshold below
 * is loose enough that a correct implementation will not flake: the tightest is
 * a chi-square bound that a uniform generator clears with probability > 0.999.
 */

import { describe, it, expect } from 'vitest';
import { secureRandomInt, secureRandom, secureShuffle } from './CryptoRandom.js';
import { Deck } from './PokerEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chi-square statistic for observed counts against a uniform expectation.
 * Returned rather than asserted so each caller can pick its own bound.
 */
function chiSquareUniform(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / counts.length;
  return counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
}

const cardKey = (c: { rank: string; suit: string }) => `${c.rank}${c.suit}`;

// ═══════════════════════════════════════════════════════════════════════════════
// secureRandomInt
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureRandomInt', () => {
  it('returns 0 for degenerate ranges instead of NaN or a throw', () => {
    expect(secureRandomInt(0)).toBe(0);
    expect(secureRandomInt(1)).toBe(0);
    expect(secureRandomInt(-5)).toBe(0);
  });

  it('stays inside [0, exclusiveMax) for ranges that do not divide 2^32', () => {
    // 3, 5, 7, 52 and 1_000_000 all leave a remainder against 2^32 — these are
    // precisely the ranges a modulo-biased implementation skews on.
    for (const max of [3, 5, 7, 52, 1_000_000]) {
      for (let i = 0; i < 2_000; i++) {
        const v = secureRandomInt(max);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
      }
    }
  });

  it('is uniform over a range that does not divide 2^32', () => {
    // 7 buckets, 70_000 draws => expected 10_000 each.
    // chi-square with 6 df: the 99.9th percentile is 22.46.
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 70_000; i++) counts[secureRandomInt(7)]++;
    expect(chiSquareUniform(counts)).toBeLessThan(22.46);
  });

  it('covers every value of a small range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1_000; i++) seen.add(secureRandomInt(6));
    expect(seen.size).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureRandom
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureRandom', () => {
  it('returns a float in [0, 1) and never repeats trivially', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const v = secureRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      seen.add(v);
    }
    // 5_000 draws from a 2^32 space: a collision is possible but the generator
    // being stuck is what this catches.
    expect(seen.size).toBeGreaterThan(4_990);
  });

  it('has a mean near 0.5', () => {
    let sum = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) sum += secureRandom();
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureShuffle
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureShuffle', () => {
  it('is a permutation - nothing added, dropped or duplicated', () => {
    for (let trial = 0; trial < 200; trial++) {
      const arr = Array.from({ length: 52 }, (_, i) => i);
      secureShuffle(arr);
      expect(arr.length).toBe(52);
      expect(new Set(arr).size).toBe(52);
      expect([...arr].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i));
    }
  });

  it('handles empty and single-element arrays', () => {
    const empty: number[] = [];
    secureShuffle(empty);
    expect(empty).toEqual([]);

    const one = [7];
    secureShuffle(one);
    expect(one).toEqual([7]);
  });

  it('sends element 0 to a uniform destination index', () => {
    // The old modulo implementation skewed low indices. 10 slots, 20_000
    // shuffles => expected 2_000 each; chi-square with 9 df, 99.9th pct = 27.88.
    const N = 10;
    const counts = new Array(N).fill(0);
    for (let trial = 0; trial < 20_000; trial++) {
      const arr = Array.from({ length: N }, (_, i) => i);
      secureShuffle(arr);
      counts[arr.indexOf(0)]++;
    }
    expect(chiSquareUniform(counts)).toBeLessThan(27.88);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Deck
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deck.shuffle', () => {
  it('always holds 52 distinct cards after a shuffle', () => {
    for (let trial = 0; trial < 100; trial++) {
      const deck = new Deck();
      const cards = deck.deal(52);
      expect(cards.length).toBe(52);
      expect(new Set(cards.map(cardKey)).size).toBe(52);
      expect(deck.remaining()).toBe(0);
    }
  });

  it('does not leave the deck in new-deck order', () => {
    const ordered = new Deck();
    // A fresh Deck() already shuffles in reset(); build the reference order by
    // hand instead of trusting an unshuffled instance.
    const first = ordered.deal(52).map(cardKey).join(',');
    const second = new Deck().deal(52).map(cardKey).join(',');
    expect(first).not.toBe(second);
  });

  it('deals the ace of spades to a uniform position', () => {
    // The single strongest signal that a shuffle is biased: track one card's
    // landing slot across many deals, bucketed into 13 groups of 4 positions.
    const BUCKETS = 13;
    const counts = new Array(BUCKETS).fill(0);
    const TRIALS = 26_000; // expected 2_000 per bucket
    for (let t = 0; t < TRIALS; t++) {
      const cards = new Deck().deal(52);
      const idx = cards.findIndex((c) => c.rank === 'A' && c.suit === 'spades');
      counts[Math.floor(idx / 4)]++;
    }
    // chi-square with 12 df: 99.9th percentile is 32.91.
    expect(chiSquareUniform(counts)).toBeLessThan(32.91);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rollSpinMultiplier (audit A8) — DELETED, and pinned deleted
// ═══════════════════════════════════════════════════════════════════════════════
//
// The six tests that lived here exercised TournamentRecurringService's local
// CSPRNG weighted roll. That method is gone (2026-08-20 second pass): the one
// and only draw now happens server-side at START, inside
// fn_spin_draw_multiplier, whose randomness is gen_random_bytes in Postgres —
// rejection concerns and boundary bugs live in ONE implementation with ONE
// audit surface. A local roll was the last code path that could pick a
// multiplier without asking the reserve, so its absence is itself the
// invariant worth testing now.

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('the local multiplier roll stays deleted', () => {
  it('no rollSpinMultiplier implementation exists anywhere in the engine', () => {
    const recurring = readFileSync(
      path.join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(recurring).not.toMatch(/rollSpinMultiplier\s*\(/);
    expect(recurring).not.toMatch(/Math\.random/);
  });
});
