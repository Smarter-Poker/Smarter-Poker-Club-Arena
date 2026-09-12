import {
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { runOmahaPolicyLeague, type Plo4LeagueProfile } from './Plo4PolicyLeague.js';

export const REMAINING_VARIANT_LEAGUE_SEEDS = Object.freeze([12101101, 12102203, 12103307]);
/** Frozen before outcomes. Cash includes legacy house caps and current six-seat
 * creator geometry. Pineapple tournaments are deliberately outside the registry. */
export const REMAINING_VARIANT_LEAGUE_PROFILES: readonly Readonly<Plo4LeagueProfile>[] =
  Object.freeze(
    (['short_deck', 'pineapple', 'flh', 'flo8'] as RemainingPolicyVariant[]).flatMap((variant) =>
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
          seats: remainingVariantSeatCap(variant, 'cash'),
          stackBB: 100,
          rakePercent: 10,
          rakeCapBB: 5,
          anteBB: 0,
          straddle: false,
          tournament: false,
          opponentStyle: 'tag' as const,
        },
        {
          id: `${variant}-six-seat-ante-100bb`,
          seats: 6,
          stackBB: 100,
          rakePercent: 10,
          rakeCapBB: 5,
          anteBB: 0.5,
          straddle: variant === 'short_deck' || variant === 'pineapple',
          tournament: false,
          opponentStyle: 'lag' as const,
        },
        ...(variant !== 'pineapple'
          ? [
              {
                id: `${variant}-tournament-cap-30bb`,
                seats: remainingVariantSeatCap(variant, 'tournament'),
                stackBB: 30,
                rakePercent: 0,
                rakeCapBB: 0,
                anteBB: 0.5,
                straddle: false,
                tournament: true,
                opponentStyle: 'balanced' as const,
              },
            ]
          : []),
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
export function runRemainingVariantLeague(
  options: Parameters<typeof runOmahaPolicyLeague>[0],
  shouldContinue = () => true
) {
  return runOmahaPolicyLeague(options, shouldContinue, REMAINING_VARIANT_LEAGUE_PROFILES);
}
