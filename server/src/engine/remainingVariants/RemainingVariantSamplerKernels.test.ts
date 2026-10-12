/**
 * The Phase 12 live sampler's exact kernels (2026-10-11).
 *
 * The sampler stopped at its 2.5 ms deadline on most Crazy Pineapple postflop
 * decisions with four or five dealt seats and on a few percent of FLO8
 * decisions, so neither pack could meet the P12.3 completion floor. The root
 * was work per decision, not the deadline: a retained Pineapple pair was chosen
 * for every dealt seat (folded ones included) on every sample, every prior
 * attempt rebuilt a full hand shape to read one number, and FLO8 scored its
 * 60 two-plus-three combinations from card objects for every hand.
 *
 * Each kernel that replaced that work must return exactly what the code it
 * replaced returned, so a sample, a receipt and a decision cannot change:
 * these tests compare them value for value (Object.is, so the same IEEE
 * double), exhaustively where the domain allows it, and pin the sampler's
 * whole output on natural HandController spots to the digest the original
 * code produced.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../types.js';
import { RANKS, SUITS } from '../PokerEngine.js';
import { restoreFastRandom, scoreOmahaHi } from '../HorseEval.js';
import { scoreFiveCards } from '../HorseFiveCardScore.js';
import { forEachControllerSpot } from './RemainingVariantControllerSpots.test-support.js';
import {
  remainingVariantHandShape,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';
import {
  choosePineappleFlopPair,
  drawInPlace,
  fiveCardScoreFromCounters,
  flo8SampledOmahaHigh,
  pineappleSampledFlopPair,
  remainingVariantSampledShapeQuality,
  removePicked,
  sampleRemainingVariantEquity,
} from './RemainingVariantSampler.js';

const DECK: Card[] = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }) as Card));
const SHORT_DECK = DECK.filter((c) => RANKS.indexOf(c.rank) >= 4);
const key = (c: Card) => `${c.rank}${c.suit[0]}`;

function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function* combinations(deck: Card[], k: number, start = 0, prefix: Card[] = []): Generator<Card[]> {
  if (prefix.length === k) {
    yield prefix.slice();
    return;
  }
  for (let i = start; i <= deck.length - (k - prefix.length); i++) {
    prefix.push(deck[i]);
    yield* combinations(deck, k, i + 1, prefix);
    prefix.pop();
  }
}

const permutations3 = (c: Card[]) => [
  [c[0], c[1], c[2]],
  [c[0], c[2], c[1]],
  [c[1], c[0], c[2]],
  [c[1], c[2], c[0]],
  [c[2], c[0], c[1]],
  [c[2], c[1], c[0]],
];

describe('remainingVariantSampledShapeQuality is remainingVariantHandShape(...).quality', () => {
  it('for every two-card Short Deck, FLH and retained Pineapple pair, in both orders', () => {
    let checked = 0;
    for (const [variant, deck, postDiscard] of [
      ['short_deck', SHORT_DECK, false],
      ['flh', DECK, false],
      ['pineapple', DECK, true],
    ] as const)
      for (const [a, b] of combinations(deck, 2))
        for (const cards of [
          [a, b],
          [b, a],
        ]) {
          const want = remainingVariantHandShape(variant, cards, postDiscard).quality;
          const got = remainingVariantSampledShapeQuality(variant, cards, postDiscard);
          if (!Object.is(got, want)) expect({ variant, cards: cards.map(key), got }).toEqual(want);
          checked++;
        }
    expect(checked).toBe(2 * (630 + 1326 + 1326));
  });

  it('for every three-card Crazy Pineapple holding before the discard, in every order', () => {
    let checked = 0;
    for (const combo of combinations(DECK, 3))
      for (const cards of permutations3(combo)) {
        const want = remainingVariantHandShape('pineapple', cards).quality;
        const got = remainingVariantSampledShapeQuality('pineapple', cards);
        if (!Object.is(got, want)) expect({ cards: cards.map(key), got }).toEqual(want);
        checked++;
      }
    expect(checked).toBe(22_100 * 6);
  });

  it('for every four-card FLO8 holding, and in a shuffled order', () => {
    const random = seeded(0xf108);
    let checked = 0;
    for (const combo of combinations(DECK, 4)) {
      const want = remainingVariantHandShape('flo8', combo).quality;
      const got = remainingVariantSampledShapeQuality('flo8', combo);
      if (!Object.is(got, want)) expect({ cards: combo.map(key), got }).toEqual(want);
      const shuffled = combo.slice().sort(() => random() - 0.5);
      expect(Object.is(remainingVariantSampledShapeQuality('flo8', shuffled), want)).toBe(true);
      checked++;
    }
    expect(checked).toBe(270_725);
  });
});

describe('pineappleSampledFlopPair is choosePineappleFlopPair', () => {
  it('keeps the same two cards for 100,000 seeded holdings and flops', () => {
    const random = seeded(0x9a1e);
    for (let i = 0; i < 100_000; i++) {
      const deck = DECK.slice();
      const take = () => deck.splice(Math.floor(random() * deck.length), 1)[0];
      const cards = [take(), take(), take()];
      const flop = [take(), take(), take()];
      const want = choosePineappleFlopPair(cards, flop).map(key);
      const got = pineappleSampledFlopPair(cards, flop).map(key);
      if (got.join() !== want.join())
        expect({ cards: cards.map(key), flop: flop.map(key), got }).toEqual(want);
    }
  });

  it('keeps the same two cards for every holding on boards built to tie and to draw', () => {
    const boards = [
      ['A', 'h', 'K', 'h', 'Q', 'h'],
      ['7', 's', '7', 'd', '2', 'c'],
      ['5', 'c', '4', 'd', '3', 'h'],
      ['T', 'c', '9', 'c', '8', 'd'],
      ['A', 's', '2', 'd', '3', 'c'],
      ['K', 'd', 'K', 'c', 'K', 'h'],
    ];
    const suitOf = (s: string) => SUITS.find((x) => x[0] === s)!;
    for (const spec of boards) {
      const flop = [0, 2, 4].map((i) => ({ rank: spec[i], suit: suitOf(spec[i + 1]) }) as Card);
      const rest = DECK.filter((c) => !flop.some((f) => key(f) === key(c)));
      for (const cards of combinations(rest, 3)) {
        const want = choosePineappleFlopPair(cards, flop).map(key);
        const got = pineappleSampledFlopPair(cards, flop).map(key);
        if (got.join() !== want.join()) expect({ cards: cards.map(key), got }).toEqual(want);
      }
    }
  });
});

describe('the FLO8 high kernel is scoreOmahaHi', () => {
  it('fiveCardScoreFromCounters is scoreFiveCards for every five-card hand', () => {
    let checked = 0;
    const ranks = DECK.map((c) => 1 << (RANKS.indexOf(c.rank) + 2));
    const n = DECK.length;
    const hand: Card[] = new Array(5);
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) {
              let once = 0,
                twice = 0,
                thrice = 0,
                four = 0;
              for (const bit of [ranks[a], ranks[b], ranks[c], ranks[d], ranks[e]]) {
                four |= thrice & bit;
                thrice |= twice & bit;
                twice |= once & bit;
                once |= bit;
              }
              const suit = DECK[a].suit;
              const flush =
                DECK[b].suit === suit &&
                DECK[c].suit === suit &&
                DECK[d].suit === suit &&
                DECK[e].suit === suit;
              hand[0] = DECK[a];
              hand[1] = DECK[b];
              hand[2] = DECK[c];
              hand[3] = DECK[d];
              hand[4] = DECK[e];
              const got = fiveCardScoreFromCounters(once, twice, thrice, four, flush);
              const want = scoreFiveCards(hand);
              if (got !== want) expect({ hand: hand.map(key), got }).toEqual(want);
              checked++;
            }
    expect(checked).toBe(2_598_960);
  });

  it('flo8SampledOmahaHigh is scoreOmahaHi for 200,000 seeded deals', () => {
    const random = seeded(0x0a8a);
    for (let i = 0; i < 200_000; i++) {
      const deck = DECK.slice();
      const take = () => deck.splice(Math.floor(random() * deck.length), 1)[0];
      const hole = [take(), take(), take(), take()];
      const board = [take(), take(), take(), take(), take()];
      const got = flo8SampledOmahaHigh(hole, board);
      const want = scoreOmahaHi(hole, board);
      if (got !== want) expect({ hole: hole.map(key), board: board.map(key), got }).toEqual(want);
    }
  });
});

describe('drawInPlace and removePicked are the copied-deck splices', () => {
  it('take the same cards from the same draws and leave the same deck', () => {
    const random = seeded(0xd4a3);
    for (let trial = 0; trial < 20_000; trial++) {
      const length = 8 + Math.floor(random() * 45);
      const deck = DECK.slice(0, length);
      const holes = 2 + Math.floor(random() * 3);
      const stream = random() * 0x100000000;
      const reference = deck.slice();
      const draws = seeded(stream);
      const want = Array.from(
        { length: holes },
        () => reference.splice(Math.floor(draws() * reference.length), 1)[0]
      );
      const inPlace = deck.slice();
      const picked = new Array<number>(4);
      const got = drawInPlace(inPlace, holes, seeded(stream), picked);
      expect(got.map(key)).toEqual(want.map(key));
      // A rejected attempt leaves the deck as it was.
      expect(inPlace.map(key)).toEqual(deck.map(key));
      removePicked(inPlace, picked, holes);
      expect(inPlace.map(key)).toEqual(reference.map(key));
    }
  });
});

/**
 * The sampler's whole output (every showdown, receipt field and count except
 * its wall time) on natural HandController postflop spots, from unbounded
 * and part-way budgets, hashed per pack. The controller shuffles a physical
 * deck, so the hero's cards, the hero's known discard and the board are
 * re-dealt here from a seeded stream (the betting line, stacks and seats stay
 * the controller's own). The digests were produced, on the same spots, by the
 * sampler as it was before the kernels (RemainingVariantSampler.ts at
 * 1235b47a63c439da9bdf8427148bc0818499378c).
 */
const ORIGINAL_SAMPLER_OUTPUT_SHA256: Record<RemainingPolicyVariant, string> = {
  short_deck: 'e1a4a457da80f08684ee5f07979fbe0ffc64c1c022d20288fa0c80942f7a6de1',
  pineapple: 'f1d713de2e2da662633b7427fb00c552b17f8f099a0f299e66e1486a21c99e4e',
  flh: 'c49093f188cfa23789c829086b3577e7b6bba72187e11b20bbdcb3f09cb17437',
  flo8: '7ef5d35aeca68f9e620af2fccb4924de99cdad2e2b0f30ecd1c491f4770e1ea4',
};

const ORIGINAL_SPOTS: Record<RemainingPolicyVariant, number> = {
  short_deck: 97,
  pineapple: 155,
  flh: 745,
  flo8: 764,
};

function samplerOutputDigest(variant: RemainingPolicyVariant): { spots: number; sha256: string } {
  const hash = createHash('sha256');
  const random = seeded(0x512c);
  let spots = 0;
  forEachControllerSpot(variant, 'cash', 40, 0x512c, (spot) => {
    if (spot.state.communityCards.length < 3) return;
    const deck = (variant === 'short_deck' ? SHORT_DECK : DECK).slice();
    const take = (n: number) =>
      Array.from({ length: n }, () => ({
        ...deck.splice(Math.floor(random() * deck.length), 1)[0],
      }));
    const hero = {
      ...spot.hero,
      cards: take(spot.hero.cards.length),
      knownDeadCards: take(spot.hero.knownDeadCards?.length ?? 0),
    };
    const state = { ...spot.state, communityCards: take(spot.state.communityCards.length) };
    for (const stopAt of [Infinity, 1, 9]) {
      let checks = 0;
      restoreFastRandom(0x5bd1e995 ^ spots);
      const evidence = sampleRemainingVariantEquity(variant, hero, state, () => ++checks <= stopAt);
      // Everything but the wall time the sampler took.
      const rest: Record<string, unknown> = { ...evidence };
      delete rest.analysisMs;
      hash.update(`${checks}|${evidence ? JSON.stringify(rest) : 'null'}\n`);
    }
    spots++;
  });
  return { spots, sha256: hash.digest('hex') };
}

describe('the sampler output is bit-identical to the sampler before the kernels', () => {
  for (const variant of ['short_deck', 'pineapple', 'flh', 'flo8'] as const)
    it(variant, () => {
      const { spots, sha256 } = samplerOutputDigest(variant);
      expect(spots).toBe(ORIGINAL_SPOTS[variant]);
      expect(sha256).toBe(ORIGINAL_SAMPLER_OUTPUT_SHA256[variant]);
    });
});
