/**
 * THE OFFER WINDOW CLOSES, THE WAIT ENDS, THE HAND RUNS ONCE (2026-09-14).
 *
 * End to end through the REAL host: handleAllInRunout offers, nobody answers,
 * the DeadlineScheduler expires the offer, and the host's wait - which since
 * today LISTENS for the engine's terminal event instead of polling the state
 * every 250 ms - finishes, announces one board with the right reason, and
 * runs the single board to HAND_COMPLETE. The scheduler runs on an injected
 * clock, so the twenty-five second window costs the test nothing.
 *
 * Until now this path was pinned only in pieces: RunItTwiceEngine.consent
 * pins the expiry event, ritSingleRunIsAnnounced pins the forwarder's text,
 * and the multiway test drives a DECLINE through the wait. Nothing drove the
 * TIMEOUT through the wait, which is the one outcome that has no player
 * behind it and therefore no request to trace when it goes wrong.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const equityWorker = vi.hoisted(() => ({
  estimateEquity: vi.fn(),
  estimateInsurance: vi.fn(),
}));

vi.mock('./equity/EquityWorkerPool.js', () => ({
  getEquityPool: () => equityWorker,
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { DeadlineScheduler } from './DeadlineScheduler.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { waitFor } from '../testing/waitBudget.js';

let tableSequence = 0;
let TABLE: string;
const engines = new Set<ServerTableEngine>();

beforeEach(() => {
  TABLE = 'dddddddd-dddd-dddd-dddd-' + String(++tableSequence).padStart(12, '0');
  equityWorker.estimateEquity.mockReset();
  equityWorker.estimateEquity.mockImplementation(async (hands: unknown[][]) =>
    hands.map(() => 1 / hands.length)
  );
});

afterEach(async () => {
  try {
    for (const engine of engines) await engine.stop();
  } finally {
    engines.clear();
    vi.restoreAllMocks();
  }
});

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

/**
 * A host whose RunItTwiceEngine expires offers on a clock the test owns.
 * The scheduler never ticks on its own (its interval is a no-op); the test
 * advances the clock and ticks it by hand, which is exactly what production
 * does every 100 ms with the real clock.
 */
/**
 * The window is the engine's own: applyRunItTwiceConfig() re-reads the table
 * row on every all-in and pins autoDeclineTimeout at 25 s (the reference
 * countdown), so a value passed to configure() here would be overwritten
 * before the offer. The clock starts at the real now because offer() stamps
 * its deadline from Date.now(); the test then moves only this clock.
 */
const OFFER_WINDOW_MS = 25_000;

function harness() {
  const clock = { t: Date.now() };
  const scheduler = new DeadlineScheduler({
    now: () => clock.t,
    setInterval: () => ({}) as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  });
  const players = mkPlayers([500, 500]);
  const events: HandEvent[] = [];
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 5,
      bigBlind: 10,
      rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  hc.onEvent((e) => events.push(e));
  hc.start();
  hc.performAction(1, 'all_in', 0);
  hc.performAction(2, 'all_in', 0);
  const ev = events.find((e) => e.type === 'ALL_IN_RUNOUT');
  expect(ev).toBeDefined();

  const engine = new ServerTableEngine(TABLE) as any;
  engines.add(engine);
  vi.spyOn(engine, 'flushSnapshot').mockResolvedValue(undefined);
  engine.running = true;
  engine.handCount = 1;
  engine.handController = hc;
  engine.lifecycleCanMutate = () => true;
  engine.tableInfo = {
    game_variant: 'nlh',
    big_blind: 10,
    run_it_twice: true,
    allow_run_it_twice: true,
    run_it_twice_enabled: false,
    insurance_enabled: false,
  };
  engine.allInStreetPauseMs = 1;
  engine.allInFirstPauseMs = 1;
  engine.allInStreetRevealMs = 1;
  engine.allInPreShowdownPauseMs = 1;
  engine.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: false, // humans: nobody answers unless the test does
  }));
  const hubEvents: Array<Record<string, unknown>> = [];
  engine.hub = {
    emitEvent: (_tableId: string, payload: Record<string, unknown>) => {
      hubEvents.push(payload);
    },
    publish: vi.fn(),
    sendToUser: vi.fn(),
  };
  // The engine under test, on the test's clock. Installed BEFORE
  // handleAllInRunout so the host wires its forwarder and its wait to it.
  engine.runItTwiceEngine = new RunItTwiceEngine(undefined, scheduler);
  engine.runItTwiceEngine.configure(TABLE, { enabled: true, autoDeclineTimeout: 25, maxRuns: 3 });
  engine.insuranceEngine.configure(TABLE, { enabled: false });

  engine.handleAllInRunout(ev, engine.seatedPlayers);
  return { engine, events, hubEvents, clock, scheduler };
}

const handOver = (events: HandEvent[]) => events.some((e) => e.type === 'HAND_COMPLETE');

describe('the offer window closes and the wait ends', () => {
  it('nobody answers: the expiry ends the wait, one notice says so, the board runs once', async () => {
    const { engine, events, hubEvents, clock, scheduler } = harness();
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(true);
    expect(hubEvents.some((e) => e.type === 'rit_offer')).toBe(true);

    // Nothing happens before the window: the wait is listening, not polling.
    clock.t += OFFER_WINDOW_MS - 5_000;
    expect(scheduler.tickNow()).toBe(0);
    expect(engine.runItTwiceEngine.getState(TABLE)?.status).toBe('offered');
    expect(handOver(events)).toBe(false);

    // The window closes.
    clock.t += 6_000;
    expect(scheduler.tickNow()).toBe(1);
    expect(engine.runItTwiceEngine.getState(TABLE)?.status).toBe('declined');

    await waitFor(() => handOver(events), 'the single-board runout to complete');
    const single = hubEvents.filter((e) => e.type === 'rit_single_run');
    expect(single.length, 'exactly one single-run notice per hand').toBe(1);
    expect(single[0].reason).toBe('no_agreement');
    expect(hubEvents.some((e) => e.type === 'rit_result')).toBe(false);
    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as
      | { communityCards?: unknown[] }
      | undefined;
    expect(complete).toBeDefined();
  });

  it('one seat answered and one stayed silent: the notice names the silent seat', async () => {
    const { engine, events, hubEvents, clock, scheduler } = harness();
    const state = engine.runItTwiceEngine.getState(TABLE)!;
    const chooser = state.chooserPlayerId as string;
    const responder = state.allPlayerIds.find((id: string) => id !== chooser) as string;
    // The chooser picks two boards; the responder never answers.
    expect(engine.respondToRIT(chooser, undefined, 2).success).toBe(true);
    expect(engine.runItTwiceEngine.getState(TABLE)?.status).toBe('offered');

    clock.t += OFFER_WINDOW_MS + 1_000;
    expect(scheduler.tickNow()).toBe(1);

    await waitFor(() => handOver(events), 'the single-board runout to complete');
    const single = hubEvents.filter((e) => e.type === 'rit_single_run');
    expect(single.length).toBe(1);
    expect(single[0].reason).toBe('no_answer');
    expect(single[0].player_id).toBe(responder);
  });

  it('the chooser picking one board ends the wait through the same event, at once', async () => {
    const { engine, events, hubEvents } = harness();
    const chooser = engine.runItTwiceEngine.getState(TABLE)!.chooserPlayerId as string;
    expect(engine.respondToRIT(chooser, undefined, 1).status).toBe('declined_by_chooser');
    // No clock advance, no tick: the event alone finishes the wait.
    await waitFor(() => handOver(events), 'the single-board runout to complete');
    const single = hubEvents.filter((e) => e.type === 'rit_single_run');
    expect(single.length).toBe(1);
    expect(single[0].reason).toBe('chooser_chose_one');
  });

  it('unanimous consent ends the wait through the event and deals the extra board', async () => {
    const { engine, events, hubEvents } = harness();
    const state = engine.runItTwiceEngine.getState(TABLE)!;
    const chooser = state.chooserPlayerId as string;
    const responder = state.allPlayerIds.find((id: string) => id !== chooser) as string;
    expect(engine.respondToRIT(chooser, undefined, 2).success).toBe(true);
    expect(engine.respondToRIT(responder, 'accept').status).toBe('accepted');
    await waitFor(() => handOver(events), 'the two-board hand to complete');
    // The acceptance broadcast precedes the result: the wait finished AFTER
    // respondToRIT's own tail, never inside it.
    const order = hubEvents.map((e) => e.type);
    expect(order.indexOf('rit_all_accepted')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('rit_result')).toBeGreaterThan(order.indexOf('rit_all_accepted'));
    expect(hubEvents.some((e) => e.type === 'rit_single_run')).toBe(false);
  });
});
