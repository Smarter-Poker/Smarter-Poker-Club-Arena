/** V53 pre-holdout development design. This is deliberately NOT a qualification
 * manifest: the matrix can be locked only after current-worker coverage and a
 * dispersion-only pilot, then protected merge. No API here deals holdouts. */
import type { FeatureAblationSpec } from './FeatureAblationLeague.js';
import type { Plo4AblationBrain, Plo4LeagueProfile } from './Plo4PolicyLeague.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import { V53_PRESSURE_POPULATION, V53_PRESSURE_VARIANTS } from './V53PressurePopulation.js';

export type PressureQualificationVariant = (typeof V53_PRESSURE_VARIANTS)[number];
export const V53_PRESSURE_WARM_SEED = 24307777;
export const V53_PRESSURE_DEVELOPMENT_SEEDS = Object.freeze([24301101, 24302203, 24303307]);
/** Reserved now, never dealt by development/tests. Final protected contract
 * must retain these exact seeds or record a new untouched reservation before
 * any qualification run. Reservation is not authority to deal them. */
export const V53_PRESSURE_RESERVED_HOLDOUT_SEEDS = Object.freeze([25301109, 25302231, 25303347]);
const SHAPES = Object.freeze([
  { seats: 2, stackBB: 100 },
  { seats: 4, stackBB: 100 },
  { seats: 6, stackBB: 40 },
  { seats: 6, stackBB: 100 },
  { seats: 6, stackBB: 200 },
]);
export const V53_PRESSURE_DEVELOPMENT_DESIGN = Object.freeze({
  version: 'v53-pressure-development-design-v1',
  population: V53_PRESSURE_POPULATION.id,
  state: 'awaiting_current_worker_coverage_and_dispersion_pilot',
  promotionEligible: false,
  variants: V53_PRESSURE_VARIANTS,
  coveragePairsPerVariant: 36,
  maximumCoveragePairsPerVariant: 576,
  coverageRule:
    'A zero finite probe is insufficient coverage, not structural inert proof; extend within the fixed 576-pair development budget or use a declared full-tier eligible fixture before variance sizing',
  requiredCoverageEvidence: Object.freeze([
    'admitted_base',
    'opportunity_denominator_not_measured',
    'pressure_proposals',
    'accepted_final_action_contrasts',
  ]),
  warmPublicHands: 48,
  warmPublicSeed: V53_PRESSURE_WARM_SEED,
  warmPublicAvailableAtMs: Date.UTC(2026, 9, 25, 23),
  pilotPairsPerProfile: 576,
  rotationBlock: 576,
  developmentSeeds: V53_PRESSURE_DEVELOPMENT_SEEDS,
  reservedHoldoutSeeds: V53_PRESSURE_RESERVED_HOLDOUT_SEEDS,
  interval: Object.freeze({ ...PLO4_STRENGTH_CONTRACT.interval }),
  thresholds: Object.freeze({
    primaryLowerBoundAboveBb100: 0,
    eachSeedPointEstimateAboveBb100: 0,
    everyCriticalCellLowerBoundAtLeastBb100: -10,
    planningSdFactor: 1.2,
    plannedHalfWidthMaxBb100: 8.5,
  }),
  criticalCells: Object.freeze(['profile', 'relative_position', 'depth']),
  excluded: Object.freeze([
    'tournament',
    'antes',
    'straddles',
    'bomb_multiboard',
    'other_stakes',
    'absolute_human_market_profitability',
  ]),
});

export function pressureDevelopmentProfiles(
  variant: PressureQualificationVariant
): readonly Readonly<Plo4LeagueProfile>[] {
  if (!V53_PRESSURE_VARIANTS.includes(variant)) throw new Error('Unsupported pressure variant');
  const published = getFullRakeConfig(1, 2, variant);
  return SHAPES.map(({ seats, stackBB }) =>
    Object.freeze({
      id: `v53-${variant}-6max-${seats}dealt-${stackBB}bb`,
      variant,
      tableSeats: 6,
      seats,
      stackBB,
      publishedRake: true,
      productionStyles: true,
      moodClock: 'deal_seed_time_of_day' as const,
      rakePercent: published.rakePercent,
      rakeCapBB: published.rakeCap / 2,
      anteBB: 0,
      straddle: false,
      tournament: false,
      opponentStyle: 'balanced' as const,
    })
  );
}

export function pressureDevelopmentSpec(
  variant: PressureQualificationVariant,
  profileId: string,
  brain: Plo4AblationBrain
): FeatureAblationSpec {
  const profile = pressureDevelopmentProfiles(variant).find((p) => p.id === profileId);
  if (!profile) throw new Error(`Undeclared pressure profile ${profileId}`);
  if (!brain.id) throw new Error('Pressure evidence requires an identified current-worker brain');
  return {
    id: `v53-pressure-${variant}-development-v1`,
    profile,
    brain,
    candidate: { v53Pressure: true },
    reference: { v53Pressure: false },
    population: V53_PRESSURE_POPULATION,
  };
}
