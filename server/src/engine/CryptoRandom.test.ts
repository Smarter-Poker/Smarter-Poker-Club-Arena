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
 * Exact Uint32 vectors cover rejection boundaries and every Fisher-Yates path
 * for a four-element array. The separate real-entropy check exercises Deck's
 * production CSPRNG with an explicit 1e-6 approximate false-rejection budget;
 * see docs/changelog/2026-09-11-shuffle-statistical-qualification.md.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { secureRandomInt, secureRandom, secureShuffle } from './CryptoRandom.js';
import { Deck, RANKS, SUITS } from './PokerEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function stubUint32Draws(draws: readonly number[]) {
  let next = 0;
  const getRandomValues = vi.fn((target: Uint32Array): Uint32Array => {
    if (!(target instanceof Uint32Array) || target.length !== 1) {
      throw new Error('CryptoRandom requested an unexpected entropy buffer');
    }
    if (next >= draws.length) {
      throw new Error('CryptoRandom consumed more entropy than the test vector supplied');
    }
    target[0] = draws[next++];
    return target;
  });

  vi.stubGlobal('crypto', { getRandomValues });
  return {
    getRandomValues,
    consumed: () => next,
  };
}

const cardKey = (c: { rank: string; suit: string }) => `${c.rank}${c.suit}`;
const UINT32_RANGE = 0x100000000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureRandomInt
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureRandomInt', () => {
  it('rejects non-integer and out-of-domain ranges before drawing entropy', () => {
    const entropy = stubUint32Draws([0]);

    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => secureRandomInt(invalid)).toThrow(TypeError);
    }
    for (const invalid of [-1, 0, UINT32_RANGE + 1]) {
      expect(() => secureRandomInt(invalid)).toThrow(RangeError);
    }

    expect(entropy.consumed()).toBe(0);
  });

  it('returns the sole value for max 1 without consuming entropy', () => {
    const entropy = stubUint32Draws([0xffffffff]);
    expect(secureRandomInt(1)).toBe(0);
    expect(entropy.consumed()).toBe(0);
  });

  it('uses all 2^32 source values when the range divides 2^32', () => {
    const entropy = stubUint32Draws([0xffffffff]);

    // The former 0xffffffff domain-size bug rejected this value for max 16.
    expect(secureRandomInt(16)).toBe(15);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('supports the full Uint32 range, including its largest result', () => {
    const entropy = stubUint32Draws([0xffffffff]);

    expect(secureRandomInt(UINT32_RANGE)).toBe(UINT32_RANGE - 1);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('rejects exactly the incomplete residue tail for max 7', () => {
    const firstRejected = UINT32_RANGE - (UINT32_RANGE % 7);
    const entropy = stubUint32Draws([
      firstRejected,
      firstRejected + 1,
      firstRejected + 2,
      firstRejected + 3,
      14,
    ]);

    expect(firstRejected).toBe(4294967292);
    expect(secureRandomInt(7)).toBe(0);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(5);
  });

  it('maps accepted boundary values to exact residues', () => {
    const entropy = stubUint32Draws([0, 1, 6, 7, 4294967291]);

    expect([
      secureRandomInt(7),
      secureRandomInt(7),
      secureRandomInt(7),
      secureRandomInt(7),
      secureRandomInt(7),
    ]).toEqual([0, 1, 6, 0, 6]);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureRandom
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureRandom', () => {
  it('maps exact Uint32 boundary vectors into [0, 1)', () => {
    const entropy = stubUint32Draws([0, 0x80000000, 0xffffffff]);

    expect([secureRandom(), secureRandom(), secureRandom()]).toEqual([
      0,
      0.5,
      (UINT32_RANGE - 1) / UINT32_RANGE,
    ]);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureShuffle
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureShuffle', () => {
  it('handles empty and single-element arrays without drawing entropy', () => {
    const entropy = stubUint32Draws([0]);
    const empty: number[] = [];
    secureShuffle(empty);
    expect(empty).toEqual([]);

    const one = [7];
    secureShuffle(one);
    expect(one).toEqual([7]);
    expect(entropy.consumed()).toBe(0);
  });

  it('follows a known Fisher-Yates swap vector in descending slot order', () => {
    const entropy = stubUint32Draws([2, 0, 1]);
    const values = [0, 1, 2, 3];

    secureShuffle(values);

    expect(values).toEqual([3, 1, 0, 2]);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(3);
  });

  it('maps every Fisher-Yates choice path to one unique permutation', () => {
    const permutations = new Set<string>();

    // A length-four Fisher-Yates pass has 4 * 3 * 2 = 24 possible choice
    // paths. Exhausting all of them proves both completeness and one-to-one
    // mapping without relying on a random sample or a statistical threshold.
    for (let atThree = 0; atThree < 4; atThree++) {
      for (let atTwo = 0; atTwo < 3; atTwo++) {
        for (let atOne = 0; atOne < 2; atOne++) {
          const entropy = stubUint32Draws([atThree, atTwo, atOne]);
          const values = [0, 1, 2, 3];
          secureShuffle(values);

          expect([...values].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
          expect(entropy.consumed()).toBe(3);
          permutations.add(values.join(','));
        }
      }
    }

    expect(permutations.size).toBe(24);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Deck
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deck.shuffle', () => {
  it('uses the exact Fisher-Yates known vector and preserves every card', () => {
    const entropy = stubUint32Draws(new Array(51).fill(0));
    const newDeckOrder = SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}`));

    // Choosing slot zero at every descending step rotates new-deck order left
    // by one. This pins Deck -> secureShuffle wiring as well as the full pass.
    const cards = new Deck().deal(52).map(cardKey);

    expect(cards).toEqual([...newDeckOrder.slice(1), newDeckOrder[0]]);
    expect(new Set(cards).size).toBe(52);
    expect(entropy.getRandomValues).toHaveBeenCalledTimes(51);
  });

  it('deals the ace of spades across all positions using real CSPRNG entropy', () => {
    // One prespecified marginal test, 52 cells, no fitted parameters: df = 51.
    // scipy.stats.chi2.isf(1e-6, 51) = 114.07566776592196. With 26,000 decks
    // the expected cell count is 500, supporting the chi-square approximation.
    // Never retry until green or seed/mock this entropy source. A rejection is
    // evidence to investigate, not permission to change cards or the threshold.
    vi.unstubAllGlobals();
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Deck must never obtain entropy from Math.random');
    });
    const deals = 26_000;
    const positions = new Array<number>(52).fill(0);
    for (let i = 0; i < deals; i++) {
      const cards = new Deck().deal(52);
      const position = cards.findIndex((card) => card.rank === 'A' && card.suit === 'spades');
      if (position < 0) throw new Error('Shuffled deck lost the ace of spades');
      positions[position]++;
    }
    const expected = deals / positions.length;
    const statistic = positions.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(
      statistic,
      `Real CSPRNG: N=${deals}, df=51, alpha=1e-6, chiSquare=${statistic}, counts=${positions.join(',')}`
    ).toBeLessThan(114.07566776592196);
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
