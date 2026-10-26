import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { seedFastRandom } from '../HorseEval.js';
import { jointPolicyFixture } from '../multiway/JointRangeFixture.test-support.js';
import { horseDecisionReceiptRefusal } from './responseValidation.js';

afterEach(() => HorseMind.reset());

describe('Omaha production decision receipt acceptance matrix', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const)
    for (const mode of ['cash', 'tournament'] as const)
      for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
        it(`${variant} ${mode} ${street}: every seeded decision binds the action it returns`, () => {
          for (let seed = 1; seed <= 8; seed++) {
            HorseMind.reset();
            const { hero, state } = jointPolicyFixture(variant, 1, mode, street);
            seedFastRandom(20261026 + seed);
            const decision = HorseLogic.decide(
              hero,
              state,
              'balanced',
              {},
              {
                mind: false,
                telemetry: false,
                decisionTimeMs: 0,
              }
            );
            expect(horseDecisionReceiptRefusal(decision, variant), `seed=${seed}`).toBeNull();
            expect(decision.policyGraph?.finalAction.action).toBe(decision.action);
            expect(decision.policyGraph?.finalAction.amount ?? undefined).toBe(decision.amount);
          }
        });
});
