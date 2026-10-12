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

  it('a blind that left the hand folded still gets its unmatched part back', () => {
    // Three-handed: seat 1 button, seat 2 small blind (0.5 posted), seat 3 big
    // blind all-in for 0.3. A seat that covers the all-in is no longer asked
    // to act, so the fold arrives the way it does in play when a seat is
    // stood up mid-hand: marked folded, then the hand settles.
    const h = play([100, 100, 0.3], 1);
    const players = h.state().players as Array<{
      seat: number;
      stack: number;
      is_folded: boolean;
    }>;
    players.find((p) => p.seat === 1)!.is_folded = true;
    players.find((p) => p.seat === 2)!.is_folded = true;
    const returned = (h.hc as unknown as { returnUncalledBet(): number }).returnUncalledBet();
    expect(returned).toBeCloseTo(0.2, 2);
    expect(players.find((p) => p.seat === 2)!.stack).toBeCloseTo(99.7, 2);
    expect(h.state().pot).toBeCloseTo(0.6, 2);
  });
});

/**
 * A BLIND THAT ALREADY COVERS EVERY ALL-IN HAS NOTHING TO DECIDE (launch audit
 * 2026-10-05). The seat was put on the clock with fold, call and raise though
 * nobody was left to call and it could lose no more than it had matched; a
 * slow or disconnected seat was auto-folded out of a pot it had covered.
 */
describe('a blind that already covers every all-in is not asked to act', () => {
  function play(stacks: number[], dealer: number) {
    const events: any[] = [];
    const players = stacks.map((stack, i) => ({
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
    const hc = new HandController(
      {
        tableId: 't-cover',
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
    const types = () => events.map((e) => e.type);
    return { hc, events, types, state: () => (hc as any).state };
  }

  it('heads-up, big blind all-in for less than the small blind: straight to the runout', () => {
    const h = play([100, 0.2], 1);
    expect(h.types()).not.toContain('TURN_CHANGE');
    expect(h.types()).toContain('ALL_IN_RUNOUT');
    const returned = h.events.filter((e) => e.type === 'UNCALLED_BET_RETURNED');
    expect(returned).toHaveLength(1);
    expect(returned[0].amount).toBeCloseTo(0.3, 2);
    expect(h.state().pot).toBeCloseTo(0.4, 2);
  });

  it('heads-up, small blind all-in for less than the big blind: straight to the runout', () => {
    const h = play([0.4, 100], 1);
    expect(h.types()).not.toContain('TURN_CHANGE');
    expect(h.events.find((e) => e.type === 'UNCALLED_BET_RETURNED').amount).toBeCloseTo(0.6, 2);
  });

  it('three-handed: the others fold and the small blind that covers is not asked', () => {
    // Seat 1 button, seat 2 small blind, seat 3 big blind all-in for 0.3.
    const h = play([100, 100, 0.3], 1);
    expect(h.state().currentPlayerSeat).toBe(1);
    expect(h.hc.performAction(1, 'fold' as any, 0)).toBe(true);
    expect(h.types()).toContain('ALL_IN_RUNOUT');
    expect(h.types().filter((t) => t === 'TURN_CHANGE')).toHaveLength(1);
    expect(h.events.find((e) => e.type === 'UNCALLED_BET_RETURNED').amount).toBeCloseTo(0.2, 2);
  });

  it('a seat that does NOT cover the all-in still decides', () => {
    // Big blind all-in for 0.7: the small blind's 0.5 does not cover it.
    const h = play([100, 0.7], 1);
    expect(h.types()).toContain('TURN_CHANGE');
    expect(h.types()).not.toContain('ALL_IN_RUNOUT');
  });

  it('with two seats still able to act, play is ordinary', () => {
    const h = play([100, 100, 100], 1);
    expect(h.types()).toContain('TURN_CHANGE');
  });
});
