import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Eval from './HorseEval.js';
import type { OpponentExploitRead } from './HorseOpponentExploit.js';
import type { SeatPlayer } from '../types.js';

const seat = (seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  seat,
  user_id: `seat-${seat}`,
  username: `seat-${seat}`,
  stack: 200,
  bet: 0,
  totalInvested: 0,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  is_horse: true,
  ...over,
});
function spot(extra: Partial<SeatPlayer> = {}) {
  const hero = seat(1, {
    cards: [
      { rank: 'J', suit: 'hearts' },
      { rank: '8', suit: 'hearts' },
    ],
  });
  const gs = {
    stateSchemaVersion: 1,
    asset: 'chips',
    chipUnit: 0.01,
    players: [
      { ...hero, cards: [] },
      seat(2, { stack: 0, bet: 200, totalInvested: 200, is_all_in: true }),
      seat(3, extra),
    ],
    dealtSeatIds: [1, 2, 3],
    communityCards: [],
    gameVariant: 'nlh',
    stage: 'preflop',
    gameMode: 'cash',
    currentBet: 200,
    bigBlind: 2,
    minRaise: 198,
    pot: 200 + (extra.totalInvested ?? 0),
    actionHistory: [
      {
        seat: 2,
        userId: 'seat-2',
        stage: 'preflop',
        action: 'all_in',
        amount: 200,
        isFullRaise: true,
        timestamp: 1,
      },
    ],
    rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
  } as HorseGameStateV2;
  return { hero, gs };
}
function decide(extra: Partial<SeatPlayer> = {}) {
  const { hero, gs } = spot(extra);
  return HorseLogic.__testables.maniacCallDown(
    { action: 'fold', thinkTime: 0 },
    hero,
    gs,
    Eval.variantInfo('nlh'),
    {}
  );
}
beforeEach(() => {
  const base = { engaged: null, mean: 0.2, excess: 0, lower: 0, upper: 1 };
  const stats = Object.fromEntries(
    ['vpip', 'pfr', 'rfi', 'threeBet', 'foldTo3Bet', 'betCheckedTo', 'foldToBet', 'riverCall'].map(
      (k) => [k, { ...base, ...(k === 'pfr' ? { engaged: 'high', mean: 1 } : {}) }]
    )
  );
  vi.spyOn(HorseMind, 'opponentRead').mockReturnValue({ stats } as unknown as OpponentExploitRead);
  vi.spyOn(HorseMind, 'bandFor').mockReturnValue([0, 1]);
  vi.spyOn(Eval, 'equitySampleSizeOfLastCall').mockReturnValue(360);
});
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

describe('preflop maniac recovery uses the actual committed population', () => {
  it('does not price unanswered seats as callers, but retains a real second caller', () => {
    const eq = vi
      .spyOn(Eval, 'simulateEquity')
      .mockImplementation((_hole, _board, opponents) => (opponents === 1 ? 0.58 : 0.29));
    expect(decide().action).toBe('all_in');
    expect(eq.mock.calls[0][2]).toBe(1);
    eq.mockClear();
    expect(
      decide({ stack: 0, bet: 200, totalInvested: 200, is_all_in: true, is_sitting_out: true })
        .action
    ).toBe('fold');
    expect(eq.mock.calls[0][2]).toBe(2);
  });
  it('includes a matched live caller without requiring it to be all in', () => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.29);
    expect(decide({ stack: 100, bet: 200, totalInvested: 200 }).action).toBe('fold');
    expect(eq.mock.calls[0][2]).toBe(2);
  });
  it('confirms a noisy heads-up all-in boundary without lowering the net price', () => {
    const eq = vi.spyOn(Eval, 'simulateEquity').mockReturnValueOnce(0.48).mockReturnValue(0.58);
    expect(decide().action).toBe('all_in');
    expect(eq).toHaveBeenCalledTimes(2);
    eq.mockReset().mockReturnValue(0.5);
    expect(decide().action).toBe('fold'); // 200 / (400 - 6), not gross 50%.
    expect(eq).toHaveBeenCalledTimes(3); // at most the two existing bounded confirmations.
  });
});
