import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { ploPairedBoardMustFold } from './HorsePloPairedBoardFold.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import type { Card, SeatPlayer } from '../types.js';

const suits: Record<string, Card['suit']> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1]] }));

const human = '388dc5ea-0e9f-4a49-865f-d14737f58713';

/**
 * The recorded hand (2026-10-25, Madness PLO5 1/2 + BB ante): the horse held
 * Th Qd 6d Qc 7d, called a pot bet on 6h 7c Jd, the Js paired the board, the
 * human shoved 190.52 into 375 and the horse called with two pair.
 */
function recorded(
  over: { hole?: string; board?: string; variant?: string; shove?: number; heroStack?: number } = {}
) {
  const shove = over.shove ?? 190.52;
  const hero = {
    seat: 6,
    user_id: 'horse',
    username: 'DETLegend',
    totalInvested: 165,
    stack: over.heroStack ?? 504.76,
    bet: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: cards(over.hole ?? 'Th Qd 6d Qc 7d'),
  } as SeatPlayer;
  const villain = {
    seat: 2,
    user_id: human,
    username: 'human',
    totalInvested: 165 + shove,
    stack: 0,
    bet: shove,
    is_folded: false,
    is_all_in: true,
    is_sitting_out: false,
    cards: [],
  } as unknown as SeatPlayer;
  const gs = {
    players: [villain, hero],
    communityCards: cards(over.board ?? '6h 7c Jd Js'),
    pot: 375 + shove,
    currentBet: shove,
    minRaise: shove,
    lastRaise: shove,
    stage: 'turn',
    gameVariant: over.variant ?? 'plo5',
    bigBlind: 2,
    dealerSeat: 2,
    rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
    actionHistory: [
      { stage: 'preflop', seat: 6, userId: 'horse', action: 'raise', amount: 11 },
      { stage: 'preflop', seat: 2, userId: human, action: 'raise', amount: 40 },
      { stage: 'preflop', seat: 6, userId: 'horse', action: 'call', amount: 29 },
      { stage: 'flop', seat: 6, userId: 'horse', action: 'check', amount: 0 },
      { stage: 'flop', seat: 2, userId: human, action: 'bet', amount: 125 },
      { stage: 'flop', seat: 6, userId: 'horse', action: 'call', amount: 125 },
      { stage: 'turn', seat: 6, userId: 'horse', action: 'check', amount: 0 },
      { stage: 'turn', seat: 2, userId: human, action: 'all_in', amount: shove, isFullRaise: true },
    ],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

function ruleFor(s: ReturnType<typeof recorded>) {
  return ploPairedBoardMustFold({
    gameVariant: s.gs.gameVariant,
    hiLo: false,
    multiBoard: false,
    board: s.gs.communityCards,
    hero: s.hero,
    players: s.gs.players,
    currentBet: s.gs.currentBet,
    pot: s.gs.pot,
  });
}

afterEach(() => HorseMind.reset());

describe('PLO4/PLO5/PLO6: no full house on a paired board folds to a committing bet (Dan 2026-10-25)', () => {
  it('the recorded hand folds: two pair when the Jack paired the turn, facing the shove', () => {
    const s = recorded();
    expect(ruleFor(s)).toBe(true);
    for (const seed of [1, 7, 42, 99, 2026]) {
      seedFastRandom(seed);
      expect(HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false }).action).toBe('fold');
    }
  });

  it('the fold is signed by the policy graph, so the live worker accepts it', () => {
    // 2026-10-26: applied after graph.finish, the fold left a graph whose
    // final action was the call, and the engine refused 149 decisions as an
    // "invalid policy receipt". It is now the last wager rule.
    for (const [variant, hole, board] of [
      ['plo5', 'Th Qd 6d Qc 7d', '6h 7c Jd Js'],
      ['plo4', 'Jh Ah Kd 2c', '6h Jc Jd'],
      ['plo6', 'Th Qd 6d Qc 7d 2s', '6h 7c Jd Js Kc'],
    ] as const) {
      const s = recorded({ variant, hole, board });
      seedFastRandom(5);
      const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
      expect(d.action).toBe('fold');
      expect(d.policyGraph?.finalAction).toEqual({ action: 'fold', amount: null });
      const wager = d.policyGraph?.transitions.find((t) => t.node === 'wager_rules');
      expect(wager?.after.action).toBe('fold');
      expect(horseDecisionReceiptIsValid(d, variant)).toBe(true);
      // The games without an owner fold rule never admit a wager-rule fold.
      expect(horseDecisionReceiptIsValid(d, 'short_deck')).toBe(wager?.changed ? false : true);
    }
  });

  it('every style folds it', () => {
    for (const style of ['tag', 'lag', 'balanced', 'tricky', 'grinder'] as const) {
      const s = recorded();
      seedFastRandom(3);
      expect(HorseLogic.decide(s.hero, s.gs, style, {}, { mind: false }).action).toBe('fold');
    }
  });

  it('also on the river, and in PLO6', () => {
    expect(ruleFor(recorded({ board: '6h 7c Jd Js Kc' }))).toBe(true);
    expect(ruleFor(recorded({ variant: 'plo6', hole: 'Th Qd 6d Qc 7d 2s' }))).toBe(true);
  });

  it('trips, a straight and a flush still fold on a paired board', () => {
    expect(ruleFor(recorded({ hole: 'Jh Ah 2d Qc 3d' }))).toBe(true); // trips Jacks
    expect(ruleFor(recorded({ hole: '8h 9h 2d 3c 4d', board: '6h 7c Td Ts' }))).toBe(true); // straight
    expect(ruleFor(recorded({ hole: 'Ac Kc 2d 3h 4d', board: '6c 7c Jc Js' }))).toBe(true); // nut flush
  });

  it('a full house or better keeps its call', () => {
    expect(ruleFor(recorded({ hole: '7h 7s Qd Qc 2d' }))).toBe(false); // 777JJ
    expect(ruleFor(recorded({ hole: 'Jh Jc 6d Qc 2d' }))).toBe(false); // quads
  });

  it('PLO4 and the paired flop fold too ("ADD PLO4 AND PLO5 AND THE FLOP")', () => {
    expect(ruleFor(recorded({ board: '6h Jc Jd' }))).toBe(true); // PLO5 paired flop
    expect(ruleFor(recorded({ variant: 'plo4', hole: 'Th Qd Qc 7d' }))).toBe(true); // PLO4 turn
    expect(ruleFor(recorded({ variant: 'plo4', hole: 'Jh Ah Kd 2c', board: '6h Jc Jd' }))).toBe(
      true
    ); // PLO4 flop trips
    expect(
      ruleFor(recorded({ variant: 'plo6', hole: 'Th Qd 6d Qc 7d 2s', board: '7h 7c Kd' }))
    ).toBe(true); // PLO6 flop
    for (const [variant, hole, board] of [
      ['plo4', 'Th Qd Qc 7d', '6h 7c Jd Js'],
      ['plo4', 'Jh Ah Kd 2c', '6h Jc Jd'],
      ['plo5', 'Th Qd 6d Qc 7d', '6h Jc Jd'],
    ] as const) {
      for (const seed of [1, 42, 2026]) {
        const s = recorded({ variant, hole, board });
        seedFastRandom(seed);
        expect(HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false }).action).toBe(
          'fold'
        );
      }
    }
  });

  it('a flop full house keeps its call', () => {
    expect(ruleFor(recorded({ hole: 'Jh 6c 2d 3c 4d', board: '6h Jc Jd' }))).toBe(false); // JJJ66
    expect(ruleFor(recorded({ variant: 'plo4', hole: '6s 6c 2d 3c', board: '6h Jc Jd' }))).toBe(
      false
    ); // 666JJ
  });

  it('does not touch an unpaired board, hold em, PLO8, or a token call', () => {
    expect(ruleFor(recorded({ board: '6h 7c Jd 2s' }))).toBe(false);
    expect(ruleFor(recorded({ board: '6h 7c Jd' }))).toBe(false);
    expect(ruleFor(recorded({ variant: 'nlh', hole: 'Qd Qc' }))).toBe(false);
    expect(ruleFor(recorded({ variant: 'plo8', hole: 'Th Qd Qc 7d' }))).toBe(false);
    // 5 into a 1000 pot with plenty behind: not a call-off
    expect(ruleFor(recorded({ shove: 5, heroStack: 2000 }))).toBe(false);
  });
});
