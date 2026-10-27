/** V24 development design, distinct from Phase 11 pack qualification and the
 * legacy unraked nightly mirror. Held-out matrix is deliberately not fixed
 * until the current-brain development pilot measures this exact contrast. */
import { getFullRakeConfig } from '../config/RakeConfig.js';
import type { FeatureAblationSpec } from './FeatureAblationLeague.js';
import type { Plo4AblationBrain, Plo4LeagueProfile } from './Plo4PolicyLeague.js';
export const PLO6_V24_DEVELOPMENT_DESIGN = Object.freeze({
  id: 'plo6-v24-published-cash-v1',
  state: 'development_pilot_required',
  candidate: { v24PloDefense: true },
  reference: { v24PloDefense: false },
  variant: 'plo6',
  stake: [1, 2],
  tableSeats: 6,
  productionStyles: true,
  profiles: [
    { id: 'plo6-v24-two-dealt-100bb', seats: 2, stackBB: 100 },
    { id: 'plo6-v24-four-dealt-100bb', seats: 4, stackBB: 100 },
    { id: 'plo6-v24-six-dealt-40bb', seats: 6, stackBB: 40 },
    { id: 'plo6-v24-six-dealt-100bb', seats: 6, stackBB: 100 },
    { id: 'plo6-v24-six-dealt-200bb', seats: 6, stackBB: 200 },
  ],
  developmentSeeds: [24304111, 24305213, 24306317],
  reservedHeldoutSeeds: [25304119, 25305233, 25306349],
  // Reservation is not permission to deal. Only a separately protected locked contract may do so.
  heldoutState: 'never_dealt_contract_merge_required',
  pilotPairsPerProfile: 576,
  promotionEligible: false,
} as const);
export function plo6V24DevelopmentProfile(id: string): Plo4LeagueProfile {
  const p = PLO6_V24_DEVELOPMENT_DESIGN.profiles.find((p) => p.id === id);
  if (!p) throw new Error('Unknown PLO6 V24 development profile');
  const full = getFullRakeConfig(1, 2, 'plo6');
  return {
    ...p,
    variant: 'plo6',
    tableSeats: 6,
    rakePercent: full.rakePercent,
    rakeCapBB: full.rakeCap / 2,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced',
    publishedRake: true,
    productionStyles: true,
    moodClock: 'deal_seed_time_of_day',
  };
}
export function plo6V24DevelopmentSpec(id: string, brain: Plo4AblationBrain): FeatureAblationSpec {
  return {
    id: PLO6_V24_DEVELOPMENT_DESIGN.id,
    profile: plo6V24DevelopmentProfile(id),
    brain,
    candidate: PLO6_V24_DEVELOPMENT_DESIGN.candidate,
    reference: PLO6_V24_DEVELOPMENT_DESIGN.reference,
  };
}
