import { describe, expect, it } from 'vitest';
import type { GameVariant, HandConfig, GameState, HandEvent, SeatPlayer } from '../../types.js';
import { HandController } from '../HandController.js';
import { createHandStateMachine } from '../StateMachine.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { jointFixture } from './JointRangeFixture.test-support.js';
import { sampleJointRanges } from './JointRangeSampler.js';
import { prepareJointPots, settleJointScores } from './JointPotDistribution.js';
import { applyJointDeductions } from './JointDeductions.js';

describe('joint fee and net-return calculation', () => {
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as GameVariant[])(
    '%s matches the controller final net winners and refunds in all board counts',
    (variant) => {
      for (const boards of [1, 2, 3])
        for (const rate of [0, 3, 10])
          for (const count of [2, 4]) {
            const { hero, state } = jointFixture(variant, 'flop', boards, count);
            state.players.forEach((p, i) => {
              p.stack = 200;
              p.totalInvested = [10.01, 23.33, 20.11, 6.07][i];
              p.bet = p.totalInvested;
            });
            Object.assign(hero, {
              stack: state.players[0].stack,
              bet: state.players[0].bet,
              totalInvested: state.players[0].totalInvested,
            });
            let deal:
              | Parameters<
                  NonNullable<Parameters<typeof sampleJointRanges>[2]['inspectPhysicalSample']>
                >[0]
              | undefined;
            const sampled = sampleJointRanges(hero, state, {
              seed: 13009301 + rate,
              samples: 1,
              withinBudget: () => true,
              inspectPhysicalSample: (s) => {
                deal = s;
              },
            })!;
            const rakeConfig = {
              percent: rate,
              cap: 1.75,
              noFlopNoDrop: true,
              playerCountCaps: [
                { players: 2, cap: 0.37 },
                { players: 3, cap: 1.75 },
              ],
            };
            const bbjConfig = {
              enabled: rate > 0,
              feeBB: 0.25,
              minPlayersDealt: 3,
              minPotBB: 10000,
            };
            const gross = settleJointScores({
              prepared: prepareJointPots(state.players, 0.01),
              heroId: hero.user_id,
              opponentIds: sampled.opponentIds,
              sample: sampled.samples[0],
              dealerSeat: count,
              splitLow: horseVariantRulesFor(variant).splitLow8OrBetter,
            });
            const calculated = applyJointDeductions({
              settlement: gross,
              rakeConfig,
              bbjConfig,
              asset: 'chips',
              gameMode: 'cash',
              bigBlind: 2,
              dealtPlayers: count,
              sawFlop: true,
            });
            const config: HandConfig = {
              tableId: 'joint-net-fixture',
              handNumber: 1,
              gameVariant: variant,
              smallBlind: 1,
              bigBlind: 2,
              rakeConfig,
              bbjConfig,
            };
            const seats: SeatPlayer[] = state.players.map((p) => ({
              ...p,
              is_sitting_out: false,
              cards:
                p.user_id === hero.user_id
                  ? deal!.heroRetainedCards
                  : deal!.opponentDeals.find((o) => o.userId === p.user_id)!.retained,
            }));
            const hc = new HandController(config, seats, count);
            const internal = hc as unknown as {
              state: GameState;
              activeBoardCount: number;
              handFSM: ReturnType<typeof createHandStateMachine>;
              completeHandInner(): void;
            };
            Object.assign(internal.state, {
              players: seats,
              stage: 'showdown',
              sawFlop: true,
              pot: seats.reduce((s, p) => s + p.totalInvested, 0),
              communityCards: deal!.boards[0],
              communityCards2: deal!.boards[1] ?? [],
              communityCards3: deal!.boards[2] ?? [],
            });
            internal.activeBoardCount = boards;
            internal.handFSM = createHandStateMachine('showdown');
            const events: HandEvent[] = [];
            hc.onEvent((e) => events.push(e));
            internal.completeHandInner();
            const win = events.find((e) => e.type === 'WINNERS') as Extract<
              HandEvent,
              { type: 'WINNERS' }
            >;
            const complete = events.find((e) => e.type === 'HAND_COMPLETE') as Extract<
              HandEvent,
              { type: 'HAND_COMPLETE' }
            >;
            expect(complete.rake).toBeCloseTo(calculated.rake, 8);
            expect(complete.bbjFee).toBeCloseTo(calculated.bbjFee, 8);
            for (const p of seats) {
              expect(
                win.winners.filter((w) => w.userId === p.user_id).reduce((s, w) => s + w.amount, 0)
              ).toBeCloseTo(calculated.netTotals[p.user_id], 8);
              expect(p.stack).toBeCloseTo(
                200 + calculated.netTotals[p.user_id] + calculated.refunds[p.user_id],
                8
              );
            }
            expect(
              Object.values(calculated.netTotals).reduce((a, b) => a + b, 0) +
                calculated.rake +
                calculated.bbjFee
            ).toBeCloseTo(calculated.gross, 8);
          }
    }
  );
  const caseInput = () => {
    const { hero, state } = jointFixture('nlh', 'river', 1, 2);
    state.players.forEach((p) => {
      p.totalInvested = 0.01;
      p.bet = 0.01;
    });
    const settlement = settleJointScores({
      prepared: prepareJointPots(state.players, 0.01),
      heroId: hero.user_id,
      opponentIds: ['p1'],
      dealerSeat: 2,
      splitLow: false,
      sample: {
        boards: [
          {
            heroHigh: 2,
            opponentHigh: [1],
            heroLow: null,
            opponentLow: [null],
            opponentDecisionStrength: [0.1],
          },
        ],
      },
    });
    return {
      settlement,
      rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
      bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 0, minPlayersDealt: 2 },
      asset: 'chips' as const,
      gameMode: 'cash' as const,
      bigBlind: 2,
      dealtPlayers: 2,
      sawFlop: true,
    };
  };
  it('gives BBJ the remainder after rake and never takes more than the contested pot', () => {
    const result = applyJointDeductions(caseInput());
    expect(result.net).toBe(0);
    expect(result.bbjFee + result.rake).toBeCloseTo(0.02, 8);
  });
  it('charges no-flop/no-drop on a preflop walk and leaves refunds alone', () => {
    const input = caseInput();
    input.sawFlop = false;
    const result = applyJointDeductions(input);
    expect(result.rake).toBe(0);
    expect(result.bbjFee).toBe(0);
    expect(result.net).toBe(0.02);
  });
  it.each(['timed', 'diamond_fee', 'tournament_fee', 'missing_bbj', 'bad_cap', 'bad_count'])(
    'refuses unsupported %s fee configuration',
    (fault) => {
      const input: any = caseInput();
      if (fault === 'timed') input.rakeConfig.timedRake = { amountPerMinute: 1 };
      if (fault === 'diamond_fee') input.asset = 'diamonds';
      if (fault === 'tournament_fee') input.gameMode = 'tournament';
      if (fault === 'missing_bbj') delete input.bbjConfig;
      if (fault === 'bad_cap') input.rakeConfig.cap = NaN;
      if (fault === 'bad_count') input.dealtPlayers = 1;
      expect(() => applyJointDeductions(input)).toThrow();
    }
  );
});
