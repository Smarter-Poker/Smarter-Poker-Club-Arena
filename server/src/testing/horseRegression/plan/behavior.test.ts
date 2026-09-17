import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import { requestAt } from './fixture.js';
beforeEach(() => HorseMind.reset());
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('current explicit unavailable and legacy plan context', () => {
  it.each([undefined, null])(
    'keeps actual legacy omission distinct from explicit unavailable=%s',
    (context) => {
      const request = requestAt(),
        spy = vi.spyOn(HorseMind, 'getPlan');
      seedFastRandom(901791);
      HorseLogic.decide(
        request.player,
        request.gameState,
        'balanced',
        {},
        { observeMind: false, telemetry: false, mindPlanContext: context }
      );
      expect(spy).toHaveBeenCalledWith(
        context === undefined ? HorseMind.handKeyOf(request.gameState.actionHistory) : null,
        request.player.user_id
      );
    }
  );
});
