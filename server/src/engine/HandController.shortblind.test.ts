/**
 * SHORT ALL-IN BLIND — regression guard (2026-08-18).
 *
 * `postBlinds` used to set `state.currentBet = Math.min(bigBlind, stack)`, so a
 * big blind who could not cover the full blind lowered the price of entry for
 * the entire table. Worse, when the BB's stack was below the SMALL blind the
 * bet level landed BELOW an already-posted live bet, making `toCall` negative —
 * and `call` runs `Math.min(toCall, stack)`, which then ADDS to the caller's
 * stack and SUBTRACTS from the pot.
 *
 * Nothing in the suite pinned the bet level after a short blind, so both went
 * unnoticed. These tests fail against the pre-fix engine.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

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
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const hc = new HandController(config, players, dealerSeat);
  const st = () => (hc as unknown as { state: any }).state;
  const seat = (n: number) => st().players.find((p: SeatPlayer) => p.seat === n);
  const total = () => st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0) + st().pot;
  return { hc, st, seat, total };
}

describe('short all-in blind (Bible V8 §4.2 / §7.2)', () => {
  it('a BB who cannot cover the blind does NOT lower the price of entry', () => {
    // dealer=1 → SB=2, BB=3. BB has 1 against a big blind of 2.
    const h = harness(mkConfig(), mkPlayers([200, 200, 1]), 1);
    h.hc.start();

    expect(h.seat(3).bet).toBe(1); // posted all they had
    expect(h.seat(3).is_all_in).toBe(true);
    expect(h.st().currentBet).toBe(2); // ...but the price is still a full BB
  });

  it('the bet level is never below a live bet already posted', () => {
    // BB stack (0.5) is below the SMALL blind (1). Pre-fix this set
    // currentBet = 0.5 while the SB already had 1 in front → toCall = -0.5.
    const h = harness(mkConfig(), mkPlayers([200, 200, 0.5]), 1);
    h.hc.start();

    expect(h.st().currentBet).toBeGreaterThanOrEqual(h.seat(2).bet);
    expect(h.st().currentBet).toBe(2);
  });

  it('calling behind a sub-small-blind all-in cannot mint chips', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 0.5]), 1);
    h.hc.start();
    const before = h.total();

    // UTG (seat 1) calls, then the SB (seat 2) completes.
    h.hc.performAction(1, 'call' as any, 0);
    h.hc.performAction(2, 'call' as any, 0);

    // Chips are conserved and both callers PAID rather than received.
    expect(h.total()).toBeCloseTo(before, 8);
    expect(h.seat(1).stack).toBeLessThan(200);
    expect(h.seat(2).stack).toBeLessThan(200 - 1 + 0.0001);
    expect(h.st().pot).toBeGreaterThan(1.5);
  });

  it('a full big blind is unaffected', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    h.hc.start();
    expect(h.st().currentBet).toBe(2);
    expect(h.st().pot).toBe(3);
  });
});

/**
 * A FOLDED BLIND IS NOT PAID TO A STACK THAT NEVER MATCHED IT (launch audit
 * 2026-10-05). Before the fix the unique top contributor got nothing back if
 * it had folded, so a blind that folded to an all-in for less paid the short
 * stack chips the short stack never put up.
 */
describe('a folded blind is not paid to a stack that never matched it', () => {
  function seats(stacks: number[]) {
    return stacks.map((stack, i) => ({
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
    })) as any;
  }
  function play(stacks: number[], dealer: number) {
    const events: any[] = [];
    const players = seats(stacks);
    const total = stacks.reduce((a, b) => a + b, 0);
    const hc = new HandController(
      {
        tableId: 't-uncalled',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 0.5,
        bigBlind: 1,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as any,
      players,
      dealer
    );
    hc.onEvent((e: any) => events.push(e));
    hc.start();
    return { hc, events, players, total, state: () => (hc as any).state };
  }

  it('heads-up: the SB folds to a BB all-in for 0.2 and gets its unmatched 0.3 back', () => {
    // Heads-up the dealer is the small blind. Seat 1 = SB (100), seat 2 = BB (0.2).
    const h = play([100, 0.2], 1);
    const sbSeat = h.state().currentPlayerSeat;
    expect(h.hc.performAction(sbSeat, 'fold' as any, 0)).toBe(true);
    const returned = h.events.filter((e) => e.type === 'UNCALLED_BET_RETURNED');
    expect(returned).toHaveLength(1);
    expect(returned[0].amount).toBeCloseTo(0.3, 2);
    const after = h.state().players as Array<{ user_id: string; stack: number }>;
    const sb = after.find((p) => p.user_id === `u${sbSeat}`)!;
    const bb = after.find((p) => p.user_id !== `u${sbSeat}`)!;
    // The SB lost only the 0.2 that was matched; the BB won 0.2 + 0.2.
    expect(sb.stack).toBeCloseTo(99.8, 2);
    expect(bb.stack).toBeCloseTo(0.4, 2);
    expect(sb.stack + bb.stack).toBeCloseTo(h.total, 2);
  });
});
