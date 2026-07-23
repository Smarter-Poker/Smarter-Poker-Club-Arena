/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE AI — Server-Side Horse Decision Engine (V2 — 2026-07-23 full rewrite)
 * ═══════════════════════════════════════════════════════════════════════════════
 * ALL horses are fundamentally WINNING poker players.
 * They have DIFFERENT STYLES, but they all play sound, +EV poker.
 * NEVER refer to them as "bots" — they are HORSES only.
 *
 * V2 upgrades over the original engine:
 *  - Position-aware preflop play (EP/MP/CO/BTN/SB/BB) with a proper tiered
 *    169-combo hand classifier instead of the old Chen-style score.
 *  - Raise-context awareness: open vs limped vs single-raised vs 3-bet+ pots,
 *    limper/caller counts, squeeze spots, correct raise-TO sizing.
 *  - Real postflop equity via fast Monte Carlo simulation (draws are priced
 *    correctly — the old engine folded every flush draw to a single bet).
 *  - Full variant support: nlh, short_deck (stripped deck + flush > full house),
 *    plo4/plo5/plo6 (true Omaha 2+3 evaluation, pot-limit sizing caps),
 *    plo8 (hi-lo scoop awareness), pineapple (3-card hands + smart discard).
 *  - Opponent-count-aware thresholds (multiway pots tighten value/bluff mixes).
 *  - SPR-based commitment logic and short-stack push/fold play.
 *  - Guaranteed-legal outputs: every amount is clamped to the engine's
 *    min-bet / min-raise / pot-limit / stack rules and rounded to whole cents.
 *  - Style resolution hardened: accepts string profiles, jsonb object profiles
 *    ({"style":"tag",...}) or anything else — falls back to a deterministic
 *    per-horse hash so all 574 horses do NOT play the same style.
 *
 * ZERO browser dependencies. Runs on Node.js. Decisions are synchronous and
 * budgeted to stay under ~15ms even for 6-card PLO.
 */

import type {
  Card,
  SeatPlayer,
  HandStage,
  HorseStyle,
  HorseDecision,
  HorseGameState,
  ActionRecord,
} from '../types.js';
import {
  SUITS,
  RANKS,
  RANK_VALUES,
  validateAction,
  calculateBettingState,
} from './PokerEngine.js';

// BUG 020 FIX (2026-04-15) — round chip amounts to whole cents so horse decisions
// don't pollute hand_history.actions with 15-digit floats. Bible V8 §2.6.
const toCents = (n: number): number => Math.round(n * 100) / 100;
// Directional cent snapping for clamping against legal minimums / maximums:
// floor against a max cap (never exceed it), ceil against a min bound.
const floorCents = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;
const ceilCents = (n: number): number => Math.ceil(n * 100 - 1e-9) / 100;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// ═══════════════════════════════════════════════════════════════════════════════
// FAST PRNG — strategy mixing does not need crypto randomness, it needs speed.
// (Card dealing uses CryptoRandom; this is only for decision mixing + MC deals.)
// ═══════════════════════════════════════════════════════════════════════════════

let rngState = (Date.now() ^ 0x9e3779b9) >>> 0;
function fastRandom(): number {
  // xorshift32 — ~4x faster than Math.random in tight MC loops and good enough
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0xffffffff;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE PARAMETERS — All styles are winning; they differ in HOW they win
// ═══════════════════════════════════════════════════════════════════════════════

interface StyleParams {
  /** <1 = looser preflop, >1 = tighter preflop */
  tightness: number;
  /** scales bluff / semi-bluff frequencies */
  bluffFreq: number;
  /** scales 3-bet / raise aggression */
  aggression: number;
  /** probability of trapping with a monster instead of fast-playing */
  slowplayFreq: number;
  /** probability of raising (instead of calling) when facing a bet with a strong hand */
  checkRaiseFreq: number;
  /** scales bet sizes */
  sizingMultiplier: number;
  /** humanlike think-time range in ms */
  thinkRange: [number, number];
}

const STYLE_PARAMS: Record<HorseStyle, StyleParams> = {
  tag: {
    tightness: 1.06,
    bluffFreq: 0.12,
    aggression: 1.1,
    slowplayFreq: 0.1,
    checkRaiseFreq: 0.1,
    sizingMultiplier: 1.0,
    thinkRange: [1400, 4200],
  },
  lag: {
    tightness: 0.9,
    bluffFreq: 0.24,
    aggression: 1.25,
    slowplayFreq: 0.12,
    checkRaiseFreq: 0.16,
    sizingMultiplier: 1.12,
    thinkRange: [1100, 3600],
  },
  balanced: {
    tightness: 1.0,
    bluffFreq: 0.17,
    aggression: 1.0,
    slowplayFreq: 0.18,
    checkRaiseFreq: 0.13,
    sizingMultiplier: 1.0,
    thinkRange: [1500, 4600],
  },
  tricky: {
    tightness: 1.0,
    bluffFreq: 0.2,
    aggression: 0.95,
    slowplayFreq: 0.32,
    checkRaiseFreq: 0.24,
    sizingMultiplier: 0.92,
    thinkRange: [1700, 5200],
  },
  grinder: {
    tightness: 1.12,
    bluffFreq: 0.09,
    aggression: 0.95,
    slowplayFreq: 0.12,
    checkRaiseFreq: 0.09,
    sizingMultiplier: 0.88,
    thinkRange: [1200, 3800],
  },
};

/** Optional per-horse modifiers stored in profiles.horse_profile (jsonb). */
export interface HorseProfileMods {
  aggression?: number;
  tightness?: number;
  bluffFreq?: number;
  sizingMultiplier?: number;
}

/**
 * Resolve any horse_profile value (string, jsonb object, null, legacy names)
 * into a concrete style + modifiers. Falls back to a DETERMINISTIC hash of the
 * horse's user id so a fleet with empty profiles still gets stable diversity.
 */
export function resolveHorseStyle(
  profile: unknown,
  horseId: string
): { style: HorseStyle; mods: HorseProfileMods } {
  const legacyMap: Record<string, HorseStyle> = {
    tag: 'tag',
    lag: 'lag',
    balanced: 'balanced',
    tricky: 'tricky',
    grinder: 'grinder',
    reg: 'tag',
    fish: 'balanced',
    nit: 'grinder',
    maniac: 'lag',
    whale: 'lag',
    shark: 'tag',
  };

  let styleName: string | undefined;
  let mods: HorseProfileMods = {};

  if (typeof profile === 'string') {
    styleName = profile.toLowerCase();
  } else if (profile && typeof profile === 'object') {
    const obj = profile as Record<string, unknown>;
    const cand = obj.style ?? obj.type ?? obj.personality ?? obj.profile;
    if (typeof cand === 'string') styleName = cand.toLowerCase();
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && isFinite(v) ? v : undefined;
    mods = {
      aggression: num(obj.aggression),
      tightness: num(obj.tightness),
      bluffFreq: num(obj.bluffFreq ?? obj.bluff_freq),
      sizingMultiplier: num(obj.sizingMultiplier ?? obj.sizing_multiplier),
    };
  }

  let style = styleName ? legacyMap[styleName] : undefined;
  if (!style) {
    // Deterministic per-horse fallback: hash the id onto the 5 styles so the
    // fleet is diverse even when horse_profile is {} for every row.
    let h = 0;
    for (let i = 0; i < horseId.length; i++) {
      h = (h * 31 + horseId.charCodeAt(i)) >>> 0;
    }
    const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
    style = styles[h % styles.length];
  }
  return { style, mods };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type VariantInfo = {
  holeCount: number;
  isOmaha: boolean;
  isHiLo: boolean;
  isShortDeck: boolean;
  isPotLimit: boolean;
  /** MC iterations per street decision (budgeted for <15ms total) */
  iterations: number;
};

function variantInfo(gameVariant: string): VariantInfo {
  const v = (gameVariant || 'nlh').toLowerCase();
  const isOmaha = v.startsWith('plo');
  const holeCount =
    v === 'plo5' ? 5 : v === 'plo6' ? 6 : isOmaha ? 4 : v === 'pineapple' ? 3 : 2;
  return {
    holeCount,
    isOmaha,
    isHiLo: v === 'plo8',
    isShortDeck: v === 'short_deck',
    isPotLimit: isOmaha,
    iterations:
      v === 'plo6' ? 120 : v === 'plo5' ? 170 : v === 'plo8' ? 140 : isOmaha ? 220 : 450,
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
function straightTop(mask: number, shortDeck: boolean): number {
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
function scoreHoldem(cards: Card[], count: number, shortDeck: boolean): number {
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
function scoreOmahaHi(hole: Card[], board: Card[]): number {
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

const LOW_RANK = (r: number): number => (r === 14 ? 1 : r);

/**
 * Omaha 8-or-better low: exactly 2 hole + 3 board, five DISTINCT ranks all <= 8
 * (ace plays low). Returns an encoded value where SMALLER = better, or
 * Infinity when no qualifying low exists.
 */
function scoreOmahaLow(hole: Card[], board: Card[]): number {
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
      const mask =
        (1 << h1) | (1 << h2) | (1 << b1) | (1 << b2) | (1 << b3);
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
// MONTE CARLO EQUITY — variant-aware, opponent-count-aware, draw-aware
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate hero's equity (0..1) vs `numOpponents` random hands. Handles all
 * supported variants. Draws are priced naturally because the runout completes
 * the board every iteration.
 */
function simulateEquity(
  holeCards: Card[],
  boardCards: Card[],
  numOpponents: number,
  vi: VariantInfo,
  iterations: number
): number {
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
      for (let c = 0; c < oppHole; c++) oppCards[c] = deck[dealIdx++];

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
    } else {
      const loShare = heroBestLow && bestLow !== Infinity ? 1 / lowTies : 0;
      score += hiShare * 0.5 + loShare * 0.5;
    }
  }

  return score / iterations;
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

function preflopEquity(holeCards: Card[], numOpponents: number, vi: VariantInfo, variant: string): number {
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
function holdemPreflopScore(c1: Card, c2: Card, shortDeck: boolean): number {
  const r1 = RANK_VALUES[c1.rank];
  const r2 = RANK_VALUES[c2.rank];
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const suited = c1.suit === c2.suit;
  const pair = r1 === r2;
  const gap = hi - lo;

  let score: number;

  if (pair) {
    if (hi === 14) score = 1.0; // AA
    else if (hi === 13) score = 0.98; // KK
    else if (hi === 12) score = 0.95; // QQ
    else if (hi === 11) score = 0.9; // JJ
    else if (hi === 10) score = 0.86; // TT
    else if (hi === 9) score = 0.78; // 99
    else if (hi === 8) score = 0.72; // 88
    else if (hi === 7) score = 0.65; // 77
    else score = 0.45 + (hi - 2) * 0.03; // 22..66 -> 0.45..0.57
  } else if (hi === 14) {
    // Ace-high hands
    if (lo === 13) score = suited ? 0.96 : 0.93; // AK
    else if (lo === 12) score = suited ? 0.88 : 0.83; // AQ
    else if (lo === 11) score = suited ? 0.82 : 0.74; // AJ
    else if (lo === 10) score = suited ? 0.76 : 0.66; // AT
    else score = suited ? 0.52 + (lo - 2) * 0.008 : 0.34 + (lo - 2) * 0.01; // Axs / Axo
  } else if (hi === 13) {
    // King-high
    if (lo === 12) score = suited ? 0.79 : 0.7; // KQ
    else if (lo === 11) score = suited ? 0.73 : 0.62; // KJ
    else if (lo === 10) score = suited ? 0.68 : 0.56; // KT
    else score = suited ? 0.38 + (lo - 2) * 0.01 : 0.2 + (lo - 2) * 0.012;
  } else if (hi === 12) {
    if (lo === 11) score = suited ? 0.7 : 0.58; // QJ
    else if (lo === 10) score = suited ? 0.65 : 0.52; // QT
    else score = suited ? 0.34 + (lo - 2) * 0.01 : 0.16 + (lo - 2) * 0.011;
  } else if (hi === 11) {
    if (lo === 10) score = suited ? 0.64 : 0.5; // JT
    else if (lo === 9) score = suited ? 0.55 : 0.38; // J9
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
function omahaPreflopScore(cards: Card[], isHiLo: boolean): number {
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
    if (hasA && has2) pts += 6;
    else if (hasA && has3) pts += 4;
    else if (has2 && has3) pts += 2;
    const lowCount = ranks.filter((r) => r <= 8 || r === 14).length;
    if (lowCount >= 3) pts += 1.5;
  }

  // Normalize: premium AAKK-ds style hands land around 28-32 points.
  return clamp01(pts / 30);
}

/** Pineapple (3-card) preflop: best 2-card combo + backup potential. */
function pineapplePreflopScore(cards: Card[], shortDeck: boolean): number {
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

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION
// ═══════════════════════════════════════════════════════════════════════════════

type PositionClass = 'early' | 'middle' | 'late' | 'sb' | 'bb';

function classifyPosition(
  heroSeat: number,
  dealerSeat: number | undefined,
  players: SeatPlayer[]
): PositionClass {
  const inHand = players
    .filter((p) => !p.is_folded || p.seat === heroSeat)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  if (dealerSeat === undefined || inHand.length < 2) return 'middle';

  // Order seats clockwise starting after the dealer: SB, BB, UTG, ..., BTN
  const after = (seat: number) => {
    const higher = inHand.filter((s) => s > seat);
    return higher.length > 0 ? higher : inHand;
  };
  const order: number[] = [];
  let cur = dealerSeat;
  for (let i = 0; i < inHand.length; i++) {
    const nxt = after(cur)[0];
    order.push(nxt);
    cur = nxt;
    if (order.length > 1 && nxt === order[0]) break;
  }
  const idx = order.indexOf(heroSeat);
  const n = order.length;
  if (idx === -1) return 'middle';
  if (n === 2) return idx === 0 ? 'sb' : 'bb'; // heads-up: dealer is SB
  if (idx === 0) return 'sb';
  if (idx === 1) return 'bb';
  // Remaining players: first third early, last two late, rest middle
  const nonBlind = n - 2;
  const pos = idx - 2; // 0-based among non-blind seats
  if (pos >= nonBlind - 2) return 'late';
  if (pos < Math.ceil(nonBlind / 3)) return 'early';
  return 'middle';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DECISION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/** Extended game state — ServerTableEngine passes the full HandController view. */
export interface HorseGameStateV2 extends HorseGameState {
  dealerSeat?: number;
  lastRaise?: number;
  actionHistory?: ActionRecord[];
}

export class HorseLogic {
  static decide(
    player: SeatPlayer,
    gameState: HorseGameStateV2,
    style: HorseStyle = 'balanced',
    mods: HorseProfileMods = {}
  ): HorseDecision {
    try {
      return this.decideInternal(player, gameState, style, mods);
    } catch {
      // Absolute safety net: never let a horse hang the table.
      const toCall = Math.max(0, (gameState.currentBet || 0) - (player.bet || 0));
      return toCall === 0
        ? { action: 'check', thinkTime: 1500 }
        : { action: 'fold', thinkTime: 1500 };
    }
  }

  private static decideInternal(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    styleName: HorseStyle,
    mods: HorseProfileMods
  ): HorseDecision {
    const base = STYLE_PARAMS[styleName] || STYLE_PARAMS.balanced;
    const params: StyleParams = {
      ...base,
      tightness: base.tightness * (mods.tightness ?? 1),
      bluffFreq: base.bluffFreq * (mods.bluffFreq ?? 1),
      aggression: base.aggression * (mods.aggression ?? 1),
      sizingMultiplier: base.sizingMultiplier * (mods.sizingMultiplier ?? 1),
    };

    const vi = variantInfo(gs.gameVariant);
    const toCall = Math.max(0, gs.currentBet - player.bet);

    let decision: HorseDecision;
    if (gs.stage === 'preflop') {
      decision = this.decidePreflop(player, gs, vi, params);
    } else {
      decision = this.decidePostflop(player, gs, vi, params);
    }

    decision = this.legalize(decision, player, gs, vi);
    decision.thinkTime = this.computeThinkTime(decision, gs, params, toCall);
    return decision;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PREFLOP
  // ─────────────────────────────────────────────────────────────────────────

  private static decidePreflop(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, bigBlind, pot } = gs;
    const bb = bigBlind > 0 ? bigBlind : 2;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const stackBB = stack / bb;

    // Hand strength 0..1 (percentile-style, variant-aware)
    let strength: number;
    if (vi.isOmaha) strength = omahaPreflopScore(player.cards, vi.isHiLo);
    else if (player.cards.length === 3) strength = pineapplePreflopScore(player.cards, vi.isShortDeck);
    else if (player.cards.length === 2)
      strength = holdemPreflopScore(player.cards[0], player.cards[1], vi.isShortDeck);
    else strength = 0.3;

    // Small per-decision jitter creates mixed strategies at the boundaries.
    strength = clamp01(strength + (fastRandom() * 0.06 - 0.03));

    // Read the action so far this street.
    const history = (gs.actionHistory || []).filter((a) => a.stage === 'preflop');
    let raises = 0;
    let limpers = 0;
    let callers = 0;
    for (const a of history) {
      if (a.action === 'raise' || a.action === 'bet') raises++;
      else if (a.action === 'all_in' && a.isFullRaise) raises++;
      else if (a.action === 'call') {
        if (raises === 0) limpers++;
        else callers++;
      }
    }
    // Fallback when history is unavailable: infer from bet size.
    if (history.length === 0 && currentBet > bb * 1.05) {
      raises = currentBet > bb * 4.5 ? 2 : 1;
    }

    const position = classifyPosition(player.seat, gs.dealerSeat, gs.players);
    const oppsLeft = gs.players.filter((p) => !p.is_folded && p.seat !== player.seat).length;

    // Position-based open thresholds (percentile strength required)
    const OPEN_THRESH: Record<PositionClass, number> = {
      early: 0.62,
      middle: 0.54,
      late: 0.42,
      sb: 0.5,
      bb: 0.42,
    };
    const t = (x: number) => clamp01(x * params.tightness);

    const unopened = raises === 0 && currentBet <= bb * 1.05;

    // ── Short-stack push/fold (cash short stacks + tournament endgame) ──
    if (stackBB <= 12 && !vi.isOmaha) {
      if (unopened) {
        const jamThresh = position === 'late' || position === 'sb' ? 0.5 : 0.6;
        if (strength >= t(jamThresh)) return { action: 'all_in', thinkTime: 0 };
        if (toCall === 0) return { action: 'check', thinkTime: 0 };
        return { action: 'fold', thinkTime: 0 };
      }
      // Facing action short-stacked: jam or fold on real strength.
      if (strength >= t(raises >= 2 ? 0.85 : 0.72)) return { action: 'all_in', thinkTime: 0 };
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      if (toCall <= bb && strength >= 0.3) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Unopened pot (or limpers only) ──
    if (unopened) {
      const openThresh = t(OPEN_THRESH[position]) + Math.min(limpers, 3) * 0.03;
      if (strength >= openThresh) {
        // Occasionally trap with a true premium
        if (strength > 0.93 && fastRandom() < params.slowplayFreq * 0.4 && toCall <= bb) {
          if (toCall === 0) return { action: 'check', thinkTime: 0 };
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        const sizeBB = (2.2 + fastRandom() * 0.8 + limpers * 1.0) * params.sizingMultiplier;
        return this.raiseTo(sizeBB * bb, player, gs, vi);
      }
      // Below opening threshold: free check, limp-behind with playable hands,
      // otherwise fold to a raise / complete cheap in the blinds.
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      const limpable = strength >= openThresh - 0.12;
      if (toCall <= bb && (limpable || position === 'sb') && fastRandom() < 0.7) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (toCall <= bb * 1.5 && strength >= 0.3) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Facing a single raise ──
    if (raises === 1) {
      const threeBetThresh = t(0.82 - (params.aggression - 1) * 0.08);
      const callThresh = t(0.52) + callers * 0.025 + (position === 'early' ? 0.04 : 0);
      const priceOK = toCall <= Math.max(bb * 12, stack * 0.12);
      const bbDiscount = position === 'bb' ? 0.06 : 0;

      if (strength >= threeBetThresh) {
        // Squeeze bigger when there are callers behind the raiser.
        if (strength > 0.95 && fastRandom() < params.slowplayFreq * 0.5 && callers === 0) {
          return { action: 'call', amount: toCall, thinkTime: 0 }; // trap
        }
        const ip = position === 'late';
        const mult = (ip ? 3.0 : 3.8) + callers * 1.0 + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      // Light 3-bet mix from the right hands (suited playables, not pure junk)
      if (
        strength >= t(0.55) &&
        strength < threeBetThresh &&
        callers === 0 &&
        fastRandom() < params.bluffFreq * params.aggression * 0.35
      ) {
        const ip = position === 'late';
        const mult = (ip ? 3.0 : 3.8) + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      if (strength >= callThresh - bbDiscount && priceOK) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // Big-blind price-in: closing the action getting a huge price
      if (position === 'bb' && toCall <= bb * 2.5 && strength >= 0.3) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Facing a 3-bet or bigger ──
    {
      const fourBetThresh = t(0.93 - (params.aggression - 1) * 0.04);
      const callThresh = t(0.78);
      if (strength >= fourBetThresh) {
        if (raises >= 3 || currentBet * 2.3 >= stack * 0.4) {
          return { action: 'all_in', thinkTime: 0 };
        }
        const mult = 2.2 + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      if (strength >= callThresh && toCall <= stack * 0.35) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // Getting a monster price closing the action
      if (toCall > 0 && toCall <= pot * 0.15 && strength >= 0.45) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POSTFLOP — equity-driven for every street and every variant
  // ─────────────────────────────────────────────────────────────────────────

  private static decidePostflop(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;
    const street: HandStage = gs.stage;
    const isRiver = street === 'river';
    const drawsLive = street === 'flop' || street === 'turn' || street === 'pineapple_discard';

    const opponents = gs.players.filter(
      (p) => !p.is_folded && p.seat !== player.seat && !p.is_sitting_out
    );
    const oppCount = Math.max(1, opponents.length);

    // Real equity vs opponent count — draws priced by the runout.
    const equity = simulateEquity(
      player.cards,
      gs.communityCards,
      Math.min(oppCount, 4),
      vi,
      vi.iterations
    );

    // Multiway tightening: each extra opponent raises the bar.
    const mw = (oppCount - 1) * 0.03;
    const spr = pot > 0 ? stack / pot : 10;

    // ═══ Not facing a bet ═══
    if (!facingBet) {
      // Monster: usually bet big, sometimes trap.
      if (equity >= 0.8 + mw) {
        if (!isRiver && fastRandom() < params.slowplayFreq && oppCount <= 2) {
          return { action: 'check', thinkTime: 0 };
        }
        return this.betSize(pot, 0.65 + fastRandom() * 0.25, player, gs, vi, params);
      }
      // Strong value
      if (equity >= 0.62 + mw) {
        return this.betSize(pot, 0.5 + fastRandom() * 0.2, player, gs, vi, params);
      }
      // Thin value / protection
      if (equity >= 0.52 + mw && fastRandom() < 0.65) {
        return this.betSize(pot, 0.33 + fastRandom() * 0.15, player, gs, vi, params);
      }
      // Semi-bluff with live draws (equity from draws is in the MC number)
      if (
        drawsLive &&
        equity >= 0.3 &&
        equity < 0.52 &&
        fastRandom() < params.bluffFreq * params.aggression * (oppCount === 1 ? 1.4 : 0.7)
      ) {
        return this.betSize(pot, 0.55 + fastRandom() * 0.2, player, gs, vi, params);
      }
      // Pure bluff — mostly heads-up, rarer on the river
      if (
        equity < 0.3 &&
        oppCount === 1 &&
        fastRandom() < params.bluffFreq * (isRiver ? 0.55 : 0.8)
      ) {
        return this.betSize(pot, 0.5 + fastRandom() * 0.25, player, gs, vi, params);
      }
      return { action: 'check', thinkTime: 0 };
    }

    // ═══ Facing a bet ═══
    const potOdds = toCall / (pot + toCall);
    const betRatio = pot > 0 ? toCall / pot : 1;

    // Low-SPR commitment: with the money effectively in, play equity directly.
    const committed = spr < 1.2 || toCall >= stack;
    if (committed) {
      const required = potOdds + 0.02;
      if (equity >= Math.max(required, 0.42 + mw)) {
        return toCall >= stack
          ? { action: 'call', amount: toCall, thinkTime: 0 }
          : { action: 'all_in', thinkTime: 0 };
      }
      if (equity >= required) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // Raise for value
    const valueRaiseThresh = 0.68 + mw + (isRiver ? 0.04 : 0);
    if (equity >= valueRaiseThresh) {
      if (fastRandom() < 0.55 * params.aggression + params.checkRaiseFreq) {
        const raiseToAmt = currentBet + (pot + toCall) * (0.7 + fastRandom() * 0.4);
        return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
      }
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Semi-bluff raise with big draws (flop/turn only, not into a crowd)
    if (
      drawsLive &&
      equity >= 0.33 &&
      equity < 0.52 &&
      oppCount <= 2 &&
      betRatio <= 0.85 &&
      fastRandom() < params.bluffFreq * params.aggression * 0.5
    ) {
      const raiseToAmt = currentBet + (pot + toCall) * (0.8 + fastRandom() * 0.3);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }

    // Call when the price is right. Margin scales with bet size; draws get a
    // small implied-odds allowance before the river.
    const impliedBonus = drawsLive && equity >= 0.25 ? 0.04 : 0;
    const sizingPenalty = Math.min(0.06, betRatio * 0.04) + mw * 0.5;
    if (equity + impliedBonus >= potOdds + 0.03 + sizingPenalty) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Occasional disciplined bluff-catch vs small bets heads-up on the river
    if (
      isRiver &&
      oppCount === 1 &&
      betRatio <= 0.4 &&
      equity >= potOdds - 0.04 &&
      fastRandom() < 0.25
    ) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    return { action: 'fold', thinkTime: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PINEAPPLE DISCARD — pick the discard that maximizes equity
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Choose which of the 3 hole cards to discard (returns the card INDEX).
   * Evaluates the equity of each 2-card keep against the current board.
   */
  static decideDiscard(cards: Card[], communityCards: Card[], gameVariant: string): number {
    if (!cards || cards.length !== 3) return 2;
    const vi = variantInfo('nlh'); // after the discard the hand plays like holdem
    let bestIdx = 2;
    let bestEq = -1;
    for (let discard = 0; discard < 3; discard++) {
      const keep = cards.filter((_, i) => i !== discard);
      const eq =
        communityCards.length >= 3
          ? simulateEquity(keep, communityCards, 1, vi, 160)
          : holdemPreflopScore(keep[0], keep[1], gameVariant === 'short_deck');
      if (eq > bestEq) {
        bestEq = eq;
        bestIdx = discard;
      }
    }
    return bestIdx;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SIZING + LEGALIZATION HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Build a bet decision sized as a fraction of pot, clamped to legal bounds. */
  private static betSize(
    pot: number,
    fraction: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams
  ): HorseDecision {
    return this.legalize(
      { action: 'bet', amount: pot * fraction * params.sizingMultiplier, thinkTime: 0 },
      player,
      gs,
      vi
    );
  }

  /** Build a raise decision to an absolute amount, clamped to legal bounds. */
  private static raiseTo(
    target: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const action = gs.currentBet > 0 ? 'raise' : 'bet';
    return this.legalize({ action, amount: target, thinkTime: 0 }, player, gs, vi);
  }

  /**
   * Final safety pass: whatever the strategy produced, make it LEGAL under the
   * engine's validateAction() rules — including no-limit stack bounds,
   * min-bet / min-raise floors, pot-limit caps (Bible V8 §4.14), and whole-cent
   * amounts (Bible V8 §2.6). Falls back down the ladder raise -> call -> check
   * when a desired action has no legal sizing.
   */
  private static legalize(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const currentBet = isFinite(gs.currentBet) ? Math.max(0, gs.currentBet) : 0;
    const pot = isFinite(gs.pot) ? Math.max(0, gs.pot) : 0;
    const playerBet = isFinite(player.bet) ? Math.max(0, player.bet) : 0;
    const stack = isFinite(player.stack) ? Math.max(0, player.stack) : 0;
    const toCall = Math.max(0, currentBet - playerBet);

    // Normalize impossible action/context combinations.
    if (d.action === 'check' && toCall > 0) d = { action: 'fold', thinkTime: 0 };
    if (d.action === 'fold' && toCall === 0) d = { action: 'check', thinkTime: 0 };
    if (d.action === 'call' && toCall === 0) d = { action: 'check', thinkTime: 0 };
    if (d.action === 'bet' && currentBet > 0)
      d = { action: 'raise', amount: d.amount, thinkTime: 0 };
    if (d.action === 'raise' && currentBet === 0)
      d = { action: 'bet', amount: d.amount, thinkTime: 0 };

    if (d.action === 'call') {
      if (toCall >= stack) return { action: 'all_in', thinkTime: 0 };
      return { action: 'call', amount: toCents(toCall), thinkTime: 0 };
    }

    if (d.action === 'bet') {
      let amt = d.amount ?? gs.minRaise;
      if (!isFinite(amt) || amt <= 0) return { action: 'check', thinkTime: 0 };
      // Engine rule: min bet = minRaise (= max(bigBlind, lastRaise)).
      const minBet = ceilCents(Math.max(gs.minRaise || 0, 0.01));
      // Engine rule (pot-limit): max bet = pot + toCall.
      const maxBet = vi.isPotLimit ? floorCents(pot + toCall) : Infinity;
      if (minBet > maxBet || minBet >= stack) {
        // No legal non-all-in bet exists.
        return amt >= stack * 0.9 ? { action: 'all_in', thinkTime: 0 } : { action: 'check', thinkTime: 0 };
      }
      amt = Math.min(floorCents(amt), maxBet);
      if (amt < minBet) amt = minBet;
      if (amt >= stack * 0.92) return { action: 'all_in', thinkTime: 0 };
      return this.verifyAmount(
        { action: 'bet', amount: toCents(amt), thinkTime: 0 },
        player,
        gs,
        vi,
        { action: 'check', thinkTime: 0 }
      );
    }

    if (d.action === 'raise') {
      let amt = d.amount ?? 0;
      const fallback = (): HorseDecision =>
        toCall > 0
          ? toCall >= stack
            ? { action: 'all_in', thinkTime: 0 }
            : { action: 'call', amount: toCents(toCall), thinkTime: 0 }
          : { action: 'check', thinkTime: 0 };
      if (!isFinite(amt) || amt <= 0) return fallback();

      // Engine rules: raise-to must satisfy (amount - currentBet) >= minRaise,
      // amount <= playerBet + stack, and pot-limit (amount - currentBet) <= pot + toCall.
      const minRaiseTo = ceilCents(currentBet + Math.max(gs.minRaise || 0, 0.01));
      const maxRaiseTo = playerBet + stack;
      const potLimitTo = vi.isPotLimit ? floorCents(currentBet + pot + toCall) : Infinity;
      const cap = Math.min(maxRaiseTo, potLimitTo);

      if (minRaiseTo > cap) {
        // No legal raise sizing exists. Jam only if the jam is itself a big
        // commitment we intended; otherwise fall back to calling.
        if (amt >= maxRaiseTo && maxRaiseTo <= potLimitTo) return { action: 'all_in', thinkTime: 0 };
        return fallback();
      }
      amt = Math.min(floorCents(amt), cap);
      if (amt < minRaiseTo) amt = minRaiseTo;
      if (amt >= maxRaiseTo * 0.95 && maxRaiseTo <= potLimitTo) {
        return { action: 'all_in', thinkTime: 0 };
      }
      return this.verifyAmount(
        { action: 'raise', amount: toCents(amt), thinkTime: 0 },
        player,
        gs,
        vi,
        fallback()
      );
    }

    return d; // fold / check / all_in are always legal here
  }

  /**
   * AUDIT V2: final verification against the ENGINE'S OWN validateAction().
   * IEEE 754 drift in DB-loaded floats (e.g. currentBet + minRaise summing to
   * 13.040000000000001) can make a boundary-exact amount fail the engine's
   * strict comparison. Verify the exact amount; nudge one cent up (min-raise
   * boundaries) then one cent down (pot-limit caps); otherwise fall back to a
   * guaranteed-legal action. A horse action can therefore NEVER be rejected.
   */
  private static verifyAmount(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    fallback: HorseDecision
  ): HorseDecision {
    const bs = calculateBettingState(
      gs.pot,
      gs.currentBet,
      player.bet,
      gs.bigBlind || 0.02,
      // Exact parity with HandController.performAction: it passes state.lastRaise.
      gs.lastRaise ?? gs.minRaise,
      vi.isPotLimit
    );
    const candidates = [d.amount!, toCents(d.amount! + 0.01), toCents(d.amount! - 0.01)];
    for (const amt of candidates) {
      if (amt <= 0) continue;
      if (validateAction(d.action, amt, player.stack, bs).valid) {
        return { action: d.action, amount: amt, thinkTime: 0 };
      }
    }
    return fallback;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THINK TIME — humanlike pacing, style- and situation-aware
  // ─────────────────────────────────────────────────────────────────────────

  private static computeThinkTime(
    d: HorseDecision,
    gs: HorseGameStateV2,
    params: StyleParams,
    toCall: number
  ): number {
    const [minT, maxT] = params.thinkRange;
    let think = minT + fastRandom() * (maxT - minT);
    const simple = d.action === 'check' || d.action === 'fold';
    if (simple) think *= 0.55;
    if (d.action === 'raise' || d.action === 'all_in') think *= 1.25;
    const headsUp = gs.players.filter((p) => !p.is_folded).length === 2;
    if (headsUp) think *= 0.75;
    if (gs.stage === 'river' && toCall > gs.pot * 0.5) think *= 1.35; // big river decision
    if (gs.stage === 'preflop' && simple) think *= 0.7; // snap-folds preflop
    return Math.round(Math.max(700, Math.min(think, 8000)));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEGACY API — kept for compatibility with existing callers/tests
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Legacy hand-strength score (0..1). Preflop uses the V2 classifiers;
   * postflop uses real Monte Carlo equity vs one opponent.
   */
  static calculateHandStrength(
    holeCards: Card[],
    communityCards: Card[],
    stage: HandStage,
    gameVariant: string = 'nlh'
  ): number {
    if (!holeCards || holeCards.length === 0) return 0;
    const vi = variantInfo(gameVariant);
    if (stage === 'preflop') {
      if (vi.isOmaha && holeCards.length >= 4) return omahaPreflopScore(holeCards, vi.isHiLo);
      if (holeCards.length === 3) return pineapplePreflopScore(holeCards, vi.isShortDeck);
      if (holeCards.length !== 2) return 0.3;
      return holdemPreflopScore(holeCards[0], holeCards[1], vi.isShortDeck);
    }
    return simulateEquity(holeCards, communityCards, 1, vi, vi.iterations);
  }

  /** Exposed for tests ONLY: internal fast evaluators for cross-validation. */
  static readonly __testables = { scoreHoldem, scoreOmahaHi, scoreOmahaLow, straightTop };

  /** Exposed for tests: variant-aware Monte Carlo equity (0..1). */
  static estimateEquity(
    holeCards: Card[],
    communityCards: Card[],
    numOpponents: number,
    gameVariant: string = 'nlh',
    iterations?: number
  ): number {
    const vi = variantInfo(gameVariant);
    if (communityCards.length === 0) {
      return preflopEquity(holeCards, numOpponents, vi, (gameVariant || 'nlh').toLowerCase());
    }
    return simulateEquity(holeCards, communityCards, numOpponents, vi, iterations ?? vi.iterations);
  }
}
