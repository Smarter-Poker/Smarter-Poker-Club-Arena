/**
 * V69 (2026-10-31): three hold'em single-board TURN call gaps found while
 * building V65 / V67 / V68, closed under one option (`v69TurnCallGaps`,
 * default on; explicit false is the previous behaviour for all three):
 *  (1) one pair still collected the 0.04 implied-odds bonus facing a big turn
 *      wager with no stack behind to pay it; V68's no-room-to-be-paid rule
 *      now applies to one pair too;
 *  (2) V65's draw exemption read a draw made by the board alone (four to a
 *      suit, or a four-rank window, with no hole card in it) as hero's draw;
 *      only a draw a hole card is part of exempts the hand now;
 *  (3) the opt-in V32 defend layer's draw pass-through guaranteed a turn
 *      call before the heuristic line ran, so V68's rule never reached it; a
 *      no-room spot now falls through to the normal line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HorseLogic, holdemDrawPresent, holdemHoleDrawPresent } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const VILLAIN = '10000000-0000-4000-8000-000000000069';
const RECEIPT = 'v69_turn_call_gaps';
const V65 = 'v65_turn_one_pair_shade';
const PASS = 'v34_defend_draw_passthrough';
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

/**
 * The V65 / V68 fixture: villain raised preflop, hero called; villain c-bet
 * the flop, hero called; villain bets `bet` into a 36-chip turn pot.
 * `villainBehind` is what villain keeps behind after the wager (default
 * deep); 60 behind a pot-sized wager is under 1.5x the 108-chip pot after
 * the call.
 */
function turn(
  variant: string,
  hole: string,
  board: string,
  bet: number,
  opts: {
    villainBehind?: number;
    street?: 'flop' | 'turn' | 'river';
    oop?: boolean;
  } = {}
) {
  const { villainBehind = 400 - bet, street = 'turn', oop = false } = opts;
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
      gameMode: 'cash',
      bigBlind: 2,
      dealerSeat: oop ? 2 : 1,
      actionHistory: history,
    },
  };
}

function decideMany(s: ReturnType<typeof turn>, opts: Record<string, unknown>, seeds = 20) {
  const acts: Record<string, number> = {};
  const seen: Record<string, number> = {};
  for (let seed = 1; seed <= seeds; seed++) {
    seedFastRandom(seed * 7919);
    HorseMind.reset();
    drainFires();
    const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      ...opts,
    } as never);
    acts[d.action] = (acts[d.action] ?? 0) + 1;
    const f = fires();
    for (const k of [RECEIPT, V65, PASS]) if (f[k]) seen[k] = (seen[k] ?? 0) + 1;
  }
  return { acts, seen };
}
const OFF = { v69TurnCallGaps: false };

/** A V32 solver cell for the turn board: every hand class bets big. */
function loadTurnCells(board: string) {
  const tex = textureClass(cards(board))!;
  const matrix: Record<string, Record<string, number>> = {};
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  for (let i = 0; i < ranks.length; i++)
    for (let j = i; j < ranks.length; j++) {
      if (i === j) matrix[ranks[j] + ranks[i]] = { bet_big: 1 };
      else {
        matrix[ranks[j] + ranks[i] + 's'] = { bet_big: 1 };
        matrix[ranks[j] + ranks[i] + 'o'] = { bet_big: 1 };
      }
    }
  const rows = [];
  for (const position of ['SB', 'BB'])
    for (const depth_bucket of [10, 20, 40, 80, 150])
      rows.push({
        street: 'turn',
        game_family: 'cash',
        position,
        depth_bucket,
        texture_class: tex,
        facing: 'open',
        hand_matrix: matrix,
      });
  setGtoPostflop(rows as never);
}

describe('V69 hole-card draw read', () => {
  it('counts a draw only when a hole card is part of it', () => {
    // board-only four-flush, hero holds no heart
    expect(holdemDrawPresent(cards('Ks5d'), cards('KhQh9h2h'))).toBe(true);
    expect(holdemHoleDrawPresent(cards('Ks5d'), cards('KhQh9h2h'))).toBe(false);
    // a hole heart makes the four-flush hero's draw
    expect(holdemHoleDrawPresent(cards('Ks5h'), cards('Kd9h3h7h'))).toBe(true);
    // board-only four-rank window, hero's ranks add nothing inside it
    expect(holdemDrawPresent(cards('9sKd'), cards('9h8d7s6c'))).toBe(true);
    expect(holdemHoleDrawPresent(cards('9sKd'), cards('9h8d7s6c'))).toBe(false);
    // three ranks in any window is no draw; a hole rank completing four is
    expect(holdemHoleDrawPresent(cards('Ks4d'), cards('Kh9d8s6c'))).toBe(false);
    expect(holdemHoleDrawPresent(cards('Ts4d'), cards('Kh9d7s2c'))).toBe(false);
    expect(holdemHoleDrawPresent(cards('Ts8d'), cards('Kh9d7s2c'))).toBe(true);
    expect(holdemHoleDrawPresent(cards('As2d'), cards('3h4d9sKc'))).toBe(true); // wheel
  });
});

describe('V69 decisions on the turn', () => {
  beforeEach(() => {
    enableBrainTelemetry();
    HorseMind.reset();
    drainFires();
  });
  afterEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    HorseMind.reset();
    drainFires();
  });

  it('(1) one pair facing a pot-sized bet with a short stack behind calls less on than off', () => {
    const s = turn('nlh', 'As4d', 'AhKdTs2c', 36, { villainBehind: 60 });
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(off.seen[RECEIPT] ?? 0).toBe(0);
    expect(on.seen[RECEIPT]).toBe(20);
    expect(off.acts['call'] ?? 0).toBe(16);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('(1) the same one pair with deep stacks is unchanged', () => {
    const s = turn('nlh', 'As4d', 'AhKdTs2c', 36);
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.seen[RECEIPT] ?? 0).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('(2) one pair on a board-only four-flush is now shaded like V65', () => {
    const s = turn('nlh', 'Ks5d', 'KhQh9h2h', 36);
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(off.seen[V65] ?? 0).toBe(0);
    expect(on.seen[V65]).toBe(20);
    expect(on.seen[RECEIPT]).toBe(20);
    expect(off.acts['call'] ?? 0).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('(2) a real hole-card flush draw with one pair is still exempt', () => {
    const s = turn('nlh', 'Ks5h', 'Kd9h3h7h', 36);
    const off = decideMany(s, OFF);
    const on = decideMany(s, {});
    expect(on.seen[V65] ?? 0).toBe(0);
    expect(on.seen[RECEIPT] ?? 0).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('(3) a V32 draw pass-through with no room to be paid no longer auto-calls', () => {
    loadTurnCells('Kh9h3s7c');
    const s = turn('nlh', 'Ah5h', 'Kh9h3s7c', 45, { villainBehind: 60 });
    const off = decideMany(s, { ...OFF, v32FacingDefense: true });
    const on = decideMany(s, { v32FacingDefense: true });
    expect(off.seen[PASS]).toBe(20);
    expect(off.acts['call'] ?? 0).toBe(20);
    expect(on.seen[PASS] ?? 0).toBe(0);
    expect(on.seen[RECEIPT]).toBe(20);
    expect(on.acts['call'] ?? 0).toBeLessThan(off.acts['call'] ?? 0);
  });

  it('(3) the same pass-through with deep stacks is unchanged', () => {
    loadTurnCells('Kh9h3s7c');
    const s = turn('nlh', 'Ah5h', 'Kh9h3s7c', 45);
    const off = decideMany(s, { ...OFF, v32FacingDefense: true });
    const on = decideMany(s, { v32FacingDefense: true });
    expect(on.seen[PASS]).toBe(20);
    expect(on.seen[RECEIPT] ?? 0).toBe(0);
    expect(on.acts).toEqual(off.acts);
  });

  it('the flop, the river and Omaha are identical on and off', () => {
    for (const s of [
      turn('nlh', 'As4d', 'AhKdTs', 36, { villainBehind: 60, street: 'flop' }),
      turn('nlh', 'Ks5d', 'KhQh9h', 36, { street: 'flop' }),
      turn('nlh', 'As4d', 'AhKdTs2c3s', 36, { villainBehind: 60, street: 'river' }),
      turn('nlh', 'Ks5d', 'KhQh9h2h3c', 36, { street: 'river' }),
      turn('plo4', 'As4dQc2c', 'AhKdTs2s', 36, { villainBehind: 60 }),
      turn('plo4', 'Ks5dJc8c', 'KhQh9h2h', 36),
    ]) {
      const off = decideMany(s, OFF);
      const on = decideMany(s, {});
      expect(on.seen[RECEIPT] ?? 0).toBe(0);
      expect(on.acts).toEqual(off.acts);
    }
  });

  it('the off arm reproduces today: no receipt on any fixture', () => {
    for (const s of [
      turn('nlh', 'As4d', 'AhKdTs2c', 36, { villainBehind: 60 }),
      turn('nlh', 'Ks5d', 'KhQh9h2h', 36),
      turn('nlh', '9sKd', '9h8d7s6c', 36),
    ])
      expect(decideMany(s, OFF).seen[RECEIPT] ?? 0).toBe(0);
    loadTurnCells('Kh9h3s7c');
    const v32 = decideMany(turn('nlh', 'Ah5h', 'Kh9h3s7c', 45, { villainBehind: 60 }), {
      ...OFF,
      v32FacingDefense: true,
    });
    expect(v32.seen[RECEIPT] ?? 0).toBe(0);
  });
});
