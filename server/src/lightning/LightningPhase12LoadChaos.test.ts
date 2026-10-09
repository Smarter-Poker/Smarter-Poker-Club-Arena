/**
 * LIGHTNING PHASE 12 (engine): LOAD / STRESS / CHAOS, SURGE PROTECTION and
 * the ACTION LATENCY LEDGER (spec Phase 20; ACTION LATENCY TELEMETRY).
 *
 * The real engine stack - LightningSupervisor, LightningClusterWorker,
 * LightningHosting, LightningHandHost, LightningRegistry, the latency ledger
 * and the formation gate - runs against an in-memory world that models the
 * database CONTRACT (reservations, request-id idempotency, settlement
 * receipts, the per-Cluster pass lock, the formation reaper). Every scenario
 * ends by asserting the spec's required outcome:
 *
 *   NO duplicate money, NO lost money (chips + rake conserved to the cent),
 *   NO duplicate player (never in two instances), NO duplicate hand (an
 *   instance is dealt at most once), NO ambiguous settlement (one receipt
 *   per hand, never IDEMPOTENCY_CONFLICT, never a second request id), NO
 *   orphan reservation (none left by the engine; a crash leaves only what the
 *   reaper voids), no overlapping formation for a Cluster, no crash loop,
 *   recovery within bounded passes, and bounded maps after every storm.
 *
 * Populations 10, 50, 100, 500 and 1,000 run in CI; 5,000 and 10,000 run with
 * LIGHTNING_LOAD_FULL=1. The scoreboard (P50/P95/P99 of the pass time and of
 * every latency leg, measured in this in-memory world) is printed.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): every population seats horses with the
 * humans; a horse's seat has no room socket, so it simply yields no render
 * sample - nothing branches on what it is.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 12 load world');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 12 load world');
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

const { mulberry32 } = await import('../engine/HandFuzzer.js');
const { FakeLightningWorld, quantiles } = await import('../testing/lightningLoadChaosKit.js');
const { LoadEngine, TableDriver, instrumentWorkerPasses, waitFor, waitMs } =
  await import('../testing/lightningLoadEngine.js');
const {
  LightningLatencyLedger,
  LIGHTNING_LATENCY_LEG_KEYS,
  LIGHTNING_LATENCY_RPC_RETRY_MS,
  LIGHTNING_LATENCY_MAX_QUEUED,
} = await import('./LightningLatencyLedger.js');
const { LightningTelemetry } = await import('./LightningTelemetry.js');
const { LightningMetrics, LIGHTNING_LATENCY_SEGMENTS } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { LightningRegistry, LIGHTNING_RENDER_ACK_TTL_MS } = await import('./LightningRegistry.js');
const { LightningFormationGate } = await import('./LightningFormationGate.js');
const { parseLightningConfig, parseLightningLatencyConfig } = await import('./LightningConfig.js');

type World = InstanceType<typeof FakeLightningWorld>;
type Engine = InstanceType<typeof LoadEngine>;

const FULL = process.env.LIGHTNING_LOAD_FULL === '1';
const cents = (n: number) => Math.round(n * 100);

// ─── THE SCOREBOARD ────────────────────────────────────────────────────────

interface ScoreRow {
  scenario: string;
  players: number;
  clusters: number;
  hands: number;
  abandoned: number;
  passes: number;
  passMs: ReturnType<typeof quantiles>;
  legs: Record<string, ReturnType<typeof quantiles>>;
  joinToHand?: ReturnType<typeof quantiles>;
  wallMs: number;
}
const scoreboard: ScoreRow[] = [];

afterAll(() => {
  const fmt = (q?: ReturnType<typeof quantiles>) =>
    q && q.n > 0 ? `${q.p50}/${q.p95}/${q.p99} (n=${q.n})` : 'n/a';
  const lines = ['', 'LIGHTNING PHASE 12 LOAD SCOREBOARD (in-memory world; ms, P50/P95/P99)'];
  for (const r of scoreboard) {
    lines.push(
      `${r.scenario} | players ${r.players} | clusters ${r.clusters} | hands ${r.hands} | abandoned ${r.abandoned} | passes ${r.passes} | wall ${r.wallMs} ms`
    );
    lines.push(`  pass time            ${fmt(r.passMs)}`);
    for (const leg of Object.values(LIGHTNING_LATENCY_LEG_KEYS))
      lines.push(`  ${leg.padEnd(24)} ${fmt(r.legs[leg])}`);
    if (r.joinToHand) lines.push(`  join_to_first_hand   ${fmt(r.joinToHand)}`);
  }
  console.log(lines.join('\n'));
});

// ─── THE RUNNER ────────────────────────────────────────────────────────────

interface RunSpec {
  name: string;
  players: number;
  clusters: number;
  horseEvery?: number;
  hands: number;
  capMs: number;
  seed: number;
  joinSpreadMs?: number;
  rpcLatencyMs?: (rnd: () => number) => number;
  formTimeoutMs?: number;
  noAckShare?: number;
  driver?: Partial<ConstructorParameters<typeof TableDriver>[1]>;
  maxHands?: number;
  /** Chaos injected while the run is live. */
  chaos?: (ctx: RunCtx) => Promise<void>;
  /** The reaper may be needed (a crash leaves instances nobody hosts). */
  allowReap?: boolean;
  /** Record the run on the scoreboard. */
  score?: boolean;
}

interface RunCtx {
  world: World;
  engine: Engine;
  driver: InstanceType<typeof TableDriver>;
  rnd: () => number;
  passes: ReturnType<typeof instrumentWorkerPasses>;
  /** Replace the engine (server restart). */
  setEngine(e: Engine, d: InstanceType<typeof TableDriver>): void;
}

let instrumented: ReturnType<typeof instrumentWorkerPasses> | null = null;
afterEach(() => {
  instrumented?.restore();
  instrumented = null;
});

/** The players whose client opens a room socket (a horse is present through its anchor engine). */
const humansOf = (world: World) =>
  [...world.players.values()].filter((p) => p.presentVia === 'room');

async function joinAll(engine: Engine, ids: string[], spreadMs: number, rnd: () => number) {
  if (spreadMs <= 0) {
    await Promise.all(ids.map((id) => engine.join(id)));
    return;
  }
  await Promise.all(
    ids.map(async (id) => {
      await waitMs(Math.floor(rnd() * spreadMs));
      await engine.join(id);
    })
  );
}

async function run(spec: RunSpec) {
  const t0 = Date.now();
  const rnd = mulberry32(spec.seed);
  const world = new FakeLightningWorld({
    clusters: spec.clusters,
    playersPerCluster: Math.ceil(spec.players / spec.clusters),
    horseEvery: spec.horseEvery ?? 10,
    rpcLatencyMs: spec.rpcLatencyMs ? () => spec.rpcLatencyMs!(rnd) : () => (rnd() < 0.5 ? 0 : 1),
    passIntervalMs: 500,
    latencyWindowMs: 10_000,
    maxHands: spec.maxHands,
  });
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const passes = instrumentWorkerPasses();
  instrumented = passes;
  let engine = new LoadEngine(world, {
    rnd,
    formTimeoutMs: spec.formTimeoutMs,
    noAckShare: spec.noAckShare ?? 0.1,
  });
  const driverOpts = {
    rnd,
    foldShare: 0.5,
    fastShare: 0.55,
    watchShare: 0.15,
    earlyFoldShare: 0.01,
    thinkMs: () => Math.floor(rnd() * 6),
    ...(spec.driver ?? {}),
  };
  let driver = new TableDriver(engine, driverOpts);
  const engines: Engine[] = [engine];
  engine.start();
  await joinAll(
    engine,
    humansOf(world).map((p) => p.id),
    spec.joinSpreadMs ?? 200,
    rnd
  );
  driver.start();
  const ctx: RunCtx = {
    world,
    engine,
    driver,
    rnd,
    passes,
    setEngine(e, d) {
      engine = e;
      driver = d;
      ctx.engine = e;
      ctx.driver = d;
      engines.push(e);
    },
  };
  const chaos = spec.chaos ? spec.chaos(ctx) : Promise.resolve();
  await Promise.all([chaos, waitFor(() => world.settledHands >= spec.hands, spec.capMs, 20)]);
  // DRAIN: the database stops forming (pending_off); every hand in the air finishes.
  for (const c of world.clusters.values()) if (c.mode === 'lightning') c.mode = 'pending_off';
  const drained = await waitFor(() => engine.pendingHosts() === 0, 20_000, 20);
  driver.stop();
  // The last render acknowledgements land (a client paints within tens of ms).
  await waitMs(60);
  await engine.stop();
  const wallMs = Date.now() - t0;
  return { world, engine, engines, passes, drained, wallMs, timersBefore, rnd };
}

function assertRequiredOutcome(
  r: Awaited<ReturnType<typeof run>>,
  opts: { allowReap?: boolean; label: string }
) {
  const { world, engine, engines } = r;
  const label = opts.label;
  expect(r.drained, `${label}: every host finished`).toBe(true);
  expect(world.violations, `${label}: contract violations`).toEqual([]);
  // NO AMBIGUOUS SETTLEMENT.
  expect(world.counters.idempotencyConflicts, `${label}: IDEMPOTENCY_CONFLICT`).toBe(0);
  expect(world.counters.latencyConflicts, `${label}: latency IDEMPOTENCY_CONFLICT`).toBe(0);
  // ONE FORMATION IN FLIGHT PER CLUSTER: the DB's pass lock never had to refuse the engine.
  expect(world.counters.passInProgress, `${label}: overlapping match_and_form`).toBe(0);
  for (const e of engines) expect(e.gate.overlaps, `${label}: gate overlaps`).toBe(0);
  expect(world.counters.maxHandsInOnePass).toBeLessThanOrEqual(32);
  // NO ORPHAN RESERVATION left by the engine (a crash may leave some to the reaper).
  const open = world.openInstances().length;
  if (!opts.allowReap) expect(open, `${label}: instances left open by the engine`).toBe(0);
  world.reap(() => false);
  expect(world.openInstances(), `${label}: open after the reaper`).toEqual([]);
  expect(world.orphanReservations(), `${label}: orphan reservations`).toEqual([]);
  for (const p of world.players.values()) {
    expect(p.instanceId, `${label}: ${p.id} still reserved`).toBeNull();
    expect(p.exposure.size, `${label}: ${p.id} exposure left`).toBe(0);
  }
  // NO DUPLICATE / LOST MONEY: chips + rake + jackpot drop, to the cent.
  expect(cents(world.chipsNow() + world.rake + world.bbj), `${label}: chips conserved`).toBe(
    cents(world.initialChips)
  );
  // Every instance either settled exactly once or was abandoned.
  let complete = 0;
  for (const inst of world.instances.values()) {
    expect(['complete', 'abandoned']).toContain(inst.state);
    if (inst.state === 'complete') complete++;
  }
  expect(world.settledHands).toBe(complete);
  // HIDDEN INFORMATION: private frames reach only their owner; no public frame carries hole cards.
  for (const e of engines) {
    expect(e.hub.misdirected, `${label}: misdirected private frames`).toBe(0);
    expect(e.hub.leaked, `${label}: hole cards in a public frame`).toBe(0);
  }
  // BOUNDED: nothing of a stopped engine is still held.
  const sizes = engine.registry.sizes;
  expect(sizes.hosts).toBe(0);
  expect(sizes.hostByRoom).toBe(0);
  expect(sizes.decisions).toBe(0);
  expect(sizes.rooms).toBeLessThanOrEqual(world.players.size);
  expect(engine.registry.pendingRenderAcks).toBeLessThanOrEqual(world.players.size);
  expect(engine.pendingHosts()).toBe(0);
  expect(engine.gate.size).toBeLessThanOrEqual(world.clusters.size);
  const idle = (engine.metrics as unknown as { idle: Map<string, unknown> }).idle;
  expect(idle.size).toBeLessThanOrEqual(world.players.size);
  expect(engine.supervisor.activeClusters()).toEqual([]);
}

function legsOf(engine: Engine): Record<string, ReturnType<typeof quantiles>> {
  const out: Record<string, ReturnType<typeof quantiles>> = {};
  for (const seg of LIGHTNING_LATENCY_SEGMENTS)
    out[LIGHTNING_LATENCY_LEG_KEYS[seg]] = quantiles(engine.samples.get(seg) ?? []);
  return out;
}

function record(name: string, r: Awaited<ReturnType<typeof run>>, joinToHand?: number[]) {
  const legs: Record<string, ReturnType<typeof quantiles>> = {};
  for (const e of r.engines) {
    for (const [k, q] of Object.entries(legsOf(e))) if (!legs[k] || q.n > legs[k].n) legs[k] = q;
  }
  scoreboard.push({
    scenario: name,
    players: r.world.players.size,
    clusters: r.world.clusters.size,
    hands: r.world.settledHands,
    abandoned: r.world.counters.abandoned,
    passes: r.passes.durations.length,
    passMs: quantiles(r.passes.durations),
    legs,
    joinToHand: joinToHand ? quantiles(joinToHand) : undefined,
    wallMs: r.wallMs,
  });
}

/** The ledger reported every sample the engine measured, leg by leg (no faults on the report). */
function assertLedgerMatchesSamples(r: Awaited<ReturnType<typeof run>>) {
  const reported = new Map<string, number>();
  for (const rep of r.world.latencyReports) {
    const legs = rep.p_legs as Record<string, { n: number; p50: number; p95: number; p99: number }>;
    for (const [k, v] of Object.entries(legs)) {
      expect(Object.values(LIGHTNING_LATENCY_LEG_KEYS)).toContain(k);
      expect(v.p50).toBeLessThanOrEqual(v.p95);
      expect(v.p95).toBeLessThanOrEqual(v.p99);
      reported.set(k, (reported.get(k) ?? 0) + v.n);
    }
    expect(JSON.stringify(rep)).not.toMatch(/card|hole|deck|seed/i);
  }
  for (const seg of LIGHTNING_LATENCY_SEGMENTS) {
    const n = r.engine.samples.get(seg)?.length ?? 0;
    expect(reported.get(LIGHTNING_LATENCY_LEG_KEYS[seg]) ?? 0, `ledger leg ${seg}`).toBe(n);
  }
}

// ─── 1. THE LOAD LADDER ────────────────────────────────────────────────────

const LADDER: Array<{ players: number; clusters: number; hands: number; capMs: number }> = [
  { players: 10, clusters: 1, hands: 30, capMs: 15_000 },
  { players: 50, clusters: 1, hands: 80, capMs: 15_000 },
  { players: 100, clusters: 2, hands: 120, capMs: 15_000 },
  { players: 500, clusters: 3, hands: 250, capMs: 20_000 },
  { players: 1_000, clusters: 3, hands: 350, capMs: 25_000 },
  ...(FULL
    ? [
        { players: 5_000, clusters: 8, hands: 1_200, capMs: 120_000 },
        { players: 10_000, clusters: 12, hands: 2_000, capMs: 240_000 },
      ]
    : []),
];

describe('load: 10, 50, 100, 500, 1,000 players (5,000 and 10,000 with LIGHTNING_LOAD_FULL=1)', () => {
  for (const row of LADDER) {
    it(
      `${row.players} players over ${row.clusters} Cluster(s): every invariant holds and the ledger reports every leg`,
      async () => {
        const r = await run({
          name: `load-${row.players}`,
          players: row.players,
          clusters: row.clusters,
          hands: row.hands,
          capMs: row.capMs,
          seed: row.players,
        });
        assertRequiredOutcome(r, { label: `load ${row.players}` });
        expect(r.world.settledHands).toBeGreaterThanOrEqual(Math.min(row.hands, 10));
        // Every leg the spec names was measured, the render leg included.
        for (const seg of LIGHTNING_LATENCY_SEGMENTS) {
          if (seg === 'fold_watch_to_next_hand' && row.players < 50) continue;
          expect(r.engine.samples.get(seg)?.length ?? 0, `leg ${seg}`).toBeGreaterThan(0);
        }
        assertLedgerMatchesSamples(r);
        // A worker restart never reports a window_from twice (checked by the world).
        expect(r.world.counters.latencyReports).toBeGreaterThan(0);
        // No crash loop: one worker per Cluster for the whole run.
        expect(r.passes.starts()).toBe(row.clusters);
        record(`load-${row.players}`, r);
      },
      row.capMs + 60_000
    );
  }
});

// ─── 2. SURGE PROTECTION ───────────────────────────────────────────────────

describe('surge protection: 20 join within 1 s, 100 during a promotion, 500 during an event', () => {
  for (const surge of [
    { players: 20, spreadMs: 1_000 },
    { players: 100, spreadMs: 1_500 },
    { players: 500, spreadMs: 2_000 },
  ]) {
    it(`${surge.players} arrivals in ${surge.spreadMs} ms: micro-batched, never overlapping, at most 32 hands a pass, everyone dealt in fast`, async () => {
      const r = await run({
        name: `surge-${surge.players}`,
        players: surge.players,
        clusters: 1,
        horseEvery: 0,
        hands: Math.ceil(surge.players / 2),
        capMs: 15_000,
        seed: 4000 + surge.players,
        joinSpreadMs: surge.spreadMs,
        rpcLatencyMs: (rnd) => 1 + Math.floor(rnd() * 3),
      });
      assertRequiredOutcome(r, { label: `surge ${surge.players}` });
      const joinToHand: number[] = [];
      for (const [id, at] of r.engine.joinedAt) {
        const first = r.engine.firstHandAt.get(id);
        if (first !== undefined && first >= at) joinToHand.push(first - at);
      }
      // Everyone who joined was dealt in.
      expect(joinToHand.length).toBe(r.engine.joinedAt.size);
      const q = quantiles(joinToHand);
      // JOIN -> HAND: inside the admission window plus a few round trips,
      // never a pass interval of waiting per arrival.
      expect(q.p95).toBeLessThan(1_500);
      record(`surge-${surge.players}`, r, joinToHand);
    }, 60_000);
  }

  it('admission micro-batching: a burst of arrivals shares one pass inside the window, never a pass each', async () => {
    vi.useFakeTimers();
    try {
      const { LightningClusterWorker, LIGHTNING_ADMISSION_COALESCE_MS } =
        await import('./LightningClusterWorker.js');
      const { LightningPresence } = await import('./LightningPresence.js');
      const { LIGHTNING_AUTO_REBUY_DEFAULTS } = await import('./LightningConfig.js');
      const C = '00001000-0000-4000-8000-000000000001';
      let maf = 0;
      const rpc = vi.fn(async (fn: string) => {
        if (fn === 'fn_lightning_match_and_form') maf++;
        return {
          data: { ok: true, formed: 0, hands: [], stopped_reason: 'plan_exhausted' },
          error: null,
        };
      });
      const worker = new LightningClusterWorker(
        C,
        {
          matcherVersion: 'm1',
          workerMode: 'form',
          passIntervalMs: 60_000,
          keepaliveIntervalMs: 600_000,
          maxHandsPerPass: 32,
          dealWindowMs: 600_000,
          autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
        },
        {
          rpc,
          presence: new LightningPresence(() => []),
          metrics: new LightningMetrics(new MetricsRegistry(), null),
          logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
          startHand: () => undefined,
          hasInstance: () => false,
          formationGate: new LightningFormationGate(),
        }
      );
      worker.start();
      await vi.advanceTimersByTimeAsync(5);
      expect(maf).toBe(1); // the first pass; the next is a minute away
      for (let i = 0; i < 20; i++) {
        worker.admit();
        await vi.advanceTimersByTimeAsync(10);
      }
      // Twenty arrivals in 200 ms: one pass, inside the admission window.
      await vi.advanceTimersByTimeAsync(LIGHTNING_ADMISSION_COALESCE_MS);
      expect(maf).toBe(2);
      // Quiet again: nothing until the interval.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(maf).toBe(2);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a saturated batch (max_hands) is followed at once by the next pass, a bounded number of times', async () => {
    const r = await run({
      name: 'surge-saturated',
      players: 300,
      clusters: 1,
      horseEvery: 0,
      hands: 100,
      capMs: 15_000,
      seed: 4999,
      joinSpreadMs: 0,
      maxHands: 8,
    });
    assertRequiredOutcome(r, { label: 'surge saturated' });
    expect(r.world.counters.maxHandsInOnePass).toBe(8);
    // 300 players at 8 hands of 6 a pass is several passes: back to back, not a pass interval apart.
    const formed = r.passes.outcomes.filter((o) => (o.formed ?? 0) > 0);
    expect(formed.length).toBeGreaterThanOrEqual(5);
    const firstFive = formed.slice(0, 5);
    expect(firstFive[4].at - firstFive[0].at).toBeLessThan(4 * 500);
  }, 60_000);
});

// ─── 3. CHAOS ──────────────────────────────────────────────────────────────

describe('chaos: every fault the spec names, the required outcome every time', () => {
  it('matcher worker crash and restart, mid-call: no overlap, nothing formed twice, no orphan, bounded restarts', async () => {
    let crashes = 0;
    let crashEndedAt = 0;
    const r = await run({
      name: 'chaos-worker-crash',
      players: 100,
      clusters: 2,
      hands: 120,
      capMs: 15_000,
      seed: 5001,
      rpcLatencyMs: (rnd) => Math.floor(rnd() * 15),
      chaos: async (ctx) => {
        for (let i = 0; i < 12; i++) {
          await waitMs(120);
          for (const c of ctx.world.clusters.keys()) {
            const workers = (
              ctx.engine.supervisor as unknown as {
                workers: Map<string, { stop(): Promise<void> }>;
              }
            ).workers;
            const w = workers.get(c);
            if (!w) continue;
            workers.delete(c); // the worker object is gone, mid-pass or not
            void w.stop();
            crashes++;
          }
          await ctx.engine.supervisor.reconcile();
        }
        crashEndedAt = Date.now();
        // Play on after the last crash (the recovery is measured on these passes).
        await waitFor(
          () => ctx.passes.outcomes.some((o) => o.at >= crashEndedAt && (o.formed ?? 0) > 0),
          3_000
        );
      },
    });
    assertRequiredOutcome(r, { label: 'worker crash' });
    expect(crashes).toBeGreaterThan(10);
    // No crash loop: one restart per crash, no more.
    expect(r.passes.starts()).toBeLessThanOrEqual(crashes + r.world.clusters.size);
    // Recovered: hands formed again soon after the last crash.
    const after = r.passes.outcomes.filter((o) => o.at >= crashEndedAt);
    const firstFormed = after.findIndex((o) => o.outcome === 'formed' && (o.formed ?? 0) > 0);
    expect(firstFormed).toBeGreaterThanOrEqual(0);
    expect(firstFormed).toBeLessThan(10);
    record('chaos-worker-crash', r);
  }, 60_000);

  it('hand host crash mid-hand: each such hand is voided by the reaper, never settled twice, players freed', async () => {
    const dead = new Set<string>();
    const r = await run({
      name: 'chaos-host-crash',
      players: 100,
      clusters: 1,
      hands: 100,
      capMs: 15_000,
      seed: 5002,
      allowReap: true,
      chaos: async (ctx) => {
        // A dead host's process is gone: none of its calls land any more.
        ctx.world.faults = (fn, c) =>
          c.instanceId && dead.has(c.instanceId) && fn !== 'fn_lightning_match_and_form'
            ? { kind: 'transport_before' }
            : null;
        for (let i = 0; i < 10; i++) {
          await waitMs(150);
          const dealing = ctx.engine.hosts().filter((h) => h.lifecycle === 'dealing');
          const victim = dealing[Math.floor(ctx.rnd() * dealing.length)];
          if (!victim) continue;
          dead.add(victim.instanceId);
          ctx.world.instances.get(victim.instanceId)!.hostDead = true;
          // The DB's formation reaper: voids what a dead host left.
          ctx.world.reap((id) => !dead.has(id));
        }
        await waitMs(300);
        ctx.world.reap((id) => !dead.has(id));
      },
    });
    assertRequiredOutcome(r, { allowReap: true, label: 'host crash' });
    expect(dead.size).toBeGreaterThan(3);
    for (const id of dead) {
      const inst = r.world.instances.get(id)!;
      expect(inst.state).toBe('abandoned');
    }
    record('chaos-host-crash', r);
  }, 60_000);

  it('RPC timeout: the forming call that never answers in time is re-asked under the SAME id and dealt once', async () => {
    let hung = 0;
    const r = await run({
      name: 'chaos-rpc-timeout',
      players: 100,
      clusters: 1,
      hands: 100,
      capMs: 15_000,
      seed: 5003,
      formTimeoutMs: 120,
      chaos: async (ctx) => {
        ctx.world.faults = (fn) => {
          if (fn !== 'fn_lightning_match_and_form' || hung >= 6 || ctx.rnd() > 0.3) return null;
          hung++;
          return { kind: 'hang', ms: 600 };
        };
        await waitFor(() => hung >= 6, 8_000);
        await waitMs(800);
        ctx.world.faults = null;
      },
    });
    assertRequiredOutcome(r, { label: 'rpc timeout' });
    expect(hung).toBe(6);
    const timeouts = r.passes.outcomes.filter((o) => o.reason === 'rpc_timeout').length;
    const skipped = r.passes.outcomes.filter((o) => o.reason === 'formation_in_flight').length;
    expect(timeouts).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
    // The unknown outcomes were re-asked and answered from the record.
    expect(r.world.counters.replayed).toBeGreaterThan(0);
    record('chaos-rpc-timeout', r);
  }, 60_000);

  it('RPC connection loss (answers lost before AND after commit): settled once or abandoned, never twice', async () => {
    const r = await run({
      name: 'chaos-connection-loss',
      players: 100,
      clusters: 2,
      hands: 120,
      capMs: 20_000,
      seed: 5004,
      allowReap: true,
      chaos: async (ctx) => {
        await waitMs(400);
        ctx.world.faults = (fn) =>
          fn === 'fn_lightning_latency_report'
            ? null
            : ctx.rnd() < 0.5
              ? { kind: ctx.rnd() < 0.5 ? 'transport_before' : 'transport_after' }
              : null;
        await waitMs(700);
        ctx.world.faults = null;
      },
    });
    assertRequiredOutcome(r, { allowReap: true, label: 'connection loss' });
    expect(r.world.counters.settleReplays + r.world.counters.replayed).toBeGreaterThan(0);
    record('chaos-connection-loss', r);
  }, 60_000);

  it('duplicated, delayed, reordered and dropped events (presence, fold, settle, render)', async () => {
    const r = await run({
      name: 'chaos-events',
      players: 100,
      clusters: 1,
      hands: 120,
      capMs: 20_000,
      seed: 5005,
      noAckShare: 0.25,
      rpcLatencyMs: (rnd) => Math.floor(rnd() * 20), // answers overtake each other
      driver: { duplicateFoldEvery: 3, earlyFoldShare: 0.05 },
      chaos: async (ctx) => {
        // Settle and fold answers dropped after commit (the retry must replay).
        ctx.world.faults = (fn) =>
          (fn === 'settle' || fn === 'fastFold') && ctx.rnd() < 0.3
            ? { kind: 'transport_after' }
            : null;
        const humans = humansOf(ctx.world);
        for (let round = 0; round < 6; round++) {
          await waitMs(150);
          for (const p of humans) {
            const x = ctx.rnd();
            if (x < 0.1) {
              // duplicated connect: a second socket in the same room
              await ctx.engine.join(p.id);
            } else if (x < 0.2) {
              // reordered: the drop lands, then a duplicate drop, then the connect
              ctx.engine.drop(p.id);
              ctx.engine.drop(p.id);
              await ctx.engine.join(p.id);
            }
          }
          // Render acks duplicated and for the wrong hand: ignored.
          for (const h of ctx.engine.hosts()) {
            for (const pid of h.participantIds()) {
              const room = h.roomOf(pid)!;
              ctx.engine.registry.renderAck(room, pid, h.currentHandId);
              ctx.engine.registry.renderAck(room, pid, 'not-this-hand');
            }
          }
        }
        ctx.world.faults = null;
      },
    });
    assertRequiredOutcome(r, { label: 'events' });
    expect(r.world.counters.settleReplays).toBeGreaterThan(0);
    record('chaos-events', r);
  }, 60_000);

  it('websocket disconnect storm: presence settles, maps stay bounded, play resumes', async () => {
    let stormEnded = 0;
    const r = await run({
      name: 'chaos-disconnect-storm',
      players: 500,
      clusters: 2,
      hands: 200,
      capMs: 20_000,
      seed: 5006,
      chaos: async (ctx) => {
        const humans = humansOf(ctx.world);
        for (let round = 0; round < 5; round++) {
          await waitMs(200);
          const gone = humans.filter(() => ctx.rnd() < 0.5);
          for (const p of gone) ctx.engine.drop(p.id);
          const sizes = ctx.engine.registry.sizes;
          expect(sizes.rooms).toBeLessThanOrEqual(ctx.world.players.size);
          await waitMs(100);
          await Promise.all(gone.map((p) => ctx.engine.join(p.id)));
        }
        stormEnded = Date.now();
        await waitFor(
          () => ctx.passes.outcomes.some((o) => o.at >= stormEnded && (o.formed ?? 0) > 0),
          3_000
        );
      },
    });
    assertRequiredOutcome(r, { label: 'disconnect storm' });
    const formedAfter = r.passes.outcomes.filter(
      (o) => o.at >= stormEnded && o.outcome === 'formed' && (o.formed ?? 0) > 0
    );
    expect(formedAfter.length).toBeGreaterThan(0);
    record('chaos-disconnect-storm', r);
  }, 60_000);

  it('server restart: the new process rebuilds from the database state alone', async () => {
    const r = await run({
      name: 'chaos-server-restart',
      players: 100,
      clusters: 2,
      hands: 140,
      capMs: 20_000,
      seed: 5007,
      chaos: async (ctx) => {
        await waitMs(1_200);
        // The process goes down: its hands that have not reached settlement are voided.
        ctx.driver.stop();
        await ctx.engine.stop();
        ctx.world.lease = {
          instance: 'load-engine-2',
          generation: '00004242-0000-4000-8000-000000000002',
        };
        // A new process: a new registry, hosting, supervisor and gate - and the database.
        const next = new LoadEngine(ctx.world, { rnd: ctx.rnd, noAckShare: 0.1 });
        const driver = new TableDriver(next, { rnd: ctx.rnd, foldShare: 0.5, thinkMs: () => 2 });
        ctx.setEngine(next, driver);
        next.start();
        await joinAll(
          next,
          humansOf(ctx.world).map((p) => p.id),
          200,
          ctx.rnd
        );
        driver.start();
      },
    });
    assertRequiredOutcome(r, { label: 'server restart' });
    expect(r.engines.length).toBe(2);
    // Both generations dealt and settled; nothing survived the old one unexplained.
    expect(r.world.counters.abandoned + r.world.settledHands).toBe(r.world.instances.size);
    record('chaos-server-restart', r);
  }, 60_000);

  it('settlement retry: every first answer lost after commit, the retry replays the one receipt', async () => {
    const lostOnce = new Set<string>();
    const r = await run({
      name: 'chaos-settlement-retry',
      players: 100,
      clusters: 1,
      hands: 100,
      capMs: 15_000,
      seed: 5008,
      chaos: async (ctx) => {
        ctx.world.faults = (fn, c) => {
          if (fn !== 'settle' || !c.handId || lostOnce.has(c.handId)) return null;
          lostOnce.add(c.handId);
          return { kind: 'transport_after' };
        };
      },
    });
    assertRequiredOutcome(r, { label: 'settlement retry' });
    expect(r.world.counters.settleReplays).toBeGreaterThanOrEqual(r.world.settledHands - 5);
    record('chaos-settlement-retry', r);
  }, 60_000);

  it('conversion failure (pending_off, aborted back) and a freeze: drains, resumes, the frozen Cluster stops for good', async () => {
    let frozenCluster = '';
    let mafAfterFreeze = 0;
    const r = await run({
      name: 'chaos-conversion',
      players: 120,
      clusters: 2,
      hands: 120,
      capMs: 20_000,
      seed: 5009,
      allowReap: true,
      chaos: async (ctx) => {
        const [a, b] = [...ctx.world.clusters.values()];
        await waitMs(400);
        a.mode = 'pending_off'; // the conversion back to MUST MOVE starts...
        await waitMs(400);
        a.mode = 'lightning'; // ...and is aborted: Lightning resumes
        await waitMs(400);
        frozenCluster = b.id;
        b.mode = 'frozen';
        const before = ctx.world.mafByCluster.get(b.id) ?? 0;
        await waitMs(1_200);
        // The worker of a frozen Cluster stopped; the supervisor does not restart it.
        expect(ctx.engine.supervisor.workerFor(b.id)).toBeUndefined();
        mafAfterFreeze = (ctx.world.mafByCluster.get(b.id) ?? 0) - before;
        // Settlement on a frozen Cluster is the reaper's (evidence stays put).
        ctx.world.reap((id) => ctx.world.instances.get(id)?.clusterId !== b.id);
      },
    });
    assertRequiredOutcome(r, { allowReap: true, label: 'conversion' });
    expect(frozenCluster).not.toBe('');
    // Only the other Cluster kept forming (a frozen Cluster answers once, then is left alone).
    expect(r.passes.starts()).toBe(2);
    // The frozen Cluster was asked at most once more (the pass that learned it froze).
    expect(mafAfterFreeze).toBeLessThanOrEqual(2);
    record('chaos-conversion', r);
  }, 60_000);
});

// ─── 4. THE LATENCY LEDGER ─────────────────────────────────────────────────

describe('the latency ledger (fn_lightning_latency_report)', () => {
  const CLUSTER = '00001000-0000-4000-8000-000000000001';
  function ledger(
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
    t: { now: number }
  ) {
    const telemetry = new LightningTelemetry();
    const l = new LightningLatencyLedger(CLUSTER, {
      rpc,
      telemetry,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(t.now),
    });
    return { l, telemetry };
  }

  it('reads latency_telemetry and latency_window_ms with the DB clamps (default on, 60 s, 10 s → 600 s)', () => {
    expect(parseLightningLatencyConfig({})).toEqual({ enabled: true, windowMs: 60_000 });
    expect(parseLightningLatencyConfig({ latency_telemetry: false })).toEqual({
      enabled: false,
      windowMs: 60_000,
    });
    expect(parseLightningLatencyConfig({ latency_window_ms: 5 }).windowMs).toBe(10_000);
    expect(parseLightningLatencyConfig({ latency_window_ms: 9e9 }).windowMs).toBe(600_000);
    expect(parseLightningLatencyConfig({ latency_window_ms: 'x' }).windowMs).toBe(60_000);
    expect(parseLightningConfig({ worker_mode: 'form' }).latency).toEqual({
      enabled: true,
      windowMs: 60_000,
    });
  });

  it('n/p50/p95/p99 per leg under the contract keys; first window exact, later ones aligned; empty windows send nothing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { ok: true }, error: null };
    });
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 7, 123) };
    const { l, telemetry } = ledger(rpc, t);
    l.configure({ enabled: true, windowMs: 60_000 });
    for (let i = 1; i <= 100; i++) telemetry.latency(CLUSTER, 'fold_ack', i);
    for (let i = 1; i <= 10; i++) telemetry.latency(CLUSTER, 'hand_to_first_render', 10 * i);
    telemetry.latency(CLUSTER, 'ack_to_idle_pool', 3);
    telemetry.latency('00009999-0000-4000-8000-000000000001', 'fold_ack', 9_999); // another Cluster
    t.now = Date.UTC(2026, 9, 9, 12, 1, 0, 5);
    l.tick();
    await l.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      p_cluster_id: CLUSTER,
      p_window_from: '2026-10-09T12:00:07.123Z',
      p_window_to: '2026-10-09T12:01:00.000Z',
      p_legs: {
        fold_ack: { n: 100, p50: 50, p95: 95, p99: 99 },
        ack_to_idle: { n: 1, p50: 3, p95: 3, p99: 3 },
        hand_to_first_render: { n: 10, p50: 50, p95: 100, p99: 100 },
      },
    });
    // The next window is aligned; one with no sample sends nothing.
    t.now = Date.UTC(2026, 9, 9, 12, 2, 0, 1);
    l.tick();
    await l.settled();
    expect(calls).toHaveLength(1);
    telemetry.latency(CLUSTER, 'match_to_hand', 40);
    t.now = Date.UTC(2026, 9, 9, 12, 3, 0, 1);
    l.tick();
    await l.settled();
    expect(calls[1].p_window_from).toBe('2026-10-09T12:02:00.000Z');
    expect(calls[1].p_window_to).toBe('2026-10-09T12:03:00.000Z');
    expect(Object.keys(calls[1].p_legs as object)).toEqual(['match_to_hand']);
  });

  it('one flush in flight; a transport retry sends the SAME frozen payload, so it can only replay', async () => {
    const seen: unknown[] = [];
    let release: (() => void) | null = null;
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      seen.push(args);
      if (seen.length <= 2) return { data: null, error: { code: '08006', message: 'lost' } };
      if (seen.length === 3) await new Promise<void>((r) => (release = r));
      return { data: { ok: true }, error: null };
    });
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 0, 0) };
    const { l, telemetry } = ledger(rpc, t);
    l.configure({ enabled: true, windowMs: 10_000 });
    telemetry.latency(CLUSTER, 'fold_ack', 7);
    t.now += 10_000;
    l.tick();
    await l.settled();
    expect(seen).toHaveLength(1);
    // Backoff: nothing again before it, then the same object.
    l.tick();
    await l.settled();
    expect(seen).toHaveLength(1);
    t.now += 5_000;
    l.tick();
    await l.settled();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    // A third attempt hangs: a second window closing meanwhile waits, never a second call in flight.
    t.now += 10_000;
    telemetry.latency(CLUSTER, 'fold_ack', 9);
    l.tick();
    t.now += 10_000;
    telemetry.latency(CLUSTER, 'fold_ack', 11);
    l.tick();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toBe(seen[0]);
    // The hung head, plus the closed window waiting behind it (the newest is still open).
    expect(l.queued).toBe(2);
    release!();
    await waitFor(() => l.queued === 0, 1_000, 1);
    await l.settled();
    expect(l.recordsSent).toBe(2);
    expect(seen).toHaveLength(4);
  });

  it('missing function: ten minutes of quiet, the queue dropped, never a loop, never a fault', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.fn_lightning_latency_report',
      },
    }));
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 0, 0) };
    const { l, telemetry } = ledger(rpc, t);
    l.configure({ enabled: true, windowMs: 10_000 });
    for (let w = 0; w < 30; w++) {
      telemetry.latency(CLUSTER, 'fold_ack', 5);
      t.now += 10_000;
      l.tick();
      await l.settled();
    }
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(l.queued).toBe(0);
    t.now += LIGHTNING_LATENCY_RPC_RETRY_MS;
    telemetry.latency(CLUSTER, 'fold_ack', 5);
    t.now += 10_000;
    l.tick();
    await l.settled();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('a refusal is final; the queue is bounded; latency_telemetry off is zero work', async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: false, code: 'IDEMPOTENCY_CONFLICT' },
      error: null,
    }));
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 0, 0) };
    const { l, telemetry } = ledger(rpc, t);
    l.configure({ enabled: true, windowMs: 10_000 });
    telemetry.latency(CLUSTER, 'fold_ack', 5);
    t.now += 10_000;
    l.tick();
    await l.settled();
    t.now += 60_000;
    l.tick();
    await l.settled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(l.refusedWindows).toBe(1);
    // Bounded queue under a transport outage.
    const down = vi.fn(async () => ({ data: null, error: { code: '08006', message: 'down' } }));
    const t2 = { now: Date.UTC(2026, 9, 9, 13, 0, 0, 0) };
    const b = ledger(down, t2);
    b.l.configure({ enabled: true, windowMs: 10_000 });
    for (let w = 0; w < 40; w++) {
      b.telemetry.latency(CLUSTER, 'fold_ack', 5);
      t2.now += 10_000;
      b.l.tick();
      await b.l.settled();
    }
    expect(b.l.queued).toBeLessThanOrEqual(LIGHTNING_LATENCY_MAX_QUEUED);
    expect(b.l.heldSamples).toBeLessThanOrEqual(1);
    // Off: unregistered, nothing held, nothing called.
    const off = vi.fn();
    const c = ledger(off as never, { now: Date.UTC(2026, 9, 9, 14, 0, 0, 0) });
    c.l.configure({ enabled: false, windowMs: 60_000 });
    c.telemetry.latency(CLUSTER, 'fold_ack', 5);
    c.l.tick();
    expect(c.telemetry.isRecordingLatency(CLUSTER)).toBe(false);
    expect(c.l.heldSamples).toBe(0);
    expect(off).not.toHaveBeenCalled();
  });

  it('stop flushes the open window; a successor ledger never reuses its window_from', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = vi.fn(async (_f: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { ok: true }, error: null };
    });
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 1, 0) };
    const a = ledger(rpc, t);
    a.l.configure({ enabled: true, windowMs: 60_000 });
    a.telemetry.latency(CLUSTER, 'fold_ack', 5);
    t.now += 20_000;
    await a.l.stop();
    t.now += 1_500;
    const b = ledger(rpc, t);
    b.l.configure({ enabled: true, windowMs: 60_000 });
    b.telemetry.latency(CLUSTER, 'fold_ack', 6);
    await b.l.stop();
    expect(calls).toHaveLength(2);
    expect(calls[0].p_window_from).not.toBe(calls[1].p_window_from);
    expect(a.telemetry.isRecordingLatency(CLUSTER)).toBe(false);
  });
});

// ─── 5. HAND CREATION -> FIRST CLIENT RENDER ───────────────────────────────

describe('hand creation → first client render: engine clock, per connection, once', () => {
  const ROOM = '00003000-0000-4000-8000-000000000001';
  const USER = '00002000-0000-4000-8000-000000000001';
  const HAND = '00008000-0000-4000-8000-000000000001';
  const CLUSTER = '00001000-0000-4000-8000-000000000001';

  function reg() {
    const t = { now: 1_000_000 };
    const metrics = new LightningMetrics(new MetricsRegistry(), null);
    const seen: Array<[string, number, string | null | undefined]> = [];
    const observe = metrics.observeLatency.bind(metrics);
    metrics.observeLatency = (s, ms, c) => {
      seen.push([s, ms, c]);
      observe(s, ms, c);
    };
    const r = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => ({ playerId: USER, clusterId: CLUSTER }),
      clusterMode: async () => 'lightning',
      now: () => t.now,
      metrics,
    });
    return { r, t, seen };
  }

  it('measures the first frame → the room’s RENDER_ACK on the engine’s clock', async () => {
    const { r, t, seen } = reg();
    await r.authorize(ROOM, USER);
    r.connect(ROOM, USER);
    r.noteFirstFrame(ROOM, USER, HAND, t.now);
    t.now += 37;
    expect(r.renderAck(ROOM, USER, HAND)).toBe(true);
    expect(seen).toEqual([['hand_to_first_render', 37, CLUSTER]]);
    // Once per hand: a duplicate ack is nothing.
    t.now += 5;
    expect(r.renderAck(ROOM, USER, HAND)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('the wrong user, the wrong hand or a late ack is no sample; a seat whose room never acks is simply none', async () => {
    const { r, t, seen } = reg();
    await r.authorize(ROOM, USER);
    r.connect(ROOM, USER);
    r.noteFirstFrame(ROOM, USER, HAND, t.now);
    expect(r.renderAck(ROOM, '00002000-0000-4000-8000-000000000999', HAND)).toBe(false);
    expect(r.renderAck(ROOM, USER, '00008000-0000-4000-8000-000000000999')).toBe(false);
    expect(r.renderAck(ROOM, USER, 42)).toBe(false);
    t.now += LIGHTNING_RENDER_ACK_TTL_MS + 1;
    expect(r.renderAck(ROOM, USER, HAND)).toBe(false);
    expect(seen).toEqual([]);
    // A room with no socket is pruned with its pending frame: nothing waits for it.
    r.disconnect(ROOM, USER);
    expect(r.pendingRenderAcks).toBe(0);
  });

  it('the transport accepts a RENDER_ACK carrying a hand id only and hands it to the registry', () => {
    const src = readFileSync(
      new URL('../transport/EngineWebSocketServer.ts', import.meta.url),
      'utf8'
    );
    expect(src).toContain("case 'RENDER_ACK'");
    expect(src).toMatch(/onRenderAck\?\.\(tableId, userId, handId\)/);
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(
      /onRenderAck: \(tableId, userId, handId\) => \{\s*gameServer\.lightningRooms\.renderAck\(tableId, userId, handId\);/
    );
  });
});

// ─── 6. THE FORMATION GATE ─────────────────────────────────────────────────

describe('the formation gate', () => {
  it('holds while a call is in flight, keeps an unknown outcome to be re-asked, forgets a known one', () => {
    const g = new LightningFormationGate();
    const C = '00001000-0000-4000-8000-000000000001';
    expect(g.check(C, 0)).toEqual({ busy: false, pendingRequestId: null });
    g.open(C, 'r1', 0);
    expect(g.check(C, 10).busy).toBe(true);
    g.close(C, 'other', false, 20); // only the holder closes it
    expect(g.check(C, 20).busy).toBe(true);
    g.close(C, 'r1', true, 30);
    expect(g.check(C, 40)).toEqual({ busy: false, pendingRequestId: 'r1' });
    g.open(C, 'r1', 50);
    g.close(C, 'r1', false, 60);
    expect(g.check(C, 70)).toEqual({ busy: false, pendingRequestId: null });
    expect(g.size).toBe(0);
    expect(g.overlaps).toBe(0);
    // A call that never answers stops holding after the stale bound.
    g.open(C, 'r2', 0);
    expect(g.check(C, 60_001)).toEqual({ busy: false, pendingRequestId: 'r2' });
  });
});

// ─── 7. SEPARATION AND THE LAWS (source pins) ──────────────────────────────

describe('telemetry never feeds the matcher; horses are players', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

  it('the matcher input reads nothing the latency path produces', () => {
    // The matcher model is pure (no imports at all) and never names latency.
    const model = read('LightningMatcherModel.ts');
    expect(model).not.toMatch(/^import /m);
    expect(model).not.toMatch(/latenc|render_ack|renderAck/i);
    // The ledger reads nothing of the matcher, the shadow model or the pool.
    const ledgerSrc = read('LightningLatencyLedger.ts');
    expect(ledgerSrc).not.toMatch(
      /LightningMatcherModel|LightningShadowRunner|LightningPresence|match_and_form|fn_lightning_match/
    );
    // The worker only configures, ticks and stops its ledger: it never reads it into a pass.
    const worker = read('LightningClusterWorker.ts');
    const uses = worker.match(/this\.latency\.[a-zA-Z]+/g) ?? [];
    expect([...new Set(uses)].sort()).toEqual([
      'this.latency.configure',
      'this.latency.stop',
      'this.latency.tick',
    ]);
    // The forming call's arguments are exactly the contract's: nothing measured goes in.
    const rpcSrc = read('LightningRpc.ts');
    const maf = rpcSrc.slice(rpcSrc.indexOf('export async function lightningMatchAndForm'));
    const body = maf.slice(0, maf.indexOf('\n}\n'));
    expect(body).not.toMatch(/latenc|render|telemetry|integrity|shadow|quality/);
  });

  it('no Phase 12 engine surface reads or filters on is_horse (CLAUDE.md 10.5)', () => {
    for (const f of [
      'LightningLatencyLedger.ts',
      'LightningFormationGate.ts',
      'LightningRegistry.ts',
      'LightningSupervisor.ts',
      'LightningClusterWorker.ts',
      'LightningTelemetry.ts',
    ]) {
      expect(read(f), f).not.toMatch(/is_horse|isHorse|horse_id/);
    }
  });
});
