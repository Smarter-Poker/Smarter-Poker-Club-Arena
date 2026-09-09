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
 * `hand_matrix['AKs'] = { check: 0.4, bet_small: 0.6 }` does not only tell hero
 * what to do with AKs — read from the BETTOR'S seat it says the bettor holds
 * AKs betting small 60% of the time. Bayes does the rest:
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
 * SIZE BUCKETS must respect the V30 compact store this module actually reads.
 * That store has only `check`, `bet_small`, and `bet_big`; worse, multi-size
 * trees label their largest root size big while single-size trees label a
 * sub-pot root small. The compact row no longer preserves those source sizes,
 * so an observed 60-110% bet cannot be mapped honestly. The layer fails closed
 * in that middle band and waits for a certified V31 response cell instead of
 * inventing a range. The unambiguous tails retain the shipped <60% small and
 * >=110% big behavior.
 *
 * This remains an explicitly DERIVED legacy fallback. Certified V31 response
 * nodes are consulted directly before this module. V31 open cells are not
 * relabeled as exact responses here; if no genuine response cell exists, the
 * caller may use this V30 range inference and telemetry names it as derived.
 */

import type { Card, CardRank, CardSuit } from '../types.js';
import { evaluateHand, compareHands } from './PokerEngine.js';
import { textureClass } from './GtoPostflop.js';
import { gtoV30CellMatrix } from './GtoPostflop.js';

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
 * The only defensible observed-size mapping into the V30 compact action domain:
 * 0 = no bet, <60% of pot = small, 60-110% = unknown, >=110% = big.
 *
 * Do not add `bet_mid` here. V31 owns that three-bucket action domain and is
 * consulted directly before this legacy-derived fallback. V30 compact rows
 * have never persisted a mid bucket.
 */
export function betBucketForFraction(frac: number): 'bet_small' | 'bet_big' | null {
  if (!isFinite(frac) || frac <= 0) return null;
  if (frac < 0.6) return 'bet_small';
  if (frac < 1.1) return null;
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
  source: 'v30_legacy_derived';
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

  const build = (matrix: Record<string, Record<string, number>>): WeightedRange | null => {
    const combos: Array<[Card, Card]> = [];
    const weights: number[] = [];
    let total = 0;
    for (const [key, mix] of Object.entries(matrix)) {
      const w = mix?.[bucket];
      if (!w || w <= 0) continue;
      for (const combo of expandHandClass(key)) {
        const k0 = cardKey(combo[0]);
        const k1 = cardKey(combo[1]);
        if (dead.has(k0) || dead.has(k1)) continue;
        combos.push(combo);
        weights.push(w);
        total += w;
      }
    }
    if (combos.length < MIN_RANGE_COMBOS || total <= 0) return null;
    return { combos, weights, totalWeight: total, source: 'v30_legacy_derived' };
  };
  const m30 = gtoV30CellMatrix(args.street, args.family, args.bettorPosition, args.stackBB, tex);
  if (m30) {
    const r = build(m30);
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
  | {
      action: 'fold' | 'call';
      equity: number;
      potOdds: number;
      /** The equity the call actually needed, after realization and rake. */
      required: number;
      source: 'v30_legacy_derived';
    }
  | {
      action: 'pass_strong';
      equity: number;
      potOdds: number;
      required: number;
      source: 'v30_legacy_derived';
    }
  | null;

/**
 * ═══ V34 (2026-09-02): RAW EQUITY IS NOT REALIZED EQUITY ═══════════════════
 *
 * The first cut compared equity-vs-the-betting-range with pot odds and
 * nothing else. Measured live over two days: v32_defend_call 13,660 against
 * v32_defend_fold 2,518 — the layer folded 16% of the hands it judged, when a
 * solver facing the same bets folds 35-50%. The arithmetic was not wrong,
 * the premise was: against a third-pot bet the pot lays 4:1 and almost any
 * two cards hold 20% RAW equity against a range that contains bluffs — but
 * a seven-high on the flop does not get to REALIZE 20%, because it has to
 * survive two more streets of betting to reach a showdown. The solver
 * defends by minimum defence frequency and lets the bottom of its range go;
 * a raw-equity call criterion keeps all of it.
 *
 * So the required equity is potOdds / realization, where realization is the
 * fraction of raw equity a hand can expect to cash on this street from this
 * seat. The river realizes everything (a call closes the hand). Earlier
 * streets realize less, and less again out of position: the values are the
 * standard ones (OOP flop ~0.75, IP flop ~0.85, turn ~0.85/0.92). Draws get a
 * little back — their equity arrives on later streets by construction and
 * carries implied odds — which the caller expresses through the same number.
 *
 * With realization 0.75, a third-pot bet on the flop needs 27% instead of
 * 20%, a two-thirds-pot bet needs 38% instead of 29%, and a pot-sized bet
 * needs 44% instead of 33%. Those are the fold-out points a solver's
 * defending range actually has.
 */
export function realizationFactor(args: {
  street: 'flop' | 'turn' | 'river';
  inPosition: boolean;
  drawy?: boolean;
}): number {
  if (args.street === 'river') return 1;
  let r = args.street === 'flop' ? (args.inPosition ? 0.85 : 0.75) : args.inPosition ? 0.92 : 0.85;
  if (args.drawy) r = Math.min(1, r + 0.08);
  return r;
}

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
  /** V34: equity realization (0..1], see realizationFactor. Default 1. */
  realization?: number;
  /** V34: marginal rake on the pot in cash games (0..1). Default 0 — the
   *  same rakeDrag the heuristic call line already prices. */
  rakeMarg?: number;
  /** V34: tournament survival premium to ADD to the required equity (0 in
   *  cash). The caller scales icmRisk by the share of stack the call puts
   *  at risk, exactly as the V24 preflop price defence does — a chip-EV
   *  solver range prices the pot, not the tournament life. */
  riskPremium?: number;
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
  const rake = Math.max(0, Math.min(0.5, args.rakeMarg ?? 0));
  const potOdds = args.toCall / ((args.pot + args.toCall) * (1 - rake));
  const realization =
    typeof args.realization === 'number' && args.realization > 0
      ? Math.min(1, args.realization)
      : 1;
  const premium = Math.max(0, Math.min(0.15, args.riskPremium ?? 0));
  const required = Math.min(0.99, potOdds / realization + premium);
  if (equity >= STRONG_PASS_EQ) {
    // Strong enough that fold-or-call is the wrong question — the aggression
    // layers own this hand. Null-adjacent, but counted distinctly.
    return { action: 'pass_strong', equity, potOdds, required, source: range.source };
  }
  return {
    action: equity >= required ? 'call' : 'fold',
    equity,
    potOdds,
    required,
    source: range.source,
  };
}
