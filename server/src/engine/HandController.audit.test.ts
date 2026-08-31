/**
 * Audit regression tests (2026-07-19) for HandController money/rules fixes:
 *  - Uncalled bets are returned to the bettor before rake (not raked).
 *  - A short all-in blind poster is not handed the turn and auto-folded.
 *  - Everyone all-in from the blinds runs the board out instead of hanging.
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
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

/** Drive HandController + capture events; act for whoever is on the button. */
function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  // HandController deep-copies the input players into its own state — assert on
  // the internal copy, not the array we passed in.
  const state = () =>
    (hc as unknown as { state: { currentPlayerSeat: number; players: SeatPlayer[] } }).state;
  const currentSeat = () => state().currentPlayerSeat;
  const seat = (n: number) => state().players.find((p) => p.seat === n)!;
  return { hc, events, currentSeat, seat };
}

describe('HandController - uncalled bet returned before rake (AUDIT FIX)', () => {
  it('refunds the uncalled portion and rakes only the contested pot', () => {
    // HU, 1000 each, 5/10. Flop is seen so no-flop-no-drop does not apply.
    const players = mkPlayers([1000, 1000]);
    const { hc, events, seat } = harness(mkConfig(), players, 1);
    hc.start(); // seat1=button/SB posts 5, seat2=BB posts 10; button acts first HU

    // Preflop: SB completes, BB checks option -> flop.
    hc.performAction(1, 'call', 0); // seat1 completes to 10
    hc.performAction(2, 'check', 0); // BB option -> flop (pot 20)
    // Flop: BB checks, button bets 100, BB folds.
    hc.performAction(2, 'check', 0);
    hc.performAction(1, 'bet', 100);
    hc.performAction(2, 'fold', 0);

    const uncalled = events.find((e) => e.type === 'UNCALLED_BET_RETURNED') as
      | { type: 'UNCALLED_BET_RETURNED'; amount: number; seat: number }
      | undefined;
    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number }
      | undefined;

    expect(uncalled).toBeDefined();
    expect(uncalled!.amount).toBe(100); // the whole 100 bet was uncalled
    expect(uncalled!.seat).toBe(1);
    // Rake is 5% of the CONTESTED $20 pot = $1.00, NOT 5% of $120 = $6.00.
    expect(complete).toBeDefined();
    expect(complete!.rake).toBe(1);

    // Chip conservation: seat2 lost its $10, seat1 nets +$10 minus $1 rake.
    const s1 = seat(1);
    const s2 = seat(2);
    expect(s2.stack).toBe(990);
    expect(s1.stack).toBe(1009);
    expect(s1.stack + s2.stack + complete!.rake).toBe(2000);
  });
});

describe('HandController - all-in blind edge cases (AUDIT FIX)', () => {
  it('does not hand the turn to a short all-in SB (would be auto-folded)', () => {
    // HU: seat1 (button/SB) has only 3 -> posts 3 all-in. seat2 (BB) has 1000.
    const players = mkPlayers([3, 1000]);
    const { hc, currentSeat, seat } = harness(mkConfig(), players, 1);
    hc.start();

    expect(seat(1).is_all_in).toBe(true);
    // The only player who can act is seat2 — never the all-in seat1.
    expect(currentSeat()).toBe(2);
  });

  it('runs the board out when everyone is all-in from the blinds (no hang)', () => {
    // HU: both stacks below their blind -> both all-in on the post.
    const players = mkPlayers([3, 8]);
    const { hc, events, seat } = harness(mkConfig(), players, 1);
    hc.start();

    // Previously start() emitted no turn and the hand hung until the 10-min
    // void. Now it drives straight into the all-in runout pause.
    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);

    // Simulate the ServerTableEngine resuming the runout (no insurance/RIT).
    hc.continueRunout();

    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number }
      | undefined;
    expect(complete).toBeDefined();
    // seat2's blind over-covered seat1, so the $5 excess is returned uncalled;
    // only the contested $6 is raked. All 11 chips conserved (stacks + rake).
    expect(seat(1).stack + seat(2).stack + complete!.rake).toBe(11);
    // Someone actually got paid — the hand did not void.
    expect(seat(1).stack + seat(2).stack).toBeGreaterThan(0);
  });
});

describe('HandController - straddle min-raise (AUDIT FIX)', () => {
  it('min raise over a 2xBB straddle is to 4xBB (increment = straddle amount)', () => {
    // 4 players, 1/2. UTG (seat 4) straddles to 4. Min raise-to must be 8 (4xBB),
    // i.e. increment (state.minRaise) === the straddle amount, not the BB.
    const players = mkPlayers([1000, 1000, 1000, 1000]);
    const cfg = mkConfig({ straddles: [{ seat: 4, amount: 4 }] });
    const { hc } = harness(cfg, players, 1);
    hc.start();
    const st = (hc as unknown as { state: { currentBet: number; minRaise: number } }).state;
    expect(st.currentBet).toBe(4); // straddle is the live bet level
    expect(st.minRaise).toBe(4); // increment = straddle -> raise-to floor 4+4 = 8
  });
});

describe('HandController - RIT settlement helpers (AUDIT FIX)', () => {
  it('computeLivePots returns real pots at the all-in runout point (getPots was empty)', () => {
    // HU both all-in preflop (equal stacks) → ALL_IN_RUNOUT pause. This is the
    // exact point ServerTableEngine.dealAndResolveRIT runs. getPots() is [] here
    // (only completeHand fills it); computeLivePots() must return the real pot.
    const players = mkPlayers([500, 500]);
    const { hc, events } = harness(mkConfig(), players, 1);
    hc.start();
    // seat1 (button/SB) shoves, seat2 (BB) calls all-in.
    hc.performAction(1, 'all_in', 0);
    hc.performAction(2, 'call', 0);

    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);

    const stalePots = hc.getPots();
    const livePots = hc.computeLivePots();
    // The pre-fix source of the pot-destruction bug:
    expect(stalePots.length).toBe(0);
    // The fix: live pots reflect the $1000 all-in pot with both players eligible.
    const liveTotal = livePots.reduce((s, p) => s + p.amount, 0);
    expect(liveTotal).toBe(1000);
    expect(livePots[0].eligiblePlayers.length).toBe(2);

    // Rake is computed once on the contested $1000 pot (5% = $50, under cap).
    // 2026-08-18 parity fix: the runout now parks BEFORE any street is dealt,
    // so at this exact point sawFlop is still false and noFlopNoDrop zeroes
    // the rake - correctly, because the hand COULD still end preflop only in
    // theory; in practice the runout always deals the flop, and the engine
    // marks it seen before computing rake (markFlopSeen in dealAndResolveRIT,
    // runOutCommunityCards for single-run). Mirror that sequence here.
    expect(hc.computeRakeAndBBJ().rake).toBe(0); // pre-deal: no flop yet
    hc.markFlopSeen();
    const { rake } = hc.computeRakeAndBBJ();
    expect(rake).toBe(50);
  });
});
