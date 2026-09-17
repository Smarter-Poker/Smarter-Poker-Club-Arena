import { KNOWN_VARIANTS, horseVariantRulesFor, maxSeatsFor } from '../engine/VariantRules.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import { runOmahaPolicyLeague, type Plo4LeagueProfile } from './Plo4PolicyLeague.js';
import type { GameVariant } from '../types.js';

export const JOINT_LEAGUE_SEEDS = Object.freeze([13101101, 13102203, 13103307]);
/** Frozen before outcomes. Every relative position, all enabled variants,
 * ordinary multiway and every independent bomb-board count, plus the physical
 * multi-board cap and both settlement units. No post-result seed selection. */
export const JOINT_LEAGUE_PROFILES: readonly Readonly<Plo4LeagueProfile>[] = Object.freeze([
  ...(KNOWN_VARIANTS as readonly GameVariant[]).flatMap(
    (variant): Readonly<Plo4LeagueProfile>[] => {
      const rules = horseVariantRulesFor(variant);
      const cap = (boards: number, tournament = false) =>
        Math.min(
          tournament ? Math.min(10, maxSeatsFor(variant)) : maxSeatsForVariant(variant),
          Math.floor((rules.deckSize - boards * 5) / rules.holeCardsDealt)
        );
      const base = {
        variant,
        jointPolicy: true,
        rakePercent: 10,
        rakeCapBB: 3,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'balanced' as const,
      };
      return [
        { ...base, id: variant + '-ordinary-short', seats: 3, stackBB: 3, rakePercent: 5 },
        {
          ...base,
          id: variant + '-ordinary-cap',
          seats: cap(1),
          stackBB: 100,
          anteBB: 0.5,
          straddle: !['flh', 'flo8'].includes(variant),
          opponentStyle: 'lag' as const,
        },
        {
          ...base,
          id: variant + '-bomb1-deep',
          seats: 3,
          stackBB: 250,
          bombBoards: 1 as const,
          bbj: true,
          opponentStyle: 'tag' as const,
        },
        { ...base, id: variant + '-bomb2-cap', seats: cap(2), stackBB: 25, bombBoards: 2 as const },
        { ...base, id: variant + '-bomb3-cap', seats: cap(3), stackBB: 25, bombBoards: 3 as const },
        ...(variant === 'flh' || variant === 'flo8'
          ? [
              {
                ...base,
                id: variant + '-legacy-fixed-1000bb',
                seats: 6,
                stackBB: 1000,
                opponentStyle: 'tag' as const,
              },
            ]
          : []),
        ...(variant === 'pineapple'
          ? []
          : [
              {
                ...base,
                id: variant + '-tournament-bomb2',
                seats: cap(2, true),
                stackBB: 30,
                rakePercent: 0,
                rakeCapBB: 0,
                bombBoards: 2 as const,
                tournament: true,
              },
            ]),
      ].map((r) => Object.freeze(r));
    }
  ),
  ...[
    Object.freeze({
      variant: 'nlh' as const,
      jointPolicy: true,
      id: 'nlh-diamond-bomb3',
      seats: 6,
      stackBB: 25,
      rakePercent: 0,
      rakeCapBB: 0,
      anteBB: 0,
      straddle: false,
      tournament: false,
      opponentStyle: 'balanced' as const,
      bombBoards: 3 as const,
      asset: 'diamonds' as const,
    }),
    Object.freeze({
      variant: 'plo6' as const,
      jointPolicy: true,
      id: 'plo6-hu-bomb3',
      seats: 2,
      stackBB: 25,
      rakePercent: 10,
      rakeCapBB: 3,
      anteBB: 0,
      straddle: false,
      tournament: false,
      opponentStyle: 'tag' as const,
      bombBoards: 3 as const,
    }),
  ],
]);
export function runJointPolicyLeague(
  options: Parameters<typeof runOmahaPolicyLeague>[0],
  shouldContinue = () => true
) {
  return runOmahaPolicyLeague(options, shouldContinue, JOINT_LEAGUE_PROFILES);
}
