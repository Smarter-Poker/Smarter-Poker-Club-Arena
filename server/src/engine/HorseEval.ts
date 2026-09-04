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
import {
  holeCardCount,
  isOmahaVariant,
  isHiLoVariant,
  isShortDeckVariant,
} from './VariantRules.js';
import { isPotLimitVariant, isFixedLimitVariant } from './BettingStructure.js';

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
  /** V35: fixed-limit betting (flh, flo8) — the brain plays a different game. */
  isFixedLimit: boolean;
  /** MC iterations per street decision (budgeted for <15ms total) */
  iterations: number;
};

export function variantInfo(gameVariant: string): VariantInfo {
  const v = (gameVariant || 'nlh').toLowerCase();
  // 2026-08-23: every field here was its own substring test, and `flo8` failed
  // all of them — the horses would have read Fixed Limit Omaha Hi-Lo as a
  // two-card Hold'em board and priced every decision off the wrong hand.
  // `isPotLimit` was `isOmaha`, which is now doubly wrong: flo8 is an Omaha
  // game that is NOT pot-limit, so ask BettingStructure rather than inferring.
  const isOmaha = isOmahaVariant(v);
  const holeCount = holeCardCount(v);
  return {
    holeCount,
    isOmaha,
    isHiLo: isHiLoVariant(v),
    isShortDeck: isShortDeckVariant(v),
    isPotLimit: isPotLimitVariant(v),
    isFixedLimit: isFixedLimitVariant(v),
    // V28 AUDIT FIX (2026-08-29): hi-lo tested AFTER the plo5/plo6 literals
    // (so a future plo5/plo6 hi-lo string takes the right branch), and raised
    // from 140 to 220 — each hi-lo iteration returns hi*0.5 + lo*0.5 with
    // quarter/scoop atoms, the WIDEST per-iteration variance in the engine,
    // and it had the second-smallest sample while scoop/quarter frequencies
    // were read as discrete strategy triggers at ~4pp standard error.
    iterations: isHiLoVariant(v)
      ? 220
      : v === 'plo6'
        ? 120
        : v === 'plo5'
          ? 170
          : isOmaha
            ? 220
            : 450,
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
/**
 * ═══ V35 PINEAPPLE (2026-09-02): THREE CARDS, TWO PLAY ═══════════════════
 *
 * simulateEquity used to score a pineapple hand as hole + board, best five of
 * EIGHT — all three hole cards live to the river. They are not: one is thrown
 * away before the turn, so the truth is the best TWO-card keep, and the
 * eight-card read overstated every three-card combination (a three-card
 * flush draw that "makes" a flush with all three, a 3-card straight draw
 * using all three, trips in the hand plus one on board reading as a boat
 * when only two of the trips can be kept). Measured on the flop, the
 * overstatement ran up to ~8 equity points on exactly the coordinated
 * holdings a pineapple horse most needs to price honestly.
 *
 * Both hero and opponents hold three on the flop and are scored the same way.
 * Three evaluations of seven cards instead of one of eight; only on the one
 * street where three cards are held.
 */
const pineappleScratch: Card[] = new Array(7);
export function scoreBestTwoOfThree(hole: Card[], board: Card[], shortDeck: boolean): number {
  let best = 0;
  const n = board.length;
  for (let k = 0; k < n; k++) pineappleScratch[2 + k] = board[k];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      pineappleScratch[0] = hole[i];
      pineappleScratch[1] = hole[j];
      const sc = scoreHoldem(pineappleScratch, 2 + n, shortDeck);
      if (sc > best) best = sc;
    }
  }
  return best;
}

/**
 * ═══ V39 NEXT-STREET OUTLOOK (Dan 2026-09-03) ═══════════════════════════
 * "AFTER THEY MAKE A PLAY, THEY SHOULD ALREADY BE STARTING TO THINK ABOUT
 *  WHAT PLAY THEY WILL MAKE IF THEY GET CALLED OR RAISED, OR WHAT ARE 'GOOD
 *  CARDS' OR 'BAD CARDS' ON THE NEXT STREET."
 *
 * Every unseen card, classified for the hand hero holds on the board hero
 * sees: GOOD when it raises hero's made-hand category (a pair, a set, a
 * straight, a flush arriving), SCARE when it brings a third card of a suit
 * hero holds none of, or a fourth to a straight hero does not have, or
 * pairs the board under hero's flush/straight. Everything else is a blank.
 * The bet the horse makes now records this; the next street reads the card
 * that actually came against it (HorseMind street plans).
 *
 * Cost: one category evaluation per unseen card (<= 47), only when a bluff
 * or semi-bluff bet fires — the value hands do not need to know.
 */
export interface NextCardOutlook {
  /** card keys (e.g. "Ah") that improve hero's made hand */
  good: string[];
  /** card keys that put a hand hero does not hold on the board */
  scare: string[];
  /** hero's made category now */
  madeNow: number;
}

export function nextCardOutlook(hole: Card[], board: Card[], vi: VariantInfo): NextCardOutlook {
  const out: NextCardOutlook = { good: [], scare: [], madeNow: 0 };
  if (!hole || hole.length < 2 || !board || board.length < 3 || board.length >= 5) return out;
  const known = new Set<string>();
  for (const c of hole) known.add(cardKey(c));
  for (const c of board) known.add(cardKey(c));
  const base = vi.isShortDeck ? SHORT_DECK_CARDS : FULL_DECK;
  const cat = (b: Card[]): number => {
    try {
      const score = vi.isOmaha
        ? scoreOmahaHiPartial(hole, b)
        : hole.length === 3
          ? scoreBestTwoOfThree(hole, b, vi.isShortDeck)
          : scoreHoldem(hole.concat(b), hole.length + b.length, vi.isShortDeck);
      return Math.floor(score / 0x100000);
    } catch {
      return 0;
    }
  };
  out.madeNow = cat(board);
  // suits on board, and which of them hero holds
  const suitN = new Map<string, number>();
  for (const c of board) suitN.set(c.suit, (suitN.get(c.suit) || 0) + 1);
  const heroSuits = new Map<string, number>();
  for (const c of hole) heroSuits.set(c.suit, (heroSuits.get(c.suit) || 0) + 1);
  const rankN = new Map<string, number>();
  for (const c of board) rankN.set(c.rank, (rankN.get(c.rank) || 0) + 1);
  const CAT_STRAIGHT = 5;
  const CAT_FLUSH = vi.isShortDeck ? 7 : 6;
  const next: Card[] = board.slice();
  for (const c of base) {
    const k = cardKey(c);
    if (known.has(k)) continue;
    next[board.length] = c;
    const after = cat(next);
    if (after > out.madeNow) {
      out.good.push(k);
      continue;
    }
    // a third (or fourth) of a suit hero holds none of, when hero has no flush
    const suitAfter = (suitN.get(c.suit) || 0) + 1;
    const holdsSuit = (heroSuits.get(c.suit) || 0) >= (vi.isOmaha ? 2 : 1);
    if (suitAfter >= 3 && !holdsSuit && out.madeNow < CAT_FLUSH) {
      out.scare.push(k);
      continue;
    }
    // the board pairs under hero's straight or flush: boats are live
    if ((rankN.get(c.rank) || 0) >= 1 && out.madeNow >= CAT_STRAIGHT && out.madeNow <= CAT_FLUSH) {
      out.scare.push(k);
    }
  }
  return out;
}

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
  /** V16 plo8: one card from the NUT LOW with A-2 live in hand */
  nutLowDraw: boolean;
  /** the draw is worth fighting for: nut flush draw, big wrap, or nut-low draw */
  nutty: boolean;
}

const NO_DRAW_INFO: OmahaDrawInfo = {
  nutFlushDraw: false,
  dominatedFlushDraw: false,
  straightOuts: 0,
  bigWrap: false,
  nutLowDraw: false,
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
export function omahaDrawQuality(
  hole: Card[],
  board: Card[],
  /** V16 plo8: also grade the NUT-LOW draw — the hi-lo half the old grader
   *  was blind to. */
  isHiLo: boolean = false
): OmahaDrawInfo {
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

    // V16 plo8: a NUT-LOW draw (A-2 in hand, two distinct low board cards,
    // one more low card needed) is half the pot with the best possible low —
    // real semi-bluff equity the high-only grader scored as nothing.
    let nutLowDraw = false;
    if (isHiLo) {
      const lowRank = (r: number): number => (r === 14 ? 1 : r);
      const boardLows = new Set<number>();
      for (const c of board) {
        const lr = lowRank(RANK_VALUES[c.rank]);
        if (lr <= 8) boardLows.add(lr);
      }
      const holeRanks = new Set<number>();
      for (const c of hole) holeRanks.add(lowRank(RANK_VALUES[c.rank]));
      // A + 2 live (not counterfeit by the board) with exactly 2 distinct
      // board lows = one card from the nut low.
      if (
        boardLows.size === 2 &&
        holeRanks.has(1) &&
        holeRanks.has(2) &&
        !boardLows.has(1) &&
        !boardLows.has(2)
      ) {
        nutLowDraw = true;
      }
    }

    return {
      nutFlushDraw,
      dominatedFlushDraw,
      straightOuts,
      bigWrap,
      nutLowDraw,
      nutty: nutFlushDraw || bigWrap || nutLowDraw,
    };
  } catch {
    return NO_DRAW_INFO;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// V15 OMAHA MADE-HAND NUT STATUS (Dan 2026-08-26)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The made-hand classifier stops at CATEGORY: a 9-high flush and the nut flush
// are both "6". In Omaha that distinction is most of the game — when a bet gets
// raised on a three-flush board, the raiser has a flush too, and the only
// question that matters is WHOSE IS BIGGER. This answers it directly:
// for a made flush, how many ranks of the flush suit that beat hero's best
// suited hole card are still live (not on the board, not in hero's hand); for
// a made straight, whether any two hole cards could make a bigger one on this
// board. Cheap (no simulation), called lazily only for cat 5/6 Omaha hands.

export interface OmahaNutStatus {
  /** made category from scoreOmahaHiPartial (0 when unknown) */
  category: number;
  /** made flush only: count of LIVE ranks in the flush suit above hero's best
   *  suited hole card. 0 = nut flush; 1 = second nut; 2+ = dominated. */
  higherFlushRanks: number;
  /** made straight only: no two hole cards make a bigger straight here */
  straightIsNut: boolean;
}

const NO_NUT_STATUS: OmahaNutStatus = { category: 0, higherFlushRanks: 0, straightIsNut: true };

export function omahaNutStatus(hole: Card[], board: Card[]): OmahaNutStatus {
  if (!hole || hole.length < 2 || !board || board.length < 3) return NO_NUT_STATUS;
  try {
    const score = scoreOmahaHiPartial(hole, board);
    const cat = Math.floor(score / 0x100000);
    const out: OmahaNutStatus = { category: cat, higherFlushRanks: 0, straightIsNut: true };

    if (cat === 6) {
      // The flush suit: >= 3 on the board (Omaha uses exactly 3 board cards)
      // where hero holds >= 2 (exactly 2 hole cards must play).
      for (const suit of SUITS) {
        const onBoard = board.filter((c) => c.suit === suit);
        if (onBoard.length < 3) continue;
        const heroSuited = hole.filter((c) => c.suit === suit);
        if (heroSuited.length < 2) continue;
        let heroTop = 0;
        for (const c of heroSuited) heroTop = Math.max(heroTop, RANK_VALUES[c.rank]);
        const seen = new Set<number>();
        for (const c of onBoard) seen.add(RANK_VALUES[c.rank]);
        for (const c of heroSuited) seen.add(RANK_VALUES[c.rank]);
        let higher = 0;
        for (let r = heroTop + 1; r <= 14; r++) if (!seen.has(r)) higher++;
        out.higherFlushRanks = higher;
        break;
      }
    } else if (cat === 5) {
      // Best straight ANY two hole cards could make: a 5-rank window holding
      // at least 3 distinct board ranks is fillable (the opponent supplies
      // the at-most-2 missing ranks from their hole).
      const boardRankSet = new Set<number>();
      for (const c of board) boardRankSet.add(RANK_VALUES[c.rank]);
      const heroTop = score & 0xfffff;
      let bestTop = 0;
      for (let top = 14; top >= 5 && bestTop === 0; top--) {
        let onBoard = 0;
        for (let k = 0; k < 5; k++) {
          const r = top - k === 1 ? 14 : top - k; // wheel: the 5-high straight uses the ace
          if (boardRankSet.has(r)) onBoard++;
        }
        if (onBoard >= 3) bestTop = top;
      }
      out.straightIsNut = bestTop <= heroTop;
    }
    return out;
  } catch {
    return NO_NUT_STATUS;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// V21 NLH MADE-HAND NUT STATUS (Dan 2026-08-27, Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Omaha nut status above answered "whose flush is bigger" and it killed the
// small-flush stack-offs. NLH had NOTHING equivalent, and the review table
// showed exactly what that costs: a T7 straight four-bet into a three-club
// board, a sixes-full re-raising on JJ66x into any jack, trips escalating a
// river war. Category numbers are blind to "hands that beat mine are ON this
// board". This answers the three questions that decide NLH river wars:
// is a flush possible over my straight, is a bigger straight live, and is my
// full house the BOTTOM boat. Cheap (no simulation), computed lazily.

export interface NlhNutStatus {
  /** made category of hero's best five (0 = unknown) */
  cat: number;
  /** the board carries three or more of one suit — a flush is possible */
  flushPossible: boolean;
  /** four or more of one suit on the board — every single card of the suit plays */
  fourFlushBoard: boolean;
  /** hero makes a flush: rank of hero's best card of the flush suit (0 = none) */
  heroFlushHigh: number;
  /** made flush only: LIVE ranks of the flush suit above hero's best. 0 = nut flush. */
  higherFlushRanks: number;
  /** hero's straight top rank (0 = no straight) */
  heroStraightTop: number;
  /** highest straight top ANY two opponent cards could complete on this board */
  maxStraightTop: number;
  /** hero's full house is dominated by a ONE-CARD boat: a board pair of higher
   *  rank than hero's trips exists, so any single card of that rank beats hero */
  underfull: boolean;
}

const NO_NLH_NUT_STATUS: NlhNutStatus = {
  cat: 0,
  flushPossible: false,
  fourFlushBoard: false,
  heroFlushHigh: 0,
  higherFlushRanks: 0,
  heroStraightTop: 0,
  maxStraightTop: 0,
  underfull: false,
};

export function nlhNutStatus(hole: Card[], board: Card[], shortDeck: boolean): NlhNutStatus {
  if (!hole || hole.length < 2 || !board || board.length < 3) return NO_NLH_NUT_STATUS;
  try {
    const all = hole.concat(board);
    const score = scoreHoldem(all, all.length, shortDeck);
    const cat = Math.floor(score / 0x100000);
    const out: NlhNutStatus = { ...NO_NLH_NUT_STATUS, cat };

    // Flush geography.
    const suitCount = new Map<string, number>();
    for (const c of board) suitCount.set(c.suit, (suitCount.get(c.suit) || 0) + 1);
    let flushSuit: string | null = null;
    let flushSuitN = 0;
    for (const [s, n] of suitCount) {
      if (n >= 3 && n > flushSuitN) {
        flushSuit = s;
        flushSuitN = n;
      }
    }
    if (flushSuit) {
      out.flushPossible = true;
      out.fourFlushBoard = flushSuitN >= 4;
      const heroSuited = hole.filter((c) => c.suit === flushSuit);
      // NLH plays any five: board 3 needs two suited hole cards, board 4+ one.
      const heroMakesFlush = heroSuited.length >= Math.max(1, 5 - flushSuitN);
      // V28 AUDIT FIX (2026-08-29): on a MONOTONE FIVE-CARD board a hero with
      // ZERO cards of the suit plays the board flush — scoreHoldem says cat 6,
      // but this block skipped him, leaving higherFlushRanks at its default 0,
      // which every consumer reads as "NUT flush". A hand that can do no
      // better than chop was classified undominated and left the stack-off
      // path open. Playing the board means EVERY live rank above the board's
      // lowest flush card beats hero.
      if (flushSuitN === 5 && heroSuited.length === 0) {
        const boardRanks = board
          .filter((c) => c.suit === flushSuit)
          .map((c) => RANK_VALUES[c.rank]);
        const boardLow = Math.min(...boardRanks);
        const seen = new Set<number>(boardRanks);
        let higher = 0;
        const floor = shortDeck ? 6 : 2;
        for (let r = floor; r <= 14; r++) {
          if (!seen.has(r) && r > boardLow) higher++;
        }
        out.heroFlushHigh = boardLow;
        out.higherFlushRanks = Math.max(1, higher);
      } else if (heroMakesFlush && heroSuited.length > 0) {
        let heroTop = 0;
        for (const c of heroSuited) heroTop = Math.max(heroTop, RANK_VALUES[c.rank]);
        out.heroFlushHigh = heroTop;
        const seen = new Set<number>();
        for (const c of board) if (c.suit === flushSuit) seen.add(RANK_VALUES[c.rank]);
        for (const c of heroSuited) seen.add(RANK_VALUES[c.rank]);
        let higher = 0;
        for (let r = heroTop + 1; r <= 14; r++) if (!seen.has(r)) higher++;
        // V28: a dead short-deck "correction" deleted here. It looped
        // r = heroTop+1 .. min(5,14), but in short deck heroTop >= 6 always,
        // so the body never executed — and the counting loop above starts at
        // heroTop+1 walking UP, so ranks 2-5 could never be counted anyway.
        // A correction that looks live and is not is a trap for the next
        // editor; the upward walk is already short-deck-safe by construction.
        out.higherFlushRanks = higher;
      }
    }

    // Straight geography: hero's top, and the best top any 2 cards complete.
    let comboMask = 0;
    let boardMask = 0;
    for (const c of board) boardMask |= 1 << RANK_VALUES[c.rank];
    comboMask = boardMask;
    for (const c of hole) comboMask |= 1 << RANK_VALUES[c.rank];
    out.heroStraightTop = straightTop(comboMask, shortDeck);
    const lowRank = shortDeck ? 6 : 2;
    for (let top = 14; top >= lowRank + 3; top--) {
      let onBoard = 0;
      for (let k = 0; k < 5; k++) {
        let r = top - k;
        if (r === lowRank - 1) r = 14; // the wheel uses the ace low
        if (r < lowRank - 1) break;
        if ((boardMask & (1 << r)) !== 0) onBoard++;
      }
      if (onBoard >= 3) {
        out.maxStraightTop = top;
        break;
      }
    }

    // Underfull: hero boat whose trips rank sits under a board pair.
    if (cat === 7 || (shortDeck && cat === 6)) {
      // hero's boat trips rank = top 4 bits of the tiebreak by construction is
      // fragile across encodings — recompute from counts instead.
      const count = new Map<number, number>();
      for (const c of all) {
        const r = RANK_VALUES[c.rank];
        count.set(r, (count.get(r) || 0) + 1);
      }
      let tripsRank = 0;
      for (const [r, n] of count) if (n >= 3 && r > tripsRank) tripsRank = r;
      if (tripsRank > 0) {
        const boardCount = new Map<number, number>();
        for (const c of board) {
          const r = RANK_VALUES[c.rank];
          boardCount.set(r, (boardCount.get(r) || 0) + 1);
        }
        for (const [r, n] of boardCount) {
          if (n >= 2 && r > tripsRank) {
            out.underfull = true;
            break;
          }
        }
      }
    }
    return out;
  } catch {
    return NO_NLH_NUT_STATUS;
  }
}

/**
 * V15: cheap Omaha board-contact test for the MC sampler — no hand scoring.
 * Pair-or-better contact (a hole rank on the board, or a pocket pair), a
 * two-card flush holding in a two-suited/monotone board suit, or two hole
 * cards coordinating with the board's straight window.
 */
export function omahaConnectsBoard(hole: Card[], board: Card[]): boolean {
  const boardRanks = new Set<number>();
  for (const c of board) boardRanks.add(RANK_VALUES[c.rank]);
  const holeRankCount = new Map<number, number>();
  for (const c of hole) {
    const r = RANK_VALUES[c.rank];
    if (boardRanks.has(r)) return true; // paired the board
    holeRankCount.set(r, (holeRankCount.get(r) || 0) + 1);
  }
  for (const n of holeRankCount.values()) if (n >= 2) return true; // pocket pair
  // Flush contact: board suit with >= 2 and two suited hole cards.
  const boardSuit = new Map<string, number>();
  for (const c of board) boardSuit.set(c.suit, (boardSuit.get(c.suit) || 0) + 1);
  for (const [suit, n] of boardSuit) {
    if (n >= 2 && hole.filter((c) => c.suit === suit).length >= 2) return true;
  }
  // Straight-ish contact: two distinct hole ranks each within 2 of a board rank.
  let near = 0;
  for (const r of holeRankCount.keys()) {
    for (const b of boardRanks) {
      if (Math.abs(r - b) <= 2) {
        near++;
        break;
      }
    }
  }
  return near >= 2;
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
  /** V16: fired a big (>= 20bb) bet on the newest street — sampled toward
   *  two-pair-plus contact, not just any contact. */
  bigBet?: boolean;
  /** V40: postflop streets on which this opponent bet or raised (1 = a
   *  single bet, 3 = a triple barrel). The Omaha sampler's tier is built
   *  from this and lastFrac, not from the capped aggrW. */
  streets?: number;
  /** V40: the newest street's bet or raise as a fraction of the pot it
   *  went into (1 = a pot-sized bet). */
  lastFrac?: number;
  /** V40: this opponent RAISED on the newest street (over a bet). */
  raised?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V40 OMAHA MADE-HAND CLASS (Dan 2026-09-04)
// ═══════════════════════════════════════════════════════════════════════════════
//
// "HORSES ARE PLAYING PLO4, PLO5, PLO6 AND PLO8 LIKE IT'S HOLDEM. This horse
//  check-called a pot sized bet on the flop, turn and river with naked aces."
//
// The made-hand category says "two pair". Omaha says WHICH two pair, on WHAT
// board, and that answer is most of the decision: aces-up on a paired board
// is one pair against a range that bet three streets; bottom two on an
// unpaired connected board is a bluff-catcher; top set on a rainbow
// unconnected board is the nuts. This classifier is cheap (no simulation,
// no enumeration) and serves both the calling side (the V40 pressure cap in
// HorseLogic) and the betting side (small ball with non-nut hands).
export type OmahaMadeClass =
  | 'air'
  | 'pair'
  | 'board2p' // two pair where one pair IS the board's pair: really one pair
  | 'low2p' // two pair below the board's top rank
  | 'top2p' // top two pair on an unpaired board
  | 'weaktrips' // trips via the board's pair (one hole card)
  | 'set' // pocket pair matched a board card
  | 'strong'; // straight or better: V15 owns the nut question there

export interface OmahaMadeInfo {
  cls: OmahaMadeClass;
  category: number;
  boardPaired: boolean;
  /** three board cards fit inside a five-rank window (a straight is live) */
  straightPossible: boolean;
  /** three or more board cards of one suit (a flush is live) */
  flushPossible: boolean;
  /** hero holds a pocket pair, or two hole ranks pair the board: the class is
   *  "weak" for this board — a made hand that a pot-sized line beats. */
  weak: boolean;
}

const NO_MADE_INFO: OmahaMadeInfo = {
  cls: 'air',
  category: 0,
  boardPaired: false,
  straightPossible: false,
  flushPossible: false,
  weak: true,
};

/** Board texture flags shared by the classifier and the sampler tier. */
export function omahaBoardShape(board: Card[]): {
  paired: boolean;
  straightPossible: boolean;
  flushPossible: boolean;
} {
  const rankN = new Map<number, number>();
  const suitN = new Map<string, number>();
  for (const c of board) {
    const r = RANK_VALUES[c.rank];
    rankN.set(r, (rankN.get(r) || 0) + 1);
    suitN.set(c.suit, (suitN.get(c.suit) || 0) + 1);
  }
  let paired = false;
  for (const n of rankN.values()) if (n >= 2) paired = true;
  let flushPossible = false;
  for (const n of suitN.values()) if (n >= 3) flushPossible = true;
  // Straight: any three distinct board ranks inside a five-rank window,
  // the ace counting low as well.
  const ranks = Array.from(rankN.keys());
  if (ranks.includes(14)) ranks.push(1);
  ranks.sort((a, b) => a - b);
  let straightPossible = false;
  for (let i = 0; i + 2 < ranks.length && !straightPossible; i++) {
    if (ranks[i + 2] - ranks[i] <= 4) straightPossible = true;
  }
  return { paired, straightPossible, flushPossible };
}

export function omahaMadeClass(hole: Card[], board: Card[], category?: number): OmahaMadeInfo {
  if (!hole || hole.length < 2 || !board || board.length < 3) return NO_MADE_INFO;
  try {
    const cat =
      category != null && category > 0
        ? category
        : Math.floor(scoreOmahaHiPartial(hole, board) / 0x100000);
    const shape = omahaBoardShape(board);
    const base = {
      category: cat,
      boardPaired: shape.paired,
      straightPossible: shape.straightPossible,
      flushPossible: shape.flushPossible,
    };
    if (cat >= 5) return { ...base, cls: 'strong', weak: false };
    if (cat <= 1) return { ...base, cls: 'air', weak: true };
    if (cat === 2) return { ...base, cls: 'pair', weak: true };

    const boardRankN = new Map<number, number>();
    for (const c of board) {
      const r = RANK_VALUES[c.rank];
      boardRankN.set(r, (boardRankN.get(r) || 0) + 1);
    }
    const boardRanks = Array.from(boardRankN.keys()).sort((a, b) => b - a);
    const holeRankN = new Map<number, number>();
    for (const c of hole) {
      const r = RANK_VALUES[c.rank];
      holeRankN.set(r, (holeRankN.get(r) || 0) + 1);
    }
    // Hole ranks that pair the board, highest first.
    const matched = boardRanks.filter((r) => holeRankN.has(r));
    const pocketPairs = Array.from(holeRankN.entries())
      .filter(([, n]) => n >= 2)
      .map(([r]) => r);

    if (cat === 4) {
      // A set: a pocket pair whose rank is on the board (once).
      const set = pocketPairs.some((r) => boardRankN.get(r) === 1);
      if (set) {
        return {
          ...base,
          cls: 'set',
          weak: shape.straightPossible || shape.flushPossible,
        };
      }
      return { ...base, cls: 'weaktrips', weak: true };
    }

    // cat === 3, two pair.
    if (shape.paired) {
      // On a paired board, two pair means the board pair plus ONE pair of
      // hero's own (a pocket pair, or one card that hit) unless two hole
      // ranks pair two DIFFERENT unpaired board ranks.
      const unpairedMatches = matched.filter((r) => boardRankN.get(r) === 1);
      if (unpairedMatches.length < 2) return { ...base, cls: 'board2p', weak: true };
    }
    // Unpaired board (or two live matches on a paired one): is it TOP two?
    const liveBoard = boardRanks.filter((r) => boardRankN.get(r) === 1);
    const top2 = liveBoard.slice(0, 2);
    const isTop = top2.length === 2 && top2.every((r) => holeRankN.has(r));
    if (isTop) {
      // Top two on a paired board is still two pair against trips and
      // boats: weak. On an unpaired board it is weak only where a straight
      // or flush is live.
      return {
        ...base,
        cls: 'top2p',
        weak: shape.paired || shape.straightPossible || shape.flushPossible,
      };
    }
    return { ...base, cls: 'low2p', weak: true };
  } catch {
    return NO_MADE_INFO;
  }
}

/**
 * V40 OMAHA AGGRESSOR TIER. Which made category a sampled opponent hand must
 * reach for the sampler to accept it, given how hard this opponent has been
 * betting. Tier 1 is a single ordinary bet, tier 2 a pot-sized bet or a
 * second barrel, tier 3 a triple barrel, a raise, or a big second barrel.
 *
 * Pot-limit Omaha is a game of the nuts. A pot-sized third barrel on a
 * paired board is a full house or trips, not "something that connects" -
 * omahaConnectsBoard accepts virtually any six-card hand on any board (a
 * hole rank pairing the board, any pocket pair, two suited cards, two ranks
 * near the board) and so an aggressor was still sampled from his preflop
 * band. That is the single equity lie behind every naked-aces call-down.
 */
export function omahaAggressorTier(read: OppPostflopRead): number {
  const streets = read.streets ?? (read.aggrW > 0 ? 1 : 0);
  if (streets <= 0 && !read.raised) return 0;
  const frac = read.lastFrac ?? (read.bigBet ? 1 : 0.5);
  let tier = 1;
  if (frac >= 0.7 || read.bigBet) tier++;
  if (streets >= 2) tier++;
  if (streets >= 3 || read.raised) tier++;
  return Math.min(3, tier);
}

/**
 * The made category a tiered aggressor's sampled hand must reach on this
 * board. Before the river a strong draw substitutes for it, but only on top
 * of a made hand of at least `drawMinCat` (tier 3 wants two pair plus the
 * draw, not a bare wrap). `pStrong` is the share of the range that is
 * value at all; the rest is left as bluffs.
 */
export function omahaTierRequirement(
  tier: number,
  boardLen: number,
  shape: { paired: boolean; straightPossible: boolean; flushPossible: boolean }
): { minCat: number; drawMinCat: number; pStrong: number } {
  const river = boardLen >= 5;
  const noDraw = 99;
  if (tier <= 1) return { minCat: 2, drawMinCat: river ? noDraw : 1, pStrong: 0.7 };
  if (tier === 2) {
    if (river) return { minCat: shape.paired ? 4 : 3, drawMinCat: noDraw, pStrong: 0.78 };
    return { minCat: 3, drawMinCat: 2, pStrong: 0.75 };
  }
  // tier 3
  if (river) {
    const minCat = shape.paired ? 4 : shape.straightPossible || shape.flushPossible ? 5 : 3;
    return { minCat, drawMinCat: noDraw, pStrong: 0.85 };
  }
  return { minCat: shape.paired ? 4 : 3, drawMinCat: 3, pStrong: 0.8 };
}

/**
 * V40: a structural Omaha made-category estimate for the sampler - no
 * scoring. Exactly two hole cards play: pairs, two pair, trips, boats and
 * quads from rank counts; a flush from suit counts; a straight from a rank
 * bitmask test over every hole-rank pair. Returns the category number
 * scoreOmahaHiPartial would (1..8), ignoring straight flushes (rare, and
 * a category-9 hand passes every threshold this feeds anyway).
 */
const qBoardN = new Int32Array(15);
const qHoleN = new Int32Array(15);
export function omahaQuickCategory(hole: Card[], board: Card[]): number {
  qBoardN.fill(0);
  qHoleN.fill(0);
  let boardMask = 0;
  const suitB = new Int32Array(4);
  const suitH = new Int32Array(4);
  for (const c of board) {
    const r = RANK_VALUES[c.rank];
    qBoardN[r]++;
    boardMask |= 1 << r;
    if (r === 14) boardMask |= 1 << 1;
    suitB[SUIT_INDEX[c.suit]]++;
  }
  for (const c of hole) {
    qHoleN[RANK_VALUES[c.rank]]++;
    suitH[SUIT_INDEX[c.suit]]++;
  }
  let cat = 1;
  // Board structure.
  let boardPair = 0;
  let boardTrips = 0;
  for (let r = 2; r <= 14; r++) {
    if (qBoardN[r] >= 3) boardTrips = r;
    else if (qBoardN[r] === 2) boardPair = r;
  }
  // Hole contact.
  let singleHits = 0; // distinct hole ranks matching a board singleton
  let pairHits = 0; // distinct hole ranks matching a board pair (trips)
  let tripsHit = false; // a hole rank matching board trips (quads)
  let pocketPairs = 0;
  let pocketOnSingle = false; // pocket pair matching a board singleton (set)
  let pocketOnPair = false; // pocket pair matching a board pair (quads)
  for (let r = 2; r <= 14; r++) {
    const h = qHoleN[r];
    if (h === 0) continue;
    const b = qBoardN[r];
    if (h >= 2) {
      pocketPairs++;
      if (b === 1) pocketOnSingle = true;
      if (b >= 2) pocketOnPair = true;
    }
    if (b === 1) singleHits++;
    else if (b === 2) pairHits++;
    else if (b >= 3) tripsHit = true;
  }
  // Exactly two hole cards play, so a pocket pair spends both of them and a
  // board rank hero matches is used once from the hand.
  const pairHit = pairHits >= 1;
  if (tripsHit || pocketOnPair) cat = 8;
  else if (
    pairHits >= 2 ||
    (pairHit && singleHits >= 1) ||
    (pocketOnSingle && boardPair > 0) ||
    (boardTrips > 0 && pocketPairs >= 1)
  )
    cat = 7;
  else if (pairHit || pocketOnSingle || boardTrips > 0) cat = Math.max(cat, 4);
  else if (singleHits >= 2 || (boardPair > 0 && (singleHits >= 1 || pocketPairs >= 1)))
    cat = Math.max(cat, 3);
  else if (singleHits >= 1 || pocketPairs >= 1 || boardPair > 0) cat = Math.max(cat, 2);
  if (cat >= 7) return cat;
  // Flush: three or more board cards of a suit hero holds two of.
  for (let si = 0; si < 4; si++) {
    if (suitB[si] >= 3 && suitH[si] >= 2) return Math.max(cat, 6);
  }
  if (cat >= 6) return cat;
  // Straight: two distinct hole ranks that, with three board ranks, cover
  // five consecutive ranks (ace low counts).
  const holeRanks: number[] = [];
  for (let r = 2; r <= 14; r++) if (qHoleN[r] > 0) holeRanks.push(r);
  if (qHoleN[14] > 0) holeRanks.push(1);
  for (let i = 0; i < holeRanks.length; i++) {
    for (let j = i + 1; j < holeRanks.length; j++) {
      const a = holeRanks[i];
      const b = holeRanks[j];
      if (a === 1 && b === 14) continue;
      const mask = boardMask | (1 << a) | (1 << b);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo > 4) continue;
      for (let st = Math.max(1, hi - 4); st <= lo && st <= 10; st++) {
        const window = 31 << st;
        if ((mask & window) === window) return Math.max(cat, 5);
      }
    }
  }
  return cat;
}

/** Cheap structural "strong draw" test for the sampler: a flush draw in a
 *  two-suited board suit, or three hole ranks inside the board's straight
 *  window (a wrap-shaped holding). No scoring. */
export function omahaStrongDrawShape(hole: Card[], board: Card[]): boolean {
  const suitN = new Map<string, number>();
  for (const c of board) suitN.set(c.suit, (suitN.get(c.suit) || 0) + 1);
  for (const [suit, n] of suitN) {
    if (n === 2 && hole.filter((c) => c.suit === suit).length >= 2) return true;
  }
  // A wrap needs a board that can straighten (two ranks within three of
  // each other) and three distinct hole ranks each within two of one of
  // those board ranks, none of them already on the board.
  const boardRanks: number[] = [];
  for (const c of board) boardRanks.push(RANK_VALUES[c.rank]);
  let window = false;
  for (let i = 0; i < boardRanks.length && !window; i++)
    for (let j = i + 1; j < boardRanks.length; j++)
      if (boardRanks[i] !== boardRanks[j] && Math.abs(boardRanks[i] - boardRanks[j]) <= 3) {
        window = true;
        break;
      }
  if (!window) return false;
  let near = 0;
  const seen = new Set<number>();
  for (const c of hole) {
    const r = RANK_VALUES[c.rank];
    if (seen.has(r) || boardRanks.includes(r)) continue;
    seen.add(r);
    for (const b of boardRanks) {
      if (Math.abs(r - b) <= 2) {
        near++;
        break;
      }
    }
  }
  return near >= 3;
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
  // V28 AUDIT FIX (2026-08-29): the two fall-throughs below returned `cat` —
  // the very board-derived value the V13 guard above just REJECTED. 32o on
  // K-K-7 still "connected" with the board's kings via the terminal return,
  // so the V12/V16 aggressor conditioning was a no-op on every paired board
  // (~17% of flops, and every board once it pairs) — the exact pre-V13
  // behaviour the guard's own comment says it fixed. When the hole cards add
  // nothing to what the board already makes, the honest contact value is the
  // high-card floor, not the board's category.
  const noContact = cat <= boardCat && !isPocketPair ? 1 : cat;
  if (board.length >= 5) return noContact; // river: no draws left
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
  // V28: same fall-through as the river shortcut above — no made improvement,
  // no draw found. Report no-contact rather than echoing the board's hand.
  return noContact;
}

/**
 * Estimate hero's equity (0..1) vs `numOpponents` random hands. Handles all
 * supported variants. Draws are priced naturally because the runout completes
 * the board every iteration.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// V13 EXACT BAND SAMPLING (2026-08-23)
// ═══════════════════════════════════════════════════════════════════════════════
// The band sampler used REJECTION sampling: redraw uniformly up to `tries`
// times and, if nothing landed in the band, keep the CLOSEST MISS at full
// weight. For a tight read that is a disaster, because the tighter the band the
// lower the per-draw hit rate and so the more often the fallback fires — and
// the fallback's expected value is the best of ~15 draws that all FAILED the
// band, i.e. a hand just under it.
//
// Measured, hero AQs on A-K-7 against a [0.85, 1.0] read (27 legal combos, 2.5%
// of the deck): true equity 55.4%, sampler 72.4% — SEVENTEEN POINTS too high,
// systematically, in hero's favour. A horse facing a 4-bet priced its hand as a
// crush and called off.
//
// A two-card range is small enough to enumerate exactly, so there is no reason
// to sample it by rejection at all. The tables below hold every combo sorted by
// preflop percentile; a band is then a CONTIGUOUS SLICE found by binary search,
// and sampling is one uniform draw from that slice plus a collision check
// against the cards already dealt. Exact, and cheaper than the loop it replaces.
// Omaha keeps the old path — its combo space is far too large to enumerate.

type ComboTable = { scores: Float64Array; c1: Card[]; c2: Card[] };

function buildComboTable(shortDeck: boolean): ComboTable {
  const src = shortDeck ? SHORT_DECK_CARDS : FULL_DECK;
  const rows: Array<{ s: number; a: Card; b: Card }> = [];
  for (let i = 0; i < src.length; i++) {
    for (let j = i + 1; j < src.length; j++) {
      rows.push({ s: holdemPreflopScore(src[i], src[j], shortDeck), a: src[i], b: src[j] });
    }
  }
  rows.sort((x, y) => x.s - y.s);
  const scores = new Float64Array(rows.length);
  const c1: Card[] = new Array(rows.length);
  const c2: Card[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    scores[i] = rows[i].s;
    c1[i] = rows[i].a;
    c2[i] = rows[i].b;
  }
  return { scores, c1, c2 };
}

let comboFull: ComboTable | null = null;
let comboShort: ComboTable | null = null;
const comboTable = (shortDeck: boolean): ComboTable => {
  if (shortDeck) return (comboShort ??= buildComboTable(true));
  return (comboFull ??= buildComboTable(false));
};

/** First index whose score is >= v. */
function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Availability scratch, indexed by card id — reused, never allocated. */
const cardAvail = new Uint8Array(64);
const cardId = (c: Card): number => ((RANK_VALUES[c.rank] - 2) << 2) | (SUIT_INDEX[c.suit] ?? 0);

/**
 * Place an in-band two-card hand into deck[windowStart..windowStart+1] by
 * swapping it in from the undealt remainder. Returns false when the band has no
 * combo left that avoids the cards already dealt, in which case the caller
 * keeps its uniform draw.
 */
function placeBandCombo(
  deck: Card[],
  windowStart: number,
  n: number,
  band: [number, number],
  shortDeck: boolean
): boolean {
  const tbl = comboTable(shortDeck);
  const lo = lowerBound(tbl.scores, band[0]);
  const hi = lowerBound(tbl.scores, band[1] + 1e-12);
  const span = hi - lo;
  if (span <= 0) return false;

  cardAvail.fill(0);
  for (let i = windowStart; i < n; i++) cardAvail[cardId(deck[i])] = 1;

  for (let attempt = 0; attempt < 24; attempt++) {
    const idx = lo + Math.floor(fastRandom() * span);
    const a = tbl.c1[idx];
    const b = tbl.c2[idx];
    if (!cardAvail[cardId(a)] || !cardAvail[cardId(b)]) continue;
    // Swap both into the window.
    for (let k = 0; k < 2; k++) {
      const want = k === 0 ? a : b;
      const slot = windowStart + k;
      if (deck[slot] === want) continue;
      for (let j = slot; j < n; j++) {
        if (deck[j] === want) {
          const tmp = deck[slot];
          deck[slot] = deck[j];
          deck[j] = tmp;
          break;
        }
      }
    }
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V16 OMAHA RESERVOIR BAND SAMPLING (2026-08-26)
// ═══════════════════════════════════════════════════════════════════════════════
// The V13 exact-combo fix reached only NLH: an Omaha combo space cannot be
// enumerated, so Omaha bands kept REJECTION sampling — and its fallback keeps
// the CLOSEST MISS at full weight. For a tight band nearly every uniform draw
// scores far BELOW it, so the fallback hand is systematically weaker than the
// read and hero's equity is overstated in exactly the pots where reads matter
// most (PLO 3-bet and 4-bet pots) — the same bias family measured at +17
// equity points in NLH before V13.
//
// The space cannot be enumerated, but it does not need to be: a large SORTED
// EMPIRICAL RESERVOIR of random combos approximates the score distribution to
// sampling error. A band is then a contiguous slice found by binary search,
// exactly like the NLH combo table, and the closest-miss fallback becomes the
// rare case (dealt-card collisions only) instead of the common one. Built
// lazily per (holeCount, hiLo) with a PRIVATE deterministic RNG so building
// never disturbs the live fastRandom stream mid-decision.

type OmahaReservoir = { scores: Float64Array; combos: Card[][] };
const omahaReservoirs = new Map<string, OmahaReservoir>();
const OMAHA_RESERVOIR_SIZE = 16384;

function buildOmahaReservoir(holeCount: number, isHiLo: boolean): OmahaReservoir {
  let s = (0x9e3779b9 ^ (holeCount * 2654435761) ^ (isHiLo ? 0x85ebca6b : 0)) >>> 0 || 1;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const deck = FULL_DECK.slice();
  const entries: Array<{ score: number; cards: Card[] }> = [];
  for (let i = 0; i < OMAHA_RESERVOIR_SIZE; i++) {
    for (let j = 0; j < holeCount; j++) {
      const k = j + Math.floor(rnd() * (deck.length - j));
      const t = deck[j];
      deck[j] = deck[k];
      deck[k] = t;
    }
    // References into FULL_DECK, deliberately: simulateEquity's deck is a
    // filter of FULL_DECK, so identity comparison works for the swap-in.
    const cards = deck.slice(0, holeCount);
    entries.push({ score: omahaPreflopScore(cards, isHiLo), cards });
  }
  entries.sort((x, y) => x.score - y.score);
  const scores = new Float64Array(entries.length);
  const combos: Card[][] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    scores[i] = entries[i].score;
    combos[i] = entries[i].cards;
  }
  return { scores, combos };
}

/**
 * Exported for the ground-truth test.
 *
 * BAND SEMANTICS — the discovery that made this fix bigger than a sampler
 * swap: HorseMind's bands are PERCENTILE-INTENT ("this line means a top-15%
 * hand"), and the NLH combo table delivers that because holdemPreflopScore
 * is percentile-style. omahaPreflopScore is NOT — its distribution is
 * compressed (median 0.24, p99 0.59), so matching band VALUES against Omaha
 * SCORES selects almost nothing: a [0.85, 1.0] "3-bettor" read is beyond
 * p99.9, the rejection sampler never once found an in-band hand, and every
 * "read" degraded to closest-miss noise. The reservoir therefore maps bands
 * through its own empirical CDF: band [0.85, 1.0] = the top 15% of sorted
 * combos BY INDEX. That is what the read meant all along.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OMAHA PREFLOP PERCENTILE — the same CDF correction, for the DECISION
 * thresholds (Dan 2026-08-30, after a live PLO spin)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The comment above records that omahaPreflopScore is NOT percentile-style
 * and that matching percentile-intent BANDS against it selects almost
 * nothing. The reservoir fixed that for HorseMind's reads. It was never
 * applied to the place it matters most: the preflop decision itself.
 *
 * decidePreflopV7's thresholds are percentile-intent — they are calibrated
 * against holdemPreflopScore, which IS percentile-style. HorseLogic fed them
 * the raw Omaha score, whose distribution is compressed:
 *
 *     median 0.24, p75 0.32, max observed 0.72   (measured over 300 deals)
 *
 * So in PLO every hand read as bottom-quartile trash. Measured against the
 * live decide() before this fix, 3-max PLO spin, SB unopened:
 *
 *     first to act   ->  call 212, fold 88, RAISE 0 of 300
 *
 * Zero opens, ever. That is exactly what Dan saw: horses that never raise,
 * never re-raise, and fold to a pot-sized bet.
 *
 * THE FIX: map the score through its own empirical CDF, so the median PLO
 * hand becomes 0.5 and the existing thresholds mean what they say. Ties take
 * the MID-rank so a common score does not slam to the bottom of its block.
 * Same reservoir, same private RNG, cached per (holeCount, isHiLo) — one
 * binary search per decision, no I/O, and the postflop path is untouched
 * because it already uses real Monte Carlo equity.
 */
/**
 * The EXACT hold'em score distribution: all 1,326 two-card combos, scored
 * and sorted once. Used to quantile-match Omaha onto the scale the preflop
 * thresholds were actually tuned against.
 *
 * WHY QUANTILE-MATCHING AND NOT A PLAIN PERCENTILE — measured, because the
 * obvious answer is wrong. Hold'em's own score is NOT uniform either:
 *
 *     holdem    median 0.236   p75 0.410   p99 1.000   max 1.000
 *     omaha     median 0.240   p75 0.317   p99 0.640   max 0.850
 *
 * The medians nearly agree; the TOP END does not. Hold'em's best hands
 * saturate at 1.0, so a 3-bet bar at t(0.74) is cleared by a real slice of
 * its range. Omaha never gets there at all — p99 is 0.64 — so the same bar
 * selects essentially nothing, which is why the fleet 3-bet 0.3% of the
 * time. Mapping Omaha to a FLAT percentile would fix the sticking but
 * overshoot the other way: every threshold would suddenly admit far more of
 * the range than the same threshold admits in hold'em. Matching quantiles
 * makes a 90th-percentile PLO hand score exactly what a 90th-percentile
 * hold'em hand scores, so every bar in decidePreflopV7 means the same thing
 * in both games — which is what "percentile-intent" claimed all along.
 */
let holdemScoreCdf: Float64Array | null = null;
function holdemCdf(): Float64Array {
  if (holdemScoreCdf) return holdemScoreCdf;
  const d = FULL_DECK;
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) {
    for (let j = i + 1; j < d.length; j++) {
      out.push(holdemPreflopScore(d[i], d[j], false));
    }
  }
  out.sort((a, b) => a - b);
  holdemScoreCdf = new Float64Array(out);
  return holdemScoreCdf;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME CORRECTION FOR SHORT DECK AND PINEAPPLE (Dan 2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The PLO fix exposed the same defect running the OTHER way. Sweeping every
 * live variant's preflop strength against the identical spot showed:
 *
 *     variant      median  p75    | opens | facing a pot raise
 *     nlh          0.232   0.410  |  22%  | fold 48%
 *     short_deck   0.420   0.620  |  40%  | fold 23%
 *     pineapple    0.493   0.713  |  51%  | fold 15%
 *
 * Short deck deals from 36 cards and pineapple deals three, so in both games
 * every hand is genuinely better in ABSOLUTE terms — and both score
 * functions faithfully say so. But decidePreflopV7's bars are
 * PERCENTILE-INTENT: "open the top ~20%" is a statement about rank, not
 * about an absolute number. Feeding an inflated score against a fixed bar
 * does not express "this game plays looser", it just silently doubles the
 * opening range and folds a pot-sized raise 15% of the time.
 *
 * Variant intent belongs where it is already expressed and visible: the V8
 * style overlay in HorseLogic (Omaha tightens 1.03 and trims slowplay,
 * short deck trims bluffs). The SCALE should be neutral so those knobs mean
 * what they say. So every variant is mapped onto the hold'em scale by
 * quantile, and any deliberate widening is a separate, reviewable decision
 * rather than an artifact of a scoring range.
 *
 * Both CDFs are EXACT, not sampled — 630 two-card combos from the 36-card
 * deck, 22,100 three-card combos from 52 — built once and cached.
 */
let shortDeckCdf: Float64Array | null = null;
function shortDeckScoreCdf(): Float64Array {
  if (shortDeckCdf) return shortDeckCdf;
  const d = SHORT_DECK_CARDS;
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) {
    for (let j = i + 1; j < d.length; j++) out.push(holdemPreflopScore(d[i], d[j], true));
  }
  out.sort((a, b) => a - b);
  shortDeckCdf = new Float64Array(out);
  return shortDeckCdf;
}

let pineappleCdf: Float64Array | null = null;
function pineappleScoreCdf(shortDeck: boolean): Float64Array {
  if (!shortDeck && pineappleCdf) return pineappleCdf;
  const d = shortDeck ? SHORT_DECK_CARDS : FULL_DECK;
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) {
    for (let j = i + 1; j < d.length; j++) {
      for (let k = j + 1; k < d.length; k++) {
        out.push(pineapplePreflopScore([d[i], d[j], d[k]], shortDeck));
      }
    }
  }
  out.sort((a, b) => a - b);
  const arr = new Float64Array(out);
  if (!shortDeck) pineappleCdf = arr;
  return arr;
}

/** Rank a value inside a sorted array and return the mid-rank percentile. */
function midRankPercentile(sorted: Float64Array, v: number): number {
  const n = sorted.length;
  if (n === 0) return v;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  const lower = lo;
  let lo2 = lower;
  let hi2 = n;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (sorted[mid] <= v) lo2 = mid + 1;
    else hi2 = mid;
  }
  return clamp01((lower + lo2) / 2 / n);
}

/** The hold'em score sitting at a given quantile. */
function holdemAtQuantile(p: number): number {
  const cdf = holdemCdf();
  const idx = Math.min(cdf.length - 1, Math.max(0, Math.round(p * (cdf.length - 1))));
  return cdf[idx];
}

/**
 * Short-deck preflop strength ON THE HOLD'EM SCALE. Without this a 6+ horse
 * opened 40% of hands and folded a pot-sized raise 23% of the time, purely
 * because a 36-card deck inflates every score.
 */
export function shortDeckPreflopStrength(c1: Card, c2: Card): number {
  return holdemAtQuantile(midRankPercentile(shortDeckScoreCdf(), holdemPreflopScore(c1, c2, true)));
}

/**
 * Pineapple preflop strength ON THE HOLD'EM SCALE. Without this a pineapple
 * horse opened 51% and folded a pot-sized raise 15% of the time.
 */
export function pineapplePreflopStrength(cards: Card[], shortDeck: boolean): number {
  const raw = pineapplePreflopScore(cards, shortDeck);
  return holdemAtQuantile(midRankPercentile(pineappleScoreCdf(shortDeck), raw));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTIWAY VALUE BARS — the same scale bug, on the opponent-count axis
 * (Dan 2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * decidePostflop's VALUE-BET bars are written as absolute equity numbers
 * (`equity >= 0.8 + mw`, `0.62 + mw`, `0.52 + mw`). They were calibrated
 * against the HEADS-UP equity distribution. But `equity` is computed against
 * min(oppCount, 4) opponents, and that distribution collapses as opponents
 * are added. Measured, 250 random NLH flops per column:
 *
 *     opps  median   %>=0.80   mw     effective bar   % clearing it
 *      1     0.473      9%     0.00       0.80             9%
 *      2     0.280      2%     0.03       0.83             2%
 *      4     0.154      0%     0.09       0.89             0%
 *
 * So the bar meant "top ~9% of hands" heads-up and "literally nothing" four
 * ways — and `mw` pushed it UP on a distribution that had already collapsed
 * DOWN, compounding instead of conserving. Live consequence, measured
 * through decide() before this fix: a preflop raiser c-bet 71% heads-up,
 * 24% three-handed and 2% five-handed, in EVERY variant. A fleet that never
 * bets multiway is both exploitable and visibly robotic.
 *
 * THE FIX, mirroring the preflop variant fix: express the bar as the
 * PERCENTILE it was always meant to be, and look up the equity that sits at
 * that percentile for the actual opponent count. `mw` then supplies the
 * intended extra multiway tightening on top of a scale-neutral bar, which is
 * what it was for.
 *
 * ONLY the value-BET bars use this. The calling side compares equity to POT
 * ODDS — a true probability against a true probability — and must keep raw
 * equity. Normalising that would misprice every call.
 *
 * Deciles measured over 600 random flops per cell (nlh and plo4 averaged;
 * they agree within a few points, so one table serves every variant — the
 * dilution is a property of counting opponents, not of the game).
 */
const EQ_DECILES: Record<number, number[]> = {
  1: [0.112, 0.258, 0.323, 0.378, 0.428, 0.483, 0.543, 0.596, 0.668, 0.776, 0.974],
  2: [0.038, 0.124, 0.163, 0.2, 0.244, 0.291, 0.344, 0.398, 0.479, 0.607, 0.929],
  3: [0.009, 0.075, 0.101, 0.129, 0.165, 0.202, 0.241, 0.291, 0.37, 0.502, 0.907],
  4: [0.002, 0.05, 0.073, 0.092, 0.12, 0.152, 0.187, 0.228, 0.296, 0.422, 0.897],
};

/** Quantile of `v` within a sorted decile table, linearly interpolated. */
function quantileOf(table: number[], v: number): number {
  if (v <= table[0]) return 0;
  if (v >= table[table.length - 1]) return 1;
  for (let i = 1; i < table.length; i++) {
    if (v <= table[i]) {
      const span = table[i] - table[i - 1];
      const frac = span > 0 ? (v - table[i - 1]) / span : 0;
      return (i - 1 + frac) / (table.length - 1);
    }
  }
  return 1;
}

/** The value at quantile `q` in a decile table, linearly interpolated. */
function valueAtQuantile(table: number[], q: number): number {
  const x = clamp01(q) * (table.length - 1);
  const lo = Math.floor(x);
  const hi = Math.min(table.length - 1, lo + 1);
  return table[lo] + (table[hi] - table[lo]) * (x - lo);
}

/**
 * Translate a value-bet bar written on the HEADS-UP equity scale into the
 * equivalent bar for `oppCount` opponents, preserving the PERCENTILE of hand
 * strength the bar was calibrated to mean.
 *
 * Heads-up it returns the bar unchanged, so nothing about HU play moves.
 */
export function multiwayValueBar(headsUpBar: number, oppCount: number): number {
  const n = Math.max(1, Math.min(4, Math.floor(oppCount)));
  if (n === 1) return headsUpBar;
  const q = quantileOf(EQ_DECILES[1], headsUpBar);
  return valueAtQuantile(EQ_DECILES[n], q);
}

/**
 * Omaha preflop strength ON THE HOLD'EM SCALE — what decidePreflopV7's
 * thresholds have always assumed they were being handed. Percentile first
 * (through the Omaha reservoir), then the hold'em score at that same
 * quantile. See omahaPreflopPercentile and holdemCdf for the measurements.
 */
export function omahaPreflopStrength(cards: Card[], isHiLo: boolean): number {
  if (cards.length < 4) return omahaPreflopScore(cards, isHiLo);
  const p = omahaPreflopPercentile(cards, isHiLo);
  const cdf = holdemCdf();
  const idx = Math.min(cdf.length - 1, Math.max(0, Math.round(p * (cdf.length - 1))));
  return cdf[idx];
}

export function omahaPreflopPercentile(cards: Card[], isHiLo: boolean): number {
  const raw = omahaPreflopScore(cards, isHiLo);
  const holeCount = cards.length;
  // Below four cards there is no Omaha hand to rank; the raw score is all
  // there is, and callers already guard this.
  if (holeCount < 4) return raw;

  const key = `${holeCount}${isHiLo ? 'h' : ''}`;
  let rv = omahaReservoirs.get(key);
  if (!rv) {
    rv = buildOmahaReservoir(holeCount, isHiLo);
    omahaReservoirs.set(key, rv);
  }
  const s = rv.scores;
  const n = s.length;
  if (n === 0) return raw;

  // lower bound: how many reservoir scores are strictly below this hand
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] < raw) lo = mid + 1;
    else hi = mid;
  }
  const lower = lo;
  // upper bound: end of the tie block
  let lo2 = lower;
  let hi2 = n;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (s[mid] <= raw) lo2 = mid + 1;
    else hi2 = mid;
  }
  return clamp01((lower + lo2) / 2 / n);
}

export function placeOmahaBandCombo(
  deck: Card[],
  windowStart: number,
  n: number,
  band: [number, number],
  holeCount: number,
  isHiLo: boolean
): boolean {
  const key = `${holeCount}${isHiLo ? 'h' : ''}`;
  let rv = omahaReservoirs.get(key);
  if (!rv) {
    rv = buildOmahaReservoir(holeCount, isHiLo);
    omahaReservoirs.set(key, rv);
  }
  const size = rv.combos.length;
  // Percentile (CDF-index) mapping, clamped to a legal slice.
  const lo = Math.max(0, Math.min(size - 1, Math.floor(clamp01(band[0]) * size)));
  const hi = Math.max(lo + 1, Math.min(size, Math.ceil(clamp01(band[1]) * size)));
  if (band[0] > 1 || band[1] < 0 || band[1] <= band[0]) return false;
  const span = hi - lo;

  cardAvail.fill(0);
  for (let i = windowStart; i < n; i++) cardAvail[cardId(deck[i])] = 1;

  for (let attempt = 0; attempt < 24; attempt++) {
    const idx = lo + Math.floor(fastRandom() * span);
    const combo = rv.combos[idx];
    let ok = true;
    for (const c of combo) {
      if (!cardAvail[cardId(c)]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Swap by CARD ID, not object identity — the deck's card objects are not
    // guaranteed to be the reservoir's references, and an identity mismatch
    // here would silently leave the uniform window in place while reporting
    // success (the exact shape of silent failure this codebase hunts).
    for (let k = 0; k < combo.length; k++) {
      const wantId = cardId(combo[k]);
      const slot = windowStart + k;
      if (cardId(deck[slot]) === wantId) continue;
      for (let j = slot + 1; j < n; j++) {
        if (cardId(deck[j]) === wantId) {
          const t = deck[slot];
          deck[slot] = deck[j];
          deck[j] = t;
          break;
        }
      }
    }
    return true;
  }
  return false;
}

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
    // V13: the trim was HALVING the sample in exactly the spots that matter
    // most — multiway banded pots — and the measured cost was severe. Run to
    // run, a banded 4-opponent PLO estimate moved by 2sd = 6.5 to 10.4
    // percentage points, against strategy tiers only 10 to 12 points apart:
    // a PLO decision could land in a different tier from the RNG alone, and
    // the difficultyHint "tank on close spots" read was measuring noise.
    // Measured latency at the untrimmed count is 11-13 ms against a 25 ms
    // budget, so the trim was buying headroom the engine did not need.
    // Softened to a light trim for the widest multiway case only.
    iterations = Math.max(120, Math.floor(iterations * (numOpponents >= 3 ? 0.85 : 1)));
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
  // V13: the floor used to be Math.max(60, ...), which for a trimmed Omaha
  // budget of 60 made checkpoint[0] EQUAL the whole budget — a no-op — and left
  // the other two out of order. The adaptive early exit was therefore dead for
  // every Omaha variant, while the iteration counts had been cut on the
  // assumption that it was live. Sorted, with a floor that can actually be
  // reached, the exit works again and pays for the larger samples above on the
  // decisions that are not close.
  const checkpoints = adaptive
    ? [
        Math.max(30, Math.floor(iterations * 0.4)),
        Math.floor(iterations * 0.65),
        Math.floor(iterations * 0.85),
      ].sort((a, b) => a - b)
    : null;
  let done = 0;
  // V40: the board shape the tiered Omaha sampler keys on, computed once.
  const omahaTierShape =
    vi.isOmaha &&
    boardCards.length >= 3 &&
    oppReads &&
    oppReads.some((r) => r && (r.aggrW > 0 || r.raised))
      ? omahaBoardShape(boardCards)
      : null;

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
    } else if (holeCards.length === 3) {
      // V35 pineapple: only two of the three ever play.
      heroHi = scoreBestTwoOfThree(holeCards, board, vi.isShortDeck);
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

        // V13: NLH-family two-card ranges are sampled EXACTLY from the
        // enumerated combo table — no rejection, no closest-miss fallback.
        // Measured bias of the old path on a [0.85,1.0] read: +17 equity
        // points in hero's favour. Omaha keeps rejection sampling because its
        // combo space cannot be enumerated.
        if (!vi.isOmaha && oppHole === 2) {
          if (placeBandCombo(deck, windowStart, n, band, vi.isShortDeck)) {
            oppCards[0] = deck[windowStart];
            oppCards[1] = deck[windowStart + 1];
          }
          // If the band has nothing left that avoids the dealt cards, the
          // uniform draw already in the window stands — the same fail-safe
          // the old code had, but now it is the rare case rather than the
          // majority one.
        } else if (
          vi.isOmaha &&
          placeOmahaBandCombo(deck, windowStart, n, band, oppHole, vi.isHiLo)
        ) {
          // V16: sampled exactly from the reservoir slice — no rejection, no
          // closest-miss fallback. Collisions with dealt cards fall through
          // to the legacy path below.
          for (let i = 0; i < oppHole; i++) oppCards[i] = deck[windowStart + i];
        } else {
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
        } // end Omaha rejection-sampling branch (V13)
      }

      // ═══ V12 BOARD-CONTACT CONDITIONING (NLH family, flop+) ═══
      // The preflop band says which hands an opponent STARTED with; it says
      // nothing about which of those hands bet this board. An aggressor's
      // sampled hands are pushed toward board CONTACT (pairs, draws) with a
      // probability scaled by how hard they have been betting; a passive
      // checked line gets its monsters down-sampled (capped stays capped).
      const read = oppReads ? oppReads[o] : null;
      // ═══ V15 OMAHA BOARD-CONTACT CONDITIONING (Dan 2026-08-26) ═══
      // The V12 conditioning below was NLH-only, so a PLO opponent RAISING on
      // a three-flush board was still sampled from his preflop band — mostly
      // hands with no flush — and a 9-high flush priced itself as a 75-85%
      // favourite against a range that in reality is full of bigger flushes.
      // This is the equity overstatement behind every "called off with the
      // small flush" hand. Omaha aggressors are now pushed toward hands that
      // CONTACT the board, using a cheap structural test (no scoring) and at
      // most two redraws so the MC budget is untouched. Tight bands skip it:
      // the Omaha band redraw cannot re-test the band (the V13 NLH collapse),
      // so conditioning there would trade one bias for another — the explicit
      // nut-discipline penalty in HorseLogic covers those pots instead.
      if (read && vi.isOmaha && boardCards.length >= 3 && (read.aggrW > 0 || read.raised)) {
        const bandWidth = band ? band[1] - band[0] : 1;
        // ═══ V40 TIERED OMAHA AGGRESSOR SAMPLING (Dan 2026-09-04) ═══
        // The V15 contact test above accepted almost every Omaha hand, so a
        // pot-pot-pot line was priced against the preflop band. The
        // aggressor's sampled hand must now reach a MADE CATEGORY that
        // scales with the line (see omahaTierRequirement), with a share of
        // the range left as bluffs and (before the river) strong draws
        // standing in for made hands. Tight bands (a 3-bet range) keep the
        // in-band sampler on every redraw so the V13 collapse cannot recur.
        const tier40 = read.streets != null ? omahaAggressorTier(read) : 0;
        if (tier40 >= 1 && omahaTierShape != null) {
          const req = omahaTierRequirement(tier40, boardCards.length, omahaTierShape);
          const tries = tier40 >= 3 ? 4 : 3;
          for (let t = 0; t < tries; t++) {
            const c40 = omahaQuickCategory(oppCards, boardCards);
            if (c40 >= req.minCat) break;
            if (c40 >= req.drawMinCat && omahaStrongDrawShape(oppCards, boardCards)) break;
            if (t === 0 && fastRandom() >= req.pStrong) break; // the bluff share
            const placed =
              band != null
                ? placeOmahaBandCombo(deck, windowStart, n, band, oppHole, vi.isHiLo)
                : false;
            if (!placed) {
              for (let i = 0; i < oppHole; i++) {
                const slot = windowStart + i;
                const j = slot + Math.floor(fastRandom() * (n - slot));
                const tmp = deck[slot];
                deck[slot] = deck[j];
                deck[j] = tmp;
              }
            }
            for (let i = 0; i < oppHole; i++) oppCards[i] = deck[windowStart + i];
          }
        } else if (bandWidth >= 0.45 && read.aggrW > 0) {
          const pConnect = Math.min(0.85, 0.4 + read.aggrW * 2.0);
          for (let t = 0; t < 2; t++) {
            if (omahaConnectsBoard(oppCards, boardCards)) break;
            if (fastRandom() >= pConnect) break; // some of the range IS air
            const placed =
              band != null
                ? placeOmahaBandCombo(deck, windowStart, n, band, oppHole, vi.isHiLo)
                : false;
            if (!placed) {
              for (let i = 0; i < oppHole; i++) {
                const slot = windowStart + i;
                const j = slot + Math.floor(fastRandom() * (n - slot));
                const tmp = deck[slot];
                deck[slot] = deck[j];
                deck[j] = tmp;
              }
            }
            for (let i = 0; i < oppHole; i++) oppCards[i] = deck[windowStart + i];
          }
        }
      }
      if (read && !vi.isOmaha && boardCards.length >= 3) {
        // V13: the redraw must STAY IN THE READ. It used to draw uniformly
        // from the whole remaining deck and never re-test the band, so any
        // in-band hand that failed to connect was replaced by an
        // unconditioned random one — the intersection "in band AND
        // connecting" was never sampled and the model collapsed to "anything
        // that connects". A 3-bettor's c-betting range acquired bottom two
        // pair and 72o, inflating villain equity and folding the horse's top
        // pair on a dry board. When a band is present the redraw now draws
        // from the band; without one it stays uniform, as before.
        const band13 = oppBands ? oppBands[o] : null;
        const redraw = () => {
          if (
            band13 &&
            oppHole === 2 &&
            placeBandCombo(deck, windowStart, n, band13, vi.isShortDeck)
          ) {
            oppCards[0] = deck[windowStart];
            oppCards[1] = deck[windowStart + 1];
            return;
          }
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
          // V16: a BIG bet is sampled toward REAL strength (two pair+), not
          // just any contact — an overbettor's range is not middle pair.
          const wantCat = read.bigBet ? 3 : 2;
          const pConnect = Math.min(0.9, (read.bigBet ? 0.55 : 0.4) + read.aggrW * 2.2);
          const tries = read.bigBet ? 4 : 3;
          for (let t = 0; t < tries; t++) {
            if (connectsBoard(oppCards, boardCards, vi.isShortDeck) >= wantCat) break;
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
      } else if (oppHole === 3) {
        oppHi = scoreBestTwoOfThree(oppCards, board, vi.isShortDeck);
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
    else if (suited)
      // V28 AUDIT FIX: wheel-ace suits (A2s-A5s) were the lowest-scored
      // suited aces (0.520-0.544), which put every one of them BELOW the
      // 0.55 3-bet-bluff floor in HorsePreflop — the canonical ace-blocker
      // bluffs were unplayable as bluffs, while KTo/QJo (0.56-0.58) bluffed
      // instead. A5s>A4s>A3s>A2s for the straight, and all four sit above
      // A6s (the true bottom of the suited-ace ladder, no wheel, no
      // broadway). The ladder now says so.
      score =
        lo <= 5
          ? 0.556 + (lo - 2) * 0.006 // A2s 0.556 .. A5s 0.574
          : 0.535 + (lo - 6) * 0.01;
    // A6s 0.535 .. A9s 0.565
    else score = 0.34 + (lo - 2) * 0.01; // Axo
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
      // V28 AUDIT FIX: J9 was 0.55s/0.38o — scored ABOVE K9s (0.45) and
      // Q9s (0.41), both of which dominate it. Connectivity is worth
      // something; domination is worth more.
      score = suited ? 0.44 : 0.27; // J9
    else
      // V28: Jx low was 0.30+(lo-2)*0.01, which put J8s (0.36) BELOW T8s
      // (0.40) — a strictly dominated ordering. Lifted so Jx >= the same-gap
      // Tx hand.
      score = suited ? 0.33 + (lo - 2) * 0.012 : 0.13 + (lo - 2) * 0.011;
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
      // V28 AUDIT FIX: this bucket scored on high card ONLY, so 72s (0.224)
      // outranked 43s (0.188) and 72o outranked four hands that beat it.
      // Wide-gap rags now pay for their gap: 43s keeps its connectivity
      // credit above, and 72 sinks to the bottom where it belongs.
      const gapDrag = Math.max(0, gap - 2) * 0.014;
      score = suited
        ? Math.max(0.1, 0.14 + hi * 0.012 - gapDrag)
        : Math.max(0.02, 0.02 + hi * 0.01 - gapDrag);
    }
  }

  if (shortDeck) {
    // Short deck: suited/connected value rises, small pairs & offsuit rags
    // matter less, AK is effectively stronger (fewer dominated hands).
    if (suited) score += 0.03;
    if (!pair && gap <= 1) score += 0.03;
    if (pair && hi <= 9) score -= 0.04;
    if (hi === 14 && lo === 13) score += 0.02;
    // V28 AUDIT FIX: the A-6-7-8-9 wheel was not modelled at all. In short
    // deck the ace plays low in that straight, so A6-A9 are connectors —
    // the code computed gap = 14-lo and gave them nothing. A6s was scored
    // below A9s exactly as in the full deck, which is the wrong game.
    if (!pair && hi === 14 && lo >= 6 && lo <= 9) score += 0.035;
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
  //
  // V15 (Dan 2026-08-26): the raw point sum grows with every extra hole card
  // (more pairs, more suits, more connections exist in 5 and 6 cards), and a
  // single /30 divisor let that growth masquerade as hand strength. Measured
  // over 200k random hands per variant: the MEDIAN plo6 hand scored 0.53 and
  // the median plo5 hand 0.40 against plo4's 0.24 — above the facing-a-raise
  // call threshold (0.52) on a completely average holding, which is why the
  // plo5/plo6 fleets played far too many hands far too hard. Subtracting the
  // measured median shift aligns the distributions almost exactly (p85 within
  // 0.2 points, p95 within 1.4 points of plo4's curve), so a percentile
  // threshold now selects the same QUALITY of hand in every Omaha variant.
  const holeShift = cards.length >= 6 ? 8.8 : cards.length === 5 ? 4.7 : 0;
  return clamp01((pts - holeShift) / 30);
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
