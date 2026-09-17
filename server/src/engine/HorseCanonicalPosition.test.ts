import { afterEach, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import * as charts from './GtoCharts.js';
import type { SeatPlayer } from '../types.js';

afterEach(() => {
  vi.restoreAllMocks();
  charts._clearGtoCharts();
});

it.each([
  ['UTG', 3, []],
  ['MP', 4, [3]],
  ['CO', 5, [3, 4]],
  ['BTN', 6, [3, 4, 5]],
  ['SB', 1, [3, 4, 5, 6]],
] as const)(
  'retains the dealt %s position after private cards are removed and prior seats fold',
  (position, heroSeat, folded) => {
    charts.setGtoCharts(
      ['UTG', 'MP', 'CO', 'BTN', 'SB'].map((hero_position) => ({
        game_type: 'Cash',
        hero_position,
        stack_depth: 10,
        villain_action: 'fold_to_hero',
        hand_matrix: { AA: { push: 1, fold: 0 } },
      }))
    );
    const lookup = vi.spyOn(charts, 'gtoOpenJam');
    const players = [1, 2, 3, 4, 5, 6, 7].map((seat) => ({
      seat,
      user_id: 'position-' + seat,
      username: 'P' + seat,
      stack: 20 - (seat === 1 ? 1 : seat === 2 ? 2 : 0),
      bet: seat === 1 ? 1 : seat === 2 ? 2 : 0,
      totalInvested: seat === 1 ? 1 : seat === 2 ? 2 : 0,
      cards:
        seat === heroSeat
          ? [
              { rank: 'A', suit: 'spades' },
              { rank: 'A', suit: 'hearts' },
            ]
          : [],
      is_folded: (folded as readonly number[]).includes(seat) || seat === 7,
      is_all_in: false,
      is_sitting_out: seat === 7,
      is_horse: true,
    })) as SeatPlayer[];
    const hero = players.find((player) => player.seat === heroSeat)!;
    const state = {
      players,
      dealtSeatIds: [1, 2, 3, 4, 5, 6],
      communityCards: [],
      pot: 3,
      currentBet: 2,
      minRaise: 2,
      stage: 'preflop',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 6,
      gameMode: 'cash',
      format: 'cash',
      actionHistory: folded.map((seat, index) => ({
        seat,
        userId: 'position-' + seat,
        action: 'fold',
        amount: 0,
        stage: 'preflop',
        timestamp: index,
      })),
    } as HorseGameStateV2;
    const result = HorseLogic.decide(
      hero,
      state,
      'balanced',
      {},
      { mind: false, telemetry: false }
    );
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ position, stackBB: 10 }));
    expect(result.action).toBe('all_in');
  }
);
