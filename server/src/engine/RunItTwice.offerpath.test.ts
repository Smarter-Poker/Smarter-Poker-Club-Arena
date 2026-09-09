/**
 * RUN IT TWICE — the OFFER path, which nothing tested (Dan 2026-08-21).
 *
 * "RUN IT TWICE DOESN'T ACTUALLY WORK, IT DOESN'T RUN THE BOARD OR TURN OR
 *  RIVER TWICE, IT DOESN'T AWARD A POT TO THE WINNERS OR ANYTHING."
 *
 * Every existing RIT test calls runItTwiceEngine.offer()/chooserDecides()/
 * accept() BY HAND and then invokes dealAndResolveRIT directly. That proves
 * the RESOLVER is sound - and it is - while stepping straight over the part
 * that actually runs in production:
 *
 *     handleAllInRunout  ->  emit rit_offer  ->  horses respond
 *                        ->  waitForRITResponse  ->  isActive?  ->  resolve
 *
 * If any link there is broken, every hand silently runs once and the money
 * path below it never executes. That is exactly the symptom. This test
 * drives the real entry point end to end.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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

const cfg = (over: Partial<HandConfig> = {}): HandConfig =>
  ({
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  }) as HandConfig;

/** Build an engine parked at a real 2-way all-in runout, horses at every seat. */
function atAllIn(stacks = [500, 500]) {
  const players = mkPlayers(stacks);
  const events: HandEvent[] = [];
  const hc = new HandController(cfg(), players, 1);
  hc.onEvent((e) => events.push(e));
  hc.start();
  let guard = 0;
  while (!events.some((e) => e.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
    const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
    if (st.currentPlayerSeat <= 0) break;
    hc.performAction(st.currentPlayerSeat, 'all_in', 0);
  }
  const runoutEvent = events.find((e) => e.type === 'ALL_IN_RUNOUT');
  expect(runoutEvent, 'the hand must park at ALL_IN_RUNOUT').toBeTruthy();

  const e = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  e.running = true;
  e.handCount = 1;
  e.handController = hc;
  e.tableInfo = { game_variant: 'nlh', big_blind: 10, tournament_id: null, game_type: 'cash' };
  e.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: true,
  }));
  e.currentHandActions = players.map((player, index) => ({
    seat: player.seat,
    userId: player.user_id,
    action: index === 0 ? 'all_in' : 'call',
    timestamp: 1,
    stage: 'preflop',
  }));
  // Isolate the offer path: no network, no equity solver, no snapshots.
  const emitted: Array<Record<string, unknown>> = [];
  e.hub = { emitEvent: (_t: string, p: Record<string, unknown>) => emitted.push(p) };
  e.broadcastCurrentState = vi.fn();
  e.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
  e.sleep = vi.fn().mockResolvedValue(undefined);
  e.markProgress = vi.fn();
  // RIT on, insurance off - the live cash-table configuration.
  e.runItTwiceEngine.configure(TABLE, {
    enabled: true,
    autoDeclineTimeout: 10,
    maxRuns: 3,
    chooserTimeout: 5,
    responderTimeout: 10,
  });
  e.insuranceEngine.configure(TABLE, { enabled: false });

  return { e, hc, events, emitted, runoutEvent: runoutEvent as HandEvent, players };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RIT offer path (the part production actually runs)', () => {
  it('THE OFFER FIRES: a 2-way all-in on a RIT cash table emits rit_offer', () => {
    vi.useFakeTimers();
    const { e, runoutEvent, emitted, players } = atAllIn();

    e.handleAllInRunout(runoutEvent, e.seatedPlayers);

    const offer = emitted.find((p) => p.type === 'rit_offer');
    expect(offer, 'handleAllInRunout must broadcast rit_offer').toBeTruthy();
    expect(offer!.chooserPlayerId, 'a chooser must be named').toBeTruthy();
    expect((offer!.allPlayerIds as string[]).length).toBe(players.length);
    // Dan: "there is no option to run it three times which is a MUST."
    expect(offer!.maxRuns, 'the offer must allow THREE runs').toBe(3);
  });

  it('THE RESPONSES LAND: every all-in player answers and the offer is ACCEPTED', async () => {
    vi.useFakeTimers();
    const { e, runoutEvent } = atAllIn();

    // Watch the engine's own lifecycle events. Polling isActive() later is
    // useless: a SUCCESSFUL run-it-twice resolves and clears its own offer,
    // so by the time the boards are dealt isActive is false again - which
    // reads exactly like failure and is the opposite.
    const seen: string[] = [];
    e.runItTwiceEngine.onEvent = (ev: { type: string }) => seen.push(ev.type);

    e.handleAllInRunout(runoutEvent, e.seatedPlayers);
    expect(e.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);

    await vi.advanceTimersByTimeAsync(6000);

    expect(seen, 'the offer must reach RIT_ACCEPTED, never RIT_DECLINED').toContain('RIT_ACCEPTED');
    expect(seen).not.toContain('RIT_DECLINED');
  });

  it('IT ACTUALLY RUNS TWICE: the wait resolves into a multi-board runout', async () => {
    vi.useFakeTimers();
    const { e, runoutEvent, events } = atAllIn();
    const resolved = vi.fn();
    e.dealAndResolveRIT = (...a: unknown[]) => resolved(...a);

    e.handleAllInRunout(runoutEvent, e.seatedPlayers);
    await vi.advanceTimersByTimeAsync(15000);

    expect(
      resolved,
      'the wait must end in dealAndResolveRIT, not a single-board runout'
    ).toHaveBeenCalled();
    void events;
  });

  it('THE MONEY MOVES: a real 2-way all-in runs multiple boards and pays out', async () => {
    vi.useFakeTimers();
    const { e, runoutEvent, events, players } = atAllIn([500, 500]);
    const startingChips = players.reduce((n, p) => n + p.stack, 0);

    // No stubs on the resolver this time - the whole chain runs for real.
    e.handleAllInRunout(runoutEvent, e.seatedPlayers);
    await vi.advanceTimersByTimeAsync(20000);

    const complete = events.find((ev) => ev.type === 'HAND_COMPLETE') as
      | { rake: number; bbjFee: number }
      | undefined;
    expect(complete, 'the hand must finish').toBeTruthy();

    // Dan: "IT DOESN'T AWARD A POT TO THE WINNERS OR ANYTHING."
    const winners = events.filter((ev) => ev.type === 'WINNERS');
    expect(winners.length, 'winners must be recorded').toBeGreaterThan(0);

    // And the chips must still add up once rake and the BBJ fee come out.
    const st = (e.handController as unknown as { state: { players: SeatPlayer[] } }).state;
    const stacks = st.players.reduce((n, p) => n + p.stack, 0);
    const rake = Number(complete?.rake) || 0;
    const bbj = Number(complete?.bbjFee) || 0;
    expect(stacks + rake + bbj, 'no chips created or destroyed by a RIT hand').toBeCloseTo(
      startingChips,
      6
    );
  });
});
