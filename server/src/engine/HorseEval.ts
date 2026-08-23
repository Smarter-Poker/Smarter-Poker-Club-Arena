/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE EVAL — Hand Evaluators, Monte Carlo Equity, Preflop Scores (V7 split)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Extracted verbatim from HorseLogic.ts (V7 — 2026-07-24) purely to keep each
 * module a reviewable size; ZERO behavior change. Contains:
 *  - the fast xorshift PRNG shared by decision mixing and MC deals
 *  - variant helpers (hole counts, Omaha/pot-limit flags, deck selection)
 *  - the zero-allocation hand evaluators (holdem/short-deck/Omaha hi/lo,
 *    partial-board Omaha) used by both equity sim and street IQ
 *  - simulateEquity: range-conditioned rejection-sampled Monte Carlo with the
 *    V7 adaptive early exit (checkpointed, threshold-distance gated)
 *  - preflop percentile scores per variant + the preflop equity cache
 *
 * V8 (2026-07-24) additions:
 *  - HiLoSplit: hi/lo/scoop/quarter decomposition for plo8, filled inside the
 *    same MC loop at zero extra cost
 *  - omahaDrawQuality: nut vs dominated flush draws + wrap detection by
 *    direct out-enumeration (lazy, semi-bluff band only)
 *  - A23 counterfeit backup bonus in the O8 preflop score
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import type { Card } from '../types.js';
import { SUITS, RANKS, RANK_VALUES } from './PokerEngine.js';

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// ═══════════════════════════════════════════════════════════════════════════════
// FAST PRNG — strategy mixing does not need crypto randomness, it needs speed.
// (Card dealing uses CryptoRandom; this is only for decision mixing + MC deals.)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Seed selection.
 *
 * This was `Date.now() ^ 0x9e3779b9`, unconditionally — and it was the real
 * source of the long-standing `HorseLogic V10` test flakiness. Seeding
 * Math.random in the test file did nothing for it, because the V10 A/B blocks
 * drive simulateEquity, which draws from HERE. Every run got a different stream,
 * so two statistical assertions flipped red roughly one run in three and taught
 * everyone to re-run a red suite instead of reading it.
 *
 *   - HORSE_FUZZ_SEED=<n>  pin the stream explicitly (tests, or reproducing a
 *                          specific decision sequence while debugging)
 *   - under vitest         pinned automatically, so the suite is reproducible
 *                          without every test file having to remember to do it
 *   - otherwise            time-seeded, so production restarts are not
 *                          correlated with each other
 */
const FAST_RNG_SEED =
  Number(process.env.HORSE_FUZZ_SEED) || (process.env.VITEST ? 0x5eed1e : Date.now() ^ 0x9e3779b9);

// xorshift32 is a fixed point at 0 — a zero state emits zeros forever — so the
// seed is forced non-zero here and in seedFastRandom.
let rngState = FAST_RNG_SEED >>> 0 || 1;

/** Pin the strategy/Monte-Carlo stream. Exported for tests and for replaying a decision. */
export function seedFastRandom(seed: number): void {
  rngState = seed >>> 0 || 1;
}

/**
 * V12.3: snapshot / restore the stream position.
 *
 * `rngState` is a MODULE GLOBAL shared by every live decision — bluff dice,
 * sizing jitter, Monte Carlo sampling. The self-play league seeds it once per
 * synthetic hand, which silently rewinds the live stream to a value derived
 * entirely from the run date (see HorseLeague.runMatchup, which now brackets
 * every matchup with these two calls). Without the bracket, live decisions
 * made after a league run draw from a publicly predictable stream — the exact
 * property the boot-time seed at the top of this file exists to prevent.
 */
export function saveFastRandom(): number {
  return rngState;
}

export function restoreFastRandom(state: number): void {
  rngState = state >>> 0 || 1;
}

export function fastRandom(): number {
  // xorshift32 — ~4x faster than Math.random in tight MC loops and good enough
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  // V13 (2026-08-23): divide by 2^32, NOT 2^32-1. xorshift32's period covers
  // every non-zero state, so rngState hits 0xffffffff exactly once per period
  // and this returned EXACTLY 1.0. Every consumer here is
  // `Math.floor(fastRandom() * (n - i))`, which then yields `n - i`, so the
  // partial Fisher-Yates swapped in `deck[n]` — undefined — and extended the
  // array, corrupting the rest of that simulation. The undefined card reaches
  // scoreHoldem, throws on `.rank`, and HorseLogic.decide's safety net turns
  // it into a FOLD. Roughly one silent, unexplained fold of an arbitrary hand
  // per 2^32 draws, fleet-wide, with no telemetry. [0, 1) is the contract.
  return rngState / 0x100000000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export type VariantInfo = {
  holeCount: number;
  isOmaha: boolean;
  isHiLo: boolean;
  isShortDeck: boolean;
  isPotLimit: boolean;
  /** MC iterations per street decision (budgeted for <15ms total) */
  iterations: number;
};

export function variantInfo(gameVariant: string): VariantInfo {
  const v = (gameVariant || 'nlh').toLowerCase();
  const isOmaha = v.startsWith('plo');
  const holeCount = v === 'plo5' ? 5 : v === 'plo6' ? 6 : isOmaha ? 4 : v === 'pineapple' ? 3 : 2;
  return {
    holeCount,
    isOmaha,
    isHiLo: v === 'plo8',
    isShortDeck: v === 'short_deck',
    isPotLimit: isOmaha,
    iterations: v === 'plo6' ? 120 : v === 'plo5' ? 170 : v === 'plo8' ? 140 : isOmaha ? 220 : 450,
  };
}

const FULL_DECK: Card[] = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    FULL_DECK.push({ rank, suit });
  }
}
const SHORT_DECK_REMOVED = new Set(['2', '3', '4', '5']);
const SHORT_DECK_CARDS: Card[] = FULL_DECK.filter((c) => !SHORT_DECK_REMOVED.has(c.rank));

const cardKey = (c: Card): string => `${c.rank}${c.suit[0]}`;

// ═══════════════════════════════════════════════════════════════════════════════
// FAST HAND EVALUATOR — allocation-free, used ONLY inside the Monte Carlo loop.
// Produces a single comparable number per hand. Mirrors PokerEngine rankings
// including Short Deck rules (flush > full house, A-6-7-8-9 wheel).
// ═══════════════════════════════════════════════════════════════════════════════

// Scratch buffers reused across evaluations (single-threaded server).
const evRankCount = new Int32Array(15);
const evSuitCount = new Int32Array(4);
const evSuitMask = new Int32Array(4);
const SUIT_INDEX: Record<string, number> = { hearts: 0, diamonds: 1, clubs: 2, spades: 3 };

/** Find the top rank of a straight within a rank bitmask, or 0 if none. */
export function straightTop(mask: number, shortDeck: boolean): number {
  for (let top = 14; top >= 6; top--) {
    const run = 0b11111 << (top - 4);
    if ((mask & run) === run) return top;
  }
  if (shortDeck) {
    // A-6-7-8-9 wheel
    const need = (1 << 14) | (1 << 9) | (1 << 8) | (1 << 7) | (1 << 6);
    if ((mask & need) === need) return 9;
  } else {
    // A-2-3-4-5 wheel
    const need = (1 << 14) | (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2);
    if ((mask & need) === need) return 5;
  }
  return 0;
}

/**
 * Score any 5-8 card holdem-style hand (best 5 of N). Bigger = better.
 * Encoding: category * 2^20 + 20-bit tiebreak.
 */
export function scoreHoldem(cards: Card[], count: number, shortDeck: boolean): number {
  evRankCount.fill(0);
  evSuitCount.fill(0);
  evSuitMask.fill(0);
  let rankMask = 0;

  for (let i = 0; i < count; i++) {
    const r = RANK_VALUES[cards[i].rank];
    const s = SUIT_INDEX[cards[i].suit];
    evRankCount[r]++;
    evSuitCount[s]++;
    evSuitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  const CAT_FLUSH = shortDeck ? 7 : 6;
  const CAT_FULLHOUSE = shortDeck ? 6 : 7;

  // Straight flush
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (evSuitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sfTop = straightTop(evSuitMask[flushSuit], shortDeck);
    if (sfTop > 0) return (sfTop === 14 ? 10 : 9) * 0x100000 + sfTop;
  }

  // Quads
  let quad = 0;
  let trips = 0;
  let trips2 = 0;
  let pairHi = 0;
  let pairLo = 0;
  for (let r = 14; r >= 2; r--) {
    const c = evRankCount[r];
    if (c === 4 && quad === 0) quad = r;
    else if (c === 3) {
      if (trips === 0) trips = r;
      else if (trips2 === 0) trips2 = r;
    } else if (c === 2) {
      if (pairHi === 0) pairHi = r;
      else if (pairLo === 0) pairLo = r;
    }
  }

  if (quad > 0) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) {
      if (r !== quad && evRankCount[r] > 0) {
        kicker = r;
        break;
      }
    }
    return 8 * 0x100000 + quad * 16 + kicker;
  }

  // Full house (second trips counts as the pair)
  const fhPair = Math.max(pairHi, trips2);
  if (trips > 0 && fhPair > 0) {
    return CAT_FULLHOUSE * 0x100000 + trips * 16 + fhPair;
  }

  // Flush — top 5 ranks of the flush suit
  if (flushSuit >= 0) {
    let tb = 0;
    let found = 0;
    const m = evSuitMask[flushSuit];
    for (let r = 14; r >= 2 && found < 5; r--) {
      if (m & (1 << r)) {
        tb = tb * 16 + r;
        found++;
      }
    }
    return CAT_FLUSH * 0x100000 + tb;
  }

  // Straight
  const st = straightTop(rankMask, shortDeck);
  if (st > 0) return 5 * 0x100000 + st;

  // Trips
  if (trips > 0) {
    let tb = trips;
    let found = 0;
    for (let r = 14; r >= 2 && found < 2; r--) {
      if (r !== trips && evRankCount[r] > 0) {
        tb = tb * 16 + r;
        found++;
      }
    }
    return 4 * 0x100000 + tb;
  }

  // Two pair
  if (pairHi > 0 && pairLo > 0) {
    let kicker = 0;
    for (let r = 14; r >= 2; r--) {
      if (r !== pairHi && r !== pairLo && evRankCount[r] > 0) {
        kicker = r;
        break;
      }
    }
    return 3 * 0x100000 + pairHi * 256 + pairLo * 16 + kicker;
  }

  // One pair
  if (pairHi > 0) {
    let tb = pairHi;
    let found = 0;
    for (let r = 14; r >= 2 && found < 3; r--) {
      if (r !== pairHi && evRankCount[r] > 0) {
        tb = tb * 16 + r;
        found++;
      }
    }
    return 2 * 0x100000 + tb;
  }

  // High card — top 5 ranks
  let tb = 0;
  let found = 0;
  for (let r = 14; r >= 2 && found < 5; r--) {
    if (rankMask & (1 << r)) {
      tb = tb * 16 + r;
      found++;
    }
  }
  return 1 * 0x100000 + tb;
}

// Precomputed index combinations for Omaha evaluation.
const PAIR_COMBOS: Record<number, number[][]> = {};
for (let n = 2; n <= 6; n++) {
  const combos: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) combos.push([i, j]);
  PAIR_COMBOS[n] = combos;
}
const BOARD_TRIPLES: number[][] = [];
for (let i = 0; i < 5; i++)
  for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) BOARD_TRIPLES.push([i, j, k]);

const omahaScratch: Card[] = new Array(5);

/** Omaha high: exactly 2 hole + 3 board. Bigger = better. */
export function scoreOmahaHi(hole: Card[], board: Card[]): number {
  const pairs = PAIR_COMBOS[hole.length] || PAIR_COMBOS[4];
  let best = 0;
  for (const [a, b] of pairs) {
    omahaScratch[0] = hole[a];
    omahaScratch[1] = hole[b];
    for (const [x, y, z] of BOARD_TRIPLES) {
      omahaScratch[2] = board[x];
      omahaScratch[3] = board[y];
      omahaScratch[4] = board[z];
      const s = scoreHoldem(omahaScratch, 5, false);
      if (s > best) best = s;
    }
  }
  return best;
}

// V4 (2026-07-23): board triples for PARTIAL boards (flop/turn) so the made-hand
// classifier can score Omaha hands before the river. The hot MC path still uses
// the precomputed 5-card BOARD_TRIPLES above.
const TRIPLES_BY_LEN: Record<number, number[][]> = { 5: BOARD_TRIPLES };
for (const len of [3, 4]) {
  const t: number[][] = [];
  for (let i = 0; i < len; i++)
    for (let j = i + 1; j < len; j++) for (let k = j + 1; k < len; k++) t.push([i, j, k]);
  TRIPLES_BY_LEN[len] = t;
}

/** Omaha high on a 3-5 card board (2 hole + 3 board). Bigger = better. */
export function scoreOmahaHiPartial(hole: Card[], board: Card[]): number {
  const triples = TRIPLES_BY_LEN[board.length];
  if (!triples) return 0;
  const pairs = PAIR_COMBOS[hole.length] || PAIR_COMBOS[4];
  let best = 0;
  for (const [a, b] of pairs) {
    omahaScratch[0] = hole[a];
    omahaScratch[1] = hole[b];
    for (const [x, y, z] of triples) {
      omahaScratch[2] = board[x];
      omahaScratch[3] = board[y];
      omahaScratch[4] = board[z];
      const s = scoreHoldem(omahaScratch, 5, false);
      if (s > best) best = s;
    }
  }
  return best;
}

const LOW_RANK = (r: number): number => (r === 14 ? 1 : r);

/**
 * Omaha 8-or-better low: exactly 2 hole + 3 board, five DISTINCT ranks all <= 8
 * (ace plays low). Returns an encoded value where SMALLER = better, or
 * Infinity when no qualifying low exists.
 */
export function scoreOmahaLow(hole: Card[], board: Card[]): number {
  const pairs = PAIR_COMBOS[hole.length] || PAIR_COMBOS[4];
  let best = Infinity;
  for (const [a, b] of pairs) {
    const h1 = LOW_RANK(RANK_VALUES[hole[a].rank]);
    const h2 = LOW_RANK(RANK_VALUES[hole[b].rank]);
    if (h1 > 8 || h2 > 8 || h1 === h2) continue;
    for (const [x, y, z] of BOARD_TRIPLES) {
      const b1 = LOW_RANK(RANK_VALUES[board[x].rank]);
      const b2 = LOW_RANK(RANK_VALUES[board[y].rank]);
      const b3 = LOW_RANK(RANK_VALUES[board[z].rank]);
      if (b1 > 8 || b2 > 8 || b3 > 8) continue;
      // All five must be distinct
      const mask = (1 << h1) | (1 << h2) | (1 << b1) | (1 << b2) | (1 << b3);
      let bits = mask;
      let cnt = 0;
      while (bits) {
        bits &= bits - 1;
        cnt++;
      }
      if (cnt !== 5) continue;
      // Encode highest-card-first — lexicographic compare, smaller = better low
      let v = 0;
      for (let r = 8; r >= 1; r--) {
        if (mask & (1 << r)) v = v * 16 + r;
      }
      if (v < best) best = v;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V8 OMAHA DRAW QUALITY — nut draws vs dominated draws, wraps
// ═══════════════════════════════════════════════════════════════════════════════

export interface OmahaDrawInfo {
  /** flush draw to the NUT flush (ace of suit, or king when the ace is on board) */
  nutFlushDraw: boolean;
  /** flush draw that is NOT to the nuts — the classic PLO trap hand */
  dominatedFlushDraw: boolean;
  /** deck cards that improve hero to a straight or straight flush */
  straightOuts: number;
  /** 9+ straight outs — a true wrap */
  bigWrap: boolean;
  /** the draw is worth fighting for: nut flush draw or a big wrap */
  nutty: boolean;
}

const NO_DRAW_INFO: OmahaDrawInfo = {
  nutFlushDraw: false,
  dominatedFlushDraw: false,
  straightOuts: 0,
  bigWrap: false,
  nutty: false,
};

/**
 * Classify hero's Omaha draws on a 3-4 card board. The engine's biggest
 * historical PLO leak was treating every flush draw alike — pros punish
 * dominated flush draws relentlessly. Straight outs are counted by direct
 * enumeration (each unseen card, does it make hero a straight or better
 * straight-family hand). Called lazily and only in the semi-bluff decision
 * band, so the enumeration cost never touches value-hand decisions.
 */
export function omahaDrawQuality(hole: Card[], board: Card[]): OmahaDrawInfo {
  if (!hole || hole.length < 4 || !board || board.length < 3 || board.length > 4) {
    return NO_DRAW_INFO;
  }
  try {
    // Flush draws: a suit with exactly 2 on board and 2+ in hand (Omaha
    // requires exactly two hole cards to play).
    const suitOnBoard = new Map<string, number>();
    for (const c of board) suitOnBoard.set(c.suit, (suitOnBoard.get(c.suit) || 0) + 1);
    let nutFlushDraw = false;
    let dominatedFlushDraw = false;
    for (const [suit, n] of suitOnBoard) {
      if (n !== 2) continue;
      const heroSuited = hole.filter((c) => c.suit === suit);
      if (heroSuited.length >= 2) {
        const hasAce = heroSuited.some((c) => c.rank === 'A');
        const aceOnBoard = board.some((c) => c.suit === suit && c.rank === 'A');
        const hasKing = heroSuited.some((c) => c.rank === 'K');
        if (hasAce || (aceOnBoard && hasKing)) nutFlushDraw = true;
        else dominatedFlushDraw = true;
      }
    }

    // Straight outs by enumeration (straight family only: 5, 9, 10 — flushes
    // and boats are tracked separately and would double-count otherwise).
    let straightOuts = 0;
    const cur = scoreOmahaHiPartial(hole, board);
    if (Math.floor(cur / 0x100000) < 5) {
      const used = new Set<string>();
      for (const c of hole) used.add(cardKey(c));
      for (const c of board) used.add(cardKey(c));
      const extended = [...board, board[0]]; // placeholder slot, replaced below
      for (const c of FULL_DECK) {
        if (used.has(cardKey(c))) continue;
        extended[extended.length - 1] = c;
        const cat = Math.floor(scoreOmahaHiPartial(hole, extended) / 0x100000);
        if (cat === 5 || cat >= 9) straightOuts++;
      }
    }

    const bigWrap = straightOuts >= 9;
    return {
      nutFlushDraw,
      dominatedFlushDraw,
      straightOuts,
      bigWrap,
      nutty: nutFlushDraw || bigWrap,
    };
  } catch {
    return NO_DRAW_INFO;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO EQUITY — variant-aware, opponent-count-aware, draw-aware
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * V8 hi-lo decomposition of a plo8 equity estimate. Filled by simulateEquity
 * when passed as `splitOut` so the caller can tell a SCOOP (whole pot both
 * ways) from a nut-low-only hand that is about to be QUARTERED — the single
 * most important strategic distinction in O8.
 */
export interface HiLoSplit {
  /** average share of the HI half (or the whole pot when no low qualifies) */
  hi: number;
  /** average share of the LO half */
  lo: number;
  /** fraction of runouts where hero took the ENTIRE pot */
  scoop: number;
  /** fraction of runouts where hero took a quarter or less (but not zero) */
  quarter: number;
}

/**
 * V12 BOARD-CONDITIONED SAMPLING (2026-08-22): per-opponent postflop read.
 * `aggrW` is the summed street-narrowing weight of their postflop aggression
 * (0 = never bet); `checked` counts postflop streets where they showed no
 * aggression despite acting. Aggressors get sampled toward hands that
 * CONNECT with the current board; passive lines get their monsters
 * down-sampled (a capped range stays capped).
 */
export interface OppPostflopRead {
  aggrW: number;
  checked: number;
}

/** Does this NLH-family hand connect with the CURRENT board — a pair or
 *  better using it, a flush draw, or an open straight draw? */
export function connectsBoard(hole: Card[], board: Card[], shortDeck: boolean): number {
  // Returns the made CATEGORY (1..10) using hole+board; draws return 2
  // ("pair-equivalent connection") so the acceptance logic treats a real
  // draw like real contact.
  const all = hole.concat(board);
  const cat = Math.floor(scoreHoldem(all, all.length, shortDeck) / 0x100000);
  // V13: the hole cards must IMPROVE on what the board already makes. This
  // scored the board's own hand as opponent contact, so on any paired board
  // (~17% of flops) every holding "connected" — 32o on K K 7 returned a pair
  // of kings — and the whole V12 board-contact conditioning became a no-op
  // exactly where reads matter most. A pocket pair stays contact by intent.
  const boardCat =
    board.length > 0 ? Math.floor(scoreHoldem(board, board.length, shortDeck) / 0x100000) : 0;
  const isPocketPair = hole.length === 2 && hole[0].rank === hole[1].rank;
  if (cat >= 2 && (cat > boardCat || isPocketPair)) {
    // A pocket pair UNDER every board card is a hidden non-connector — but it
    // still bets sometimes; treat pocket pairs as contact.
    return cat;
  }
  if (board.length >= 5) return cat; // river: no draws left
  // Flush draw: 4 to a flush with at least one hole card of the suit.
  const suitCount = new Map<string, number>();
  for (const c of all) suitCount.set(c.suit, (suitCount.get(c.suit) || 0) + 1);
  for (const [suit, n] of suitCount) {
    if (n >= 4 && hole.some((h) => h.suit === suit)) return 2;
  }
  // Open-ended-ish: 4 distinct ranks inside a 5-window using a hole card.
  let mask = 0;
  for (const c of all) mask |= 1 << RANK_VALUES[c.rank];
  for (let top = 14; top >= 5; top--) {
    let inWin = 0;
    for (let r = top; r > top - 5 && r >= 2; r--) if (mask & (1 << r)) inWin++;
    if (inWin >= 4) {
      // must use a hole card inside the window
      for (const h of hole) {
        const hr = RANK_VALUES[h.rank];
        if (hr <= top && hr > top - 5) return 2;
      }
    }
  }
  return cat;
}

/**
 * Estimate hero's equity (0..1) vs `numOpponents` random hands. Handles all
 * supported variants. Draws are priced naturally because the runout completes
 * the board every iteration.
 */
export function simulateEquity(
  holeCards: Card[],
  boardCards: Card[],
  numOpponents: number,
  vi: VariantInfo,
  iterations: number,
  // V3: optional per-opponent preflop-strength bands (from HorseMind range
  // reads). When provided, opponent hole cards are REJECTION-SAMPLED from the
  // band instead of dealt uniformly — equity vs their actual range, not vs
  // random. null entries fall back to uniform sampling.
  oppBands?: Array<[number, number] | null>,
  // V7: adaptive early exit — stop sampling once the estimate is far from
  // every decision threshold (3 standard errors). Cuts typical latency 2-3x
  // and banks the headroom for the decisions that are actually close.
  adaptive?: boolean,
  // V8: hi-lo decomposition accumulator (plo8 only) — filled in the SAME
  // loop, so the scoop/quarter read costs nothing extra.
  splitOut?: HiLoSplit,
  // V12: board-contact conditioning per opponent (NLH family only).
  oppReads?: Array<OppPostflopRead | null>
): number {
  // V3 perf: banded Omaha sampling adds rejection-scoring cost; trim the
  // iteration count to stay inside the per-decision millisecond budget.
  if (oppBands && vi.isOmaha) {
    // Multiway banded pots multiply the rejection-sampling cost per iteration;
    // scale the iteration count down harder to hold the latency budget.
    iterations = Math.max(60, Math.floor(iterations * (numOpponents >= 3 ? 0.5 : 0.65)));
  }
  const known = new Set<string>();
  for (const c of holeCards) known.add(cardKey(c));
  for (const c of boardCards) known.add(cardKey(c));

  const base = vi.isShortDeck ? SHORT_DECK_CARDS : FULL_DECK;
  const deck = base.filter((c) => !known.has(cardKey(c)));

  const boardNeeded = 5 - boardCards.length;
  // Opponents hold as many cards as the hero currently does (pineapple horses
  // hold 3 preflop but 2 after the discard — opponents mirror that).
  const oppHole = vi.isOmaha ? vi.holeCount : holeCards.length;
  const cardsNeeded = boardNeeded + numOpponents * oppHole;
  if (deck.length < cardsNeeded || holeCards.length < 2) return 0.5;

  let score = 0; // pot share accumulated across iterations
  const n = deck.length;
  const board: Card[] = new Array(5);
  for (let i = 0; i < boardCards.length; i++) board[i] = boardCards[i];
  const oppCards: Card[] = new Array(oppHole);

  // V7 adaptive checkpoints: evaluate the running estimate at 40%/65%/85% of
  // the budget and stop when it is >3.5 standard errors from every threshold
  // the postflop strategy actually compares against. TUNED (duplicate-deal
  // ablation): later checkpoints + stricter margin than the first cut — keeps
  // nearly all the latency win with no measurable equity-precision cost.
  const V7_THRESHOLDS = [0.18, 0.3, 0.42, 0.52, 0.62, 0.8];
  const checkpoints = adaptive
    ? [
        Math.max(60, Math.floor(iterations * 0.4)),
        Math.floor(iterations * 0.65),
        Math.floor(iterations * 0.85),
      ]
    : null;
  let done = 0;

  for (let iter = 0; iter < iterations; iter++) {
    // Partial Fisher-Yates: we only need the first `cardsNeeded` cards.
    for (let i = 0; i < cardsNeeded; i++) {
      const j = i + Math.floor(fastRandom() * (n - i));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }

    let dealIdx = 0;
    for (let i = boardCards.length; i < 5; i++) board[i] = deck[dealIdx++];

    // Hero high score
    let heroHi: number;
    if (vi.isOmaha) {
      heroHi = scoreOmahaHi(holeCards, board);
    } else {
      // Hero cards + board evaluated as best-5-of-N
      const all = holeCards.concat(board);
      heroHi = scoreHoldem(all, all.length, vi.isShortDeck);
    }
    const heroLow = vi.isHiLo ? scoreOmahaLow(holeCards, board) : Infinity;

    let heroBestHi = true;
    let hiTies = 1;
    let bestLow = heroLow;
    let heroBestLow = heroLow !== Infinity;
    let lowTies = 1;
    let anyLow = heroLow !== Infinity;

    for (let o = 0; o < numOpponents; o++) {
      const windowStart = dealIdx;
      for (let c = 0; c < oppHole; c++) oppCards[c] = deck[dealIdx++];

      // V3: range-conditioned sampling. If this opponent has a band, resample
      // their card window until the drawn hand's preflop strength falls inside
      // it. Tries scale with band width (narrow ranges need more attempts) and
      // the BEST draw seen is kept when nothing lands in-band, so tight reads
      // stay tight instead of degrading toward random.
      const band = oppBands ? oppBands[o] : null;
      if (band) {
        const scoreOf = (cards: Card[]): number =>
          vi.isOmaha
            ? omahaPreflopScore(cards, vi.isHiLo)
            : cards.length === 3
              ? pineapplePreflopScore(cards, vi.isShortDeck)
              : holdemPreflopScore(cards[0], cards[1], vi.isShortDeck);
        const distOf = (s: number): number =>
          s < band[0] ? band[0] - s : s > band[1] ? s - band[1] : 0;

        const narrow = band[1] - band[0] < 0.45;
        const tries = vi.isOmaha ? (narrow ? 6 : 4) : narrow ? 14 : 6;

        let bestDist = distOf(scoreOf(oppCards));
        let bestKeys: string[] | null = null; // null = current window is best
        if (bestDist > 0) {
          bestKeys = [];
          for (let i = 0; i < oppHole; i++) bestKeys.push(cardKey(oppCards[i]));
          for (let t = 0; t < tries && bestDist > 0; t++) {
            // Redraw the window uniformly from the remainder of the deck.
            for (let i = 0; i < oppHole; i++) {
              const slot = windowStart + i;
              const j = slot + Math.floor(fastRandom() * (n - slot));
              const tmp = deck[slot];
              deck[slot] = deck[j];
              deck[j] = tmp;
              oppCards[i] = deck[slot];
            }
            const d = distOf(scoreOf(oppCards));
            if (d < bestDist) {
              bestDist = d;
              if (d === 0) {
                bestKeys = null; // current window is in-band — done
              } else {
                bestKeys = [];
                for (let i = 0; i < oppHole; i++) bestKeys.push(cardKey(oppCards[i]));
              }
            }
          }
          // Restore the best-seen draw into the window if the final redraw
          // was not it (cards were displaced into [windowStart, n) by swaps).
          if (bestKeys) {
            for (let i = 0; i < oppHole; i++) {
              const slot = windowStart + i;
              if (cardKey(deck[slot]) === bestKeys[i]) {
                oppCards[i] = deck[slot];
                continue;
              }
              for (let j = slot + 1; j < n; j++) {
                if (cardKey(deck[j]) === bestKeys[i]) {
                  const tmp = deck[slot];
                  deck[slot] = deck[j];
                  deck[j] = tmp;
                  break;
                }
              }
              oppCards[i] = deck[slot];
            }
          }
        }
      }

      // ═══ V12 BOARD-CONTACT CONDITIONING (NLH family, flop+) ═══
      // The preflop band says which hands an opponent STARTED with; it says
      // nothing about which of those hands bet this board. An aggressor's
      // sampled hands are pushed toward board CONTACT (pairs, draws) with a
      // probability scaled by how hard they have been betting; a passive
      // checked line gets its monsters down-sampled (capped stays capped).
      const read = oppReads ? oppReads[o] : null;
      if (read && !vi.isOmaha && boardCards.length >= 3) {
        const redraw = () => {
          for (let i = 0; i < oppHole; i++) {
            const slot = windowStart + i;
            const j = slot + Math.floor(fastRandom() * (n - slot));
            const tmp = deck[slot];
            deck[slot] = deck[j];
            deck[j] = tmp;
            oppCards[i] = deck[slot];
          }
        };
        if (read.aggrW > 0) {
          const pConnect = Math.min(0.9, 0.4 + read.aggrW * 2.2);
          for (let t = 0; t < 3; t++) {
            if (connectsBoard(oppCards, boardCards, vi.isShortDeck) >= 2) break;
            if (fastRandom() >= pConnect) break; // some of the range IS air
            redraw();
          }
        } else if (read.checked >= 1) {
          const cat = connectsBoard(oppCards, boardCards, vi.isShortDeck);
          if (cat >= 4 && fastRandom() < 0.55 + Math.min(0.25, read.checked * 0.12)) {
            redraw();
          }
        }
      }

      let oppHi: number;
      if (vi.isOmaha) {
        oppHi = scoreOmahaHi(oppCards, board);
      } else {
        const all = oppCards.concat(board);
        oppHi = scoreHoldem(all, all.length, vi.isShortDeck);
      }
      if (oppHi > heroHi) heroBestHi = false;
      else if (oppHi === heroHi) hiTies++;

      if (vi.isHiLo) {
        const oppLow = scoreOmahaLow(oppCards, board);
        if (oppLow !== Infinity) {
          anyLow = true;
          if (oppLow < bestLow) {
            bestLow = oppLow;
            heroBestLow = false;
            lowTies = 1;
          } else if (oppLow === bestLow && bestLow !== Infinity) {
            lowTies++;
          }
        }
      } else if (!heroBestHi) {
        // Non-hilo: once beaten we can stop early.
        break;
      }
    }

    const hiShare = heroBestHi ? 1 / hiTies : 0;
    if (!vi.isHiLo || !anyLow) {
      score += hiShare;
      if (splitOut) {
        splitOut.hi += hiShare;
        if (hiShare >= 0.999) splitOut.scoop++;
      }
    } else {
      const loShare = heroBestLow && bestLow !== Infinity ? 1 / lowTies : 0;
      const iterShare = hiShare * 0.5 + loShare * 0.5;
      score += iterShare;
      if (splitOut) {
        splitOut.hi += hiShare;
        splitOut.lo += loShare;
        if (iterShare >= 0.999) splitOut.scoop++;
        else if (iterShare > 0 && iterShare <= 0.26) splitOut.quarter++;
      }
    }
    done = iter + 1;

    if (
      checkpoints &&
      (done === checkpoints[0] || done === checkpoints[1] || done === checkpoints[2])
    ) {
      const eq = score / done;
      const se = Math.sqrt(Math.max(1e-6, eq * (1 - eq)) / done);
      let minDist = Infinity;
      for (const t of V7_THRESHOLDS) {
        const d = Math.abs(eq - t);
        if (d < minDist) minDist = d;
      }
      if (minDist > 3.5 * se) return finalizeSplit(splitOut, done, eq);
    }
  }

  return finalizeSplit(splitOut, done, score / done);
}

/** Normalize a HiLoSplit accumulator by the iterations actually run. */
function finalizeSplit(splitOut: HiLoSplit | undefined, done: number, eq: number): number {
  if (splitOut && done > 0) {
    splitOut.hi /= done;
    splitOut.lo /= done;
    splitOut.scoop /= done;
    splitOut.quarter /= done;
  }
  return eq;
}

// Small bounded cache for preflop equities (variant|opps|canonical-combo).
const preflopEquityCache = new Map<string, number>();
const PREFLOP_CACHE_MAX = 50_000;

function canonicalCombo(cards: Card[]): string {
  const sorted = [...cards].sort((a, b) => {
    const d = RANK_VALUES[b.rank] - RANK_VALUES[a.rank];
    return d !== 0 ? d : a.suit.localeCompare(b.suit);
  });
  const suitMap = new Map<string, string>();
  const labels = ['w', 'x', 'y', 'z'];
  let out = '';
  for (const c of sorted) {
    if (!suitMap.has(c.suit)) suitMap.set(c.suit, labels[suitMap.size]);
    out += c.rank + suitMap.get(c.suit)!;
  }
  return out;
}

export function preflopEquity(
  holeCards: Card[],
  numOpponents: number,
  vi: VariantInfo,
  variant: string
): number {
  const opps = Math.max(1, Math.min(numOpponents, 3));
  const key = `${variant}|${opps}|${canonicalCombo(holeCards)}`;
  const cached = preflopEquityCache.get(key);
  if (cached !== undefined) return cached;
  // Higher iteration count preflop — it is cached, so the cost amortizes to ~0.
  const iters = vi.isOmaha ? 220 : 500;
  const eq = simulateEquity(holeCards, [], opps, vi, iters);
  if (preflopEquityCache.size >= PREFLOP_CACHE_MAX) preflopEquityCache.clear();
  preflopEquityCache.set(key, eq);
  return eq;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREFLOP HAND CLASSIFICATION (NLHE family) — tiered 169-combo strength 0..1
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns a percentile-style strength score (0..1) for a 2-card holdem hand.
 * Hand-tuned tiers — NOT equity vs random (which overrates small pairs and
 * underrates AK-type hands for raise/3-bet decisions).
 */
export function holdemPreflopScore(c1: Card, c2: Card, shortDeck: boolean): number {
  const r1 = RANK_VALUES[c1.rank];
  const r2 = RANK_VALUES[c2.rank];
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const suited = c1.suit === c2.suit;
  const pair = r1 === r2;
  const gap = hi - lo;

  let score: number;

  if (pair) {
    if (hi === 14)
      score = 1.0; // AA
    else if (hi === 13)
      score = 0.98; // KK
    else if (hi === 12)
      score = 0.95; // QQ
    else if (hi === 11)
      score = 0.9; // JJ
    else if (hi === 10)
      score = 0.86; // TT
    else if (hi === 9)
      score = 0.78; // 99
    else if (hi === 8)
      score = 0.72; // 88
    else if (hi === 7)
      score = 0.65; // 77
    else score = 0.45 + (hi - 2) * 0.03; // 22..66 -> 0.45..0.57
  } else if (hi === 14) {
    // Ace-high hands
    if (lo === 13)
      score = suited ? 0.96 : 0.93; // AK
    else if (lo === 12)
      score = suited ? 0.88 : 0.83; // AQ
    else if (lo === 11)
      score = suited ? 0.82 : 0.74; // AJ
    else if (lo === 10)
      score = suited ? 0.76 : 0.66; // AT
    else score = suited ? 0.52 + (lo - 2) * 0.008 : 0.34 + (lo - 2) * 0.01; // Axs / Axo
  } else if (hi === 13) {
    // King-high
    if (lo === 12)
      score = suited ? 0.79 : 0.7; // KQ
    else if (lo === 11)
      score = suited ? 0.73 : 0.62; // KJ
    else if (lo === 10)
      score = suited ? 0.68 : 0.56; // KT
    else score = suited ? 0.38 + (lo - 2) * 0.01 : 0.2 + (lo - 2) * 0.012;
  } else if (hi === 12) {
    if (lo === 11)
      score = suited ? 0.7 : 0.58; // QJ
    else if (lo === 10)
      score = suited ? 0.65 : 0.52; // QT
    else score = suited ? 0.34 + (lo - 2) * 0.01 : 0.16 + (lo - 2) * 0.011;
  } else if (hi === 11) {
    if (lo === 10)
      score = suited ? 0.64 : 0.5; // JT
    else if (lo === 9)
      score = suited ? 0.55 : 0.38; // J9
    else score = suited ? 0.3 + (lo - 2) * 0.01 : 0.12 + (lo - 2) * 0.01;
  } else {
    // Connectors / gappers / rags below jack-high
    const connected = gap === 1;
    const oneGap = gap === 2;
    if (connected && lo >= 4) {
      // 54s..T9s style hands
      score = suited ? 0.42 + (hi - 6) * 0.02 : 0.24 + (hi - 6) * 0.015;
    } else if (oneGap && lo >= 4) {
      score = suited ? 0.34 + (hi - 6) * 0.015 : 0.15 + (hi - 6) * 0.012;
    } else {
      score = suited ? 0.14 + hi * 0.012 : 0.02 + hi * 0.01;
    }
  }

  if (shortDeck) {
    // Short deck: suited/connected value rises, small pairs & offsuit rags
    // matter less, AK is effectively stronger (fewer dominated hands).
    if (suited) score += 0.03;
    if (!pair && gap <= 1) score += 0.03;
    if (pair && hi <= 9) score -= 0.04;
    if (hi === 14 && lo === 13) score += 0.02;
  }

  return clamp01(score);
}

/**
 * Omaha starting-hand quality 0..1 — Hutchison-style: high pairs, double-suited
 * to big cards, connected rundowns, penalize danglers. Works for 4/5/6 cards.
 */
export function omahaPreflopScore(cards: Card[], isHiLo: boolean): number {
  const ranks = cards.map((c) => RANK_VALUES[c.rank]).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  let pts = 0;

  // Pair points
  const rankCounts = new Map<number, number>();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  for (const [r, count] of rankCounts) {
    if (count === 2) {
      if (r === 14) pts += 8;
      else if (r >= 12) pts += 6;
      else if (r >= 10) pts += 4;
      else pts += 2;
    } else if (count >= 3) {
      pts -= 2; // trips in hand are dead cards in Omaha
    }
  }

  // Suit points — suited to the ace is the big one; double-suited best
  const suitCounts = new Map<string, number>();
  for (let i = 0; i < cards.length; i++) {
    const s = suits[i];
    suitCounts.set(s, (suitCounts.get(s) || 0) + 1);
  }
  let suitedGroups = 0;
  for (const [s, count] of suitCounts) {
    if (count >= 2) {
      suitedGroups++;
      const hasAce = cards.some((c) => c.suit === s && c.rank === 'A');
      pts += hasAce ? 4 : 2;
      if (count >= 4) pts -= 2; // 4 of one suit blocks own outs
    }
  }
  if (suitedGroups >= 2) pts += 2; // double-suited bonus

  // Connectivity — count distinct ranks forming tight rundowns
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  for (let i = 1; i < unique.length; i++) {
    const g = unique[i - 1] - unique[i];
    if (g === 1) pts += 2.5;
    else if (g === 2) pts += 1.2;
    else if (g === 3) pts += 0.5;
  }
  // High-card quality
  for (const r of ranks) {
    if (r === 14) pts += 1.5;
    else if (r >= 12) pts += 1;
    else if (r >= 10) pts += 0.5;
  }

  if (isHiLo) {
    // Low potential: A2 / A3 / 23 combos gain a lot of value in plo8
    const hasA = ranks.includes(14);
    const has2 = ranks.includes(2);
    const has3 = ranks.includes(3);
    if (hasA && has2)
      pts += has3 ? 7.5 : 6; // A23 carries counterfeit backup
    else if (hasA && has3) pts += 4;
    else if (has2 && has3) pts += 2;
    const lowCount = ranks.filter((r) => r <= 8 || r === 14).length;
    if (lowCount >= 3) pts += 1.5;
  }

  // Normalize: premium AAKK-ds style hands land around 28-32 points.
  return clamp01(pts / 30);
}

/** Pineapple (3-card) preflop: best 2-card combo + backup potential. */
export function pineapplePreflopScore(cards: Card[], shortDeck: boolean): number {
  let best = 0;
  let second = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const s = holdemPreflopScore(cards[i], cards[j], shortDeck);
      if (s > best) {
        second = best;
        best = s;
      } else if (s > second) {
        second = s;
      }
    }
  }
  return clamp01(best + second * 0.12);
}
