import type { Card } from '../../types.js';
import type { Plo4NodeRole, Plo4Position } from '../plo4/Plo4PolicyPack.js';
import { maxSeatsFor } from '../VariantRules.js';
import { maxSeatsForVariant } from '../../config/tableSeating.js';

export type RemainingPolicyVariant = 'short_deck' | 'pineapple' | 'flh' | 'flo8';

/**
 * Round 3 (docs/horse-brain-phase12-round3-2026-10-08.md). The round-1 packs
 * replaced every eligible reference decision with their own entry bars and
 * sampled-equity rules, and lost to the reference on every held-out matrix.
 * Read from the locked matrices and from development-seed attribution of each
 * pair to its first changed decision, the losses had three named causes:
 *
 *  1. Blind defence and every facing-a-raise node: the shared kernel's
 *     defence bar is a fixed hand-shape quality that ignores the price, so the
 *     big blind folded hands the reference profitably defends (the largest
 *     single loss in every pack), and it called hands the reference
 *     profitably three-bets.
 *  2. Postflop calls and raises against a bet: the sampler conditions an
 *     opponent's range on preflop hand shape and action counts only, never on
 *     board contact, so a bettor's range is far too wide and the hero's
 *     equity against it is overstated. Every call the pack made where the
 *     reference folded lost (10 to 40 big blinds a time in no limit).
 *  3. Postflop value bets the reference does not make lost for the same
 *     reason: the equity they rest on is measured against the wrong range.
 *
 * And it had one consistent gain: first-in opens the reference makes from
 * early, middle, cutoff and (three or more dealt) button positions with a
 * hand below the pack's own open bar lose against this population, which
 * defends and continues too widely for a loose open to profit; folding them
 * wins in every pack's position cells. In no limit the reference's flop
 * stab when checked to also loses to checking.
 *
 * So round 3 is a delta on the reference, not a replacement of it. The pack
 * keeps the reference action everywhere it was measured to be worse, which
 * removes causes 1 to 3 at their source (no price-blind defence bar, no
 * line-blind sampled call, raise or value bet is ever substituted for the
 * reference), and it changes the decision only in these declared spots:
 *
 *  - `openTighten`: first in (`rfi`) from a listed position with at least
 *    `openTightenMinDealt` dealt, when the reference opens and the hand's
 *    pack quality is below the pack's open bar: fold.
 *  - `flopCheckBelow` (no limit only): checked to on the flop, when the
 *    reference bets and the sampled equity is below this value: check.
 *  - `headsUpOpenBelowBar` (fixed limit only): heads-up, first in on the
 *    button, when the reference does not open and the hand's quality is at
 *    least the open bar minus this value: open. Folding a heads-up button
 *    loses the posted small blind, and the population defends a fixed-limit
 *    open too passively to punish a wider one.
 *  - `smallBlindStealBelowBar` (fixed limit only): folded to the small blind
 *    with three or more dealt, when the reference does not open and the
 *    hand's quality is at least the open bar minus this value: open.
 *  - `bigBlindDefendBelowCallBar` (fixed limit only): the big blind facing a
 *    single raise, when the reference folds and the hand's quality is at
 *    least the pack's call bar minus this value: call. A fixed-limit big
 *    blind closes the action at three to one or better.
 *
 * These are heuristic choices measured on development seeds, not solver
 * frequencies, and nothing here is calibrated (`calibratedConfidence: null`).
 */
export interface RemainingVariantRound3Rules {
  readonly openTighten: readonly ('early' | 'middle' | 'cutoff' | 'button')[];
  readonly openTightenMinDealt: number;
  readonly flopCheckBelow: number | null;
  readonly headsUpOpenBelowBar: number | null;
  readonly smallBlindStealBelowBar: number | null;
  readonly bigBlindDefendBelowCallBar: number | null;
}
const REMAINING_VARIANT_NO_LIMIT_ROUND3: RemainingVariantRound3Rules = Object.freeze({
  openTighten: Object.freeze(['early', 'middle', 'cutoff', 'button'] as const),
  openTightenMinDealt: 3,
  flopCheckBelow: 0.95,
  headsUpOpenBelowBar: null,
  smallBlindStealBelowBar: null,
  bigBlindDefendBelowCallBar: null,
});
const REMAINING_VARIANT_FIXED_LIMIT_ROUND3: RemainingVariantRound3Rules = Object.freeze({
  openTighten: Object.freeze(['middle', 'cutoff', 'button'] as const),
  openTightenMinDealt: 3,
  flopCheckBelow: null,
  headsUpOpenBelowBar: 0.15,
  smallBlindStealBelowBar: 0.2,
  bigBlindDefendBelowCallBar: 0.15,
});
export const REMAINING_VARIANT_PACKS = Object.freeze({
  short_deck: Object.freeze({
    version: 'short-deck-round3-v1',
    holes: 2,
    deck: 36,
    splitLow: false,
    structure: 'no_limit',
    open: Object.freeze({
      early: 0.59,
      middle: 0.54,
      cutoff: 0.48,
      button: 0.43,
      small_blind: 0.52,
      big_blind: 0.47,
    }),
    call: 0.52,
    raise: 0.76,
    callOff: 0.67,
    value: 0.65,
    depthAdjustment: 0.065,
    multiway: 0.018,
    round3: REMAINING_VARIANT_NO_LIMIT_ROUND3,
  }),
  pineapple: Object.freeze({
    version: 'crazy-pineapple-round3-v1',
    holes: 3,
    deck: 52,
    splitLow: false,
    structure: 'no_limit',
    open: Object.freeze({
      early: 0.64,
      middle: 0.59,
      cutoff: 0.53,
      button: 0.47,
      small_blind: 0.57,
      big_blind: 0.51,
    }),
    call: 0.56,
    raise: 0.82,
    callOff: 0.72,
    value: 0.66,
    depthAdjustment: 0.07,
    multiway: 0.02,
    round3: REMAINING_VARIANT_NO_LIMIT_ROUND3,
  }),
  flh: Object.freeze({
    version: 'fixed-limit-holdem-round3-v1',
    holes: 2,
    deck: 52,
    splitLow: false,
    structure: 'fixed_limit',
    open: Object.freeze({
      early: 0.53,
      middle: 0.49,
      cutoff: 0.43,
      button: 0.38,
      small_blind: 0.46,
      big_blind: 0.41,
    }),
    call: 0.43,
    raise: 0.67,
    callOff: 0.59,
    value: 0.54,
    depthAdjustment: 0.025,
    multiway: 0.008,
    round3: REMAINING_VARIANT_FIXED_LIMIT_ROUND3,
  }),
  flo8: Object.freeze({
    version: 'fixed-limit-omaha8-round3-v1',
    holes: 4,
    deck: 52,
    splitLow: true,
    structure: 'fixed_limit',
    open: Object.freeze({
      early: 0.54,
      middle: 0.5,
      cutoff: 0.44,
      button: 0.39,
      small_blind: 0.47,
      big_blind: 0.42,
    }),
    call: 0.42,
    raise: 0.72,
    callOff: 0.6,
    value: 0.58,
    depthAdjustment: 0.025,
    multiway: 0.01,
    round3: REMAINING_VARIANT_FIXED_LIMIT_ROUND3,
  }),
});
export const REMAINING_VARIANT_DOMAIN = Object.freeze({
  source: 'explicit_variant_heuristic',
  calibratedConfidence: null,
  defaultMode: 'shadow',
  maxStackBB: 250,
  // Existing fixed-limit tables permit a1000BB buy-in. Canonical fixed
  // wagers bound exposure; the ordinary no-limit depth domain stays separate.
  fixedLimitMaxStackBB: 1000,
  maxAnteBB: 1,
  maxRakePercent: 10,
  liveBudgetMs: 4,
  // Leave headroom for completing a physical sample, pot receipts and GC.
  samplingDeadlineMs: 2.5,
  // P12.1: the net-action economics get a budget OF THEIR OWN, measured from
  // their own start AFTER the policy has already finished and fixed its
  // reason, proposal and latency. A deadline inside liveBudgetMs was the first
  // design and it was wrong: the guard bounds work units, not wall time, so on
  // a slow host one settlement's overshoot past the deadline still crossed
  // liveBudgetMs and the diagnostic became the reason the policy fell back to
  // the baseline. Measured, on a shared CI runner, by the test that pinned it.
  // Now the decision cannot be reached from here at all. Checked before the
  // hypothetical pots and before every terminal settlement.
  netActionBudgetMs: 1,
  defaultSamples: 32,
  maxSamples: 128,
  maxActionsPerHand: 256,
  maxPairs: 32,
  boardCount: 1,
});
export function isRemainingPolicyVariant(v: unknown): v is RemainingPolicyVariant {
  return v === 'short_deck' || v === 'pineapple' || v === 'flh' || v === 'flo8';
}
export function remainingVariantSeatCap(v: RemainingPolicyVariant, mode: 'cash' | 'tournament') {
  if (mode === 'tournament' && v === 'pineapple') return 0;
  return mode === 'cash' ? maxSeatsForVariant(v) : Math.min(10, maxSeatsFor(v));
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ranks = '23456789TJQKA';
const suits: Card['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades'];
/** Physical validation is independent of the quality model; no opponent cards
 * are admitted by this helper. Pineapple's retained pair is an explicit input. */
export function remainingVariantHandShape(
  v: RemainingPolicyVariant,
  cards: Card[],
  postDiscard = false
) {
  const pack = REMAINING_VARIANT_PACKS[v];
  if (
    !pack ||
    cards.length !== (v === 'pineapple' && postDiscard ? 2 : pack.holes) ||
    cards.some(
      (c) =>
        !c ||
        c.rank.length !== 1 ||
        !ranks.includes(c.rank) ||
        !suits.includes(c.suit) ||
        (pack.deck === 36 && ranks.indexOf(c.rank) < 4)
    ) ||
    new Set(cards.map((c) => c.rank + ':' + c.suit)).size !== cards.length
  )
    throw new Error('Cards outside remaining-variant pack');
  const values = cards.map((c) => ranks.indexOf(c.rank) + 2);
  const low = [...new Set(values.map((n) => (n === 14 ? 1 : n)).filter((n) => n <= 8))].sort(
    (a, b) => a - b
  );
  const nutSuits = suits.filter(
    (s) =>
      cards.some((c) => c.suit === s && c.rank === 'A') &&
      cards.filter((c) => c.suit === s).length >= 2
  ).length;
  const pairRanks = [...new Set(values)].filter((n) => values.filter((r) => r === n).length === 2);
  const backupLow = low.length >= 3,
    aceDeuce = low.includes(1) && low.includes(2),
    aceTrey = low.includes(1) && low.includes(3);
  let quality = 0;
  const pairQualities: number[] = [];
  if (v === 'flo8') {
    const suitPairs = suits.filter((s) => cards.filter((c) => c.suit === s).length >= 2).length;
    const duplicateWaste = cards.length - new Set(values).size - pairRanks.length;
    quality = clamp(
      (aceDeuce ? 0.48 : aceTrey ? 0.29 : low.includes(2) && low.includes(3) ? 0.18 : 0.02) +
        Number(backupLow) * 0.14 +
        nutSuits * 0.11 +
        Number(pairRanks.includes(14)) * 0.21 +
        Number(pairRanks.some((n) => n >= 12)) * 0.08 +
        suitPairs * 0.045 +
        values.filter((n) => n >= 10).length * 0.025 -
        duplicateWaste * 0.15
    );
  } else {
    for (let a = 0; a < cards.length - 1; a++)
      for (let b = a + 1; b < cards.length; b++) {
        const hi = Math.max(values[a], values[b]),
          lo = Math.min(values[a], values[b]);
        const pair = hi === lo,
          suited = cards[a].suit === cards[b].suit;
        const gap =
          hi === 14 ? Math.min(hi - lo, Math.abs(lo - (v === 'short_deck' ? 5 : 1))) : hi - lo;
        const connection = pair ? 0 : Math.max(0, 1 - (gap - 1) / 4);
        const high = (hi + lo * 0.65) / (14 * 1.65);
        // Short-deck suit/connectivity has its own scale; these are structural
        // quality scores, not hold'em quantiles, equity or solver frequencies.
        const q =
          v === 'short_deck'
            ? 0.04 +
              high * 0.36 +
              Number(pair) * (0.2 + ((hi - 6) / 8) * 0.2) +
              Number(suited) * 0.15 +
              connection * 0.19
            : 0.025 +
              high * 0.39 +
              Number(pair) * (0.22 + (hi / 14) * 0.2) +
              Number(suited) * 0.1 +
              connection * 0.11;
        pairQualities.push(clamp(q));
      }
    pairQualities.sort((a, b) => b - a);
    quality = clamp(
      pairQualities[0] +
        (v === 'pineapple' && !postDiscard ? 0.04 + Math.min(0.08, pairQualities[1] * 0.09) : 0)
    );
  }
  return { quality, pairQualities, nutSuits, pairRanks, backupLow, aceDeuce, aceTrey };
}

export function remainingVariantEntryBars(
  v: RemainingPolicyVariant,
  node: {
    position: Plo4Position;
    aggressorPosition: Plo4Position | null;
    role: Plo4NodeRole;
    seats: number;
    depthBB: number;
    rakePercent: number;
    anteBB: number;
    straddle: boolean;
  }
) {
  const p = REMAINING_VARIANT_PACKS[v],
    limit = p.structure === 'fixed_limit';
  const depth = clamp((node.depthBB - 5) / 245);
  const price =
    node.rakePercent / 300 +
    Math.max(0, node.seats - 3) * p.multiway -
    Math.min(1, node.anteBB) * 0.025;
  const position =
    node.aggressorPosition === 'early' ? 0.05 : node.aggressorPosition === 'button' ? -0.025 : 0;
  const escalation =
    node.role === 'five_bet_plus'
      ? limit
        ? 0.06
        : 0.13
      : node.role === 'four_bet'
        ? limit
          ? 0.035
          : 0.075
        : 0;
  return {
    open: clamp(
      p.open[node.position] +
        price +
        depth * p.depthAdjustment * 0.3 +
        Number(node.straddle) * 0.015
    ),
    call: clamp(p.call + price + position + depth * p.depthAdjustment + escalation),
    raise: clamp(p.raise + position + depth * p.depthAdjustment + escalation),
    callOff: clamp(p.callOff + price + position + depth * (limit ? 0.12 : 0.23) + escalation),
  };
}
