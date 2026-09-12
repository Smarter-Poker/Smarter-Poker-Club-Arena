import type { Card } from '../../types.js';

export const PLO4_POSITIONS = [
  'early',
  'middle',
  'cutoff',
  'button',
  'small_blind',
  'big_blind',
] as const;
export type Plo4Position = (typeof PLO4_POSITIONS)[number];
export const PLO4_PREFLOP_ROLES = [
  'rfi',
  'limp_option',
  'isolation',
  'defense',
  'three_bet',
  'four_bet',
  'five_bet_plus',
  'squeeze',
  'reshove',
  'overcall',
  'call_off',
] as const;
export const PLO4_POSTFLOP_ROLES = [
  'checked_to',
  'facing_bet',
  'facing_raise',
  'call_off',
] as const;
export type Plo4NodeRole =
  | (typeof PLO4_PREFLOP_ROLES)[number]
  | (typeof PLO4_POSTFLOP_ROLES)[number];

/** A deliberately labeled heuristic baseline pack. No solver distillation or
 * calibrated win probability is claimed by its hand-quality score. */
export const PLO4_POLICY_PACK = Object.freeze({
  version: 'plo4-policy-round1-v2',
  source: 'explicit_heuristic_baseline' as const,
  calibratedConfidence: null,
  defaultMode: 'shadow' as const,
  domain: Object.freeze({
    variant: 'plo4',
    minSeats: 2,
    maxSeats: 8,
    minStackBB: 0,
    maxStackBB: 250,
    maxAnteBB: 1,
    maxStraddleBB: 2,
    maxRakePercent: 10,
  }),
  openQuality: Object.freeze({
    early: 0.62,
    middle: 0.55,
    cutoff: 0.48,
    button: 0.42,
    small_blind: 0.54,
    big_blind: 0.5,
  }),
  callQuality: 0.57,
  threeBetQuality: 0.8,
  fourBetQuality: 0.9,
  fiveBetQuality: 0.96,
  liveBudgetMs: 4,
  maxSamples: 128,
  defaultSamples: 32,
  maxActionsPerHand: 128,
  maxPairs: 32,
});

export function plo4HandShape(cards: Card[]) {
  if (cards.length !== 4) throw new Error('PLO4 needs exactly four hole cards');
  if (
    cards.some(
      (c) =>
        !c ||
        c.rank.length !== 1 ||
        !'23456789TJQKA'.includes(c.rank) ||
        !['clubs', 'diamonds', 'hearts', 'spades'].includes(c.suit)
    ) ||
    new Set(cards.map((c) => `${c.rank}:${c.suit}`)).size !== 4
  )
    throw new Error('Invalid PLO4 cards');
  const ranks = cards.map((c) => '23456789TJQKA'.indexOf(c.rank) + 2);
  const distinct = [...new Set(ranks)].sort((a, b) => a - b);
  const suits = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
  const suitCounts = suits.map((s) => cards.filter((c) => c.suit === s).length);
  const pairs = distinct.filter((r) => ranks.filter((v) => v === r).length === 2);
  const duplicateWaste = distinct.some((r) => ranks.filter((v) => v === r).length >= 3);
  const nutSuits = suits.filter(
    (s) =>
      cards.some((c) => c.suit === s && c.rank === 'A') &&
      cards.filter((c) => c.suit === s).length >= 2
  );
  const lowAce = distinct.map((r) => (r === 14 ? 1 : r)).sort((a, b) => a - b);
  const connected =
    distinct.length === 4 && Math.min(distinct[3] - distinct[0], lowAce[3] - lowAce[0]) <= 4;
  const doubleSuited = suitCounts.filter((n) => n === 2).length === 2;
  const broadway = ranks.filter((r) => r >= 10).length;
  const pairedAces = pairs.includes(14);
  const quality = Math.max(
    0,
    Math.min(
      1,
      (pairedAces ? 0.56 : pairs.some((r) => r >= 12) ? 0.18 : 0) +
        nutSuits.length * 0.12 +
        (doubleSuited ? 0.15 : suitCounts.some((n) => n >= 2) ? 0.06 : 0) +
        (connected ? 0.32 : 0) +
        broadway * 0.05 +
        (pairs.length === 2 ? 0.12 : 0) -
        (duplicateWaste ? 0.25 : 0)
    )
  );
  return {
    pairedAces,
    pairs,
    nutSuits,
    connected,
    doubleSuited,
    broadway,
    duplicateWaste,
    quality,
  };
}

export const PLO4_CORE_DEPTHS = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 100, 150, 250,
] as const;
export function positionForOffset(offset: number, seats: number): Plo4Position {
  if (offset === 0) return 'button';
  if (seats === 2 || offset === 2) return 'big_blind';
  if (offset === 1) return 'small_blind';
  if (offset === seats - 1) return 'cutoff';
  return offset === 3 ? 'early' : 'middle';
}
/** Stream the actual numeric atlas so certification does not allocate a million rows. */
export function* plo4CertificationCoordinates() {
  for (const mode of ['cash', 'tournament'] as const)
    for (let seats = 2; seats <= 8; seats++)
      for (let heroOffset = 0; heroOffset < seats; heroOffset++)
        for (let aggressorOffset = 0; aggressorOffset < seats; aggressorOffset++)
          for (const depthBB of PLO4_CORE_DEPTHS)
            for (const role of PLO4_PREFLOP_ROLES)
              for (const anteBB of [0, 0.5, 1])
                for (const straddle of [false, true])
                  for (const rakePercent of mode === 'cash' ? [0, 5, 10] : [0])
                    yield {
                      mode,
                      seats,
                      heroOffset,
                      aggressorOffset,
                      depthBB,
                      role,
                      anteBB,
                      straddle,
                      rakePercent,
                      position: positionForOffset(heroOffset, seats),
                      aggressorPosition:
                        aggressorOffset === heroOffset
                          ? null
                          : positionForOffset(aggressorOffset, seats),
                    };
}
export function plo4CoverageMatrix() {
  return {
    version: PLO4_POLICY_PACK.version,
    mode: ['cash', 'tournament'],
    seats: [2, 3, 4, 5, 6, 7, 8],
    position: 'every dealer-relative hero seat and distinct aggressor seat or unopened',
    depthBB: PLO4_CORE_DEPTHS,
    anteBB: [0, 0.5, 1],
    straddleBB: [0, 2],
    rakePercent: [0, 5, 10],
    preflopRoles: PLO4_PREFLOP_ROLES,
    postflopRoles: PLO4_POSTFLOP_ROLES,
    streets: ['preflop', 'flop', 'turn', 'river'],
    preflopCoordinates: 203 * PLO4_CORE_DEPTHS.length * PLO4_PREFLOP_ROLES.length * 3 * 2 * 4,
    coreOwner: 'Plo4LivePolicy',
    tournamentUtilityOwner: 'HorseTournamentUtility',
    calibrated: false,
    boundaries: [
      'depth above 250BB',
      'multiboard/bomb-pot Phase13',
      'unknown canonical state or rake',
      'work budget',
    ],
  };
}
