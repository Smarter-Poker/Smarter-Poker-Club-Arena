/**
 * LIGHTNING PHASE 7: LIGHTNING -> MUST_MOVE, THE ENGINE'S HALF (2026-10-02).
 *
 *   - discovery finds `pending_off` Clusters as well as `lightning` ones,
 *     whatever `lightning_enabled` says, and says which are draining (a
 *     `lightning` Cluster switched off drains until the tick moves it on);
 *   - a draining worker forms nothing and calls nothing, while the hands in
 *     the air are left to their hosts (nothing is abandoned);
 *   - a Cluster that turns back to `lightning` forms again;
 *   - when the Cluster is MUST MOVE it leaves discovery: its worker stops and
 *     the ended-room sweep runs at once, closing each room with
 *     "Lightning Has Ended" (any other ending keeps its own words).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  rows: [] as unknown[],
}));
vi.mock('../services/supabase/client.js', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    db.calls.push(['from', table]);
    for (const m of ['select', 'in', 'eq']) {
      c[m] = (...a: unknown[]) => {
        db.calls.push([m, ...a]);
        return c;
      };
    }
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: db.rows, error: null });
    return c;
  };
  return { supabase: { from: chain, rpc: vi.fn() }, maintenanceSupabase: {} };
});
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String((e as Error)?.message ?? e),
}));

const {
  discoverLightningClusters,
  parseDiscoveredClusters,
  LightningSupervisor,
  LIGHTNING_ROOM_SWEEP_INTERVAL_MS,
  LIGHTNING_WORKER_CLUSTER_MODES,
} = await import('./LightningSupervisor.js');
const { LightningClusterWorker } = await import('./LightningClusterWorker.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { LightningRegistry, LIGHTNING_HAS_ENDED_REASON, LIGHTNING_SESSION_ENDED_REASON } =
  await import('./LightningRegistry.js');
import { LIGHTNING_AUTO_REBUY_DEFAULTS, type LightningConfig } from './LightningConfig.js';
import type { LightningRpcClient } from './LightningRpc.js';

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ROOM = '0c0c0c0c-0000-4000-8000-00000000000c';
const USER = '0d0d0d0d-0000-4000-8000-00000000000d';

const form: LightningConfig = {
  matcherVersion: 'm-2026-10-02',
  workerMode: 'form',
  passIntervalMs: 1_000,
  keepaliveIntervalMs: 30_000,
  maxHandsPerPass: 8,
  dealWindowMs: 600_000,
  autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
};

const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function formRpc() {
  return vi.fn(async (fn: string) => {
    if (fn === 'fn_lightning_config') return { data: { worker_mode: 'form' }, error: null };
    if (fn === 'fn_lightning_match_and_form') return { data: { ok: true, hands: [] }, error: null };
    if (fn === 'fn_lightning_match') return { data: null, error: null };
    throw new Error('unexpected rpc ' + fn);
  }) as unknown as LightningRpcClient & ReturnType<typeof vi.fn>;
}

function hostingStub() {
  return {
    startHand: vi.fn(),
    hasInstance: vi.fn(() => false),
    formBackoffUntil: vi.fn(() => 0),
    leaseFor: vi.fn(() => ({ tableId: 'front' })),
    abortCluster: vi.fn(async () => {}),
    abortAll: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  db.calls = [];
  db.rows = [];
});

describe('discovery includes the Clusters draining out of Lightning', () => {
  it('asks for lightning AND pending_off, whatever lightning_enabled says, and says which drain', async () => {
    db.rows = [
      { id: A, cluster_mode: 'lightning', lightning_enabled: true },
      { id: B, cluster_mode: 'pending_off', lightning_enabled: false },
    ];
    expect(await discoverLightningClusters()).toEqual([
      { clusterId: A, draining: false },
      { clusterId: B, draining: true },
    ]);
    expect(db.calls).toContainEqual(['select', 'id, cluster_mode, lightning_enabled']);
    // Widened by Lightning Phase 13: the operator's draining and paused modes
    // hold a worker too (LightningPhase13RolloutDrain.test.ts).
    const modes = db.calls.find((c) => c[0] === 'in' && c[1] === 'cluster_mode')?.[2];
    expect(modes).toEqual(expect.arrayContaining(['lightning', 'pending_off']));
    // No flag filter: a Cluster switched off mid-hand must not drop out.
    expect(db.calls.filter((c) => c[0] === 'eq')).toEqual([]);
    expect([...LIGHTNING_WORKER_CLUSTER_MODES]).toEqual(
      expect.arrayContaining(['lightning', 'pending_off'])
    );
    expect([...LIGHTNING_WORKER_CLUSTER_MODES].slice(0, 2)).toEqual(['lightning', 'pending_off']);
  });

  it('a lightning Cluster forms only with lightning_enabled exactly true; otherwise it drains', () => {
    expect(
      parseDiscoveredClusters([
        { id: A, cluster_mode: 'lightning', lightning_enabled: false },
        { id: B, cluster_mode: 'lightning' },
      ])
    ).toEqual([
      { clusterId: A, draining: true },
      { clusterId: B, draining: true },
    ]);
    expect(
      parseDiscoveredClusters([{ id: B, cluster_mode: 'pending_off', lightning_enabled: true }])
    ).toEqual([{ clusterId: B, draining: true }]);
  });

  it('a row in any other mode, or with a malformed id, is no Cluster at all', () => {
    expect(
      parseDiscoveredClusters([
        { id: A, cluster_mode: 'must_move' },
        { id: A, cluster_mode: 'pending_on' },
        { id: 'nope', cluster_mode: 'lightning' },
        null,
        { id: B, cluster_mode: 'pending_off' },
      ])
    ).toEqual([{ clusterId: B, draining: true }]);
    expect(parseDiscoveredClusters(null)).toEqual([]);
  });
});

describe('a draining worker', () => {
  function worker(rpc = formRpc()) {
    const logger = quiet();
    let nowMs = 1_000_000;
    const startHand = vi.fn();
    const w = new LightningClusterWorker(A, form, {
      rpc,
      presence: new LightningPresence(() => []),
      metrics: new LightningMetrics(new MetricsRegistry()),
      logger,
      now: () => new Date(nowMs),
      startHand,
      hasInstance: () => false,
      formBackoffUntil: () => 0,
      holdsFrontTableLease: async () => true,
    });
    return { w, rpc, logger, startHand, advance: (ms: number) => (nowMs += ms) };
  }

  it('calls neither match_and_form nor the matcher, and forms again once back in lightning', async () => {
    const { w, rpc } = worker();
    w.setDraining(true);
    expect(w.isDraining).toBe(true);
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pending_off' });
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pending_off' });
    expect(rpc).not.toHaveBeenCalled();
    w.setDraining(false);
    expect((await w.pass()).outcome).toBe('formed');
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['fn_lightning_match_and_form']);
  });

  it('keeps its keepalive line, once per keepalive interval', async () => {
    const { w, logger, advance } = worker();
    w.setDraining(true);
    logger.log.mockClear();
    await w.pass();
    await w.pass();
    const drainLines = () =>
      logger.log.mock.calls.filter((c) => String(c[0]).includes('draining (pending_off)'));
    expect(drainLines()).toHaveLength(1);
    advance(form.keepaliveIntervalMs);
    await w.pass();
    expect(drainLines()).toHaveLength(2);
  });

  it('a freed player does not wake a draining worker', async () => {
    vi.useFakeTimers();
    const { w, rpc } = worker();
    w.setDraining(true);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    w.wake();
    w.wake();
    await vi.advanceTimersByTimeAsync(form.passIntervalMs * 3);
    expect(rpc).not.toHaveBeenCalled();
    expect(w.passCount).toBe(4);
    await w.stop();
  });
});

describe('the supervisor through LIGHTNING -> PENDING_OFF -> MUST_MOVE', () => {
  it('keeps the worker (draining) and every hand in the air, then stops it and closes the rooms at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let mode: 'lightning' | 'pending_off' | 'must_move' = 'lightning';
    const rpc = formRpc();
    const hosting = hostingStub();
    const closed: Array<[string, string]> = [];
    let poolOpen = true;
    const registry = new LightningRegistry({
      viewAccess: async () => poolOpen,
      roomOwner: async () => ({ playerId: USER, clusterId: A }),
      clusterMode: async () => mode,
      closeRoom: (room, reason) => closed.push([room, reason]),
    });
    await registry.authorize(ROOM, USER);
    registry.connect(ROOM, USER);
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () =>
        mode === 'must_move' ? [] : [{ clusterId: A, draining: mode === 'pending_off' }],
      rpc,
      hosting: hosting as never,
      sweepRooms: () => registry.sweepEndedRooms(),
      frontTable: async () => 'front',
      frozen: () => false,
      logger: quiet(),
      metrics: new LightningMetrics(new MetricsRegistry()),
    });
    sup.start();
    await sup.reconcile();
    const w = sup.workerFor(A)!;
    expect(w.isDraining).toBe(false);

    mode = 'pending_off';
    await sup.reconcile();
    expect(sup.workerFor(A)).toBe(w); // the same worker, not a new one
    expect(w.isRunning).toBe(true);
    expect(w.isDraining).toBe(true);
    rpc.mockClear();
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pending_off' });
    expect(rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_match_and_form')).toHaveLength(0);
    // In-flight hands play on: nothing of the Cluster was abandoned.
    expect(hosting.abortCluster).not.toHaveBeenCalled();
    expect(hosting.abortAll).not.toHaveBeenCalled();
    expect(closed).toEqual([]);

    // commit_must_move: every pool session exited, the Cluster is MUST MOVE.
    mode = 'must_move';
    poolOpen = false;
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
    expect(w.isRunning).toBe(false);
    // Swept at once, well inside the sweep interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toEqual([[ROOM, LIGHTNING_HAS_ENDED_REASON]]);
    expect(LIGHTNING_ROOM_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
    await sup.stop();
  });

  it('a worker first started on a pending_off Cluster (a new leader mid-drain) starts draining', async () => {
    const rpc = formRpc();
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () => [{ clusterId: B, draining: true }],
      rpc,
      hosting: hostingStub() as never,
      frontTable: async () => 'front',
      frozen: () => false,
      logger: quiet(),
      metrics: new LightningMetrics(new MetricsRegistry()),
    });
    sup.start();
    await sup.reconcile();
    const w = sup.workerFor(B)!;
    expect(w.isDraining).toBe(true);
    rpc.mockClear();
    await w.pass();
    expect(rpc).not.toHaveBeenCalled();
    await sup.stop();
  });
});

describe('Lightning switched off while a hand is being dealt', () => {
  it('the hand settles under its host: the worker drains, nothing is abandoned', async () => {
    // The real discovery read, against cash_games rows the test changes.
    const row = { id: A, cluster_mode: 'lightning', lightning_enabled: true };
    let rows: unknown[] = [row];
    const HAND = '0e0e0e0e-0000-4000-8000-00000000000e';
    const INSTANCE = '0f0f0f0f-0000-4000-8000-00000000000f';
    const P1 = '01010101-0000-4000-8000-000000000001';
    const P2 = '02020202-0000-4000-8000-000000000002';
    let formedOnce = false;
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'fn_lightning_config') return { data: { worker_mode: 'form' }, error: null };
      if (fn === 'fn_lightning_match_and_form') {
        if (formedOnce) return { data: { ok: true, hands: [] }, error: null };
        formedOnce = true;
        return {
          data: {
            ok: true,
            hands: [
              { hand_id: HAND, instance_id: INSTANCE, bb: P1, sb: P2, btn: P2, players: [P1, P2] },
            ],
          },
          error: null,
        };
      }
      throw new Error('unexpected rpc ' + fn);
    }) as unknown as LightningRpcClient & ReturnType<typeof vi.fn>;
    // A host that keeps each hand until it settles; an abort voids them.
    const live = new Set<string>();
    const voided: string[] = [];
    const hosting = {
      ...hostingStub(),
      startHand: vi.fn((hand: { instanceId: string }) => live.add(hand.instanceId)),
      hasInstance: vi.fn((id: string) => live.has(id)),
      abortCluster: vi.fn(async () => {
        voided.push(...live);
        live.clear();
      }),
    };
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () => {
        db.rows = rows;
        return discoverLightningClusters();
      },
      rpc,
      hosting: hosting as never,
      frontTable: async () => 'front',
      frozen: () => false,
      logger: quiet(),
      metrics: new LightningMetrics(new MetricsRegistry()),
    });
    sup.start();
    await sup.reconcile();
    const w = sup.workerFor(A)!;
    expect((await w.pass()).outcome).toBe('formed');
    expect([...live]).toEqual([INSTANCE]); // the hand is being dealt

    // The operator switches Lightning off; the tick has not run yet.
    row.lightning_enabled = false;
    await sup.reconcile();
    expect(sup.workerFor(A)).toBe(w);
    expect(w.isRunning).toBe(true);
    expect(w.isDraining).toBe(true);
    expect(hosting.abortCluster).not.toHaveBeenCalled();
    expect([...live]).toEqual([INSTANCE]);
    rpc.mockClear();
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pending_off' });
    expect(rpc).not.toHaveBeenCalled();

    // The tick: pending_off. Still draining, still nothing abandoned.
    row.cluster_mode = 'pending_off';
    await sup.reconcile();
    expect(sup.workerFor(A)).toBe(w);
    expect(w.isDraining).toBe(true);
    expect(hosting.abortCluster).not.toHaveBeenCalled();

    // The hand settles under its host; then the commit sets must_move.
    live.delete(INSTANCE);
    row.cluster_mode = 'must_move';
    rows = [];
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
    expect(w.isRunning).toBe(false);
    expect(voided).toEqual([]); // the dealt hand was never abandoned
    await sup.stop();
  });
});

describe('the close reason says which ending', () => {
  /** A room admitted while its pool session was open, with a socket, then ended. */
  async function socketedRoom(deps: {
    roomOwner: () => Promise<{ playerId: string; clusterId: string } | null>;
    clusterMode: (clusterId: string) => Promise<string | null>;
  }) {
    const closed: Array<[string, string]> = [];
    let open = true;
    const registry = new LightningRegistry({
      viewAccess: async () => open,
      roomOwner: deps.roomOwner,
      clusterMode: deps.clusterMode,
      closeRoom: (room, reason) => closed.push([room, reason]),
    });
    await registry.authorize(ROOM, USER);
    registry.connect(ROOM, USER);
    open = false;
    return { registry, closed };
  }

  it('MUST MOVE: "Lightning Has Ended"', async () => {
    const { registry, closed } = await socketedRoom({
      roomOwner: async () => ({ playerId: USER, clusterId: A }),
      clusterMode: async () => 'must_move',
    });
    expect(await registry.sweepEndedRooms()).toBe(1);
    expect(closed).toEqual([[ROOM, LIGHTNING_HAS_ENDED_REASON]]);
    expect(LIGHTNING_HAS_ENDED_REASON).toBe('Lightning Has Ended');
  });

  it('a player who left a Cluster still in Lightning keeps "Your Lightning Session Has Ended"', async () => {
    const { registry, closed } = await socketedRoom({
      roomOwner: async () => ({ playerId: USER, clusterId: A }),
      clusterMode: async () => 'lightning',
    });
    expect(await registry.sweepEndedRooms()).toBe(1);
    expect(closed).toEqual([[ROOM, LIGHTNING_SESSION_ENDED_REASON]]);
  });

  it('a mode that cannot be read still closes the room, with the ordinary words', async () => {
    const { registry, closed } = await socketedRoom({
      roomOwner: async () => ({ playerId: USER, clusterId: A }),
      clusterMode: async () => {
        throw new Error('down');
      },
    });
    expect(await registry.sweepEndedRooms()).toBe(1);
    expect(closed).toEqual([[ROOM, LIGHTNING_SESSION_ENDED_REASON]]);
  });

  it('a room admitted before its Cluster was known asks the pool session for it', async () => {
    let owner: { playerId: string; clusterId: string } | null = null;
    const modeOf = vi.fn(async () => 'must_move');
    const { registry, closed } = await socketedRoom({
      roomOwner: async () => owner,
      clusterMode: modeOf,
    });
    owner = { playerId: USER, clusterId: B };
    expect(await registry.sweepEndedRooms()).toBe(1);
    expect(modeOf).toHaveBeenCalledWith(B);
    expect(closed).toEqual([[ROOM, LIGHTNING_HAS_ENDED_REASON]]);
  });
});
