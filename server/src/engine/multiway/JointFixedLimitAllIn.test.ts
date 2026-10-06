/**
 * Phase 13 loss diagnosis (October 6): a fixed-limit all-in is priced as the
 * action the controller executes.
 *
 * In fixed limit the real HandController advertises `all_in` whenever its
 * clamp turns the button into a legal wager, and performAction executes it
 * as a bet or raise to the street's fixed ceiling (clampToStructure). The
 * shared candidate builder still emits a `jam` there, with the whole stack as
 * its investment. The round-2 response tree (turn and river) prices that jam
 * through clampJointAllIn, the controller replica; the one-response model,
 * which prices every preflop and flop decision, committed the whole stack and
 * asked every opponent to call a 100 big blind shove into a few big blinds.
 * Almost nobody did, so the model credited the jam with the whole pot and
 * proposed it on most deep fixed-limit preflop and flop decisions, while the
 * table executed a one-unit bet or raise. On the development seeds this
 * mispriced jam was the first divergent decision in more than half of the
 * bomb-pot pairs.
 *
 * Law: on every natural fixed-limit spot where the controller would clamp the
 * all-in, the jam row is priced identically to the bet or raise to the
 * ceiling, under both response models.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HorseDecision } from '../../types.js';
import { seedFastRandom } from '../HorseEval.js';
import { controllerSpotRandom } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';
import { forEachJointControllerSpot } from './JointControllerSpots.test-support.js';

function pinDeckEntropy(seed: number) {
  const random = controllerSpotRandom(seed);
  vi.stubGlobal('crypto', {
    getRandomValues(target: Uint32Array) {
      for (let i = 0; i < target.length; i++) target[i] = Math.floor(random() * 0x100000000) >>> 0;
      return target;
    },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('Phase 13 prices a fixed-limit all-in as the wager the controller executes', () => {
  it.each(['flh', 'flo8'] as const)(
    '%s cash: a clamped jam equals the bet or raise to the ceiling on every street',
    (variant) => {
      pinDeckEntropy(0x13f10000 ^ variant.length);
      const checked: Record<string, number> = {};
      const mismatches: unknown[] = [];
      forEachJointControllerSpot(variant, 'cash', 40, 0x13f1 + variant.length, (spot) => {
        const s = spot.state;
        const hero = spot.hero;
        const legal = s.legalActions ?? [];
        const wager = legal.includes('raise') ? 'raise' : legal.includes('bet') ? 'bet' : null;
        if (
          s.bettingStructure !== 'fixed_limit' ||
          !legal.includes('all_in') ||
          !wager ||
          typeof s.maxRaiseTo !== 'number' ||
          hero.bet + hero.stack <= s.maxRaiseTo + 0.005
        )
          return;
        const baseline: HorseDecision = {
          action: legal.includes('check') ? 'check' : 'call',
          thinkTime: 0,
        };
        seedFastRandom(0x13f2);
        const { receipt } = evaluateJointLivePolicy(hero, s, baseline, 'shadow', () => 0);
        const rows = receipt.actionModel?.candidates;
        if (!rows) return;
        const jam = rows.find((r) => r.id === 'jam');
        const ceiling = rows.find((r) => r.action === wager && r.amount === s.maxRaiseTo);
        if (!jam || !ceiling) return;
        checked[s.stage] = (checked[s.stage] ?? 0) + 1;
        if (
          Math.abs(jam.expectedNetChips - ceiling.expectedNetChips) > 1e-9 ||
          Math.abs(jam.allFoldProbability - ceiling.allFoldProbability) > 1e-9
        )
          mismatches.push({
            stage: s.stage,
            model: receipt.responseModel,
            jam: [jam.expectedNetChips, jam.allFoldProbability],
            ceiling: [ceiling.id, ceiling.expectedNetChips, ceiling.allFoldProbability],
          });
      });
      expect(mismatches.slice(0, 3)).toEqual([]);
      expect(mismatches.length).toBe(0);
      // Both response models are exercised: preflop or flop (one response)
      // and turn or river (the bounded tree).
      expect((checked.preflop ?? 0) + (checked.flop ?? 0)).toBeGreaterThan(0);
      expect((checked.turn ?? 0) + (checked.river ?? 0)).toBeGreaterThan(0);
    },
    120_000
  );
});
