/**
 * LIGHTNING PHASE 11 REMEDIATION (engine), 2026-10-09: the review findings
 * on the engine side, each pinned.
 *
 *   3  The shadow comparison is not biased toward either side: a failed live
 *      call scores neither side; order_violations is null on both; `m1-port`
 *      is registered and an A/A record (live m1, shadow m1-port) is sent.
 *   4  The m1 port is the SQL plan: per-group microsecond BB stamps (shadow
 *      model and simulator), the Cluster join in the queue, the slot's
 *      opening apart from the pool entry in P2, the window's hand_id
 *      tie-break and epoch filter, P5's band from the database's legal count.
 *      (scripts/dev/test-lightning-matcher-parity.sh proves the whole plan
 *      against the real fn_lightning_match_plan.)
 *   8c Every *_to_next_hand leg starts at the fold REQUEST.
 *   9  stop() awaits the flush in flight before closing the final window.
 *   11 The size cap reads the presence before any snapshot is built, and a
 *      skipped pass is not scored on the live side.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 11 remediation fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 11 remediation fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
const { parseLightningShadowConfig } = await import('./LightningConfig.js');
const { LightningTelemetry } = await import('./LightningTelemetry.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { LightningShadowRunner, lightningGroupStampMs } = await import('./LightningShadowRunner.js');
const {
  LIGHTNING_MATCHER_MODELS,
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  compareBlindOrder,
  compareQueueOrder,
  lightningMatcherModel,
  recentWindow,
} = await import('./LightningMatcherModel.js');
const { runLightningMatcherSim } = await import('./LightningMatcherSim.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { buildHost, flush, formedHand, uid } = kit;

type Player = import('./LightningMatcherModel.js').LightningPoolPlayer;
type Obs = import('./LightningShadowRunner.js').LightningLivePassObservation;

const CLUSTER = uid(1);
const POP = Array.from({ length: 12 }, (_, i) => uid(300 + i));
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const ON = { lightning_shadow_matcher: true, shadow_window_ms: 60_000 };

const player = (id: string, over: Partial<Player> = {}): Player => ({
  playerId: id,
  legal: true,
  reasonCode: null,
  idleSinceMs: 1_000,
  enteredAtMs: 1_000,
  lastBbAtMs: null,
  bbUnresolved: false,
  debtSinceMs: 1_000,
  handsSinceBb: null,
  newcomer: false,
  positions: { btn: 0, co: 0, hj: 0, utg: 0 },
  ...over,
});

function runner(
  rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
    data: { ok: true },
    error: null,
  })),
  cfg: Record<string, unknown> = ON,
  t = { now: Date.UTC(2026, 9, 9, 12, 0, 0) }
) {
  const r = new LightningShadowRunner(CLUSTER, {
    rpc,
    telemetry: new LightningTelemetry(),
    logger: quiet,
    now: () => new Date(t.now),
    clock: () => 0,
  });
  r.configure(parseLightningShadowConfig(cfg));
  return { r, rpc, t };
}

const pass = (nowMs: number, over: Partial<Obs> = {}): Obs => ({
  nowMs,
  presence: { connected: POP.slice(0, 8), disconnected: [] },
  kind: 'form',
  ok: true,
  matcherVersion: 'm1',
  groups: [],
  ...over,
});

const records = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_shadow_record').map((c) => c[1] as any);

// ─── Finding 4: the port is the SQL plan ────────────────────────────────────

describe('finding 4: the m1 port reads the keys the SQL plan reads', () => {
  it('P4 breaks an idle_since and pool-entry tie on the Cluster join (NULLS LAST), then player_id', () => {
    const a = player(POP[0], { joinedAtMs: 900 });
    const b = player(POP[1], { joinedAtMs: 800 });
    const c = player(POP[2], { joinedAtMs: null });
    const d = player(POP[3]);
    expect([a, b, c, d].sort(compareQueueOrder).map((p) => p.playerId)).toEqual([
      POP[1],
      POP[0],
      POP[2],
      POP[3],
    ]);
  });

  it("P2's fourth key is the slot's opening, not the pool entry", () => {
    const a = player(POP[0], { enteredAtMs: 100, slotOpenedAtMs: 500 });
    const b = player(POP[1], { enteredAtMs: 200, slotOpenedAtMs: 400 });
    expect([a, b].sort(compareBlindOrder).map((p) => p.playerId)).toEqual([POP[1], POP[0]]);
    // Without a slot time, the pool entry stands in (the model never saw them apart).
    const c = player(POP[2], { enteredAtMs: 100 });
    const d = player(POP[3], { enteredAtMs: 200 });
    expect([d, c].sort(compareBlindOrder).map((p) => p.playerId)).toEqual([POP[2], POP[3]]);
  });

  it("P5's window: hands at one instant in hand_id order, and only the current epoch", () => {
    const hands = [
      { players: [POP[0], POP[1]], formedAtMs: 5_000, handId: uid(9), epoch: 2 },
      { players: [POP[2], POP[3]], formedAtMs: 5_000, handId: uid(8), epoch: 2 },
      { players: [POP[4], POP[5]], formedAtMs: 6_000, handId: uid(7), epoch: 1 },
    ];
    const params = { ...LIGHTNING_MATCHER_PARAM_DEFAULTS, recentWindowHands: 1 };
    const w = recentWindow({ nowMs: 10_000, players: [], recentHands: hands, epoch: 2 }, params);
    expect(w.map((h) => h.handId)).toEqual([uid(8)]);
    const all = recentWindow(
      { nowMs: 10_000, players: [], recentHands: hands, epoch: 2 },
      { ...params, recentWindowHands: 60 }
    );
    expect(all.map((h) => h.handId)).toEqual([uid(8), uid(9)]);
  });

  it("P5's band reads the database's legal count when the snapshot carries it", () => {
    // Twelve legal players, two groups of six; p4 met the first big blind
    // in the window. In the tiny band (12) P5 is off and p4 sits with p0; at
    // the database's legal count of 60 (large) P5 moves p4 to the other group.
    const players = POP.map((id) => player(id));
    const recentHands = [{ players: [POP[0], POP[4]], formedAtMs: 500 }];
    const params = { ...LIGHTNING_MATCHER_PARAM_DEFAULTS, instanceMax: 6, instanceTarget: 6 };
    const m1 = lightningMatcherModel('m1')!;
    const tiny = m1.plan({ nowMs: 1_000, players, recentHands }, params);
    const large = m1.plan({ nowMs: 1_000, players, recentHands, legalCount: 60 }, params);
    const groupOf = (plan: typeof tiny, id: string) =>
      plan.groups.findIndex((g) => g.players.includes(id));
    expect(groupOf(tiny, POP[4])).toBe(groupOf(tiny, POP[0]));
    expect(groupOf(large, POP[4])).not.toBe(groupOf(large, POP[0]));
    expect(large.legalCount).toBe(12);
  });

  it('the shadow model stamps each group of a pass its own microsecond, heads-up button included', () => {
    const { r } = runner();
    const now = Date.UTC(2026, 9, 9, 12, 0, 1);
    const groups = [
      { players: POP.slice(0, 3), bb: POP[0], sb: POP[1], btn: POP[2], handId: uid(51) },
      { players: POP.slice(3, 5), bb: POP[3], sb: POP[4], btn: POP[4], handId: uid(52) },
      { players: POP.slice(5, 8), bb: POP[5], sb: POP[6], btn: POP[7], handId: uid(53) },
    ];
    r.observe(pass(now, { groups, epoch: 4 }));
    for (const g of groups) r.idle(g.bb, now + 10_000);
    r.idle(POP[4], now + 10_000);
    const snap = r.buildSnapshot(pass(now + 20_000, { epoch: 4 }));
    const by = new Map(snap.players.map((p) => [p.playerId, p]));
    expect(by.get(POP[0])!.lastBbAtMs).toBe(lightningGroupStampMs(now, 0));
    expect(by.get(POP[3])!.lastBbAtMs).toBe(lightningGroupStampMs(now, 1));
    expect(by.get(POP[5])!.lastBbAtMs).toBe(lightningGroupStampMs(now, 2));
    expect(lightningGroupStampMs(now, 1)).toBeGreaterThan(now);
    expect(lightningGroupStampMs(now, 2)).toBeGreaterThan(lightningGroupStampMs(now, 1));
    // Heads-up, the small blind is the button (the barrier's own position name).
    expect(by.get(POP[4])!.positions.btn).toBe(1);
    expect(snap.recentHands.map((h) => [h.handId, h.epoch, h.formedAtMs])).toEqual([
      [uid(51), 4, lightningGroupStampMs(now, 0)],
      [uid(52), 4, lightningGroupStampMs(now, 1)],
      [uid(53), 4, lightningGroupStampMs(now, 2)],
    ]);
    expect(snap.epoch).toBe(4);
  });

  it("worker 'shadow' mode: the diagnosis is the snapshot's legality", () => {
    const { r } = runner();
    const legality = new Map<string, string | null>([
      [POP[0], null],
      [POP[1], 'SITTING_OUT'],
    ]);
    const snap = r.buildSnapshot(
      pass(1_000, {
        kind: 'match',
        legality,
        presence: { connected: POP.slice(0, 3), disconnected: [] },
      })
    );
    expect(snap.players.map((p) => [p.legal, p.reasonCode])).toEqual([
      [true, null],
      [false, 'SITTING_OUT'],
      [false, 'NOT_IN_POOL'],
    ]);
  });

  it('the simulator stamps its groups the same way and stays deterministic', () => {
    const a = runLightningMatcherSim({ players: 30, hands: 400, seed: 3 });
    const b = runLightningMatcherSim({ players: 30, hands: 400, seed: 3 });
    expect(a).toEqual(b);
    expect(a.hands).toBe(400);
  });
});

// ─── Finding 3: an unbiased comparison ─────────────────────────────────────

describe('finding 3: the comparison is biased toward neither side', () => {
  it('registers m1-port: the same plan as m1, under its own name', () => {
    expect([...LIGHTNING_MATCHER_MODELS.keys()]).toEqual(['m1', 'm1-port', 'm2']);
    const players = POP.map((id, i) => player(id, { idleSinceMs: 1_000 - i, joinedAtMs: i }));
    const snap = { nowMs: 2_000, players, recentHands: [] };
    const a = lightningMatcherModel('m1')!.plan(snap, LIGHTNING_MATCHER_PARAM_DEFAULTS);
    const b = lightningMatcherModel('m1-port')!.plan(snap, LIGHTNING_MATCHER_PARAM_DEFAULTS);
    expect(b.matcherVersion).toBe('m1-port');
    expect(b.groups).toEqual(a.groups);
  });

  it('an A/A calibration is recorded: live m1 against shadow m1-port', async () => {
    const { r, rpc } = runner(undefined, { ...ON, shadow_matcher_version: 'm1-port' });
    const t0 = Date.UTC(2026, 9, 9, 12, 0, 0);
    for (let i = 0; i < 5; i++) r.observe(pass(t0 + i * 2_000));
    r.observe(pass(t0 + 61_000));
    await r.settled();
    const [rec] = records(rpc);
    expect(rec.p_live_version).toBe('m1');
    expect(rec.p_shadow_version).toBe('m1-port');
    expect(rec.p_live.passes).toBe(5);
    expect(rec.p_shadow.passes).toBe(5);
  });

  it('a failed live call scores neither side; order_violations is null on both', async () => {
    const { r, rpc } = runner();
    const t0 = Date.UTC(2026, 9, 9, 12, 0, 0);
    const m2 = LIGHTNING_MATCHER_MODELS.get('m2')!;
    const spy = vi.spyOn(m2, 'plan');
    try {
      r.observe(pass(t0, { ok: false, matcherVersion: null }));
      r.observe(pass(t0 + 2_000, { ok: false, matcherVersion: null }));
      expect(spy).not.toHaveBeenCalled(); // the shadow does not plan through an outage
      r.observe(pass(t0 + 4_000));
      r.observe(pass(t0 + 61_000));
      await r.settled();
    } finally {
      spy.mockRestore();
    }
    const [rec] = records(rpc);
    expect(rec.p_live.passes).toBe(1);
    expect(rec.p_shadow.passes).toBe(1);
    expect(rec.p_live.failed_passes).toBe(0);
    expect(rec.p_shadow.skipped.live_failed).toBe(2);
    expect(rec.p_live.bb_fairness.order_violations).toBeNull();
    expect(rec.p_shadow.bb_fairness.order_violations).toBeNull();
  });
});

// ─── Finding 11: the CPU bound costs nothing ───────────────────────────────

describe('finding 11: an oversized or skipped pass builds nothing and scores neither side', () => {
  it('the size cap reads the presence before any snapshot is built', async () => {
    const { r, rpc } = runner(undefined, { ...ON, shadow_max_players: 5 });
    const build = vi.spyOn(r, 'buildSnapshot');
    const t0 = Date.UTC(2026, 9, 9, 12, 0, 0);
    for (let i = 0; i < 4; i++) r.observe(pass(t0 + i * 2_000));
    expect(build).not.toHaveBeenCalled();
    r.observe(pass(t0 + 61_000, { presence: { connected: POP.slice(0, 2), disconnected: [] } }));
    await r.settled();
    const [rec] = records(rpc);
    expect(rec.p_shadow.skipped.size_cap).toBe(4);
    expect(rec.p_live.passes).toBe(0);
    expect(rec.p_shadow.passes).toBe(0);
  });
});

// ─── Finding 9: the final window survives a stop ───────────────────────────

describe('finding 9: stop awaits the flush in flight, then flushes the final window', () => {
  it('two windows, the first still flushing at stop: both are recorded', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    let n = 0;
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
      if (n++ === 0) await gate;
      return { data: { ok: true }, error: null };
    });
    const t = { now: Date.UTC(2026, 9, 9, 12, 0, 0) };
    const { r } = runner(rpc, ON, t);
    r.observe(pass(t.now));
    t.now += 61_000;
    r.observe(pass(t.now)); // closes window 1: its flush hangs on the gate
    t.now += 2_000;
    r.observe(pass(t.now));
    const stopped = r.stop();
    release();
    await stopped;
    const recs = records(rpc);
    expect(recs).toHaveLength(2);
    expect(recs[1].p_window_from).toBe(new Date(Date.UTC(2026, 9, 9, 12, 1, 0)).toISOString());
  });
});

// ─── Finding 8 (c): the fold legs start at the fold request ─────────────────

describe('finding 8c: every *_to_next_hand leg starts at the fold request', () => {
  it('the metrics measure from the fold, not from the idle after the acknowledgement', () => {
    const m = new LightningMetrics(new MetricsRegistry());
    const seen = vi.spyOn(m, 'observeLatency');
    m.noteIdle(POP[0], 1_250, 'fast', CLUSTER, 1_000);
    m.noteIdle(POP[1], 5_000, 'fold_watch', CLUSTER, 2_000);
    m.noteIdle(POP[2], 1_300, 'normal', CLUSTER);
    m.noteDealt([POP[0], POP[1], POP[2]], 6_000, CLUSTER);
    expect(seen).toHaveBeenCalledWith('fast_fold_to_next_hand', 5_000, CLUSTER);
    expect(seen).toHaveBeenCalledWith('fold_watch_to_next_hand', 4_000, CLUSTER);
    expect(seen).toHaveBeenCalledWith('normal_fold_to_next_hand', 4_700, CLUSTER);
  });

  it('a LIGHTNING FOLD whose acknowledgement takes 250 ms is timed from the request', async () => {
    let clock = 1_000_000;
    const formed = formedHand(4, 3100);
    const t = buildHost(formed, [200, 200, 200, 200], { deps: { now: () => clock } });
    await t.host.start();
    await flush();
    vi.mocked(t.backend.fastFold).mockImplementation(async () => {
      clock += 250;
      return { ok: true as const, value: null };
    });
    const seen = vi.spyOn(t.metrics, 'observeLatency');
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const waiting = st.players.find(
      (p) => p.user_id !== current.user_id && st.currentBet - p.bet > 0 && !p.is_folded
    )!;
    const requestedAt = clock;
    expect(t.host.handlePlayerAction(waiting.user_id, 'fast_fold').success).toBe(true);
    await flush();
    expect(clock).toBe(requestedAt + 250);
    clock += 400;
    t.metrics.noteDealt([waiting.user_id], clock, formed.clusterId);
    expect(seen).toHaveBeenCalledWith('ack_to_idle_pool', 250, formed.clusterId);
    expect(seen).toHaveBeenCalledWith('fast_fold_to_next_hand', 650, formed.clusterId);
  });
});

// ─── Finding 7 (engine side): every window's evidence reaches the database ──

describe('finding 7: a pair that shared one hand in the window is reported', () => {
  it('the database aggregates windows over 24 hours, so no per-window floor hides a pair', async () => {
    const { LightningIntegrityWindow } = await import('./LightningIntegrity.js');
    const w = new LightningIntegrityWindow();
    const hand = uid(8801);
    w.handDealt(hand, [POP[0], POP[1], POP[2]]);
    w.decision(hand, POP[0], 700);
    w.decision(hand, POP[1], 400);
    w.handEnded(hand);
    const sig = w.signals();
    expect(sig.pairs.map((p) => [p.player_a, p.player_b, p.hands_together])).toEqual([
      [POP[0], POP[1], 1],
      [POP[0], POP[2], 1],
      [POP[1], POP[2], 1],
    ]);
    // One shared decision is no correlation: that stays null below three.
    for (const p of sig.pairs) expect(p.latency_corr).toBeNull();
  });
});
