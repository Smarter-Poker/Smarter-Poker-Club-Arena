/**
 * ═══ ONE FLAG, SEVERAL BEHAVIORS: THE COMPONENT FLAGS (2026-09-21) ═══
 *
 * plo4_v16_polarity pools to -0.71 bb/100 and shortdeck_v23 to -0.79 over
 * the eight nightly runs to 2026-09-21, and each master flag gates more than
 * one behavior. Before either is tuned, each behavior has to be measurable
 * alone, so v16PloPolar and v23Variants gained component flags:
 *
 *   v16PloPolarAA3Bet  the AAxx 3-bet bar 0.04 under the generic bar
 *   v16PloPolarFlat    a non-AA hand within 0.05 over the bar flats
 *   v23SdThinValue     short deck: the one-pair thin-value bar is 0.03 higher
 *   v23SdDrawCredit    short deck: a live draw's implied credit is 0.02 larger
 *
 * (The third v23Variants behavior, the low-only draw rule, needs a hi-lo
 * deal, so plo8_v23_lowdraw already measures it alone.)
 *
 * These are ABLATION controls, and production play must not move. This file
 * holds that on a fixed scenario set: league deals with fixed seeds, all six
 * seats on one config, every decision captured as action:amount.
 *   1. Default play is the pre-split play. SCENARIO_PINS were computed on
 *      origin/main 397a467976, before the split, for `{}` and for the b-side
 *      of each parent matchup, and the split leaves every one unchanged.
 *   2. The split is a partition: the master off decides exactly as every
 *      component off.
 *   3. Each component reaches its own path, and no component reaches a
 *      variant it is not written for.
 *
 * A strategy change that moves one of these hands moves a pin, and that is
 * the point of a pin. Re-pin only in a change that means to move default
 * play, and say so in its changelog.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { HorseLogic, ploPolarityRead, type HorseDecideOpts } from './HorseLogic.js';
import { LEAGUE_MATCHUPS, playHand } from '../benchmark/HorseLeague.js';
import type { Card } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

/** Every decision of one league hand, all six seats on `opts`, as action:amount. */
function handStream(variant: string, opts: HorseDecideOpts, hand: number): string {
  const stream: string[] = [];
  const real = HorseLogic.decide.bind(HorseLogic);
  const spy = vi.spyOn(HorseLogic, 'decide').mockImplementation(((...args: unknown[]) => {
    const d = (real as (...a: unknown[]) => { action: string; amount?: number })(...args);
    stream.push(`${d.action}:${d.amount ?? ''}`);
    return d;
  }) as never);
  try {
    // No sandbox: playHand forces mind:false and reseeds the strategy RNG per
    // hand, so the stream is a pure function of (variant, opts, hand).
    playHand(
      (0x0c0de000 + hand) >>> 0,
      (hand % 6) + 1,
      () => opts,
      undefined,
      undefined,
      variant,
      6,
      100
    );
  } finally {
    spy.mockRestore();
  }
  return stream.join(',');
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

/**
 * THE FIXED SCENARIO SET. The first 30 hands of each variant (100 in short
 * deck, where a hand costs a tenth as much), plus the hands where each
 * component was measured on 2026-09-21 to move a decision, so the set
 * exercises every path the split touched.
 */
const SCENARIOS: Record<string, readonly number[]> = {
  // 36, 94, 107, 136: the margin flat
  plo4: [...range(0, 30), 36, 94, 107, 136],
  // 56, 124, 174: the margin flat; 171: the AAxx discount
  plo5: [...range(0, 30), 56, 124, 171, 174],
  // 49, 141, 206, 280: thin value; 61, 70, 97, 125, 127, 164: draw credit
  short_deck: [...range(0, 100), 125, 127, 141, 164, 206, 280],
  // 218, 226: the polarity read; 222, 257, 291: the low-only draw rule
  plo8: [...range(0, 30), 218, 222, 226, 257, 291],
};

const streams = new Map<string, string[]>();
/** The scenario set's decisions for one config, one hand per entry (cached). */
function scenario(variant: string, opts: HorseDecideOpts): string[] {
  const key = `${variant} ${JSON.stringify(opts)}`;
  let s = streams.get(key);
  if (!s) {
    s = SCENARIOS[variant].map((hand) => handStream(variant, opts, hand));
    streams.set(key, s);
  }
  return s;
}

const digest = (hands: string[]): string =>
  createHash('sha256').update(hands.join('|')).digest('hex').slice(0, 16);
const decisionCount = (hands: string[]): number =>
  hands.reduce((n, h) => n + (h ? h.split(',').length : 0), 0);

/** Computed on origin/main 397a467976, before the component flags existed. */
const SCENARIO_PINS: Array<{
  variant: string;
  opts: HorseDecideOpts;
  decisions: number;
  sha: string;
}> = [
  { variant: 'plo4', opts: {}, decisions: 360, sha: 'd5d129a2ed920e61' },
  { variant: 'plo4', opts: { v16PloPolar: false }, decisions: 342, sha: '306c80f0ccd8ab48' },
  { variant: 'plo5', opts: {}, decisions: 387, sha: '6d234af779e16886' },
  { variant: 'plo5', opts: { v16PloPolar: false }, decisions: 369, sha: '98a52797495d5d23' },
  { variant: 'short_deck', opts: {}, decisions: 860, sha: '051072edea81045b' },
  {
    variant: 'short_deck',
    opts: { v23Variants: false },
    decisions: 847,
    sha: '3465e5ed2d7f36b3',
  },
  { variant: 'plo8', opts: {}, decisions: 371, sha: 'd1b4d7d04057fb62' },
  { variant: 'plo8', opts: { v23Variants: false }, decisions: 371, sha: '2576036546924c99' },
];

describe('ploPolarityRead: the V16 polarity read, split', () => {
  const HANDS: Card[][] = [
    [c('A', 'hearts'), c('A', 'spades'), c('7', 'clubs'), c('2', 'diamonds')],
    [c('A', 'hearts'), c('K', 'hearts'), c('Q', 'spades'), c('J', 'spades')],
    [c('9', 'hearts'), c('8', 'hearts'), c('7', 'spades'), c('6', 'spades')],
    [c('A', 'hearts'), c('A', 'spades'), c('A', 'clubs'), c('K', 'diamonds'), c('Q', 'hearts')],
    [
      c('K', 'hearts'),
      c('K', 'spades'),
      c('Q', 'clubs'),
      c('Q', 'diamonds'),
      c('4', 'hearts'),
      c('3', 'clubs'),
    ],
  ];
  /** The expression HorseLogic passed as omahaAA before the split, verbatim. */
  const preSplit = (cards: Card[], isOmaha: boolean, master: boolean | undefined) =>
    (master ?? true) !== false && isOmaha
      ? cards.filter((hc) => hc.rank === 'A').length >= 2
      : undefined;

  it('with the component flags at their defaults it is exactly the pre-split expression', () => {
    for (const cards of HANDS) {
      for (const isOmaha of [true, false]) {
        for (const master of [undefined, true, false]) {
          const opts = master === undefined ? {} : { v16PloPolar: master };
          expect(ploPolarityRead(cards, isOmaha, opts)).toBe(preSplit(cards, isOmaha, master));
          expect(
            ploPolarityRead(cards, isOmaha, {
              ...opts,
              v16PloPolarAA3Bet: true,
              v16PloPolarFlat: true,
            })
          ).toBe(preSplit(cards, isOmaha, master));
        }
      }
    }
  });

  it('each component switches off only its own value; both off is the master off', () => {
    const aa = HANDS[0];
    const noAA = HANDS[2];
    expect(ploPolarityRead(aa, true, {})).toBe(true);
    expect(ploPolarityRead(noAA, true, {})).toBe(false);
    // AAxx discount off: the AA hand stops reaching it, the other keeps its flat.
    expect(ploPolarityRead(aa, true, { v16PloPolarAA3Bet: false })).toBeUndefined();
    expect(ploPolarityRead(noAA, true, { v16PloPolarAA3Bet: false })).toBe(false);
    // Margin flat off: the non-AA hand stops reaching it, AA keeps its discount.
    expect(ploPolarityRead(noAA, true, { v16PloPolarFlat: false })).toBeUndefined();
    expect(ploPolarityRead(aa, true, { v16PloPolarFlat: false })).toBe(true);
    for (const cards of HANDS) {
      expect(
        ploPolarityRead(cards, true, { v16PloPolarAA3Bet: false, v16PloPolarFlat: false })
      ).toBe(ploPolarityRead(cards, true, { v16PloPolar: false }));
    }
    // The master still wins over a component switched on.
    expect(
      ploPolarityRead(aa, true, { v16PloPolar: false, v16PloPolarAA3Bet: true })
    ).toBeUndefined();
  });
});

describe(
  'default play is the pre-split play, on the fixed scenario set',
  { timeout: 60_000 },
  () => {
    for (const pin of SCENARIO_PINS) {
      it(`${pin.variant} ${JSON.stringify(pin.opts)} decides exactly as before the split`, () => {
        const hands = scenario(pin.variant, pin.opts);
        expect(hands).toHaveLength(SCENARIOS[pin.variant].length);
        expect(decisionCount(hands)).toBe(pin.decisions);
        expect(digest(hands)).toBe(pin.sha);
      });
    }
  }
);

describe('each component reaches its own path, and only its own', { timeout: 60_000 }, () => {
  it('plo4: the margin flat moves decisions, and the master off is both components off', () => {
    expect(scenario('plo4', { v16PloPolarFlat: false })).not.toEqual(scenario('plo4', {}));
    expect(scenario('plo4', { v16PloPolarAA3Bet: false, v16PloPolarFlat: false })).toEqual(
      scenario('plo4', { v16PloPolar: false })
    );
  });

  it('plo5: the AAxx discount and the margin flat each move decisions, differently', () => {
    const def = scenario('plo5', {});
    const aaOff = scenario('plo5', { v16PloPolarAA3Bet: false });
    const flatOff = scenario('plo5', { v16PloPolarFlat: false });
    expect(aaOff).not.toEqual(def);
    expect(flatOff).not.toEqual(def);
    expect(aaOff).not.toEqual(flatOff);
    expect(scenario('plo5', { v16PloPolarAA3Bet: false, v16PloPolarFlat: false })).toEqual(
      scenario('plo5', { v16PloPolar: false })
    );
  });

  it('short deck: thin value and draw credit each move decisions, differently, and the master off is both off', () => {
    const def = scenario('short_deck', {});
    const thinOff = scenario('short_deck', { v23SdThinValue: false });
    const drawOff = scenario('short_deck', { v23SdDrawCredit: false });
    expect(thinOff).not.toEqual(def);
    expect(drawOff).not.toEqual(def);
    expect(thinOff).not.toEqual(drawOff);
    expect(scenario('short_deck', { v23SdThinValue: false, v23SdDrawCredit: false })).toEqual(
      scenario('short_deck', { v23Variants: false })
    );
  });

  it('the short-deck components never reach a plo8 decision, so plo8_v23_lowdraw still measures the low-only rule alone', () => {
    expect(scenario('plo8', { v23SdThinValue: false, v23SdDrawCredit: false })).toEqual(
      scenario('plo8', {})
    );
  });

  it('the polarity components never reach a short-deck decision', () => {
    expect(scenario('short_deck', { v16PloPolarAA3Bet: false, v16PloPolarFlat: false })).toEqual(
      scenario('short_deck', {})
    );
  });
});

describe('the league card', () => {
  it('carries one ablation per component that measures something, right after its parent', () => {
    const names = LEAGUE_MATCHUPS.map((m) => m.name);
    const byName = new Map(LEAGUE_MATCHUPS.map((m) => [m.name, m]));
    expect(byName.get('plo4_v16_polarity_flat')).toMatchObject({
      variant: 'plo4',
      a: {},
      b: { v16PloPolarFlat: false },
    });
    expect(byName.get('shortdeck_v23_thin_value')).toMatchObject({
      variant: 'short_deck',
      a: {},
      b: { v23SdThinValue: false },
    });
    expect(byName.get('shortdeck_v23_draw_credit')).toMatchObject({
      variant: 'short_deck',
      a: {},
      b: { v23SdDrawCredit: false },
    });
    expect(names.indexOf('plo4_v16_polarity_flat')).toBe(names.indexOf('plo4_v16_polarity') + 1);
    expect(names.indexOf('shortdeck_v23_thin_value')).toBe(names.indexOf('shortdeck_v23') + 1);
    expect(names.indexOf('shortdeck_v23_draw_credit')).toBe(names.indexOf('shortdeck_v23') + 2);
    // The parents are unchanged, so their history stays comparable.
    expect(byName.get('plo4_v16_polarity')?.b).toEqual({ v16PloPolar: false });
    expect(byName.get('shortdeck_v23')?.b).toEqual({ v23Variants: false });
    expect(byName.get('plo8_v23_lowdraw')?.b).toEqual({ v23Variants: false });
    // The AAxx discount has no matchup: at 1,000 pairs it diverged in 1 pair
    // at seed 4242 and 0 at seed 20260921, and an inert matchup is never
    // added to the card.
    expect(
      LEAGUE_MATCHUPS.some((m) => 'v16PloPolarAA3Bet' in m.a || 'v16PloPolarAA3Bet' in m.b)
    ).toBe(false);
  });
});
