/**
 * V32 — FACING A BET, FROM THE SOLVER'S OWN BETTING RANGE (2026-08-30).
 *
 * Phase 2 of 7. The single biggest coverage gap in the solver stack: V29/V30/
 * V31 answer only when HERO has the lead (`initiative === 'hero'`), so the
 * entire facing-a-bet side of postflop poker — at least as common — has played
 * on heuristics alone since V30's contaminated facing cells were purged
 * (#1810: the export's facing rows mixed nodes; the consult was removed
 * rather than serve corrupted answers).
 *
 * THE IDEA THAT MAKES THIS BUILDABLE FROM OPEN-NODE DATA ALONE: a cell's
 * per-holding action mix IS the opponent's betting range at a known size.
 * `hand_matrix['AKs'] = { check: 0.4, bet_mid: 0.6 }` does not only tell hero
 * what to do with AKs — read from the BETTOR'S seat it says the bettor holds
 * AKs betting mid 60% of the time. Bayes does the rest:
 *
 *     P(hand | bet of size s) ∝ P(bet of size s | hand) × P(hand)
 *
 * with the combo count as the prior (a class blocked by hero's cards or the
 * board contributes fewer combos, which is card removal falling out of the
 * arithmetic instead of being bolted on). Sampling villain holdings from that
 * posterior and running the board out gives hero's equity against the RANGE
 * THAT ACTUALLY BET, and the call/fold line follows from pot odds.
 *
 * WHY THIS IS SOUND HEADS-UP AND CLOSING: calling a bet that closes the
 * action is profitable exactly when equity vs the betting range exceeds
 * toCall / (pot + toCall). The solver's bluffs are IN the range at their
 * solved frequencies, so the comparison already prices them. On earlier
 * streets this ignores implied odds in both directions; the layer answers
 * only fold-or-call and PASSES on strong hands (see below), which keeps the
 * approximation on the side where it is tightest.
 *
 * WHAT THE LAYER DELIBERATELY DOES NOT DO: raise. With equity above
 * STRONG_PASS_EQ it returns null and lets the existing aggression layers
 * (V12 river overbet, V15/V21 nut discipline, semi-bluff gates) play the
 * hand — this layer exists to fix the fold/call line, and duplicating raise
 * sizing here would fork it. A null is "no opinion", never "check-fold".
 *
 * SIZE BUCKETS mirror fn_aggregate_gto_v31_next EXACTLY (size_pct: 0 check,
 * <60 small, <110 mid, else big). The observed bet is bucketed by the same
 * edges, so the range consulted is the range the solver bet AT THAT SIZE.
 *
 * V31 cells are consulted first (disjoint export, suit-aware); V30 second.
 * V31 keys carry the flush-suit-count suffix (`AKs:2`), so combo expansion
 * must respect it: with two spades on board, `AKs:2` expands ONLY to
 * As Ks. That is the suit dimension doing real work on the defence side —
 * the betting range on a flush board is mostly the combos that interact
 * with it, and a class-mean range would miss exactly that.
 */

import type { Card, CardRank, CardSuit } from '../types.js';
import { evaluateHand, compareHands } from './PokerEngine.js';
import { textureClass } from './GtoPostflop.js';
import { gtoV30CellMatrix } from './GtoPostflop.js';
import { gtoV31CellMatrix, boardFlushSuit } from './GtoPostflopV31.js';

const RANKS: CardRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: CardSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_INDEX: Record<CardSuit, number> = { clubs: 0, diamonds: 1, hearts: 2, spades: 3 };

/** Equity above which the layer declines to answer and lets aggression play. */
export const STRONG_PASS_EQ = 0.7;
/** Monte Carlo samples per decision. Measured at ~5.5ms per consult, which
 *  is the same envelope as the existing banded MC (120-220 iterations per
 *  decision, ~1.1M fires/day) — and a V32 answer RETURNS, so the banded MC
 *  it replaces does not also run. Net decision cost is roughly neutral. */
const MC_SAMPLES = 160;
/** Below this many live combos the posterior is noise, not a range. */
const MIN_RANGE_COMBOS = 8;

/**
 * The aggregator's own size edges (fn_aggregate_gto_v31_next):
 * 0 = check, <60% of pot = small, <110% = mid, else big.
 */
export function betBucketForFraction(frac: number): 'bet_small' | 'bet_mid' | 'bet_big' | null {
  if (!isFinite(frac) || frac <= 0) return null;
  if (frac < 0.6) return 'bet_small';
  if (frac < 1.1) return 'bet_mid';
  return 'bet_big';
}

function cardKey(c: Card): number {
  return RANKS.indexOf(c.rank) * 4 + SUIT_INDEX[c.suit];
}

/** All concrete two-card combos of a 169-class ('AA' | 'AKs' | 'AKo'). */
export function expandHandClass(cls: string): Array<[Card, Card]> {
  const r1 = cls[0] as CardRank;
  const r2 = cls[1] as CardRank;
  const out: Array<[Card, Card]> = [];
  if (r1 === r2) {
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++)
        out.push([
          { rank: r1, suit: SUITS[a] },
          { rank: r2, suit: SUITS[b] },
        ]);
    return out;
  }
  const suited = cls[2] === 's';
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++) {
      if (suited && a !== b) continue;
      if (!suited && a === b) continue;
      out.push([
        { rank: r1, suit: SUITS[a] },
        { rank: r2, suit: SUITS[b] },
      ]);
    }
  return out;
}

export interface WeightedRange {
  combos: Array<[Card, Card]>;
  weights: number[];
  totalWeight: number;
  source: 'v31' | 'v30';
}

/**
 * The betting range: every combo the solver bets at this size, weighted by
 * how often it bets it, minus everything hero and the board block.
 */
export function solverBettingRange(args: {
  street: 'flop' | 'turn' | 'river';
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev';
  bettorPosition: string;
  stackBB: number;
  board: Card[];
  heroCards: Card[];
  betFraction: number;
}): WeightedRange | null {
  const bucket = betBucketForFraction(args.betFraction);
  if (!bucket) return null;
  const tex = textureClass(args.board);
  if (!tex) return null;
  const dead = new Set<number>([...args.board, ...args.heroCards].map(cardKey));

  const build = (
    matrix: Record<string, Record<string, number>>,
    suitAware: boolean,
    source: 'v31' | 'v30'
  ): WeightedRange | null => {
    const fs = suitAware ? boardFlushSuit(args.board) : -1;
    const combos: Array<[Card, Card]> = [];
    const weights: number[] = [];
    let total = 0;
    for (const [key, mix] of Object.entries(matrix)) {
      const w = mix?.[bucket];
      if (!w || w <= 0) continue;
      let cls = key;
      let wantSuitCount = -1;
      if (suitAware) {
        const i = key.lastIndexOf(':');
        if (i < 0) continue;
        cls = key.slice(0, i);
        wantSuitCount = Number(key.slice(i + 1));
        if (!isFinite(wantSuitCount)) continue;
      }
      for (const combo of expandHandClass(cls)) {
        const k0 = cardKey(combo[0]);
        const k1 = cardKey(combo[1]);
        if (dead.has(k0) || dead.has(k1)) continue;
        if (suitAware) {
          const n =
            (fs >= 0 && SUIT_INDEX[combo[0].suit] === fs ? 1 : 0) +
            (fs >= 0 && SUIT_INDEX[combo[1].suit] === fs ? 1 : 0);
          const have = fs >= 0 ? n : 0;
          if (have !== wantSuitCount) continue;
        }
        combos.push(combo);
        weights.push(w);
        total += w;
      }
    }
    if (combos.length < MIN_RANGE_COMBOS || total <= 0) return null;
    return { combos, weights, totalWeight: total, source };
  };

  const m31 = gtoV31CellMatrix(
    args.street,
    args.family,
    args.bettorPosition,
    args.stackBB,
    tex,
    args.board
  );
  if (m31) {
    const r = build(m31, true, 'v31');
    if (r) return r;
  }
  const m30 = gtoV30CellMatrix(args.street, args.family, args.bettorPosition, args.stackBB, tex);
  if (m30) {
    const r = build(m30, false, 'v30');
    if (r) return r;
  }
  return null;
}

/**
 * Monte Carlo equity of hero vs a weighted range on a partial board.
 * NLH only — the consult gate already excludes Omaha and short deck.
 */
export function equityVsWeightedRange(
  heroCards: Card[],
  board: Card[],
  range: WeightedRange,
  rand: () => number = Math.random,
  samples: number = MC_SAMPLES
): number {
  const need = 5 - board.length;
  const deadBase = new Set<number>([...heroCards, ...board].map(cardKey));
  // cumulative weights for O(log n)-free linear sampling (n is small)
  const cum: number[] = [];
  let acc = 0;
  for (const w of range.weights) {
    acc += w;
    cum.push(acc);
  }
  let score = 0;
  let counted = 0;
  for (let s = 0; s < samples; s++) {
    const target = rand() * acc;
    let idx = 0;
    while (idx < cum.length - 1 && cum[idx] < target) idx++;
    const villain = range.combos[idx];
    const vk0 = cardKey(villain[0]);
    const vk1 = cardKey(villain[1]);
    if (deadBase.has(vk0) || deadBase.has(vk1)) continue; // blocked (shouldn't happen; range pre-filtered)
    const dead = new Set(deadBase);
    dead.add(vk0);
    dead.add(vk1);
    const runout: Card[] = [];
    let guard = 0;
    while (runout.length < need && guard < 200) {
      guard++;
      const r = RANKS[Math.floor(rand() * 13)];
      const su = SUITS[Math.floor(rand() * 4)];
      const k = RANKS.indexOf(r) * 4 + SUIT_INDEX[su];
      if (dead.has(k)) continue;
      dead.add(k);
      runout.push({ rank: r, suit: su });
    }
    if (runout.length < need) continue;
    const full = [...board, ...runout];
    const h = evaluateHand(heroCards, full, false);
    const v = evaluateHand([villain[0], villain[1]], full, false);
    const c = compareHands(h, v);
    score += c > 0 ? 1 : c === 0 ? 0.5 : 0;
    counted++;
  }
  if (counted === 0) return 0.5;
  return score / counted;
}

export type FacingDefense =
  | { action: 'fold' | 'call'; equity: number; potOdds: number; source: 'v31' | 'v30' }
  | { action: 'pass_strong'; equity: number; potOdds: number; source: 'v31' | 'v30' }
  | null;

/**
 * The defence line. `pot` INCLUDES the bet being faced; `toCall` is the
 * effective call. Returns null when no solver range exists for the spot —
 * the caller falls through to the heuristics unchanged.
 */
export function gtoFacingDefense(args: {
  street: 'flop' | 'turn' | 'river';
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev';
  bettorPosition: string;
  stackBB: number;
  board: Card[];
  heroCards: Card[];
  pot: number;
  toCall: number;
  /**
   * The bettor's RAW bet as a fraction of the pot before it — for the size
   * bucket. Without it the fraction is derived from pot/toCall, which are
   * EFFECTIVE (clamped to hero's stack): a villain jamming three pots into a
   * short hero would read as a mid bet and consult the wrong range. The
   * range is defined by the size the bettor CHOSE; the odds by what hero
   * actually pays. Two different numbers, deliberately.
   */
  rawBetFraction?: number;
  rand?: () => number;
}): FacingDefense {
  if (!(args.toCall > 0) || !(args.pot > 0)) return null;
  const potBefore = args.pot - args.toCall;
  if (potBefore <= 0) return null;
  const betFraction =
    typeof args.rawBetFraction === 'number' && args.rawBetFraction > 0
      ? args.rawBetFraction
      : args.toCall / potBefore;
  const range = solverBettingRange({ ...args, betFraction });
  if (!range) return null;
  const equity = equityVsWeightedRange(args.heroCards, args.board, range, args.rand ?? Math.random);
  const potOdds = args.toCall / (args.pot + args.toCall);
  if (equity >= STRONG_PASS_EQ) {
    // Strong enough that fold-or-call is the wrong question — the aggression
    // layers own this hand. Null-adjacent, but counted distinctly.
    return { action: 'pass_strong', equity, potOdds, source: range.source };
  }
  return { action: equity >= potOdds ? 'call' : 'fold', equity, potOdds, source: range.source };
}
