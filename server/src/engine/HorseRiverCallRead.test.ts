/**
 * RIVER CALL READ (2026-10-25) - what a river CALLER showed down.
 *
 * Dan ruled that a hand whose last river decision was a call is shown at
 * showdown. Humans see it, so the horses learn from it too (CLAUDE.md 10.5):
 * the caller-side mirror of the V16 big-bet read in HorseDeepReads.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

type Act = {
  userId: string;
  action: string;
  amount?: number;
  stage: string;
  isFullRaise?: boolean;
};
type Shown = { user_id: string; mucked: boolean; hand_name?: string };

let handSeq = 0;
const feed = (actions: Act[], showdown: Shown[] | null, times = 1) => {
  for (let i = 0; i < times; i++)
    HorseMind.observeHandComplete(`rc:${++handSeq}`, actions as never, 2, showdown);
};
/** bettor bets the river, caller calls, both shown. */
const calledRiver = (caller: string, callerHand: string, mucked = false) =>
  [
    [
      { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
      { userId: caller, action: 'call', amount: 10, stage: 'river' },
    ],
    [
      { user_id: 'bettor', mucked: false, hand_name: 'Two Pair' },
      { user_id: caller, mucked, hand_name: callerHand },
    ],
  ] as [Act[], Shown[]];

beforeEach(() => HorseMind.reset());

describe('river call read: observation', () => {
  it('counts a shown river call once, and a one-pair-or-worse hand as light', () => {
    for (const name of ['Pair', 'High Card', 'One Pair']) feed(...calledRiver('cc', name), 3);
    for (const name of ['Two Pair', 'Flush']) feed(...calledRiver('cc', name), 2);
    const s = HorseMind.getStats('cc')!;
    expect(s.riverCallSD).toBe(13);
    expect(s.riverCallSDWeak).toBe(9);
    expect(HorseMind.riverCallLightTendency('cc')).toBeCloseTo(9 / 13, 5);
    // The bettor's own line is the V16 read, never a river call.
    expect(HorseMind.getStats('bettor')?.riverCallSD ?? 0).toBe(0);
  });

  it('is null under twelve shown calls', () => {
    feed(...calledRiver('cc', 'Pair'), 11);
    expect(HorseMind.getStats('cc')!.riverCallSD).toBe(11);
    expect(HorseMind.riverCallLightTendency('cc')).toBeNull();
    feed(...calledRiver('cc', 'Pair'));
    expect(HorseMind.riverCallLightTendency('cc')).toBe(1);
  });

  it('needs a shown hand: mucked or absent from the showdown teaches nothing', () => {
    feed(...calledRiver('cc', 'Pair', true), 6);
    feed(
      [
        { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'cc', action: 'call', amount: 10, stage: 'river' },
      ],
      [{ user_id: 'bettor', mucked: false, hand_name: 'Flush' }],
      6
    );
    feed(
      [
        { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'cc', action: 'call', amount: 10, stage: 'river' },
      ],
      null,
      6
    );
    expect(HorseMind.getStats('cc')?.riverCallSD ?? 0).toBe(0);
  });

  it("reads the player's LAST river action: a call that later raised is not a call", () => {
    feed(
      [
        { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'cc', action: 'call', amount: 10, stage: 'river' },
        { userId: 'other', action: 'raise', amount: 40, stage: 'river' },
        { userId: 'bettor', action: 'fold', stage: 'river' },
        { userId: 'cc', action: 'raise', amount: 120, stage: 'river' },
        { userId: 'other', action: 'call', amount: 80, stage: 'river' },
      ],
      [
        { user_id: 'cc', mucked: false, hand_name: 'Pair' },
        { user_id: 'other', mucked: false, hand_name: 'Pair' },
      ]
    );
    expect(HorseMind.getStats('cc')!.riverCallSD).toBe(0);
    // ... while the player who called the raise last is counted, once.
    expect(HorseMind.getStats('other')).toMatchObject({ riverCallSD: 1, riverCallSDWeak: 1 });
  });

  it('a check-raise that gets called counts the caller, and earlier-street calls never count', () => {
    feed(
      [
        { userId: 'cc', action: 'call', amount: 10, stage: 'turn' },
        { userId: 'cc', action: 'check', stage: 'river' },
        { userId: 'bettor', action: 'check', stage: 'river' },
      ],
      [
        { user_id: 'cc', mucked: false, hand_name: 'Pair' },
        { user_id: 'bettor', mucked: false, hand_name: 'High Card' },
      ]
    );
    expect(HorseMind.getStats('cc')?.riverCallSD ?? 0).toBe(0);
    feed(
      [
        { userId: 'cc', action: 'check', stage: 'river' },
        { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'cc', action: 'raise', amount: 30, stage: 'river' },
        { userId: 'bettor', action: 'call', amount: 20, stage: 'river' },
      ],
      [
        { user_id: 'cc', mucked: false, hand_name: 'Straight' },
        { user_id: 'bettor', mucked: false, hand_name: 'High Card' },
      ]
    );
    expect(HorseMind.getStats('cc')?.riverCallSD ?? 0).toBe(0);
    expect(HorseMind.getStats('bettor')).toMatchObject({ riverCallSD: 1, riverCallSDWeak: 1 });
  });

  it('an all-in for no more than the standing river bet is a call; one above it is a raise', () => {
    // Calling all-in short (amount 6 under a 10 bet) and all-in for exactly 10.
    for (const amount of [6, 10])
      feed(
        [
          { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
          { userId: 'cc', action: 'all_in', amount, stage: 'river' },
        ],
        [
          { user_id: 'bettor', mucked: false, hand_name: 'Flush' },
          { user_id: 'cc', mucked: false, hand_name: 'Pair' },
        ]
      );
    expect(HorseMind.getStats('cc')).toMatchObject({ riverCallSD: 2, riverCallSDWeak: 2 });
    // A short all-in raise (not a full raise) still raised: not a call.
    feed(
      [
        { userId: 'bettor', action: 'bet', amount: 10, stage: 'river' },
        { userId: 'ai', action: 'all_in', amount: 14, isFullRaise: false, stage: 'river' },
        { userId: 'bettor', action: 'call', amount: 4, stage: 'river' },
      ],
      [
        { user_id: 'bettor', mucked: false, hand_name: 'Flush' },
        { user_id: 'ai', mucked: false, hand_name: 'Pair' },
      ]
    );
    expect(HorseMind.getStats('ai')?.riverCallSD ?? 0).toBe(0);
    // An all-in into an unbet river is a bet, not a call.
    feed(
      [{ userId: 'ai2', action: 'all_in', amount: 50, isFullRaise: true, stage: 'river' }],
      [{ user_id: 'ai2', mucked: false, hand_name: 'Pair' }]
    );
    expect(HorseMind.getStats('ai2')?.riverCallSD ?? 0).toBe(0);
  });

  it('is idempotent per hand key', () => {
    const [a, s] = calledRiver('cc', 'Pair');
    HorseMind.observeHandComplete('dupe:rc', a as never, 2, s);
    HorseMind.observeHandComplete('dupe:rc', a as never, 2, s);
    expect(HorseMind.getStats('cc')!.riverCallSD).toBe(1);
  });

  it('lands in the scoped bucket too, and survives the import path', () => {
    const [a, s] = calledRiver('cc', 'Pair');
    for (let i = 0; i < 5; i++)
      HorseMind.observeHandComplete(`scoped:${i}`, a as never, 2, s, 'holdem:hu');
    expect(HorseMind.getScopedStats('cc', 'holdem:hu')).toMatchObject({
      riverCallSD: 5,
      riverCallSDWeak: 5,
    });
    HorseMind.reset();
    HorseMind.importStats([{ user_id: 'cc', hands: 19, riverCallSD: 14, riverCallSDWeak: 8 }]);
    expect(HorseMind.riverCallLightTendency('cc')).toBeCloseTo(8 / 14, 5);
  });
});

describe('river call read: decision', () => {
  const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
  function riverBetRate(
    oppId: string,
    heroCards: Card[],
    trials: number,
    oppIsHorse = false
  ): number {
    let bets = 0;
    for (let seed = 1; seed <= trials; seed++) {
      seedFastRandom(seed * 7919);
      const hero = {
        seat: 1,
        user_id: 'hero',
        username: 'hero',
        stack: 200,
        bet: 0,
        totalInvested: 20,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
        cards: heroCards,
      } as SeatPlayer;
      const opp = {
        seat: 3,
        user_id: oppId,
        username: oppId,
        stack: 200,
        bet: 0,
        totalInvested: 20,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: oppIsHorse,
        cards: [],
      } as never as SeatPlayer;
      const history = [
        { seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
        { seat: 3, userId: oppId, action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
        { seat: 3, userId: oppId, action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
        { seat: 1, userId: 'hero', action: 'bet', amount: 7, timestamp: 4, stage: 'flop' },
        { seat: 3, userId: oppId, action: 'call', amount: 7, timestamp: 5, stage: 'flop' },
        { seat: 3, userId: oppId, action: 'check', amount: 0, timestamp: 6, stage: 'turn' },
        { seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 7, stage: 'turn' },
        { seat: 3, userId: oppId, action: 'check', amount: 0, timestamp: 8, stage: 'river' },
      ] as ActionRecord[];
      const gs = {
        players: [hero, opp],
        communityCards: [
          c('K', 'spades'),
          c('8', 'diamonds'),
          c('3', 'clubs'),
          c('J', 'hearts'),
          c('2', 'spades'),
        ],
        pot: 40,
        currentBet: 0,
        minRaise: 2,
        stage: 'river',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: history,
        gameMode: 'cash',
        format: 'cash',
      } as HorseGameStateV2;
      const dec = HorseLogic.decide(hero, gs, 'balanced', {}, {});
      if (dec.action === 'bet' || dec.action === 'raise' || dec.action === 'all_in') bets++;
    }
    return bets / trials;
  }
  /** Twelve shown river calls each: one light caller, one who only calls strong. */
  function seedReads() {
    // Production observes every hand with its scope; the read is the game's
    // own bucket (heads-up hold'em here).
    for (const [id, hand] of [
      ['light-caller', 'Pair'],
      ['strong-caller', 'Two Pair'],
    ] as const) {
      const [a, s] = calledRiver(id, hand);
      for (let i = 0; i < 12; i++)
        HorseMind.observeHandComplete(`seed:${id}:${i}`, a as never, 2, s, 'holdem:hu');
    }
    HorseMind.setDecisionScope('holdem:hu');
    expect(HorseMind.riverCallLightTendency('light-caller')).toBe(1);
    expect(HorseMind.riverCallLightTendency('strong-caller')).toBe(0);
    HorseMind.setDecisionScope(null);
  }

  it('bluffs a light river caller less than an opponent who calls only strong', () => {
    const air = [c('6', 'hearts'), c('5', 'diamonds')];
    const before = riverBetRate('strong-caller', air, 600);
    seedReads();
    const vsLight = riverBetRate('light-caller', air, 600);
    const vsStrong = riverBetRate('strong-caller', air, 600);
    // A strong-only caller's read (0) is below the bar: no change at all.
    expect(vsStrong).toBe(before);
    expect(before).toBeGreaterThan(0.05);
    expect(vsLight).toBeLessThan(vsStrong);
  });

  it('value-bets a light river caller thinner', () => {
    // Bottom pair on K 8 3 J 2, checked to hero on the river: a thin value
    // bet the bar usually refuses. Measured 0.63 vs 0.27 at 300 seeds.
    const thin = [c('3', 'hearts'), c('7', 'clubs')];
    seedReads();
    const vsLight = riverBetRate('light-caller', thin, 600);
    const vsStrong = riverBetRate('strong-caller', thin, 600);
    expect(vsLight).toBeGreaterThan(vsStrong + 0.15);
  });

  it('reads a horse opponent exactly as it reads a human one (CLAUDE.md 10.5)', () => {
    seedReads();
    const thin = [c('3', 'hearts'), c('7', 'clubs')];
    expect(riverBetRate('light-caller', thin, 300, true)).toBe(
      riverBetRate('light-caller', thin, 300, false)
    );
  });
});

describe('river call read: calibration and the hands that cannot teach it (2026-10-26)', () => {
  const seed = (id: string, weak: number, strong: number, scope?: string) => {
    for (let i = 0; i < weak; i++)
      HorseMind.observeHandComplete(
        `cal:${id}:w${i}`,
        calledRiver(id, 'Pair')[0] as never,
        2,
        calledRiver(id, 'Pair')[1],
        scope as never
      );
    for (let i = 0; i < strong; i++)
      HorseMind.observeHandComplete(
        `cal:${id}:s${i}`,
        calledRiver(id, 'Flush')[0] as never,
        2,
        calledRiver(id, 'Flush')[1],
        scope as never
      );
  };

  it("does not fire against an ordinary hold'em caller, fires against a light one", () => {
    seed('ordinary', 6, 8); // 0.43: about the hold'em base of 0.40
    seed('light', 10, 4); // 0.71: base + margin (0.65) cleared
    expect(HorseMind.riverCallLightRead('ordinary')).toBeNull();
    const k = HorseMind.riverCallLightRead('light')!;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1);
  });

  it("judges a call by its own game: an Omaha one-pair call is light, a hold'em one is not", () => {
    seed('pa', 5, 9, 'omaha:hu'); // 0.36 in Omaha, base 0.04
    seed('pa', 5, 9, 'holdem:hu'); // 0.36 in hold'em, base 0.40
    HorseMind.setDecisionScope('omaha:hu');
    expect(HorseMind.riverCallLightRead('pa')).not.toBeNull();
    HorseMind.setDecisionScope('holdem:hu');
    expect(HorseMind.riverCallLightRead('pa')).toBeNull();
    HorseMind.setDecisionScope(null);
  });

  it('takes no sample from a hand flagged as unable to teach it (hi-lo, multi-board)', () => {
    const [a, s] = calledRiver('lo', 'Pair');
    HorseMind.observeHandComplete('hilo:1', a as never, 2, s, 'omaha:hu', false, false);
    expect(HorseMind.getStats('lo')?.riverCallSD ?? 0).toBe(0);
    HorseMind.observeHandComplete('hilo:2', a as never, 2, s, 'omaha:hu', false, true);
    expect(HorseMind.getStats('lo')!.riverCallSD).toBe(1);
  });

  it('the live settlement path flags hi-lo and multi-board hands', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../services/supabase/handHistory.ts', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/riverCallSample:\s*!variantInfo\(params\.gameVariant\)\.isHiLo &&/);
    expect(src).toMatch(
      /params\.communityCards2, params\.communityCards3, \.\.\.\(params\.ritBoards/
    );
  });
});
