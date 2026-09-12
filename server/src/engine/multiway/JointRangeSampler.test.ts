import { describe, expect, it } from 'vitest';
import type { Card, GameVariant } from '../../types.js';
import { saveFastRandom, seedFastRandom, fastRandom } from '../HorseEval.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { referenceRemainingHigh } from '../../benchmark/RemainingVariantReference.js';
import { referenceOmaha } from '../../benchmark/OmahaReference.js';
import {
  buildJointOpponentRanges,
  sampleJointRanges,
  jointDecisionStrength,
} from './JointRangeSampler.js';

import { jointFixture } from './JointRangeFixture.test-support.js';

const variants: GameVariant[] = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flo8',
  'flh',
  'pineapple',
  'short_deck',
];
type Tap = NonNullable<Parameters<typeof sampleJointRanges>[2]['inspectPhysicalSample']>;
type Deal = Parameters<Tap>[0];
const withoutClock = (value: ReturnType<typeof sampleJointRanges>) => {
  if (!value) return value;
  const { analysisMs, ...rest } = value;
  return rest;
};
const winners = (scores: number[], low = false) =>
  scores.flatMap((v, i) => (v === (low ? Math.min(...scores) : Math.max(...scores)) ? [i] : []));

describe('physical joint public-range samples', () => {
  it.each(variants)('%s preserves one deck across every board and folded deal', (variant) => {
    const rules = horseVariantRulesFor(variant);
    for (const stage of ['preflop', 'flop', 'turn', 'river'] as const)
      for (const count of [1, 2, 3]) {
        const seats = Math.min(10, Math.floor((rules.deckSize - count * 5) / rules.holeCardsDealt));
        const { hero, state } = jointFixture(variant, stage, count, seats);
        const original = structuredClone({ hero, state });
        const captured: Deal[] = [];
        const result = sampleJointRanges(hero, state, {
          seed: 13007103,
          samples: 6,
          withinBudget: () => true,
          inspectPhysicalSample: (sample) => captured.push(sample),
        });
        expect(result?.samples).toHaveLength(6);
        expect(result?.unknownDealtCardsPerSample).toBe((seats - 1) * rules.holeCardsDealt);
        expect(result?.opponentIds).not.toContain('p' + (seats - 1));
        for (let index = 0; index < captured.length; index++) {
          const deal = captured[index];
          const physical = [
            ...deal.heroCards,
            ...deal.knownDeadCards,
            ...deal.opponentDeals.flatMap((p) => p.dealt),
            ...deal.boards.flat(),
          ];
          expect(new Set(physical.map((c) => c.rank + ':' + c.suit)).size).toBe(physical.length);
          expect(physical.length).toBe(result!.physicalCardsPerSample);
          expect(physical.length).toBeLessThanOrEqual(rules.deckSize);
          for (const p of deal.opponentDeals)
            expect(
              p.retained.every((c) => p.dealt.some((d) => d.rank === c.rank && d.suit === c.suit))
            ).toBe(true);
          // The independent reference scores the captured physical deal. Only
          // relative ranking/low qualification is compared; encodings differ.
          if (index === 0)
            for (let board = 0; board < count; board++) {
              const cards = [
                deal.heroRetainedCards,
                ...result!.opponentIds.map(
                  (id) => deal.opponentDeals.find((p) => p.userId === id)!.retained
                ),
              ];
              const expected = cards.map((hand) =>
                rules.holeCardsUse === 'exactly_two'
                  ? referenceOmaha(hand, deal.boards[board])
                  : {
                      high: referenceRemainingHigh(
                        variant === 'nlh' ? 'flh' : (variant as 'flh' | 'pineapple' | 'short_deck'),
                        hand,
                        deal.boards[board]
                      ).score,
                      low: null,
                    }
              );
              const actual = result!.samples[index].boards[board];
              expect(winners([actual.heroHigh, ...actual.opponentHigh])).toEqual(
                winners(expected.map((s) => s.high))
              );
              expect(
                winners(
                  [actual.heroLow, ...actual.opponentLow].map((v) => v ?? Infinity),
                  true
                )
              ).toEqual(
                winners(
                  expected.map((s) => (rules.splitLow8OrBetter ? (s.low ?? Infinity) : Infinity)),
                  true
                )
              );
            }
        }
        expect({ hero, state }).toEqual(original);
        expect(JSON.stringify(result)).not.toContain('"rank"');
      }
  });
  it('keeps the baseline stream unchanged and replays the complete result', () => {
    const { hero, state } = jointFixture('plo8');
    seedFastRandom(13007107);
    const before = saveFastRandom();
    const a = sampleJointRanges(hero, state, { samples: 32, withinBudget: () => true });
    expect(saveFastRandom()).toBe(before);
    for (let i = 0; i < 100; i++) fastRandom();
    seedFastRandom(before);
    const b = sampleJointRanges(hero, state, { samples: 32, withinBudget: () => true });
    expect(withoutClock(a)).toEqual(withoutClock(b));
  });
  it('conditions each opponent on their own public line and keeps unacted bomb ranges uniform', () => {
    const { hero, state } = jointFixture();
    state.actionHistory = [
      { userId: 'p1', seat: 2, action: 'raise', amount: 12, timestamp: 1, stage: 'flop' },
      { userId: 'p1', seat: 2, action: 'call', amount: 8, timestamp: 2, stage: 'flop' },
      { userId: 'p2', seat: 3, action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
    ];
    const ranges = buildJointOpponentRanges(hero, state);
    expect(ranges[0]).toMatchObject({ raises: 1, calls: 1, exponent: 0.85 });
    expect(ranges[1]).toMatchObject({ raises: 0, checks: 1, exponent: 0 });
    const a = sampleJointRanges(hero, state, { seed: 7, samples: 32, withinBudget: () => true });
    const b = sampleJointRanges(
      hero,
      { ...state, actionHistory: [] },
      { seed: 7, samples: 32, withinBudget: () => true }
    );
    expect(a?.samples).not.toEqual(b?.samples);
  });
  it('ignores alleged future lines and preflop records on bomb hands', () => {
    const { hero, state } = jointFixture();
    const base = buildJointOpponentRanges(hero, state);
    state.actionHistory = ['preflop', 'turn', 'river'].map((stage) => ({
      userId: 'p1',
      seat: 2,
      stage,
      action: 'raise',
      amount: 20,
      timestamp: 1,
    })) as any;
    expect(buildJointOpponentRanges(hero, state)).toEqual(base);
  });
  it('retains physical folded seats but admits an all-in disconnected contender', () => {
    const { hero, state } = jointFixture();
    state.players[2].is_all_in = true;
    state.players[2].is_sitting_out = true;
    const result = sampleJointRanges(hero, state, { samples: 8, withinBudget: () => true });
    expect(result?.opponentIds).toEqual(['p1', 'p2']);
    expect(result?.ranges[2]).toMatchObject({ folded: true, live: false });
    expect(result?.unknownDealtCardsPerSample).toBe(6);
  });
  it('returns only complete samples when the budget expires', () => {
    const { hero, state } = jointFixture();
    expect(sampleJointRanges(hero, state, { withinBudget: () => false })).toBeNull();
    let calls = 0;
    const result = sampleJointRanges(hero, state, {
      samples: 32,
      withinBudget: () => ++calls < 25,
    });
    expect(result?.sampleBudgetExhausted).toBe(true);
    expect(result!.samples.length).toBeGreaterThan(0);
    expect(result!.samples.length).toBeLessThan(32);
    expect(
      result!.samples.every(
        (s) => s.boards.length === 2 && s.boards.every((b) => b.opponentHigh.length === 2)
      )
    ).toBe(true);
  });
  it.each(['collision', 'dead', 'private', 'census', 'capacity', 'count', 'seed', 'budget'])(
    'refuses invalid %s without a partial result',
    (fault) => {
      const { hero, state } = jointFixture('plo6', 'flop', 3, 6);
      if (fault === 'collision') state.communityCards2![0] = hero.cards[0];
      if (fault === 'dead') hero.knownDeadCards = [hero.cards[0]];
      if (fault === 'private') state.players[1].cards = [hero.cards[0]];
      if (fault === 'census') state.dealtSeatIds = [1, 2, 2];
      if (fault === 'capacity') {
        state.players.push({ ...state.players[5], seat: 7, user_id: 'p6' });
        state.dealtSeatIds!.push(7);
      }
      if (fault === 'count') state.boardCount = 2;
      expect(
        sampleJointRanges(hero, state, {
          samples: fault === 'budget' ? 129 : 8,
          seed: fault === 'seed' ? NaN : 17,
          withinBudget: () => true,
        })
      ).toBeNull();
    }
  );
  it('isolates certification observers from the scored deal', () => {
    const { hero, state } = jointFixture('pineapple');
    const options = { seed: 71, samples: 8, withinBudget: () => true };
    const a = sampleJointRanges(hero, state, options);
    const b = sampleJointRanges(hero, state, {
      ...options,
      inspectPhysicalSample: (deal) => {
        deal.boards[0][0].rank = 'A';
        deal.opponentDeals[0].retained.splice(0);
        deal.heroCards[0].rank = '2';
      },
    });
    expect(withoutClock(a)).toEqual(withoutClock(b));
  });
  it('makes the present board change the structural response read', () => {
    const cards: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ];
    const board = (ranks: string) => [...ranks].map((rank) => ({ rank, suit: 'spades' }) as Card);
    expect(jointDecisionStrength('nlh', cards, board('QJT'))).toBeGreaterThan(
      jointDecisionStrength('nlh', cards, [
        { rank: '2', suit: 'hearts' },
        { rank: '7', suit: 'clubs' },
        { rank: '9', suit: 'diamonds' },
      ])
    );
  });
});
