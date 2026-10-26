/**
 * A MADE HAND IS NOT ITS CLASS AVERAGE (Dan 2026-10-26, binding).
 *
 * "I JUST WATCHED A HORSE RAISE AJc 'SLEEPYREG' AND FLIP THE NUT FLUSH AND
 * CHECK IT EVERY SINGLE STREET INSTEAD OF EVER BETTING FOR VALUE!?"
 *
 * Hand 48442708: sleepyreg raised A-J of clubs from the small blind, was
 * called, and the board ran Q-5-8 of clubs, 5h, Kh. The compact solver cells
 * hold the mean of a hand CLASS over every board in a TEXTURE class: on that
 * turn texture "AJs" is mostly ace-high with no club, so the production cell
 * says check 81-84%, and the river cell says check 100%. The cell cannot
 * know that this AJs holds the ace of the board's suit.
 *
 * A set, trips, a straight, a flush or better is not the class average: the
 * value ladder bets it. Any other holding still reads the cell exactly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const T0 = 1_792_990_000_000;
const seat = (
  n: number,
  id: string,
  stack: number,
  invested: number,
  folded: boolean
): SeatPlayer => ({
  seat: n,
  user_id: id,
  username: id,
  stack,
  bet: 0,
  totalInvested: invested,
  cards: [],
  is_folded: folded,
  is_sitting_out: false,
  is_all_in: false,
});
const PREFLOP = [
  { stage: 'preflop', seat: 3, userId: 'bb', action: 'bb', amount: 20000, timestamp: T0 },
  { stage: 'preflop', seat: 8, userId: 'hero', action: 'sb', amount: 10000, timestamp: T0 },
  { stage: 'preflop', seat: 4, userId: 'p4', action: 'fold', amount: 0, timestamp: T0 + 1 },
  { stage: 'preflop', seat: 5, userId: 'p5', action: 'fold', amount: 0, timestamp: T0 + 2 },
  { stage: 'preflop', seat: 6, userId: 'p6', action: 'fold', amount: 0, timestamp: T0 + 3 },
  { stage: 'preflop', seat: 7, userId: 'p7', action: 'fold', amount: 0, timestamp: T0 + 4 },
  {
    stage: 'preflop',
    seat: 8,
    userId: 'hero',
    action: 'raise',
    amount: 40000,
    timestamp: T0 + 5,
    isFullRaise: true,
  },
  { stage: 'preflop', seat: 3, userId: 'bb', action: 'call', amount: 20000, timestamp: T0 + 6 },
];
const checks = (street: string, t: number) => [
  { stage: street, seat: 8, userId: 'hero', action: 'check', amount: 0, timestamp: t },
  { stage: street, seat: 3, userId: 'bb', action: 'check', amount: 0, timestamp: t + 1 },
];

function state(stage: 'flop' | 'turn' | 'river', board: string, hole: string, mode = 'tournament') {
  const players = [
    seat(3, 'bb', 330754, 60000, false),
    seat(4, 'p4', 232070, 0, true),
    seat(5, 'p5', 151074, 0, true),
    seat(6, 'p6', 290574, 0, true),
    seat(7, 'p7', 300192, 0, true),
    seat(8, 'hero', 899508, 40000, false),
  ];
  const history =
    stage === 'flop'
      ? PREFLOP
      : stage === 'turn'
        ? [...PREFLOP, ...checks('flop', T0 + 7)]
        : [...PREFLOP, ...checks('flop', T0 + 7), ...checks('turn', T0 + 9)];
  return {
    hero: { ...players[5], cards: cards(hole) },
    gs: {
      players,
      communityCards: cards(board),
      pot: 100000,
      currentBet: 0,
      minRaise: 20000,
      stage,
      gameVariant: 'nlh',
      gameMode: mode,
      format: mode === 'cash' ? 'cash' : 'mtt',
      bigBlind: 20000,
      smallBlind: 10000,
      dealerSeat: 7,
      actionHistory: history,
      tournament: { playersLeft: 13, spotsPaid: 21, inMoney: true, entrants: 160 },
    },
  };
}

/**
 * The production cells for this spot, as gto_postflop_compact holds them on
 * 2026-10-26. Heads-up, the small blind is charted at the BB position, and
 * a tourney_icm consult falls back to tourney_ev where icm has no flop.
 */
function seedProductionCells() {
  const flopTex = textureClass(cards('Qc5c8c'))!;
  const turnTex = textureClass(cards('Qc5c8c5h'))!;
  const row = (street: string, family: string, tex: string, depth: number, mix: object) =>
    ({
      street,
      game_family: family,
      position: 'BB',
      depth_bucket: depth,
      texture_class: tex,
      facing: 'open',
      hand_matrix: { AJs: mix },
    }) as never;
  setGtoPostflop([
    row('flop', 'tourney_ev', flopTex, 10, { check: 0.7694, bet_big: 0.0487, bet_small: 0.182 }),
    row('flop', 'tourney_ev', flopTex, 20, { check: 0.7612, bet_big: 0, bet_small: 0.2388 }),
    row('flop', 'tourney_ev', flopTex, 40, { check: 0.9903, bet_big: 0.0031, bet_small: 0.0066 }),
    row('turn', 'tourney_icm', turnTex, 10, { check: 0.8091, bet_small: 0.191 }),
    row('turn', 'tourney_icm', turnTex, 20, { check: 0.8183, bet_small: 0.1817 }),
    row('turn', 'tourney_icm', turnTex, 40, { check: 0.8496, bet_small: 0.1504 }),
    row('flop', 'cash', flopTex, 20, { check: 0.7612, bet_big: 0, bet_small: 0.2388 }),
  ]);
}

function decide(
  stage: 'flop' | 'turn' | 'river',
  board: string,
  hole: string,
  mode = 'tournament'
) {
  const { hero, gs } = state(stage, board, hole, mode);
  enableBrainTelemetry();
  drainFires();
  let bets = 0;
  for (let i = 0; i < 150; i++) {
    HorseMind.reset();
    const d = HorseLogic.decide(hero as never, gs as never, 'balanced', {}, {
      telemetry: true,
      decisionTimeMs: T0 + 100 + i * 7919,
    } as never);
    if (d.action === 'bet' || d.action === 'raise' || d.action === 'all_in') bets++;
  }
  return { bets, fires: Object.fromEntries(drainFires().map((r) => [r.feature, r.fires])) };
}

beforeEach(() => {
  _clearGtoPostflop();
  _clearGtoPostflopV31();
  seedProductionCells();
});

describe('the nut flush bets for value whatever the class-mean cell says', () => {
  it('flop: A-J of clubs on Q-5-8 of clubs does not follow the 76%-check cell', () => {
    const { bets, fires } = decide('flop', 'Qc5c8c', 'AcJc');
    expect(fires.v58_made_hand_cell_skip).toBe(150);
    expect(bets).toBeGreaterThanOrEqual(120);
  });

  it('turn: the same flush on the 5h bets', () => {
    const { bets, fires } = decide('turn', 'Qc5c8c5h', 'AcJc');
    expect(fires.v58_made_hand_cell_skip).toBe(150);
    expect(bets).toBeGreaterThanOrEqual(140);
  });

  it('river: the same hand on the Kh river bets', () => {
    expect(decide('river', 'Qc5c8c5hKh', 'AcJc').bets).toBeGreaterThanOrEqual(140);
  });

  it('a cash game bets it too: the cell flaw is not a tournament one', () => {
    const { fires } = decide('flop', 'Qc5c8c', 'AcJc', 'cash');
    expect(fires.v58_made_hand_cell_skip).toBe(150);
  });

  it('an A-J suited with no club is not a made hand: the cell keeps its say', () => {
    const { fires } = decide('flop', 'Qc5c8c', 'AdJd');
    expect(fires.v58_made_hand_cell_skip ?? 0).toBe(0);
    expect(fires.v29_gto_flop_open ?? 0).toBe(150);
  });
});
