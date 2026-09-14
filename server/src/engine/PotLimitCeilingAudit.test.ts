import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { calculateBettingState, validateAction } from './PokerEngine.js';
import { potLimitRaiseTo } from './BettingStructure.js';
import type { HandConfig, SeatPlayer } from '../types.js';

// Independent accounting: call first, then raise by every chip now in the pot.
it.each([
  [3, 2, 0, 7],
  [3, 2, 1, 6],
  [5, 2, 0, 9],
  [15, 2, 0, 19],
  [7, 4, 0, 15],
  [123.45, 20.25, 7.5, 156.45],
  [100, 0, 0, 100],
  [0.15, 0.1, 0.05, 0.3],
])('pot %s, current %s, invested %s has exact ceiling %s', (pot, current, invested, ceiling) => {
  const state = calculateBettingState(pot, current, invested, 0.01, 0.01, true);
  expect(current + state.maxRaise!).toBeCloseTo(ceiling, 2);
  expect(potLimitRaiseTo(pot, current, current - invested)).toBeCloseTo(ceiling, 2);
  const action = current === 0 ? 'bet' : 'raise';
  expect(validateAction(action, ceiling, 1000, state).valid).toBe(true);
  expect(validateAction(action, ceiling + 0.01, 1000, state).valid).toBe(false);
});

describe.each(['plo4', 'plo5', 'plo6', 'plo8'] as const)(
  '%s actual controller ceiling',
  (variant) => {
    function hand() {
      const hc = new HandController(
        {
          tableId: 'pot-ceiling',
          handNumber: 1,
          gameVariant: variant,
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        [1, 2, 3, 4].map((seat) => ({
          seat,
          user_id: `p${seat}`,
          username: `P${seat}`,
          stack: 100,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        })) as SeatPlayer[],
        1
      );
      hc.start();
      return hc;
    }
    it('rejects a cent over pot without spending chips, then accepts the exact opening', () => {
      const hc = hand();
      expect(hc.performAction(4, 'raise', 7.01)).toBe(false);
      expect(hc.getState().pot).toBe(3);
      expect(hc.performAction(4, 'raise', 7)).toBe(true);
      expect(hc.getState().currentBet).toBe(7);
    });
    it('includes a limper in the pot ceiling', () => {
      const hc = hand();
      expect(hc.performAction(4, 'call')).toBe(true);
      expect(hc.performAction(1, 'raise', 9.01)).toBe(false);
      expect(hc.performAction(1, 'raise', 9)).toBe(true);
    });
    it('normalizes a deep shove to the legal pot amount', () => {
      const hc = hand();
      expect(hc.performAction(4, 'all_in')).toBe(true);
      expect(hc.getState().currentBet).toBe(7);
      expect(hc.getState().players.find((p) => p.seat === 4)!.stack).toBe(93);
    });
    it('observes the committed record before advancing, and an observer cannot veto the action', () => {
      const hc = hand();
      let observed = 0;
      const records: Array<Readonly<import('../types.js').ActionRecord>> = [];
      const seats: Array<number | null> = [];
      const latest: Array<Readonly<import('../types.js').ActionRecord> | undefined> = [];
      const observer = (record: Readonly<import('../types.js').ActionRecord>) => {
        observed++;
        records.push(record);
        seats.push(hc.getState().currentPlayerSeat);
        latest.push(hc.getState().actionHistory.at(-1));
        throw new Error('receipt consumer failed');
      };
      expect(hc.performAction(4, 'raise', 7.01, 'horse_policy', observer)).toBe(false);
      expect(observed).toBe(0);
      expect(hc.performAction(4, 'all_in', undefined, 'horse_policy', observer)).toBe(true);
      expect(observed).toBe(1);
      expect(records[0]).toMatchObject({ seat: 4, action: 'raise', amount: 7, stage: 'preflop' });
      expect(Object.isFrozen(records[0])).toBe(true);
      expect(seats).toEqual([4]);
      expect(latest[0]).toBe(records[0]);
      expect(hc.getState().currentPlayerSeat).not.toBe(4);
      expect(hc.getState().players.find((p) => p.seat === 4)!.stack).toBe(93);
    });
  }
);
