/**
 * Regression test (2026-07-21) for the Big Blind Ante refund bug.
 *
 * The BB fronts the whole table's ante (Bible V8 §4.3). That ante is DEAD money
 * in the pot. The pre-fix returnUncalledBet compared each player's TOTAL invested
 * (live blind + dead ante), so whenever the BB was the unique top contributor —
 * e.g. a limped pot where callers only match the live big blind — the BB's ante
 * was refunded as an "uncalled bet" every hand, and calculatePots would otherwise
 * have handed it to the BB as a private side pot. The fix segregates dead money
 * (deadInvested) and compares LIVE invested only.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { calculatePots } from './PokerEngine.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
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
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const state = () => (hc as unknown as { state: { pot: number; players: SeatPlayer[] } }).state;
  const seat = (n: number) => state().players.find((p) => p.seat === n)!;
  return { hc, events, state, seat };
}

describe('HandController - Big Blind Ante is dead money, never refunded', () => {
  it('does not refund the BBA to the BB in a limped, checked-down pot', () => {
    // HU, 1000 each, 5/10, BBA of 2/player => BB fronts 2*2 = 4.
    const players = mkPlayers([1000, 1000]);
    const { hc, events, seat } = harness(mkConfig({ ante: 2, bigBlindAnte: true }), players, 1);
    hc.start(); // seat1 = button/SB (posts 5), seat2 = BB (posts 10 + 4 dead ante)

    // BB posted the dead ante and only the dead ante.
    expect(seat(2).deadInvested).toBe(4);
    expect(seat(1).deadInvested ?? 0).toBe(0);

    // Limp + check to showdown: no voluntary bet ever exceeds the big blind, so
    // the BB is the unique TOTAL-invested top contributor (10 + 4 vs 10).
    hc.performAction(1, 'call', 0); // SB completes to 10
    hc.performAction(2, 'check', 0); // BB checks option -> flop
    hc.performAction(2, 'check', 0); // flop: BB first to act HU
    hc.performAction(1, 'check', 0);
    hc.performAction(2, 'check', 0); // turn
    hc.performAction(1, 'check', 0);
    hc.performAction(2, 'check', 0); // river
    hc.performAction(1, 'check', 0); // -> showdown

    // The ante must NOT come back as an uncalled bet.
    const uncalled = events.find((e) => e.type === 'UNCALLED_BET_RETURNED');
    expect(uncalled).toBeUndefined();

    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number }
      | undefined;
    expect(complete).toBeDefined();

    // Chip conservation across both stacks + rake. The full 24 (10 + 10 + 4)
    // was contested; whoever won the showdown carries the ante.
    expect(seat(1).stack + seat(2).stack + complete!.rake).toBe(2000);
  });

  it('folds the BBA into the main pot, not a BB-only side pot', () => {
    // Two players contest a limped pot; the BB also fronted a 4-chip ante.
    // Live invested is equal (10 each), so there is ONE pot of 24 (20 live + 4
    // dead) contested by both — never a 4-chip side pot for the BB alone.
    const players: SeatPlayer[] = [
      {
        seat: 1,
        user_id: 'u1',
        username: 'P1',
        stack: 990,
        bet: 10,
        totalInvested: 10,
        deadInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      } as SeatPlayer,
      {
        seat: 2,
        user_id: 'u2',
        username: 'P2',
        stack: 986,
        bet: 10,
        totalInvested: 14,
        deadInvested: 4,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      } as SeatPlayer,
    ];
    const pots = calculatePots(players);
    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(24);
    expect(pots[0].eligiblePlayers.sort()).toEqual(['u1', 'u2']);
  });
});
