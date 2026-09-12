import { describe, expect, it } from 'vitest';
import type { GameVariant } from '../../types.js';
import { settleJointBoardReference } from '../../benchmark/JointBoardReference.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { sampleJointRanges } from './JointRangeSampler.js';
import { jointFixture } from './JointRangeFixture.test-support.js';
import {
  prepareJointPots,
  settleJointScores,
  jointPotDistribution,
} from './JointPotDistribution.js';

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
const units = (value: number, unit: number) => Math.round(value / unit);
const asAwards = (
  awards: {
    playerId: string;
    potIndex: number;
    boardIndex: number;
    half: string;
    amount: number;
  }[],
  unit: number
) =>
  awards
    .map((a) => [a.potIndex, a.boardIndex, a.half, a.playerId, units(a.amount, unit)].join(':'))
    .sort();

describe('exact joint pot distributions', () => {
  it.each(variants)(
    '%s matches independent awards/refunds across board, seat and chip-unit boundaries',
    (variant) => {
      const rules = horseVariantRulesFor(variant);
      for (const chipUnit of [0.01, 1] as const)
        for (const boardCount of [2, 3]) {
          const cap = Math.min(
            10,
            Math.floor((rules.deckSize - boardCount * 5) / rules.holeCardsDealt)
          );
          for (const count of [2, 3, cap]) {
            const { hero, state } = jointFixture(variant, 'flop', boardCount, count);
            state.players.forEach((p, i) => {
              p.totalInvested =
                (i === 0 ? 101 : i === 1 ? 233 : i === 2 ? 201 : 31 + (i % 4) * 30) * chipUnit;
              p.bet = p.totalInvested;
              p.stack = 500 * chipUnit;
            });
            state.pot = state.players.reduce((a, p) => a + p.totalInvested, 0);
            Object.assign(hero, {
              stack: state.players[0].stack,
              bet: state.players[0].bet,
              totalInvested: state.players[0].totalInvested,
            });
            const copies = structuredClone(state.players);
            const prepared = prepareJointPots(state.players, chipUnit);
            const physical: Parameters<
              NonNullable<Parameters<typeof sampleJointRanges>[2]['inspectPhysicalSample']>
            >[0][] = [];
            const samples = sampleJointRanges(hero, state, {
              seed: 13008201 + count,
              samples: 4,
              withinBudget: () => true,
              inspectPhysicalSample: (s) => physical.push(s),
            })!;
            expect(samples.samples).toHaveLength(4);
            const dealerSeat = count - 1;
            for (let i = 0; i < samples.samples.length; i++) {
              const deal = physical[i];
              const dead = [
                ...deal.knownDeadCards,
                ...deal.opponentDeals.flatMap((p) =>
                  p.dealt.filter(
                    (c) => !p.retained.some((r) => r.rank === c.rank && r.suit === c.suit)
                  )
                ),
              ];
              const expected = settleJointBoardReference({
                variant,
                players: state.players.map((p) => ({
                  id: p.user_id,
                  seat: p.seat,
                  folded: p.is_folded,
                  contributed: p.totalInvested,
                  cards:
                    p.user_id === hero.user_id
                      ? deal.heroRetainedCards
                      : deal.opponentDeals.find((d) => d.userId === p.user_id)!.retained,
                })),
                boards: deal.boards,
                knownDeadCards: dead,
                chipUnit,
                dealerSeat,
              });
              const actual = settleJointScores({
                prepared,
                heroId: hero.user_id,
                opponentIds: samples.opponentIds,
                sample: samples.samples[i],
                splitLow: rules.splitLow8OrBetter,
                dealerSeat,
              });
              expect(asAwards(actual.awards, chipUnit)).toEqual(
                asAwards(expected.awards, chipUnit)
              );
              for (const p of state.players) {
                expect(units(actual.refunds[p.user_id], chipUnit)).toBe(
                  units(expected.refunds[p.user_id] ?? 0, chipUnit)
                );
                expect(units(actual.totals[p.user_id], chipUnit)).toBe(
                  units(expected.totals[p.user_id], chipUnit)
                );
              }
              expect(
                units(
                  Object.values(actual.resultingStacks).reduce((a, b) => a + b, 0),
                  chipUnit
                )
              ).toBe(
                units(
                  state.players.reduce((a, p) => a + p.stack + p.totalInvested, 0),
                  chipUnit
                )
              );
            }
            const distribution = jointPotDistribution({
              prepared,
              heroId: hero.user_id,
              opponentIds: samples.opponentIds,
              samples: samples.samples,
              splitLow: rules.splitLow8OrBetter,
              dealerSeat,
            });
            expect(distribution.boardMeans.reduce((a, b) => a + b, 0)).toBeCloseTo(
              distribution.expectedAward,
              8
            );
            expect(distribution.covariance.flat().reduce<number>((a, b) => a + b!, 0)).toBeCloseTo(
              distribution.variance!,
              7
            );
            expect(distribution.distribution.reduce((a, b) => a + b.probability, 0)).toBeCloseTo(
              1,
              10
            );
            expect(state.players).toEqual(copies);
          }
        }
    }
  );
  const headsUp = () => {
    const { hero, state } = jointFixture('nlh', 'river', 2, 2);
    state.players.forEach((p) => {
      p.totalInvested = 50;
      p.bet = 50;
      p.stack = 50;
    });
    const prepared = prepareJointPots(state.players, 1);
    const board = (heroWins: boolean) => ({
      heroHigh: heroWins ? 10 : 1,
      opponentHigh: [heroWins ? 1 : 10],
      heroLow: null,
      opponentLow: [null],
      opponentDecisionStrength: [0.5],
    });
    return {
      prepared,
      heroId: hero.user_id,
      opponentIds: ['p1'],
      splitLow: false,
      dealerSeat: 2,
      board,
    };
  };
  it('distinguishes identical per-board means with opposite joint risk', () => {
    const { board, ...input } = headsUp();
    const correlated = jointPotDistribution({
      ...input,
      samples: [{ boards: [board(true), board(true)] }, { boards: [board(false), board(false)] }],
    });
    const hedged = jointPotDistribution({
      ...input,
      samples: [{ boards: [board(true), board(false)] }, { boards: [board(false), board(true)] }],
    });
    expect(correlated.boardMeans).toEqual(hedged.boardMeans);
    expect(correlated.expectedAward).toBe(50);
    expect(hedged.expectedAward).toBe(50);
    expect(correlated.covariance[0][1]).toBe(1250);
    expect(hedged.covariance[0][1]).toBe(-1250);
    expect(correlated.variance).toBe(5000);
    expect(hedged.variance).toBe(0);
    expect(correlated.scoopProbability).toBe(0.5);
    expect(hedged.scoopProbability).toBe(0);
    expect(hedged.distribution).toEqual([{ award: 50, probability: 1 }]);
  });
  it('preserves a one-board lock while the other board is contested', () => {
    const { board, ...input } = headsUp();
    const result = jointPotDistribution({
      ...input,
      samples: [{ boards: [board(true), board(true)] }, { boards: [board(true), board(false)] }],
    });
    expect(result.boardMeans).toEqual([50, 25]);
    expect(result.covariance[0]).toEqual([0, 0]);
    expect(result.expectedAward).toBe(75);
  });
  it('reports unknown sampling error from a single observation', () => {
    const { board, ...input } = headsUp();
    const result = jointPotDistribution({
      ...input,
      samples: [{ boards: [board(true), board(true)] }],
    });
    expect(result.standardError).toBeNull();
    expect(result.covariance).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(result.samplingRadius99).toBeGreaterThan(0);
  });
  it('keeps shared dead money separate from a short individual ante', () => {
    const { state } = jointFixture('nlh', 'river', 2, 3);
    state.players.forEach((p) => {
      p.is_folded = false;
      p.is_sitting_out = false;
      p.bet = 0;
    });
    Object.assign(state.players[0], { totalInvested: 100, deadInvested: 0 });
    Object.assign(state.players[1], {
      totalInvested: 110,
      deadInvested: 10,
      individualAnteInvested: 0,
    });
    Object.assign(state.players[2], {
      totalInvested: 5,
      deadInvested: 5,
      individualAnteInvested: 5,
    });
    const prepared = prepareJointPots(state.players, 1);
    expect(prepared.pots).toEqual([
      { amount: 25, eligiblePlayers: ['p0', 'p1', 'p2'] },
      { amount: 190, eligiblePlayers: ['p0', 'p1'] },
    ]);
    expect(Object.values(prepared.refunds)).toEqual([0, 0, 0]);
  });
  it.each([
    'chip_unit',
    'fractional',
    'dead',
    'identity',
    'missing_contender',
    'bad_score',
    'board_mismatch',
  ])('refuses %s rather than inventing an award', (fault) => {
    const { board, ...input } = headsUp();
    if (fault === 'chip_unit')
      expect(() => prepareJointPots(input.prepared.seats, 0.5 as any)).toThrow();
    if (fault === 'fractional')
      expect(() =>
        prepareJointPots(
          input.prepared.seats.map((p) => ({ ...p, stack: 1.2 })),
          1
        )
      ).toThrow();
    if (fault === 'dead')
      expect(() =>
        prepareJointPots(
          input.prepared.seats.map((p) => ({ ...p, deadInvested: 51 })),
          1
        )
      ).toThrow();
    if (fault === 'identity')
      expect(() =>
        settleJointScores({ ...input, dealerSeat: 0, sample: { boards: [board(true)] } })
      ).toThrow();
    if (fault === 'missing_contender')
      expect(() =>
        settleJointScores({
          ...input,
          opponentIds: [],
          sample: { boards: [{ ...board(true), opponentHigh: [], opponentLow: [] }] },
        })
      ).toThrow();
    if (fault === 'bad_score')
      expect(() =>
        settleJointScores({ ...input, sample: { boards: [{ ...board(true), heroHigh: NaN }] } })
      ).toThrow();
    if (fault === 'board_mismatch')
      expect(() =>
        jointPotDistribution({
          ...input,
          samples: [{ boards: [board(true)] }, { boards: [board(true), board(false)] }],
        })
      ).toThrow();
  });
});
