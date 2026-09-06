/**
 * THE CLUSTER CONTROLLER is a clock around one SQL function. These tests pin
 * the clock: that a pass is ONE RPC carrying the fleet's whole census keyed by
 * Main 1, what it does with each game's result, when it wakes a dealer, that a
 * seat change wakes one game (debounced, coalesced, leader-only), and that the
 * freeze stops it before any I/O (OPORD 1.4 s18.2, s18.4, s18.5).
 *
 * PINS MOVED 2026-09-05 (one tick RPC per pass): the first cut asked for a
 * worklist and then ticked each game through an eight-wide pool. That shape
 * was deliberately replaced by fn_cash_clusters_tick_all, so the pins on
 * "asks for the worklist", "bounded pool" and "one game failing" now assert
 * the new mechanism - one call, the SQL's per-game results, the SQL's caught
 * errors - and the behaviour they guarded (every game once, one failure never
 * stops the rest, the wake is never awaited) is asserted the same as before.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ClusterController,
  CLUSTER_WAKE_DEBOUNCE_MS,
  wakeCluster,
  type ClusterControllerDeps,
  type ClusterTickAllEntry,
  type ClusterTickAllRestedEntry,
} from './ClusterController.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

type Rpc = ClusterControllerDeps['rpc'];

/** What fn_cash_clusters_tick_all returns for a set of games. */
const passOf = (
  rows: Array<
    Partial<{ game_id: string; main1_table_id: string | null; enabled: boolean }> & {
      result?: unknown;
      error?: { sqlstate?: string; message?: string };
    }
  >,
  extra: Partial<{
    rested: number;
    games: number;
    restedGames: ClusterTickAllRestedEntry[];
  }> = {}
) => {
  const results: ClusterTickAllEntry[] = rows.map((r, i) => {
    const entry: ClusterTickAllEntry = {
      game_id: r.game_id ?? `game-${i}`,
      main1_table_id: r.main1_table_id === undefined ? `main1-${i}` : r.main1_table_id,
      enabled: r.enabled ?? true,
    };
    if (r.error) entry.error = r.error;
    else entry.result = (r.result ?? { ok: true, actions: [], seated_total: 2 }) as never;
    return entry;
  });
  const errors = results.filter((r) => r.error).length;
  const restedGames = extra.restedGames ?? [];
  return {
    ok: true,
    games: extra.games ?? results.length + (extra.rested ?? restedGames.length),
    ticked: results.length - errors,
    errors,
    rested: extra.rested ?? restedGames.length,
    results,
    rested_games: restedGames,
  };
};

function build(
  over: Partial<ClusterControllerDeps> & {
    pass?: ReturnType<typeof passOf>;
    tickResult?: unknown;
  } = {}
) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === 'fn_cash_clusters_tick_all') return { data: over.pass ?? passOf([{}]), error: null };
    if (fn === 'fn_cash_cluster_tick') {
      return { data: over.tickResult ?? { ok: true, actions: [], seated_total: 2 }, error: null };
    }
    return { data: null, error: { message: `unexpected ${fn}` } };
  }) as unknown as Rpc;
  const deps: ClusterControllerDeps = {
    eligibleHorseCount: over.eligibleHorseCount ?? (() => 0),
    eligibleCounts: over.eligibleCounts ?? (() => new Map()),
    ensureEngine: over.ensureEngine ?? vi.fn(async () => true),
    hasEngine: over.hasEngine ?? (() => false),
    seatedCount: over.seatedCount ?? (async () => 0),
    frozen: over.frozen ?? (() => false),
    rpc: over.rpc ?? rpc,
  };
  return { controller: new ClusterController(deps), calls, deps };
}

describe('the pass is one RPC', () => {
  it('makes exactly one call, fn_cash_clusters_tick_all, however many games there are', async () => {
    const { controller, calls } = build({
      pass: passOf(Array.from({ length: 120 }, (_, i) => ({ game_id: `g${i}` }))),
    });
    const s = await controller.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('fn_cash_clusters_tick_all');
    expect(s.rpcs).toBe(1);
    expect(s.games).toBe(120);
    expect(s.ticked).toBe(120);
  });

  it('never asks for the worklist or ticks a game itself during a pass', async () => {
    const { controller, calls } = build({ pass: passOf([{}, {}, {}]) });
    await controller.tick();
    expect(calls.map((c) => c.fn)).not.toContain('fn_cash_clusters_to_tick');
    expect(calls.map((c) => c.fn)).not.toContain('fn_cash_cluster_tick');
  });

  it('sends the fleet census keyed by Main 1 table id, zero counts omitted', async () => {
    const { controller, calls } = build({
      eligibleCounts: () =>
        new Map([
          ['t1', 3],
          ['t2', 0],
          ['t3', 1],
        ]),
    });
    await controller.tick();
    expect(calls[0].args).toEqual({ p_eligible: { t1: 3, t3: 1 } });
  });

  it('sends an empty map when the fleet has counted nothing', async () => {
    const { controller, calls } = build();
    await controller.tick();
    expect(calls[0].args).toEqual({ p_eligible: {} });
  });

  it('reports how many games the SQL let rest', async () => {
    const { controller } = build({ pass: passOf([{}, {}], { rested: 39 }) });
    const s = await controller.tick();
    expect(s.games).toBe(41);
    expect(s.ticked).toBe(2);
    expect(s.rested).toBe(39);
  });

  it('a failed pass RPC is one error and no games', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'boom' } })) as unknown as Rpc;
    const { controller } = build({ rpc });
    const s = await controller.tick();
    expect(s.errors).toBe(1);
    expect(s.games).toBe(0);
    expect(s.rpcs).toBe(1);
  });
});

describe('each game result is handled as before', () => {
  it('wakes a dealer for a Main 1 that has a seat and no engine (18.4)', async () => {
    const ensureEngine = vi.fn(async () => true);
    const { controller } = build({
      ensureEngine,
      seatedCount: async () => 2,
      hasEngine: () => false,
    });
    const s = await controller.tick();
    expect(ensureEngine).toHaveBeenCalledWith('main1-0');
    expect(s.woken).toBe(1);
  });

  it('does not wake a dealer for an empty Main 1, nor for one that has an engine', async () => {
    const ensureEngine = vi.fn(async () => true);
    const empty = build({ ensureEngine, seatedCount: async () => 0 });
    await empty.controller.tick();
    const owned = build({ ensureEngine, seatedCount: async () => 4, hasEngine: () => true });
    await owned.controller.tick();
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('an empty game is not even asked about its Main 1 (the tick said nobody is seated)', async () => {
    const seatedCount = vi.fn(async () => 0);
    const { controller } = build({
      seatedCount,
      pass: passOf([{ result: { ok: true, actions: [], seated_total: 0 } }]),
    });
    await controller.tick();
    expect(seatedCount).not.toHaveBeenCalled();
  });

  it('a game with no Main 1 row is ticked (the SQL reopens it) and never woken', async () => {
    const ensureEngine = vi.fn(async () => true);
    const { controller } = build({
      ensureEngine,
      seatedCount: async () => 3,
      pass: passOf([{ game_id: 'g1', main1_table_id: null }]),
    });
    const s = await controller.tick();
    expect(s.ticked).toBe(1);
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('a disabled game is ticked (its tables drain) but never woken', async () => {
    const ensureEngine = vi.fn(async () => true);
    const { controller } = build({
      pass: passOf([{ game_id: 'g1', enabled: false }]),
      ensureEngine,
      seatedCount: async () => 3,
    });
    const s = await controller.tick();
    expect(s.ticked).toBe(1);
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('records the actions the SQL took, per game', async () => {
    const { controller } = build({
      pass: passOf([{ result: { ok: true, actions: [{ feeder: 'opened' }] } }]),
    });
    const s = await controller.tick();
    expect(s.actions).toEqual([{ game_id: 'game-0', actions: [{ feeder: 'opened' }] }]);
  });

  it('a game the SQL caught an error for is counted as an error and the rest are ticked', async () => {
    const { controller } = build({
      pass: passOf([
        { game_id: 'bad', error: { sqlstate: 'P0001', message: 'boom' } },
        { game_id: 'good' },
        { game_id: 'also-good' },
      ]),
    });
    const s = await controller.tick();
    expect(s.errors).toBe(1);
    expect(s.ticked).toBe(2);
    const { reportError } = await import('../services/errorReporter.js');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'ClusterController.tick_rpc_failed',
      expect.objectContaining({ game_id: 'bad', sqlstate: 'P0001' })
    );
  });
});

describe('the freeze (CLAUDE.md 13, OPORD 1.4 18.5)', () => {
  it('a frozen tick does no I/O at all and says so', async () => {
    const { controller, calls } = build({ frozen: () => true });
    const s = await controller.tick();
    expect(s.skippedFrozen).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('the SQL seeing the freeze first is reported the same way', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        ok: false,
        skipped: 'frozen',
        games: 0,
        ticked: 0,
        errors: 0,
        rested: 0,
        results: [],
      },
      error: null,
    })) as unknown as Rpc;
    const { controller } = build({ rpc });
    const s = await controller.tick();
    expect(s.skippedFrozen).toBe(true);
    expect(s.errors).toBe(0);
  });
});

/**
 * A RESTED GAME ANSWERS THE WAKE (2026-09-05, migration 20260906011113).
 *
 * The pass CONTINUEs past a dormant, empty, unwanted game before it builds a
 * result entry, so it appeared in no roster the controller could read. The map
 * the wake consults was built from `results` alone, so a wake on a rested game
 * found nothing, read `enabled` as false and skipped the 18.4 dealer wake -
 * for exactly the dormant game a wake exists to serve. The SQL now returns a
 * `rested_games` roster; the controller folds it in as IDENTITY ONLY.
 */
describe('the rested roster is identity, and the wake can read it', () => {
  const rested = (over: Partial<ClusterTickAllRestedEntry> = {}): ClusterTickAllRestedEntry => ({
    game_id: 'sleepy',
    main1_table_id: 'sleepy-main1',
    enabled: true,
    state: 'dormant',
    ...over,
  });

  it('a wake on a game the pass only RESTED still finds its Main 1 and its horse demand', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build({
        pass: passOf([{ game_id: 'g1', main1_table_id: 't1' }], { restedGames: [rested()] }),
        eligibleHorseCount: (t) => (t === 'sleepy-main1' ? 3 : 0),
      });
      controller.start();
      await controller.tick();
      calls.length = 0;
      controller.wake('sleepy');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 1);
      expect(calls).toEqual([
        { fn: 'fn_cash_cluster_tick', args: { p_game_id: 'sleepy', p_eligible_horses: 3 } },
      ]);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('and its enabled flag, so the 18.4 dealer wake is not skipped for a dormant game', async () => {
    vi.useFakeTimers();
    try {
      const ensureEngine = vi.fn(async () => true);
      const { controller } = build({
        pass: passOf([{ game_id: 'g1', main1_table_id: 't1' }], { restedGames: [rested()] }),
        ensureEngine,
        hasEngine: () => false,
        seatedCount: async () => 3,
        tickResult: { ok: true, actions: [], seated_total: 3 },
      });
      controller.start();
      await controller.tick();
      ensureEngine.mockClear();
      controller.wake('sleepy');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 1);
      expect(ensureEngine).toHaveBeenCalledWith('sleepy-main1');
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rested game is not a ticked one: it is counted once, in rested, and never dealt with', async () => {
    const ensureEngine = vi.fn(async () => true);
    const { controller } = build({
      pass: passOf([{ game_id: 'g1', main1_table_id: 't1' }], {
        restedGames: [rested(), rested({ game_id: 'sleepy-2', main1_table_id: 'sleepy-2-main1' })],
      }),
      ensureEngine,
      seatedCount: async () => 0,
    });
    const s = await controller.tick();
    expect(s.ticked).toBe(1);
    expect(s.rested).toBe(2);
    expect(s.games).toBe(3);
    expect(s.errors).toBe(0);
    // No result, so no afterGameTick: a rested game never wakes a dealer from
    // the pass itself, only from a wake that reads the row it just learned.
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('a pass with no rested_games at all is unchanged (an older engine, or an empty roster)', async () => {
    const { controller } = build({ pass: passOf([{}, {}], { rested: 4 }) });
    const s = await controller.tick();
    expect(s.ticked).toBe(2);
    expect(s.rested).toBe(4);
  });
});

describe('a seat change wakes its game', () => {
  it('wake() ticks ONE game through the per-game RPC with its Main 1 horse demand, after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build({
        pass: passOf([{ game_id: 'g1', main1_table_id: 't1' }]),
        eligibleHorseCount: (t) => (t === 't1' ? 4 : 0),
      });
      controller.start();
      await controller.tick(); // the pass teaches the controller g1's Main 1
      calls.length = 0;
      controller.wake('g1');
      expect(calls).toHaveLength(0); // not yet
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS - 1);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([
        { fn: 'fn_cash_cluster_tick', args: { p_game_id: 'g1', p_eligible_horses: 4 } },
      ]);
      expect(controller.wakeStats.fired).toBe(1);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('many wakes for one game inside the window are one tick', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build();
      controller.start();
      for (let i = 0; i < 25; i++) controller.wake('g1');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      expect(calls.filter((c) => c.fn === 'fn_cash_cluster_tick')).toHaveLength(1);
      expect(controller.wakeStats.coalesced).toBe(24);
      expect(controller.wakeStats.pending).toBe(0);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes for different games are separate ticks, each once', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build();
      controller.start();
      controller.wake('g1');
      controller.wake('g2');
      controller.wake('g1');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      const ticks = calls.filter((c) => c.fn === 'fn_cash_cluster_tick');
      expect(ticks.map((c) => c.args?.p_game_id).sort()).toEqual(['g1', 'g2']);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wake is a no-op when the controller is not running (non-leader)', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build();
      controller.wake('g1');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 4);
      expect(calls).toHaveLength(0);
      expect(controller.wakeStats.fired).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the module-level wakeCluster reaches the running controller and is a no-op without one', async () => {
    vi.useFakeTimers();
    try {
      wakeCluster('nobody-home'); // no controller started: nothing happens, nothing throws
      const { controller, calls } = build();
      controller.start();
      wakeCluster('g1');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      expect(calls.filter((c) => c.fn === 'fn_cash_cluster_tick')).toHaveLength(1);
      controller.stop();
      calls.length = 0;
      wakeCluster('g1'); // stopped: gone from the module slot
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wake never throws into the caller, even when the RPC fails or the tick throws', async () => {
    vi.useFakeTimers();
    try {
      const rpc = vi.fn(async (fn: string) => {
        if (fn === 'fn_cash_cluster_tick') throw new Error('transport down');
        return { data: passOf([{}]), error: null };
      }) as unknown as Rpc;
      const { controller } = build({ rpc });
      controller.start();
      expect(() => wakeCluster('g1')).not.toThrow();
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      const { reportError } = await import('../services/errorReporter.js');
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'ClusterController.wake_tick_error',
        expect.objectContaining({ game_id: 'g1' })
      );
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wake is skipped while frozen', async () => {
    vi.useFakeTimers();
    try {
      let frozen = false;
      const { controller, calls } = build({ frozen: () => frozen });
      controller.start();
      controller.wake('g1');
      frozen = true;
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      expect(calls).toHaveLength(0);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wake wakes the dealer too (18.4), never awaited', async () => {
    vi.useFakeTimers();
    try {
      let released = false;
      const ensureEngine = vi.fn(
        () => new Promise<boolean>((r) => setTimeout(() => ((released = true), r(true)), 50_000))
      );
      const { controller } = build({
        ensureEngine,
        seatedCount: async () => 1,
        pass: passOf([{ game_id: 'g1', main1_table_id: 't1' }]),
        tickResult: { ok: true, actions: [], seated_total: 1 },
      });
      controller.start();
      await controller.tick();
      ensureEngine.mockClear();
      controller.wake('g1');
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS + 5);
      expect(ensureEngine).toHaveBeenCalledWith('t1');
      expect(released).toBe(false);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() drops pending wakes', async () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = build();
      controller.start();
      controller.wake('g1');
      controller.stop();
      await vi.advanceTimersByTimeAsync(CLUSTER_WAKE_DEBOUNCE_MS * 2);
      expect(calls).toHaveLength(0);
      expect(controller.wakeStats.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('no memory, no overlap, no cascade', () => {
  it('a tick still running when the next fires is not run twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'fn_cash_clusters_tick_all') {
        await gate;
        return { data: passOf([{}]), error: null };
      }
      return { data: { ok: true, actions: [] }, error: null };
    }) as unknown as Rpc;
    const { controller } = build({ rpc, hasEngine: () => true });
    const first = controller.tick();
    const second = await controller.tick();
    expect(second.games).toBe(0);
    release();
    const done = await first;
    expect(done.games).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a wake that takes the life of the table does not take the pass with it', async () => {
    /* Live 2026-09-04 22:10 UTC: ensureEngine resolves when engine.start()
       resolves, and start() waits for a second player. One Main 1 with one
       player seated held a worker open, the pass never ended, and the latch
       silenced the controller for 11 minutes. */
    let released = false;
    const ensureEngine = vi.fn(
      () => new Promise<boolean>((r) => setTimeout(() => ((released = true), r(true)), 50))
    );
    const { controller, calls } = build({
      ensureEngine,
      seatedCount: async () => 1,
      pass: passOf([{}, {}, {}]),
    });
    const s = await controller.tick();
    expect(ensureEngine).toHaveBeenCalledTimes(3);
    expect(released).toBe(false); // the pass finished before any wake did
    expect(s.woken).toBe(3);
    expect(s.ticked).toBe(3);
    // ...and the next pass is not blocked either.
    const again = await controller.tick();
    expect(again.ticked).toBe(3);
    expect(calls.filter((c) => c.fn === 'fn_cash_clusters_tick_all')).toHaveLength(2);
  });

  it('a pass stuck past the stall ceiling is reported and the latch released', async () => {
    vi.useFakeTimers();
    try {
      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => (releaseGate = r));
      let firstCall = true;
      const rpc = vi.fn(async (fn: string) => {
        if (fn === 'fn_cash_clusters_tick_all') {
          if (firstCall) {
            firstCall = false;
            await gate; // a pass that never comes back on its own
          }
          return { data: passOf([{}]), error: null };
        }
        return { data: { ok: true, actions: [] }, error: null };
      }) as unknown as Rpc;
      const { controller } = build({ rpc, hasEngine: () => true });
      const stuck = controller.tick();
      // Under the ceiling: still guarded, nothing runs twice.
      vi.setSystemTime(Date.now() + 60_000);
      expect((await controller.tick()).games).toBe(0);
      // Over it: the latch is released and a fresh pass runs to completion.
      vi.setSystemTime(Date.now() + 120_000);
      const fresh = await controller.tick();
      expect(fresh.games).toBe(1);
      expect(fresh.ticked).toBe(1);
      const { reportError } = await import('../services/errorReporter.js');
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'ClusterController.tick_stalled');
      releaseGate();
      await stuck;
    } finally {
      vi.useRealTimers();
    }
  });

  it('start is idempotent and stop clears the clock', () => {
    vi.useFakeTimers();
    const { controller } = build();
    controller.start();
    controller.start();
    expect(controller.isRunning).toBe(true);
    controller.stop();
    expect(controller.isRunning).toBe(false);
    vi.useRealTimers();
  });
});
