import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { evaluateHand } from '../engine/PokerEngine.js';
import { scoreHoldem } from '../engine/HorseEval.js';
import {
  referenceFiveHigh,
  referenceRemainingHigh,
  remainingReferenceDeck,
} from './RemainingVariantReference.js';
const cards = (text: string): Card[] =>
  text.split(' ').map((s) => ({
    rank: s.slice(0, -1),
    suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[
      s.at(-1)! as 's' | 'h' | 'd' | 'c'
    ],
  })) as Card[];

describe('independent Phase 12 high-hand reference', () => {
  it('proves the short-deck wheel and flush/full-house ordering', () => {
    expect(referenceFiveHigh(cards('As 6h 7d 8c 9s'), true)).toMatchObject({
      category: 5,
      kickers: [9, 8, 7, 6, 1],
    });
    const flush = cards('As Js 9s 8s 6s'),
      house = cards('Ah Ad Ac Kh Kd');
    expect(referenceFiveHigh(flush, true).score).toBeGreaterThan(
      referenceFiveHigh(house, true).score
    );
    expect(referenceFiveHigh(flush, false).score).toBeLessThan(
      referenceFiveHigh(house, false).score
    );
    expect(() => referenceFiveHigh(cards('As 2h 3d 4c 5s'), true)).toThrow('physical card');
  });
  it('keeps the Pineapple discard boundary and board-playing ties explicit', () => {
    const board = cards('As Ks Qs Js Ts');
    const a = referenceRemainingHigh('pineapple', cards('2c 3d'), board);
    const b = referenceRemainingHigh('flh', cards('8c 9d'), board);
    expect(a).toEqual(b);
    expect(() => referenceRemainingHigh('pineapple', cards('2c 3d 4h'), board)).toThrow('geometry');
    expect(() => referenceRemainingHigh('short_deck', cards('As Kh'), cards('As 7h 8c'))).toThrow(
      'Duplicate'
    );
  });
  it('independently checks every physical five-card short-deck hand against both production scorers', () => {
    const deck = remainingReferenceDeck(true);
    let checked = 0,
      mismatches = 0;
    const first: unknown[] = [];
    const ordering = new Map<number, number>();
    for (let a = 0; a < 32; a++)
      for (let b = a + 1; b < 33; b++)
        for (let c = b + 1; c < 34; c++)
          for (let d = c + 1; d < 35; d++)
            for (let e = d + 1; e < 36; e++) {
              const hand = [deck[a], deck[b], deck[c], deck[d], deck[e]];
              const expected = referenceFiveHigh(hand, true),
                actual = evaluateHand([], hand, true);
              const fast = scoreHoldem(hand, 5, true);
              checked++;
              const priorFast = ordering.get(expected.score);
              ordering.set(expected.score, fast);
              // The settlement scorer repeats grouped ranks in its kicker array;
              // the reference stores each comparison rank once. Compare semantics.
              if (
                expected.category !== actual.ranking ||
                JSON.stringify(expected.kickers) !== JSON.stringify([...new Set(actual.kickers)]) ||
                Math.floor(fast / 2 ** 20) !== expected.category ||
                (priorFast !== undefined && priorFast !== fast)
              ) {
                mismatches++;
                if (first.length < 3) first.push({ hand, expected, actual, fast });
              }
            }
    expect(checked).toBe(376992);
    expect({ mismatches, first }).toEqual({ mismatches: 0, first: [] });
    const ordered = [...ordering].sort((a, b) => a[0] - b[0]);
    expect(ordered.every((row, i) => i === 0 || row[1] > ordered[i - 1][1])).toBe(true);
  }, 30000);
});
