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
      return { data: over.tickResult ?? { ok: true, actions: [] }, error: null };
    }
    return { data: null, error: { message: `unexpected ${fn}` } };
  }) as unknown as Rpc;
  const deps: ClusterControllerDeps = {
    eligibleHorseCount: over.eligibleHorseCount ?? (() => 0),
    ensureEngine: over.ensureEngine ?? vi.fn(async () => true),
    hasEngine: over.hasEngine ?? (() => false),
    seatedCount: over.seatedCount ?? (async () => 0),
    frozen: over.frozen ?? (() => false),
    rpc,
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
