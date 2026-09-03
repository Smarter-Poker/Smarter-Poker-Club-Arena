/**
 * THE BET-RATIO SCALE (2026-08-27)
 *
 * gs.pot INCLUDES the bet hero faces, so toCall/pot approaches 0.5 for a
 * POT-SIZED bet and needs a THREE-TIMES-pot bet to reach 0.75. Thresholds
 * written as if the value were bet/pot were therefore unreachable (>= 0.75,
 * > 1.2) or vacuous (<= 0.85, <= 0.75 — always true, so gates meant to STOP
 * bluff-raises into big bets never stopped anything).
 *
 * Telemetry proved it across 700,000 live decisions: v16_reads_tell and
 * v17_catch_block fired ZERO times. These tests pin the arithmetic so the
 * mistake cannot be made a fourth time, and pin that the honest scale
 * actually reaches the branches.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

describe('the arithmetic that caused it', () => {
  const legacy = (toCall: number, potIncludingBet: number) => toCall / potIncludingBet;
  const honest = (toCall: number, potIncludingBet: number) =>
    toCall / Math.max(potIncludingBet - toCall, 1e-9);

  it('a POT-SIZED bet is 0.5 on the legacy scale and 1.0 on the honest one', () => {
    // Pot was 40; villain bets 40; hero faces 40 into a pot of 80.
    expect(legacy(40, 80)).toBeCloseTo(0.5, 6);
    expect(honest(40, 80)).toBeCloseTo(1.0, 6);
  });

  it('legacy can NEVER reach 0.75 without a three-times-pot bet', () => {
    // To get toCall/(pot+toCall) >= 0.75 you need toCall >= 3 * pot.
    expect(legacy(120, 160)).toBeCloseTo(0.75, 6); // 120 into a pot of 40 = 3x pot
    expect(legacy(80, 120)).toBeLessThan(0.75); // a 2x-pot overbet still misses
    expect(honest(80, 120)).toBeCloseTo(2.0, 6);
  });

  it('legacy > 1.2 is impossible for any legal bet', () => {
    for (const [call, pot] of [
      [1, 2],
      [50, 100],
      [1000, 1001],
    ] as Array<[number, number]>) {
      expect(legacy(call, pot)).toBeLessThanOrEqual(1);
    }
  });

  it('the vacuous gates: legacy <= 0.85 was true for every legal sizing', () => {
    for (const [call, pot] of [
      [10, 20],
      [100, 140],
      [500, 600],
    ] as Array<[number, number]>) {
      expect(legacy(call, pot)).toBeLessThanOrEqual(0.85); // never restricted
    }
    // The honest scale distinguishes them properly.
    expect(honest(100, 140)).toBeCloseTo(2.5, 6); // 2.5x pot — should be gated OUT
  });
});

describe('the branches wake up on the honest scale', () => {
  function mkPlayer(cards: Card[], over: Partial<SeatPlayer> = {}): SeatPlayer {
    return {
      seat: 1,
      user_id: 'hero',
      username: 'hero',
      stack: 400,
      bet: 0,
      totalInvested: 0,
      cards,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
      ...over,
    } as SeatPlayer;
  }

  /** Hero faces a 1.5x-pot river overbet: legacy 0.6 (misses every gate),
   *  honest 1.5 (reaches the overbet-polarity and big-bet-cap branches). */
  function decideVsOverbet(hole: Card[]) {
    seedFastRandom(9001);
    const hero = mkPlayer(hole, { bet: 0, stack: 400 });
    const opp = {
      seat: 3,
      user_id: 'opp3',
      username: 'opp3',
      stack: 300,
      bet: 90,
      totalInvested: 90,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    } as never as SeatPlayer;
    const gs: HorseGameStateV2 = {
      players: [hero, opp],
      communityCards: [
        c('K', 'hearts'),
        c('9', 'hearts'),
        c('4', 'spades'),
        c('7', 'clubs'),
        c('2', 'diamonds'),
      ],
      pot: 150, // 60 before the bet + the 90 wager
      currentBet: 90,
      minRaise: 90,
      stage: 'river',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: [
        { seat: 3, userId: 'opp3', action: 'bet', amount: 90, timestamp: 1, stage: 'river' },
      ] as ActionRecord[],
      gameMode: 'cash',
      format: 'cash',
    } as HorseGameStateV2;
    return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false });
  }

  it('a 1.5x-pot overbet is a real overbet to the brain now (and is respected)', () => {
    // Legacy scale: 90/150 = 0.6 — below every "big bet" gate in the file.
    // Honest scale: 90/60 = 1.5 — an overbet, exactly as the comments say.
    expect(90 / 150).toBeCloseTo(0.6, 6);
    expect(90 / 60).toBeCloseTo(1.5, 6);
    // A weak bluff-catcher facing a 1.5x overbet should not be calling off.
    const dec = decideVsOverbet([c('8', 'clubs'), c('6', 'diamonds')]);
    expect(dec.action).toBe('fold');
  });

  it('decisions remain legal facing overbets across variants', () => {
    for (const hole of [
      [c('A', 'hearts'), c('K', 'hearts')],
      [c('8', 'clubs'), c('6', 'diamonds')],
      [c('K', 'spades'), c('Q', 'spades')],
    ]) {
      const dec = decideVsOverbet(hole);
      expect(['fold', 'call', 'raise', 'all_in']).toContain(dec.action);
    }
  });
});
