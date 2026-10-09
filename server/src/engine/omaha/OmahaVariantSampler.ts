import type { Card, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { RANKS, RANK_VALUES, SUITS } from '../PokerEngine.js';
import { saveFastRandom, type HorseEquityOutcomeSample } from '../HorseEval.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import {
  omahaVariantEquityFromShowdowns,
  type OmahaVariantRangeProvenance,
} from './OmahaVariantEquity.js';
import {
  OMAHA_VARIANT_PACKS,
  omahaVariantHandQuality,
  type OmahaPolicyVariant,
} from './OmahaVariantPolicyPack.js';

// ── Integer Omaha scoring for the sampler ───────────────────────────────────
// Bit-identical to HorseEval's scoreOmahaHi / scoreOmahaHiPartial /
// scoreOmahaLow (pinned over randomized deals in OmahaVariantSamplerSpeed.test),
// which evaluate every 2-hole x 3-board combination and keep the best. A best
// is order-free, so here each board's triples are reduced to rank masks and a
// suit once, and every hole pair is added to them as two rank bits: no card
// objects, string keys or scratch arrays inside the 100-150 combination loop.

const SUIT_CODE: Record<string, number> = Object.freeze({
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3,
});
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
/** HorseFiveCardScore.scoreFiveCards from its rank masks and flush flag. */
function scoreFromMasks(once: number, twice: number, thrice: number, four: number, flush: boolean) {
  if (!twice) return (flush ? FLUSH_DISTINCT : PLAIN_DISTINCT)[once];
  return scoreMasksSlow(once, twice, thrice, four, flush);
}
function scoreMasksSlow(once: number, twice: number, thrice: number, four: number, flush: boolean) {
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
/** Five distinct ranks (the case without a pair): the score of every 5-bit
 * rank mask, plain and flush, from the same arithmetic. */
const PLAIN_DISTINCT = new Int32Array(1 << 15);
const FLUSH_DISTINCT = new Int32Array(1 << 15);
for (let mask = 0; mask < 1 << 15; mask++) {
  let bits = 0;
  for (let m = mask; m; m &= m - 1) bits++;
  if (bits !== 5 || mask & 3) continue;
  PLAIN_DISTINCT[mask] = scoreMasksSlow(mask, 0, 0, 0, false);
  FLUSH_DISTINCT[mask] = scoreMasksSlow(mask, 0, 0, 0, true);
}
/** scoreOmahaLow's encoding of a five-distinct-rank low mask (bits 1..8). */
const LOW_VALUE = new Int32Array(512);
for (let mask = 0; mask < 512; mask++) {
  let v = 0;
  for (let r = 8; r >= 1; r--) if (mask & (1 << r)) v = v * 16 + r;
  LOW_VALUE[mask] = v;
}
/** Card code: rank value (2..14) | suit << 4. */
const codeOf = (card: Card) => RANK_VALUES[card.rank] | (SUIT_CODE[card.suit] << 4);

/** A board reduced to its 3-card triples: per triple the rank masks, the
 * shared suit (-1 when mixed) and the 8-or-better low mask (0 when the triple
 * cannot make a low). */
interface OmahaBoardTriples {
  count: number;
  once: Int32Array;
  twice: Int32Array;
  thrice: Int32Array;
  suit: Int32Array;
  low: Int32Array;
}
const newTriples = (): OmahaBoardTriples => ({
  count: 0,
  once: new Int32Array(10),
  twice: new Int32Array(10),
  thrice: new Int32Array(10),
  suit: new Int32Array(10),
  low: new Int32Array(10),
});
/** Loads the triples of board[0..length) whose last card is at or after
 * `from`: every triple when `from` is 0, only those holding a drawn card when
 * `from` is the public board's length. */
function loadTriples(into: OmahaBoardTriples, board: readonly number[], length: number, from = 0) {
  let t = 0;
  for (let i = 0; i < length; i++)
    for (let j = i + 1; j < length; j++)
      for (let k = Math.max(j + 1, from); k < length; k++) {
        const a = board[i];
        const b = board[j];
        const c = board[k];
        let once = 0;
        let twice = 0;
        let thrice = 0;
        for (const code of [a, b, c]) {
          const bit = 1 << (code & 15);
          thrice |= twice & bit;
          twice |= once & bit;
          once |= bit;
        }
        into.once[t] = once;
        into.twice[t] = twice;
        into.thrice[t] = thrice;
        into.suit[t] = a >> 4 === b >> 4 && a >> 4 === c >> 4 ? a >> 4 : -1;
        const la = (a & 15) === 14 ? 1 : a & 15;
        const lb = (b & 15) === 14 ? 1 : b & 15;
        const lc = (c & 15) === 14 ? 1 : c & 15;
        const low = (1 << la) | (1 << lb) | (1 << lc);
        into.low[t] =
          la <= 8 && lb <= 8 && lc <= 8 && la !== lb && la !== lc && lb !== lc ? low : 0;
        t++;
      }
  into.count = t;
}
/** The non-flush score of every hole rank pair against every triple, indexed
 * (low * 15 + high) * count + triple. Filled once for the public board, which
 * every prior draw of the decision is scored against. */
function rankPairTable(tri: OmahaBoardTriples): Int32Array {
  const table = new Int32Array(15 * 15 * tri.count);
  for (let low = 2; low <= 14; low++)
    for (let high = low; high <= 14; high++) {
      const bitA = 1 << low;
      const bitB = 1 << high;
      for (let t = 0; t < tri.count; t++) {
        let once = tri.once[t];
        let twice = tri.twice[t];
        let thrice = tri.thrice[t];
        let four = thrice & bitA;
        thrice |= twice & bitA;
        twice |= once & bitA;
        once |= bitA;
        four |= thrice & bitB;
        thrice |= twice & bitB;
        twice |= once & bitB;
        once |= bitB;
        table[(low * 15 + high) * tri.count + t] = scoreFromMasks(once, twice, thrice, four, false);
      }
    }
  return table;
}
/** omahaHiFast through a rankPairTable: one read per combination, the flush
 * computed only where the triple and the pair share one suit. */
function omahaHiTable(hole: readonly number[], tri: OmahaBoardTriples, table: Int32Array) {
  let best = 0;
  const count = tri.count;
  for (let i = 0; i < hole.length; i++) {
    const a = hole[i];
    for (let j = i + 1; j < hole.length; j++) {
      const b = hole[j];
      const ra = a & 15;
      const rb = b & 15;
      const row = (ra < rb ? ra * 15 + rb : rb * 15 + ra) * count;
      const pairSuit = a >> 4 === b >> 4 ? a >> 4 : -2;
      for (let t = 0; t < count; t++) {
        let s = table[row + t];
        if (tri.suit[t] === pairSuit) {
          const bitA = 1 << ra;
          const bitB = 1 << rb;
          // A flush has five distinct ranks: the triple's three plus the pair's.
          s = scoreFromMasks(tri.once[t] | bitA | bitB, 0, 0, 0, true);
        }
        if (s > best) best = s;
      }
    }
  }
  return best;
}
function omahaHiFast(hole: readonly number[], tri: OmahaBoardTriples): number {
  let best = 0;
  for (let i = 0; i < hole.length; i++) {
    const a = hole[i];
    const bitA = 1 << (a & 15);
    for (let j = i + 1; j < hole.length; j++) {
      const b = hole[j];
      const bitB = 1 << (b & 15);
      const pairSuit = a >> 4 === b >> 4 ? a >> 4 : -2;
      for (let t = 0; t < tri.count; t++) {
        let once = tri.once[t];
        let twice = tri.twice[t];
        let thrice = tri.thrice[t];
        let four = thrice & bitA;
        thrice |= twice & bitA;
        twice |= once & bitA;
        once |= bitA;
        four |= thrice & bitB;
        thrice |= twice & bitB;
        twice |= once & bitB;
        once |= bitB;
        const s = scoreFromMasks(once, twice, thrice, four, tri.suit[t] === pairSuit);
        if (s > best) best = s;
      }
    }
  }
  return best;
}
function omahaLowFast(hole: readonly number[], tri: OmahaBoardTriples): number {
  let best = Infinity;
  for (let i = 0; i < hole.length; i++) {
    const h1 = (hole[i] & 15) === 14 ? 1 : hole[i] & 15;
    if (h1 > 8) continue;
    for (let j = i + 1; j < hole.length; j++) {
      const h2 = (hole[j] & 15) === 14 ? 1 : hole[j] & 15;
      if (h2 > 8 || h1 === h2) continue;
      const pair = (1 << h1) | (1 << h2);
      for (let t = 0; t < tri.count; t++) {
        const low = tri.low[t];
        if (!low || low & pair) continue;
        const v = LOW_VALUE[low | pair];
        if (v < best) best = v;
      }
    }
  }
  return best;
}
/** Exported for the identity tests only. */
export const omahaSamplerScoring = Object.freeze({
  codeOf,
  newTriples,
  loadTriples,
  omahaHiFast,
  omahaHiTable,
  omahaLowFast,
  rankPairTable,
});

/** A separate bounded shadow read. Its local stream never advances the
 * baseline strategy stream. Public-line conditioning is an explicitly
 * heuristic sequential prior, not an independent solver-range posterior.
 * Folded dealt seats still consume unknown cards from the one physical deck.
 */
/** The terminal showdowns a sample consisted of, handed to an optional
 * retention callback (P11-A, audit 2026-10-07) so the river net-action pass
 * can settle the same showdowns the policy priced. No extra sample, card,
 * deck draw or iteration is taken to supply it, and the evidence returned is
 * identical whether or not retention is asked for. */
export interface OmahaVariantTerminalShowdowns {
  samples: HorseEquityOutcomeSample[];
  /** The contesting roster, in the samples' opponent index order. */
  opponentIds: string[];
}

export function sampleOmahaVariantEquity(
  variant: OmahaPolicyVariant,
  hero: SeatPlayer,
  state: HorseGameStateV2,
  withinBudget: () => boolean,
  retain?: (showdowns: OmahaVariantTerminalShowdowns) => void
) {
  const started = performance.now();
  const pack = OMAHA_VARIANT_PACKS[variant];
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
  const known = new Set([...hero.cards, ...state.communityCards].map((c) => `${c.rank}:${c.suit}`));
  const deck: Card[] = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))).filter(
    (c) => !known.has(`${c.rank}:${c.suit}`)
  );
  if (!active.length || dealt.length * pack.holes + 5 - state.communityCards.length > deck.length)
    return null;
  let stream = saveFastRandom() ^ 0x51a7e11;
  for (const card of hero.cards)
    for (const char of `${card.rank}:${card.suit}`)
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
              a.action === 'bet' ||
              a.action === 'raise' ||
              (a.action === 'all_in' && a.isFullRaise !== undefined)
          ).length,
          calls: line.filter(
            (a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)
          ).length,
        },
      ];
    })
  );
  // The measured policy's sample, always (2026-10-09). The P11.2 matrix priced
  // every proposal on the full 32 samples (governor off), and the P11.3
  // completion floor admits a pack only when its live decisions price that
  // same sample. Scaling the request by the equity governor made about 4% of
  // natural postflop decisions governor-reduced on release c1deef24, so no
  // qualified pack could meet the floor. Load is still bounded: the sampler
  // stops starting work at its own deadline (counted as budget exhausted).
  const requested = 32;
  const board3 = state.communityCards;
  const codes = new Map<Card, number>();
  for (const card of [...deck, ...hero.cards, ...board3]) codes.set(card, codeOf(card));
  const codesOf = (cards: Card[]) => cards.map((card) => codes.get(card)!);
  const heroCodes = codesOf(hero.cards);
  // The public board's triples are fixed for the whole decision.
  const publicTriples = newTriples();
  loadTriples(publicTriples, codesOf(board3), board3.length);
  const publicTable = rankPairTable(publicTriples);
  // A showdown's best is the better of the public-board triples and the
  // triples holding a drawn card. The public part of each drawn hand is the
  // score its prior weight already computed, and the hero's is the same in
  // every sample, so each sample scores only the drawn triples (none on the
  // river, where the public score IS the showdown score).
  const publicScoreOf = new Map<Card[], number>();
  const handCodes = new Map<Card[], number[]>();
  const hole = (cards: Card[]) => {
    let codesOfHand = handCodes.get(cards);
    if (!codesOfHand) handCodes.set(cards, (codesOfHand = codesOf(cards)));
    return codesOfHand;
  };
  const publicScore = (cards: Card[]) => {
    let score = publicScoreOf.get(cards);
    if (score === undefined)
      publicScoreOf.set(cards, (score = omahaHiTable(hole(cards), publicTriples, publicTable)));
    return score;
  };
  const madeCategory = (cards: Card[]) => Math.floor(publicScore(cards) / 0x100000);
  handCodes.set(hero.cards, heroCodes);
  const heroPublicHigh = publicScore(hero.cards);
  const heroPublicLow = pack.splitPot ? omahaLowFast(heroCodes, publicTriples) : Infinity;
  const drawnTriples = newTriples();
  const boardCodes: number[] = [];
  const samples: HorseEquityOutcomeSample[] = [];
  // P11.1: what the prior actually did, recorded with the sample it produced.
  let seatDraws = 0;
  let uniformEscapes = 0;
  sampleLoop: for (let iteration = 0; iteration < requested; iteration++) {
    if (!withinBudget()) break;
    let remaining = deck.slice();
    const hands = new Map<string, Card[]>();
    const contactOf = new Map<string, number>();
    let iterationEscapes = 0;
    for (const p of dealt) {
      if (!withinBudget()) break sampleLoop;
      const read = reads.get(p.user_id)!;
      const exponent = Math.min(4, 1 + read.raises * 0.6 + read.calls * 0.1);
      // Up to three rejection attempts from the still-available deck. The
      // final attempt is a declared uniform escape, keeping sparse priors
      // from inventing impossible cards or starving wide tables.
      for (let attempt = 0; attempt < 3; attempt++) {
        const trial = remaining.slice();
        const cards: Card[] = [];
        for (let h = 0; h < pack.holes; h++)
          cards.push(trial.splice(Math.floor(random() * trial.length), 1)[0]);
        // The third attempt is accepted without a weight test (no random draw
        // either), so its weight is never computed: same cards, same stream.
        if (attempt === 2) {
          iterationEscapes++;
          remaining = trial;
          hands.set(p.user_id, cards);
          break;
        }
        // The made category, exactly omahaMadeClass(...).category on a 3-5 card
        // board, without the board-shape and rank maps the prior never reads.
        const category = madeCategory(cards);
        const signal = Math.min(
          1,
          omahaVariantHandQuality(variant, cards) * 0.55 + (category / 10) * 0.45
        );
        const weight = Math.pow(0.3 + signal * 0.7, exponent);
        if (random() <= weight) {
          remaining = trial;
          hands.set(p.user_id, cards);
          contactOf.set(p.user_id, category / 10);
          break;
        }
      }
    }
    const board = state.communityCards.slice();
    while (board.length < 5)
      board.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
    for (let i = 0; i < 5; i++) boardCodes[i] = codes.get(board[i])!;
    loadTriples(drawnTriples, boardCodes, 5, board3.length);
    const high = (cards: Card[]) => {
      const drawn = omahaHiFast(hole(cards), drawnTriples);
      const known = cards === hero.cards ? heroPublicHigh : publicScore(cards);
      return drawn > known ? drawn : known;
    };
    const low = (cards: Card[]) => {
      if (!pack.splitPot) return null;
      const known = cards === hero.cards ? heroPublicLow : omahaLowFast(hole(cards), publicTriples);
      const drawn = omahaLowFast(hole(cards), drawnTriples);
      const value = drawn < known ? drawn : known;
      return Number.isFinite(value) ? value : null;
    };
    // Counted only for a completed sample: an iteration cut by the budget
    // contributes no showdown and no draw.
    seatDraws += dealt.length;
    uniformEscapes += iterationEscapes;
    samples.push({
      heroHigh: high(hero.cards),
      heroLow: low(hero.cards),
      opponentHigh: active.map((p) => high(hands.get(p.user_id)!)),
      opponentLow: active.map((p) => low(hands.get(p.user_id)!)),
      opponentDecisionStrength: active.map(
        (p) => contactOf.get(p.user_id) ?? madeCategory(hands.get(p.user_id)!) / 10
      ),
    });
  }
  retain?.({ samples, opponentIds: active.map((p) => p.user_id) });
  const evidence = omahaVariantEquityFromShowdowns({
    variant,
    players: state.players,
    heroId: hero.user_id,
    callCost: Math.min(hero.stack, Math.max(0, state.currentBet - hero.bet)),
    opponentIds: active.map((p) => p.user_id),
    samples,
  });
  if (evidence) {
    evidence.analysisMs = performance.now() - started;
    evidence.provenance = 'variant_public_line_joint_deck';
    evidence.requestedSamples = requested;
    evidence.sampleBudgetExhausted = samples.length < requested;
    evidence.range = Object.freeze({
      version: 'omaha-variant-range-provenance-v1',
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
        physical: 'single_deck_excluding_hero_and_board',
        dealtOpponents: dealt.length,
      }),
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
    } satisfies OmahaVariantRangeProvenance);
  }
  return evidence;
}
