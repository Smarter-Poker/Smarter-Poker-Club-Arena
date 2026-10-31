/**
 * V67 (2026-10-31): a hold'em one-pair hand that BET the river and was
 * RAISED is a bluff-catcher facing the most value-heavy action in the game.
 * Measured over 7 days of NLH review hands (12% sample, |net| >= 20bb):
 * after a one-pair river bet was raised, the horse folded 1.4-17% and its
 * calls or jams won 11.9% in cash (n=226, about -129,000bb a week) and 19.2%
 * in tournaments (n=125, about -47,000bb) at an average raise of 0.72 pot;
 * calls of a raise under 0.7 pot won 0-5% (cash n=90).
 *
 * V67: the call carries the V63 river shape plus a raise-specific ten
 * points (capped at 25), is not withheld for a V62 polar read, and the class
 * calls or folds at that price without the 0.42 floor or a jam. Two pair of
 * hero's own cards and better, the flop and turn, and Omaha keep their
 * paths; a near-all-in getting a tiny price still calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HorseLogic,
  v67RiverBetRaisedShade,
  v61RiverOnePairShade,
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

type Fixture = {
  variant?: string;
  hole: string;
  board: string;
  street?: 'flop' | 'turn' | 'river';
  mode?: string;
  /** chips each player started the hand with (bb = 2) */
  stackChips?: number;
  /** hero's wager this street, and villain's raise-to */
  heroBet?: number;
  raiseTo?: number;
};

/**
 * The `raisedRiver` shape of HorseRiverOnePairShade.test.ts, parameterised:
 * hero opened preflop, villain called (pot 12), both checked every street
 * before the decision street; on it villain checked, hero bet 2/3 pot (8)
 * and villain raised 3x (to 24): toCall 16 into a pot of 44.
 */
function raisedRiver(f: Fixture) {
  const street = f.street ?? 'river';
  const stackChips = f.stackChips ?? 200;
  const heroBet = f.heroBet ?? 8;
  const raiseTo = f.raiseTo ?? 24;
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: stackChips - 6 - heroBet,
      bet: heroBet,
      totalInvested: 6 + heroBet,
      cards: cards(f.hole),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'villain',
      username: 'v',
      stack: stackChips - 6 - raiseTo,
      bet: raiseTo,
      totalInvested: 6 + raiseTo,
      cards: [],
      is_folded: false,
      is_all_in: stackChips - 6 - raiseTo <= 0,
      is_sitting_out: false,
    },
  ];
  const history: Array<Record<string, unknown>> = [
    { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: 1 },
    { stage: 'preflop', seat: 2, userId: 'villain', action: 'call', amount: 4, timestamp: 2 },
  ];
  for (const st of ['flop', 'turn', 'river'] as const) {
    if (st === street) break;
    history.push({ stage: st, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 3 });
    history.push({ stage: st, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 4 });
  }
  history.push({ stage: street, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 5 });
  history.push({ stage: street, seat: 1, userId: 'hero', action: 'bet', amount: heroBet, timestamp: 6 });
  history.push({ stage: street, seat: 2, userId: 'villain', action: 'raise', amount: raiseTo, timestamp: 7 });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(f.board),
      pot: 12 + heroBet + raiseTo,
      currentBet: raiseTo,
      minRaise: raiseTo - heroBet,
      stage: street,
      gameVariant: f.variant ?? 'nlh',
      gameMode: f.mode ?? 'cash',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: history,
    },
  };
}

type Freq = { call: number; fold: number; raise: number; fired: number; n: number };

function frequencies(f: Fixture, opts: Record<string, unknown>, seeds = 40): Freq {
  const out: Freq = { call: 0, fold: 0, raise: 0, fired: 0, n: seeds };
  for (let i = 0; i < seeds; i++) {
    seedFastRandom(0x67000 + i);
    HorseMind.reset();
    drainFires();
    const s = raisedRiver(f);
    const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      ...opts,
    } as never);
    if (d.action === 'call') out.call++;
    else if (d.action === 'fold') out.fold++;
    else out.raise++;
    if (fires()['v67_river_bet_raised_one_pair']) out.fired++;
  }
  return out;
}

const show = (name: string, on: Freq, off: Freq) =>
  `${name}: V67 on call=${on.call}/${on.n} fold=${on.fold} raise/jam=${on.raise} fired=${on.fired}; ` +
  `V67 off call=${off.call}/${off.n} fold=${off.fold} raise/jam=${off.raise} fired=${off.fired}`;

const OFF = { v67RiverBetRaisedOnePair: false };
const BOARD = 'Qh7d2s4c9h';

describe('V67: a hold em one pair that bet the river and was raised is priced against the raise', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed67);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  it('top pair facing a 3x raise calls measurably less with V67 on than off', () => {
    const on = frequencies({ hole: 'AsQd', board: BOARD }, {});
    const off = frequencies({ hole: 'AsQd', board: BOARD }, OFF);
    const msg = show('river TPTK AsQd vs 3x, 100bb', on, off);
    console.log(msg);
    expect(on.fired, msg).toBe(on.n);
    expect(off.fired, msg).toBe(0);
    expect(on.call, msg).toBeLessThan(off.call);
    expect(on.raise, msg).toBe(0);
  });

  it('top pair facing a 3x raise in the committed branch (short stack) calls less too', () => {
    const f = { hole: 'KsQd', board: BOARD, stackChips: 60 };
    const on = frequencies(f, {});
    const off = frequencies(f, OFF);
    const msg = show('river TP KsQd vs 3x, 30bb committed', on, off);
    console.log(msg);
    expect(on.fired, msg).toBe(on.n);
    expect(on.call, msg).toBeLessThan(off.call);
    expect(on.raise, msg).toBe(0);
  });

  it('a second pair folds most of the time with V67 on', () => {
    const on = frequencies({ hole: 'Ts9d', board: BOARD }, {});
    const off = frequencies({ hole: 'Ts9d', board: BOARD }, OFF);
    const msg = show('river second pair Ts9d vs 3x', on, off);
    console.log(msg);
    expect(on.fold, msg).toBeGreaterThan(on.n / 2);
    expect(on.call, msg).toBeLessThanOrEqual(off.call);
  });

  it('applies in tournaments too', () => {
    const f = { hole: 'AsQd', board: BOARD, mode: 'tournament' };
    const on = frequencies(f, {});
    const off = frequencies(f, OFF);
    const msg = show('river TPTK tournament', on, off);
    console.log(msg);
    expect(on.fired, msg).toBe(on.n);
    expect(on.call, msg).toBeLessThanOrEqual(off.call);
  });

  it('a near-all-in getting a tiny price still calls', () => {
    // hero bet 100 into 12 with 6 behind, villain shoved to 106: toCall 6 into 218
    const f = { hole: 'KsQd', board: BOARD, stackChips: 112, heroBet: 100, raiseTo: 106 };
    const on = frequencies(f, {});
    const off = frequencies(f, OFF);
    const msg = show('river TP near-all-in, toCall 6 into 218', on, off);
    console.log(msg);
    // the call is the whole stack, so it is sent as all_in; it never folds
    expect(on.fold, msg).toBe(0);
    expect(on.call + on.raise, msg).toBe(on.n);
    expect(on, msg).toEqual({ ...off, fired: on.n });
  });

  it('two pair of hero own cards and a set are unchanged', () => {
    for (const hole of ['Qs9c', '7s7c']) {
      const on = frequencies({ hole, board: BOARD }, {});
      const off = frequencies({ hole, board: BOARD }, OFF);
      const msg = show(`river ${hole} on ${BOARD}`, on, off);
      expect(on.fired, msg).toBe(0);
      expect(on, msg).toEqual(off);
    }
  });

  it('the flop and turn are unchanged', () => {
    for (const [street, board] of [
      ['flop', 'Qh7d2s'],
      ['turn', 'Qh7d2s4c'],
    ] as const) {
      const on = frequencies({ hole: 'AsQd', board, street }, {});
      const off = frequencies({ hole: 'AsQd', board, street }, OFF);
      const msg = show(`${street} TPTK`, on, off);
      expect(on.fired, msg).toBe(0);
      expect(on, msg).toEqual(off);
    }
  });

  it('Omaha is unchanged', () => {
    const plo = { variant: 'plo4', hole: 'AsQdJc3h', board: BOARD };
    const on = frequencies(plo, {});
    const off = frequencies(plo, OFF);
    const msg = show('plo4 river', on, off);
    expect(on.fired, msg).toBe(0);
    expect(on, msg).toEqual(off);
  });

  it('the off arm reproduces today (no receipt, the V63 shade only)', () => {
    const off = frequencies({ hole: 'AsQd', board: BOARD }, OFF);
    const offAgain = frequencies({ hole: 'AsQd', board: BOARD }, OFF);
    expect(off.fired).toBe(0);
    expect(off).toEqual(offAgain);
  });
});

describe('V67 shade shape', () => {
  it('is the V63 shape plus ten points, capped at 25', () => {
    expect(v67RiverBetRaisedShade(0, 100)).toBe(0);
    expect(v67RiverBetRaisedShade(10, 100)).toBeCloseTo(0.1, 9);
    const r36 = v61RiverOnePairShade(16, 44, V63_RIVER_SHADE_SHAPE);
    expect(v67RiverBetRaisedShade(16, 44)).toBeCloseTo(r36 + 0.1, 9);
    expect(v67RiverBetRaisedShade(50, 100)).toBeCloseTo(0.25, 9);
    expect(v67RiverBetRaisedShade(90, 100)).toBeCloseTo(0.25, 9);
    expect(v67RiverBetRaisedShade(16, 44, V63_RIVER_SHADE_SHAPE, 0.05)).toBeCloseTo(r36 + 0.05, 9);
  });
});
