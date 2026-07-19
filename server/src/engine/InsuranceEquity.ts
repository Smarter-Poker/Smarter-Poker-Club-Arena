/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Insurance Equity Calculator — EXACT enumeration vs KNOWN opponent cards
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Insurance is priced from the true equity of an all-in. In an all-in every
 * player's hole cards are known, so we do NOT deal opponents random cards (that
 * is what MonteCarloEquity does, and it badly mis-prices insurance — see
 * FIX-A12). Instead we enumerate every possible runout of the remaining board
 * cards and evaluate the leader against the ACTUAL opponent hands.
 *
 * Insurance is offered per street with at most 2 board cards to come (before the
 * turn = 2, before the river = 1), so exact enumeration is a few hundred to a
 * couple thousand boards — trivially cheap and perfectly accurate. If ever asked
 * for more cards to come than exact enumeration can bound, we fall back to a
 * large random-BOARD sample (opponents' cards still fixed/known).
 *
 * Returns the leader's share of the pot as a percentage (0-100): a scoop counts
 * as 1, an N-way tie for best counts as 1/N. For hi-lo variants this is the
 * HI-side share only (documented limitation; insurance targets the hi leader).
 */
import type { Card } from '../types.js';
import { evaluateHand, evaluateOmahaHand, compareHands, SUITS, RANKS } from './PokerEngine.js';
import { secureShuffle } from './CryptoRandom.js';

const FULL_DECK: Card[] = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK.push({ rank, suit });
  }
}

const cardKey = (c: Card): string => `${c.rank}:${c.suit}`;

const SHORT_DECK_REMOVED = new Set(['2', '3', '4', '5']);

type EvalFn = (hole: Card[], board: Card[]) => ReturnType<typeof evaluateHand>;

/** Number of k-combinations of n items (bounded; used only to pick exact vs sample). */
function countCombos(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

/** All k-combinations of arr (used for small k only). */
function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const combo: T[] = [];
  const rec = (start: number): void => {
    if (combo.length === k) {
      out.push([...combo]);
      return;
    }
    for (let i = start; i <= arr.length - (k - combo.length); i++) {
      combo.push(arr[i]);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  return out;
}

/**
 * The leader's share (0..1) of a single COMPLETE 5-card board against the known
 * opponents: 1 if the leader alone holds the best hand, 1/N for an N-way tie for
 * best, 0 if any opponent strictly beats the leader.
 */
function heroShareOnBoard(
  heroCards: Card[],
  opponentsCards: Card[][],
  board: Card[],
  evalFn: EvalFn
): number {
  const heroEval = evalFn(heroCards, board);
  let tiedForBest = 1; // the hero
  for (const opp of opponentsCards) {
    const cmp = compareHands(heroEval, evalFn(opp, board));
    if (cmp < 0) return 0; // an opponent strictly beats the hero on this board
    if (cmp === 0) tiedForBest += 1;
  }
  return 1 / tiedForBest;
}

export interface InsuranceEquityResult {
  /** Leader's pot-win equity as a percentage (0-100). */
  equity: number;
  /** True if computed by exact enumeration, false if by random-board sampling. */
  exact: boolean;
  /** Number of runouts evaluated. */
  runouts: number;
}

/**
 * Exact (or sampled) insurance equity for the leader against KNOWN opponents.
 *
 * @param heroCards      Leader's hole cards.
 * @param opponentsCards Every other all-in player's KNOWN hole cards.
 * @param board          Community cards so far (0-4; 5 => already decided).
 * @param variant        Game variant (plo* => Omaha evaluation).
 * @param shortDeck      Short-deck (6+) ranking + deck.
 */
export function insuranceEquity(
  heroCards: Card[],
  opponentsCards: Card[][],
  board: Card[],
  variant: string,
  shortDeck: boolean = false
): InsuranceEquityResult {
  const isOmaha = variant.startsWith('plo');
  const evalFn: EvalFn = isOmaha
    ? (h, b) => evaluateOmahaHand(h, b)
    : (h, b) => evaluateHand(h, b, shortDeck);

  // Board already complete — a single deterministic evaluation.
  if (board.length >= 5) {
    return {
      equity: heroShareOnBoard(heroCards, opponentsCards, board, evalFn) * 100,
      exact: true,
      runouts: 1,
    };
  }

  const known = new Set<string>();
  for (const c of heroCards) known.add(cardKey(c));
  for (const opp of opponentsCards) for (const c of opp) known.add(cardKey(c));
  for (const c of board) known.add(cardKey(c));

  const baseDeck = shortDeck ? FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank)) : FULL_DECK;
  const remaining = baseDeck.filter((c) => !known.has(cardKey(c)));

  const cardsToCome = 5 - board.length;
  if (remaining.length < cardsToCome) {
    return { equity: 50, exact: false, runouts: 0 }; // not enough cards — neutral fallback
  }

  const EXACT_MAX_COMBOS = 20000;
  const nCombos = countCombos(remaining.length, cardsToCome);

  let runouts: Card[][];
  let exact: boolean;
  if (nCombos <= EXACT_MAX_COMBOS) {
    runouts = combinations(remaining, cardsToCome);
    exact = true;
  } else {
    // Fall back to sampling only the BOARD (opponents' cards remain known/fixed).
    const N = 6000;
    runouts = [];
    for (let i = 0; i < N; i++) {
      secureShuffle(remaining);
      runouts.push(remaining.slice(0, cardsToCome));
    }
    exact = false;
  }

  let shareSum = 0;
  for (const runout of runouts) {
    shareSum += heroShareOnBoard(heroCards, opponentsCards, [...board, ...runout], evalFn);
  }

  return {
    equity: Math.round((shareSum / runouts.length) * 1000) / 10,
    exact,
    runouts: runouts.length,
  };
}
