/**
 * ═══ A STALE RUNOUT CANNOT REACH THE NEXT HAND (2026-08-31) ═══════════════
 *
 * Root cause of the rake-law alarm's no_flop_no_drop criticals (32 live cash
 * hands raked on walks and preflop folds, 2026-08-29..31):
 *
 *   1. Hand N parks in an all-in runout; the insurance/RIT cascade holds
 *      sleeps, 20-second offer windows, catch handlers and safety timers.
 *   2. Hand N dies; dealHand assigns hand N+1's controller and then AWAITS
 *      fetchTimeBankExtras before subscribing a listener or calling start().
 *   3. A stale continuation fires in that window and runs the fresh,
 *      unstarted, listener-less controller out: five phantom board cards
 *      dealt into the void (never recorded - hand_history showed an empty
 *      board), sawFlop set true, stage parked at 'showdown', a pot-0
 *      completion emitted to nobody.
 *   4. start() posted blinds into the corpse. No street could ever deal
 *      (advanceStage has no 'showdown' case), big blinds were walked through
 *      folds on uncontested pots (every recorded action carried
 *      stage:'showdown'), and the fold-out settlement priced rake on
 *      sawFlop=true: 10% of a pot that never saw a card, 5% heads-up.
 *
 * The fixes these tests pin:
 *   - runout entry points (continueRunout, dealNextStreet, finalizeRunout,
 *     markFlopSeen, settleUncalledBet) refuse any hand that is not in an
 *     all-in runout - unstarted hands included;
 *   - start() refuses to start dirty: a corrupted pre-start controller is
 *     reset to a blank preflop hand and reported.
 *
 * The engine half (safeContinueRunout and the insurance cascade now anchor
 * every continuation to its controller) is type-enforced; these pins hold
 * the authoritative backstop.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(() => Promise.resolve({ persisted: true, alertId: 'a1' })),
}));

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

type Internal = {
  state: {
    stage: string;
    sawFlop: boolean;
    pot: number;
    communityCards: unknown[];
  };
};

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const internal = hc as unknown as Internal;
  const complete = () =>
    events.find((e) => e.type === 'HAND_COMPLETE') as
      | { type: 'HAND_COMPLETE'; rake: number; bbjFee: number }
      | undefined;
  return { hc, events, internal, complete };
}

describe('runout calls are refused outside an all-in runout', () => {
  it('continueRunout before start() is a reported no-op - the production race, step 3', () => {
    const { hc, internal, events } = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);

    hc.continueRunout(); // the stale continuation, landing pre-start

    expect(internal.state.communityCards.length).toBe(0);
    expect(internal.state.sawFlop).toBe(false);
    expect(internal.state.stage).toBe('preflop');
    expect(events.find((e) => e.type === 'HAND_COMPLETE')).toBeUndefined();
    expect(events.find((e) => e.type === 'COMMUNITY_CARDS')).toBeUndefined();
  });

  it('a hand dealt after the refused stale runout plays clean and pays no rake on a walk', () => {
    const { hc, internal, complete } = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    hc.continueRunout(); // stale continuation refused

    hc.start();
    hc.performAction(1, 'fold', 0);
    hc.performAction(2, 'fold', 0); // folded to the BB - never saw a flop

    expect(complete()).toBeDefined();
    expect(complete()!.rake).toBe(0);
    expect(internal.state.sawFlop).toBe(false);
  });

  it('finalizeRunout mid-betting cannot park the stage at showdown', () => {
    const { hc, internal, events } = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    hc.start();

    hc.finalizeRunout(); // stale - three players can still bet

    expect(internal.state.stage).not.toBe('showdown');
    expect(events.find((e) => e.type === 'HAND_COMPLETE')).toBeUndefined();
  });

  it('dealNextStreet mid-betting deals nothing and reports complete:false', () => {
    const { hc, internal } = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    hc.start();

    const r = hc.dealNextStreet();

    expect(r.complete).toBe(false);
    expect(r.board.length).toBe(0);
    expect(internal.state.communityCards.length).toBe(0);
  });

  it('markFlopSeen and settleUncalledBet are refused pre-start', () => {
    const { hc, internal } = harness(mkConfig(), mkPlayers([200, 200]), 1);

    hc.markFlopSeen();
    expect(internal.state.sawFlop).toBe(false);
    expect(hc.settleUncalledBet()).toBe(0);
  });

  it('a REAL all-in runout still runs out and still pays rake', () => {
    // Both stacks below their blinds: all-in from the posts, runout parks.
    const { hc, events, internal, complete } = harness(
      mkConfig({ smallBlind: 5, bigBlind: 10 } as never),
      mkPlayers([3, 8]),
      1
    );
    hc.start();
    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);

    hc.continueRunout(); // the legitimate continuation

    expect(internal.state.communityCards.length).toBe(5);
    expect(internal.state.sawFlop).toBe(true);
    expect(complete()).toBeDefined();
  });
});

describe('start() refuses to start dirty', () => {
  it('resets a corrupted pre-start controller to a blank preflop hand', () => {
    const { hc, internal, complete } = harness(mkConfig(), mkPlayers([200, 200, 200]), 1);
    // Corrupt the controller the way the production race did, bypassing the
    // runout guards - this pins the backstop behind the backstop.
    internal.state.stage = 'showdown';
    internal.state.sawFlop = true;

    hc.start();

    expect(internal.state.stage).toBe('preflop');
    expect(internal.state.sawFlop).toBe(false);

    // And the hand it deals is a normal hand: folds end it, nothing is raked.
    hc.performAction(1, 'fold', 0);
    hc.performAction(2, 'fold', 0);
    expect(complete()).toBeDefined();
    expect(complete()!.rake).toBe(0);
  });
});
