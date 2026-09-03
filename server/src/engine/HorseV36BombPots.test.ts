/**
 * V36 — bomb pots: single, double and triple board (2026-09-02, phase 3).
 *
 * Dan: "THERE IS PROBABLY ZERO SOLVER, OR LOGIC OR MATH BEHIND ANY OF IT,
 * ESPECIALLY THE DOUBLE AND TRIPLE BOARD BOMB POTS."
 *
 * What there was: the per-board equity average (exact for the pot share) and
 * nothing else. Every style read used board one; a first-to-act bettor in a
 * bomb pot was sampled from a random range forever (no preflop line, so the
 * postflop narrowing never engaged); a lock on one board was a 55% medium
 * hand; single-board bomb pots consulted hold'em solver cells solved for
 * single-raised-pot ranges.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, ActionRecord, HandStage } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

function player(seat: number, id: string, o: Record<string, unknown> = {}) {
  return {
    seat,
    user_id: id,
    username: id,
    stack: 400,
    bet: 0,
    totalInvested: 4,
    cards: [] as Card[],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    ...o,
  };
}

/** Heads-up bomb pot: two 2bb antes (pot 8 before action), 100bb behind. */
function bombState(args: {
  hero: string;
  board1: string;
  board2?: string;
  board3?: string;
  stage?: HandStage;
  facingBet?: number;
  heroIp?: boolean;
  variant?: string;
  history?: ActionRecord[];
}) {
  const heroSeat = args.heroIp ? 2 : 1;
  const villSeat = args.heroIp ? 1 : 2;
  const players = [
    player(1, heroSeat === 1 ? 'hero' : 'villain'),
    player(2, heroSeat === 2 ? 'hero' : 'villain'),
  ];
  const hero = players[heroSeat - 1];
  const vill = players[villSeat - 1];
  hero.cards = cards(args.hero);
  let pot = 8;
  let currentBet = 0;
  const history: ActionRecord[] = args.history ? [...args.history] : [];
  const stage = args.stage ?? 'flop';
  if (args.facingBet) {
    const bet = Math.round(pot * args.facingBet);
    history.push({
      seat: villSeat,
      userId: 'villain',
      action: 'bet',
      amount: bet,
      timestamp: 50,
      stage,
    });
    vill.bet = bet;
    vill.totalInvested += bet;
    vill.stack -= bet;
    pot += bet;
    currentBet = bet;
  } else if (args.heroIp) {
    history.push({
      seat: villSeat,
      userId: 'villain',
      action: 'check',
      amount: 0,
      timestamp: 50,
      stage,
    });
  }
  return {
    hero,
    gs: {
      players,
      communityCards: cards(args.board1),
      communityCards2: args.board2 ? cards(args.board2) : [],
      communityCards3: args.board3 ? cards(args.board3) : [],
      pot,
      currentBet,
      minRaise: Math.max(2, currentBet),
      stage,
      gameVariant: args.variant ?? 'nlh',
      gameMode: 'cash',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: history,
      bombPot: true,
      boardCount: args.board3 ? 3 : args.board2 ? 2 : 1,
    },
  };
}

beforeEach(() => {
  seedFastRandom(0x5eed36);
  HorseMind.reset();
  enableBrainTelemetry();
  drainFires();
});
afterEach(() => HorseMind.reset());

describe('V36 a bettor in a bomb pot is read from what they did, not from a random deal', () => {
  it('a player who bet the flop and barrelled the turn has a narrowed band', () => {
    const history: ActionRecord[] = [
      { seat: 2, userId: 'villain', action: 'bet', amount: 6, timestamp: 10, stage: 'flop' },
      { seat: 1, userId: 'hero', action: 'call', amount: 6, timestamp: 11, stage: 'flop' },
      { seat: 2, userId: 'villain', action: 'bet', amount: 16, timestamp: 20, stage: 'turn' },
    ];
    const readOut = { aggrW: 0, checked: 0 };
    const band = HorseMind.bandFor('villain', history, 2, true, cards('Ks9d7c2h'), readOut);
    expect(band).not.toBeNull();
    expect(band![0]).toBeGreaterThan(0);
    expect(readOut.aggrW).toBeGreaterThan(0);
  });
  it('a player who has not acted in a bomb pot is still a random deal', () => {
    const history: ActionRecord[] = [
      { seat: 2, userId: 'villain', action: 'bet', amount: 6, timestamp: 10, stage: 'flop' },
    ];
    expect(HorseMind.bandFor('hero', history, 2, true, cards('Ks9d7c'))).toBeNull();
  });
});

describe('V36 a lock on one board is a freeroll', () => {
  // Board 1: hero AhKh on Qh7h2h = the nut flush, no full house possible yet.
  // Board 2: 9c8d3s, hero has ace-king high — nothing.
  it('facing a pot-sized bet: never folds, raises most of the time', () => {
    let raises = 0;
    let folds = 0;
    let calls = 0;
    for (let i = 0; i < 60; i++) {
      const s = bombState({ hero: 'AhKh', board1: 'Qh7h2h', board2: '9c8d3s', facingBet: 1 });
      const d = HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true }
      );
      if (d.action === 'raise' || d.action === 'all_in') raises++;
      else if (d.action === 'fold') folds++;
      else calls++;
    }
    expect(folds).toBe(0);
    expect(raises).toBeGreaterThan(30);
    expect(raises + calls).toBe(60);
    expect(fires()['v36_board_lock']).toBeGreaterThan(0);
  });

  it('the lock is found on board TWO as well (the style board follows the money)', () => {
    let raises = 0;
    let folds = 0;
    for (let i = 0; i < 60; i++) {
      const s = bombState({ hero: 'AhKh', board1: '9c8d3s', board2: 'Qh7h2h', facingBet: 1 });
      const d = HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true }
      );
      if (d.action === 'raise' || d.action === 'all_in') raises++;
      if (d.action === 'fold') folds++;
    }
    expect(folds).toBe(0);
    expect(raises).toBeGreaterThan(30);
  });

  it('checked to: bets big, almost always', () => {
    let bets = 0;
    for (let i = 0; i < 60; i++) {
      const s = bombState({ hero: 'AhKh', board1: 'Qh7h2h', board2: '9c8d3s', heroIp: true });
      const d = HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true }
      );
      if (d.action === 'bet' || d.action === 'all_in') bets++;
    }
    expect(bets).toBeGreaterThan(48);
    expect(fires()['v36_freeroll_bet']).toBeGreaterThan(0);
  });

  it('a three-board pot with one lock still never folds a pot-sized bet', () => {
    let folds = 0;
    for (let i = 0; i < 40; i++) {
      const s = bombState({
        hero: 'AhKh',
        board1: 'Qh7h2h',
        board2: '9c8d3s',
        board3: 'Jd5c4c',
        facingBet: 1,
      });
      const d = HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true }
      );
      if (d.action === 'fold') folds++;
    }
    expect(folds).toBe(0);
    expect(fires()['v36_bomb_multiboard']).toBeGreaterThan(0);
  });

  it('PLO: a nut flush on one board of two raises the other board away too', () => {
    let raises = 0;
    let folds = 0;
    for (let i = 0; i < 40; i++) {
      const s = bombState({
        hero: 'AhKh9c8d',
        board1: 'Qh7h2h',
        board2: 'Jd5c4c',
        facingBet: 1,
        variant: 'plo4',
      });
      const d = HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true }
      );
      if (d.action === 'raise' || d.action === 'all_in') raises++;
      if (d.action === 'fold') folds++;
    }
    expect(folds).toBe(0);
    expect(raises).toBeGreaterThan(20);
  });
});

describe('V36 bluffs shrink with every extra board', () => {
  it('air on a double board bluffs less than the same air on one board', () => {
    const run = (board2?: string) => {
      let bets = 0;
      for (let i = 0; i < 300; i++) {
        const s = bombState({ hero: '6d5c', board1: 'KsQh2c', board2, heroIp: true });
        const d = HorseLogic.decide(s.hero as never, s.gs as never, 'lag', {}, { telemetry: true });
        if (d.action === 'bet') bets++;
      }
      return bets;
    };
    const single = run();
    const double = run('Ah9s3d');
    expect(double).toBeLessThan(single);
    expect(fires()['v36_multiboard_bluff_trim']).toBeGreaterThan(0);
  });
});

describe('V36 single-board bomb pots do not consult hold em solver cells', () => {
  const BOARD = cards('Ks9d7c2h');
  beforeEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    setGtoPostflop([
      {
        street: 'turn',
        game_family: 'cash',
        position: 'SB',
        depth_bucket: 80,
        texture_class: textureClass(BOARD)!,
        facing: 'open',
        hand_matrix: { AKs: { bet_big: 1 } },
      },
    ]);
  });
  afterEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
  });
  const turnWithLead = (bombPot: boolean) => {
    const s = bombState({
      hero: 'AhKh',
      board1: 'Ks9d7c2h',
      stage: 'turn',
      heroIp: true,
      history: [
        { seat: 1, userId: 'villain', action: 'check', amount: 0, timestamp: 10, stage: 'flop' },
        { seat: 2, userId: 'hero', action: 'bet', amount: 6, timestamp: 11, stage: 'flop' },
        { seat: 1, userId: 'villain', action: 'call', amount: 6, timestamp: 12, stage: 'flop' },
      ],
    });
    (s.gs as { bombPot: boolean }).bombPot = bombPot;
    s.gs.pot = 20;
    HorseLogic.decide(
      s.hero as never,
      s.gs as never,
      'balanced',
      {},
      { telemetry: true, mind: false }
    );
    return fires()['v30_gto_turn_open'] ?? 0;
  };
  it('the same spot consults the cell in a normal hand and not in a bomb pot', () => {
    expect(turnWithLead(false)).toBe(1);
    expect(turnWithLead(true)).toBe(0);
  });
});
