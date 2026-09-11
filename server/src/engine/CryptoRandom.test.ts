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
 * CI never judges a cryptographic sample by luck. The distribution laws below
 * drive the uint32 source through exact residue and Fisher-Yates cases, so a
 * correct implementation is deterministic and a biased implementation fails
 * deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import { secureRandomInt, secureRandom, secureShuffle } from './CryptoRandom.js';
import { Deck, RANKS, SUITS } from './PokerEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function withUint32Draws<T>(draws: number[], run: () => T): T {
  const remaining = [...draws];
  const randomValues = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
    array: Uint32Array
  ) => {
    const next = remaining.shift();
    if (next === undefined) throw new Error('test exhausted its deterministic uint32 draws');
    array[0] = next >>> 0;
    return array;
  }) as unknown as typeof globalThis.crypto.getRandomValues);
  try {
    const result = run();
    expect(remaining, 'every deterministic uint32 draw was consumed').toHaveLength(0);
    return result;
  } finally {
    randomValues.mockRestore();
  }
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

  it('maps every accepted residue exactly once for a non-divisor of 2^32', () => {
    withUint32Draws([0, 1, 2, 3, 4, 5, 6], () => {
      expect(Array.from({ length: 7 }, () => secureRandomInt(7))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });

  it('rejects the incomplete high residue block instead of applying modulo bias', () => {
    const max = 7;
    const firstRejected = Math.floor(0xffffffff / max) * max;
    withUint32Draws([firstRejected, 0xffffffff, 6], () => {
      expect(secureRandomInt(max)).toBe(6);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// secureRandom
// ═══════════════════════════════════════════════════════════════════════════════

describe('secureRandom', () => {
  it('consumes a fresh uint32 for every bounded float', () => {
    withUint32Draws([0, 1, 0xffffffff], () => {
      const values = [secureRandom(), secureRandom(), secureRandom()];
      expect(values).toEqual([0, 1 / 0x100000000, 0xffffffff / 0x100000000]);
      expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    });
  });

  it('scales the full uint32 range into exact [0, 1) boundaries', () => {
    withUint32Draws([0, 0x80000000, 0xffffffff], () => {
      expect([secureRandom(), secureRandom(), secureRandom()]).toEqual([
        0,
        0.5,
        0xffffffff / 0x100000000,
      ]);
    });
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

  it('maps every Fisher-Yates choice sequence to each three-element permutation once', () => {
    const permutations = new Set<string>();
    for (let choiceAtTwo = 0; choiceAtTwo <= 2; choiceAtTwo++) {
      for (let choiceAtOne = 0; choiceAtOne <= 1; choiceAtOne++) {
        const arr = [0, 1, 2];
        withUint32Draws([choiceAtTwo, choiceAtOne], () => secureShuffle(arr));
        permutations.add(arr.join(','));
      }
    }
    expect([...permutations].sort()).toEqual([
      '0,1,2',
      '0,2,1',
      '1,0,2',
      '1,2,0',
      '2,0,1',
      '2,1,0',
    ]);
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
    const newDeckOrder = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })))
      .map(cardKey)
      .join(',');
    const shuffled = withUint32Draws(new Array(51).fill(0), () =>
      new Deck().deal(52).map(cardKey).join(',')
    );
    expect(shuffled).not.toBe(newDeckOrder);
  });

  it('can deal the ace of spades to every position through exact Fisher-Yates choices', () => {
    const positions: number[] = [];
    for (let target = 0; target < 52; target++) {
      const draws = Array.from({ length: 51 }, (_, offset) => {
        const index = 51 - offset;
        return index === 51 ? target : index;
      });
      const cards = withUint32Draws(draws, () => new Deck().deal(52));
      const idx = cards.findIndex((c) => c.rank === 'A' && c.suit === 'spades');
      positions.push(idx);
    }
    expect(positions).toEqual(Array.from({ length: 52 }, (_, index) => index));
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
