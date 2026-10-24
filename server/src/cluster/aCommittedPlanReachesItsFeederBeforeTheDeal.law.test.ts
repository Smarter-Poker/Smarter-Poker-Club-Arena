/**
 * LAW: a must-move plan the controller commits reaches its feeders before
 * their next deal (Dan 2026-10-23: "MAIN GAME MUST BE FED RIGHT AWAY WHEN A
 * SEAT OPENS UP ... NEXT HAND, PLAYER GOES TO THE MAIN GAME").
 *
 * The planner, the feeders and the Mains all run in one engine process. A
 * plan committed after a feeder's pre-deal read used to be invisible until
 * the feeder had dealt one more hand (live, c485ce7a, 2026-10-24: moves
 * 1440caa7 and 4f1e32f4, planned 0.9 s and 1.2 s before the deal). These pins
 * keep the in-process signal wired at its source: every plan a current pass
 * or wake committed bumps its game's generation the moment the RPC returns,
 * before any follow-up awaits, and nothing else does. A fenced (stopped or
 * superseded) pass signals nothing, like every other post-stop continuation.
 * The engine half is pinned in
 * server/src/engine/aMainSeatTakesTheNextHand.law.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClusterController,
  CLUSTER_WAKE_DEBOUNCE_MS,
  type ClusterControllerDeps,
} from './ClusterController.js';
import {
  movesPlannedGeneration,
  noteMovesPlanned,
  noteSeatArrival,
  resetSeatBoundarySignalsForTest,
  seatArrivalGeneration,
  tickReportsMovesPlanned,
} from './seatBoundarySignals.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

type Rpc = ClusterControllerDeps['rpc'];
const planned = { ok: true, actions: [{ moves_planned: 1 }], seated_total: 4 };
const quiet = { ok: true, actions: [{ moves_expired: 2 }], seated_total: 4 };

function build(rpcImpl: (fn: string) => Promise<{ data: unknown; error: unknown }>) {
  const deps: ClusterControllerDeps = {
    eligibleHorseCount: () => 0,
    eligibleCounts: () => new Map(),
    ensureEngine: vi.fn(async () => true),
    hasEngine: () => true,
    seatedCount: async () => 0,
    frozen: () => false,
    rpc: vi.fn(rpcImpl) as unknown as Rpc,
  };
  return new ClusterController(deps);
}

const pass = (games: Array<{ id: string; result: unknown }>) => ({
  ok: true,
  games: games.length,
  ticked: games.length,
  errors: 0,
  rested: 0,
  results: games.map((g) => ({
    game_id: g.id,
    main1_table_id: g.id + '-main1',
    enabled: true,
    result: g.result,
  })),
  rested_games: [],
});

beforeEach(() => resetSeatBoundarySignalsForTest());
afterEach(() => vi.useRealTimers());

describe('the signal itself', () => {
  it('counts plans per game and arrivals per table, and an unknown id never moves', () => {
    expect(movesPlannedGeneration('g')).toBe(0);
    noteMovesPlanned('g');
    noteMovesPlanned('g');
    noteMovesPlanned(null);
    expect(movesPlannedGeneration('g')).toBe(2);
    expect(movesPlannedGeneration('other')).toBe(0);
    expect(movesPlannedGeneration(undefined)).toBe(0);
    noteSeatArrival('main');
    noteSeatArrival(undefined);
    expect(seatArrivalGeneration('main')).toBe(1);
    expect(seatArrivalGeneration('feeder')).toBe(0);
  });

  it('reads moves_planned out of the actions the SQL actually returns, and nothing else', () => {
    expect(tickReportsMovesPlanned(planned)).toBe(true);
    expect(
      tickReportsMovesPlanned({ actions: [{ main1: 'reopened' }, { moves_planned: 3 }] })
    ).toBe(true);
    expect(tickReportsMovesPlanned(quiet)).toBe(false);
    expect(tickReportsMovesPlanned({ actions: [{ moves_planned: 0 }] })).toBe(false);
    expect(tickReportsMovesPlanned({ actions: [{ moves_planned: '1' }] })).toBe(false);
    expect(tickReportsMovesPlanned({ actions: 'moves_planned' })).toBe(false);
    expect(tickReportsMovesPlanned(null)).toBe(false);
  });
});

describe('a committed plan reaches its game the moment the planner returns', () => {
  it('a pass signals exactly the games it planned for', async () => {
    const controller = build(async () => ({
      data: pass([
        { id: 'fed', result: planned },
        { id: 'still', result: quiet },
      ]),
      error: null,
    }));
    await controller.tick();
    expect(movesPlannedGeneration('fed')).toBe(1);
    expect(movesPlannedGeneration('still')).toBe(0);
  });

  it('a pass fenced by stop() before it returns does no follow-up work and signals nothing', async () => {
    let release!: (value: { data: unknown; error: unknown }) => void;
    const reply = new Promise<{ data: unknown; error: unknown }>((r) => {
      release = r;
    });
    const controller = build(() => reply);
    controller.start();
    const running = controller.tick();
    // stop() fences the generation now and joins the pass once it returns.
    const stopping = controller.stop();
    release({ data: pass([{ id: 'fed', result: planned }]), error: null });
    const summary = await running;
    await stopping;
    expect(summary.ticked).toBe(0); // the stale pass did no follow-up work
    // Fenced like every other continuation (ProducerShutdownOwnership): the
    // plan is committed and the feeder's next pending-move read still finds it.
    expect(movesPlannedGeneration('fed')).toBe(0);
  });

  it('a failed pass signals nothing', async () => {
    const controller = build(async () => ({ data: null, error: { message: 'down' } }));
    await controller.tick();
    expect(movesPlannedGeneration('fed')).toBe(0);
  });

  it('a wake signals its game when its tick planned, and not when it did not', async () => {
    vi.useFakeTimers();
    let result: unknown = planned;
    const controller = build(async (fn) =>
      fn === 'fn_cash_cluster_tick'
        ? { data: result, error: null }
        : { data: pass([]), error: null }
    );
    controller.start();
    controller.wake('woken');
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 1);
    expect(movesPlannedGeneration('woken')).toBe(1);
    result = quiet;
    controller.wake('woken');
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 1);
    expect(movesPlannedGeneration('woken')).toBe(1);
    await controller.stop();
  });
});

describe('a vacancy reaches the planner without the 500 ms burst hold (2026-10-24)', () => {
  function counting(reply: () => Promise<{ data: unknown; error: unknown }>) {
    const calls: string[] = [];
    const controller = build(async (fn) => {
      calls.push(fn);
      return fn === 'fn_cash_cluster_tick' ? reply() : { data: pass([]), error: null };
    });
    return { controller, ticks: () => calls.filter((fn) => fn === 'fn_cash_cluster_tick').length };
  }
  const answer = async () => ({ data: planned, error: null });

  it('an ordinary wake still holds for the debounce', async () => {
    vi.useFakeTimers();
    const { controller, ticks } = counting(answer);
    controller.start();
    controller.wake('g');
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS - 1);
    expect(ticks()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks()).toBe(1);
    await controller.stop();
  });

  it('a vacancy wake plans at once', async () => {
    vi.useFakeTimers();
    const { controller, ticks } = counting(answer);
    controller.start();
    controller.wake('g', { now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks()).toBe(1);
    expect(movesPlannedGeneration('g')).toBe(1);
    await controller.stop();
  });

  it('a vacancy replaces a held wake: one planner call, not two, and no hold', async () => {
    vi.useFakeTimers();
    const { controller, ticks } = counting(answer);
    controller.start();
    controller.wake('g');
    await vi.advanceTimersByTimeAsync(100);
    controller.wake('g', { now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks()).toBe(1);
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 2);
    expect(ticks()).toBe(1);
    await controller.stop();
  });

  it('a vacancy during an in-flight tick never overlaps it and keeps its urgency', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let first = true;
    const { controller, ticks } = counting(async () => {
      if (first) {
        first = false;
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return { data: planned, error: null };
    });
    controller.start();
    controller.wake('g', { now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks()).toBe(1);
    controller.wake('g', { now: true }); // arrives while the first RPC runs
    await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 2);
    expect(ticks()).toBe(1); // never overlapping
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks()).toBe(2); // the follow-up did not wait the hold
    await controller.stop();
  });

  it('the engine sends a vacancy as `now` and every other reason through the hold', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const base = readFileSync(join(__dirname, '..', 'engine', 'ServerTableEngineBase.ts'), 'utf8');
    expect(base).toMatch(/wakeCluster\(String\(gameId\), \{ now: reason === 'seat_left' \}\);/);
    expect(base.match(/wakeCluster\(/g)).toHaveLength(1);
  });
});
