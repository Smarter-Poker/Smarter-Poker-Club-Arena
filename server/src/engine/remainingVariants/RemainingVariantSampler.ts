import type { Card, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { RANK_VALUES, RANKS, SUITS } from '../PokerEngine.js';
import {
  saveFastRandom,
  scoreHoldem,
  scoreOmahaLow,
  type HorseEquityOutcomeSample,
} from '../HorseEval.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import {
  variantEquityFromShowdowns,
  type OmahaVariantEquityEvidence,
} from '../omaha/OmahaVariantEquity.js';
import {
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  remainingVariantHandShape,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';

/**
 * P12.3: the samples one live draw requests at equity-governor scale `scale`.
 * At scale 1 (the governor off, as in the P12.2 matrix) it is the pack's full
 * count, `REMAINING_VARIANT_DOMAIN.defaultSamples`; under load it falls
 * proportionally, never below four. The P12.3 completion record counts a
 * consumed sample that requested fewer than the full count as
 * governor-reduced, never as completed.
 */
export function remainingVariantRequestedSamples(scale: number): number {
  return Math.max(
    4,
    Math.floor(REMAINING_VARIANT_DOMAIN.defaultSamples * Math.min(1, Math.max(0, scale)))
  );
}

/** P12.1: where the opponent holdings behind a live remaining-variant sample
 * came from. Each dealt opponent is drawn from one physical deck (36 cards for
 * Short Deck) under a sequential prior conditioned only on that opponent's
 * public raise and call counts, with a declared uniform escape on the third
 * attempt. For Crazy Pineapple every opponent's retained pair is chosen by the
 * declared flop-only structural prior (`choosePineappleFlopPair`), never by an
 * actual discard, and the hero's own accepted discard is excluded from the
 * deck: only its count is recorded here, never a card value. Nothing here is
 * calibrated or solver input. */
export interface RemainingVariantRangeProvenance {
  readonly version: 'remaining-variant-range-provenance-v1';
  readonly source: 'variant_public_line_sequential_prior';
  readonly calibration: 'uncalibrated';
  readonly solverInput: false;
  readonly reads: 'public_action_line_only';
  readonly prior: Readonly<{
    attemptsPerSeat: 3;
    finalAttempt: 'uniform_escape';
    /** Dealt-opponent draws inside completed samples. */
    seatDraws: number;
    /** Of those, draws accepted by the uniform escape (third attempt). */
    uniformEscapes: number;
  }>;
  readonly deck: Readonly<{
    physical: 'single_deck_excluding_hero_known_and_board';
    size: 36 | 52;
    /** Every dealt opponent consumes unknown cards, folded seats included. */
    dealtOpponents: number;
    /** The hero's private accepted discard excluded from the deck (Pineapple
     * after the discard: 1; otherwise 0). A count, never the card. */
    heroKnownDeadCards: 0 | 1;
  }>;
  /** Crazy Pineapple only; null for the other three packs. */
  readonly discard: Readonly<{
    opponents: 'declared_flop_only_structural_prior';
    /** The hero's pair: the accepted private discard after the flop, or the
     * same declared prior when sampled before it. */
    hero: 'accepted_private_discard' | 'declared_flop_only_structural_prior';
    actualOpponentDiscardsRead: false;
  }> | null;
  readonly work: Readonly<{
    requestedSamples: number;
    completedSamples: number;
    budgetExhausted: boolean;
  }>;
  /** The contesting opponents scored at showdown, with the public counts read. */
  readonly opponents: ReadonlyArray<
    Readonly<{ userId: string; seat: number; raises: number; calls: number }>
  >;
}

/** The shared pot-share evidence with the Phase 12 sampler's own provenance. */
export type RemainingVariantEquityEvidence = Omit<OmahaVariantEquityEvidence, 'range'> & {
  /** P12.1: the live sampler's range provenance; absent on external evidence. */
  range?: RemainingVariantRangeProvenance;
};

/** A bounded flop-only public prior for the opponent's Crazy Pineapple
 * discard. The final board is deliberately not an input. All three original
 * cards consume the deck, including the card this heuristic throws away.
 * This is a declared structural heuristic, not optimal discard equity. */
export function choosePineappleFlopPair(cards: Card[], flop: Card[]): Card[] {
  remainingVariantHandShape('pineapple', cards);
  if (
    flop.length !== 3 ||
    new Set([...cards, ...flop].map((c) => c.rank + ':' + c.suit)).size !== 6
  )
    throw new Error('Pineapple prior requires one physical three-card flop');
  let best = -Infinity,
    retained: Card[] = [];
  for (let discard = 0; discard < 3; discard++) {
    const pair = cards.filter((_, i) => i !== discard);
    const all = [...pair, ...flop];
    const score = scoreHoldem(all, 5, false),
      category = Math.floor(score / 0x100000);
    const flushDraw = SUITS.some(
      (s) => all.filter((c) => c.suit === s).length === 4 && pair.some((c) => c.suit === s)
    );
    const values = new Set(
      all.flatMap((c) => (c.rank === 'A' ? [1, 14] : [RANKS.indexOf(c.rank) + 2]))
    );
    let straightDraw = false;
    for (let top = 5; top <= 14; top++)
      if (Array.from({ length: 5 }, (_, i) => top - i).filter((r) => values.has(r)).length === 4)
        straightDraw = true;
    const value =
      category * 0.3 +
      ((score % 0x100000) / 0x100000) * 0.1 +
      Number(flushDraw) * 0.32 +
      Number(straightDraw) * 0.16 +
      remainingVariantHandShape('pineapple', pair, true).quality * 0.12;
    if (value > best) {
      best = value;
      retained = pair;
    }
  }
  return retained.map((c) => ({ ...c }));
}

// ---------------------------------------------------------------------------
// Exact, allocation-free kernels for the live sampler's inner loop (2026-10-11)
// ---------------------------------------------------------------------------
//
// Measured on engine release f47ad93c (2026-10-11 19:05 to 19:45Z, closed
// journal segments): the Crazy Pineapple sampler's own analysis time grew with
// every DEALT opponent, folded or not (median 1.34 ms with one dealt opponent,
// 1.95 ms with two, 2.28 ms with three), so on a table with four or five dealt
// opponents every postflop sample stopped at `samplingDeadlineMs` (2.5 ms)
// with 14 to 19 of its 32 samples: 450 of 1,111 postflop decisions. A CPU
// profile of those journaled states put about 70% of the time in
// `choosePineappleFlopPair` and `remainingVariantHandShape`: every iteration
// chose a retained pair for every dealt opponent, although only the contesting
// opponents' pairs are ever scored, and every prior attempt rebuilt a full
// hand shape (validation, sets, sorts) to read one number. FLO8 spent the same
// share in its four-card shape and the hero's unchanged river scores, and its
// samples ran out at the deadline whenever host jitter met that work.
//
// The kernels below return exactly what the code they replace returned (the
// same operands, the same operation order, so the same IEEE doubles), pinned
// by exhaustive equivalence tests, and the sampler consumes the same random
// draws in the same order: every sample, every receipt and every decision is
// bit-identical. Only the time per sample changes.

const SHAPE_RANK_VALUE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(RANKS.map((rank, i) => [rank, i + 2]))
);
const shapeClamp = (x: number) => Math.max(0, Math.min(1, x));

/** `remainingVariantHandShape(v, [a, b], ...).pairQualities[0]` for a hold'em
 * style pack (Short Deck, Crazy Pineapple, FLH): one pair's clamped quality. */
function pairShapeQuality(shortDeck: boolean, a: Card, b: Card): number {
  const va = SHAPE_RANK_VALUE[a.rank],
    vb = SHAPE_RANK_VALUE[b.rank];
  const hi = Math.max(va, vb),
    lo = Math.min(va, vb);
  const pair = hi === lo,
    suited = a.suit === b.suit;
  const gap = hi === 14 ? Math.min(hi - lo, Math.abs(lo - (shortDeck ? 5 : 1))) : hi - lo;
  const connection = pair ? 0 : Math.max(0, 1 - (gap - 1) / 4);
  const high = (hi + lo * 0.65) / (14 * 1.65);
  const q = shortDeck
    ? 0.04 +
      high * 0.36 +
      Number(pair) * (0.2 + ((hi - 6) / 8) * 0.2) +
      Number(suited) * 0.15 +
      connection * 0.19
    : 0.025 +
      high * 0.39 +
      Number(pair) * (0.22 + (hi / 14) * 0.2) +
      Number(suited) * 0.1 +
      connection * 0.11;
  return shapeClamp(q);
}

/** `remainingVariantHandShape('flo8', cards).quality` for four physical cards. */
const flo8RankCounts = new Uint8Array(15);
function flo8ShapeQuality(cards: Card[]): number {
  flo8RankCounts.fill(0);
  let lowMask = 0,
    distinct = 0,
    pairs = 0,
    acePair = false,
    highPair = false,
    broadway = 0;
  for (let i = 0; i < cards.length; i++) {
    const value = SHAPE_RANK_VALUE[cards[i].rank];
    flo8RankCounts[value]++;
    const low = value === 14 ? 1 : value;
    if (low <= 8) lowMask |= 1 << low;
    if (value >= 10) broadway++;
  }
  for (let value = 2; value <= 14; value++) {
    const count = flo8RankCounts[value];
    if (count > 0) distinct++;
    if (count === 2) {
      pairs++;
      if (value === 14) acePair = true;
      if (value >= 12) highPair = true;
    }
  }
  let nutSuits = 0,
    suitPairs = 0;
  for (const suit of SUITS) {
    let count = 0,
      ace = false;
    for (let i = 0; i < cards.length; i++)
      if (cards[i].suit === suit) {
        count++;
        if (cards[i].rank === 'A') ace = true;
      }
    if (ace && count >= 2) nutSuits++;
    if (count >= 2) suitPairs++;
  }
  let lowCount = 0;
  for (let low = 1; low <= 8; low++) if (lowMask & (1 << low)) lowCount++;
  const has = (low: number) => (lowMask & (1 << low)) !== 0;
  const backupLow = lowCount >= 3,
    aceDeuce = has(1) && has(2),
    aceTrey = has(1) && has(3);
  const duplicateWaste = cards.length - distinct - pairs;
  return shapeClamp(
    (aceDeuce ? 0.48 : aceTrey ? 0.29 : has(2) && has(3) ? 0.18 : 0.02) +
      Number(backupLow) * 0.14 +
      nutSuits * 0.11 +
      Number(acePair) * 0.21 +
      Number(highPair) * 0.08 +
      suitPairs * 0.045 +
      broadway * 0.025 -
      duplicateWaste * 0.15
  );
}

/**
 * Exactly `remainingVariantHandShape(variant, cards, postDiscard).quality` for
 * physical cards the sampler dealt itself (distinct, in the pack's deck, the
 * pack's hole count), without the validation and the fields only the policy
 * reads. Exported for its exhaustive equivalence test.
 */
export function remainingVariantSampledShapeQuality(
  variant: RemainingPolicyVariant,
  cards: Card[],
  postDiscard = false
): number {
  if (variant === 'flo8') return flo8ShapeQuality(cards);
  const shortDeck = variant === 'short_deck';
  if (cards.length === 2) return shapeClamp(pairShapeQuality(shortDeck, cards[0], cards[1]) + 0);
  // Crazy Pineapple before its discard: the best of three pairs plus the
  // declared second-pair bonus, as `remainingVariantHandShape` sums it.
  const q01 = pairShapeQuality(shortDeck, cards[0], cards[1]),
    q02 = pairShapeQuality(shortDeck, cards[0], cards[2]),
    q12 = pairShapeQuality(shortDeck, cards[1], cards[2]);
  // The largest and the second largest, as the descending sort reads them.
  const first = Math.max(q01, q02, q12);
  const middle =
    first === q01 ? Math.max(q02, q12) : first === q02 ? Math.max(q01, q12) : Math.max(q01, q02);
  return shapeClamp(
    first + (variant === 'pineapple' && !postDiscard ? 0.04 + Math.min(0.08, middle * 0.09) : 0)
  );
}

const pineappleScratch: Card[] = new Array(5);

/**
 * Exactly `choosePineappleFlopPair(cards, flop)` for three physical cards the
 * sampler dealt itself and a physical flop: the same three candidate pairs in
 * the same order, the same value arithmetic and the same first-maximum rule.
 * Returns the retained pair as the original cards (the sampler only scores
 * them). Exported for its exhaustive equivalence test.
 */
export function pineappleSampledFlopPair(cards: Card[], flop: Card[]): Card[] {
  let best = -Infinity,
    keepA = 0,
    keepB = 1;
  for (let discard = 0; discard < 3; discard++) {
    const a = discard === 0 ? 1 : 0,
      b = discard === 2 ? 1 : 2;
    pineappleScratch[0] = cards[a];
    pineappleScratch[1] = cards[b];
    pineappleScratch[2] = flop[0];
    pineappleScratch[3] = flop[1];
    pineappleScratch[4] = flop[2];
    const score = scoreHoldem(pineappleScratch, 5, false),
      category = Math.floor(score / 0x100000);
    let flushDraw = false;
    for (const suit of SUITS) {
      let count = 0;
      for (let i = 0; i < 5; i++) if (pineappleScratch[i].suit === suit) count++;
      if (count === 4 && (cards[a].suit === suit || cards[b].suit === suit)) flushDraw = true;
    }
    let values = 0;
    for (let i = 0; i < 5; i++) {
      const rank = pineappleScratch[i].rank;
      if (rank === 'A') values |= (1 << 1) | (1 << 14);
      else values |= 1 << (RANKS.indexOf(rank) + 2);
    }
    let straightDraw = false;
    for (let top = 5; top <= 14; top++) {
      let present = 0;
      for (let r = top - 4; r <= top; r++) if (values & (1 << r)) present++;
      if (present === 4) straightDraw = true;
    }
    const value =
      category * 0.3 +
      ((score % 0x100000) / 0x100000) * 0.1 +
      Number(flushDraw) * 0.32 +
      Number(straightDraw) * 0.16 +
      remainingVariantSampledShapeQuality('pineapple', [cards[a], cards[b]], true) * 0.12;
    if (value > best) {
      best = value;
      keepA = a;
      keepB = b;
    }
  }
  return [cards[keepA], cards[keepB]];
}

/**
 * Exactly the cards `holes` successive `trial.splice(floor(random() *
 * trial.length), 1)[0]` calls take from `trial = deck.slice()`: the same
 * random draws in the same order, each index read against the deck with the
 * earlier picks removed. `picked` receives the picked positions in `deck`,
 * ascending, for `removePicked`. Exported for its equivalence test.
 */
export function drawInPlace(
  deck: Card[],
  holes: number,
  random: () => number,
  picked: number[]
): Card[] {
  const cards = new Array<Card>(holes);
  for (let k = 0; k < holes; k++) {
    let position = Math.floor(random() * (deck.length - k));
    // Step over every earlier pick at or below it, lowest first.
    for (let j = 0; j < k; j++) if (picked[j] <= position) position++;
    let j = k;
    for (; j > 0 && picked[j - 1] > position; j--) picked[j] = picked[j - 1];
    picked[j] = position;
    cards[k] = deck[position];
  }
  return cards;
}

/** Removes the `holes` positions `drawInPlace` picked, leaving `deck` exactly
 * the copy those splices would have left. */
export function removePicked(deck: Card[], picked: number[], holes: number): void {
  for (let j = holes - 1; j >= 0; j--) deck.splice(picked[j], 1);
}

// FLO8 high: `scoreOmahaHi` (exactly two hole cards and three board cards,
// best of the 60 five-card scores `scoreFiveCards` gives) with each board
// triple's rank counters built once per sample and shared by the hero and
// every contesting opponent. Rank counts are order-free, so adding the two
// hole cards to a triple's counters gives the five-card counters
// `scoreFiveCards` builds, and the score below is its own arithmetic on them.
const FLO8_TRIPLE_STRIDE = 5;
const FLO8_BOARD_TRIPLES: ReadonlyArray<readonly [number, number, number]> = (() => {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) out.push([i, j, k]);
  return out;
})();
const FLO8_HOLE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];
const topRank = (mask: number): number => 31 - Math.clz32(mask);
function topKickers(mask: number, count: number): number {
  let value = 0;
  while (count-- > 0) {
    const rank = topRank(mask);
    value = value * 16 + rank;
    mask ^= 1 << rank;
  }
  return value;
}

/** `scoreFiveCards` from its rank counters (ranks seen at least once, twice,
 * three and four times) and its flush flag. Exported for its exhaustive
 * equivalence test over every five-card hand. */
export function fiveCardScoreFromCounters(
  once: number,
  twice: number,
  thrice: number,
  four: number,
  flush: boolean
): number {
  const runs = once & (once >> 1) & (once >> 2) & (once >> 3) & (once >> 4);
  const straight = runs ? topRank(runs) + 4 : (once & 0x403c) === 0x403c ? 5 : 0;
  if (flush && straight) return (straight === 14 ? 10 : 9) * 0x100000 + straight;
  if (four) return 8 * 0x100000 + topRank(four) * 16 + topRank(once ^ four);
  if (thrice && twice !== thrice) {
    return 7 * 0x100000 + topRank(thrice) * 16 + topRank(twice ^ thrice);
  }
  if (flush) return 6 * 0x100000 + topKickers(once, 5);
  if (straight) return 5 * 0x100000 + straight;
  if (thrice) return 4 * 0x100000 + topRank(thrice) * 256 + topKickers(once ^ thrice, 2);
  if (twice) {
    const highPair = topRank(twice);
    const otherPair = twice ^ (1 << highPair);
    if (otherPair) {
      return 3 * 0x100000 + highPair * 256 + topRank(otherPair) * 16 + topRank(once ^ twice);
    }
    return 2 * 0x100000 + highPair * 4096 + topKickers(once ^ twice, 3);
  }
  return 0x100000 + topKickers(once, 5);
}

/** The ten triples of a complete five-card board, as counters and a flush
 * suit (its index in SUITS, or -1 when the triple is not one suit). */
function flo8BoardTriples(board: Card[], out: Int32Array): void {
  for (let t = 0; t < 10; t++) {
    const [x, y, z] = FLO8_BOARD_TRIPLES[t];
    let once = 0,
      twice = 0,
      thrice = 0,
      four = 0;
    for (const card of [board[x], board[y], board[z]]) {
      const bit = 1 << RANK_VALUES[card.rank];
      four |= thrice & bit;
      thrice |= twice & bit;
      twice |= once & bit;
      once |= bit;
    }
    const at = t * FLO8_TRIPLE_STRIDE;
    out[at] = once;
    out[at + 1] = twice;
    out[at + 2] = thrice;
    out[at + 3] = four;
    out[at + 4] =
      board[x].suit === board[y].suit && board[x].suit === board[z].suit
        ? SUITS.indexOf(board[x].suit)
        : -1;
  }
}

/** Exactly `scoreOmahaHi(hole, board)` for four hole cards, given
 * `flo8BoardTriples(board)`. */
function flo8OmahaHigh(hole: Card[], triples: Int32Array): number {
  let best = 0;
  for (const [a, b] of FLO8_HOLE_PAIRS) {
    const bitA = 1 << RANK_VALUES[hole[a].rank],
      bitB = 1 << RANK_VALUES[hole[b].rank];
    const pairSuit = hole[a].suit === hole[b].suit ? SUITS.indexOf(hole[a].suit) : -2;
    for (let at = 0; at < 10 * FLO8_TRIPLE_STRIDE; at += FLO8_TRIPLE_STRIDE) {
      let once = triples[at],
        twice = triples[at + 1],
        thrice = triples[at + 2],
        four = triples[at + 3];
      four |= thrice & bitA;
      thrice |= twice & bitA;
      twice |= once & bitA;
      once |= bitA;
      four |= thrice & bitB;
      thrice |= twice & bitB;
      twice |= once & bitB;
      once |= bitB;
      const score = fiveCardScoreFromCounters(
        once,
        twice,
        thrice,
        four,
        triples[at + 4] === pairSuit
      );
      if (score > best) best = score;
    }
  }
  return best;
}

/** Exactly `scoreOmahaHi(hole, board)` for four hole cards and a complete
 * board. Exported for its equivalence test. */
export function flo8SampledOmahaHigh(hole: Card[], board: Card[]): number {
  const triples = new Int32Array(FLO8_TRIPLE_STRIDE * 10);
  flo8BoardTriples(board, triples);
  return flo8OmahaHigh(hole, triples);
}

/** P12.1: the terminal showdowns this sampler scored, offered to a caller
 * that needs the individual runouts rather than their aggregate share. The
 * roster is the contesting order the opponent arrays are indexed by, which is
 * the only order those arrays can legally be read in. Retention is additive:
 * the returned aggregate evidence is unchanged whether or not it is asked for,
 * and no extra sample, card or iteration is drawn to supply it. */
export interface RemainingVariantTerminalShowdowns {
  samples: HorseEquityOutcomeSample[];
  opponentIds: string[];
}

/** One physical deck, local RNG, bounded sequential public-line prior with a
 * declared uniform escape. Folded dealt seats still consume their full deal.
 * Hero's private known discard is excluded; opponents' private cards and
 * discards are never read. The consumer owns domain and legal validation. */
export function sampleRemainingVariantEquity(
  variant: RemainingPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  withinBudget: () => boolean,
  retain?: (showdowns: RemainingVariantTerminalShowdowns) => void
): RemainingVariantEquityEvidence | null {
  const started = performance.now(),
    pack = REMAINING_VARIANT_PACKS[variant];
  const postDiscard = variant === 'pineapple' && state.communityCards.length >= 3;
  try {
    remainingVariantHandShape(variant, hero.cards, postDiscard);
  } catch {
    return null;
  }
  const dead = hero.knownDeadCards ?? [];
  if (
    !Array.isArray(dead) ||
    dead.length !== (postDiscard ? 1 : 0) ||
    ![0, 3, 4, 5].includes(state.communityCards.length)
  )
    return null;
  const knownCards = [...hero.cards, ...dead, ...state.communityCards];
  const known = new Set(knownCards.map((c) => c.rank + ':' + c.suit));
  if (
    known.size !== knownCards.length ||
    knownCards.some(
      (c) =>
        !c ||
        !RANKS.includes(c.rank) ||
        !SUITS.includes(c.suit) ||
        (variant === 'short_deck' && RANKS.indexOf(c.rank) < 4)
    )
  )
    return null;
  let players: SeatPlayer[];
  try {
    players = horsePolicyDealtPlayers(state.players, hero.seat, state.dealtSeatIds);
  } catch {
    return null;
  }
  const dealt = players
    .filter((p) => p.user_id !== hero.user_id)
    .slice()
    .sort((a, b) => a.seat - b.seat);
  const active = dealt.filter((p) => !p.is_folded && (!p.is_sitting_out || p.is_all_in));
  const deck: Card[] = SUITS.flatMap((suit) =>
    RANKS.filter((rank) => variant !== 'short_deck' || RANKS.indexOf(rank) >= 4).map((rank) => ({
      rank,
      suit,
    }))
  ).filter((c) => !known.has(c.rank + ':' + c.suit));
  if (!active.length || dealt.length * pack.holes + 5 - state.communityCards.length > deck.length)
    return null;
  let stream = saveFastRandom() ^ 0x51a7e12;
  for (const card of knownCards)
    for (const char of card.rank + ':' + card.suit)
      stream = Math.imul(stream ^ char.charCodeAt(0), 16777619);
  stream = stream >>> 0 || 1;
  const random = () => {
    stream ^= stream << 13;
    stream ^= stream >>> 17;
    stream ^= stream << 5;
    return (stream >>> 0) / 0x100000000;
  };
  const reads = new Map(
    dealt.map((p) => {
      const line = (state.actionHistory ?? []).filter((a) => a.userId === p.user_id);
      return [
        p.user_id,
        {
          raises: line.filter(
            (a) =>
              ['bet', 'raise'].includes(a.action) ||
              (a.action === 'all_in' && a.isFullRaise !== undefined)
          ).length,
          calls: line.filter(
            (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
          ).length,
        },
      ];
    })
  );
  // The measured policy's sample, always (2026-10-09): the P12.2 matrix priced
  // every proposal at scale 1, and the P12.3 completion floor admits a pack
  // only when its live decisions price that same sample. Governor scaling made
  // about 4% of natural postflop decisions governor-reduced on release
  // c1deef24. Since 2026-10-16 the live policy passes no deadline either: the
  // work is the declared full request with at most three prior draws per dealt
  // opponent each, never cut by a clock. `withinBudget` remains for offline
  // callers that stop a sample early (counted as budget exhausted).
  const requested = remainingVariantRequestedSamples(1);
  const samples: HorseEquityOutcomeSample[] = [];
  // P12.1: what the prior actually did, recorded with the sample it produced.
  let seatDraws = 0;
  let uniformEscapes = 0;
  const picked = new Array<number>(4);
  const riverKnown = state.communityCards.length === 5;
  let heroRiver: { high: number; low: number | null } | false | null = null;
  const flo8Triples = new Int32Array(variant === 'flo8' ? FLO8_TRIPLE_STRIDE * 10 : 0);
  sampleLoop: for (let iteration = 0; iteration < requested; iteration++) {
    if (!withinBudget()) break;
    const remaining = deck.slice();
    const hands = new Map<string, Card[]>();
    let iterationEscapes = 0;
    for (const p of dealt) {
      if (!withinBudget()) break sampleLoop;
      const read = reads.get(p.user_id)!;
      for (let attempt = 0; attempt < 3; attempt++) {
        // The cards a copy of the deck would give up to `holes` successive
        // splices at the same random indices, read in place: an attempt the
        // prior rejects leaves the deck untouched, so nothing is copied for it.
        const cards = drawInPlace(remaining, pack.holes, random, picked);
        const weight = Math.pow(
          0.3 + remainingVariantSampledShapeQuality(variant, cards) * 0.7,
          Math.min(4, 1 + read.raises * 0.6 + read.calls * 0.1)
        );
        if (attempt === 2 || random() <= weight) {
          if (attempt === 2) iterationEscapes++;
          removePicked(remaining, picked, pack.holes);
          hands.set(p.user_id, cards);
          break;
        }
      }
    }
    // Deal the flop before making discard choices; the future turn and river
    // cannot influence which two cards survive, even in a preflop sample.
    const board = state.communityCards.slice();
    while (board.length < 3)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    const heroHand =
      variant === 'pineapple' && hero.cards.length === 3
        ? pineappleSampledFlopPair(hero.cards, board)
        : hero.cards;
    // Only a contesting opponent's retained pair is ever scored. A folded
    // dealt seat's three cards already left the deck above; choosing its pair
    // draws no random number and changes nothing (2026-10-11: it was most of
    // the Pineapple sampler's time on tables with four or five dealt seats).
    if (variant === 'pineapple')
      for (const p of active)
        hands.set(p.user_id, pineappleSampledFlopPair(hands.get(p.user_id)!, board));
    while (board.length < 5)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    if (variant === 'flo8') flo8BoardTriples(board, flo8Triples);
    const high = (cards: Card[]) =>
      variant === 'flo8'
        ? flo8OmahaHigh(cards, flo8Triples)
        : scoreHoldem([...cards, ...board], cards.length + board.length, variant === 'short_deck');
    const low = (cards: Card[]) => {
      const v = pack.splitLow ? scoreOmahaLow(cards, board) : Infinity;
      return Number.isFinite(v) ? v : null;
    };
    // On the river the board and the hero's hand are the same in every
    // sample, so the hero's scores are computed once, from the first.
    if (heroRiver === null)
      heroRiver = riverKnown ? { high: high(heroHand), low: low(heroHand) } : false;
    // Counted only for a completed sample: an iteration cut by the budget
    // contributes no showdown and no draw.
    seatDraws += dealt.length;
    uniformEscapes += iterationEscapes;
    samples.push({
      heroHigh: heroRiver ? heroRiver.high : high(heroHand),
      heroLow: heroRiver ? heroRiver.low : low(heroHand),
      opponentHigh: active.map((p) => high(hands.get(p.user_id)!)),
      opponentLow: active.map((p) => low(hands.get(p.user_id)!)),
      opponentDecisionStrength: active.map((p) =>
        remainingVariantSampledShapeQuality(variant, hands.get(p.user_id)!, variant === 'pineapple')
      ),
    });
  }
  retain?.({ samples, opponentIds: active.map((p) => p.user_id) });
  const evidence = variantEquityFromShowdowns({
    variant,
    players: state.players,
    heroId: hero.user_id,
    callCost: Math.min(hero.stack, Math.max(0, state.currentBet - hero.bet)),
    opponentIds: active.map((p) => p.user_id),
    samples,
  }) as RemainingVariantEquityEvidence | null;
  if (evidence) {
    evidence.analysisMs = performance.now() - started;
    evidence.provenance = 'variant_public_line_joint_deck';
    evidence.requestedSamples = requested;
    evidence.sampleBudgetExhausted = samples.length < requested;
    evidence.range = Object.freeze({
      version: 'remaining-variant-range-provenance-v1',
      source: 'variant_public_line_sequential_prior',
      calibration: 'uncalibrated',
      solverInput: false,
      reads: 'public_action_line_only',
      prior: Object.freeze({
        attemptsPerSeat: 3,
        finalAttempt: 'uniform_escape',
        seatDraws,
        uniformEscapes,
      }),
      deck: Object.freeze({
        physical: 'single_deck_excluding_hero_known_and_board',
        size: pack.deck as 36 | 52,
        dealtOpponents: dealt.length,
        heroKnownDeadCards: dead.length as 0 | 1,
      }),
      discard:
        variant === 'pineapple'
          ? Object.freeze({
              opponents: 'declared_flop_only_structural_prior',
              hero:
                hero.cards.length === 3
                  ? 'declared_flop_only_structural_prior'
                  : 'accepted_private_discard',
              actualOpponentDiscardsRead: false,
            })
          : null,
      work: Object.freeze({
        requestedSamples: requested,
        completedSamples: samples.length,
        budgetExhausted: samples.length < requested,
      }),
      opponents: Object.freeze(
        active.map((p) => {
          const read = reads.get(p.user_id)!;
          return Object.freeze({
            userId: p.user_id,
            seat: p.seat,
            raises: read.raises,
            calls: read.calls,
          });
        })
      ),
    } satisfies RemainingVariantRangeProvenance);
  }
  return evidence;
}
