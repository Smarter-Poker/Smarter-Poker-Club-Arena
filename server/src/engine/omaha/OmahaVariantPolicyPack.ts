import type { Card } from '../../types.js';
import type { Plo4NodeRole, Plo4Position } from '../plo4/Plo4PolicyPack.js';
import { maxSeatsFor } from '../VariantRules.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';

export type OmahaPolicyVariant = 'plo5' | 'plo6' | 'plo8';
export type OmahaPolicyPosition = Plo4Position;
export type OmahaPolicyRole = Plo4NodeRole;

/** Separate heuristic models, not percentile tables or solver probabilities.
 * Only seat/action geometry is shared with Phase 10. Entry scores and bars
 * belong to the variant with which they were calculated. */
export const OMAHA_VARIANT_PACKS = Object.freeze({
  plo5: Object.freeze({
    version: 'plo5-high-round1-v2',
    variant: 'plo5' as const,
    holes: 5,
    splitPot: false,
    open: Object.freeze({
      early: 0.61,
      middle: 0.56,
      cutoff: 0.5,
      button: 0.45,
      small_blind: 0.55,
      big_blind: 0.51,
    }),
    call: 0.54,
    raise: 0.78,
    callOff: 0.59,
    deepAdjustment: 0.07,
    multiwayAdjustment: 0.018,
    raiseFacingAdjustment: 0.055,
    valueEquity: 0.63,
    protectionEquity: 0.56,
  }),
  plo6: Object.freeze({
    version: 'plo6-high-round1-v2',
    variant: 'plo6' as const,
    holes: 6,
    splitPot: false,
    open: Object.freeze({
      early: 0.64,
      middle: 0.6,
      cutoff: 0.55,
      button: 0.49,
      small_blind: 0.59,
      big_blind: 0.55,
    }),
    call: 0.58,
    raise: 0.83,
    callOff: 0.64,
    deepAdjustment: 0.085,
    multiwayAdjustment: 0.024,
    raiseFacingAdjustment: 0.065,
    valueEquity: 0.66,
    protectionEquity: 0.59,
  }),
  plo8: Object.freeze({
    version: 'plo8-split-round1-v2',
    variant: 'plo8' as const,
    holes: 4,
    splitPot: true,
    open: Object.freeze({
      early: 0.6,
      middle: 0.55,
      cutoff: 0.49,
      button: 0.43,
      small_blind: 0.52,
      big_blind: 0.47,
    }),
    call: 0.5,
    raise: 0.76,
    callOff: 0.61,
    deepAdjustment: 0.055,
    multiwayAdjustment: 0.014,
    raiseFacingAdjustment: 0.045,
    valueEquity: 0.64,
    protectionEquity: 0.55,
  }),
});

export const OMAHA_VARIANT_DOMAIN = Object.freeze({
  source: 'explicit_variant_heuristic' as const,
  calibratedConfidence: null,
  defaultMode: 'shadow' as const,
  minSeats: 2,
  maxStackBB: 250,
  maxAnteBB: 1,
  maxStraddleBB: 2,
  maxRakePercent: 10,
  liveBudgetMs: 4,
  maxSamples: 128,
  defaultSamples: 32,
  maxActionsPerHand: 128,
  maxPairs: 32,
});

export function isOmahaPolicyVariant(value: unknown): value is OmahaPolicyVariant {
  return value === 'plo5' || value === 'plo6' || value === 'plo8';
}

/** TournamentManagerBase uses its configured 2..10 table size capped by the
 * physical single-board deck. Cash reserves the room required by its house
 * rules. Import both actual owners rather than copying either ceiling. */
export function omahaVariantSeatCap(variant: OmahaPolicyVariant, mode: 'cash' | 'tournament') {
  return mode === 'cash' ? maxSeatsForVariant(variant) : Math.min(10, maxSeatsFor(variant));
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
const ranks = '23456789TJQKA';

export function omahaVariantHandShape(variant: OmahaPolicyVariant, cards: Card[]) {
  const pack = OMAHA_VARIANT_PACKS[variant];
  if (
    !pack ||
    cards.length !== pack.holes ||
    cards.some(
      (c) => !c || c.rank.length !== 1 || !ranks.includes(c.rank) || !suits.includes(c.suit)
    ) ||
    new Set(cards.map((c) => `${c.rank}:${c.suit}`)).size !== cards.length
  )
    throw new Error('Cards do not match the Omaha variant pack');
  const values = cards.map((c) => ranks.indexOf(c.rank) + 2);
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  const lowRanks = [...new Set(values.map((v) => (v === 14 ? 1 : v)).filter((v) => v <= 8))].sort(
    (a, b) => a - b
  );
  const pairs = distinct.filter((v) => values.filter((n) => n === v).length === 2);
  const tripleRanks = distinct.filter((v) => values.filter((n) => n === v).length >= 3);
  const nutSuits = suits.filter(
    (s) =>
      cards.some((c) => c.suit === s && c.rank === 'A') &&
      cards.filter((c) => c.suit === s).length >= 2
  );
  const suitedPairs = suits.filter((s) => cards.filter((c) => c.suit === s).length >= 2).length;
  const suitWaste = suits.reduce(
    (sum, s) => sum + Math.max(0, cards.filter((c) => c.suit === s).length - 2),
    0
  );
  // A five/six-card hand can contain several connected four-card cores. Extra
  // cards matter through both redundancy and the fraction that joins a core.
  const coreRanks = new Set<number>();
  let connectedCores = 0;
  for (let a = 0; a < distinct.length; a++)
    for (let b = a + 1; b < distinct.length; b++)
      for (let c = b + 1; c < distinct.length; c++)
        for (let d = c + 1; d < distinct.length; d++) {
          const group = [distinct[a], distinct[b], distinct[c], distinct[d]];
          const wheel = group.map((v) => (v === 14 ? 1 : v)).sort((x, y) => x - y);
          if (Math.min(group[3] - group[0], wheel[3] - wheel[0]) <= 4) {
            connectedCores++;
            group.forEach((v) => coreRanks.add(v));
          }
        }
  const connectivity = coreRanks.size / cards.length;
  const broadway = values.filter((v) => v >= 10).length;
  const pairedAces = pairs.includes(14);
  const backupLow = lowRanks.length >= 3;
  const aceDeuce = lowRanks.includes(1) && lowRanks.includes(2);
  const aceTrey = lowRanks.includes(1) && lowRanks.includes(3);
  const highQuality = clamp(
    0.04 +
      (pairedAces ? 0.35 : pairs.some((v) => v >= 12) ? 0.16 : 0) +
      nutSuits.length * 0.12 +
      Math.min(3, suitedPairs) * 0.065 +
      connectivity * 0.29 +
      Math.min(4, connectedCores) * 0.025 +
      (broadway / cards.length) * 0.13 +
      Math.min(2, pairs.length) * 0.06 -
      tripleRanks.length * 0.23 -
      suitWaste * 0.025
  );
  const lowQuality = clamp(
    (aceDeuce ? 0.57 : aceTrey ? 0.32 : lowRanks.includes(2) && lowRanks.includes(3) ? 0.2 : 0) +
      Number(backupLow) * 0.2 +
      Math.min(4, lowRanks.filter((v) => v <= 5).length) * 0.045
  );
  const quality =
    variant === 'plo5'
      ? highQuality
      : variant === 'plo6'
        ? clamp(
            highQuality * 0.88 +
              connectivity * 0.08 +
              Math.min(3, suitedPairs) * 0.025 -
              Number(nutSuits.length === 0) * 0.035
          )
        : clamp(
            lowQuality * 0.52 +
              highQuality * 0.38 +
              Number(aceDeuce && nutSuits.length > 0) * 0.1 +
              Number(backupLow && pairedAces) * 0.06
          );
  return {
    variant,
    quality,
    highQuality,
    lowQuality,
    pairedAces,
    pairs,
    tripleRanks,
    nutSuits,
    suitedPairs,
    suitWaste,
    connectedCores,
    connectivity,
    broadway,
    lowRanks,
    backupLow,
    aceDeuce,
    aceTrey,
    confidence: 'explicit_variant_heuristic' as const,
  };
}

export function omahaVariantEntryBars(
  variant: OmahaPolicyVariant,
  node: {
    position: OmahaPolicyPosition;
    aggressorPosition: OmahaPolicyPosition | null;
    role: OmahaPolicyRole;
    seats: number;
    depthBB: number;
    rakePercent: number;
    anteBB: number;
    straddle: boolean;
  }
) {
  const pack = OMAHA_VARIANT_PACKS[variant];
  const depth = clamp((node.depthBB - 8) / 92);
  const pressure =
    node.aggressorPosition === 'early' ? 0.055 : node.aggressorPosition === 'button' ? -0.025 : 0;
  const price =
    node.rakePercent / 250 +
    Math.max(0, node.seats - 3) * pack.multiwayAdjustment -
    Math.min(1, node.anteBB) * 0.025;
  const reRaise = node.role === 'five_bet_plus' ? 0.12 : node.role === 'four_bet' ? 0.07 : 0;
  return {
    open: pack.open[node.position] + price + depth * 0.02 + Number(node.straddle) * 0.012,
    call: pack.call + price + depth * pack.deepAdjustment + reRaise + pressure,
    raise: pack.raise + depth * 0.045 + reRaise + pressure,
    callOff: pack.callOff + depth * (variant === 'plo8' ? 0.2 : 0.27) + price + pressure,
  };
}
