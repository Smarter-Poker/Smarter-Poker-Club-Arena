/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  equityWorker — Monte-Carlo equity core + worker_threads entrypoint
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `computeEquity` is a PURE function (no I/O, no shared state) that runs a seeded
 * Monte-Carlo simulation of the remaining board against a set of KNOWN hands and
 * returns each hand's pot-win equity as a fraction [0,1] (ties split). The pure
 * functions are exported for parity tests, but every live-table invocation is
 * made through EquityWorkerPool; the authoritative process never computes an
 * escape-path result on its own event loop.
 *
 * When loaded as a worker (worker_threads), the parentPort handler at the bottom
 * runs jobs off the main event loop. When imported on the main thread
 * (isMainThread === true) the handler is skipped, so importing it for the sync
 * fallback has no side effects.
 */
import { parentPort, isMainThread } from 'node:worker_threads';
import type { Card } from '../../types.js';
import { evaluateHand, evaluateOmahaHand, compareHands, SUITS, RANKS } from '../PokerEngine.js';
import { isOmahaVariant, isShortDeckVariant } from '../VariantRules.js';
import { SeededRandom, hashSeed } from './SeededRandom.js';

const FULL_DECK: Card[] = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK.push({ rank, suit });
  }
}

const cardKey = (c: Card): string => `${c.rank}:${c.suit}`;
const SHORT_DECK_REMOVED = new Set(['2', '3', '4', '5']);

export interface EquityOptions {
  shortDeck?: boolean;
  omaha?: boolean;
}

export interface InsuranceEquityComponents {
  /** Pot-share equity percentage, including split-pot shares. */
  equity: number;
  /** Percentage of runouts on which this hand is strictly beaten. */
  strictLossPct: number;
  /** Percentage of runouts on which this hand ties for best. */
  pushPct: number;
  exact: boolean;
  runouts: number;
}

type EvalFn = (hole: Card[], board: Card[]) => ReturnType<typeof evaluateHand>;

/** Add each runout's win/tie share (1 for a scoop, 1/k for a k-way tie) to totals. */
function award(equities: number[], hands: Card[][], board: Card[], evalFn: EvalFn): void {
  let best: ReturnType<typeof evaluateHand> | null = null;
  let winners: number[] = [];
  for (let i = 0; i < hands.length; i++) {
    const ev = evalFn(hands[i], board);
    if (best === null) {
      best = ev;
      winners = [i];
      continue;
    }
    const cmp = compareHands(ev, best);
    if (cmp > 0) {
      best = ev;
      winners = [i];
    } else if (cmp === 0) {
      winners.push(i);
    }
  }
  const share = 1 / winners.length;
  for (const w of winners) equities[w] += share;
}

/** Number of k-combinations of n items (bounded; used to select exact/sample). */
function countCombos(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

const INSURANCE_SAMPLE_MAX_RUNOUTS = 6_000;
const INSURANCE_SAMPLE_MIN_RUNOUTS = 1_000;
const INSURANCE_SAMPLE_EVALUATION_BUDGET = 90_000;

/**
 * Bound sampled insurance by evaluator work rather than board count alone.
 * Omaha evaluates every two-card choice from every known hand on each board,
 * so a fixed 6,000-board sample makes PLO4/5/6 progressively more expensive.
 * The cap is deterministic from the field shape and the result continues to
 * publish its actual runout count and whether it was exact.
 */
export function insuranceSampleRunoutCap(hands: Card[][], isOmaha: boolean): number {
  const unitsPerRunout = Math.max(
    1,
    hands.reduce((sum, hand) => sum + (isOmaha ? countCombos(hand.length, 2) : 1), 0)
  );
  return Math.min(
    INSURANCE_SAMPLE_MAX_RUNOUTS,
    Math.max(
      INSURANCE_SAMPLE_MIN_RUNOUTS,
      Math.floor(INSURANCE_SAMPLE_EVALUATION_BUDGET / unitsPerRunout)
    )
  );
}

/** Visit every k-combination without materialising the complete runout set. */
function visitCombinations<T>(arr: T[], k: number, visit: (items: T[]) => void): void {
  const selected: T[] = [];
  const walk = (start: number): void => {
    if (selected.length === k) {
      visit(selected);
      return;
    }
    for (let i = start; i <= arr.length - (k - selected.length); i++) {
      selected.push(arr[i]);
      walk(i + 1);
      selected.pop();
    }
  };
  walk(0);
}

/**
 * Price every known hand from ONE shared runout pass. Besides removing the
 * former N+1 repeated enumerations, using one board stream guarantees every
 * player is compared against precisely the same sampled universe preflop.
 */
export function computeInsuranceComponentsForHands(
  hands: Card[][],
  board: Card[],
  variant: string,
  shortDeck = false
): InsuranceEquityComponents[] {
  if (hands.length === 0) return [];

  const isOmaha = isOmahaVariant(variant);
  const useShortDeck = shortDeck || isShortDeckVariant(variant);
  const evalFn: EvalFn = isOmaha
    ? (h, b) => evaluateOmahaHand(h, b)
    : (h, b) => evaluateHand(h, b, useShortDeck);
  const equities = new Array<number>(hands.length).fill(0);
  const losses = new Array<number>(hands.length).fill(0);
  const pushes = new Array<number>(hands.length).fill(0);
  let runoutCount = 0;

  const score = (runout: Card[]): void => {
    const fullBoard = board.length >= 5 ? board : board.concat(runout);
    const evaluations = hands.map((hand) => evalFn(hand, fullBoard));
    let winners = [0];
    for (let i = 1; i < evaluations.length; i++) {
      const comparison = compareHands(evaluations[i], evaluations[winners[0]]);
      if (comparison > 0) winners = [i];
      else if (comparison === 0) winners.push(i);
    }
    const winnerSet = new Set(winners);
    const share = 1 / winners.length;
    for (let i = 0; i < hands.length; i++) {
      if (!winnerSet.has(i)) losses[i] += 1;
      else {
        equities[i] += share;
        if (winners.length > 1) pushes[i] += 1;
      }
    }
    runoutCount += 1;
  };

  if (board.length >= 5) {
    score([]);
    return equities.map((equity, i) => ({
      equity: equity * 100,
      strictLossPct: losses[i] * 100,
      pushPct: pushes[i] * 100,
      exact: true,
      runouts: 1,
    }));
  }

  const known = new Set<string>();
  for (const hand of hands) for (const card of hand) known.add(cardKey(card));
  for (const card of board) known.add(cardKey(card));
  const baseDeck = useShortDeck
    ? FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank))
    : FULL_DECK;
  const remaining = baseDeck.filter((c) => !known.has(cardKey(c)));
  const cardsToCome = 5 - board.length;
  if (remaining.length < cardsToCome) {
    throw new Error('Not enough unseen cards to complete insurance runout');
  }

  const boundedRunouts = insuranceSampleRunoutCap(hands, isOmaha);
  const exact = countCombos(remaining.length, cardsToCome) <= boundedRunouts;
  if (exact) {
    visitCombinations(remaining, cardsToCome, score);
  } else {
    const rng = new SeededRandom(hashSeed(...Array.from(known).sort(), cardsToCome));
    for (let iteration = 0; iteration < boundedRunouts; iteration++) {
      const pick: Card[] = [];
      const pickedIndices = new Set<number>();
      while (pick.length < cardsToCome) {
        const index = rng.nextInt(remaining.length);
        if (!pickedIndices.has(index)) {
          pickedIndices.add(index);
          pick.push(remaining[index]);
        }
      }
      score(pick);
    }
  }

  return equities.map((equity, i) => ({
    equity: Math.round((equity / runoutCount) * 1000) / 10,
    strictLossPct: Math.round((losses[i] / runoutCount) * 1000) / 10,
    pushPct: Math.round((pushes[i] / runoutCount) * 1000) / 10,
    exact,
    runouts: runoutCount,
  }));
}

/**
 * Monte-Carlo equity for a set of KNOWN hands over the remaining board.
 *
 * @param hands      Each player's known hole cards (2 for hold'em, 4 for Omaha).
 * @param board      Community cards so far (0-5).
 * @param deadCards  Additional cards to remove from the deck (e.g. folded cards).
 * @param iters      Monte-Carlo iterations (default 1000).
 * @param opts       { shortDeck, omaha }.
 * @param seed       Optional PRNG seed; when omitted a deterministic seed is
 *                   derived from the inputs (so equal inputs => equal result).
 * @returns          Per-hand equity fraction in [0,1] (sums to ~1 across hands).
 */
export function computeEquity(
  hands: Card[][],
  board: Card[],
  deadCards: Card[] = [],
  iters = 1000,
  opts: EquityOptions = {},
  seed?: number
): number[] {
  const n = hands.length;
  const equities = new Array<number>(n).fill(0);
  if (n === 0) return equities;
  if (n === 1) {
    equities[0] = 1;
    return equities;
  }

  const shortDeck = !!opts.shortDeck;
  const evalFn: EvalFn = opts.omaha
    ? (h, b) => evaluateOmahaHand(h, b)
    : (h, b) => evaluateHand(h, b, shortDeck);

  const need = Math.max(0, 5 - board.length);

  // Board already complete: a single deterministic evaluation.
  if (need === 0) {
    award(equities, hands, board, evalFn);
    return equities;
  }

  const known = new Set<string>();
  for (const h of hands) for (const c of h) known.add(cardKey(c));
  for (const c of board) known.add(cardKey(c));
  for (const c of deadCards) known.add(cardKey(c));

  const baseDeck = shortDeck ? FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank)) : FULL_DECK;
  const remaining = baseDeck.filter((c) => !known.has(cardKey(c)));

  if (remaining.length < need) {
    // Not enough cards to complete the board — return a neutral split.
    return equities.map(() => 1 / n);
  }

  const useSeed = seed ?? hashSeed(iters, ...Array.from(known).sort());
  const rng = new SeededRandom(useSeed);

  for (let it = 0; it < iters; it++) {
    rng.shuffle(remaining);
    const full = board.concat(remaining.slice(0, need));
    award(equities, hands, full, evalFn);
  }
  for (let i = 0; i < n; i++) equities[i] /= iters;
  return equities;
}

// ── worker_threads entrypoint (skipped on the main thread) ──────────────────────
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.postMessage({ type: 'READY' });
  port.on('message', (msg: any) => {
    try {
      if (msg?.type === 'INSURANCE_ALL') {
        const components = computeInsuranceComponentsForHands(
          msg.hands,
          msg.board,
          msg.variant,
          msg.shortDeck ?? false
        );
        port.postMessage({ type: 'INSURANCE_RESULT', id: msg.id, components });
      } else if (msg?.type === 'EQUITY') {
        const equities = computeEquity(
          msg.hands,
          msg.board,
          msg.deadCards ?? [],
          msg.iters ?? 1000,
          msg.opts ?? {},
          msg.seed
        );
        port.postMessage({ type: 'EQUITY_RESULT', id: msg.id, equities });
      } else {
        throw new Error(`Unsupported equity worker operation: ${String(msg?.type)}`);
      }
    } catch (e: any) {
      port.postMessage({ type: 'ERROR', id: msg?.id, error: String(e?.message ?? e) });
    }
  });
}
