/**
 * V68 (2026-10-31): a hold'em high-card (no pair) TURN call of a wager hero
 * did not initiate. Measured over 7 days of NLH review hands (12% sample,
 * |net| >= 20bb): cash n=494 won 29.6% (about -62,000bb a week, avg 0.72
 * pot, 16bb), tournament n=383 won 36.8% (about -25,000bb a week); air won
 * 19-20% at every size, draws 31-35% against 0.7 pot or more. Two changes,
 * both off the equity handed to the call test:
 *  (a) the 0.04 implied-odds bonus is withheld facing 0.7 pot or more when
 *      the effective stack behind after the call is under 1.5x the pot after
 *      it: there is nothing left to be paid on the river;
 *  (b) high card with no real draw that V65 left unshaded (a gutshot or a
 *      board-only shape reads as a draw to holdemDrawPresent) carries the
 *      V65 price shade, unless the bettor is a measured over-bluffer.
 * Real draws (a flush draw using a hole card, an open-ended or double-gutter
 * straight draw) keep their equity apart from (a). One pair is V65's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HorseLogic,
  v68NoRoomToBePaid,
  V68_IMPLIED_MIN_POT_FRAC,
  V68_IMPLIED_MIN_SPR,
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
const VILLAIN = '10000000-0000-4000-8000-000000000068';
const RECEIPT = 'v68_turn_air_draw_calls';
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

/**
 * Villain raised preflop, hero called; villain c-bet the flop, hero called;
 * villain bets `bet` into a 36-chip turn pot (36 is a pot-sized wager).
 * `villainBehind` is what villain keeps behind after the wager: 364 is deep
 * (3.4x the 108-chip pot after a pot-sized call), 60 is short (0.56x).
 * `street` 'flop' builds the same wager one street earlier.
 */
function turn(
  variant: string,
  hole: string,
  board: string,
  bet: number,
  opts: {
    villainBehind?: number;
    mode?: string;
    street?: 'flop' | 'turn' | 'river';
    oop?: boolean;
  } = {}
) {
  const { villainBehind = 400 - bet, mode = 'cash', street = 'turn', oop = false } = opts;
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
      stack: villainBehind,
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
  ];
  if (street !== 'flop') {
    history.push(
      { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 },
      { stage: 'flop', seat: 2, userId: VILLAIN, action: 'bet', amount: 8, timestamp: 4 },
      { stage: 'flop', seat: 1, userId: 'hero', action: 'call', amount: 8, timestamp: 5 }
    );
  }
  if (street === 'river') {
    history.push(
      { stage: 'turn', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 6 },
      { stage: 'turn', seat: 2, userId: VILLAIN, action: 'check', amount: 0, timestamp: 7 }
    );
  }
  history.push(
    { stage: street, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 8 },
    { stage: street, seat: 2, userId: VILLAIN, action: 'bet', amount: bet, timestamp: 9 }
  );
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
    if (fires()[RECEIPT]) fired++;
  }
  return { acts, fired };
}
const OFF = { v68TurnAirDrawCalls: false };

describe('V68 no room to be paid', () => {
  it('needs a wager of 0.7 pot or more and under 1.5x the pot behind after the call', () => {
    expect(V68_IMPLIED_MIN_POT_FRAC).toBe(0.7);
    expect(V68_IMPLIED_MIN_SPR).toBe(1.5);
    expect(v68NoRoomToBePaid(1, 60, 108)).toBe(true);
    expect(v68NoRoomToBePaid(0.7, 161, 108)).toBe(true);
    expect(v68NoRoomToBePaid(1, 162, 108)).toBe(false); // exactly 1.5x: room
    expect(v68NoRoomToBePaid(1, 364, 108)).toBe(false); // deep
    expect(v68NoRoomToBePaid(0.69, 60, 108)).toBe(false); // smaller wager
    expect(v68NoRoomToBePaid(1, -5, 108)).toBe(true); // nothing behind
    expect(v68NoRoomToBePaid(1, 60, 0)).toBe(false);
  });
});

describe('V68 decisions on the turn', () => {
  beforeEach(() => {
    enableBrainTelemetry();
    HorseMind.reset();
    drainFires();
  });
  afterEach(() => {
    HorseMind.reset();
    drainFires();
  });

  it('a nut flush draw facing a pot-sized bet with deep stacks calls at today s rate', () => {
    const s = turn('nlh', 'AhJh', 'Kh9h3s7c', 36);
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.fired).toBe(0);
    expect(on.acts).toEqual(off.acts);
    expect(on.acts['call'] ?? 0).toBe(20);
  });

  it('the same draw with a short stack behind loses its implied odds and calls less', () => {
    const s = turn('nlh', 'AhJh', 'Kh9h3s7c', 36, { villainBehind: 60, oop: true });
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(off.fired).toBe(0);
    expect(on.fired).toBe(20);
    expect(off.acts['call'] ?? 0).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('ace-high air (a gutshot V65 reads as a draw) facing a pot-sized bet calls less on than off', () => {
    const s = turn('nlh', 'AhQd', 'KhTd3s7c', 36);
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(off.fired).toBe(0);
    expect(on.fired).toBe(20);
    expect(off.acts['call'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('and in a tournament', () => {
    const s = turn('nlh', 'AhQd', 'KhTd3s7c', 36, { mode: 'tournament' });
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.fired).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('one pair is untouched (V65 owns it)', () => {
    const s = turn('nlh', 'Ks5d', 'Kh9d3s7c', 36, { villainBehind: 60 });
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.fired).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('the flop and the river are untouched', () => {
    const flop = turn('nlh', 'AhJh', 'Kh9h3s', 36, { villainBehind: 60, street: 'flop' });
    const fOff = decideMany(flop, OFF);
    const fOn = decideMany(flop, {});
    expect(fOn.fired).toBe(0);
    expect(fOn.acts).toEqual(fOff.acts);
    const river = turn('nlh', 'AhQd', 'KhTd3s7c2s', 36, { villainBehind: 60, street: 'river' });
    const rOff = decideMany(river, OFF);
    const rOn = decideMany(river, {});
    expect(rOn.fired).toBe(0);
    expect(rOn.acts).toEqual(rOff.acts);
  });

  it('Omaha is unchanged', () => {
    const s = turn('plo4', 'AhJhQd2c', 'Kh9h3s7c', 36, { villainBehind: 60 });
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.fired).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('the off arm reproduces today: no receipt on any fixture', () => {
    for (const s of [
      turn('nlh', 'AhJh', 'Kh9h3s7c', 36, { villainBehind: 60 }),
      turn('nlh', 'AhQd', 'KhTd3s7c', 36),
      turn('nlh', 'AhQd', 'KhTd3s7c', 22),
    ])
      expect(decideMany(s, OFF).fired).toBe(0);
  });

  it('a measured over-bluffer keeps the air call unshaded', () => {
    const roster = turn('nlh', 'AhQd', 'KhTd3s7c', 36).gs.players;
    const observe = () => {
      for (let h = 0; h < 40; h++) {
        const ts = 1700000000000 + h * 60000;
        HorseMind.observe(
          [
            {
              stage: 'preflop',
              seat: 1,
              userId: 'hero',
              action: 'raise',
              amount: 6,
              timestamp: ts,
            },
            {
              stage: 'preflop',
              seat: 2,
              userId: VILLAIN,
              action: 'call',
              amount: 6,
              timestamp: ts + 1,
            },
            {
              stage: 'flop',
              seat: 2,
              userId: VILLAIN,
              action: 'bet',
              amount: 12,
              timestamp: ts + 2,
            },
            {
              stage: 'flop',
              seat: 1,
              userId: 'hero',
              action: 'fold',
              amount: 0,
              timestamp: ts + 3,
            },
          ] as never,
          roster
        );
      }
    };
    HorseMind.reset();
    observe();
    expect(HorseMind.exploit(VILLAIN).callDownMod).toBeGreaterThan(1);
    const s = turn('nlh', 'AhQd', 'KhTd3s7c', 36);
    seedFastRandom(0x5eed68);
    drainFires();
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true } as never);
    // deep stacks: (a) does not apply, and (b) is withheld for the over-bluffer
    expect(fires()[RECEIPT]).toBeUndefined();
  });
});
