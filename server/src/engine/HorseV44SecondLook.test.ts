/**
 * V44 (2026-09-05) - THE SECOND LOOK
 *
 * From the deep audit: "Monte Carlo runs 120-450 iterations (+/-4.6pp at
 * PLO6) then the horse thinks for seconds doing nothing." The engine replays
 * a close decision at six times the sample inside the think time it was
 * already going to spend, from the same strategy dice, and lets the deeper
 * read overturn a marginal call / fold / all-in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  simulateEquity,
  variantInfo,
  seedFastRandom,
  saveFastRandom,
  restoreFastRandom,
  setEquityDepth,
  currentEquityDepth,
} from './HorseEval.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';
import type { Card, SeatPlayer, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x44);
  HorseMind.reset();
  setEquityDepth(1);
});

const SUIT: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
function c(spec: string): Card {
  return { rank: spec.slice(0, -1) as Card['rank'], suit: SUIT[spec.slice(-1)] as Card['suit'] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

/** Standard deviation of repeated equity estimates. */
function spread(depth: number, runs = 40): number {
  const vi = variantInfo('plo6');
  const hole = cc('As', 'Kd', 'Qh', 'Jc', '9s', '8d');
  const board = cc('Ts', '7h', '2c');
  setEquityDepth(depth);
  const xs: number[] = [];
  for (let i = 1; i <= runs; i++) {
    seedFastRandom(i * 2654435761);
    xs.push(simulateEquity(hole, board, 2, vi, vi.iterations, undefined, false));
  }
  setEquityDepth(1);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

describe('V44 equity depth', () => {
  it('a deeper sample is a tighter estimate - the spread at 6x is well under the spread at 1x', () => {
    const shallow = spread(1);
    const deep = spread(6);
    expect(deep).toBeLessThan(shallow * 0.7);
  });

  it('the depth is bracketed by decide() and never leaks to the next decision', () => {
    const hero = {
      seat: 2,
      user_id: 'h',
      username: 'h',
      stack: 200,
      bet: 0,
      totalInvested: 4,
      cards: cc('Ah', 'Kh'),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    } as SeatPlayer;
    const gs = {
      players: [hero, { ...hero, seat: 3, user_id: 'v', bet: 12, stack: 188 }],
      communityCards: cc('Kd', '7s', '2c'),
      pot: 20,
      currentBet: 12,
      minRaise: 12,
      stage: 'flop' as HandStage,
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 3,
      gameMode: 'cash' as const,
      format: 'cash',
      actionHistory: [],
    } as unknown as HorseGameStateV2;
    HorseLogic.decide(hero, gs, 'balanced', {}, { deepEquity: 6 });
    expect(currentEquityDepth()).toBe(1);
    // a throw inside the replay still resets it
    const broken = { ...gs, players: null } as unknown as HorseGameStateV2;
    HorseLogic.decide(hero, broken, 'balanced', {}, { deepEquity: 6 });
    expect(currentEquityDepth()).toBe(1);
  });

  it('the RNG bracket: save, replay from the same point, restore', () => {
    seedFastRandom(99);
    const before = saveFastRandom();
    const vi = variantInfo('nlh');
    const a = simulateEquity(cc('Ah', 'Kh'), cc('Kd', '7s', '2c'), 1, vi, 200, undefined, false);
    const after = saveFastRandom();
    restoreFastRandom(before);
    const b = simulateEquity(cc('Ah', 'Kh'), cc('Kd', '7s', '2c'), 1, vi, 200, undefined, false);
    expect(b).toBe(a);
    restoreFastRandom(after);
    expect(saveFastRandom()).toBe(after);
  });
});

describe('V44 second look plan and verdict', () => {
  const T = ServerTableEngineTurns;
  it('earns a second look only on a close spot with time to spend', () => {
    const call = { action: 'call', thinkTime: 3000 };
    expect(T.secondLookPlan(call, 20, 100, 2, 3000, 1)).toEqual({ afterMs: 400 });
    expect(T.secondLookPlan(call, 20, 100, 2, 1800, 1)).toEqual({ afterMs: 600 > 400 ? 400 : 600 });
    // not facing a bet
    expect(T.secondLookPlan(call, 0, 100, 2, 3000, 1)).toBeNull();
    // pot too small (20bb at bb 2 = 40 chips)
    expect(T.secondLookPlan(call, 10, 30, 2, 3000, 1)).toBeNull();
    // a sizing answer is not the sample's call
    expect(T.secondLookPlan({ action: 'raise', thinkTime: 3000 }, 20, 100, 2, 3000, 1)).toBeNull();
    // no time
    expect(T.secondLookPlan(call, 20, 100, 2, 1200, 1)).toBeNull();
    // the governor is shedding load
    expect(T.secondLookPlan(call, 20, 100, 2, 3000, 0.7)).toBeNull();
    // the replay always lands well inside the think time
    const plan = T.secondLookPlan(call, 20, 100, 2, 1500, 1)!;
    expect(plan.afterMs).toBeLessThan(1500);
  });

  it('only a different call/fold/all-in overturns the fast answer', () => {
    expect(T.secondLookVerdict({ action: 'call', amount: 20 }, { action: 'fold' })).toEqual({
      action: 'fold',
      amount: undefined,
    });
    expect(T.secondLookVerdict({ action: 'fold' }, { action: 'call', amount: 20 })).toEqual({
      action: 'call',
      amount: 20,
    });
    expect(
      T.secondLookVerdict({ action: 'call', amount: 20 }, { action: 'call', amount: 20 })
    ).toBeNull();
    expect(
      T.secondLookVerdict({ action: 'call', amount: 20 }, { action: 'raise', amount: 60 })
    ).toBeNull();
    expect(T.secondLookVerdict({ action: 'fold' }, { action: 'all_in' })).toEqual({
      action: 'all_in',
      amount: undefined,
    });
  });
});
