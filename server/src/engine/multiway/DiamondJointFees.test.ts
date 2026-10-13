import { it, expect } from 'vitest';
import { jointFixture } from './JointRangeFixture.test-support.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';
import { snapshotDiamondCashFees } from '../../domain/diamondCashFeeSnapshot.js';
const decimal = (n: number) => ({ units: BigInt(n), scale: 0 });
it.each([false, true])(
  'Diamond forecast prices actual fees and whole payouts (double board=%s)',
  (doubleBoard) => {
    const { hero, state } = jointFixture('nlh', 'flop', doubleBoard ? 2 : 1, 4);
    state.players.forEach((p) => {
      p.stack = 2000;
      p.totalInvested = 1000;
      p.bet = 0;
    });
    const settlement = settleJointScores({
      prepared: prepareJointPots(state.players, 1),
      heroId: hero.user_id,
      opponentIds: state.players.filter((p) => p.user_id !== hero.user_id).map((p) => p.user_id),
      dealerSeat: 4,
      splitLow: false,
      sample: {
        boards: Array.from({ length: doubleBoard ? 2 : 1 }, () => ({
          heroHigh: 2,
          opponentHigh: [1, 1, 1],
          heroLow: null,
          opponentLow: [null, null, null],
          opponentDecisionStrength: [0.1, 0.1, 0.1],
        })),
      },
    });
    const input = {
      settlement,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bbjConfig: null,
      asset: 'diamonds',
      gameMode: 'cash',
      bigBlind: 100,
      dealtPlayers: 4,
      sawFlop: true,
      variant: 'nlh',
      doubleBoard,
      diamondCashFees: snapshotDiamondCashFees({
        enabled: true,
        bigBlind: 100,
        noFlopNoDrop: true,
        rounding: 'down',
        minPot: decimal(0),
        percent: { '': decimal(5), _heads_up: decimal(5), _three_handed: decimal(5) },
        cap: { '': decimal(10000), _heads_up: decimal(10000), _three_handed: decimal(10000) },
        jackpot: {
          enabled: true,
          drop: 3,
          minDealtIn: 3,
          minPot: 1000,
          excludedVariants: [],
          qualifyingHands: { nlh: 'AAAJJ' },
          miniEnabled: true,
          miniAmount: 1500,
          miniReserveFloor: 5000,
        },
      }),
    };
    const result = applyJointDeductions({
      ...input,
      asset: 'diamonds',
      gameMode: 'cash',
      rakeConfig: {
        ...input.rakeConfig,
        diamondCashFees: { schedule: input.diamondCashFees, variant: 'nlh', doubleBoard },
      },
    });
    expect(result.gross).toBe(4000);
    expect(result.rake).toBe(200);
    expect(result.bbjFee).toBe(doubleBoard ? 0 : 3);
    expect(result.net).toBe(doubleBoard ? 3800 : 3797);
    expect(Object.values(result.netTotals).every(Number.isInteger)).toBe(true);
    expect(
      Object.values(result.netTotals).reduce((a, b) => a + b, 0) + result.rake + result.bbjFee
    ).toBe(4000);
  }
);
