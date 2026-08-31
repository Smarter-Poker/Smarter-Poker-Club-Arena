/**
 * V21 — RIVER ENDGAME + DEEP-STACK DISCIPLINE (Dan 2026-08-27, Phase 2)
 *
 * Every scenario below is lifted from the horse_hand_reviews table's worst
 * river_aggr_lost rows (all -400bb to -500bb, all pre-V20):
 *   - a T7 straight four-betting a river on a THREE-CLUB board;
 *   - QT (the nut straight) calling off a jam war on the same three-club board;
 *   - sixes-full re-raising all-in on JJ66x into any jack;
 *   - A4 two pair calling a jam on a river that completed flush AND straight.
 * The common root: NLH had no nut status. Category "straight/flush/boat"
 * carried no notion of the board demoting it. V21 adds the evaluator, caps
 * the dominated classes under pressure, and forbids non-nut river re-raises.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom, nlhNutStatus } from './HorseEval.js';
import { decidePreflopV7 } from './HorsePreflop.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import { detectLeaks } from '../services/HorseHandReview.js';

beforeEach(() => seedFastRandom(0x5eed21));

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 20000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return {
    seat,
    userId: `horse-${seat}`,
    action,
    amount,
    timestamp: Date.now(),
    stage,
    ...extra,
  };
}

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

// ─────────────────────────────────────────────────────────────────────────────
// The evaluator itself
// ─────────────────────────────────────────────────────────────────────────────

describe('nlhNutStatus', () => {
  const clubBoard = cc('Ac', '9c', 'Js', '5d', '8c');

  it('sees the flush over a straight: T7 on Ac9cJs5d8c', () => {
    const ns = nlhNutStatus(cc('Ts', '7d'), clubBoard, false);
    expect(ns.cat).toBe(5);
    expect(ns.flushPossible).toBe(true);
    expect(ns.heroStraightTop).toBe(11); // J-high straight (7-8-9-T-J)
  });

  it('the nut straight is still not safe on a three-flush board: QT', () => {
    const ns = nlhNutStatus(cc('Qh', 'Th'), clubBoard, false);
    expect(ns.cat).toBe(5);
    expect(ns.heroStraightTop).toBe(12);
    expect(ns.maxStraightTop).toBe(12); // QT IS the best straight...
    expect(ns.flushPossible).toBe(true); // ...and it is still a bluff-catcher
  });

  it('knows the bottom boat: 65 on JJ66T is sixes-full under any jack', () => {
    const ns = nlhNutStatus(cc('6d', '5d'), cc('Jd', '6h', 'Jc', '6c', 'Th'), false);
    expect(ns.cat).toBe(7);
    expect(ns.underfull).toBe(true);
  });

  it('jacks-full on the same board is NOT the underfull', () => {
    const ns = nlhNutStatus(cc('Jh', '2d'), cc('Jd', '6h', 'Jc', '6c', 'Th'), false);
    expect(ns.cat).toBe(7);
    expect(ns.underfull).toBe(false);
  });

  it('the nut flush reads as the nut flush', () => {
    const ns = nlhNutStatus(cc('Kc', 'Qc'), clubBoard, false); // Ac on board: K-high is nut
    expect(ns.higherFlushRanks).toBe(0);
  });

  it('a small flush counts its dominators', () => {
    const ns = nlhNutStatus(cc('2c', '3c'), clubBoard, false);
    expect(ns.higherFlushRanks).toBeGreaterThanOrEqual(5); // K,Q,J,T,7,6,4 live
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The review-table hands
// ─────────────────────────────────────────────────────────────────────────────

/** T7 straight, three-club board. Hero raised the river bet, got 3-bet big. */
function straightIntoFlushWar(): { hero: SeatPlayer; gs: GS } {
  const hero = mkPlayer(3, { cards: cc('Ts', '7d'), stack: 22000, bet: 676 });
  const players = [
    mkPlayer(2, { bet: 2648 }),
    hero,
    mkPlayer(5, { bet: 676 }),
    mkPlayer(9, { is_folded: true }),
  ];
  const gs = {
    players,
    communityCards: cc('Ac', '9c', 'Js', '5d', '8c'),
    pot: 4500,
    currentBet: 2648,
    minRaise: 1972,
    stage: 'river' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 50,
    dealerSeat: 9,
    gameMode: 'cash' as const,
    actionHistory: [
      rec(2, 'bet', 227, 'river'),
      rec(3, 'raise', 676, 'river', { isFullRaise: true }),
      rec(5, 'call', 676, 'river'),
      rec(2, 'raise', 2648, 'river', { isFullRaise: true }),
    ],
  } as unknown as GS;
  return { hero, gs };
}

describe('V21 river endgame - the -500bb wars', () => {
  it('a straight on a three-flush board never re-raises the river raise', () => {
    const { hero, gs } = straightIntoFlushWar();
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(['call', 'fold']).toContain(d.action);
  });

  it('sixes-full on JJ66T never re-raises the river raise', () => {
    const hero = mkPlayer(8, { cards: cc('6d', '5d'), stack: 24000, bet: 977 });
    const players = [hero, mkPlayer(7, { bet: 3687 })];
    const gs = {
      players,
      communityCards: cc('Jd', '6h', 'Jc', '6c', 'Th'),
      pot: 6000,
      currentBet: 3687,
      minRaise: 2710,
      stage: 'river' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 50,
      dealerSeat: 7,
      gameMode: 'cash' as const,
      actionHistory: [
        rec(8, 'bet', 977, 'river', { isFullRaise: true }),
        rec(7, 'raise', 3687, 'river', { isFullRaise: true }),
      ],
    } as unknown as GS;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(['call', 'fold']).toContain(d.action);
  });

  it('the nut straight FOLDS to a three-way jam war on the flush board', () => {
    // QT has the best straight — and on Ac9cJs8c with two players shoving
    // over a raise, straights are not the hands doing the shoving.
    const hero = mkPlayer(5, { cards: cc('Qh', 'Th'), stack: 24000, bet: 676 });
    const players = [
      mkPlayer(2, { bet: 24950, stack: 0, is_all_in: true }),
      mkPlayer(3, { bet: 24950, stack: 0, is_all_in: true }),
      hero,
    ];
    const gs = {
      players,
      communityCards: cc('Ac', '9c', 'Js', '5d', '8c'),
      pot: 55000,
      currentBet: 24950,
      minRaise: 10000,
      stage: 'river' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 50,
      dealerSeat: 5,
      gameMode: 'cash' as const,
      actionHistory: [
        rec(2, 'bet', 227, 'river'),
        rec(3, 'raise', 676, 'river', { isFullRaise: true }),
        rec(5, 'call', 676, 'river'),
        rec(2, 'raise', 2648, 'river', { isFullRaise: true }),
        rec(3, 'all_in', 24950, 'river', { isFullRaise: true }),
        rec(2, 'all_in', 24950, 'river', { isFullRaise: true }),
      ],
    } as unknown as GS;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('fold');
  });

  it('the NUT FLUSH is untouched: it keeps raising the war', () => {
    const { hero, gs } = straightIntoFlushWar();
    hero.cards = cc('Kc', 'Qc');
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).not.toBe('fold');
  });

  it('two pair folds a committed jam on a flush-and-straight river', () => {
    // A4 two pair; the 3d river completed diamonds AND the wheel.
    const hero = mkPlayer(9, { cards: cc('Ah', '4h'), stack: 12000, bet: 0 });
    const players = [hero, mkPlayer(6, { bet: 12513, stack: 0, is_all_in: true })];
    const gs = {
      players,
      communityCards: cc('4d', 'As', 'Qd', '5s', '3d'),
      pot: 21500,
      currentBet: 12513,
      minRaise: 5000,
      stage: 'river' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 50,
      dealerSeat: 6,
      gameMode: 'cash' as const,
      actionHistory: [
        rec(9, 'check', 0, 'river'),
        rec(6, 'all_in', 12513, 'river', { isFullRaise: true }),
      ],
    } as unknown as GS;
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('fold');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Deep-stack preflop discipline (unit level — the branch is pure)
// ─────────────────────────────────────────────────────────────────────────────

function deepCtx(overrides: Record<string, unknown>) {
  return {
    strength: 0.955,
    position: 'late' as const,
    raiserPosition: 'middle' as const,
    raises: 3,
    limpers: 0,
    callers: 0,
    oppsLeft: 1,
    toCall: 3000,
    currentBet: 8000,
    pot: 12000,
    bigBlind: 50,
    stack: 12500,
    stackBB: 250,
    tightness: 1,
    bluffFreq: 0.1,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0,
    mode: 'cash' as const,
    deepDiscipline: true,
    v13: true,
    rand: () => 0.5,
    ...overrides,
  };
}

describe('V21 deep-stack preflop discipline', () => {
  it('a 0.955 hand no longer jams a 5-bet pot at 250bb - it calls', () => {
    const r = decidePreflopV7(deepCtx({}) as never);
    expect(r.a).toBe('call');
  });

  it('the same hand at the same depth WITHOUT the layer jams (the old leak)', () => {
    const r = decidePreflopV7(deepCtx({ deepDiscipline: false }) as never);
    expect(r.a).toBe('jam');
  });

  it('at 100bb behavior is unchanged with the layer on', () => {
    const r = decidePreflopV7(deepCtx({ stackBB: 100, stack: 5000 }) as never);
    expect(r.a).toBe('jam');
  });

  it('tournaments are untouched by deep discipline', () => {
    const r = decidePreflopV7(deepCtx({ mode: 'tournament' }) as never);
    expect(r.a).toBe('jam');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detector + league registration
// ─────────────────────────────────────────────────────────────────────────────

describe('V21 detectors and league card', () => {
  it('a lost river raise war carries the river_raise_war tag', () => {
    const tags = detectLeaks({
      netBB: -450,
      invested: 22500,
      bigBlind: 50,
      variant: 'nlh',
      holeCards: cc('6d', '5d'),
      board: cc('Jd', '6h', 'Jc', '6c', 'Th'),
      heroActions: [
        { action: 'call', stage: 'preflop' },
        { action: 'bet', stage: 'river' },
        { action: 'raise', stage: 'river' },
        { action: 'all_in', stage: 'river' },
      ],
      wentToShowdown: true,
    });
    expect(tags).toContain('river_raise_war');
    expect(tags).toContain('underfull_stackoff');
  });

  it('a straight lost into a flush board is tagged', () => {
    const tags = detectLeaks({
      netBB: -400,
      invested: 20000,
      bigBlind: 50,
      variant: 'nlh',
      holeCards: cc('Ts', '7d'),
      board: cc('Ac', '9c', 'Js', '5d', '8c'),
      heroActions: [{ action: 'raise', stage: 'river' }],
      wentToShowdown: true,
    });
    expect(tags).toContain('straight_into_flush_stackoff');
  });

  it('the v21 matchups are on the card and the legacy arm disables the flags', () => {
    expect(LEAGUE_MATCHUPS.find((m) => m.name === 'v21_river_endgame')?.b).toEqual({
      v21River: false,
    });
    expect(LEAGUE_MATCHUPS.find((m) => m.name === 'v21_deep_250bb')?.b).toEqual({
      v21Deep: false,
    });
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v21River).toBe(false);
    expect(legacy.v21Deep).toBe(false);
  });
});
