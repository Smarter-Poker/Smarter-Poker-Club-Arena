/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HAND-CLASS CHART, MEASURED AGAINST THE REAL DECK (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The deep audit's longest-standing open item reads: "A real PLO/short-deck
 * solver export. V46 is published hand-class structure, not a solver. Needs a
 * data source that does not exist in this estate."
 *
 * That is still true, and this is not a solver. A solver produces
 * FREQUENCIES at a node. What it does produce is the one reference that DOES
 * exist here and had never been used: the engine's own equity evaluator,
 * running over the actual deck of the actual variant.
 *
 * Equity cannot tell you how often to 3-bet. It CAN tell you whether the
 * chart has the classes in the right ORDER - and that is the claim V46
 * actually makes. `aa_ds` opens 0.10 wider than `pair_support` because the
 * theory says it is the stronger hand. Nobody had ever checked that against
 * the deck, in this engine, at this table size.
 *
 * So: deal many hands of each class, measure each class's mean all-in equity
 * against random opponents at 2, 3 and 6 handed, and let a law test assert
 * that the chart's opening order matches the measured order. When a class is
 * out of place, either the chart is wrong or the classifier is - and both of
 * those have already happened once each in this file's short life.
 *
 * Deterministic: seeded, so the numbers are reproducible and a test can pin
 * them. Pure apart from the evaluator, and it never touches a live table.
 */
import { SUITS, RANKS } from '../engine/PokerEngine.js';
import {
  simulateEquity,
  variantInfo,
  seedFastRandom,
  saveFastRandom,
  restoreFastRandom,
  fastRandom,
} from '../engine/HorseEval.js';
import {
  omahaHandClass,
  shortDeckHandClass,
  type OmahaHandClass,
  type ShortDeckHandClass,
} from '../engine/HorseHandClasses.js';
import type { Card } from '../types.js';

export interface ClassEquity {
  /** The class as the classifier names it. */
  handClass: string;
  /** Hands of this class that the sampler found. */
  samples: number;
  /** Mean all-in equity against this many random opponents. */
  equityHeadsUp: number;
  equityThreeWay: number;
  equitySixWay: number;
}

/** Short deck strips deuces through fives. */
const SHORT_DECK_RANKS = new Set(['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);

function buildDeck(shortDeck: boolean): Card[] {
  const out: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (shortDeck && !SHORT_DECK_RANKS.has(rank as string)) continue;
      out.push({ rank, suit } as Card);
    }
  }
  return out;
}

function dealHand(deck: Card[], holeCount: number): Card[] {
  // Fisher-Yates over a copy of the top slice only - the evaluator reshuffles
  // the remainder itself, and copying 52 cards per sample is the whole cost.
  const d = deck.slice();
  for (let i = 0; i < holeCount; i++) {
    const j = i + Math.floor(fastRandom() * (d.length - i));
    const t = d[i];
    d[i] = d[j];
    d[j] = t;
  }
  return d.slice(0, holeCount);
}

/**
 * Measure every class of one variant.
 *
 * `samplesPerClass` is a FLOOR, not a target: hands are dealt at random and
 * bucketed by their class, so a rare class (aa_ds is about 1 hand in 80)
 * needs many more deals than a common one. The sampler runs until every class
 * has enough or the deal budget is spent, and reports the sample count so a
 * thin class is visible rather than silently confident.
 */
export function measureHandClassEquity(
  gameVariant: string,
  samplesPerClass = 120,
  maxDeals = 400_000,
  iterations = 400
): ClassEquity[] {
  const vi = variantInfo(gameVariant);
  const shortDeck = gameVariant.toLowerCase().includes('short');
  const deck = buildDeck(shortDeck);
  const classify = (cards: Card[]): string =>
    shortDeck ? shortDeckHandClass(cards) : omahaHandClass(cards);

  const buckets = new Map<string, Card[][]>();
  const rngBefore = saveFastRandom();
  seedFastRandom(0x46_2026);
  try {
    for (let deal = 0; deal < maxDeals; deal++) {
      const hand = dealHand(deck, vi.holeCount);
      const k = classify(hand);
      const list = buckets.get(k) ?? [];
      if (list.length >= samplesPerClass) continue;
      list.push(hand);
      buckets.set(k, list);
      // Stop early once every class the classifier can produce is full.
      if ([...buckets.values()].every((l) => l.length >= samplesPerClass) && buckets.size >= 5) {
        // Not a guarantee that every class exists - a variant may not produce
        // all of them - so the deal budget is still the real bound.
        if (deal > maxDeals / 4) break;
      }
    }

    const out: ClassEquity[] = [];
    for (const [handClass, hands] of buckets) {
      let hu = 0;
      let three = 0;
      let six = 0;
      for (const hand of hands) {
        hu += simulateEquity(hand, [], 1, vi, iterations);
        three += simulateEquity(hand, [], 2, vi, iterations);
        six += simulateEquity(hand, [], 5, vi, iterations);
      }
      const n = hands.length;
      out.push({
        handClass,
        samples: n,
        equityHeadsUp: hu / n,
        equityThreeWay: three / n,
        equitySixWay: six / n,
      });
    }
    // Strongest first, six-handed, because the chart's opening bars are a
    // full-ring decision and multiway equity is what an Omaha hand is for.
    out.sort((a, b) => b.equitySixWay - a.equitySixWay);
    return out;
  } finally {
    restoreFastRandom(rngBefore);
  }
}

/** Every Omaha class the classifier can emit, strongest first by the chart. */
export const OMAHA_CHART_ORDER: OmahaHandClass[] = [
  'aa_ds',
  'aa_dry',
  'broadway_ds',
  'rundown',
  'kk_plus',
  'pair_support',
  'other',
  'dangler',
  'trash',
  'trips',
];

/** Same for short deck. */
export const SHORT_DECK_CHART_ORDER: ShortDeckHandClass[] = [
  'sd_suited_ace',
  'sd_suited_conn',
  'sd_big_pair',
  'sd_other',
  'sd_small_pair',
];
