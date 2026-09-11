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
import type { Card, PerPotAward, Pot, SeatPlayer } from '../../types.js';
import {
  evaluateHand,
  evaluateOmahaHand,
  compareHands,
  determineWinners,
  SUITS,
  RANKS,
} from '../PokerEngine.js';
import { isOmahaVariant, isShortDeckVariant } from '../VariantRules.js';
import { SeededRandom, hashSeed } from './SeededRandom.js';
import { scaleWinnerCentsForRake } from '../WinnerScaling.js';

const FULL_DECK: Card[] = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK.push({ rank, suit });
  }
}

const cardKey = (c: Card): string => `${c.rank}:${c.suit}`;
const SHORT_DECK_REMOVED = new Set(['2', '3', '4', '5']);
const FULL_DECK_KEYS = new Set(FULL_DECK.map(cardKey));

/** Worker-side defense against malformed structured-clone input. Live callers
 * validate first, but financial pricing must remain fail-closed if another
 * caller or a future refactor reaches this pure boundary directly. */
function assertCardUniverse(
  hands: Card[][],
  boards: Card[][],
  deadCards: Card[],
  shortDeck: boolean
): void {
  if (
    !Array.isArray(boards) ||
    boards.length === 0 ||
    boards.some((board) => !Array.isArray(board) || board.length > 5)
  ) {
    throw new Error('Equity card universe has an invalid board set');
  }
  const seen = new Set<string>();
  for (const card of [...hands.flat(), ...boards.flat(), ...deadCards]) {
    if (!card || !FULL_DECK_KEYS.has(cardKey(card))) {
      throw new Error('Equity card universe contains an invalid card');
    }
    if (shortDeck && SHORT_DECK_REMOVED.has(card.rank)) {
      throw new Error('Equity card universe contains a card removed from the short deck');
    }
    const key = cardKey(card);
    if (seen.has(key)) {
      throw new Error('Equity card universe contains a duplicate card');
    }
    seen.add(key);
  }
}

export interface EquityOptions {
  shortDeck?: boolean;
  omaha?: boolean;
  hiLo?: boolean;
}

export interface LayeredEquityResult {
  /** Whole-field showdown equity, one fraction per hand; sums to one. */
  equities: number[];
  /** Gross pot-share equity for each physical pot, in input order. */
  layerEquities: number[][];
  /** Expected post-deduction chips returned, one amount per hand. */
  expectedNetReturns: number[];
  /** Percentage of whole-field runouts on which each hand is strictly beaten. */
  strictLossPcts: number[];
  /** Percentage of whole-field runouts on which each hand ties for best. */
  pushPcts: number[];
  /** Deterministic worker seed used for sampled paths. */
  seed: number;
  exact: boolean;
  runouts: number;
}

export interface LayeredPotInput {
  potIndex: number;
  amount: number;
  eligiblePlayerIds: string[];
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
  shortDeck = false,
  deadCards: Card[] = []
): InsuranceEquityComponents[] {
  if (hands.length === 0) return [];

  const isOmaha = isOmahaVariant(variant);
  const useShortDeck = shortDeck || isShortDeckVariant(variant);
  assertCardUniverse(hands, [board], deadCards, useShortDeck);
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
  for (const card of deadCards) known.add(cardKey(card));
  const baseDeck = useShortDeck
    ? FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank))
    : FULL_DECK;
  const remaining = baseDeck.filter((c) => !known.has(cardKey(c)));
  const cardsToCome = 5 - board.length;
  if (remaining.length < cardsToCome) {
    throw new Error('Not enough unseen cards to complete insurance runout');
  }

  const exact = countCombos(remaining.length, cardsToCome) <= 20_000;
  if (exact) {
    visitCombinations(remaining, cardsToCome, score);
  } else {
    const rng = new SeededRandom(hashSeed(...Array.from(known).sort(), cardsToCome));
    for (let iteration = 0; iteration < 6_000; iteration++) {
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
  if (!Number.isSafeInteger(iters) || iters <= 0) {
    throw new Error('Equity iteration count must be a positive safe integer');
  }
  if (n === 1) {
    equities[0] = 1;
    return equities;
  }

  const shortDeck = !!opts.shortDeck;
  assertCardUniverse(hands, [board], deadCards, shortDeck);
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
    throw new Error('Not enough unseen cards to complete equity runout');
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

/**
 * Compute the whole-field display equity and every side-pot eligibility layer
 * from one deterministic runout stream. This is the durable EV primitive: a
 * single whole-field percentage cannot describe A=50, B=C=100 because A's
 * main pot is three-way while B/C's side pot is heads-up.
 */
export function computeLayeredEquity(
  hands: Card[][],
  playerIds: string[],
  playerSeats: number[],
  boards: Card[][],
  deadCards: Card[] = [],
  iters = 1000,
  variant = 'nlh',
  pots: LayeredPotInput[] = [],
  dealerSeat = 0,
  totalWinnings?: number,
  chipUnit = 0.01,
  seed?: number
): LayeredEquityResult {
  if (!Number.isSafeInteger(iters) || iters <= 0) {
    throw new Error('Layered equity iteration count must be a positive safe integer');
  }
  const n = hands.length;
  if (
    playerIds.length !== n ||
    playerSeats.length !== n ||
    playerIds.some((id) => !id) ||
    new Set(playerIds).size !== playerIds.length ||
    playerSeats.some((seat) => !Number.isSafeInteger(seat) || seat <= 0) ||
    new Set(playerSeats).size !== playerSeats.length
  ) {
    throw new Error('Layered equity contains an invalid player identity set');
  }
  if (pots.length === 0 || new Set(pots.map((pot) => pot.potIndex)).size !== pots.length) {
    throw new Error('Layered equity contains an empty or duplicate pot set');
  }
  const playerIdSet = new Set(playerIds);
  const normalizedPots: Pot[] = pots.map((pot, index) => {
    if (
      pot.potIndex !== index ||
      !Number.isFinite(pot.amount) ||
      pot.amount <= 0 ||
      pot.eligiblePlayerIds.length === 0 ||
      new Set(pot.eligiblePlayerIds).size !== pot.eligiblePlayerIds.length ||
      pot.eligiblePlayerIds.some((id) => !playerIdSet.has(id))
    ) {
      throw new Error('Layered equity contains an invalid pot layer');
    }
    return { amount: pot.amount, eligiblePlayers: [...pot.eligiblePlayerIds] };
  });
  const totalGross = normalizedPots.reduce((sum, pot) => sum + pot.amount, 0);
  const netWinnings = totalWinnings ?? totalGross;
  if (
    !Number.isFinite(netWinnings) ||
    netWinnings < 0 ||
    netWinnings > totalGross + Math.max(0.005, chipUnit / 2) ||
    !Number.isFinite(chipUnit) ||
    chipUnit <= 0
  ) {
    throw new Error('Layered equity contains an invalid settlement amount');
  }
  if (
    boards.length === 0 ||
    boards.length > 3 ||
    boards.some((board) => !Array.isArray(board) || board.length > 5)
  ) {
    throw new Error('Layered equity contains an invalid board set');
  }
  const equities = new Array<number>(n).fill(0);
  const layerEquities = normalizedPots.map(() => new Array<number>(n).fill(0));
  const expectedNetReturns = new Array<number>(n).fill(0);
  const strictLossPcts = new Array<number>(n).fill(0);
  const pushPcts = new Array<number>(n).fill(0);
  const knownForSeed = [
    ...hands
      .flat()
      .map(cardKey)
      .map((key) => `h:${key}`),
    ...boards.flatMap((board, boardIndex) =>
      board.map((knownCard) => `b${boardIndex}:${cardKey(knownCard)}`)
    ),
    ...deadCards.map((knownCard) => `d:${cardKey(knownCard)}`),
  ].sort();
  const useSeed = seed ?? hashSeed(iters, ...knownForSeed);
  if (n === 0) {
    return {
      equities,
      layerEquities,
      expectedNetReturns,
      strictLossPcts,
      pushPcts,
      seed: useSeed,
      exact: true,
      runouts: 0,
    };
  }

  const shortDeck = isShortDeckVariant(variant);
  assertCardUniverse(hands, boards, deadCards, shortDeck);
  const needs = boards.map((board) => Math.max(0, 5 - board.length));
  const totalNeed = needs.reduce((sum, need) => sum + need, 0);
  const known = new Set<string>();
  for (const hand of hands) for (const card of hand) known.add(cardKey(card));
  for (const card of boards.flat()) known.add(cardKey(card));
  for (const card of deadCards) known.add(cardKey(card));
  const baseDeck = shortDeck
    ? FULL_DECK.filter((card) => !SHORT_DECK_REMOVED.has(card.rank))
    : FULL_DECK;
  const remaining = baseDeck.filter((card) => !known.has(cardKey(card)));
  if (remaining.length < totalNeed) {
    throw new Error('Not enough unseen cards to complete layered equity runout');
  }

  const settlementUnitsPerChip = Math.round(1 / chipUnit);
  if (
    !Number.isSafeInteger(settlementUnitsPerChip) ||
    settlementUnitsPerChip <= 0 ||
    Math.abs(settlementUnitsPerChip * chipUnit - 1) > 1e-9
  ) {
    throw new Error('Layered equity chip unit is not an exact settlement unit');
  }
  const potsByBoard: Pot[][] = Array.from({ length: boards.length }, () => []);
  normalizedPots.forEach((pot) => {
    const units = Math.round(pot.amount * settlementUnitsPerChip);
    const base = Math.floor(units / boards.length);
    const remainder = units % boards.length;
    for (let boardIndex = 0; boardIndex < boards.length; boardIndex++) {
      potsByBoard[boardIndex].push({
        amount: (base + (boardIndex < remainder ? 1 : 0)) / settlementUnitsPerChip,
        eligiblePlayers: [...pot.eligiblePlayers],
      });
    }
  });

  const players = hands.map(
    (cards, index) =>
      ({
        seat: playerSeats[index],
        user_id: playerIds[index],
        username: playerIds[index],
        stack: 0,
        bet: 0,
        totalInvested: 0,
        cards,
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
      }) as SeatPlayer
  );

  let runouts = 0;
  const score = (fullBoards: Card[][]): void => {
    // Preserve the historical/public meaning: showdown equity against the
    // complete field, independent of unequal side-pot amounts. 5040 units is
    // divisible by 1..9 both before and after the hi/lo split, so settlement can
    // express every tie without an odd-unit bias.
    const displayPotAmount = 5040 * chipUnit;
    const rawByUser = new Map<string, number>();
    for (let boardIndex = 0; boardIndex < fullBoards.length; boardIndex++) {
      const displayWinners = determineWinners(
        players,
        fullBoards[boardIndex],
        [{ amount: displayPotAmount, eligiblePlayers: [...playerIds] }],
        variant,
        dealerSeat,
        undefined,
        undefined,
        chipUnit
      );
      displayWinners.forEach((winner) => {
        const playerIndex = playerIds.indexOf(winner.userId);
        if (playerIndex < 0) throw new Error('Layered display winner is outside the player set');
        equities[playerIndex] += winner.amount / displayPotAmount / fullBoards.length;
      });
      const displayWinnerIds = new Set(displayWinners.map((winner) => winner.userId));
      for (let playerIndex = 0; playerIndex < playerIds.length; playerIndex++) {
        if (!displayWinnerIds.has(playerIds[playerIndex])) {
          strictLossPcts[playerIndex] += 1 / fullBoards.length;
        } else if (displayWinnerIds.size > 1) {
          pushPcts[playerIndex] += 1 / fullBoards.length;
        }
      }

      const perPotAwards: PerPotAward[] = [];
      const boardWinners = determineWinners(
        players,
        fullBoards[boardIndex],
        potsByBoard[boardIndex],
        variant,
        dealerSeat,
        perPotAwards,
        undefined,
        chipUnit
      );
      boardWinners.forEach((winner) =>
        rawByUser.set(winner.userId, (rawByUser.get(winner.userId) ?? 0) + winner.amount)
      );
      perPotAwards.forEach((award) => {
        const playerIndex = playerIds.indexOf(award.userId);
        const originalPot = normalizedPots[award.potIndex];
        if (playerIndex < 0 || !originalPot) {
          throw new Error('Layered equity award is outside the frozen pot scope');
        }
        layerEquities[award.potIndex][playerIndex] += award.amount / originalPot.amount;
      });
    }
    const rawEntries = [...rawByUser.entries()];
    const winnerCents = scaleWinnerCentsForRake(
      rawEntries.map(([, amount]) => amount),
      netWinnings
    );
    rawEntries.forEach(([userId], index) => {
      const playerIndex = playerIds.indexOf(userId);
      if (playerIndex < 0) throw new Error('Layered equity winner is outside the player set');
      expectedNetReturns[playerIndex] += winnerCents[index] / 100;
    });
    runouts += 1;
  };

  if (totalNeed === 0) {
    score(boards);
    return {
      equities,
      layerEquities,
      expectedNetReturns,
      strictLossPcts: strictLossPcts.map((value) => value * 100),
      pushPcts: pushPcts.map((value) => value * 100),
      seed: useSeed,
      exact: true,
      runouts,
    };
  }
  // Single-board turn/flop paths can be enumerated exactly. Multiple boards
  // require an ordered partition of the remaining deck, so they share one
  // deterministic Monte Carlo stream and one settlement per sampled outcome.
  const exact = boards.length === 1 && countCombos(remaining.length, totalNeed) <= 20_000;
  if (exact) {
    visitCombinations(remaining, totalNeed, (runout) => score([boards[0].concat(runout)]));
  } else {
    const rng = new SeededRandom(useSeed);
    for (let iteration = 0; iteration < iters; iteration++) {
      rng.shuffle(remaining);
      let cursor = 0;
      const fullBoards = boards.map((board, boardIndex) => {
        const drawn = remaining.slice(cursor, cursor + needs[boardIndex]);
        cursor += needs[boardIndex];
        return board.concat(drawn);
      });
      score(fullBoards);
    }
  }
  for (let index = 0; index < equities.length; index++) equities[index] /= runouts;
  for (const layer of layerEquities) {
    for (let index = 0; index < layer.length; index++) layer[index] /= runouts;
  }
  for (let index = 0; index < expectedNetReturns.length; index++) {
    expectedNetReturns[index] /= runouts;
    strictLossPcts[index] = (strictLossPcts[index] / runouts) * 100;
    pushPcts[index] = (pushPcts[index] / runouts) * 100;
  }
  return {
    equities,
    layerEquities,
    expectedNetReturns,
    strictLossPcts,
    pushPcts,
    seed: useSeed,
    exact,
    runouts,
  };
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
          msg.shortDeck ?? false,
          msg.deadCards ?? []
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
      } else if (msg?.type === 'LAYERED_EQUITY') {
        const result = computeLayeredEquity(
          msg.hands,
          msg.playerIds,
          msg.playerSeats,
          msg.boards,
          msg.deadCards ?? [],
          msg.iters ?? 1000,
          msg.variant ?? 'nlh',
          msg.pots ?? [],
          msg.dealerSeat ?? 0,
          msg.totalWinnings,
          msg.chipUnit ?? 0.01,
          msg.seed
        );
        port.postMessage({ type: 'LAYERED_EQUITY_RESULT', id: msg.id, ...result });
      } else {
        throw new Error(`Unsupported equity worker operation: ${String(msg?.type)}`);
      }
    } catch (e: any) {
      port.postMessage({ type: 'ERROR', id: msg?.id, error: String(e?.message ?? e) });
    }
  });
}
