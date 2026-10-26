/**
 * THE TURN CELL IS NOT THE BARREL NODE (Dan 2026-10-25, binding).
 *
 * "IT IS SO PASSIVE AND EASY", with players' screenshots calling the
 * tournament horses soft. The compact turn solver cells are keyed by street,
 * family, seat, depth and texture - never by who bet the flop - and every
 * tournament turn cell averages a 16% bet frequency, the same for the button
 * and the big blind. A horse that c-bet the flop and was called read that
 * check-heavy mix and gave up: in production the heads-up NLH tournament flop
 * bettor fired the turn 24.5% of the time when checked to (humans 47%).
 *
 * With the initiative on a tournament turn the cell does not answer; the
 * barrel plan, the value ladder and the continuation do. Cash, and any turn
 * where the horse does not hold the lead, still read the cell exactly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

const BOARD = cards('Ks9d7c2h');
const HOLE = cards('AhQh');

beforeEach(() => {
  _clearGtoPostflop();
  _clearGtoPostflopV31();
  HorseMind.reset();
});

/** Heads-up turn; hero (button/small blind) raised preflop and bet the flop. */
function state(mode: 'cash' | 'tournament', heroBetFlop: boolean, t0: number) {
  const flop = heroBetFlop
    ? [
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'check',
          amount: 0,
          timestamp: t0 + 3,
        },
        { stage: 'flop', seat: 1, userId: 'hero', action: 'bet', amount: 200, timestamp: t0 + 4 },
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'call',
          amount: 200,
          timestamp: t0 + 5,
        },
      ]
    : [
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 200,
          timestamp: t0 + 3,
        },
        { stage: 'flop', seat: 1, userId: 'hero', action: 'call', amount: 200, timestamp: t0 + 4 },
      ];
  return {
    players: [
      {
        seat: 1,
        user_id: 'hero',
        stack: 4500,
        bet: 0,
        is_folded: false,
        is_sitting_out: false,
        cards: HOLE,
      },
      {
        seat: 2,
        user_id: 'villain',
        stack: 4500,
        bet: 0,
        is_folded: false,
        is_sitting_out: false,
        cards: [],
      },
    ],
    communityCards: BOARD,
    pot: 1000,
    currentBet: 0,
    minRaise: 100,
    stage: 'turn',
    gameVariant: 'nlh',
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'mtt',
    ...(mode === 'tournament' ? { tournament: { id: 't1' } } : {}),
    bigBlind: 100,
    smallBlind: 50,
    dealerSeat: 1,
    actionHistory: [
      {
        stage: 'preflop',
        seat: 1,
        userId: 'hero',
        action: 'raise',
        amount: 300,
        timestamp: t0,
        isFullRaise: true,
      },
      {
        stage: 'preflop',
        seat: 2,
        userId: 'villain',
        action: 'call',
        amount: 300,
        timestamp: t0 + 1,
      },
      ...flop,
      { stage: 'turn', seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: t0 + 6 },
    ],
  };
}

function seedCheckCell(family: string) {
  const tex = textureClass(BOARD)!;
  setGtoPostflop(
    [20, 40, 80].map(
      (depth) =>
        ({
          street: 'turn',
          game_family: family,
          position: 'SB',
          depth_bucket: depth,
          texture_class: tex,
          facing: 'open',
          hand_matrix: { AQs: { check: 1.0 } },
        }) as never
    )
  );
}

function turnBets(mode: 'cash' | 'tournament', heroBetFlop: boolean) {
  enableBrainTelemetry();
  drainFires();
  let bets = 0;
  for (let i = 0; i < 200; i++) {
    const t0 = 1_700_000_000_000 + i * 100_000;
    const st = state(mode, heroBetFlop, t0);
    const d = HorseLogic.decide(st.players[0] as never, st as never, 'balanced', {}, {
      telemetry: true,
      decisionTimeMs: t0 + 7,
    } as never);
    if (d.action === 'bet' || d.action === 'raise' || d.action === 'all_in') bets++;
  }
  const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
  return { bets, fires };
}

describe('a tournament horse with the flop lead plays the turn as the aggressor', () => {
  it('the check-only turn cell no longer answers the flop bettor', () => {
    seedCheckCell('tourney_icm');
    const { bets, fires } = turnBets('tournament', true);
    expect(fires['v57_turn_cell_initiative_skip'] ?? 0).toBe(200);
    expect(fires['v30_gto_turn_open'] ?? 0).toBe(0);
    expect(bets).toBeGreaterThan(20);
  });

  it('cash still reads the cell exactly: a check-only cell checks every time', () => {
    seedCheckCell('cash');
    const { bets, fires } = turnBets('cash', true);
    expect(fires['v57_turn_cell_initiative_skip'] ?? 0).toBe(0);
    expect(bets).toBe(0);
  });

  it('without the lead the tournament cell still answers', () => {
    seedCheckCell('tourney_icm');
    const { fires } = turnBets('tournament', false);
    expect(fires['v57_turn_cell_initiative_skip'] ?? 0).toBe(0);
  });
});
