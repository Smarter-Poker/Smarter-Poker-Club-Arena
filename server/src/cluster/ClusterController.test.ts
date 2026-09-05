/**
 * THE CLUSTER CONTROLLER is a clock around one SQL function. These tests pin
 * the clock: what it asks, what it passes, when it wakes a dealer, and that
 * the freeze stops it before any I/O (OPORD 1.4 s18.2, s18.4, s18.5).
 */
import { describe, expect, it, vi } from 'vitest';
import { ClusterController, type ClusterControllerDeps } from './ClusterController.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

type Rpc = ClusterControllerDeps['rpc'];

const worklist = (
  rows: Array<Partial<{ game_id: string; main1_table_id: string | null; enabled: boolean }>>
) =>
  rows.map((r, i) => ({
    game_id: r.game_id ?? `game-${i}`,
    club_id: 'club',
    main1_table_id: r.main1_table_id === undefined ? `main1-${i}` : r.main1_table_id,
    state: 'live',
    enabled: r.enabled ?? true,
  }));

function build(
  over: Partial<ClusterControllerDeps> & {
    rows?: ReturnType<typeof worklist>;
    tickResult?: unknown;
  } = {}
) {
  const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === 'fn_cash_clusters_to_tick')
      return { data: over.rows ?? worklist([{}]), error: null };
    if (fn === 'fn_cash_cluster_tick') {
      // The SQL reports the game-wide seated count; the wake path reads it so
      // an empty game costs no second query.
      return { data: over.tickResult ?? { ok: true, actions: [], seated_total: 2 }, error: null };
    }
    return { data: null, error: { message: `unexpected ${fn}` } };
  }) as unknown as Rpc;
  const deps: ClusterControllerDeps = {
    eligibleHorseCount: over.eligibleHorseCount ?? (() => 0),
    ensureEngine: over.ensureEngine ?? vi.fn(async () => true),
    hasEngine: over.hasEngine ?? (() => false),
    seatedCount: over.seatedCount ?? (async () => 0),
    frozen: over.frozen ?? (() => false),
    rpc: over.rpc ?? rpc,
  };
  return { controller: new ClusterController(deps), calls, deps };
}

describe('the tick', () => {
  it('asks for the worklist and ticks every game with the horse demand for its Main 1', async () => {
    const { controller, calls } = build({
      rows: worklist([
        { game_id: 'g1', main1_table_id: 't1' },
        { game_id: 'g2', main1_table_id: 't2' },
      ]),
      eligibleHorseCount: (tableId) => (tableId === 't1' ? 3 : 0),
    });
    const s = await controller.tick();
    expect(s.games).toBe(2);
    expect(s.ticked).toBe(2);
    expect(calls[0].fn).toBe('fn_cash_clusters_to_tick');
    expect(calls.find((c) => c.args?.p_game_id === 'g1')?.args).toEqual({
      p_game_id: 'g1',
      p_eligible_horses: 3,
    });
    expect(calls.find((c) => c.args?.p_game_id === 'g2')?.args).toEqual({
      p_game_id: 'g2',
      p_eligible_horses: 0,
    });
  });

  it('a game with no Main 1 row is ticked with zero horses (the tick reopens it)', async () => {
    const { controller, calls } = build({
      rows: worklist([{ game_id: 'g1', main1_table_id: null }]),
    });
    await controller.tick();
    expect(calls[1].args).toEqual({ p_game_id: 'g1', p_eligible_horses: 0 });
  });

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
      tickResult: { ok: true, actions: [], seated_total: 0 },
    });
    await controller.tick();
    expect(seatedCount).not.toHaveBeenCalled();
  });

  it('ticks games in a bounded pool, every game exactly once', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const rows = worklist(Array.from({ length: 30 }, (_, i) => ({ game_id: `g${i}` })));
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'fn_cash_clusters_to_tick') return { data: rows, error: null };
      inFlight++;
      peak = Math.max(peak, inFlight);
      seen.push(String(args?.p_game_id));
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { data: { ok: true, actions: [], seated_total: 0 }, error: null };
    }) as unknown as Rpc;
    const { controller } = build({ rpc });
    const s = await controller.tick();
    expect(s.ticked).toBe(30);
    expect(new Set(seen).size).toBe(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(s.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('a disabled game is ticked (its tables drain) but never woken', async () => {
    const ensureEngine = vi.fn(async () => true);
    const { controller, calls } = build({
      rows: worklist([{ game_id: 'g1', enabled: false }]),
      ensureEngine,
      seatedCount: async () => 3,
    });
    const s = await controller.tick();
    expect(s.ticked).toBe(1);
    expect(calls.some((c) => c.fn === 'fn_cash_cluster_tick')).toBe(true);
    expect(ensureEngine).not.toHaveBeenCalled();
  });

  it('records the actions the SQL took, per game', async () => {
    const { controller } = build({ tickResult: { ok: true, actions: [{ feeder: 'opened' }] } });
    const s = await controller.tick();
    expect(s.actions).toEqual([{ game_id: 'game-0', actions: [{ feeder: 'opened' }] }]);
  });
});

describe('the freeze (CLAUDE.md 13, OPORD 1.4 18.5)', () => {
  it('a frozen tick does no I/O at all and says so', async () => {
    const { controller, calls } = build({ frozen: () => true });
    const s = await controller.tick();
    expect(s.skippedFrozen).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('no memory, no overlap, no cascade', () => {
  it('one game failing does not stop the others', async () => {
    const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'fn_cash_clusters_to_tick') {
        return { data: worklist([{ game_id: 'bad' }, { game_id: 'good' }]), error: null };
      }
      if (args?.p_game_id === 'bad') return { data: null, error: { message: 'boom' } };
      return { data: { ok: true, actions: [] }, error: null };
    }) as unknown as Rpc;
    const controller = new ClusterController({
      eligibleHorseCount: () => 0,
      ensureEngine: async () => true,
      hasEngine: () => true,
      seatedCount: async () => 0,
      frozen: () => false,
      rpc,
    });
    const s = await controller.tick();
    expect(s.errors).toBe(1);
    expect(s.ticked).toBe(1);
  });

  it('a tick still running when the next fires is not run twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'fn_cash_clusters_to_tick') {
        await gate;
        return { data: worklist([{}]), error: null };
      }
      return { data: { ok: true, actions: [] }, error: null };
    }) as unknown as Rpc;
    const controller = new ClusterController({
      eligibleHorseCount: () => 0,
      ensureEngine: async () => true,
      hasEngine: () => true,
      seatedCount: async () => 0,
      frozen: () => false,
      rpc,
    });
    const first = controller.tick();
    const second = await controller.tick();
    expect(second.games).toBe(0);
    release();
    const done = await first;
    expect(done.games).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(2);
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
      rows: worklist([{}, {}, {}]),
    });
    const s = await controller.tick();
    expect(ensureEngine).toHaveBeenCalledTimes(3);
    expect(released).toBe(false); // the pass finished before any wake did
    expect(s.woken).toBe(3);
    expect(s.ticked).toBe(3);
    // ...and the next pass is not blocked either.
    const again = await controller.tick();
    expect(again.ticked).toBe(3);
    expect(calls.filter((c) => c.fn === 'fn_cash_cluster_tick')).toHaveLength(6);
  });

  it('a pass stuck past the stall ceiling is reported and the latch released', async () => {
    vi.useFakeTimers();
    try {
      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => (releaseGate = r));
      let firstCall = true;
      const rpc = vi.fn(async (fn: string) => {
        if (fn === 'fn_cash_clusters_to_tick') {
          if (firstCall) {
            firstCall = false;
            await gate; // a pass that never comes back on its own
          }
          return { data: worklist([{}]), error: null };
        }
        return { data: { ok: true, actions: [] }, error: null };
      }) as unknown as Rpc;
      const controller = new ClusterController({
        eligibleHorseCount: () => 0,
        ensureEngine: async () => true,
        hasEngine: () => true,
        seatedCount: async () => 0,
        frozen: () => false,
        rpc,
      });
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
