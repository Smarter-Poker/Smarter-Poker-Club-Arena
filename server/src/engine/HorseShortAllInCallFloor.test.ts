import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import {
  pairedBoardFoldYieldsToShortAllIn,
  shortAllInCallFloor,
  shortAllInSpot,
} from './HorseShortAllInCallFloor.js';
import { ploPairedBoardMustFold } from './HorsePloPairedBoardFold.js';
import {
  horseDecisionReceiptIsValid,
  horseDecisionReceiptRefusal,
} from './horseDecision/responseValidation.js';
import type { Card, HorseDecision, SeatPlayer } from '../types.js';

const suits: Record<string, Card['suit']> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const cards = (s: string): Card[] =>
  s ? s.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1]] })) : [];

function seat(
  n: number,
  stack: number,
  bet: number,
  over: Partial<SeatPlayer> & { hole?: string } = {}
): SeatPlayer {
  const { hole, ...rest } = over;
  return {
    seat: n,
    user_id: `p${n}`,
    username: `p${n}`,
    stack,
    bet,
    totalInvested: bet,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: cards(hole ?? ''),
    ...rest,
  } as SeatPlayer;
}

const BB = 200;

/**
 * Preflop, 100/200 with a 25 ante, six seats. UTG (seat 1) moves all in for
 * `shove`, everyone folds to the horse on the button (seat 4), the blinds are
 * still to act behind it.
 */
function preflop(
  over: { hole?: string; heroStack?: number; shove?: number; mode?: 'tournament' | 'cash' } = {}
) {
  const shove = over.shove ?? 500;
  const heroStack = over.heroStack ?? 6000;
  const hero = seat(4, heroStack, 0, { hole: over.hole ?? '7c 2d' });
  const players = [
    seat(1, 0, shove, { is_all_in: true }),
    seat(2, 9000, 0, { is_folded: true }),
    seat(3, 8000, 0, { is_folded: true }),
    hero,
    seat(5, 7000, 100),
    seat(6, 12000, 200),
  ];
  const gs = {
    players,
    communityCards: [],
    pot: shove + 300 + 150,
    currentBet: shove,
    minRaise: Math.max(BB, shove - BB),
    lastRaise: Math.max(BB, shove - BB),
    stage: 'preflop',
    gameVariant: 'nlh',
    gameMode: over.mode ?? 'tournament',
    bigBlind: BB,
    ante: 25,
    dealerSeat: 4,
    toCall: shove,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: shove + Math.max(BB, shove - BB),
    maxRaiseTo: heroStack,
    bettingStructure: 'no_limit',
    actionHistory: [
      { stage: 'preflop', seat: 5, userId: 'p5', action: 'sb', amount: 100 },
      { stage: 'preflop', seat: 6, userId: 'p6', action: 'bb', amount: 200 },
      {
        stage: 'preflop',
        seat: 1,
        userId: 'p1',
        action: 'all_in',
        amount: shove,
        isFullRaise: shove - BB >= BB,
      },
      { stage: 'preflop', seat: 2, userId: 'p2', action: 'fold', amount: 0 },
      { stage: 'preflop', seat: 3, userId: 'p3', action: 'fold', amount: 0 },
    ],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

/** PLO5 turn on a paired board: a micro stack shoves 2BB into the horse. */
function ploPaired(
  over: { shove?: number; heroStack?: number; variant?: string; hole?: string } = {}
) {
  const shove = over.shove ?? 2 * BB;
  const heroStack = over.heroStack ?? 8000;
  const hero = seat(6, heroStack, 0, {
    hole: over.hole ?? 'Th Qd 6d Qc 7d',
    totalInvested: 400,
  });
  const villain = seat(2, 0, shove, { is_all_in: true, totalInvested: 400 + shove });
  const gs = {
    players: [villain, hero],
    communityCards: cards('6h 7c Jd Js'),
    pot: 900 + shove,
    currentBet: shove,
    minRaise: shove,
    lastRaise: shove,
    stage: 'turn',
    gameVariant: over.variant ?? 'plo5',
    gameMode: 'tournament',
    bigBlind: BB,
    dealerSeat: 2,
    toCall: shove,
    legalActions: ['fold', 'call'],
    bettingStructure: 'pot_limit',
    actionHistory: [
      { stage: 'turn', seat: 6, userId: 'p6', action: 'check', amount: 0 },
      { stage: 'turn', seat: 2, userId: 'p2', action: 'all_in', amount: shove, isFullRaise: true },
    ],
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

const fold: HorseDecision = { action: 'fold', thinkTime: 1234 };

afterEach(() => HorseMind.reset());

describe('shortAllInSpot / shortAllInCallFloor (Dan 2026-10-26)', () => {
  it('a 2.5BB shove against a 30BB horse in a tournament is the spot', () => {
    const s = preflop();
    const spot = shortAllInSpot(s.hero, s.gs);
    expect(spot).not.toBeNull();
    expect(spot!.shoveBB).toBeCloseTo(2.5);
    expect(spot!.heroBB).toBeCloseTo(30);
  });

  it('turns a fold into a call, keeping the brain think time', () => {
    const s = preflop();
    const out = shortAllInCallFloor(fold, s.hero, s.gs);
    expect(out.action).toBe('call');
    expect(out.amount).toBe(500);
    expect(out.thinkTime).toBe(1234);
  });

  it('never touches a call, raise or shove the brain already chose', () => {
    const s = preflop();
    for (const d of [
      { action: 'call', amount: 500, thinkTime: 1 },
      { action: 'raise', amount: 1400, thinkTime: 1 },
      { action: 'all_in', thinkTime: 1 },
    ] as HorseDecision[]) {
      expect(shortAllInCallFloor(d, s.hero, s.gs)).toBe(d);
    }
  });

  it('a cash game in the same spot is unaffected', () => {
    const s = preflop({ mode: 'cash' });
    expect(shortAllInSpot(s.hero, s.gs)).toBeNull();
    expect(shortAllInCallFloor(fold, s.hero, s.gs)).toBe(fold);
  });

  it('a 19BB horse is unaffected; exactly 20BB is covered', () => {
    const short = preflop({ heroStack: 19 * BB });
    expect(shortAllInSpot(short.hero, short.gs)).toBeNull();
    expect(shortAllInCallFloor(fold, short.hero, short.gs)).toBe(fold);
    const twenty = preflop({ heroStack: 20 * BB });
    expect(shortAllInCallFloor(fold, twenty.hero, twenty.gs).action).toBe('call');
  });

  it('a shove of 3BB or more is unaffected', () => {
    for (const shove of [3 * BB, 4 * BB, 10 * BB]) {
      const s = preflop({ shove });
      expect(shortAllInSpot(s.hero, s.gs)).toBeNull();
      expect(shortAllInCallFloor(fold, s.hero, s.gs)).toBe(fold);
    }
    const under = preflop({ shove: 3 * BB - 1 });
    expect(shortAllInCallFloor(fold, under.hero, under.gs).action).toBe('call');
  });

  it('a raise over the short all in by a player with chips is not the spot', () => {
    const s = preflop();
    s.gs.players[4] = seat(5, 5000, 2000);
    s.gs.currentBet = 2000;
    s.gs.toCall = 2000;
    expect(shortAllInSpot(s.hero, s.gs)).toBeNull();
  });

  it('multiway: an earlier caller of the short all in does not stop the call', () => {
    const s = preflop();
    s.gs.players[1] = seat(2, 8500, 500);
    s.gs.pot += 500;
    expect(shortAllInCallFloor(fold, s.hero, s.gs).action).toBe('call');
  });

  it('a short all in for less than the big blind, facing it from the small blind', () => {
    const s = preflop({ shove: 150 });
    s.hero.bet = 100;
    s.hero.totalInvested = 100;
    s.gs.players[4] = seat(5, 0, 0, { is_folded: true });
    s.gs.currentBet = 200;
    s.gs.toCall = 100;
    expect(shortAllInCallFloor(fold, s.hero, s.gs).action).toBe('call');
  });

  it('the amount to ADD being under 3BB also counts (a short all in after a big pot)', () => {
    const s = ploPaired({ shove: BB });
    s.gs.players[0].totalInvested = 30 * BB; // the shover put most of its chips in earlier
    s.hero.cards = cards('Ah Kd 2c 3s 9h');
    s.gs.communityCards = cards('6h 7c Jd 2s');
    const spot = shortAllInSpot(s.hero, s.gs);
    expect(spot!.toCallBB).toBeCloseTo(1);
    expect(shortAllInCallFloor(fold, s.hero, s.gs).action).toBe('call');
  });

  it('postflop, only a hand measured as drawing dead keeps its fold', () => {
    const s = ploPaired();
    s.gs.communityCards = cards('6h 7c Jd 2s');
    expect(shortAllInCallFloor(fold, s.hero, s.gs, 0.01).action).toBe('fold');
    expect(shortAllInCallFloor(fold, s.hero, s.gs, 0.06).action).toBe('call');
    expect(shortAllInCallFloor(fold, s.hero, s.gs, null).action).toBe('call');
    // Preflop, equity never folds it.
    const p = preflop();
    expect(shortAllInCallFloor(fold, p.hero, p.gs, 0.01).action).toBe('call');
  });

  it('the drawing-dead check is measured only when the floor would otherwise call postflop', () => {
    let asked = 0;
    const measure = (value: number) => () => {
      asked++;
      return value;
    };
    const p = preflop();
    expect(shortAllInCallFloor(fold, p.hero, p.gs, measure(0.01)).action).toBe('call');
    expect(asked).toBe(0);
    const s = ploPaired();
    s.gs.communityCards = cards('6h 7c Jd 2s');
    const call: HorseDecision = { action: 'call', amount: 2 * BB, thinkTime: 900 };
    expect(shortAllInCallFloor(call, s.hero, s.gs, measure(0.01))).toBe(call);
    expect(asked).toBe(0);
    expect(shortAllInCallFloor(fold, s.hero, s.gs, measure(0.01)).action).toBe('fold');
    expect(shortAllInCallFloor(fold, s.hero, s.gs, measure(0.2)).action).toBe('call');
    expect(shortAllInCallFloor(fold, s.hero, s.gs, () => null).action).toBe('call');
    expect(asked).toBe(2);
  });

  it('all in or fold: the call is an all in', () => {
    const s = preflop();
    s.gs.legalActions = ['fold', 'all_in'];
    s.gs.allInOrFold = true;
    const out = shortAllInCallFloor(fold, s.hero, s.gs);
    expect(out.action).toBe('all_in');
    expect(out.amount).toBeUndefined();
  });

  it('a paired-board fold that is a real stack-off keeps priority', () => {
    // 20BB+ horse, but it has put most of its chips in already: the 2BB call
    // leaves it all in.
    const s = ploPaired({ heroStack: 2 * BB });
    s.hero.totalInvested = 30 * BB;
    expect(shortAllInSpot(s.hero, s.gs)).not.toBeNull();
    expect(pairedBoardFoldYieldsToShortAllIn(s.hero, s.gs)).toBe(false);
    expect(shortAllInCallFloor(fold, s.hero, s.gs).action).toBe('fold');
  });
});

describe('HorseLogic.decide obeys it end to end', () => {
  const SEEDS = [1, 7, 42, 99, 2026];
  const STYLES = ['tag', 'lag', 'balanced', 'tricky', 'grinder'] as const;

  it('7-2 offsuit and a spread of trash call a 2.5BB shove with 30BB, every style and seed', () => {
    for (const hole of ['7c 2d', '8s 3h', '9d 2c', 'Jc 4s', 'Ks 2d', '5h 5d', 'Ac Kd']) {
      for (const seed of SEEDS) {
        const s = preflop({ hole });
        seedFastRandom(seed);
        const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
        expect(['call', 'raise', 'all_in'], `${hole} seed ${seed}`).toContain(d.action);
      }
    }
    for (const style of STYLES) {
      const s = preflop();
      seedFastRandom(3);
      expect(HorseLogic.decide(s.hero, s.gs, style, {}, { mind: false }).action).toBe('call');
    }
  });

  it('the tightest profile there is still calls', () => {
    const s = preflop();
    seedFastRandom(5);
    const d = HorseLogic.decide(
      s.hero,
      s.gs,
      'tag',
      { tightness: 5, aggression: 0.2, bluffFreq: 0 },
      { mind: false }
    );
    expect(d.action).toBe('call');
  });

  it('the decision receipt stays valid at the worker boundary', () => {
    const s = preflop();
    seedFastRandom(11);
    const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
    expect(d.action).toBe('call');
    expect(d.policyGraph?.finalAction).toEqual({ action: 'call', amount: 500 });
    expect(horseDecisionReceiptIsValid(d, 'nlh')).toBe(true);
    expect(horseDecisionReceiptIsValid(d, 'nlh', { player: s.hero, gameState: s.gs })).toBe(true);
    expect(horseDecisionReceiptRefusal(d, 'nlh', { player: s.hero, gameState: s.gs })).toBeNull();
  });

  it('the worker boundary admits a fold turned into a call only in the short all-in spot', () => {
    const s = preflop();
    seedFastRandom(11);
    const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
    const flipped = d.policyGraph?.transitions.some(
      (t) => t.node === 'wager_rules' && t.before?.action === 'fold' && t.after.action === 'call'
    );
    expect(flipped).toBe(true);
    // The same receipt, presented for a cash game, is not a rule the floor
    // could have applied, so the worker answer is refused.
    const cash = preflop({ mode: 'cash' });
    expect(horseDecisionReceiptIsValid(d, 'nlh', { player: cash.hero, gameState: cash.gs })).toBe(
      false
    );
    expect(horseDecisionReceiptRefusal(d, 'nlh', { player: cash.hero, gameState: cash.gs })).toBe(
      'policy_graph'
    );
  });

  it('postflop multiway: a live hand calls the short all in whatever the other callers hold', () => {
    // Flop K-7-2, the horse holds 7-3 (a middle pair): a 2BB micro stack is all
    // in and two big stacks have already called. Against all three ranges the
    // brain may price the pair low; heads up against one unknown hand it is
    // far from dead, so the floor calls.
    for (const seed of SEEDS) {
      const hero = seat(4, 6000, 0, { hole: '7d 3c', totalInvested: 200 });
      const gs = {
        players: [
          seat(1, 0, 400, { is_all_in: true, totalInvested: 600 }),
          seat(2, 9000, 400, { totalInvested: 600 }),
          seat(3, 8000, 400, { totalInvested: 600 }),
          hero,
        ],
        communityCards: cards('Ks 7h 2c'),
        pot: 800 + 1200,
        currentBet: 400,
        minRaise: BB,
        lastRaise: 400,
        stage: 'flop',
        gameVariant: 'nlh',
        gameMode: 'tournament',
        bigBlind: BB,
        dealerSeat: 4,
        toCall: 400,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        minRaiseTo: 800,
        maxRaiseTo: 6000,
        bettingStructure: 'no_limit',
        actionHistory: [
          { stage: 'flop', seat: 1, userId: 'p1', action: 'all_in', amount: 400 },
          { stage: 'flop', seat: 2, userId: 'p2', action: 'call', amount: 400 },
          { stage: 'flop', seat: 3, userId: 'p3', action: 'call', amount: 400 },
        ],
      } as unknown as HorseGameStateV2;
      expect(shortAllInSpot(hero, gs)).not.toBeNull();
      seedFastRandom(seed);
      const d = HorseLogic.decide(hero, gs, 'tag', { tightness: 5 }, { mind: false });
      expect(['call', 'raise', 'all_in'], `seed ${seed}`).toContain(d.action);
    }
  });

  it('PLO5 on a paired board: a 2BB shove from a micro stack is called, not folded', () => {
    const s = ploPaired();
    // The paired-board rule on its own would fold this (the bettor is all in).
    expect(
      ploPairedBoardMustFold({
        gameVariant: 'plo5',
        hiLo: false,
        multiBoard: false,
        board: s.gs.communityCards,
        hero: s.hero,
        players: s.gs.players,
        currentBet: s.gs.currentBet,
        toCall: s.gs.toCall,
        pot: s.gs.pot,
      })
    ).toBe(true);
    for (const seed of SEEDS) {
      seedFastRandom(seed);
      const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
      expect(d.action, `seed ${seed}`).toBe('call');
      expect(horseDecisionReceiptIsValid(d, 'plo5')).toBe(true);
    }
  });

  it('the paired-board fold still folds a real stack-off', () => {
    // Same board, same hand, a 20BB shove into a 30BB horse: not a short all in.
    const s = ploPaired({ shove: 20 * BB, heroStack: 30 * BB });
    for (const seed of SEEDS) {
      seedFastRandom(seed);
      const d = HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { mind: false });
      expect(d.action, `seed ${seed}`).toBe('fold');
      expect(horseDecisionReceiptIsValid(d, 'plo5')).toBe(true);
    }
  });
});
