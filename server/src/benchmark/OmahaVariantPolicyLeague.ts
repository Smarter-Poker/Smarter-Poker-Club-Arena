import {
  omahaVariantSeatCap,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { runOmahaPolicyLeague, type Plo4LeagueProfile } from './Plo4PolicyLeague.js';

export const OMAHA_VARIANT_LEAGUE_SEEDS = Object.freeze([11101101, 11102203, 11103307]);
/** Frozen before outcomes. Each variant includes its real cash/tournament maxima,
 * short and deep stacks, public opponent styles, rake, ante and straddle. */
export const OMAHA_VARIANT_LEAGUE_PROFILES: readonly Readonly<Plo4LeagueProfile>[] = Object.freeze(
  (['plo5', 'plo6', 'plo8'] as OmahaPolicyVariant[]).flatMap((variant) =>
    [
      {
        id: `${variant}-hu-25bb`,
        seats: 2,
        stackBB: 25,
        rakePercent: 5,
        rakeCapBB: 3,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'balanced' as const,
      },
      {
        id: `${variant}-cash-cap-100bb`,
        seats: omahaVariantSeatCap(variant, 'cash'),
        stackBB: 100,
        rakePercent: 10,
        rakeCapBB: 5,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'tag' as const,
      },
      {
        id: `${variant}-straddle-ante-100bb`,
        seats: 4,
        stackBB: 100,
        rakePercent: 10,
        rakeCapBB: 5,
        anteBB: 0.5,
        straddle: true,
        tournament: false,
        opponentStyle: 'lag' as const,
      },
      {
        id: `${variant}-tournament-cap-30bb`,
        seats: omahaVariantSeatCap(variant, 'tournament'),
        stackBB: 30,
        rakePercent: 0,
        rakeCapBB: 0,
        anteBB: 0.5,
        straddle: false,
        tournament: true,
        opponentStyle: 'balanced' as const,
      },
      {
        id: `${variant}-hu-3bb`,
        seats: 2,
        stackBB: 3,
        rakePercent: 5,
        rakeCapBB: 3,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'balanced' as const,
      },
      {
        id: `${variant}-deep-250bb`,
        seats: 3,
        stackBB: 250,
        rakePercent: 10,
        rakeCapBB: 5,
        anteBB: 1,
        straddle: false,
        tournament: false,
        opponentStyle: 'tag' as const,
      },
    ].map((p) => Object.freeze({ ...p, variant }))
  )
);
export function runOmahaVariantLeague(
  options: Parameters<typeof runOmahaPolicyLeague>[0],
  shouldContinue = () => true
) {
  return runOmahaPolicyLeague(options, shouldContinue, OMAHA_VARIANT_LEAGUE_PROFILES);
}
