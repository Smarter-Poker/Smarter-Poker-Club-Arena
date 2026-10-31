/**
 * V65 (2026-10-31): a hold'em one-pair TURN call of a wager hero did not
 * initiate is a bluff-catch priced against the same bluff-heavy range read
 * V61 corrected on the river. Measured over 7 days of NLH review hands (12%
 * sample, |net| >= 20bb): turn one-pair calls facing a bet were cash n=1,727
 * won 33% (about -308,000bb a week) and tournament n=1,542 won 37% (about
 * -185,000bb a week); by wager size (cash, top pair) 50% won under 0.4 pot,
 * 44% at 0.4-0.7, 29% at 0.7-1.05 and 23% from 1.05 up, against the
 * ~29/41/50% the price demands. The heuristic call line charged a pot-sized
 * barrel two points of sizing penalty (`min(0.06, betRatio * 0.04)` at
 * betRatio 0.5). The shade comes off the equity handed to the call test,
 * zero at a quarter-pot wager and 12 points from a pot-sized one, only for
 * a made one-pair hand with no draw, only when the bettor does not read as
 * an over-bluffer, only in single-board hold'em, and never after hero's own
 * wager was raised (the committed branch owns that line).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HorseLogic,
  holdemDrawPresent,
  v65TurnOnePairShade,
  V65_TURN_SHADE_CAP,
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
const VILLAIN = '10000000-0000-4000-8000-000000000065';
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

/**
 * Villain raised preflop, hero called; villain c-bet the flop, hero called;
 * villain bets `bet` into a 36-chip turn pot (so `bet` 36 is a pot-sized
 * wager, r = 0.5; 9 is a quarter-pot wager, r = 0.2). `street` 'river'
 * builds the same line one street later, for the V61 boundary.
 */
function turn(
  variant: string,
  hole: string,
  board: string,
  bet: number,
  mode = 'cash',
  street: 'turn' | 'river' = 'turn',
  oop = false
) {
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: 400,
      bet: 0,
      totalInvested: 18,
      cards: cards(hole),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: VILLAIN,
      username: 'v',
      stack: 400 - bet,
      bet,
      totalInvested: 18 + bet,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  const history: Array<Record<string, unknown>> = [
    { stage: 'preflop', seat: 2, userId: VILLAIN, action: 'raise', amount: 6, timestamp: 1 },
    { stage: 'preflop', seat: 1, userId: 'hero', action: 'call', amount: 4, timestamp: 2 },
    { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 },
    { stage: 'flop', seat: 2, userId: VILLAIN, action: 'bet', amount: 8, timestamp: 4 },
    { stage: 'flop', seat: 1, userId: 'hero', action: 'call', amount: 8, timestamp: 5 },
  ];
  if (street === 'river') {
    history.push({
      stage: 'turn',
      seat: 1,
      userId: 'hero',
      action: 'check',
      amount: 0,
      timestamp: 6,
    });
    history.push({
      stage: 'turn',
      seat: 2,
      userId: VILLAIN,
      action: 'check',
      amount: 0,
      timestamp: 7,
    });
  }
  history.push({
    stage: street,
    seat: 1,
    userId: 'hero',
    action: 'check',
    amount: 0,
    timestamp: 8,
  });
  history.push({
    stage: street,
    seat: 2,
    userId: VILLAIN,
    action: 'bet',
    amount: bet,
    timestamp: 9,
  });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(board),
      pot: 36 + bet,
      currentBet: bet,
      minRaise: Math.max(2, bet),
      stage: street,
      gameVariant: variant,
      gameMode: mode,
      bigBlind: 2,
      dealerSeat: oop ? 2 : 1,
      actionHistory: history,
    },
  };
}

function decideMany(s: ReturnType<typeof turn>, opts: Record<string, unknown>, seeds = 20) {
  const acts: Record<string, number> = {};
  let fired = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    seedFastRandom(seed * 7919);
    HorseMind.reset();
    drainFires();
    const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      ...opts,
    } as never);
    acts[d.action] = (acts[d.action] ?? 0) + 1;
    if (fires()['v65_turn_one_pair_shade']) fired++;
  }
  return { acts, fired };
}

describe('V65 shade shape', () => {
  it('is zero at a quarter-pot wager and twelve points from a pot-sized one', () => {
    // r = toCall / (pot after the wager)
    expect(v65TurnOnePairShade(20, 100)).toBe(0); // r 0.2: a quarter-pot wager
    expect(v65TurnOnePairShade(10, 100)).toBe(0);
    expect(v65TurnOnePairShade(29, 100)).toBeCloseTo(0.036, 6); // a 0.4-pot wager
    expect(v65TurnOnePairShade(41, 100)).toBeCloseTo(0.084, 6); // a 0.7-pot wager
    expect(v65TurnOnePairShade(50, 100)).toBeCloseTo(0.12, 6); // a pot-sized wager
    expect(v65TurnOnePairShade(67, 100)).toBeCloseTo(0.12, 6); // a 2x overbet, capped
    expect(v65TurnOnePairShade(500, 600)).toBeCloseTo(0.12, 6);
    expect(v65TurnOnePairShade(0, 100)).toBe(0);
    expect(v65TurnOnePairShade(50, 0)).toBe(0);
    expect(V65_TURN_SHADE_CAP).toBe(0.12);
  });
  it('honours a smaller cap (the 0.08 fallback cut)', () => {
    expect(v65TurnOnePairShade(50, 100, 0.08)).toBeCloseTo(0.08, 6);
    expect(v65TurnOnePairShade(35, 100, 0.08)).toBeCloseTo(0.06, 6);
    expect(v65TurnOnePairShade(50, 100, 0)).toBe(0);
  });
});

describe('the shared hold em draw read', () => {
  it('sees four to a suit and four ranks inside a five-rank window, hole and board together', () => {
    expect(holdemDrawPresent(cards('AhJh'), cards('Kh9h3s7c'))).toBe(true); // flush draw
    expect(holdemDrawPresent(cards('JsTd'), cards('Qh9d3s7c'))).toBe(true); // open-ender
    expect(holdemDrawPresent(cards('JsTd'), cards('Kh9d3s7c'))).toBe(true); // gutshot (9 T J K)
    expect(holdemDrawPresent(cards('5s4d'), cards('Ah2d9s7c'))).toBe(true); // wheel draw
    expect(holdemDrawPresent(cards('QsJd'), cards('KhQd3s7c'))).toBe(false);
    expect(holdemDrawPresent(cards('Ks5d'), cards('Kh9d3s7c'))).toBe(false);
    expect(holdemDrawPresent(cards('3h3d'), cards('Kh9d3s7c'))).toBe(false);
  });
});

describe('V65 gates: where the turn shade fires and where it does not', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed65);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });
  afterEach(() => {
    HorseMind.reset();
    drainFires();
  });
  const fired = (s: ReturnType<typeof turn>, opts: Record<string, unknown> = {}) => {
    seedFastRandom(0x5eed65);
    HorseMind.reset();
    drainFires();
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true, ...opts } as never);
    return fires()['v65_turn_one_pair_shade'];
  };

  it('fires for one pair facing a pot-sized turn barrel, in cash and in a tournament, and not with V65 off', () => {
    expect(fired(turn('nlh', 'Ks5d', 'Kh9d3s7c', 36))).toBe(1);
    expect(fired(turn('nlh', 'Ks5d', 'Kh9d3s7c', 36, 'tournament'))).toBe(1);
    expect(fired(turn('nlh', 'QsJd', 'KhQd3s7c', 36))).toBe(1);
    expect(fired(turn('nlh', 'JsJd', 'Qh9d3s7c', 36))).toBe(1);
    expect(fired(turn('nlh', 'Ks7d', 'Kh9d3s9c', 36))).toBe(1); // two pair through the board pair
    expect(fired(turn('nlh', 'AhQd', 'Kh9d3s7c', 36))).toBe(1); // ace high, the bluff-catch class
    expect(
      fired(turn('nlh', 'Ks5d', 'Kh9d3s7c', 36), { v65TurnOnePairShade: false })
    ).toBeUndefined();
  });

  it('a quarter-pot turn bet is unshaded (zero shade, no receipt)', () => {
    expect(fired(turn('nlh', 'Ks5d', 'Kh9d3s7c', 9))).toBeUndefined();
  });

  it('a set, two pair of hero own cards, a flush draw and a straight draw keep the unshaded read', () => {
    expect(fired(turn('nlh', '3h3d', 'Kh9d3s7c', 36))).toBeUndefined(); // a set
    expect(fired(turn('nlh', 'Ks9c', 'Kh9d3s7c', 36))).toBeUndefined(); // two pair, hero's own
    expect(fired(turn('nlh', 'AhJh', 'Kh9h3s7c', 36))).toBeUndefined(); // ace high with a flush draw
    expect(fired(turn('nlh', 'KhJh', 'Kd9h3h7c', 36))).toBeUndefined(); // top pair with a flush draw
    expect(fired(turn('nlh', 'JsTd', 'Kh9d3s7c', 36))).toBeUndefined(); // a gutshot
  });

  it('Omaha keeps its own pricing', () => {
    expect(fired(turn('plo4', 'KsQd7h2s', 'Kh9d3s4c', 36))).toBeUndefined();
  });

  it('the river keeps V61: the turn shade never fires there', () => {
    const s = turn('nlh', 'Ks5d', 'Kh9d3s7c2d', 36, 'cash', 'river');
    seedFastRandom(0x5eed65);
    HorseMind.reset();
    drainFires();
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true } as never);
    const f = fires();
    expect(f['v65_turn_one_pair_shade']).toBeUndefined();
    expect(f['v61_river_one_pair_shade']).toBe(1);
  });

  it('a measured over-bluffer (callDownMod above 1) is still called down unshaded', () => {
    // forty hands of villain hammering every flop: a postflop maniac read,
    // the same exploit gate V61 uses on the river
    const roster = turn('nlh', 'Ks5d', 'Kh9d3s7c', 36).gs.players;
    for (let h = 0; h < 40; h++) {
      const ts = 1700000000000 + h * 60000;
      HorseMind.observe(
        [
          { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: ts },
          {
            stage: 'preflop',
            seat: 2,
            userId: VILLAIN,
            action: 'call',
            amount: 6,
            timestamp: ts + 1,
          },
          { stage: 'flop', seat: 2, userId: VILLAIN, action: 'bet', amount: 12, timestamp: ts + 2 },
          { stage: 'flop', seat: 1, userId: 'hero', action: 'fold', amount: 0, timestamp: ts + 3 },
        ] as never,
        roster
      );
    }
    expect(HorseMind.exploit(VILLAIN).callDownMod).toBeGreaterThan(1);
    const s = turn('nlh', 'Ks5d', 'Kh9d3s7c', 36);
    seedFastRandom(0x5eed65);
    drainFires();
    const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
    } as never);
    expect(fires()['v65_turn_one_pair_shade']).toBeUndefined();
    expect(['call', 'raise', 'all_in']).toContain(d.action);
  });
});

describe('V65: the heuristic call line (no barrel read) folds a shaded second pair to a pot-sized barrel', () => {
  beforeEach(() => {
    enableBrainTelemetry();
    HorseMind.reset();
    drainFires();
  });
  afterEach(() => {
    HorseMind.reset();
    drainFires();
  });

  it('top pair, weak kicker, facing a pot-sized turn barrel out of position calls less with V65 on', () => {
    const s = turn('nlh', 'As4d', 'AhKdTs2c', 36, 'cash', 'turn', true);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(off.fired).toBe(0);
    expect(on.fired).toBe(20);
    expect(off.acts['call'] ?? 0).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThanOrEqual(16);
    expect(on.acts['fold'] ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('top pair facing a 1.5x-pot turn barrel folds most of the time with V65 on and never with it off', () => {
    const s = turn('nlh', 'As5d', 'AhKd9s2c', 54);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(off.acts['call'] ?? 0).toBe(20);
    expect(on.acts['fold'] ?? 0).toBeGreaterThanOrEqual(10);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('an under pair facing a pot-sized turn barrel folds with V65 on', () => {
    const s = turn('nlh', 'JsJd', 'Qh9d3s7c', 36);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(off.acts['call'] ?? 0).toBeGreaterThanOrEqual(15);
    expect(on.acts['fold'] ?? 0).toBe(20);
  });

  it('the 0.08 league cap still folds the under pair less often than the shipped cap', () => {
    const s = turn('nlh', 'JsJd', 'Qh9d3s7c', 36);
    const capped = decideMany(s, { v65TurnShadeCapOverride: 0.08 });
    const on = decideMany(s, {});
    expect(capped.fired).toBe(20);
    expect(capped.acts['fold'] ?? 0).toBeLessThanOrEqual(on.acts['fold'] ?? 0);
  });

  it('second pair with a good kicker calls a pot-sized turn barrel with V65 off and folds with it on', () => {
    const s = turn('nlh', 'QsJd', 'KhQd3s7c', 36);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(off.fired).toBe(0);
    expect(on.fired).toBe(20);
    expect(off.acts['call'] ?? 0).toBeGreaterThanOrEqual(15);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
    expect(on.acts['fold'] ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('the same hand facing a quarter-pot bet is unchanged', () => {
    const s = turn('nlh', 'QsJd', 'KhQd3s7c', 9);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(on.fired).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('and in a tournament', () => {
    const s = turn('nlh', 'QsJd', 'KhQd3s7c', 36, 'tournament');
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(on.fired).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('a set facing the same barrel is unchanged', () => {
    const s = turn('nlh', '3h3d', 'Kh9d3s7c', 36);
    const off = decideMany(s, { v65TurnOnePairShade: false });
    const on = decideMany(s, {});
    expect(on.fired).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('hero bet the turn and was raised: the committed branch owns it, the shade never fires', () => {
    const s = turn('nlh', 'QsJd', 'KhQd3s7c', 0);
    const hero = { ...s.hero, bet: 24, stack: 376, totalInvested: 42 };
    const villain = { ...s.gs.players[1], bet: 72, stack: 328, totalInvested: 90 };
    const history = s.gs.actionHistory.filter((a) => a.stage !== 'turn');
    history.push({
      stage: 'turn',
      seat: 2,
      userId: VILLAIN,
      action: 'check',
      amount: 0,
      timestamp: 8,
    });
    history.push({
      stage: 'turn',
      seat: 1,
      userId: 'hero',
      action: 'bet',
      amount: 24,
      timestamp: 9,
    });
    history.push({
      stage: 'turn',
      seat: 2,
      userId: VILLAIN,
      action: 'raise',
      amount: 72,
      timestamp: 10,
    });
    const gs = {
      ...s.gs,
      players: [hero, villain],
      pot: 36 + 24 + 72,
      currentBet: 72,
      minRaise: 48,
      actionHistory: history,
    };
    const r = decideMany({ hero, gs } as never, {});
    expect(r.fired).toBe(0);
  });
});
