/**
 * V16 DEEP READS — full-hand observation and its decision wiring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
let handSeq = 0;
const nextKey = () => `t1:${++handSeq}`;

function feed(
  actions: Array<{ userId: string; action: string; amount?: number; stage: string }>,
  showdown: Array<{ user_id: string; mucked: boolean; hand_name?: string }> | null = null,
  times = 1
) {
  for (let i = 0; i < times; i++) {
    HorseMind.observeHandComplete(nextKey(), actions as never, 2, showdown);
  }
}

const openerFoldsTo3Bet = [
  { userId: 'op', action: 'raise', amount: 6, stage: 'preflop' },
  { userId: '3b', action: 'raise', amount: 20, stage: 'preflop' },
  { userId: 'op', action: 'fold', stage: 'preflop' },
];
const openerCalls3Bet = [
  { userId: 'op', action: 'raise', amount: 6, stage: 'preflop' },
  { userId: '3b', action: 'raise', amount: 20, stage: 'preflop' },
  { userId: 'op', action: 'call', amount: 14, stage: 'preflop' },
];

describe('observeHandComplete', () => {
  it('fold-to-3-bet: counts opportunities and folds for the OPENER only', () => {
    feed(openerFoldsTo3Bet, null, 6);
    feed(openerCalls3Bet, null, 2);
    expect(HorseMind.foldTo3BetOf('op')).toBeCloseTo(6 / 8, 5);
    expect(HorseMind.foldTo3BetOf('3b')).toBeNull(); // the 3-bettor gains no f3b sample
  });

  it('fold-to-c-bet: callers facing the aggressor flop bet', () => {
    const hand = [
      { userId: 'pfr', action: 'raise', amount: 6, stage: 'preflop' },
      { userId: 'cc', action: 'call', amount: 6, stage: 'preflop' },
      { userId: 'pfr', action: 'bet', amount: 8, stage: 'flop' },
      { userId: 'cc', action: 'fold', stage: 'flop' },
    ];
    const handCall = [
      { userId: 'pfr', action: 'raise', amount: 6, stage: 'preflop' },
      { userId: 'cc', action: 'call', amount: 6, stage: 'preflop' },
      { userId: 'pfr', action: 'bet', amount: 8, stage: 'flop' },
      { userId: 'cc', action: 'call', amount: 8, stage: 'flop' },
    ];
    feed(hand, null, 9);
    feed(handCall, null, 3);
    expect(HorseMind.foldToCbetOf('cc')).toBeCloseTo(9 / 12, 5);
    // A non-aggressor flop bet is NOT a c-bet: nothing counted.
    feed(
      [
        { userId: 'pfr', action: 'raise', amount: 6, stage: 'preflop' },
        { userId: 'cc', action: 'call', amount: 6, stage: 'preflop' },
        { userId: 'cc', action: 'bet', amount: 8, stage: 'flop' },
        { userId: 'pfr', action: 'fold', stage: 'flop' },
      ],
      null,
      20
    );
    expect(HorseMind.foldToCbetOf('pfr')).toBeNull();
  });

  it('big-river-bet sizing tell: showdown value vs mucked air', () => {
    const bigBetShown = (name: string, mucked: boolean) =>
      [
        [
          { userId: 'bb1', action: 'bet', amount: 60, stage: 'river' },
          { userId: 'x', action: 'call', amount: 60, stage: 'river' },
        ],
        [{ user_id: 'bb1', mucked, hand_name: name }],
      ] as const;
    for (let i = 0; i < 4; i++) {
      const [a, s] = bigBetShown('Full House', false);
      feed(a as never, s as never);
    }
    for (let i = 0; i < 2; i++) {
      const [a, s] = bigBetShown('', true); // called and mucked = not value
      feed(a as never, s as never);
    }
    expect(HorseMind.bigBetValueTendency('bb1')).toBeCloseTo(4 / 6, 5);
    // Small river bets never count.
    feed(
      [
        { userId: 'bb2', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'x', action: 'call', amount: 10, stage: 'river' },
      ],
      [{ user_id: 'bb2', mucked: false, hand_name: 'Flush' }],
      10
    );
    expect(HorseMind.bigBetValueTendency('bb2')).toBeNull();
  });

  it('is idempotent per hand key', () => {
    const key = 'dupe:1';
    HorseMind.observeHandComplete(key, openerFoldsTo3Bet as never, 2, null);
    const before = HorseMind.foldTo3BetOf('op');
    HorseMind.observeHandComplete(key, openerFoldsTo3Bet as never, 2, null);
    expect(HorseMind.foldTo3BetOf('op')).toBe(before);
  });
});

describe('decision wiring', () => {
  function mkPlayer(over: Partial<SeatPlayer> & { cards: Card[] }): SeatPlayer {
    return {
      seat: 1,
      user_id: 'hero',
      username: 'hero',
      stack: 200,
      bet: 0,
      totalInvested: 0,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
      ...over,
    } as SeatPlayer;
  }

  function cbetFreq(oppId: string, trials: number): number {
    // Hero holds air with initiative on a dry board, heads-up vs oppId.
    let bets = 0;
    for (let seed = 1; seed <= trials; seed++) {
      seedFastRandom(seed * 4409);
      const hero = mkPlayer({ cards: [c('6', 'hearts'), c('5', 'diamonds')] });
      const opp = {
        seat: 3,
        user_id: oppId,
        username: oppId,
        stack: 200,
        bet: 0,
        totalInvested: 6,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
        cards: [],
      } as never as SeatPlayer;
      const history: ActionRecord[] = [
        { seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
        { seat: 3, userId: oppId, action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
      ] as ActionRecord[];
      const gs: HorseGameStateV2 = {
        players: [hero, opp],
        communityCards: [c('K', 'spades'), c('8', 'diamonds'), c('3', 'clubs')],
        pot: 13,
        currentBet: 0,
        minRaise: 2,
        stage: 'flop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, {});
      if (dec.action === 'bet') bets++;
    }
    return bets / trials;
  }

  it('c-bets a proven folder more than a proven station', () => {
    // Build the reads through real observation.
    for (let i = 0; i < 30; i++) {
      feed(
        [
          { userId: 'pfr', action: 'raise', amount: 6, stage: 'preflop' },
          { userId: 'folder-1', action: 'call', amount: 6, stage: 'preflop' },
          { userId: 'pfr', action: 'bet', amount: 8, stage: 'flop' },
          { userId: 'folder-1', action: 'fold', stage: 'flop' },
        ],
        null
      );
      feed(
        [
          { userId: 'pfr', action: 'raise', amount: 6, stage: 'preflop' },
          { userId: 'station-1', action: 'call', amount: 6, stage: 'preflop' },
          { userId: 'pfr', action: 'bet', amount: 8, stage: 'flop' },
          { userId: 'station-1', action: 'call', amount: 8, stage: 'flop' },
        ],
        null
      );
    }
    expect(HorseMind.foldToCbetOf('folder-1')).toBeCloseTo(1, 5);
    expect(HorseMind.foldToCbetOf('station-1')).toBeCloseTo(0, 5);
    const vsFolder = cbetFreq('folder-1', 400);
    const vsStation = cbetFreq('station-1', 400);
    expect(vsFolder).toBeGreaterThan(vsStation + 0.05);
  });
});
