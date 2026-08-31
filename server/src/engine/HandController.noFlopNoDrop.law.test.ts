/**
 * NO FLOP, NO DROP — priced from the board, not from the flag.
 *
 * Pins the 2026-08-31 fix. The rake-law alarm (migration 20260831140000)
 * filed 20 criticals against live cash hands that ended preflop and were
 * raked anyway: walks, open-folds, a heads-up 2/4 fold. In every one the
 * board was empty and `state.sawFlop` was true, so `calculateRake`'s
 * `noFlopNoDrop && !sawFlop` short-circuit never fired.
 *
 * priceDeductions now requires a BOARD before it will take a drop: three
 * community cards in this controller's state, or markFlopSeen() — the RIT
 * path, whose boards are built outside this state and which is the only
 * legitimate way a fully-dealt hand has no board here.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

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
    rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const internal = hc as unknown as { state: { sawFlop: boolean; pot: number } };
  const complete = () =>
    events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number; bbjFee: number }
      | undefined;
  return { hc, events, internal, complete };
}

describe('no flop, no drop is settled by the board', () => {
  it('refuses the rake on a preflop fold even when sawFlop has gone true', () => {
    // The live shape: 1/2 three-handed, one raise, everyone folds, no board.
    const players = mkPlayers([200, 200, 200]);
    const { hc, internal, complete } = harness(mkConfig(), players, 1);
    hc.start();

    // Corrupt the flag exactly as production did. Nothing else changes: no
    // card is dealt, no street is advanced.
    internal.state.sawFlop = true;

    // Everyone folds to the big blind preflop.
    hc.performAction(1, 'fold', 0);
    hc.performAction(2, 'fold', 0);

    expect(complete()).toBeDefined();
    expect(complete()!.rake).toBe(0);
    expect(complete()!.bbjFee).toBe(0);
  });

  it('still rakes a hand that actually saw a flop', () => {
    const players = mkPlayers([200, 200]);
    const { hc, complete } = harness(mkConfig(), players, 1);
    hc.start(); // seat1 button/SB posts 1, seat2 BB posts 2

    hc.performAction(1, 'call', 0); // complete to 2
    hc.performAction(2, 'check', 0); // -> flop, pot 4
    hc.performAction(2, 'check', 0);
    hc.performAction(1, 'check', 0); // -> turn
    hc.performAction(2, 'check', 0);
    hc.performAction(1, 'check', 0); // -> river
    hc.performAction(2, 'check', 0);
    hc.performAction(1, 'check', 0); // -> showdown

    expect(complete()).toBeDefined();
    // Heads-up pays 5% (HEADS_UP_RAKE_PERCENT), pot 4.00 -> 0.20.
    expect(complete()!.rake).toBeGreaterThan(0);
  });

  it('markFlopSeen() still authorises the drop when the board lives outside this state', () => {
    // The RIT path: boards are built in dealAndResolveRIT, so
    // state.communityCards stays empty and markFlopSeen() is the evidence.
    const players = mkPlayers([200, 200]);
    const { hc, internal } = harness(mkConfig(), players, 1);
    hc.start();
    internal.state.pot = 100;
    hc.markFlopSeen();

    expect(hc.priceDeductions(true, 100).rake).toBeGreaterThan(0);
  });

  it('the insurance forecast still quotes the rake a preflop runout will pay', () => {
    // computeRakeAndBBJ(true) prices a runout that has not been dealt yet.
    // It moves no chips, so the board rule must not zero it.
    const players = mkPlayers([200, 200]);
    const { hc, internal } = harness(mkConfig(), players, 1);
    hc.start();
    internal.state.pot = 100;

    expect(hc.computeRakeAndBBJ(true).rake).toBeGreaterThan(0);
    // ...and the same call WITHOUT the forecast flag, on the same empty
    // board, still takes nothing.
    expect(hc.computeRakeAndBBJ(false).rake).toBe(0);
  });
});
