import { describe, expect, it } from 'vitest';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import {
  pressureDevelopmentProfiles,
  pressureDevelopmentSpec,
  V53_PRESSURE_DEVELOPMENT_DESIGN as D,
} from './PressureQualificationContract.js';
import { V53_PRESSURE_VARIANTS } from './V53PressurePopulation.js';

describe('the pressure development design cannot imply qualification', () => {
  it('reserves untouched seeds without offering a heldout runner', () => {
    expect(D.promotionEligible).toBe(false);
    expect(D.state).toBe('awaiting_current_worker_coverage_and_dispersion_pilot');
    expect(new Set([D.warmPublicSeed, ...D.developmentSeeds, ...D.reservedHoldoutSeeds]).size).toBe(
      7
    );
    expect(D.warmPublicSeed).toBe(24307777);
    expect(D.maximumCoveragePairsPerVariant).toBe(576);
    expect(D.requiredCoverageEvidence).toContain('accepted_final_action_contrasts');
    expect(D.pilotPairsPerProfile % D.rotationBlock).toBe(0);
  });
  it('retains the existing 99% interval/trust and nonregression standard', () => {
    expect(D.interval).toEqual(PLO4_STRENGTH_CONTRACT.interval);
    expect(D.thresholds).toMatchObject({
      primaryLowerBoundAboveBb100: 0,
      eachSeedPointEstimateAboveBb100: 0,
      everyCriticalCellLowerBoundAtLeastBb100: -10,
      planningSdFactor: 1.2,
      plannedHalfWidthMaxBb100: 8.5,
    });
  });
  it.each(V53_PRESSURE_VARIANTS)(
    '%s declares exact published cash pricing and position rotations',
    (variant) => {
      const profiles = pressureDevelopmentProfiles(variant);
      const published = getFullRakeConfig(1, 2, variant);
      expect(profiles).toHaveLength(5);
      for (const p of profiles) {
        expect(D.rotationBlock % (p.seats * p.seats)).toBe(0);
        expect(p.rakePercent).toBeGreaterThan(0);
        expect(p.rakeCapBB).toBeGreaterThan(0);
        expect(p).toMatchObject({
          publishedRake: true,
          tableSeats: 6,
          rakePercent: published.rakePercent,
          rakeCapBB: published.rakeCap / 2,
          anteBB: 0,
          straddle: false,
          tournament: false,
        });
      }
    }
  );
  it('changes only the hero pressure flag while preserving the identified brain and population', () => {
    const brain = {
      id: 'current-worker-source-and-admission-fixture',
      decide: async () => ({ action: 'fold' as const, thinkTime: 0 }),
    };
    const profile = pressureDevelopmentProfiles('plo5')[3];
    const spec = pressureDevelopmentSpec('plo5', profile.id, brain);
    expect(spec.brain).toBe(brain);
    expect(spec.candidate).toEqual({ v53Pressure: true });
    expect(spec.reference).toEqual({ v53Pressure: false });
    expect(spec.population?.id).toBe('v53_pressure_stress_v1');
    expect(() => pressureDevelopmentSpec('plo5', 'unregistered', brain)).toThrow(/Undeclared/);
  });
});
