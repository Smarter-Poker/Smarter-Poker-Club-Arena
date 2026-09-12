import { describe, expect, it } from 'vitest';
import type { SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import { omahaVariantEquityFromShowdowns, validOmahaVariantEquity } from './OmahaVariantEquity.js';

const seat = (id: string, index: number, invested: number): SeatPlayer => ({
  user_id: id,
  username: id,
  seat: index,
  stack: 100,
  bet: 0,
  totalInvested: invested,
  cards: [],
  is_folded: false,
  is_sitting_out: false,
  is_all_in: false,
});
const sample = (high: number[], low: Array<number | null>): HorseEquityOutcomeSample => ({
  heroHigh: high[0],
  opponentHigh: high.slice(1),
  heroLow: low[0],
  opponentLow: low.slice(1),
  opponentDecisionStrength: high.slice(1),
});

describe('Phase 11 joint-showdown pot pricing', () => {
  it('rejects malformed nested evidence and invalid pot targets without throwing', () => {
    const evidence = omahaVariantEquityFromShowdowns({
      variant: 'plo8',
      players: [seat('hero', 1, 100), seat('other', 2, 100)],
      heroId: 'hero',
      callCost: 0,
      opponentIds: ['other'],
      samples: [sample([2, 1], [null, null])],
    })!;
    expect(validOmahaVariantEquity(evidence, 200)).toBe(true);
    for (const field of ['distribution', 'perPot'] as const) {
      const malformed = { ...evidence, [field]: [null] } as unknown as typeof evidence;
      expect(validOmahaVariantEquity(malformed, 200)).toBe(false);
    }
    for (const pot of [NaN, Infinity, -1, 0]) {
      expect(validOmahaVariantEquity(evidence, pot)).toBe(false);
    }
  });
  it('lets a hero win the large side pot although the short stack beats both halves of the main pot', () => {
    const result = omahaVariantEquityFromShowdowns({
      variant: 'plo8',
      players: [seat('hero', 1, 200), seat('short', 2, 50), seat('deep', 3, 200)],
      heroId: 'hero',
      callCost: 0,
      opponentIds: ['short', 'deep'],
      samples: [sample([20, 30, 10], [100, 50, null])],
    })!;
    expect(result.eligiblePot).toBe(450);
    expect(result.expectedChips).toBe(300);
    expect(result.highEquity).toBeCloseTo(1 / 3);
    expect(result.lowEquity).toBeCloseTo(1 / 3);
    expect(result.perPot.map((p) => [p.amount, p.equity])).toEqual([
      [150, 0],
      [300, 1],
    ]);
  });
  it.each([
    [2, 0.25],
    [3, 1 / 6],
  ] as const)(
    'measures %i-way tied lows without treating them as half-pot ownership',
    (count, share) => {
      const players = Array.from({ length: count }, (_, i) =>
        seat(i ? 'opponent' + i : 'hero', i + 1, 100)
      );
      const result = omahaVariantEquityFromShowdowns({
        variant: 'plo8',
        players,
        heroId: 'hero',
        callCost: 0,
        opponentIds: players.slice(1).map((p) => p.user_id),
        samples: [sample([1, ...Array(count - 1).fill(2)], Array(count).fill(100))],
      })!;
      expect(result.equity).toBeCloseTo(share);
      expect(result.highEquity).toBe(0);
      expect(result.quarterOrLessProbability).toBe(1);
      expect(result.sixthOrLessProbability).toBe(count === 3 ? 1 : 0);
    }
  );
  it('assigns the entire pot to high when no eligible player makes a low', () => {
    const result = omahaVariantEquityFromShowdowns({
      variant: 'plo8',
      players: [seat('hero', 1, 100), seat('other', 2, 100)],
      heroId: 'hero',
      callCost: 0,
      opponentIds: ['other'],
      samples: [sample([2, 1], [null, null])],
    })!;
    expect(result.highEquity).toBe(1);
    expect(result.lowEquity).toBe(0);
    expect(result.scoopProbability).toBe(1);
    expect(result.confidence99[0]).toBeLessThan(1);
  });
  it('prices a capped call without mutating source stacks or contributions', () => {
    const players = [seat('hero', 1, 50), { ...seat('other', 2, 100), bet: 50 }];
    const original = structuredClone(players);
    const result = omahaVariantEquityFromShowdowns({
      variant: 'plo5',
      players,
      heroId: 'hero',
      callCost: 50,
      opponentIds: ['other'],
      samples: [sample([2, 1], [null, null])],
    })!;
    expect(result.eligiblePot).toBe(200);
    expect(players).toEqual(original);
  });
  it('refuses incomplete opponent score populations', () => {
    expect(
      omahaVariantEquityFromShowdowns({
        variant: 'plo6',
        players: [seat('hero', 1, 100), seat('other', 2, 100)],
        heroId: 'hero',
        callCost: 0,
        opponentIds: ['other'],
        samples: [sample([2], [null])],
      })
    ).toBeNull();
  });
});
