/**
 * V61 (2026-10-29): a hold'em one-pair river call is a bluff-catch, and the
 * range read it was priced against was too bluff-heavy. Measured over 14 days
 * of NLH review stack-offs (cash and tournament): one-pair and board-paired
 * two-pair river calls won 17-18% under a quarter pot, 21-22% at a quarter to
 * a half and 14% at a half to a full pot, against the 20/29/40% the price
 * demands. The shade lowers the equity handed to the V38 MDF verdict by
 * 6-12 points with the price, only when the bettor does not read as an
 * over-bluffer, only in single-board hold'em, and never for a made hand
 * above the bluff-catch class.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as EvEngine from './HorseEvEngine.js';
import {
  HorseLogic,
  v61RiverOnePairShade,
  V61_RIVER_SHADE_SHAPE,
  V63_RIVER_SHADE_SHAPE,
} from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

function river(variant: string, hole: string, board: string, bet: number, mode = 'cash', base = 20) {
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: 400,
      bet: 0,
      totalInvested: 10,
      cards: cards(hole),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'villain',
      username: 'v',
      stack: 400 - bet,
      bet,
      totalInvested: 10 + bet,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  const history: Array<Record<string, unknown>> = [
    { stage: 'preflop', seat: 2, userId: 'villain', action: 'raise', amount: 6, timestamp: 1 },
    { stage: 'preflop', seat: 1, userId: 'hero', action: 'call', amount: 4, timestamp: 2 },
  ];
  for (const st of ['flop', 'turn']) {
    history.push({ stage: st, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 });
    history.push({ stage: st, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 4 });
  }
  history.push({ stage: 'river', seat: 2, userId: 'villain', action: 'bet', amount: bet, timestamp: 5 });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(board),
      pot: base + bet,
      currentBet: bet,
      minRaise: Math.max(2, bet),
      stage: 'river',
      gameVariant: variant,
      gameMode: mode,
      bigBlind: 2,
      dealerSeat: 1,
      actionHistory: history,
    },
  };
}

/** The equity the V38 river verdict was handed, with the given options. */
function verdictEquity(s: ReturnType<typeof river>, opts: Record<string, unknown>) {
  const spy = vi.spyOn(EvEngine, 'riverCallVerdict');
  try {
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      mind: false,
      ...opts,
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0].equity;
  } finally {
    spy.mockRestore();
  }
}

describe('V61: a hold em one-pair river call is shaded against the price', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed61);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  it('second pair facing a pot-sized river bet is priced 12 points below the unshaded read with the V61 shape', () => {
    // toCall 20 into a pot of 40 after the bet: r = 0.5, the V61 cap
    const on = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), { v63LargeRiverBetShade: false });
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    seedFastRandom(0x5eed61);
    const off = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), {
      v61RiverOnePairShade: false,
    });
    expect(fires()['v61_river_one_pair_shade']).toBeUndefined();
    expect(off - on).toBeCloseTo(0.12, 2);
  });

  it('applies in tournaments too, and to ace high and to two pair that shares the board pair', () => {
    verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20, 'tournament'), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    verdictEquity(river('nlh', 'AhKh', 'Qh9d3s7c2c', 20), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    verdictEquity(river('nlh', '7s4d', 'Qh9d3s9c7c', 20), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
  });

  it('a set, two pair of hero own cards, and Omaha keep the unshaded read', () => {
    const decide = (variant: string, hole: string, board: string) => {
      HorseLogic.decide(river(variant, hole, board, 20).hero, river(variant, hole, board, 20).gs as never, 'balanced', {}, {
        telemetry: true,
        mind: false,
      } as never);
      return fires()['v61_river_one_pair_shade'];
    };
    expect(decide('nlh', '3h3d', 'Qh9d3s7c2c')).toBeUndefined();
    expect(decide('nlh', 'Qs9c', 'Qh9d3s7c2c')).toBeUndefined();
    expect(decide('plo4', '9s8d7h2s', 'Qh9d3s7c2c')).toBeUndefined();
  });
});

describe('V61 yields to the V62 polar bettor model', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed61);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  it('with opponent reads the river bettor is sampled polar and the price shade is not stacked', () => {
    const s = river('nlh', '9s8d', 'Qh9d3s7c2c', 20);
    // V62 is opt-in since 2026-10-30 18:50 UTC; armed here to pin the yield.
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      v62RiverBettorPolarity: true,
    } as never);
    const f = fires();
    expect(f['v62_river_bettor_polarity']).toBe(1);
    expect(f['v61_river_one_pair_shade']).toBeUndefined();
    // the shade still carries the no-read path (V62 cannot engage without reads)
    seedFastRandom(0x5eed61);
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false } as never);
    const g = fires();
    expect(g['v62_river_bettor_polarity']).toBeUndefined();
    expect(g['v61_river_one_pair_shade']).toBe(1);
    // and fires by default with reads present (V62 unset = off)
    seedFastRandom(0x5eed61);
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true } as never);
    const h = fires();
    expect(h['v61_river_one_pair_shade']).toBe(1);
  });
});

describe('V61 shade shape', () => {
  it('is zero at a quarter-pot wager (r = 0.2) and twelve points from a pot-sized wager (r = 0.5)', () => {
    expect(v61RiverOnePairShade(10, 100, V61_RIVER_SHADE_SHAPE)).toBe(0);
    expect(v61RiverOnePairShade(20, 100, V61_RIVER_SHADE_SHAPE)).toBe(0);
    expect(v61RiverOnePairShade(35, 100, V61_RIVER_SHADE_SHAPE)).toBeCloseTo(0.06, 6);
    expect(v61RiverOnePairShade(50, 100, V61_RIVER_SHADE_SHAPE)).toBeCloseTo(0.12, 6);
    expect(v61RiverOnePairShade(500, 600, V61_RIVER_SHADE_SHAPE)).toBeCloseTo(0.12, 6);
    expect(v61RiverOnePairShade(0, 100, V61_RIVER_SHADE_SHAPE)).toBe(0);
  });
});

describe('V63: the shade steepens past a half-pot wager and caps at twenty points', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed63);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  // The price r is toCall / (pot after the wager): a 0.4-pot wager is
  // r = 0.286, a half-pot wager r = 0.333, 0.7-pot r = 0.41, pot-sized
  // r = 0.5, a 2x overbet r = 0.67.
  const v63 = (toCall: number, pot: number) => v61RiverOnePairShade(toCall, pot, V63_RIVER_SHADE_SHAPE);
  const v61 = (toCall: number, pot: number) => v61RiverOnePairShade(toCall, pot, V61_RIVER_SHADE_SHAPE);

  it('shape: V61 up to a half-pot wager, then 12 points at 0.7 pot and 20 from a pot-sized wager', () => {
    expect(V63_RIVER_SHADE_SHAPE).toEqual({ slope: 0.4, cap: 0.2, kneeR: 1 / 3, kneeSlope: 0.88 });
    expect(V61_RIVER_SHADE_SHAPE).toEqual({ slope: 0.4, cap: 0.12 });
    // up to the knee the two shapes agree
    for (const [toCall, pot] of [[10, 100], [25, 125], [40, 140], [50, 150]] as const) {
      expect(v63(toCall, pot)).toBeCloseTo(v61(toCall, pot), 9);
    }
    expect(v63(50, 150)).toBeCloseTo(0.0533, 3);
    // past it V63 steepens: 0.7 pot 12 points, pot-sized 20, overbets 20
    expect(v63(70, 170)).toBeCloseTo(0.12, 2);
    expect(v61(70, 170)).toBeCloseTo(0.0847, 3);
    expect(v63(100, 200)).toBeCloseTo(0.2, 6);
    expect(v61(100, 200)).toBeCloseTo(0.12, 6);
    expect(v63(200, 300)).toBeCloseTo(0.2, 6);
    expect(v63(500, 600)).toBeCloseTo(0.2, 6);
    // continuous at the knee
    expect(v63(1 / 3 + 1e-9, 1)).toBeCloseTo(v63(1 / 3 - 1e-9, 1), 6);
    // the bare function keeps the V61 shape; the decide options select V63's
    expect(v61RiverOnePairShade(100, 200)).toBeCloseTo(0.12, 6);
    expect(v61RiverOnePairShade(0, 100)).toBe(0);
  });

  it('a short stack calling a covering jam reads as a small price and keeps the V61 shade', () => {
    // 50 behind, pot 100 before a 500 jam: contestable pot 150, r = 1/3
    expect(v63(50, 150)).toBeCloseTo(v61(50, 150), 9);
  });

  it('third pair facing a 0.7-pot wager is priced 12 points below the unshaded read by default, 8 with V63 off', () => {
    // bet 28 into 40: toCall 28, pot after the wager 68 -> r = 0.41. Third
    // pair: second pair raises this wager in the fixture and never reaches
    // the call verdict.
    const spot = () => river('nlh', '7s6d', 'Qh9d3s7c2c', 28, 'cash', 40);
    const on = verdictEquity(spot(), {});
    let f = fires();
    expect(f['v61_river_one_pair_shade']).toBe(1);
    expect(f['v63_large_river_bet_shade']).toBe(1);
    seedFastRandom(0x5eed63);
    const v61only = verdictEquity(spot(), { v63LargeRiverBetShade: false });
    f = fires();
    expect(f['v61_river_one_pair_shade']).toBe(1);
    expect(f['v63_large_river_bet_shade']).toBeUndefined();
    seedFastRandom(0x5eed63);
    const off = verdictEquity(spot(), { v61RiverOnePairShade: false });
    f = fires();
    expect(f['v61_river_one_pair_shade']).toBeUndefined();
    expect(f['v63_large_river_bet_shade']).toBeUndefined();
    expect(off - on).toBeCloseTo(v63(28, 68), 3);
    expect(off - v61only).toBeCloseTo(v61(28, 68), 3);
    expect(off - on).toBeGreaterThan(0.11);
  });

  it('a pot-sized wager is priced 20 points below the unshaded read, and a quarter-pot wager is not shaded at all', () => {
    const on = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), {});
    expect(fires()['v63_large_river_bet_shade']).toBe(1);
    seedFastRandom(0x5eed63);
    const off = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), { v61RiverOnePairShade: false });
    expect(off - on).toBeCloseTo(0.2, 2);
    // bet 20 into 80: r = 0.2, the start of the slope; the verdict is reached
    // and nothing is shaded
    seedFastRandom(0x5eed63);
    const quarter = verdictEquity(river('nlh', '7s6d', 'Qh9d3s7c2c', 20, 'cash', 80), {});
    const f = fires();
    expect(f['v61_river_one_pair_shade']).toBeUndefined();
    expect(f['v63_large_river_bet_shade']).toBeUndefined();
    seedFastRandom(0x5eed63);
    const quarterOff = verdictEquity(river('nlh', '7s6d', 'Qh9d3s7c2c', 20, 'cash', 80), { v61RiverOnePairShade: false });
    expect(quarter).toBeCloseTo(quarterOff, 9);
  });

  it('V63 lives inside the V61 gates: a set facing a pot-sized wager is not shaded', () => {
    const s = river('nlh', '3h3d', 'Qh9d3s7c2c', 20);
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, mind: false } as never);
    const f = fires();
    expect(f['v61_river_one_pair_shade']).toBeUndefined();
    expect(f['v63_large_river_bet_shade']).toBeUndefined();
  });
});

describe('V61 also prices the committed river call after hero bet and was raised', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed62);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  function raisedRiver(hole: string, board: string, opts: Record<string, unknown>) {
    const s = river('nlh', hole, board, 0);
    // hero bet 20 on the river, villain raised to 60; hero has 80 behind
    const hero = { ...s.hero, bet: 20, stack: 80, totalInvested: 30 };
    const villain = { ...s.gs.players[1], bet: 60, stack: 340, totalInvested: 70 };
    const history = s.gs.actionHistory.filter((a) => a.stage !== 'river');
    history.push({ stage: 'river', seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 5 });
    history.push({ stage: 'river', seat: 1, userId: 'hero', action: 'bet', amount: 20, timestamp: 6 });
    history.push({ stage: 'river', seat: 2, userId: 'villain', action: 'raise', amount: 60, timestamp: 7 });
    const gs = { ...s.gs, players: [hero, villain], pot: 100, currentBet: 60, minRaise: 40, actionHistory: history };
    const d = HorseLogic.decide(hero, gs as never, 'balanced', {}, { telemetry: true, mind: false, ...opts } as never);
    return { action: d.action, fired: fires()['v61_river_one_pair_shade'] };
  }

  it('top pair facing a river raise is shaded and no longer committed by the raw read', () => {
    const on = raisedRiver('QsKd', 'Qh9d3s7c2c', {});
    expect(on.fired).toBe(1);
    const off = raisedRiver('QsKd', 'Qh9d3s7c2c', { v61RiverOnePairShade: false });
    expect(off.fired).toBeUndefined();
    expect(['call', 'fold', 'all_in']).toContain(on.action);
    expect(['call', 'fold', 'all_in']).toContain(off.action);
  });

  it('a set facing the raise is not shaded', () => {
    expect(raisedRiver('3h3d', 'Qh9d3s7c2c', {}).fired).toBeUndefined();
  });
});
