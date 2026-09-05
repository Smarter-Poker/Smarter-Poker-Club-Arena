/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EQUITY — who was how likely to win, street by street, from cards we know
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 of the Previous Hand build plan (2026-09-05).
 *
 * DISPLAY ONLY. The engine decides pots; this prices a hand after the fact for
 * the player reading it. It runs on the CLIENT, on cards the record already
 * shows this viewer (showdown-revealed holdings, or the viewer's own private
 * cards), and it is exact wherever the remaining runout is small enough to
 * enumerate: every turn (44 river cards), every flop (990 turn-river pairs).
 * Preflop is sampled and says so (`exact: false`, with the sample size).
 *
 * WHAT IT REFUSES TO GUESS. A street is priced only when EVERY player still in
 * the hand at that street has known cards. One unknown holding and the number
 * would be a range assumption dressed as a fact, so the street is left blank
 * rather than filled in. Hi-lo variants are priced for the HIGH half only and
 * labelled as such - the low half needs a qualifier model this does not carry.
 *
 * Variant rules come from `handEvaluator` (Omaha's exactly-two-from-hand,
 * short deck's 36 cards and reordered categories), so an equity here can never
 * disagree with the made-hand names beside it.
 */

import type { Card as DeckCard } from '../components/table/CardImage';
import {
  bestFive,
  cardKey,
  compareScore,
  isEightOrBetterVariant,
  isShortDeckVariant,
} from './handEvaluator';

const RANKS: DeckCard['rank'][] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: DeckCard['suit'][] = ['h', 'd', 'c', 's'];

/** The deck the variant plays with, minus every card already on the table. */
export function remainingDeck(known: DeckCard[], variant: string | null | undefined): DeckCard[] {
  const shortDeck = isShortDeckVariant(variant);
  const used = new Set(known.map(cardKey));
  const out: DeckCard[] = [];
  for (const rank of RANKS) {
    if (shortDeck && ['2', '3', '4', '5'].includes(rank)) continue;
    for (const suit of SUITS) {
      const c = { rank, suit };
      if (!used.has(cardKey(c))) out.push(c);
    }
  }
  return out;
}

export interface EquityInput {
  /** Each contender's known holding. */
  players: Array<{ userId: string; hole: DeckCard[] }>;
  /** The board as of the street being priced (0, 3 or 4 cards). */
  board: DeckCard[];
  variant: string | null | undefined;
  /** Sample size where enumeration is too large (preflop). */
  samples?: number;
  /** Deterministic sampling for tests. */
  random?: () => number;
}

export interface EquityResult {
  equities: Array<{ userId: string; pct: number }>;
  /** True when every runout was enumerated; false when sampled. */
  exact: boolean;
  /** Runouts evaluated. */
  runouts: number;
  /** Hi-lo variants: the number is for the high half only. */
  highOnly: boolean;
}

/** Every k-subset of `arr` (k is 1 or 2 here; small by construction). */
function combos<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i <= arr.length - (k - acc.length); i += 1) {
      acc.push(arr[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/** Enumeration ceiling: above this many runouts, sample instead. */
export const EXACT_RUNOUT_CEILING = 2_000;

/**
 * Score one complete board for every contender; the winner(s) share the pot.
 * Returns each player's share of one pot (1, 0.5, ... or 0).
 */
function settleRunout(
  players: EquityInput['players'],
  fullBoard: DeckCard[],
  variant: string | null | undefined
): number[] {
  const scores = players.map((p) => bestFive(p.hole, fullBoard, variant));
  let best: (typeof scores)[number] = null;
  for (const s of scores) if (s && (!best || compareScore(s, best) > 0)) best = s;
  if (!best) return players.map(() => 0);
  const winners = scores.map((s) => (s ? compareScore(s, best!) === 0 : false));
  const n = winners.filter(Boolean).length;
  return winners.map((w) => (w ? 1 / n : 0));
}

export function computeEquity(input: EquityInput): EquityResult | null {
  const players = input.players.filter((p) => Array.isArray(p.hole) && p.hole.length >= 2);
  if (players.length < 2) return null;
  const board = input.board || [];
  const toCome = 5 - board.length;
  if (toCome < 0) return null;
  const known = [...board, ...players.flatMap((p) => p.hole)];
  // A card cannot be in two places; a record that says so is not priced.
  if (new Set(known.map(cardKey)).size !== known.length) return null;
  const deck = remainingDeck(known, input.variant);
  const highOnly = isEightOrBetterVariant(input.variant);
  const totals = players.map(() => 0);

  if (toCome === 0) {
    const shares = settleRunout(players, board, input.variant);
    return {
      equities: players.map((p, i) => ({
        userId: p.userId,
        pct: Math.round(shares[i] * 1000) / 10,
      })),
      exact: true,
      runouts: 1,
      highOnly,
    };
  }

  // Exact when the runout space is small enough.
  let count = 1;
  for (let i = 0; i < toCome; i += 1) count = (count * (deck.length - i)) / (i + 1);
  if (count <= EXACT_RUNOUT_CEILING) {
    const runouts = combos(deck, toCome);
    for (const r of runouts) {
      const shares = settleRunout(players, [...board, ...r], input.variant);
      for (let i = 0; i < shares.length; i += 1) totals[i] += shares[i];
    }
    return {
      equities: players.map((p, i) => ({
        userId: p.userId,
        pct: Math.round((totals[i] / runouts.length) * 1000) / 10,
      })),
      exact: true,
      runouts: runouts.length,
      highOnly,
    };
  }

  // Sampled: draw `toCome` distinct cards per trial.
  const samples = Math.max(200, input.samples ?? 1_500);
  const rnd = input.random ?? Math.random;
  const idx = deck.map((_, i) => i);
  for (let t = 0; t < samples; t += 1) {
    // Partial Fisher-Yates for the first `toCome` positions.
    for (let i = 0; i < toCome; i += 1) {
      const j = i + Math.floor(rnd() * (idx.length - i));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    const drawn = idx.slice(0, toCome).map((i) => deck[i]);
    const shares = settleRunout(players, [...board, ...drawn], input.variant);
    for (let i = 0; i < shares.length; i += 1) totals[i] += shares[i];
  }
  return {
    equities: players.map((p, i) => ({
      userId: p.userId,
      pct: Math.round((totals[i] / samples) * 1000) / 10,
    })),
    exact: false,
    runouts: samples,
    highOnly,
  };
}
