/**
 * LIGHTNING PHASE 13 (Spec Phase 22): ROLLOUT, DRAIN, ROLLBACK - THE ENGINE'S HALF.
 *
 *   - the operator's PAUSE: no new hand forms, every hand in the air plays on
 *     and settles, and resume forms again in the mode it was paused from;
 *   - the EMERGENCY DRAIN: no new formation from the next mode read, hands in
 *     flight finish and settle (chips conserved to the cent), the worker
 *     reports its progress and stops itself as soon as the Cluster is MUST
 *     MOVE, and every room is told "ending" (and the drain survives a restart:
 *     the new process forms nothing and stops at MUST MOVE);
 *   - joins disabled: the seated pool plays on (the database holds newcomers);
 *   - matcher versions: a disabled live version falls back to 'm1' exactly as
 *     the DB clamps it, a rollback takes effect on the next pass, and a
 *     disabled shadow version records nothing;
 *   - the fold flags: LIGHTNING FOLD and FOLD & WATCH refused at the action
 *     door with clear codes when switched off, the ordinary fold untouched,
 *     and the room's Lightning block says which controls are offered;
 *   - a database with none of the Phase 13 keys or modes behaves as before.
 *
 * Horses are in every world here and are treated exactly like humans (10.5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 13 world');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 13 world');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String((e as Error)?.message ?? e),
}));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => undefined),
}));

const { FakeLightningWorld } = await import('./__tests__/lightningLoadChaosKit.js');
const { LoadEngine, TableDriver, waitFor, waitMs } =
  await import('./__tests__/lightningLoadEngine.js');
const {
  LIGHTNING_CONFIG_DEFAULTS,
  LIGHTNING_DRAIN_TIMEOUT_DEFAULT_MS,
  LIGHTNING_DRAIN_TIMEOUT_MAX_MS,
  LIGHTNING_DRAIN_TIMEOUT_MIN_MS,
  LIGHTNING_ROLLOUT_DEFAULTS,
  effectiveLightningMatcherVersion,
  parseLightningConfig,
  parseLightningRolloutConfig,
  sameLightningConfig,
} = await import('./LightningConfig.js');
const { LightningClusterWorker, LIGHTNING_WORKER_HOLDS } =
  await import('./LightningClusterWorker.js');
const {
  LightningSupervisor,
  LIGHTNING_DRAIN_RECHECK_MS,
  LIGHTNING_WORKER_CLUSTER_MODES,
  lightningClusterStatusOf,
  parseDiscoveredClusters,
} = await import('./LightningSupervisor.js');
const { LIGHTNING_DISCOVERY_INTERVAL_MS } = await import('./LightningConfig.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { LightningRegistry } = await import('./LightningRegistry.js');
const { LIGHTNING_FOLD_DISABLED_CODE, LIGHTNING_FOLD_WATCH_DISABLED_CODE } =
  await import('./LightningHandHost.js');
import type { LightningConfig } from './LightningConfig.js';
import type { LightningRpcClient } from './LightningRpc.js';
import type { LightningHandHost } from './LightningHandHost.js';

type World = InstanceType<typeof FakeLightningWorld>;
type Engine = InstanceType<typeof LoadEngine>;

const A = '0a0a0a0a-0000-4000-8000-00000000000a';
const B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ROOM = '0c0c0c0c-0000-4000-8000-00000000000c';
const ROOM2 = '0e0e0e0e-0000-4000-8000-00000000000e';
const USER = '0d0d0d0d-0000-4000-8000-00000000000d';
const USER2 = '0f0f0f0f-0000-4000-8000-00000000000f';

const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const cents = (n: number) => Math.round(n * 100);

const form: LightningConfig = {
  ...LIGHTNING_CONFIG_DEFAULTS,
  workerMode: 'form',
  passIntervalMs: 1_000,
};

function formRpc() {
  return vi.fn(async (fn: string) => {
    if (fn === 'fn_lightning_config') return { data: { worker_mode: 'form' }, error: null };
    if (fn === 'fn_lightning_match_and_form') return { data: { ok: true, hands: [] }, error: null };
    throw new Error('unexpected rpc ' + fn);
  }) as unknown as LightningRpcClient & ReturnType<typeof vi.fn>;
}

function worker(config: LightningConfig = form, handsInFlight = () => 0) {
  const rpc = formRpc();
  const logger = quiet();
  let nowMs = 1_000_000;
  const w = new LightningClusterWorker(A, config, {
    rpc,
    presence: new LightningPresence(() => []),
    metrics: new LightningMetrics(new MetricsRegistry()),
    logger,
    now: () => new Date(nowMs),
    startHand: vi.fn(),
    hasInstance: () => false,
    formBackoffUntil: () => 0,
    holdsFrontTableLease: async () => true,
    handsInFlight,
  });
  return { w, rpc, logger, advance: (ms: number) => (nowMs += ms) };
}

const mafCalls = (rpc: ReturnType<typeof formRpc>) =>
  rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_match_and_form').length;

afterEach(() => {
  vi.useRealTimers();
});

// ─── CONFIG ──────────────────────────────────────────────────────────────

describe('the Phase 13 config keys', () => {
  it('absent keys are exactly today: joins open, both folds, nothing disabled, 120 s drain', () => {
    for (const raw of [null, {}, { worker_mode: 'form' }]) {
      expect(parseLightningRolloutConfig(raw)).toEqual(LIGHTNING_ROLLOUT_DEFAULTS);
    }
    expect(LIGHTNING_ROLLOUT_DEFAULTS).toEqual({
      joinsEnabled: true,
      drainTimeoutMs: 120_000,
      matcherVersionPrevious: 'm1',
      matcherVersionsDisabled: [],
      fastFold: true,
      foldWatch: true,
      paused: false,
    });
    expect(parseLightningConfig({ worker_mode: 'form' }).rollout).toEqual(
      LIGHTNING_ROLLOUT_DEFAULTS
    );
  });

  it('only a JSON false closes a door; nonsense is the default, never a refusal', () => {
    expect(parseLightningRolloutConfig({ lightning_joins_enabled: false }).joinsEnabled).toBe(
      false
    );
    for (const v of [true, null, 0, 'yes', {}, []]) {
      expect(parseLightningRolloutConfig({ lightning_joins_enabled: v }).joinsEnabled).toBe(true);
    }
    const flags = parseLightningRolloutConfig({
      lightning_fast_fold: false,
      lightning_fold_watch: false,
    });
    expect([flags.fastFold, flags.foldWatch]).toEqual([false, false]);
    // The operator row reports the flags in a `flags` object: read there too.
    const nested = parseLightningRolloutConfig({
      flags: { lightning_fold_watch: false, lightning_joins_enabled: false },
    });
    expect([nested.fastFold, nested.foldWatch, nested.joinsEnabled]).toEqual([true, false, false]);
  });

  it('drain_timeout_ms is clamped exactly as the DB clamps it (10000 .. 3600000)', () => {
    expect(LIGHTNING_DRAIN_TIMEOUT_DEFAULT_MS).toBe(120_000);
    expect(parseLightningRolloutConfig({ drain_timeout_ms: 5 }).drainTimeoutMs).toBe(
      LIGHTNING_DRAIN_TIMEOUT_MIN_MS
    );
    expect(parseLightningRolloutConfig({ drain_timeout_ms: 10 ** 9 }).drainTimeoutMs).toBe(
      LIGHTNING_DRAIN_TIMEOUT_MAX_MS
    );
    expect(parseLightningRolloutConfig({ drain_timeout_ms: '300000' }).drainTimeoutMs).toBe(
      300_000
    );
    expect(parseLightningRolloutConfig({ drain_timeout_ms: 'soon' }).drainTimeoutMs).toBe(120_000);
  });

  it('matcher_versions_disabled reads a jsonb array or a text[] literal, deduped and sorted', () => {
    expect(
      parseLightningRolloutConfig({ matcher_versions_disabled: ['m2', 'm1-port', 'm2', 7, ''] })
        .matcherVersionsDisabled
    ).toEqual(['m1-port', 'm2']);
    expect(
      parseLightningRolloutConfig({ matcher_versions_disabled: '{m2,"m1-port"}' })
        .matcherVersionsDisabled
    ).toEqual(['m1-port', 'm2']);
    expect(
      parseLightningRolloutConfig({ matcher_version_previous: ' m1-port ' }).matcherVersionPrevious
    ).toBe('m1-port');
  });

  it('a disabled live version falls back to m1; an enabled one stands; none named stays null', () => {
    const disabled = parseLightningRolloutConfig({ matcher_versions_disabled: ['m1-port'] });
    expect(effectiveLightningMatcherVersion('m1-port', disabled)).toBe('m1');
    expect(effectiveLightningMatcherVersion('m1', disabled)).toBe('m1');
    expect(effectiveLightningMatcherVersion(null, disabled)).toBeNull();
    expect(effectiveLightningMatcherVersion('m1-port', undefined)).toBe('m1-port');
    // m1 itself disabled: the engine names nothing and the SQL decides.
    expect(
      effectiveLightningMatcherVersion(
        'm1',
        parseLightningRolloutConfig({ matcher_versions_disabled: ['m1'] })
      )
    ).toBeNull();
    expect(
      parseLightningConfig({ matcher_version: 'm1-port', matcher_versions_disabled: ['m1-port'] })
        .matcherVersion
    ).toBe('m1');
  });

  it('a disabled shadow version records nothing: the shadow matcher is off, integrity is untouched', () => {
    const on = parseLightningConfig({
      lightning_shadow_matcher: true,
      shadow_matcher_version: 'm2',
    });
    expect(on.shadow?.enabled).toBe(true);
    const off = parseLightningConfig({
      lightning_shadow_matcher: true,
      shadow_matcher_version: 'm2',
      integrity_telemetry: true,
      matcher_versions_disabled: ['m2'],
    });
    expect(off.shadow?.enabled).toBe(false);
    expect(off.shadow?.integrityEnabled).toBe(true);
    // A rollout key change is a config change (the supervisor hands it on).
    expect(
      sameLightningConfig(
        on,
        parseLightningConfig({ lightning_shadow_matcher: true, shadow_matcher_version: 'm2' })
      )
    ).toBe(true);
    expect(
      sameLightningConfig(
        parseLightningConfig({ worker_mode: 'form' }),
        parseLightningConfig({ worker_mode: 'form', lightning_fast_fold: false })
      )
    ).toBe(false);
  });
});

// ─── THE WORKER UNDER A HOLD ──────────────────────────────────────────────

describe('a held worker forms nothing and calls nothing', () => {
  it('pause: no call at all; resume forms again from the next pass', async () => {
    const { w, rpc } = worker();
    expect((await w.pass()).outcome).toBe('formed');
    w.setHold('paused');
    expect(w.currentHold).toBe('paused');
    expect(w.isDraining).toBe(true);
    const before = rpc.mock.calls.length;
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'paused' });
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'paused' });
    expect(rpc.mock.calls.length).toBe(before);
    w.setHold(null);
    expect(w.currentHold).toBeNull();
    expect((await w.pass()).outcome).toBe('formed');
    expect(mafCalls(rpc)).toBe(2);
  });

  it("the config's own pause marker holds the worker too, and lifting it forms again", async () => {
    const { w, rpc } = worker(parseLightningConfig({ worker_mode: 'form', paused: true }));
    expect(w.currentHold).toBe('paused');
    expect((await w.pass()).reason).toBe('paused');
    expect(rpc).not.toHaveBeenCalled();
    w.updateConfig(parseLightningConfig({ worker_mode: 'form' }));
    expect(w.currentHold).toBeNull();
    expect((await w.pass()).outcome).toBe('formed');
  });

  it('drain: no call, and every pass reports the hands still in the air here', async () => {
    let inFlight = 3;
    const { w, rpc, logger } = worker(form, () => inFlight);
    w.setHold('draining');
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'draining', handsInFlight: 3 });
    inFlight = 0;
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'draining', handsInFlight: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect(
      logger.log.mock.calls.some((c) => String(c[0]).includes('draining (operator drain)'))
    ).toBe(true);
  });

  it('admission and wake hints never run a pass under any hold', async () => {
    vi.useFakeTimers();
    for (const hold of LIGHTNING_WORKER_HOLDS) {
      const { w, rpc } = worker();
      w.setHold(hold);
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        w.admit();
        w.wake();
      }
      await vi.advanceTimersByTimeAsync(form.passIntervalMs * 2);
      expect(mafCalls(rpc), hold).toBe(0);
      await w.stop();
    }
  });

  it('setDraining(true) is still the pending_off hold, with its own words (Phase 7 unchanged)', async () => {
    const { w } = worker();
    w.setDraining(true);
    expect(w.currentHold).toBe('pending_off');
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pending_off' });
    w.setDraining(false);
    expect(w.currentHold).toBeNull();
  });
});

// ─── THE SUPERVISOR ───────────────────────────────────────────────────────

describe('discovery reads the operator modes', () => {
  it('draining and paused Clusters hold a worker, with their hold named', () => {
    expect([...LIGHTNING_WORKER_CLUSTER_MODES]).toEqual([
      'lightning',
      'pending_off',
      'draining',
      'paused',
    ]);
    expect(
      parseDiscoveredClusters([
        { id: A, cluster_mode: 'draining', lightning_enabled: true },
        { id: B, cluster_mode: 'paused', lightning_enabled: true },
      ])
    ).toEqual([
      { clusterId: A, draining: true, hold: 'draining' },
      { clusterId: B, draining: true, hold: 'paused' },
    ]);
    // Earlier shapes are exactly as before (no hold key).
    expect(parseDiscoveredClusters([{ id: A, cluster_mode: 'pending_off' }])).toEqual([
      { clusterId: A, draining: true },
    ]);
    expect(lightningClusterStatusOf('draining')).toBe('ending');
    expect(lightningClusterStatusOf('pending_off')).toBe('ending');
    expect(lightningClusterStatusOf('switched_off')).toBe('ending');
    expect(lightningClusterStatusOf('paused')).toBe('paused');
    expect(lightningClusterStatusOf(null)).toBeNull();
  });

  it('tells a Cluster its status once per change, and looks again soon while a drain has no hand left', async () => {
    let mode: 'lightning' | 'draining' | 'paused' | 'must_move' = 'lightning';
    let inFlight = 2;
    const told: Array<[string, string | null]> = [];
    const hosting = {
      startHand: vi.fn(),
      hasInstance: vi.fn(() => false),
      formBackoffUntil: vi.fn(() => 0),
      leaseFor: vi.fn(() => ({ instance: 'x', generation: 'y' })),
      handsInFlight: vi.fn(() => inFlight),
      abortCluster: vi.fn(async () => {}),
      abortAll: vi.fn(async () => {}),
    };
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () =>
        mode === 'must_move'
          ? []
          : mode === 'lightning'
            ? [{ clusterId: A, draining: false }]
            : [{ clusterId: A, draining: true, hold: mode }],
      rpc: formRpc(),
      hosting: hosting as never,
      frontTable: async () => 'front',
      frozen: () => false,
      logger: quiet(),
      metrics: new LightningMetrics(new MetricsRegistry()),
      clusterStatus: (id, s) => told.push([id, s]),
    });
    sup.start();
    await sup.reconcile();
    const w = sup.workerFor(A)!;
    expect(told).toEqual([]);
    expect(sup.nextDiscoveryDelayMs()).toBe(LIGHTNING_DISCOVERY_INTERVAL_MS);

    mode = 'paused';
    await sup.reconcile();
    await sup.reconcile();
    expect(sup.workerFor(A)).toBe(w);
    expect(w.currentHold).toBe('paused');
    expect(told).toEqual([[A, 'paused']]);
    // A pause is not on its way out: discovery keeps its ordinary pace.
    inFlight = 0;
    expect(sup.nextDiscoveryDelayMs()).toBe(LIGHTNING_DISCOVERY_INTERVAL_MS);

    mode = 'lightning';
    await sup.reconcile();
    expect(w.currentHold).toBeNull();
    expect(told.at(-1)).toEqual([A, null]);

    inFlight = 2;
    mode = 'draining';
    await sup.reconcile();
    expect(w.currentHold).toBe('draining');
    expect(told.at(-1)).toEqual([A, 'ending']);
    expect(sup.nextDiscoveryDelayMs()).toBe(LIGHTNING_DISCOVERY_INTERVAL_MS);
    inFlight = 0;
    expect(sup.nextDiscoveryDelayMs()).toBe(LIGHTNING_DRAIN_RECHECK_MS);
    // Nothing was abandoned while draining.
    expect(hosting.abortCluster).not.toHaveBeenCalled();

    mode = 'must_move';
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
    expect(w.isRunning).toBe(false);
    expect(told.at(-1)).toEqual([A, null]);
    await sup.stop();
  });

  it('a database without the Phase 13 modes is never asked anything new', async () => {
    const rpc = formRpc();
    const told = vi.fn();
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () => [{ clusterId: A, draining: false }],
      rpc,
      frontTable: async () => 'front',
      frozen: () => false,
      logger: quiet(),
      metrics: new LightningMetrics(new MetricsRegistry()),
      clusterStatus: told,
    });
    sup.start();
    await sup.reconcile();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['fn_lightning_config']);
    expect(told).not.toHaveBeenCalled();
    expect(sup.workerFor(A)!.currentHold).toBeNull();
    await sup.stop();
  });
});

// ─── THE ROOMS ARE TOLD ───────────────────────────────────────────────────

describe('lightning_cluster_status reaches every room of the Cluster, and only its rooms', () => {
  it('sent once per change, re-sent on RESYNC, and carries nothing of any hand', async () => {
    const sent: Array<[string, string, Record<string, unknown>]> = [];
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async (room) =>
        room === ROOM ? { playerId: USER, clusterId: A } : { playerId: USER2, clusterId: B },
      clusterMode: async () => 'lightning',
    });
    registry.setUserEventSink((room, user, payload) => {
      sent.push([room, user, payload]);
      return 1;
    });
    await registry.authorize(ROOM, USER);
    await registry.authorize(ROOM2, USER2);
    registry.connect(ROOM, USER);
    registry.connect(ROOM2, USER2);
    registry.setClusterStatus(A, 'ending');
    registry.setClusterStatus(A, 'ending');
    expect(sent).toEqual([
      [ROOM, USER, { type: 'lightning_cluster_status', cluster_id: A, status: 'ending' }],
    ]);
    registry.rePushHoleCards(ROOM, USER);
    expect(sent).toHaveLength(2);
    registry.rePushHoleCards(ROOM2, USER2); // B is not held: nothing to say
    expect(sent).toHaveLength(2);
    registry.setClusterStatus(A, null);
    expect(sent.at(-1)).toEqual([
      ROOM,
      USER,
      { type: 'lightning_cluster_status', cluster_id: A, status: null },
    ]);
    expect(registry.clusterStatusOf(A)).toBeNull();
    for (const [, , payload] of sent) {
      expect(Object.keys(payload).sort()).toEqual(['cluster_id', 'status', 'type']);
    }
  });
});

// ─── THE WORLD: REAL HOSTS, REAL HANDS, REAL SETTLEMENT ───────────────────

type WorldMode = 'lightning' | 'pending_off' | 'must_move' | 'frozen' | 'draining' | 'paused';

/** The world's discovery, with the Phase 13 modes the fake cash_games row can now hold. */
function withOperatorModes(world: World, extraConfig: () => Record<string, unknown> = () => ({})) {
  const modeOf = (id: string) => world.clusters.get(id)!.mode as WorldMode;
  (world as unknown as { discover: () => unknown }).discover = () =>
    [...world.clusters.values()]
      .filter((c) =>
        (['lightning', 'pending_off', 'draining', 'paused'] as string[]).includes(c.mode)
      )
      .map((c) => {
        const m = modeOf(c.id);
        return m === 'draining' || m === 'paused'
          ? { clusterId: c.id, draining: true, hold: m }
          : { clusterId: c.id, draining: m === 'pending_off' };
      });
  const base = world.rpc;
  const rpc: LightningRpcClient = async (fn, args) => {
    const out = await base(fn, args);
    if (fn === 'fn_lightning_config' && out.data && typeof out.data === 'object')
      return { data: { ...(out.data as Record<string, unknown>), ...extraConfig() }, error: null };
    return out;
  };
  (world as unknown as { rpc: LightningRpcClient }).rpc = rpc;
}

function setMode(world: World, mode: WorldMode) {
  for (const c of world.clusters.values()) (c as { mode: string }).mode = mode;
}

async function startWorld(
  opts: { seed?: number; extraConfig?: () => Record<string, unknown> } = {}
) {
  const world = new FakeLightningWorld({
    clusters: 1,
    playersPerCluster: 24,
    horseEvery: 3,
    passIntervalMs: 200,
    latencyWindowMs: 10_000,
    seed: opts.seed ?? 1313,
  });
  withOperatorModes(world, opts.extraConfig);
  let seed = opts.seed ?? 1313;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const engine = new LoadEngine(world, { rnd, noAckShare: 0 });
  // Capture every private frame and the latest published Lightning block per room.
  const privates: Array<[string, string, Record<string, unknown>]> = [];
  const blocks = new Map<string, Record<string, unknown>>();
  const hub = engine.hub as unknown as {
    sendToUser: (r: string, u: string, p: Record<string, unknown>) => number;
    publish: (r: string, p: Record<string, unknown>) => number;
  };
  const send = hub.sendToUser.bind(hub);
  hub.sendToUser = (r, u, p) => {
    privates.push([r, u, p]);
    return send(r, u, p);
  };
  const publish = hub.publish.bind(hub);
  hub.publish = (r, p) => {
    if (p.lightning && typeof p.lightning === 'object')
      blocks.set(r, p.lightning as Record<string, unknown>);
    return publish(r, p);
  };
  const driver = new TableDriver(engine, { rnd, foldShare: 0.45, thinkMs: () => 2 });
  engine.start();
  for (const p of world.players.values()) if (p.presentVia === 'room') await engine.join(p.id);
  driver.start();
  return { world, engine, driver, privates, blocks, rnd };
}

function assertConserved(world: World, label: string) {
  expect(world.violations, `${label}: contract violations`).toEqual([]);
  expect(world.counters.idempotencyConflicts, `${label}: IDEMPOTENCY_CONFLICT`).toBe(0);
  expect(cents(world.chipsNow() + world.rake + world.bbj), `${label}: chips conserved`).toBe(
    cents(world.initialChips)
  );
  world.reap(() => false);
  expect(world.orphanReservations(), `${label}: orphan reservations`).toEqual([]);
  for (const p of world.players.values()) {
    expect(p.instanceId, `${label}: ${p.id} still reserved`).toBeNull();
    expect(p.exposure.size, `${label}: ${p.id} exposure left`).toBe(0);
  }
}

const maf = (world: World) => world.counters.matchAndForm;
const dealingHosts = (engine: Engine): LightningHandHost[] =>
  engine.hosts().filter((h) => h.lifecycle === 'dealing');

describe('the EMERGENCY DRAIN, through real hosts', () => {
  it('hands in flight finish and settle, nothing new forms, the worker stops at MUST MOVE', async () => {
    const { world, engine, driver, privates } = await startWorld({ seed: 2201 });
    try {
      const clusterId = [...world.clusters.keys()][0];
      expect(await waitFor(() => dealingHosts(engine).length >= 2, 10_000)).toBe(true);
      const abandonedBefore = world.counters.abandoned;
      // (1)(2) The operator's drain: the database is `draining`, and refuses to form.
      setMode(world, 'draining');
      await engine.supervisor.reconcile();
      const worker = engine.supervisor.workerFor(clusterId)!;
      expect(worker.currentHold).toBe('draining');
      const inAir = engine.pendingHosts();
      expect(inAir).toBeGreaterThan(0);
      // A pass already out when the hold landed may still answer; nothing after it.
      await waitMs(100);
      const mafAtHold = maf(world);
      // (3)(4) Every hand in the air plays on to settlement under its own host.
      expect(await waitFor(() => engine.pendingHosts() === 0, 20_000)).toBe(true);
      expect(maf(world)).toBe(mafAtHold);
      expect(world.counters.abandoned).toBe(abandonedBefore);
      for (const inst of world.instances.values())
        expect(['complete', 'abandoned']).toContain(inst.state);
      // The rooms were told the Cluster is ending: the same frame for every room.
      const ending = privates.filter(
        ([, , p]) => p.type === 'lightning_cluster_status' && p.status === 'ending'
      );
      expect(ending.length).toBeGreaterThan(0);
      // The drain's progress: nothing left in the air, so discovery looks again within seconds.
      expect(engine.supervisor.nextDiscoveryDelayMs()).toBe(LIGHTNING_DRAIN_RECHECK_MS);
      // (5)(6) The database closes the pool sessions and rebuilds MUST MOVE.
      setMode(world, 'must_move');
      expect(
        await waitFor(
          () => engine.supervisor.activeClusters().length === 0,
          LIGHTNING_DRAIN_RECHECK_MS + 3_000
        )
      ).toBe(true);
      expect(worker.isRunning).toBe(false);
      // (7) Every stack preserved to the cent; no reservation left behind.
      assertConserved(world, 'drain');
    } finally {
      driver.stop();
      await engine.stop();
    }
  }, 40_000);

  it('a restart mid-drain: the new process forms nothing, its rooms are told, and it stops at MUST MOVE', async () => {
    const first = await startWorld({ seed: 2202 });
    const { world } = first;
    const clusterId = [...world.clusters.keys()][0];
    expect(await waitFor(() => dealingHosts(first.engine).length >= 1, 10_000)).toBe(true);
    setMode(world, 'draining');
    await first.engine.supervisor.reconcile();
    // The process goes down mid-drain (its unsettled hands are voided, nothing moved).
    first.driver.stop();
    await first.engine.stop();
    world.lease = { instance: 'load-engine-2', generation: '00004242-0000-4000-8000-000000000002' };
    const mafBefore = maf(world);
    const next = new LoadEngine(world, { noAckShare: 0 });
    const told: Array<Record<string, unknown>> = [];
    next.registry.setUserEventSink((_room, _user, payload) => {
      told.push(payload);
      return 1;
    });
    try {
      next.start();
      expect(await waitFor(() => next.supervisor.activeClusters().includes(clusterId), 5_000)).toBe(
        true
      );
      expect(next.supervisor.workerFor(clusterId)!.currentHold).toBe('draining');
      // A player's room comes back: it is told the Cluster is ending on its RESYNC.
      const human = [...world.players.values()].find((p) => p.presentVia === 'room')!;
      setMode(world, 'draining');
      await next.join(human.id);
      next.registry.rePushHoleCards(human.poolSessionId, human.id);
      expect(told.some((p) => p.type === 'lightning_cluster_status' && p.status === 'ending')).toBe(
        true
      );
      await waitMs(600);
      expect(maf(world)).toBe(mafBefore);
      expect(next.pendingHosts()).toBe(0);
      // The database's drive finishes: the reaper voids what the old process left, MUST MOVE.
      world.reap(() => false);
      setMode(world, 'must_move');
      expect(
        await waitFor(
          () => next.supervisor.activeClusters().length === 0,
          LIGHTNING_DRAIN_RECHECK_MS + 3_000
        )
      ).toBe(true);
      assertConserved(world, 'restart mid-drain');
    } finally {
      await next.stop();
    }
  }, 40_000);
});

describe('PAUSE and RESUME, through real hosts', () => {
  it('pause holds formation while hands settle; resume forms again in lightning', async () => {
    const { world, engine, driver, privates } = await startWorld({ seed: 2203 });
    try {
      const clusterId = [...world.clusters.keys()][0];
      expect(await waitFor(() => dealingHosts(engine).length >= 1, 10_000)).toBe(true);
      setMode(world, 'paused');
      await engine.supervisor.reconcile();
      expect(engine.supervisor.workerFor(clusterId)!.currentHold).toBe('paused');
      await waitMs(100);
      const mafAtPause = maf(world);
      expect(await waitFor(() => engine.pendingHosts() === 0, 20_000)).toBe(true);
      await waitMs(500);
      expect(maf(world)).toBe(mafAtPause);
      expect(
        privates.some(([, , p]) => p.type === 'lightning_cluster_status' && p.status === 'paused')
      ).toBe(true);
      // A pause is not an ending: the worker keeps its Cluster.
      expect(engine.supervisor.activeClusters()).toEqual([clusterId]);
      const settledAtResume = world.settledHands;
      // RESUME: back to exactly the mode it was paused from.
      setMode(world, 'lightning');
      await engine.supervisor.reconcile();
      expect(engine.supervisor.workerFor(clusterId)!.currentHold).toBeNull();
      expect(await waitFor(() => world.settledHands > settledAtResume, 15_000)).toBe(true);
      expect(maf(world)).toBeGreaterThan(mafAtPause);
      setMode(world, 'pending_off');
      await engine.supervisor.reconcile();
      expect(await waitFor(() => engine.pendingHosts() === 0, 20_000)).toBe(true);
      assertConserved(world, 'pause/resume');
    } finally {
      driver.stop();
      await engine.stop();
    }
  }, 60_000);
});

describe('joins disabled', () => {
  it('the seated pool plays on (the database holds newcomers; the engine reads the key)', async () => {
    const { world, engine, driver } = await startWorld({
      seed: 2204,
      extraConfig: () => ({ lightning_joins_enabled: false }),
    });
    try {
      const clusterId = [...world.clusters.keys()][0];
      expect(await waitFor(() => world.settledHands >= 3, 15_000)).toBe(true);
      const w = engine.supervisor.workerFor(clusterId)!;
      expect(w.currentConfig.rollout?.joinsEnabled).toBe(false);
      expect(w.currentHold).toBeNull();
      setMode(world, 'pending_off');
      await engine.supervisor.reconcile();
      expect(await waitFor(() => engine.pendingHosts() === 0, 20_000)).toBe(true);
      assertConserved(world, 'joins disabled');
    } finally {
      driver.stop();
      await engine.stop();
    }
  }, 40_000);
});

describe('the fold flags at the action door', () => {
  it('LIGHTNING FOLD and FOLD & WATCH are refused with clear codes; the ordinary fold stands', async () => {
    const flags = { lightning_fast_fold: false, lightning_fold_watch: false };
    const { world, engine, driver, blocks } = await startWorld({
      seed: 2205,
      extraConfig: () => ({ ...flags }),
    });
    driver.stop(); // the test acts by hand
    try {
      expect(await waitFor(() => dealingHosts(engine).length >= 1, 10_000)).toBe(true);
      let host: LightningHandHost | undefined;
      let facing: string | undefined;
      expect(
        await waitFor(() => {
          for (const h of dealingHosts(engine)) {
            const st = h.peekState();
            if (!st || st.stage !== 'preflop') continue;
            const cur = st.players.find((p) => p.seat === st.currentPlayerSeat);
            if (cur && st.currentBet - cur.bet > 0) {
              host = h;
              facing = cur.user_id;
              return true;
            }
          }
          return false;
        }, 5_000)
      ).toBe(true);
      const fast = host!.handlePlayerAction(facing!, 'fast_fold');
      expect(fast).toMatchObject({ success: false, code: LIGHTNING_FOLD_DISABLED_CODE });
      expect(fast.error).toBe('Lightning Fold Is Not Available Right Now');
      const watch = host!.handlePlayerAction(facing!, 'fold_watch');
      expect(watch).toMatchObject({ success: false, code: LIGHTNING_FOLD_WATCH_DISABLED_CODE });
      expect(watch.error).not.toMatch(/—/);
      // The room's Lightning block says which controls the Cluster offers, for every seat.
      for (const id of host!.participantIds()) {
        const block = blocks.get(world.players.get(id)!.poolSessionId);
        expect(block, id).toMatchObject({ fast_fold_enabled: false, fold_watch_enabled: false });
      }
      // Nothing was marked or moved: the player still owes the decision, and folds normally.
      expect(host!.peekState()!.players.find((p) => p.user_id === facing)!.is_folded).toBe(false);
      expect(host!.handlePlayerAction(facing!, 'fold').success).toBe(true);
      driver.start();
      setMode(world, 'pending_off');
      await engine.supervisor.reconcile();
      expect(await waitFor(() => engine.pendingHosts() === 0, 20_000)).toBe(true);
      assertConserved(world, 'fold flags');
    } finally {
      driver.stop();
      await engine.stop();
    }
  }, 40_000);
});

describe('matcher versions: disable, roll back, and the shadow', () => {
  function shadowWorker(raw: Record<string, unknown>) {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, ...args });
      if (fn === 'fn_lightning_match')
        return {
          data: {
            matcher_version: args.p_matcher_version,
            groups: [],
            diagnosis: [],
            legal_count: 0,
            pool_diversity_score: null,
          },
          error: null,
        };
      if (fn === 'fn_lightning_shadow_record' || fn === 'fn_lightning_integrity_report')
        return { data: { ok: true }, error: null };
      if (fn === 'fn_lightning_latency_report') return { data: { ok: true }, error: null };
      throw new Error('unexpected ' + fn);
    }) as unknown as LightningRpcClient;
    const w = new LightningClusterWorker(
      A,
      parseLightningConfig({ worker_mode: 'shadow', ...raw }),
      {
        rpc,
        presence: new LightningPresence(() => []),
        metrics: new LightningMetrics(new MetricsRegistry()),
        logger: quiet(),
      }
    );
    return { w, calls };
  }

  it('a disabled live version is never asked for: the pass names m1', async () => {
    const { w, calls } = shadowWorker({
      matcher_version: 'm1-port',
      matcher_versions_disabled: ['m1-port'],
    });
    await w.pass();
    expect(calls.find((c) => c.fn === 'fn_lightning_match')?.p_matcher_version).toBe('m1');
  });

  it('a rollback (matcher_version back to its previous) takes effect on the next pass', async () => {
    const { w, calls } = shadowWorker({ matcher_version: 'm1-port' });
    await w.pass();
    w.updateConfig(
      parseLightningConfig({
        worker_mode: 'shadow',
        matcher_version: 'm1',
        matcher_version_previous: 'm1-port',
      })
    );
    await w.pass();
    const asked = calls
      .filter((c) => c.fn === 'fn_lightning_match')
      .map((c) => c.p_matcher_version);
    expect(asked).toEqual(['m1-port', 'm1']);
    expect(w.currentConfig.rollout?.matcherVersionPrevious).toBe('m1-port');
  });

  it('shadow suppression: a disabled shadow version leaves the runner inactive', () => {
    const on = shadowWorker({ lightning_shadow_matcher: true, shadow_matcher_version: 'm2' });
    expect(on.w.shadowRunner.active).toBe(true);
    const off = shadowWorker({
      lightning_shadow_matcher: true,
      shadow_matcher_version: 'm2',
      matcher_versions_disabled: ['m2'],
    });
    expect(off.w.shadowRunner.active).toBe(false);
    // Re-enabled by the operator: the next config read turns it back on.
    off.w.updateConfig(
      parseLightningConfig({
        worker_mode: 'shadow',
        lightning_shadow_matcher: true,
        shadow_matcher_version: 'm2',
      })
    );
    expect(off.w.shadowRunner.active).toBe(true);
  });
});

describe('the laws', () => {
  it('no Phase 13 engine body reads or branches on horse identity (Law 10.5)', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const f of ['LightningConfig.ts', 'LightningSupervisor.ts', 'LightningClusterWorker.ts']) {
      const src = strip(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
      expect(src, f).not.toMatch(/is_?horse|horse_?id|isHorse/i);
    }
    const registry = strip(
      readFileSync(new URL('./LightningRegistry.ts', import.meta.url), 'utf8')
    );
    const statusBody = registry.slice(
      registry.indexOf('setClusterStatus('),
      registry.indexOf('private rePushClusterStatus')
    );
    expect(statusBody.length).toBeGreaterThan(0);
    expect(statusBody).not.toMatch(/horse/i);
  });

  it('the refusal words are Title Case with no em dash', () => {
    for (const s of [
      'Lightning Fold Is Not Available Right Now',
      'Fold & Watch Is Not Available Right Now',
    ]) {
      expect(s).not.toMatch(/—/);
      for (const w of s.split(' ')) if (/^[a-z]/.test(w)) throw new Error(`${s}: ${w}`);
    }
  });
});
