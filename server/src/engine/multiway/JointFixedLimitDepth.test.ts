import { describe, expect, it } from 'vitest';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';
import { jointPolicyFixture } from './JointRangeFixture.test-support.js';
import { seedFastRandom } from '../HorseEval.js';
import { HorseLogic } from '../HorseLogic.js';

describe('Phase13 preserves the Phase12 fixed-limit production depth domain', () => {
  it.each(['flh', 'flo8'] as const)(
    '%s evaluates deep multiway candidates with fixed wagers and conserved outcomes',
    (variant) => {
      for (const mode of ['cash', 'tournament'] as const)
        for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
          for (const depth of [251, 400, 1000]) {
            const { hero, state, baseline } = jointPolicyFixture(variant, 1, mode, street);
            hero.stack = depth * state.bigBlind;
            state.players.forEach((p) => (p.stack = hero.stack));
            seedFastRandom(13009141);
            const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
            expect(
              result.receipt.fired,
              `${variant}/${mode}/${street}/${depth}: ${result.receipt.reason}`
            ).toBe(true);
            expect(result.decision).toBe(baseline);
            expect(result.receipt.applied).toBe(false);
            for (const candidate of result.receipt.actionModel!.candidates) {
              expect(candidate.maxConservationError).toBeLessThan(1e-6);
              expect(candidate.investment).toBeLessThanOrEqual(state.fixedBetSize!);
              if (candidate.action === 'bet') expect(candidate.amount).toBe(state.fixedBetSize);
            }
          }
    }
  );

  it.each(['flh', 'flo8'] as const)(
    '%s reaches Phase7 through the real deep multiway caller',
    (variant) => {
      const { hero, state } = jointPolicyFixture(variant, 1, 'tournament', 'river');
      hero.stack = 1000 * state.bigBlind;
      state.players.forEach((p) => (p.stack = hero.stack));
      state.tournament!.stacks = state.players.map((p) => p.stack + p.totalInvested);
      state.tournament!.stackByUser = Object.fromEntries(
        state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
      );
      seedFastRandom(130999);
      const decision = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        {
          telemetry: false,
          mind: false,
          decisionTimeMs: 0,
          phase12Remaining: 'off',
          phase13Joint: 'shadow',
          phase13EvidenceMode: true,
        }
      );
      expect(decision.jointPolicy?.fired, decision.jointPolicy?.reason).toBe(true);
      expect(decision.jointPolicy?.utilityOwner).toBe('phase7_evaluated');
      expect(
        decision.jointPolicy?.shadowUtility?.candidates.every(
          (c) => c.stackConservationError < 1e-8
        )
      ).toBe(true);
      expect(decision.jointPolicy?.applied).toBe(false);
      expect(decision.jointPolicy?.finalAction).toBe(decision.action);
    }
  );

  it("counts the acting player's already posted wager in effective depth", () => {
    const { hero, state, baseline } = jointPolicyFixture('flh', 1);
    hero.stack = 2000;
    hero.bet = 2;
    hero.totalInvested += 2;
    Object.assign(state.players[0], {
      stack: hero.stack,
      bet: hero.bet,
      totalInvested: hero.totalInvested,
    });
    state.players.slice(1).forEach((p) => (p.stack = 2002));
    state.currentBet = 2;
    state.pot += 2;
    const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
    expect(result.receipt.reason).toBe('depth_outside_domain');
  });

  it.each([
    ['flh', 1001],
    ['flo8', 1001],
    ['nlh', 251],
    ['plo4', 251],
  ] as const)('preserves the %s upper boundary at %dBB', (variant, depth) => {
    const { hero, state, baseline } = jointPolicyFixture(variant, 1);
    hero.stack = depth * state.bigBlind;
    state.players.forEach((p) => (p.stack = hero.stack));
    const result = evaluateJointLivePolicy(hero, state, baseline, 'shadow', () => 0);
    expect(result.receipt.reason).toBe('depth_outside_domain');
    expect(result.receipt.fired).toBe(false);
    expect(result.decision).toBe(baseline);
  });
});
