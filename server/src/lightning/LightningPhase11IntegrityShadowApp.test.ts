/**
 * LIGHTNING PHASE 11 (engine): the shadow matcher, integrity telemetry and
 * action latency telemetry (spec Phases 18 and 19, app side).
 *
 *   - THE SHADOW NEVER TOUCHES LIVE PLAY: the same seeded scenario, shadow on
 *     and off, makes the same live calls and deals the same hands; the shadow
 *     side calls no writer (no reservation, no seat, no hand).
 *   - ONE RECORD PER WINDOW, on wall-clock aligned windows, naming both
 *     matcher versions; nothing at all when the flags are off.
 *   - A MISSING FUNCTION (deploy window) is ten minutes of quiet, never a loop.
 *   - LATENCY legs are aggregated per window into the live side's p50/p95.
 *   - INTEGRITY signals carry timing only - no card, board or amount - and
 *     the matcher never reads them. Horses are timed exactly as humans.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 11 fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 11 fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const { LIGHTNING_AUTO_REBUY_DEFAULTS, parseLightningConfig, parseLightningShadowConfig } =
  await import('./LightningConfig.js');
const { LightningClusterWorker } = await import('./LightningClusterWorker.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { LightningTelemetry } = await import('./LightningTelemetry.js');
const { LightningIntegrityWindow, LIGHTNING_INTEGRITY_FAST_MS } =
  await import('./LightningIntegrity.js');
const {
  LightningShadowRunner,
  LIGHTNING_SHADOW_IN_HAND_MAX_MS,
  LIGHTNING_SHADOW_RPC_RETRY_MS,
  scoreLightningDecision,
} = await import('./LightningShadowRunner.js');
const {
  LIGHTNING_MATCHER_MODELS,
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  lightningGroupSizes,
  lightningMatcherModel,
  lightningMatcherParams,
} = await import('./LightningMatcherModel.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

type Config = import('./LightningConfig.js').LightningConfig;
type Call = { fn: string; args: Record<string, unknown> };

const CLUSTER = uid(1);
const POP = Array.from({ length: 12 }, (_, i) => uid(200 + i));
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOT_FOUND = { code: 'PGRST202', message: 'Could not find the function in the schema cache' };

function config(shadow: Record<string, unknown> | null): Config {
  return {
    matcherVersion: 'm1',
    workerMode: 'form',
    passIntervalMs: 2_000,
    keepaliveIntervalMs: 30_000,
    maxHandsPerPass: 32,
    dealWindowMs: 600_000,
    autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
    ...(shadow ? { shadow: parseLightningShadowConfig(shadow) } : {}),
  };
}

const ON = { lightning_shadow_matcher: true, integrity_telemetry: true, shadow_window_ms: 60_000 };

/**
 * A seeded Cluster: the live matcher (a stand-in for the SQL writer) forms
 * hands out of whoever it chooses; the scenario's randomness is its own,
 * independent of anything the shadow does.
 */
function scenario(
  seed: number,
  shadowCfg: Record<string, unknown> | null,
  opts: { missing?: Set<string>; t0?: number } = {}
) {
  const rnd = mulberry32(seed);
  const calls: Call[] = [];
  const started: unknown[] = [];
  let t = opts.t0 ?? Date.UTC(2026, 9, 8, 12, 0, 0);
  let handNo = 0;
  const busy = new Set<string>();
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
    if (opts.missing?.has(fn)) return { data: null, error: NOT_FOUND };
    if (fn === 'fn_lightning_match_and_form') {
      // Release a few players, then form one or two hands from the idle ones.
      for (const p of [...busy]) if (rnd() < 0.5) busy.delete(p);
      const idle = POP.filter((p) => !busy.has(p));
      const hands: unknown[] = [];
      while (idle.length >= 3 && hands.length < 2 && rnd() < 0.8) {
        const size = 2 + Math.floor(rnd() * Math.min(5, idle.length - 1));
        const players = idle.splice(0, size);
        players.forEach((p) => busy.add(p));
        handNo++;
        hands.push({
          hand_id: uid(5000 + handNo),
          instance_id: uid(7000 + handNo),
          bb: players[0],
          sb: players[1],
          btn: players[players.length - 1],
          players,
        });
      }
      return {
        data: {
          ok: true,
          formed: hands.length,
          hands,
          matcher_version: 'm1',
          stopped_reason: 'plan_exhausted',
        },
        error: null,
      };
    }
    if (fn === 'fn_lightning_shadow_record' || fn === 'fn_lightning_integrity_report')
      return { data: { ok: true }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
  const telemetry = new LightningTelemetry();
  const metrics = new LightningMetrics(new MetricsRegistry(), telemetry);
  const presence = new LightningPresence(() => [
    {
      tableId: uid(9001),
      clusterId: CLUSTER,
      players: POP.map((userId, i) => ({
        userId,
        presence: i === 11 ? ('disconnected' as const) : ('connected' as const),
      })),
    },
  ]);
  const now = () => new Date(t);
  const runner = new LightningShadowRunner(CLUSTER, {
    rpc,
    telemetry,
    logger: quiet,
    now,
    clock: () => 0,
  });
  const worker = new LightningClusterWorker(CLUSTER, config(shadowCfg), {
    rpc,
    presence,
    metrics,
    logger: quiet,
    now,
    startHand: (hand) => started.push({ ...hand, formedAtMs: 0 }),
    hasInstance: () => false,
    shadow: runner,
  });
  return {
    rpc,
    calls,
    started,
    runner,
    worker,
    telemetry,
    metrics,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const liveCalls = (calls: Call[]) =>
  calls
    .filter((c) => c.fn === 'fn_lightning_match_and_form')
    .map((c) => {
      const { p_request_id: _id, ...rest } = c.args;
      return rest;
    });

async function drive(s: ReturnType<typeof scenario>, passes: number, stepMs = 2_000) {
  for (let i = 0; i < passes; i++) {
    await s.worker.pass();
    s.advance(stepMs);
  }
  await s.runner.settled();
}

// ─── 1. The matcher model ──────────────────────────────────────────────────

describe('the matcher model (pluggable by version)', () => {
  it('ports P1 group sizing exactly (fn_lightning_group_sizes)', () => {
    expect(lightningGroupSizes(1, 2, 9, 9)).toEqual([]);
    expect(lightningGroupSizes(9, 2, 9, 9)).toEqual([9]);
    expect(lightningGroupSizes(10, 2, 9, 9)).toEqual([5, 5]);
    expect(lightningGroupSizes(19, 2, 6, 6)).toEqual([5, 5, 5, 4]);
    expect(lightningGroupSizes(7, 3, 3, 3)).toEqual([3, 3]); // no split seats all: full groups
  });

  it('knows m1 (the SQL port) and m2 (the candidate); an unknown version is none', () => {
    expect([...LIGHTNING_MATCHER_MODELS.keys()]).toEqual(['m1', 'm2']);
    expect(lightningMatcherModel('m1')?.version).toBe('m1');
    expect(lightningMatcherModel('m9')).toBeNull();
  });

  it('m1: P2 big blinds (never-paid first), P4 seats, the button from the button backward', () => {
    const now = 1_000_000;
    const players = POP.slice(0, 5).map((id, i) => ({
      playerId: id,
      legal: true,
      reasonCode: null,
      idleSinceMs: now - 10_000 + i * 1000,
      enteredAtMs: now - 100_000,
      lastBbAtMs: i === 0 ? now - 5_000 : null,
      bbUnresolved: false,
      debtSinceMs: now - 100_000,
      handsSinceBb: i === 0 ? 0 : null,
      newcomer: false,
      positions: { btn: i === 4 ? 9 : 0, co: 0, hj: 0, utg: 0 },
    }));
    const plan = lightningMatcherModel('m1')!.plan(
      { nowMs: now, players, recentHands: [] },
      LIGHTNING_MATCHER_PARAM_DEFAULTS
    );
    expect(plan.groups).toHaveLength(1);
    const g = plan.groups[0];
    expect(g.bb).toBe(POP[1]); // never paid a BB, lowest entry/id among them
    expect(g.players).toHaveLength(5);
    expect(g.btn).not.toBe(POP[4]); // P3: the player with 9 buttons is not given another
    expect(new Set(g.players).size).toBe(5);
  });

  it('reads the plan keys from the config row; the candidate keeps its own knobs', () => {
    const p = lightningMatcherParams({
      instance_max: 6,
      position_fairness: false,
      first_entry_rule: 'big_blind',
      // The DB's scoring weights: never a matcher input.
      quality_weights: { next_hand_speed: 1 },
    });
    expect(p.instanceMax).toBe(6);
    expect(p.positionFairness).toBe(false);
    expect(p.firstEntryRule).toBe('big_blind');
    expect(p.candidate).toEqual({ thinWeight: null, diversityScale: 1 });
    expect(JSON.stringify(p)).not.toMatch(/next_hand_speed|quality/);
  });
});

// ─── 2. The shadow never touches live play ─────────────────────────────────

describe('the shadow runner never alters the live decision', () => {
  it('the same seeded scenario makes the same live calls and deals the same hands, shadow on or off', async () => {
    const off = scenario(42, null);
    const on = scenario(42, ON);
    await drive(off, 120);
    await drive(on, 120);
    expect(on.runner.active).toBe(true);
    expect(liveCalls(on.calls)).toEqual(liveCalls(off.calls));
    expect(on.started).toEqual(off.started);
    expect(on.started.length).toBeGreaterThan(20);
    // The shadow side called no writer: only the two Phase 11 recorders.
    const allowed = [
      'fn_lightning_match_and_form',
      'fn_lightning_shadow_record',
      'fn_lightning_integrity_report',
    ];
    for (const c of on.calls) expect(allowed).toContain(c.fn);
    expect(on.calls.some((c) => c.fn === 'fn_lightning_shadow_record')).toBe(true);
    for (const c of on.calls)
      expect(c.fn).not.toMatch(/form_hand|reserv|seat|begin_dealing|settle/);
  });

  it('a shadow plan that throws is contained: live passes still form', async () => {
    const s = scenario(7, ON);
    const m2 = LIGHTNING_MATCHER_MODELS.get('m2')!;
    const spy = vi.spyOn(m2, 'plan').mockImplementation(() => {
      throw new Error('candidate bug');
    });
    try {
      await drive(s, 40);
      expect(spy).toHaveBeenCalled();
      expect(s.started.length).toBeGreaterThan(5);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── 3. Windows, flags and the deploy window ───────────────────────────────

describe('one record per Cluster per window', () => {
  it('flushes once per closed wall-clock window, naming both versions', async () => {
    const s = scenario(3, ON, { t0: Date.UTC(2026, 9, 8, 12, 0, 0) });
    await drive(s, 150); // 300 s of passes, 2 s apart
    const records = s.calls.filter((c) => c.fn === 'fn_lightning_shadow_record');
    expect(records).toHaveLength(4); // [12:00,12:01) .. [12:03,12:04) closed; 12:04 still open
    for (let i = 0; i < records.length; i++) {
      const a = records[i].args;
      expect(a.p_cluster_id).toBe(CLUSTER);
      expect(a.p_live_version).toBe('m1');
      expect(a.p_shadow_version).toBe('m2');
      expect(a.p_window_from).toBe(new Date(Date.UTC(2026, 9, 8, 12, i, 0)).toISOString());
      expect(a.p_window_to).toBe(new Date(Date.UTC(2026, 9, 8, 12, i + 1, 0)).toISOString());
      const live = a.p_live as Record<string, any>;
      const shadow = a.p_shadow as Record<string, any>;
      expect(live.passes).toBe(30);
      expect(shadow.passes).toBe(30);
      for (const side of [live, shadow]) {
        for (const k of [
          'formation_success_rate',
          'failure_rate',
          'wait_ms',
          'bb_fairness',
          'position_fairness',
          'opponent_diversity',
          'instance_occupancy',
          'matcher_version',
        ])
          expect(side, k).toHaveProperty(k);
      }
    }
    // Stopping flushes the open window once.
    await s.worker.stop();
    expect(s.calls.filter((c) => c.fn === 'fn_lightning_shadow_record')).toHaveLength(5);
  });

  it('every payload passes the DB contract (20261008161509): keys, ranges, windows', async () => {
    const s = scenario(16, ON);
    const feed = async (passes: number) => {
      for (let i = 0; i < passes; i++) {
        const hand = uid(6500 + i);
        s.telemetry.handDealt(CLUSTER, hand, POP.slice(0, 4), s.now());
        for (const p of POP.slice(0, 4)) s.telemetry.decision(CLUSTER, hand, p, 300 + i, s.now());
        s.telemetry.handEnded(CLUSTER, hand, s.now());
        s.metrics.observeLatency('fold_ack', 20 + i, CLUSTER);
        await s.worker.pass();
        s.advance(2_000);
      }
      await s.runner.settled();
    };
    await feed(70);
    const keysDeep = (v: unknown, out: string[] = []): string[] => {
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (!Array.isArray(v)) out.push(k);
          keysDeep(x, out);
        }
      return out;
    };
    const rec = s.calls.find((c) => c.fn === 'fn_lightning_shadow_record')!.args;
    const rep = s.calls.find((c) => c.fn === 'fn_lightning_integrity_report')!.args;
    for (const payload of [rec.p_live, rec.p_shadow, rep.p_signals]) {
      for (const k of keysDeep(payload)) expect(k).not.toMatch(/card|hole|deck|seed/i);
      expect(JSON.stringify(payload).length).toBeLessThan(16_384);
    }
    for (const side of [rec.p_live, rec.p_shadow] as Array<Record<string, any>>) {
      expect(Number.isInteger(side.passes)).toBe(true);
      for (const k of ['quorum_passes', 'failed_passes', 'groups', 'seated'])
        expect(Number.isInteger(side[k]) && side[k] >= 0).toBe(true);
      for (const k of ['formation_success_rate', 'failure_rate'])
        if (side[k] !== null) expect(side[k] >= 0 && side[k] <= 1).toBe(true);
      for (const o of [
        'wait_ms',
        'bb_fairness',
        'position_fairness',
        'opponent_diversity',
        'instance_occupancy',
      ])
        for (const v of Object.values(side[o] as Record<string, unknown>))
          if (v !== null) expect(typeof v === 'number' && v >= 0).toBe(true);
      for (const v of [
        side.opponent_diversity.repeat_pair_rate,
        side.instance_occupancy.utilization,
      ])
        if (v !== null) expect(v).toBeLessThanOrEqual(1);
    }
    expect(rec.p_live_version).toMatch(/^[A-Za-z0-9._:-]{1,32}$/);
    expect(rec.p_shadow_version).toMatch(/^[A-Za-z0-9._:-]{1,32}$/);
    expect(rec.p_live_version).not.toBe(rec.p_shadow_version);
    expect(Date.parse(rec.p_window_to as string)).toBeGreaterThan(
      Date.parse(rec.p_window_from as string)
    );
    const sig = rep.p_signals as Record<string, any>;
    expect(Date.parse(sig.window_to)).toBeGreaterThan(Date.parse(sig.window_from));
    expect(Date.parse(sig.window_to)).toBeLessThanOrEqual(
      Date.parse(rep.p_now as string) + 5 * 60_000
    );
    for (const k of ['hands', 'decisions', 'fast_ms', 'dropped_players', 'dropped_pairs'])
      expect(typeof sig[k]).toBe('number');
    expect(sig.players.length).toBeLessThanOrEqual(500);
    expect(sig.pairs.length).toBeLessThanOrEqual(200);
    for (const p of sig.pairs) expect(p.player_a < p.player_b).toBe(true);
    for (const p of sig.players)
      expect(p.fast_share === null || (p.fast_share >= 0 && p.fast_share <= 1)).toBe(true);
  });

  it('a candidate named the same as the live matcher sends no record (the DB refuses SAME_VERSION)', async () => {
    const s = scenario(15, { ...ON, shadow_matcher_version: 'm1' });
    await drive(s, 100);
    expect(s.calls.some((c) => c.fn === 'fn_lightning_shadow_record')).toBe(false);
    expect(s.started.length).toBeGreaterThan(10);
  });

  it('flags off: zero work - no registration, no plan, no record', async () => {
    const m1 = LIGHTNING_MATCHER_MODELS.get('m1')!;
    const m2 = LIGHTNING_MATCHER_MODELS.get('m2')!;
    const s1 = vi.spyOn(m1, 'plan');
    const s2 = vi.spyOn(m2, 'plan');
    try {
      for (const cfg of [null, { lightning_shadow_matcher: false, integrity_telemetry: false }]) {
        const s = scenario(9, cfg);
        await drive(s, 100);
        expect(s.runner.active).toBe(false);
        expect(s.telemetry.isRecording(CLUSTER)).toBe(false);
        expect(s.calls.every((c) => c.fn === 'fn_lightning_match_and_form')).toBe(true);
      }
      expect(s1).not.toHaveBeenCalled();
      expect(s2).not.toHaveBeenCalled();
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  });

  it('turning the flag off at runtime drops all state and unregisters', async () => {
    const s = scenario(10, ON);
    await drive(s, 10);
    expect(s.telemetry.isRecording(CLUSTER)).toBe(true);
    s.worker.updateConfig(config({ lightning_shadow_matcher: false }));
    expect(s.telemetry.isRecording(CLUSTER)).toBe(false);
    const before = s.calls.length;
    await drive(s, 60);
    expect(s.calls.slice(before).every((c) => c.fn === 'fn_lightning_match_and_form')).toBe(true);
  });

  it('a missing function is ten minutes of quiet, never a loop, never a fault', async () => {
    const missing = new Set(['fn_lightning_shadow_record', 'fn_lightning_integrity_report']);
    const s = scenario(11, ON, { missing });
    const feed = async (passes: number) => {
      for (let i = 0; i < passes; i++) {
        // Some decision timing every pass, so each window has signals to report.
        s.telemetry.handDealt(CLUSTER, uid(6000 + i), POP.slice(0, 3), s.now());
        s.telemetry.decision(CLUSTER, uid(6000 + i), POP[0], 900, s.now());
        await s.worker.pass();
        s.advance(2_000);
      }
      await s.runner.settled();
    };
    await feed(300); // ten minutes of passes
    const tries = (fn: string) => s.calls.filter((c) => c.fn === fn).length;
    expect(tries('fn_lightning_shadow_record')).toBe(1);
    expect(tries('fn_lightning_integrity_report')).toBe(1);
    expect(s.started.length).toBeGreaterThan(50); // live play went on
    s.advance(LIGHTNING_SHADOW_RPC_RETRY_MS);
    await feed(40);
    expect(tries('fn_lightning_shadow_record')).toBe(2);
  });

  it('CPU bound: an oversized snapshot is not planned; an overrun skips the next passes', async () => {
    const s = scenario(12, { ...ON, shadow_max_players: 10 });
    await drive(s, 31);
    const rec = s.calls.find((c) => c.fn === 'fn_lightning_shadow_record')!;
    const shadow = rec.args.p_shadow as Record<string, any>;
    const live = rec.args.p_live as Record<string, any>;
    expect(shadow.skipped.size_cap).toBeGreaterThan(0);
    expect(shadow.passes + shadow.skipped.size_cap).toBe(live.passes);

    let clock = 0;
    const telemetry = new LightningTelemetry();
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const runner = new LightningShadowRunner(CLUSTER, {
      rpc,
      telemetry,
      logger: quiet,
      now: () => new Date(0),
      clock: () => (clock += 200), // every plan "takes" 200 ms against a 50 ms budget
    });
    runner.configure(parseLightningShadowConfig(ON));
    for (let i = 0; i < 9; i++)
      runner.observe({
        nowMs: 1_000 + i * 1000,
        presence: { connected: POP.slice(0, 6), disconnected: [] },
        kind: 'form',
        ok: true,
        matcherVersion: 'm1',
        groups: [],
      });
    runner.observe({
      nowMs: 61_000,
      presence: { connected: [], disconnected: [] },
      kind: 'form',
      ok: true,
      matcherVersion: 'm1',
      groups: [],
    });
    await runner.settled();
    const sh = (rpc.mock.calls[0] as any)[1].p_shadow;
    expect(sh.skipped.overrun).toBe(6); // 9 passes: plan, skip 3, plan, skip 3, plan
    expect(sh.passes).toBe(3);
  });
});

// ─── 4. Action latency telemetry ───────────────────────────────────────────

describe('action latency: each leg per window, p50/p95 on the live side', () => {
  it('aggregates the Cluster-attributed legs and leaves other Clusters out', async () => {
    const s = scenario(13, ON);
    await s.worker.pass(); // opens the window
    for (let i = 1; i <= 100; i++) s.metrics.observeLatency('fold_ack', i, CLUSTER);
    for (let i = 1; i <= 20; i++) s.metrics.observeLatency('match_to_hand', 1000 + i, CLUSTER);
    s.metrics.observeLatency('fold_ack', 99_999, uid(2)); // another Cluster
    s.metrics.observeLatency('fold_ack', 99_999); // unattributed
    s.metrics.noteIdle(POP[0], s.now() - 700, 'fast', CLUSTER);
    s.metrics.noteMatched([POP[0]], s.now());
    s.advance(61_000);
    await s.worker.pass();
    await s.runner.settled();
    const live = s.calls.find((c) => c.fn === 'fn_lightning_shadow_record')!.args.p_live as any;
    expect(live.latency_ms.fold_ack).toEqual({ n: 100, p50: 50, p95: 95 });
    expect(live.latency_ms.match_to_hand).toEqual({ n: 20, p50: 1010, p95: 1019 });
    expect(live.latency_ms.idle_pool_to_match).toEqual({ n: 1, p50: 700, p95: 700 });
    // Lightning Phase 12: the client render ack exists; the leg is measured.
    expect(live.first_render_measured).toBe(true);
    expect(live.wait_ms.n).toBeGreaterThan(0);
  });
});

// ─── 5. Integrity telemetry ────────────────────────────────────────────────

describe('integrity signals: timing only, never a matcher input, horses as humans', () => {
  it('a real hand reports decision timing and nothing about cards or money', async () => {
    const telemetry = new LightningTelemetry();
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    let t = Date.UTC(2026, 9, 8, 13, 0, 0);
    const runner = new LightningShadowRunner(uid(1), {
      rpc,
      telemetry,
      logger: quiet,
      now: () => new Date(t),
    });
    runner.configure(
      parseLightningShadowConfig({ integrity_telemetry: true, shadow_window_ms: 60_000 })
    );
    const obs = (nowMs: number) =>
      runner.observe({
        nowMs,
        presence: { connected: [], disconnected: [] },
        kind: 'form',
        ok: true,
        matcherVersion: 'm1',
        groups: [],
      });
    obs(t);
    for (let seed = 0; seed < 4; seed++) {
      const formed = formedHand(4, 300 + seed * 10);
      const host = buildHost(formed, [100, 100, 100, 100], { deps: { telemetry } });
      await host.host.start();
      await playOut(host.host, mulberry32(seed), (_u, legal) =>
        legal.includes('check') ? 'check' : 'call'
      );
      await flush();
    }
    t += 61_000;
    obs(t);
    await runner.settled();
    const call = rpc.mock.calls.find((c: any) => c[0] === 'fn_lightning_integrity_report') as any;
    expect(call).toBeTruthy();
    const signals = call[1].p_signals;
    expect(signals.hands).toBe(4);
    expect(signals.decisions).toBeGreaterThan(8);
    expect(signals.players.length).toBeGreaterThan(0);
    for (const p of signals.players)
      expect(Object.keys(p).sort()).toEqual(
        [
          'cv',
          'decisions',
          'fast_share',
          'mean_ms',
          'p50_ms',
          'p95_ms',
          'player_id',
          'stddev_ms',
          'timeouts',
        ].sort()
      );
    const text = JSON.stringify(call[1]);
    expect(text).not.toMatch(
      /"(rank|suit|cards?|hole|board|amount|stack|pot|action|is_horse|isHorse)"/i
    );
    expect(Object.keys(call[1]).sort()).toEqual(['p_cluster_id', 'p_now', 'p_signals']);
  });

  it('flags constant, fast timing and correlated pairs; a horse and a human with the same timing look the same', () => {
    const w = new LightningIntegrityWindow();
    const HUMAN = uid(31);
    const HORSE = uid(32);
    const OTHER = uid(33);
    for (let h = 0; h < 10; h++) {
      const hand = uid(800 + h);
      w.handDealt(hand, [HUMAN, HORSE, OTHER]);
      w.decision(hand, HUMAN, 200 + h);
      w.decision(hand, HORSE, 200 + h);
      w.decision(hand, OTHER, 2_000 + ((h * 7919) % 5_000));
      w.handEnded(hand);
    }
    const sig = w.signals();
    const human = sig.players.find((p) => p.player_id === HUMAN)!;
    const horse = sig.players.find((p) => p.player_id === HORSE)!;
    const { player_id: _a, ...hs } = human;
    const { player_id: _b, ...rs } = horse;
    expect(rs).toEqual(hs);
    expect(human.fast_share).toBe(1);
    expect(human.cv!).toBeLessThan(0.05);
    expect(sig.fast_ms).toBe(LIGHTNING_INTEGRITY_FAST_MS);
    const pair = sig.pairs.find(
      (p) => [p.player_a, p.player_b].sort().join() === [HUMAN, HORSE].sort().join()
    )!;
    expect(pair.hands_together).toBe(10);
    expect(pair.latency_corr).toBe(1);
    expect(pair.fast_follows).toBe(10);
  });

  it('the matcher reads nothing the telemetry produces', async () => {
    const dir = new URL('.', import.meta.url);
    const model = readFileSync(new URL('LightningMatcherModel.ts', dir), 'utf8');
    expect(model).not.toMatch(/^import /m); // a pure module: no input but its arguments
    const runner = readFileSync(new URL('LightningShadowRunner.ts', dir), 'utf8');
    // The snapshot builder is the only door into a plan; it reads the pool model, never the integrity window.
    const build = runner.slice(
      runner.indexOf('buildSnapshot('),
      runner.indexOf('private shadowPass(')
    );
    expect(build).not.toMatch(/integrity|latenc/);
    // And in behaviour: the snapshot is identical with and without integrity data fed.
    const mk = (feed: boolean) => {
      const telemetry = new LightningTelemetry();
      const r = new LightningShadowRunner(CLUSTER, {
        rpc: vi.fn(),
        telemetry,
        logger: quiet,
        now: () => new Date(0),
      });
      r.configure(parseLightningShadowConfig(ON));
      if (feed) {
        telemetry.handDealt(CLUSTER, uid(900), POP.slice(0, 4), 0);
        for (const p of POP.slice(0, 4)) telemetry.decision(CLUSTER, uid(900), p, 50, 0);
        telemetry.handEnded(CLUSTER, uid(900), 0);
      }
      return r.buildSnapshot({
        nowMs: 5_000,
        presence: { connected: POP.slice(0, 8), disconnected: POP.slice(8, 9) },
        kind: 'form',
        ok: true,
        matcherVersion: 'm1',
        groups: [],
      });
    };
    expect(mk(true)).toEqual(mk(false));
    // The live writer's arguments never carry anything of the telemetry's.
    const s = scenario(14, ON);
    await drive(s, 40);
    for (const c of s.calls.filter((x) => x.fn === 'fn_lightning_match_and_form'))
      expect(Object.keys(c.args).sort()).toEqual(
        ['p_cluster_id', 'p_disconnected', 'p_max_hands', 'p_now', 'p_request_id'].sort()
      );
  });

  it('no Phase 11 surface reads or filters on is_horse (CLAUDE.md 10.5)', () => {
    for (const f of [
      'LightningMatcherModel.ts',
      'LightningShadowRunner.ts',
      'LightningTelemetry.ts',
      'LightningIntegrity.ts',
      'LightningMatcherSim.ts',
    ]) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/is_horse|isHorse/);
    }
  });
});

// ─── 6. Scoring and config ─────────────────────────────────────────────────

describe('scoring and config', () => {
  it('scores a decision against the snapshot both sides saw', () => {
    const now = 100_000;
    const players = POP.slice(0, 4).map((id, i) => ({
      playerId: id,
      legal: true,
      reasonCode: null,
      idleSinceMs: now - (i + 1) * 1000,
      enteredAtMs: 0,
      lastBbAtMs: null,
      bbUnresolved: false,
      debtSinceMs: 0,
      handsSinceBb: i,
      newcomer: false,
      positions: { btn: i, co: 0, hj: 0, utg: 0 },
    }));
    const score = scoreLightningDecision(
      { nowMs: now, players, recentHands: [{ players: [POP[0], POP[1]], formedAtMs: now - 1000 }] },
      LIGHTNING_MATCHER_PARAM_DEFAULTS,
      [{ players: [POP[3], POP[0], POP[1], POP[2]], bb: POP[3], sb: POP[0], btn: POP[2] }]
    );
    expect(score.seated).toBe(4);
    expect(score.waits.sort((a, b) => a - b)).toEqual([1000, 2000, 3000, 4000]);
    expect(score.bbGaps).toEqual([3]);
    expect(score.bbOrderViolations).toBe(1); // P2 would have chosen POP[0]
    expect(score.btnCounts).toEqual([2]);
    expect(score.pairs).toBe(6);
    expect(score.repeatPairs).toBe(1);
  });

  it('the pool model: a formed player leaves the pool until released, or until a release was surely missed', () => {
    const r = new LightningShadowRunner(CLUSTER, {
      rpc: vi.fn(),
      telemetry: new LightningTelemetry(),
      logger: quiet,
      now: () => new Date(0),
    });
    r.configure(parseLightningShadowConfig(ON));
    const pass = (nowMs: number, groups: Array<{ players: string[]; bb: string }> = []) => ({
      nowMs,
      presence: { connected: POP.slice(0, 4), disconnected: [] },
      kind: 'form' as const,
      ok: true,
      matcherVersion: 'm1',
      groups,
    });
    r.observe(pass(1_000, [{ players: POP.slice(0, 2), bb: POP[0] }]));
    const ids = (nowMs: number) => r.buildSnapshot(pass(nowMs)).players.map((p) => p.playerId);
    expect(ids(2_000)).toEqual(POP.slice(2, 4));
    r.idle(POP[0], 3_000);
    expect(ids(4_000)).toEqual([POP[0], ...POP.slice(2, 4)]);
    expect(ids(1_000 + LIGHTNING_SHADOW_IN_HAND_MAX_MS)).toEqual(POP.slice(0, 4));
  });

  it('parses the Phase 11 keys off by default and clamps them', () => {
    expect(parseLightningConfig({}).shadow).toMatchObject({
      enabled: false,
      integrityEnabled: false,
      version: 'm2',
    });
    const c = parseLightningShadowConfig({
      lightning_shadow_matcher: true,
      shadow_matcher_version: 'm1',
      shadow_window_ms: 5,
      shadow_max_players: 10 ** 9,
    });
    expect(c).toMatchObject({ enabled: true, version: 'm1', windowMs: 60_000, maxPlayers: 5_000 });
  });
});
