import { describe, expect, it } from 'vitest';
import {
  INCREMENTAL_FLAGS,
  INCREMENTAL_RESERVED_HOLDOUT_SEEDS,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  buildIncrementalWarmRecords,
  incrementalWarmCoverage,
} from './IncrementalPressureDevelopment.js';
import {
  assertAblationArms,
  runFeatureAblationDevelopment,
  runFeatureAblationContract,
} from './FeatureAblationLeague.js';
import {
  createFeatureAblationWorker,
  type FeatureAblationWorkerReceipt,
} from './FeatureAblationWorker.js';
import {
  makeFeatureAblationOwnHistory,
  featureAblationPlayerId,
  FEATURE_ABLATION_HISTORY_AVAILABLE_AT_MS as AVAILABLE,
} from './FeatureAblationHistory.js';
import { ownPublicHistoryIsValid } from '../engine/horseDecision/ownPublicHistory.js';
import { horseObserverReadContextFromRequest } from '../engine/HorseObserverReadContext.js';
import type { Plo4AblationBrain } from './Plo4PolicyLeague.js';
const noDeal: Plo4AblationBrain = {
  id: 'never-dealt',
  decide() {
    throw Error('Unexpected deal');
  },
};
describe('incremental development boundaries', () => {
  it.each(Object.keys(INCREMENTAL_FLAGS) as (keyof typeof INCREMENTAL_FLAGS)[])(
    '%s uses exactly its one flag on current defaults and cannot claim a heldout plan',
    async (target) => {
      const profile = incrementalDevelopmentProfiles(target, 'nlh')[0];
      const spec = incrementalDevelopmentSpec(target, 'nlh', profile.id, noDeal);
      expect(spec.candidate).toEqual({ [INCREMENTAL_FLAGS[target]]: true });
      expect(spec.reference).toEqual({ [INCREMENTAL_FLAGS[target]]: false });
      expect(() => assertAblationArms(spec)).not.toThrow();
      await expect(
        runFeatureAblationContract(
          spec,
          { seed: 1, pairs: 1, startPair: 0, planDigest: 'x', cellKey: 'x' },
          () => {}
        )
      ).rejects.toThrow('no protected locked heldout plan');
      for (const seed of INCREMENTAL_RESERVED_HOLDOUT_SEEDS)
        await expect(runFeatureAblationDevelopment(spec, { seed, pairs: 1 })).rejects.toThrow(
          'held-out'
        );
    }
  );
  it.each(['nlh', 'plo4', 'plo5', 'plo6'] as const)(
    '%s produces genuine bounded public histories and measured river opportunities',
    (variant) => {
      for (const seats of [2, 4, 6]) {
        const records = buildIncrementalWarmRecords(variant, seats);
        expect(records).toHaveLength(48);
        const coverage = incrementalWarmCoverage(records);
        expect(Object.keys(coverage.byPlayer)).toHaveLength(seats);
        for (let seat = 1; seat <= seats; seat++) {
          const context = {
            version: 1 as const,
            observerId: featureAblationPlayerId(seat),
            variant,
            format: 'cash' as const,
            dealtCount: seats,
          };
          const packet = makeFeatureAblationOwnHistory(context, seat, records);
          expect(ownPublicHistoryIsValid(packet, context, AVAILABLE)).toBe(true);
          expect(JSON.stringify(packet)).not.toMatch(/cards|showdown|counters|donor|authority/);
          const row = coverage.byPlayer[context.observerId];
          expect(row.opportunities).toBeGreaterThan(0);
          expect(row.bets).toBeLessThanOrEqual(row.opportunities);
          if (seats === 2) {
            expect(row.opportunities).toBeGreaterThanOrEqual(11);
            expect(row.lower99).toBeGreaterThanOrEqual(0.65);
          }
        }
      }
    }
  );
  it('the actual worker receives all three treatments and preserves default V53; paired controller accepts legal complete hands', async () => {
    for (const target of Object.keys(INCREMENTAL_FLAGS) as (keyof typeof INCREMENTAL_FLAGS)[]) {
      const receipts: FeatureAblationWorkerReceipt[] = [];
      const records = buildIncrementalWarmRecords('nlh', 2);
      const brain = createFeatureAblationWorker(
        (r) => receipts.push(r),
        () => {},
        true,
        (r) => {
          const c = horseObserverReadContextFromRequest(r);
          if (!c) throw Error('Missing original context');
          return makeFeatureAblationOwnHistory(c, r.player.seat, records);
        }
      );
      const profile = incrementalDevelopmentProfiles(target, 'nlh')[0];
      const result = await runFeatureAblationDevelopment(
        incrementalDevelopmentSpec(target, 'nlh', profile.id, brain),
        { seed: 27301101, pairs: 1 }
      );
      expect(result.complete, result.refusalReason ?? '').toBe(true);
      for (const key of [
        'protocolErrors',
        'brainExceptions',
        'illegalActions',
        'conservationErrors',
        'cardErrors',
        'truncatedHands',
        'settlementMismatches',
        'deductionMismatches',
        'pairedReplayMismatches',
      ] as const)
        expect(result[key], key).toBe(0);
      const flag = INCREMENTAL_FLAGS[target];
      expect(receipts.some((r) => r.inputFlags[flag] === true)).toBe(true);
      expect(receipts.some((r) => r.inputFlags[flag] === false)).toBe(true);
      expect(receipts.every((r) => r.inputFlags.v53Pressure === undefined)).toBe(true);
      expect(receipts.every((r) => r.observerReads?.history === 'own_public_window')).toBe(true);
      expect(result.promotionEligible).toBe(false);
    }
  }, 60000);
});
