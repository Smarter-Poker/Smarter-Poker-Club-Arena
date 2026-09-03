/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  equityWorker — Monte-Carlo equity core + worker_threads entrypoint
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `computeEquity` is a PURE function (no I/O, no shared state) that runs a seeded
 * Monte-Carlo simulation of the remaining board against a set of KNOWN hands and
 * returns each hand's pot-win equity as a fraction [0,1] (ties split). It is used
 * BOTH inside the worker thread AND as the synchronous fallback in
 * EquityWorkerPool when no worker is available.
 *
 * When loaded as a worker (worker_threads), the parentPort handler at the bottom
 * runs jobs off the main event loop. When imported on the main thread
 * (isMainThread === true) the handler is skipped, so importing it for the sync
 * fallback has no side effects.
 */
import { parentPort, isMainThread } from 'node:worker_threads';
import type { Card } from '../../types.js';
import { evaluateHand, evaluateOmahaHand, compareHands, SUITS, RANKS } from '../PokerEngine.js';
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
  port.on('message', (msg: any) => {
    try {
      const equities = computeEquity(
        msg.hands,
        msg.board,
        msg.deadCards ?? [],
        msg.iters ?? 1000,
        msg.opts ?? {},
        msg.seed
      );
      port.postMessage({ id: msg.id, equities });
    } catch (e: any) {
      port.postMessage({ id: msg?.id, error: String(e?.message ?? e) });
    }
  });
}
