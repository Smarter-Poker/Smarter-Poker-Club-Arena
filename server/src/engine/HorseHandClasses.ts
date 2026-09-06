/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE HAND CLASSES — the shape of the hand, which a percentile cannot see
 * (V46, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From the deep audit, section 5.1: "NO SOLVER DATA EXISTS FOR ANY OF THESE
 * GAMES", covering 55% of cash seat-hands and 58% of tournament seat-hands.
 *
 * What exists today is right as far as it goes. HorseEval maps every variant
 * onto the hold em percentile ladder, so a bar selects the same QUALITY of
 * hand in every game, and HorseVariantProfile (V35) shifts that bar per
 * variant so PLO opens wider and 3-bets narrower. Both are blind to the same
 * thing:
 *
 *   IN OMAHA THE SHAPE OF THE FOUR CARDS DECIDES THE HAND, AND A PERCENTILE
 *   CANNOT SEE SHAPE.
 *
 * Three consequences, all of them visible in the review table:
 *
 *   - AAA-x READS STRONG. A percentile evaluator sees three aces as a
 *     monster. In Omaha it is close to unplayable: the third ace is dead, the
 *     hand has no redraw, and it flops an overpair and nothing else.
 *   - A RUNDOWN READS MEDIOCRE. JT98 double-suited is one of the best hands
 *     in the game multiway; on the hold em ladder it is a middling
 *     percentile.
 *   - 3-BETTING IS ANCHORED ON NOTHING. Published PLO strategy 3-bets around
 *     AAxx (double-suited most, rainbow least) and FLATS almost everything
 *     else, because a 3-bet gets called and then plays a pot-sized pot out of
 *     position with a hand that is 55/45 at best. The engine's 3-bet bar is
 *     one number for every shape.
 *
 * Short deck has its own version of the same problem: strip the deuces
 * through fives and suited connectors and suited aces gain enormously
 * (straights and flushes arrive far more often), while pairs LOSE value - a
 * set is no longer near-nuts when flushes beat full houses and everyone
 * connects with everything.
 *
 * THIS FILE IS NOT A SOLVER EXPORT AND DOES NOT PRETEND TO BE. It is the
 * published hand-class structure of these games, applied where the engine has
 * none, in the SAME BAR UNITS V35 already uses, behind an ablation flag with
 * a league matchup. When a real PLO or 6+ solver export arrives it replaces
 * these numbers and keeps this shape.
 *
 * Pure: no imports but the card type and the rank table, so the tests and the
 * league can load it without the engine.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

import { RANK_VALUES } from './PokerEngine.js';
import type { Card } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// CLASSES
// ─────────────────────────────────────────────────────────────────────────────

export type OmahaHandClass =
  /** a pair of aces, double-suited or with an ace suited - the 3-bet anchor */
  | 'aa_ds'
  /** a pair of aces, rainbow or one weak suit - equity without playability */
  | 'aa_dry'
  /** four broadway cards, double-suited */
  | 'broadway_ds'
  /** four connected or one-gap cards, nine-high or better */
  | 'rundown'
  /** kings or queens with real suit or connection support */
  | 'kk_plus'
  /** a big pair with two connected or suited side cards */
  | 'pair_support'
  /** three good cards and one disconnected low card */
  | 'dangler'
  /** three or four of a rank in hand - the percentile lies about this hand */
  | 'trips'
  /** double-paired low, disconnected rainbow, no ace */
  | 'trash'
  /** nothing the chart has an opinion about */
  | 'other';

export type ShortDeckHandClass =
  /** an ace with a suited card - the nut flush draw IS the hand */
  | 'sd_suited_ace'
  /** JJ+ : strong, but it stacks off less than its hold em twin */
  | 'sd_big_pair'
  /** suited connector or one-gapper */
  | 'sd_suited_conn'
  /** 66-TT : the value published theory takes away (sets lose to flushes) */
  | 'sd_small_pair'
  | 'sd_other';

export type HandClass = OmahaHandClass | ShortDeckHandClass;

/** The same shape V35's variant shift uses. Negative = wider. */
export interface HandClassShift {
  open: number;
  threeBet: number;
  fourBet: number;
  coldCall: number;
  bbDefend: number;
}

export interface HandClassRead {
  cls: HandClass;
  shift: HandClassShift;
  /**
   * The class flats instead of 3-betting. A bar cannot say this: a rundown
   * wants to SEE a flop cheaply and multiway, and widening its 3-bet bar
   * would do the opposite of what the hand wants.
   */
  neverThreeBet: boolean;
  /**
   * The percentile is lying and the hand is a fold. Only `trips` and `trash`
   * reach this: a hand the ladder rates highly that the game rates at zero.
   */
  foldAlways: boolean;
}

const ZERO: HandClassShift = { open: 0, threeBet: 0, fourBet: 0, coldCall: 0, bbDefend: 0 };

/**
 * The chart. Bars are on the hold em percentile ladder, so -0.04 on the
 * button's 0.27 open bar is about eight percentage points of range, and
 * +0.06 on a 3-bet bar of 0.74 is roughly halving the 3-bet frequency.
 *
 * The direction of every row is published PLO/6+ theory, and the magnitudes
 * are deliberately smaller than a solver would use: this is a first chart
 * with a league matchup behind it, not a claim to have solved the game.
 */
const OMAHA_CHART: Record<OmahaHandClass, HandClassShift> = {
  // Aces double-suited: the one hand that wants a big pot preflop.
  aa_ds: { open: -0.1, threeBet: -0.14, fourBet: -0.1, coldCall: -0.06, bbDefend: -0.08 },
  // Aces dry: raise it, but a 3-bet out of position with no redraw is how
  // aces lose a stack in this game.
  aa_dry: { open: -0.08, threeBet: -0.05, fourBet: -0.03, coldCall: -0.04, bbDefend: -0.06 },
  // Broadway double-suited: every flop it likes is a big one, and it wants
  // company.
  broadway_ds: { open: -0.06, threeBet: 0.04, fourBet: 0.03, coldCall: -0.06, bbDefend: -0.06 },
  // Rundowns: the multiway hand. Open in position, flat, do not bloat.
  rundown: { open: -0.05, threeBet: 0.06, fourBet: 0.04, coldCall: -0.05, bbDefend: -0.05 },
  kk_plus: { open: -0.04, threeBet: -0.01, fourBet: 0.01, coldCall: -0.02, bbDefend: -0.03 },
  pair_support: { open: -0.02, threeBet: 0.02, fourBet: 0.02, coldCall: -0.02, bbDefend: -0.02 },
  // A dangler is three cards and a passenger: it plays, but only cheaply and
  // in position.
  dangler: { open: 0.05, threeBet: 0.08, fourBet: 0.06, coldCall: 0.02, bbDefend: 0.0 },
  // Trips and trash: the bars are irrelevant, foldAlways carries them.
  trips: { open: 0.3, threeBet: 0.3, fourBet: 0.3, coldCall: 0.3, bbDefend: 0.15 },
  trash: { open: 0.12, threeBet: 0.12, fourBet: 0.1, coldCall: 0.1, bbDefend: 0.04 },
  other: ZERO,
};

const SHORT_DECK_CHART: Record<ShortDeckHandClass, HandClassShift> = {
  // The nut flush draw is the hand in 6+; an ace with a suit plays every pot.
  sd_suited_ace: { open: -0.08, threeBet: -0.06, fourBet: -0.04, coldCall: -0.06, bbDefend: -0.08 },
  // A big pair is still a big pair, but it is not hold em's big pair.
  sd_big_pair: { open: -0.05, threeBet: -0.03, fourBet: -0.02, coldCall: -0.02, bbDefend: -0.04 },
  sd_suited_conn: { open: -0.06, threeBet: 0.02, fourBet: 0.02, coldCall: -0.05, bbDefend: -0.06 },
  // Small pairs: the set is not the lock it is in hold em (a flush beats a
  // full house here), so set-mining loses its price.
  sd_small_pair: { open: 0.06, threeBet: 0.06, fourBet: 0.04, coldCall: 0.05, bbDefend: 0.02 },
  sd_other: ZERO,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFIERS
// ─────────────────────────────────────────────────────────────────────────────

const rv = (c: Card): number => RANK_VALUES[c.rank] ?? 0;

/** Rank -> how many of it are in the hand. */
function rankCounts(cards: Card[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) m.set(rv(c), (m.get(rv(c)) ?? 0) + 1);
  return m;
}

/** Suit -> how many of it are in the hand. */
function suitCounts(cards: Card[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards) m.set(c.suit, (m.get(c.suit) ?? 0) + 1);
  return m;
}

/**
 * How connected are the four best cards: the span of the tightest four-card
 * window, ignoring pairs. 3 = perfectly connected (JT98), 4-5 = one or two
 * gaps, 6+ = disconnected. The ace also plays low for a wheel rundown.
 */
export function connectedSpan(cards: Card[]): number {
  const uniq = [...new Set(cards.map(rv))].sort((a, b) => a - b);
  const withWheelAce = uniq.includes(14) ? [...new Set([1, ...uniq])].sort((a, b) => a - b) : uniq;
  if (withWheelAce.length < 4) return 99;
  let best = 99;
  for (let i = 0; i + 3 < withWheelAce.length; i++) {
    best = Math.min(best, withWheelAce[i + 3] - withWheelAce[i]);
  }
  return best;
}

/** Suited pairs present: 2 = double-suited, 1 = single-suited, 0 = rainbow. */
export function suitedness(cards: Card[]): number {
  let pairs = 0;
  for (const n of suitCounts(cards).values()) if (n >= 2) pairs++;
  return pairs;
}

/** True when an ace shares a suit with another card (the nut-flush shape). */
export function aceSuited(cards: Card[]): boolean {
  const sc = suitCounts(cards);
  return cards.some((c) => c.rank === 'A' && (sc.get(c.suit) ?? 0) >= 2);
}

/**
 * Classify an Omaha hand (4, 5 or 6 cards). Five- and six-card hands are read
 * on the same signals - a hand with more cards has more ways to make each
 * shape, which is exactly why PLO5 and PLO6 open wider, and V35 already
 * carries that part.
 */
export function omahaHandClass(cards: Card[] | undefined | null): OmahaHandClass {
  if (!Array.isArray(cards) || cards.length < 4) return 'other';
  const counts = rankCounts(cards);
  const maxOfARank = Math.max(...counts.values());
  const aces = counts.get(14) ?? 0;

  // THREE OF A RANK IS A FOLD, AND THE LADDER DISAGREES. AAA-x is the hand
  // the percentile most overrates: the third ace is dead, and the hand has
  // one pair and no redraw. Checked before the AA branch, deliberately.
  if (maxOfARank >= 3) return 'trips';

  const suits = suitedness(cards);
  const span = connectedSpan(cards);
  const highCards = [...counts.keys()].filter((r) => r >= 10).length;

  if (aces === 2) {
    // Double-suited, or the aces themselves bring a suit: this is the hand
    // that 3-bets and 4-bets.
    return suits >= 2 || aceSuited(cards) ? 'aa_ds' : 'aa_dry';
  }

  // Four broadway cards with two suits: opens wide, flats 3-bets, wants a
  // multiway flop.
  if (highCards >= 4 && suits >= 2) return 'broadway_ds';

  // A rundown: four cards inside a five-rank window, nine-high or better.
  const topRank = Math.max(...counts.keys());
  if (span <= 4 && topRank >= 9 && maxOfARank === 1) return 'rundown';

  // Kings or queens with support.
  const hasKQPair = (counts.get(13) ?? 0) === 2 || (counts.get(12) ?? 0) === 2;
  if (hasKQPair && (suits >= 1 || span <= 5)) return 'kk_plus';

  // Any big pair with connected or suited side cards.
  const bigPairRank = [...counts.entries()].find(([r, n]) => n === 2 && r >= 10)?.[0];
  if (bigPairRank !== undefined && (suits >= 1 || span <= 5)) return 'pair_support';

  // TRASH before DANGLER: a double-paired low rainbow hand is not "three good
  // cards and a passenger", it is a hand with no way to make the nuts.
  const pairCount = [...counts.values()].filter((n) => n === 2).length;
  const lowRainbow = suits === 0 && topRank <= 11 && aces === 0;
  if ((pairCount >= 2 && topRank <= 10) || (lowRainbow && span >= 6)) return 'trash';

  // Three cards that work together and one that does not.
  if (span >= 5 && (highCards >= 2 || aces >= 1)) return 'dangler';

  return 'other';
}

/** Classify a short-deck (36-card) hold em hand. */
export function shortDeckHandClass(cards: Card[] | undefined | null): ShortDeckHandClass {
  if (!Array.isArray(cards) || cards.length !== 2) return 'sd_other';
  const [a, b] = cards;
  const ra = rv(a);
  const rb = rv(b);
  const suited = a.suit === b.suit;
  if (ra === rb) return ra >= 11 ? 'sd_big_pair' : 'sd_small_pair';
  if (suited && (ra === 14 || rb === 14)) return 'sd_suited_ace';
  if (suited && Math.abs(ra - rb) <= 2) return 'sd_suited_conn';
  return 'sd_other';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE READ
// ─────────────────────────────────────────────────────────────────────────────

const NEVER_THREE_BET = new Set<HandClass>([
  // The multiway hands: they want a cheap flop with company, and a 3-bet
  // gets them a pot-sized pot heads-up out of position instead.
  'rundown',
  'broadway_ds',
  'dangler',
  'sd_small_pair',
]);

const FOLD_ALWAYS = new Set<HandClass>(['trips', 'trash']);

const NO_READ: HandClassRead = {
  cls: 'other',
  shift: ZERO,
  neverThreeBet: false,
  foldAlways: false,
};

/**
 * The class of the hand hero was dealt, and what it does to the bars.
 * `isOmaha` and `isShortDeck` come from HorseEval.variantInfo, so a hold em
 * hand returns the zero read and the caller is byte-identical to V35.
 */
export function handClassRead(
  cards: Card[] | undefined | null,
  isOmaha: boolean,
  isShortDeck: boolean
): HandClassRead {
  if (!Array.isArray(cards) || cards.length === 0) return NO_READ;
  if (isOmaha) {
    const cls = omahaHandClass(cards);
    return {
      cls,
      shift: OMAHA_CHART[cls],
      neverThreeBet: NEVER_THREE_BET.has(cls),
      foldAlways: FOLD_ALWAYS.has(cls),
    };
  }
  if (isShortDeck) {
    const cls = shortDeckHandClass(cards);
    return {
      cls,
      shift: SHORT_DECK_CHART[cls],
      neverThreeBet: NEVER_THREE_BET.has(cls),
      foldAlways: false,
    };
  }
  return NO_READ;
}

/** Every class the chart knows, for the tests that pin them all. */
export const OMAHA_CLASSES = Object.keys(OMAHA_CHART) as OmahaHandClass[];
export const SHORT_DECK_CLASSES = Object.keys(SHORT_DECK_CHART) as ShortDeckHandClass[];
