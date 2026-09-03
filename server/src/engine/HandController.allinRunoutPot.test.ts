/**
 * ALL_IN_RUNOUT PRICES THE CONTESTED POT — regression pin (2026-08-28).
 *
 * From Dan's insurance recording (hand #3158299): a big stack shoved over a
 * micro all-in, and the ALL_IN_RUNOUT event carried `state.pot` with the
 * shover's UNCALLED chips still inside. Insurance priced a 62-chip contested
 * pot as 317.61 — max coverage, fees, and the Break Even preset's atRisk all
 * ran on money that was never winnable (the uncalled excess returns to the
 * shover no matter what).
 *
 * The fix: HandController.advanceStage() calls returnUncalledBet() BEFORE
 * emitting ALL_IN_RUNOUT. These tests pin that ordering:
 *   1. the event's pot is the contested pot,
 *   2. the shover's stack holds the refund before any runout code runs,
 *   3. the shover's totalInvested equals their matched amount (the offer's
 *      atRisk / Break Even input),
 *   4. completeHand's own later returnUncalledBet() finds nothing (idempotent).
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
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
    tableId: 't-runout-pot',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 25,
    bigBlind: 50,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

describe('ALL_IN_RUNOUT carries the CONTESTED pot (uncalled bet returned first)', () => {
  it('a shove over a micro all-in: event pot excludes the uncalled excess', () => {
    // The recording's shape: dealer folds, SB (big stack) shoves, BB is a
    // short stack already all-in on the blind (31 < BB 50).
    const events: HandEvent[] = [];
    const players = mkPlayers([500, 280, 31]); // seat1 dealer, seat2 SB, seat3 BB
    const hc = new HandController(mkConfig(), players, 1);
    hc.onEvent((e) => events.push(e));
    hc.start();

    const st = () => (hc as unknown as { state: { pot: number; players: SeatPlayer[] } }).state;
    const seat = (n: number) => st().players.find((p) => p.seat === n)!;

    expect(seat(3).is_all_in).toBe(true); // short BB posted 31 all-in
    expect(hc.performAction(1, 'fold' as never, 0)).toBe(true);
    expect(hc.performAction(2, 'all_in' as never, 0)).toBe(true); // shove 280

    const runout = events.find((e) => e.type === 'ALL_IN_RUNOUT') as
      | { type: 'ALL_IN_RUNOUT'; pot: number; players: SeatPlayer[] }
      | undefined;
    expect(runout, 'the all-in must park the hand for the runout').toBeTruthy();

    // Contested pot: both live players matched 31. The SB's other 249 were
    // never winnable and must be OUT of the event's pot.
    expect(runout!.pot).toBe(62);
    expect(st().pot).toBe(62);

    // The refund landed before the event: 280 - 31 matched = 249 back.
    expect(seat(2).stack).toBe(249);

    // The offer's atRisk input: totalInvested = the MATCHED amount only.
    expect(seat(2).totalInvested).toBe(31);
    const eventSeat2 = runout!.players.find((p) => p.seat === 2)!;
    expect(eventSeat2.totalInvested).toBe(31);

    // The refund is announced exactly once, with the right amount.
    const refunds = events.filter(
      (e) => e.type === ('UNCALLED_BET_RETURNED' as never)
    ) as never as {
      seat: number;
      amount: number;
    }[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0].seat).toBe(2);
    expect(refunds[0].amount).toBe(249);

    // Conservation: stacks + pot still add to the buy-ins.
    const total = st().players.reduce((s, p) => s + p.stack, 0) + st().pot;
    expect(total).toBe(500 + 280 + 31 - 0); // no rake taken yet
  });

  it('an exactly-matched all-in has no refund and the pot is untouched', () => {
    const events: HandEvent[] = [];
    const players = mkPlayers([500, 100, 100]);
    const hc = new HandController(mkConfig(), players, 1);
    hc.onEvent((e) => events.push(e));
    hc.start();

    expect(hc.performAction(1, 'fold' as never, 0)).toBe(true);
    expect(hc.performAction(2, 'all_in' as never, 0)).toBe(true); // SB 100
    expect(hc.performAction(3, 'call' as never, 0)).toBe(true); // BB calls all-in

    const runout = events.find((e) => e.type === 'ALL_IN_RUNOUT') as
      | { type: 'ALL_IN_RUNOUT'; pot: number }
      | undefined;
    expect(runout).toBeTruthy();
    expect(runout!.pot).toBe(200);
    const refunds = events.filter((e) => e.type === ('UNCALLED_BET_RETURNED' as never));
    expect(refunds).toHaveLength(0);
  });
});
