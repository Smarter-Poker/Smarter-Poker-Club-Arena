import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isSeparateRiverTarget,
  SEPARATE_RIVER_DESIGNS,
  assertSeparateRiverSeedSeparation,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  buildIncrementalWarmRecords,
  PRESSURE_PACKAGE_FLAGS,
} from './IncrementalPressureDevelopment.js';
import {
  assertAblationArms,
  runFeatureAblationContract,
  runFeatureAblationDevelopment,
} from './FeatureAblationLeague.js';
import {
  incrementalComponentCoverage,
  incrementalSeedFamily,
} from './IncrementalPressureQualification.js';
import {
  multiwayRiverIncrements,
  multiwayRiverPressure,
} from '../engine/HorseMultiwayRiverRead.js';
import {
  makeFeatureAblationOwnHistory,
  featureAblationPlayerId,
} from './FeatureAblationHistory.js';
const brain = {
  id: 'no-deal',
  decide() {
    throw Error('Unexpected deal');
  },
};
describe('separate river targets', () => {
  it('preserves the five-flag package and refuses every unregistered contract before dealing', async () => {
    expect(PRESSURE_PACKAGE_FLAGS).toHaveLength(5);
    expect(assertSeparateRiverSeedSeparation).not.toThrow();
    for (const target of Object.keys(SEPARATE_RIVER_DESIGNS)) {
      if (!isSeparateRiverTarget(target)) throw Error('target');
      const p = incrementalDevelopmentProfiles(target, 'plo5')[0];
      const s = incrementalDevelopmentSpec(target, 'plo5', p.id, brain);
      expect(() => assertAblationArms(s)).not.toThrow();
      await expect(
        runFeatureAblationContract(
          s,
          { seed: 1, pairs: 1, startPair: 0, planDigest: 'x', cellKey: 'x' },
          () => {}
        )
      ).rejects.toThrow('plan refused');
      for (const seed of SEPARATE_RIVER_DESIGNS[target].reservedHoldoutSeeds)
        await expect(runFeatureAblationDevelopment(s, { seed, pairs: 1 })).rejects.toThrow(
          'held-out'
        );
      expect(incrementalComponentCoverage(target, p.seats)).toEqual([
        {
          component: target,
          applicable: true,
          counter:
            target === 'small_pot_near_nut_value_raise'
              ? 'small_pot_near_nut_value_raise_accepted'
              : 'multiway_river_bluff_checkraise_accepted',
        },
      ]);
    }
    expect(incrementalSeedFamily('small_pot_near_nut_value_raise')).toBe('287');
    expect(incrementalSeedFamily('multiway_river_bluff_checkraise')).toBe('288');
    for (const file of [
      'SeparateRiverQualificationPlans.json',
      'SeparateRiverQualificationFamilies.json',
    ])
      expect(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))).toEqual({});
  });
  it('holds the original checkraise owner on in both multiway arms and rejects a widened contrast', () => {
    const p = incrementalDevelopmentProfiles('multiway_river_bluff_checkraise', 'plo5')[0];
    const s = incrementalDevelopmentSpec('multiway_river_bluff_checkraise', 'plo5', p.id, brain);
    expect(s.candidate).toEqual({ riverBluffCheckRaise: true, multiwayRiverBluffCheckRaise: true });
    expect(s.reference).toEqual({
      riverBluffCheckRaise: true,
      multiwayRiverBluffCheckRaise: false,
    });
    expect(() =>
      assertAblationArms({
        ...s,
        reference: { riverBluffCheckRaise: false, multiwayRiverBluffCheckRaise: false },
      })
    ).toThrow('composition');
    expect(() => incrementalDevelopmentProfiles('small_pot_near_nut_value_raise', 'nlh')).toThrow(
      'Omaha'
    );
  });
  it.each([4, 6])(
    'carries real original %s-seat controller nodes into observer warm packets',
    (seats) => {
      const records = buildIncrementalWarmRecords('plo5', seats, 'multiway_river_bluff_checkraise');
      const responses = records
        .map((h) => multiwayRiverIncrements(h.actions, h.playersDealt))
        .filter(Boolean);
      const pressure = records
        .map((h) => multiwayRiverPressure(h.actions, h.playersDealt))
        .filter(Boolean);
      expect(records).toHaveLength(48);
      expect(responses.length).toBeGreaterThan(0);
      expect(pressure.length).toBeGreaterThan(responses.length);
      expect(
        records.some(
          (h) =>
            h.actions
              .filter((a) => a.stage === 'river')
              .map((a) => a.action)
              .join(',') === 'check,check'
        )
      ).toBe(true);
      expect(records.some((h) => h.actions.some((a) => a.publicNode))).toBe(true);
      const context = {
        version: 1,
        observerId: featureAblationPlayerId(1),
        variant: 'plo5',
        format: 'cash',
        dealtCount: seats,
      } as any;
      const packet = makeFeatureAblationOwnHistory(context, 1, records);
      expect(packet).toBeTruthy();
      expect(JSON.stringify(records)).not.toContain('cards');
    }
  );
});

it.each(['small_pot_near_nut_value_raise', 'multiway_river_bluff_checkraise'] as const)(
  'executes one declared %s pair through actual worker and controller',
  async (target) => {
    const { createFeatureAblationWorker } = await import('./FeatureAblationWorker.js');
    const { horseObserverReadContextFromRequest } =
      await import('../engine/HorseObserverReadContext.js');
    const profile = incrementalDevelopmentProfiles(target, 'plo5')[0];
    const warm = buildIncrementalWarmRecords('plo5', profile.seats, target);
    const receipts: import('./FeatureAblationWorker.js').FeatureAblationWorkerReceipt[] = [];
    const worker = createFeatureAblationWorker(
      (r) => receipts.push(r),
      () => {},
      true,
      (request) => {
        const context = horseObserverReadContextFromRequest(request);
        if (!context) throw Error('Missing observer context');
        return makeFeatureAblationOwnHistory(context, request.player.seat, warm);
      }
    );
    const spec = incrementalDevelopmentSpec(target, 'plo5', profile.id, worker);
    const result = await runFeatureAblationDevelopment(spec, {
      seed: SEPARATE_RIVER_DESIGNS[target].developmentSeeds[0],
      pairs: 1,
    });
    console.info(
      'SEPARATE_RIVER_DEVELOPMENT_RECEIPT ' +
        JSON.stringify({
          target,
          profile: profile.id,
          seed: SEPARATE_RIVER_DESIGNS[target].developmentSeeds[0],
          firstPair: 0,
          pairs: result.pairs,
          complete: result.complete,
          changedPairs: result.changedPairs,
          acceptedContrastPairs: result.candidateHeroActionContrastPairs,
          candidateComponents: result.candidateEvaluationFires.hero,
          referenceComponents: result.referenceEvaluationFires.hero,
          pairDigest: result.pairDigest,
          protocolErrors: result.protocolErrors,
          illegalActions: result.illegalActions,
          conservationErrors: result.conservationErrors,
          promotionEligible: false,
        })
    );
    expect(result.complete).toBe(true);
    expect(result.pairs).toBe(1);
    expect(result.protocolErrors).toBe(0);
    expect(result.illegalActions).toBe(0);
    expect(result.conservationErrors).toBe(0);
    expect(result.promotionEligible).toBe(false);
    const canon = (x: object) =>
      JSON.stringify(
        Object.entries(x)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
      );
    expect(receipts.some((r) => canon(r.inputFlags) === canon(spec.candidate))).toBe(true);
    expect(receipts.some((r) => canon(r.inputFlags) === canon(spec.reference))).toBe(true);
  },
  60000
);
