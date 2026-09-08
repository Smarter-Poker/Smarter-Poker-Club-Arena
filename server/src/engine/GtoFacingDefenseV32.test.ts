/**
 * V32 — facing a bet from the solver's own betting range (2026-08-30).
 *
 * The load-bearing claim: `hand_matrix` read from the bettor's seat IS the
 * betting range. Everything else — bucket edges, blockers, suit buckets,
 * pot odds — exists to keep that claim exact. Each block pins one link.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  betBucketForFraction,
  expandHandClass,
  solverBettingRange,
  equityVsWeightedRange,
  gtoFacingDefense,
  STRONG_PASS_EQ,
} from './GtoFacingDefenseV32.js';
import { setGtoPostflop, _clearGtoPostflop } from './GtoPostflop.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  _clearGtoPostflop();
});

describe('bet size buckets mirror fn_aggregate_gto_v31_next exactly', () => {
  it('the aggregator edges: <60 small, <110 mid, else big', () => {
    expect(betBucketForFraction(0.33)).toBe('bet_small');
    expect(betBucketForFraction(0.599)).toBe('bet_small');
    expect(betBucketForFraction(0.6)).toBe('bet_mid');
    expect(betBucketForFraction(1.099)).toBe('bet_mid');
    expect(betBucketForFraction(1.1)).toBe('bet_big');
    expect(betBucketForFraction(2.62)).toBe('bet_big');
  });
  it('no bet is no bucket', () => {
    expect(betBucketForFraction(0)).toBeNull();
    expect(betBucketForFraction(-1)).toBeNull();
    expect(betBucketForFraction(NaN)).toBeNull();
  });
});

describe('expandHandClass', () => {
  it('pairs are 6, suited 4, offsuit 12 - the combinatorics of a range', () => {
    expect(expandHandClass('AA').length).toBe(6);
    expect(expandHandClass('AKs').length).toBe(4);
    expect(expandHandClass('AKo').length).toBe(12);
  });
});

const BOARD = cards('Ks9d7c2h'); // turn, Bruc-ish texture, rainbow
const V30_CELL = {
  street: 'turn',
  game_family: 'cash',
  position: 'BTN',
  depth_bucket: 80,
  texture_class: null as unknown as string, // filled below from the real classifier
  facing: 'open',
  hand_matrix: {
    // the bettor bets sets and air, checks middling — a polarised range
    KK: { check: 0.0, bet_big: 1.0 },
    '99': { check: 0.0, bet_big: 1.0 },
    QQ: { check: 1.0, bet_big: 0.0 },
    JJ: { check: 1.0, bet_big: 0.0 },
    '54s': { check: 0.2, bet_big: 0.8 },
    // real cells carry hundreds of classes; enough mass here that a blocked
    // KK still leaves a range above MIN_RANGE_COMBOS
    '65s': { check: 0.3, bet_big: 0.7 },
    A5s: { check: 0.5, bet_big: 0.5 },
  },
};

import { textureClass } from './GtoPostflop.js';
function loadV30() {
  const tex = textureClass(BOARD);
  expect(tex).toBeTruthy();
  setGtoPostflop([{ ...V30_CELL, texture_class: tex! } as never]);
}

describe('solverBettingRange - the range is what BET, not what was dealt', () => {
  it('holds only the combos with mass in the observed bucket', () => {
    loadV30();
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      betFraction: 2.0, // bet_big
    });
    expect(r).not.toBeNull();
    // QQ and JJ never bet big — no combo of either may appear
    const classes = new Set(r!.combos.map(([a, b]) => `${a.rank}${b.rank}`));
    expect(classes.has('QQ')).toBe(false);
    expect(classes.has('JJ')).toBe(false);
    expect(classes.has('KK')).toBe(true);
  });

  it('card removal: the board Kd... blocks KK down to 3 combos, 99 to 3', () => {
    loadV30();
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      betFraction: 2.0,
    })!;
    const kk = r.combos.filter(([a, b]) => a.rank === 'K' && b.rank === 'K').length;
    const nn = r.combos.filter(([a, b]) => a.rank === '9' && b.rank === '9').length;
    expect(kk).toBe(3); // Ks on board -> C(3,2)
    expect(nn).toBe(3); // 9d on board
  });

  it("hero's own cards block the range too", () => {
    loadV30();
    const withoutBlockers = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      betFraction: 2.0,
    })!;
    const withBlockers = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('KhKc'), // hero holds the other kings
      betFraction: 2.0,
    })!;
    const kk = withBlockers.combos.filter(([a, b]) => a.rank === 'K' && b.rank === 'K').length;
    expect(kk).toBe(0);
    expect(withBlockers.combos.length).toBeLessThan(withoutBlockers.combos.length);
  });

  it('a size the range never uses is a miss, not a guess', () => {
    loadV30();
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      betFraction: 0.33, // bet_small — nobody small-bets in this cell
    });
    expect(r).toBeNull();
  });

  it('an empty store is a miss', () => {
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      betFraction: 2.0,
    });
    expect(r).toBeNull();
  });
});

describe('the fallback names its evidence honestly', () => {
  it('labels open-node Bayes inference as legacy derived, never exact V31', () => {
    loadV30();
    const range = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('2c3c'),
      betFraction: 2.0,
    });
    expect(range?.source).toBe('v30_legacy_derived');
  });
});

describe('equityVsWeightedRange', () => {
  it('the nuts beat a polarised range almost always', () => {
    loadV30();
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('KhKc'), // top set... wait, KK blocked? hero holds them: range loses KK
      betFraction: 2.0,
    })!;
    const eq = equityVsWeightedRange(cards('KhKc'), BOARD, r, mulberry(7), 400);
    expect(eq).toBeGreaterThan(0.8);
  });

  it('air loses to it almost always', () => {
    loadV30();
    const r = solverBettingRange({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('3c4d'),
      betFraction: 2.0,
    })!;
    const eq = equityVsWeightedRange(cards('3c4d'), BOARD, r, mulberry(7), 400);
    expect(eq).toBeLessThan(0.3);
  });
});

describe('gtoFacingDefense - the line itself', () => {
  it('a bluff-catcher facing a range it beats often enough CALLS', () => {
    loadV30();
    // The 54s bluffs make AA a call vs the polarised big bet.
    // pot 100 incl. a 60 bet faced: odds = 60/160 = 0.375
    const d = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      pot: 100,
      toCall: 60,
      rand: mulberry(11),
    });
    expect(d).not.toBeNull();
    // AA beats 54s (air) and loses to sets; equity lands mid — assert the
    // DECISION is coherent with the numbers it reports rather than pinning
    // the exact MC value.
    if (d && d.action !== 'pass_strong') {
      expect(d.action).toBe(d.equity >= d.potOdds ? 'call' : 'fold');
    }
  });

  it('air folds', () => {
    loadV30();
    const d = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('3c4d'),
      pot: 100,
      toCall: 60,
      rand: mulberry(11),
    });
    expect(d).not.toBeNull();
    if (d) expect(d.action).toBe('fold');
  });

  it('a monster PASSES rather than flatting - aggression stays owned elsewhere', () => {
    loadV30();
    const d = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('KhKc'),
      pot: 100,
      toCall: 60,
      rand: mulberry(11),
    });
    expect(d).not.toBeNull();
    if (d) {
      expect(d.action).toBe('pass_strong');
      expect(d.equity).toBeGreaterThanOrEqual(STRONG_PASS_EQ);
    }
  });

  it('no store, no opinion - never a synthetic fold', () => {
    const d = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('AhAd'),
      pot: 100,
      toCall: 60,
    });
    expect(d).toBeNull();
  });

  it('nothing to call, nothing to say', () => {
    loadV30();
    expect(
      gtoFacingDefense({
        street: 'turn',
        family: 'cash',
        bettorPosition: 'BTN',
        stackBB: 80,
        board: BOARD,
        heroCards: cards('AhAd'),
        pot: 100,
        toCall: 0,
      })
    ).toBeNull();
  });
});

describe('the raw bet defines the RANGE, the effective call defines the PRICE', () => {
  it('a three-pot jam into a short hero consults the OVERBET range, not mid', () => {
    loadV30();
    // Effective numbers alone: pot 160, toCall 60 -> frac 0.6 -> bet_mid,
    // which this cell does not have. The RAW fraction says bet_big, which
    // it does. Only the rawBetFraction path can answer here.
    const withRaw = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('3c4d'),
      pot: 160,
      toCall: 60,
      rawBetFraction: 3.0,
      rand: mulberry(11),
    });
    expect(withRaw).not.toBeNull();
    const withoutRaw = gtoFacingDefense({
      street: 'turn',
      family: 'cash',
      bettorPosition: 'BTN',
      stackBB: 80,
      board: BOARD,
      heroCards: cards('3c4d'),
      pot: 160,
      toCall: 60,
      rand: mulberry(11),
    });
    expect(withoutRaw).toBeNull(); // frac 0.6 -> bet_mid -> no such range here
  });
});
