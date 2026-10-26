import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Eval from './HorseEval.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import type { SeatPlayer, ActionRecord } from '../types.js';
// Public action snapshot from f6fb0a8c (October 26); no opponent hole cards.
// Only MC equity is controlled to exercise the already committed branch.
const seats = [
  [1, 46.73, 20.18, 32.73, 0, 0, 0],
  [2, 58.85, 0, 0.5, 0, 0, 1],
  [4, 124.2, 59.54, 72.09, 0, 0, 0],
  [5, 46.83, 0, 0, 0, 0, 1],
  [6, 149.74, 0, 0, 0, 0, 1],
  [7, 33.99, 0, 0, 0, 0, 1],
  [8, 142.61, 0, 0, 0, 0, 1],
  [9, 51.33, 0, 0, 0, 0, 1],
];
const history = [
  {
    seat: 1,
    userId: 'hero',
    action: 'sb',
    amount: 0.25,
    stage: 'preflop',
    timestamp: 1793027289605,
  },
  {
    seat: 2,
    userId: 'seat2',
    action: 'bb',
    amount: 0.5,
    stage: 'preflop',
    timestamp: 1793027289605,
  },
  {
    seat: 4,
    userId: 'seat4',
    action: 'raise',
    amount: 1.22,
    stage: 'preflop',
    isFullRaise: true,
    timestamp: 1793027297220,
  },
  {
    seat: 5,
    userId: 'seat5',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027308040,
  },
  {
    seat: 6,
    userId: 'seat6',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027313344,
  },
  {
    seat: 7,
    userId: 'seat7',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027315560,
  },
  {
    seat: 8,
    userId: 'seat8',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027317244,
  },
  {
    seat: 9,
    userId: 'seat9',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027318808,
  },
  {
    seat: 1,
    userId: 'hero',
    action: 'call',
    amount: 0.97,
    stage: 'preflop',
    timestamp: 1793027322263,
  },
  {
    seat: 2,
    userId: 'seat2',
    action: 'fold',
    amount: 0,
    stage: 'preflop',
    timestamp: 1793027324671,
  },
  { seat: 1, userId: 'hero', action: 'check', amount: 0, stage: 'flop', timestamp: 1793027339033 },
  {
    seat: 4,
    userId: 'seat4',
    action: 'bet',
    amount: 2.41,
    stage: 'flop',
    isFullRaise: true,
    timestamp: 1793027350277,
  },
  {
    seat: 1,
    userId: 'hero',
    action: 'raise',
    amount: 11.33,
    stage: 'flop',
    isFullRaise: true,
    timestamp: 1793027352816,
  },
  {
    seat: 4,
    userId: 'seat4',
    action: 'call',
    amount: 8.92,
    stage: 'flop',
    timestamp: 1793027363168,
  },
  {
    seat: 1,
    userId: 'hero',
    action: 'bet',
    amount: 20.18,
    stage: 'turn',
    isFullRaise: true,
    timestamp: 1793027367668,
  },
  {
    seat: 4,
    userId: 'seat4',
    action: 'raise',
    amount: 59.54,
    stage: 'turn',
    isFullRaise: true,
    timestamp: 1793027375749,
  },
] as ActionRecord[];
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('committed calls preserve the existing raised-hand discipline', () => {
  it('AQ trips facing a turn raise calls without adding the unnecessary short shove', () => {
    const players = seats.map(
      ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) =>
        ({
          seat,
          user_id: seat === 1 ? 'hero' : `seat${seat}`,
          username: 'offline',
          stack,
          bet,
          totalInvested,
          deadInvested,
          individualAnteInvested,
          is_folded: !!(flags & 1),
          is_all_in: !!(flags & 2),
          is_sitting_out: false,
          cards:
            seat === 1
              ? [
                  { rank: 'A', suit: 'spades' },
                  { rank: 'Q', suit: 'hearts' },
                ]
              : [],
        }) as SeatPlayer
    );
    const hero = players[0];
    const gs = {
      stateSchemaVersion: 1,
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      asset: 'chips',
      chipUnit: 0.01,
      players,
      heroSeat: 1,
      currentPlayerSeat: 1,
      communityCards: [
        { rank: 'T', suit: 'spades' },
        { rank: 'A', suit: 'hearts' },
        { rank: '7', suit: 'clubs' },
        { rank: 'A', suit: 'diamonds' },
      ],
      stage: 'turn',
      pot: 105.32,
      contestablePot: 105.32,
      currentBet: 59.54,
      toCall: 39.36,
      minRaise: 39.36,
      minRaiseTo: null,
      maxRaiseTo: null,
      legalActions: ['fold', 'call', 'all_in'],
      bigBlind: 0.5,
      dealerSeat: 9,
      actionHistory: history,
      rakeConfig: { percent: 10, cap: 1.25, noFlopNoDrop: true },
      bbjConfig: { enabled: true, feeBB: 0.6, minPotBB: 10, minPlayersDealt: 3 },
    } as HorseGameStateV2;
    const simulate = Eval.simulateEquity;
    vi.spyOn(Eval, 'simulateEquity').mockImplementation((...args) => {
      simulate(...args);
      return 0.8;
    });
    Eval.seedFastRandom(2601026);
    const d = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, telemetry: false });
    expect(d.action).toBe('call');
    expect(d.amount).toBe(39.36);
    expect(horseDecisionReceiptIsValid(d, 'nlh')).toBe(true);
    Eval.seedFastRandom(2601026);
    expect(
      HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        { mind: false, telemetry: false, committedRaiseDiscipline: false }
      ).action
    ).toBe('all_in');
    // A private set on a dry board retains the profitable raise path.
    hero.cards = [
      { rank: '7', suit: 'spades' },
      { rank: '7', suit: 'hearts' },
    ];
    gs.communityCards[3] = { rank: '2', suit: 'diamonds' };
    Eval.seedFastRandom(2601026);
    const strong = HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, telemetry: false });
    expect(strong.action).toBe('all_in');
    expect(horseDecisionReceiptIsValid(strong, 'nlh')).toBe(true);
  });
});
