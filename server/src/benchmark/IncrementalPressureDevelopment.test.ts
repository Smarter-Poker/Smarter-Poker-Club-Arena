import { describe, expect, it } from 'vitest';
import {
  INCREMENTAL_FLAGS,
  PRESSURE_PACKAGE_FLAGS,
  ADDITIONAL_RESERVED_HOLDOUT_SEEDS,
  incrementalDevelopmentDesign,
  INCREMENTAL_CHECKRAISE_POPULATION,
  INCREMENTAL_RESERVED_HOLDOUT_SEEDS,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  buildIncrementalWarmRecords,
  incrementalWarmCoverage,
} from './IncrementalPressureDevelopment.js';
import {
  assertAblationArms,
  assertDevelopmentAblationArms,
  runFeatureAblationDevelopment,
  runFeatureAblationContract,
} from './FeatureAblationLeague.js';
import {
  createFeatureAblationWorker,
  type FeatureAblationWorkerReceipt,
} from './FeatureAblationWorker.js';
import {
  makeFeatureAblationOwnHistory,
  buildFeatureWarmRecords,
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
      ).rejects.toThrow('plan refused');
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
  it.each(['nlh', 'plo4', 'plo5', 'plo6'] as const)(
    '%s exact check-raise response workload is learned from real legal hands',
    (variant) => {
      const records = buildIncrementalWarmRecords(variant, 2, 'river_bluff_checkraise');
      const coverage = incrementalWarmCoverage(records);
      expect(Object.keys(coverage.checkRaiseResponsesByPlayer)).toHaveLength(2);
      for (let seat = 1; seat <= 2; seat++) {
        const id = featureAblationPlayerId(seat);
        const context = {
          version: 1 as const,
          observerId: id,
          variant,
          format: 'cash' as const,
          dealtCount: 2,
        };
        expect(
          ownPublicHistoryIsValid(
            makeFeatureAblationOwnHistory(context, seat, records),
            context,
            AVAILABLE
          )
        ).toBe(true);
        const row = coverage.checkRaiseResponsesByPlayer[id];
        expect(row.opportunities).toBeGreaterThanOrEqual(8);
        expect(row.folds).toBeLessThanOrEqual(row.opportunities);
        expect(coverage.byPlayer[id].lower99).toBeGreaterThanOrEqual(0.65);
      }
      // The fixed stochastic workload can yield all folds; that is recorded, never reseeded.
    }
  );
  it('actual physical calls stay in the check-raise denominator', () => {
    const records = buildFeatureWarmRecords({
      variant: 'nlh',
      seats: 2,
      seed: 27307777,
      hands: 12,
      historyVersion: 'call-response-negative-control-v1',
      population: {
        id: 'call-response-negative-control-v1',
        decide(player, gs, rng) {
          const river = (gs.actionHistory ?? []).filter((a) => a.stage === 'river');
          if (
            gs.stage === 'river' &&
            river.length === 3 &&
            river[2].action === 'raise' &&
            gs.legalActions?.includes('call')
          )
            return { action: 'call', thinkTime: 0 };
          return INCREMENTAL_CHECKRAISE_POPULATION.decide(player, gs, rng);
        },
      },
    });
    const response = incrementalWarmCoverage(records).checkRaiseResponsesByPlayer;
    expect(Object.values(response).reduce((n, r) => n + r.opportunities, 0)).toBeGreaterThan(0);
    expect(Object.values(response).every((r) => r.folds === 0)).toBe(true);
  });
  it('the actual worker receives all five individual treatments and preserves default V53; paired controller accepts legal complete hands', async () => {
    for (const target of Object.keys(INCREMENTAL_FLAGS) as (keyof typeof INCREMENTAL_FLAGS)[]) {
      const receipts: FeatureAblationWorkerReceipt[] = [];
      const records = buildIncrementalWarmRecords('nlh', 2, target);
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

describe('exact five-flag development composition', () => {
  const make = () => {
    const p = incrementalDevelopmentProfiles('pressure_package', 'nlh')[0];
    return incrementalDevelopmentSpec('pressure_package', 'nlh', p.id, noDeal);
  };
  it('admits only the named exact tuple in development, never the locked contract', async () => {
    const spec = make();
    expect(() => assertDevelopmentAblationArms(spec)).not.toThrow();
    expect(() => assertAblationArms(spec)).toThrow('exactly one');
    await expect(
      runFeatureAblationContract(
        spec,
        { seed: 27401101, pairs: 1, startPair: 0, planDigest: 'x', cellKey: 'x' },
        () => {}
      )
    ).rejects.toThrow('plan refused');
    for (const seed of ADDITIONAL_RESERVED_HOLDOUT_SEEDS)
      await expect(runFeatureAblationDevelopment(spec, { seed, pairs: 1 })).rejects.toThrow(
        'held-out'
      );
    for (const flag of PRESSURE_PACKAGE_FLAGS) {
      const candidate = { ...spec.candidate };
      delete candidate[flag];
      expect(() => assertDevelopmentAblationArms({ ...spec, candidate })).toThrow('exact');
    }
    expect(() =>
      assertDevelopmentAblationArms({
        ...spec,
        candidate: { ...spec.candidate, v53Pressure: true },
      })
    ).toThrow('exact');
    expect(() =>
      assertDevelopmentAblationArms({
        ...spec,
        candidate: spec.reference,
        reference: spec.candidate,
      })
    ).toThrow('exact');
    expect(() => assertDevelopmentAblationArms({ ...spec, id: 'arbitrary' })).toThrow(
      'exactly one'
    );
    expect(() => assertDevelopmentAblationArms({ ...spec, population: undefined })).toThrow(
      'exact'
    );
    expect(incrementalDevelopmentDesign('pressure_package').developmentSeeds).toContain(27401101);
    expect(incrementalDevelopmentDesign('combo_draw_pressure').population).toBe(
      'incremental_public_overstab_stress_v1'
    );
    expect(incrementalDevelopmentDesign('barrel_continuation_outlook').population).toBe(
      'barrel_continuation_overstab_stress_v1'
    );
  });
  it('the actual worker and controller receive both complete package arms', async () => {
    const receipts: FeatureAblationWorkerReceipt[] = [];
    const records = buildIncrementalWarmRecords('nlh', 2, 'pressure_package');
    const brain = createFeatureAblationWorker(
      (r) => receipts.push(r),
      () => {},
      true,
      (r) => {
        const c = horseObserverReadContextFromRequest(r);
        if (!c) throw Error('Missing context');
        return makeFeatureAblationOwnHistory(c, r.player.seat, records);
      }
    );
    const spec = { ...make(), brain };
    const result = await runFeatureAblationDevelopment(spec, { seed: 27401101, pairs: 1 });
    expect(result.complete, result.refusalReason ?? '').toBe(true);
    expect(
      result.illegalActions +
        result.conservationErrors +
        result.cardErrors +
        result.protocolErrors +
        result.brainExceptions +
        result.settlementMismatches +
        result.deductionMismatches +
        result.pairedReplayMismatches +
        result.truncatedHands
    ).toBe(0);
    for (const value of [true, false])
      expect(
        receipts.some((r) => PRESSURE_PACKAGE_FLAGS.every((flag) => r.inputFlags[flag] === value))
      ).toBe(true);
  });
});
