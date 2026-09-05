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

  /**
   * 3-BET FREQUENCY AGAINST A NAMED OPENER.
   *
   * Mirrors cbetFreq, for the read that HorsePreflop actually consumes:
   * `ctx.raiserFoldTo3Bet` -> f3bScale = clamp(0.6 + f3b, 0.7, 1.45), applied
   * to the V7 3-bet bluff frequency. Hero holds a mid-strength hand in the
   * bluff window (not a value 3-bet), heads-up, in position, no callers -
   * the exact branch f3bScale gates.
   *
   * WHY THIS TEST EXISTS. Production telemetry shows v16_reads_f3b firing
   * 929,664 times in two days, which proves the read is CONSULTED and proves
   * nothing about whether it changes anything. Aggregating horse_mind_pairs
   * against each victim's current fold-to-3-bet showed a flat ~9.9% 3-bet rate
   * across every bucket from 9% folders to 71% folders - 351,758 opportunities
   * and no visible differentiation. That measurement is confounded (pair
   * counts accumulate for weeks while the f3b snapshot is current), so it
   * cannot convict on its own. This can: same seed, same cards, same spot,
   * only the opener's history differs.
   */
  function threeBetFreq(openerId: string, trials: number): number {
    let threeBets = 0;
    for (let seed = 1; seed <= trials; seed++) {
      seedFastRandom(seed * 7919);
      // KJo: comfortably inside the bluff band - too weak to be a value
      // 3-bet, too strong to be folded outright.
      const hero = mkPlayer({
        seat: 1,
        user_id: 'hero',
        cards: [c('K', 'hearts'), c('J', 'diamonds')],
        stack: 200,
        bet: 0,
        totalInvested: 0,
      });
      const opener = {
        seat: 3,
        user_id: openerId,
        username: openerId,
        stack: 194,
        bet: 6,
        totalInvested: 6,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
        cards: [],
      } as never as SeatPlayer;
      const history: ActionRecord[] = [
        { seat: 3, userId: openerId, action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      ] as ActionRecord[];
      const gs: HorseGameStateV2 = {
        players: [hero, opener],
        communityCards: [],
        pot: 9,
        currentBet: 6,
        minRaise: 6,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, {});
      // A 3-bet is an aggressive action putting in more than the 6 open.
      // NOTE the cast: at preflop the engine returns action 'raise' with an
      // amount (measured: 39 of 800 trials, amounts 23-24), but 'raise' is
      // NOT in the declared HorseDecision action union - which is
      // "fold" | "check" | "call" | "bet" | "all_in" | "discard". The runtime
      // is right and the type is wrong; typing to the union here would make
      // this test silently count zero. Worth fixing at the type, separately.
      const act = String((dec as unknown as { action: string }).action);
      const amt = Number((dec as unknown as { amount?: number }).amount ?? 0);
      if (act !== 'fold' && act !== 'call' && act !== 'check' && amt > 6) threeBets++;
    }
    return threeBets / trials;
  }

  /** Teach the mind that `id` folds to 3-bets `folds` times out of `outOf`. */
  function teachFoldTo3Bet(id: string, folds: number, outOf: number): void {
    for (let i = 0; i < outOf; i++) {
      feed(
        [
          { userId: id, action: 'raise', amount: 6, stage: 'preflop' },
          { userId: 'the-3bettor', action: 'raise', amount: 20, stage: 'preflop' },
          i < folds
            ? { userId: id, action: 'fold', stage: 'preflop' }
            : { userId: id, action: 'call', amount: 14, stage: 'preflop' },
        ],
        null
      );
    }
  }

  it('3-bets a proven fold-to-3-bet opener more than one who never folds', () => {
    teachFoldTo3Bet('nit-opener', 24, 30); // folds 80%
    teachFoldTo3Bet('rock-opener', 3, 30); // folds 10%

    expect(HorseMind.foldTo3BetOf('nit-opener')).toBeCloseTo(24 / 30, 5);
    expect(HorseMind.foldTo3BetOf('rock-opener')).toBeCloseTo(3 / 30, 5);

    const vsNit = threeBetFreq('nit-opener', 400);
    const vsRock = threeBetFreq('rock-opener', 400);
    // Measured 2026-09-05: 7.5% against the 80% folder, 2.3% against the 10%
    // folder - a 3.33x differentiation from the read alone, same seed, same
    // cards, same spot. This is the assertion telemetry cannot make.

    // f3bScale is 1.40 against the 80% folder and 0.70 against the 10% folder
    // - a 2x swing on the bluff branch. If these come back equal, the read is
    // consulted and discarded, which is the failure telemetry cannot see.
    expect(
      vsNit,
      `3-bet vs 80% folder ${(vsNit * 100).toFixed(1)}% must exceed vs 10% folder ${(vsRock * 100).toFixed(1)}%`
    ).toBeGreaterThan(vsRock);
  });

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
