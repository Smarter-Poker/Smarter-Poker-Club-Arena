import { describe, expect, it } from 'vitest';
import {
  estimateRangeAdvantage,
  saveFastRandom,
  seedFastRandom,
  variantInfo,
} from './HorseEval.js';
import type { Card } from '../types.js';
const suits: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cards = (s: string): Card[] =>
  s.match(/../g)!.map((c) => ({ rank: c[0], suit: suits[c[1]] }) as Card);
const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'];
describe('public range advantage across Holdem and Omaha', () => {
  for (const variant of variants) {
    it(`${variant} prices the ranges and preserves the decision random stream`, () => {
      seedFastRandom(6789);
      const before = saveFastRandom();
      const result = estimateRangeAdvantage(
        cards('AsKh7d'),
        [0.86, 1],
        [0, 0.4],
        variantInfo(variant)
      );
      expect(result).not.toBeNull();
      expect(result!.samples).toBeGreaterThanOrEqual(96);
      expect(result!.advantage).toBe(true);
      expect(result!.equity).toBeGreaterThan(0.5);
      expect(saveFastRandom()).toBe(before);
      result!.equity = 0;
      const cached = estimateRangeAdvantage(
        cards('AsKh7d'),
        [0.86, 1],
        [0, 0.4],
        variantInfo(variant)
      );
      expect(cached!.equity).toBeGreaterThan(0.5);
      expect(saveFastRandom()).toBe(before);
    });
  }
  it('does not give an Omaha preflop raiser an automatic edge on connected low boards', () => {
    const r = estimateRangeAdvantage(cards('7s6d5c'), [0.86, 1], [0, 0.4], variantInfo('plo4'))!;
    expect(r.advantage).toBe(false);
    expect(r.disadvantage).toBe(true);
  });
  it('recognizes an exact board-only Holdem tie independently of range sampling', () => {
    const r = estimateRangeAdvantage(cards('AsKsQsJsTs'), [0, 1], [0, 1], variantInfo('nlh'))!;
    expect(r.equity).toBe(0.5);
    expect(r.standardError).toBe(0);
    expect(r.advantage).toBe(false);
    expect(r.disadvantage).toBe(false);
  });
  it('rejects invalid bands, duplicate cards and unsupported rules', () => {
    expect(estimateRangeAdvantage(cards('AsAs7d'), [0, 1], [0, 1], variantInfo('plo5'))).toBeNull();
    expect(estimateRangeAdvantage(cards('AsKh7d'), [1, 0], [0, 1], variantInfo('nlh'))).toBeNull();
    expect(estimateRangeAdvantage(cards('AsKh'), [0, 1], [0, 1], variantInfo('nlh'))).toBeNull();
  });
});
