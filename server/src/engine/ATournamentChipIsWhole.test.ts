/**
 * A TOURNAMENT CHIP IS WHOLE (launch audit 2026-10-05).
 *
 * The controller splits and rounds tournament chips as whole units, but its
 * action door accepted any whole-cent wager, so a 2.5x preset facing 75 put
 * 187.5 on the felt. A cash chip table still moves in cents.
 */
import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

function hand(isTournament: boolean) {
  const players = [1000, 1000, 1000].map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const hc = new HandController(
    {
      tableId: 't-whole',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 25,
      bigBlind: 50,
      isTournament,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.start();
  const state = () =>
    (hc as unknown as { state: { currentPlayerSeat: number; currentBet: number } }).state;
  return { hc, state };
}

describe('a tournament chip is whole', () => {
  it('a tournament table refuses a half-chip raise and plays the whole one', () => {
    const { hc, state } = hand(true);
    const seat = state().currentPlayerSeat;
    expect(hc.performAction(seat, 'raise', 187.5)).toBe(false);
    expect(state().currentBet).toBe(50);
    expect(hc.performAction(seat, 'raise', 188)).toBe(true);
    expect(state().currentBet).toBe(188);
  });

  it('a cash chip table still moves in cents', () => {
    const { hc, state } = hand(false);
    const seat = state().currentPlayerSeat;
    expect(hc.performAction(seat, 'raise', 187.5)).toBe(true);
    expect(state().currentBet).toBe(187.5);
  });
});
