/**
 * A/A CALIBRATION STAYS CURRENT IN FORM MODE (2026-10-22).
 *
 * fn_lightning_shadow_report (and so fn_lightning_rollout_readiness) counts
 * only comparisons whose live and shadow metrics carry the Cluster's CURRENT
 * matcher binding, which only the authoritative snapshot of fn_lightning_match
 * provides. A forming worker used to hand the shadow runner its form passes
 * alone, so every form-mode window recorded `snapshot_binding: null` and
 * counted for nothing. These tests drive a real forming worker with the
 * shadow matcher on (m1 against m1-port, the A/A pair) and prove:
 *
 *   - each closed window is recorded with the authoritative binding on both
 *     sides, scored only on the A/A reads (form passes are history only);
 *   - the reads are bounded (one per LIGHTNING_FORM_AA_INTERVAL_MS, one in
 *     flight) and never change a live formation call;
 *   - nothing is read with the comparison off, and a matcher that is not
 *     deployed is asked once per ten minutes while form passes are scored as
 *     before.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the form-mode A/A fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the form-mode A/A fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
const { LIGHTNING_AUTO_REBUY_DEFAULTS, parseLightningShadowConfig } =
  await import('./LightningConfig.js');
const { LightningClusterWorker, LIGHTNING_FORM_AA_INTERVAL_MS } =
  await import('./LightningClusterWorker.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningShadowRunner, LIGHTNING_SHADOW_RPC_RETRY_MS } =
  await import('./LightningShadowRunner.js');
const { lightningMatcherModel } = await import('./LightningMatcherModel.js');

type Config = import('./LightningConfig.js').LightningConfig;
type Call = { fn: string; args: Record<string, unknown> };

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLUSTER = uid(1);
const POP = Array.from({ length: 10 }, (_, i) => uid(100 + i));
const BINDING = 'c'.repeat(32);
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOT_FOUND = { code: 'PGRST202', message: 'Could not find the function in the schema cache' };
const ON = {
  lightning_shadow_matcher: true,
  shadow_matcher_version: 'm1-port',
  shadow_window_ms: 60_000,
  instance_min: 2,
  instance_target: 6,
  instance_max: 6,
};

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

function scenario(shadowCfg: Record<string, unknown> | null, opts: { aaMissing?: boolean } = {}) {
  const calls: Call[] = [];
  let t = Date.UTC(2026, 9, 22, 12, 0, 0);
  let handNo = 0;
  const busy = new Set<string>();
  const params = parseLightningShadowConfig(ON).params;
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
    if (fn === 'fn_lightning_match_and_form') {
      // The writer: free everyone from the last pass, form one hand of four.
      busy.clear();
      const players = POP.slice((handNo % 2) * 4, (handNo % 2) * 4 + 4);
      players.forEach((p) => busy.add(p));
      handNo++;
      return {
        data: {
          ok: true,
          formed: 1,
          hands: [
            {
              hand_id: uid(5000 + handNo),
              instance_id: uid(7000 + handNo),
              bb: players[0],
              sb: players[1],
              btn: players[3],
              players,
            },
          ],
          matcher_version: 'm1',
          legal_count: POP.length,
          stopped_reason: 'plan_exhausted',
        },
        error: null,
      };
    }
    if (fn === 'fn_lightning_match') {
      if (opts.aaMissing) return { data: null, error: NOT_FOUND };
      // The read-only matcher: the live plan AND the snapshot it planned on.
      const nowMs = Date.parse(args.p_now as string);
      const snapshot = {
        nowMs,
        epoch: 3,
        recentHands: [],
        players: POP.map((playerId, i) => ({
          playerId,
          legal: !busy.has(playerId),
          reasonCode: busy.has(playerId) ? 'IN_HAND' : null,
          idleSinceMs: nowMs - 30_000 - i * 100,
          enteredAtMs: nowMs - 60_000,
          joinedAtMs: nowMs - 60_000,
          slotOpenedAtMs: nowMs - 60_000,
          lastBbAtMs: null,
          bbUnresolved: false,
          debtSinceMs: nowMs - 60_000,
          handsSinceBb: null,
          newcomer: false,
          positions: { btn: 0, co: 0, hj: 0, utg: 0 },
        })),
      };
      const plan = lightningMatcherModel('m1')!.plan(snapshot, params);
      const grouped = new Set(plan.groups.flatMap((g) => g.players));
      return {
        data: {
          matcher_version: 'm1',
          generated_at: new Date(nowMs).toISOString(),
          legal_count: snapshot.players.filter((p) => p.legal).length,
          groups: plan.groups.map((g) => ({ players: g.players, bb: g.bb })),
          diagnosis: snapshot.players.map((p) => ({
            player_id: p.playerId,
            state: grouped.has(p.playerId)
              ? 'MATCHED'
              : p.legal
                ? 'WAITING_FOR_FORMATION'
                : 'BLOCKED_WITH_REASON',
            reason_code: p.reasonCode,
          })),
          pool_diversity_score: 1,
          shadow_snapshot: { binding: BINDING, snapshot },
        },
        error: null,
      };
    }
    if (fn === 'fn_lightning_shadow_record') return { data: { ok: true }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
  const presence = new LightningPresence(() => [
    {
      tableId: uid(9001),
      clusterId: CLUSTER,
      players: POP.map((userId) => ({ userId, presence: 'connected' as const })),
    },
  ]);
  const now = () => new Date(t);
  const runner = new LightningShadowRunner(CLUSTER, { rpc, logger: quiet, now, clock: () => 0 });
  const worker = new LightningClusterWorker(CLUSTER, config(shadowCfg), {
    rpc,
    presence,
    logger: quiet,
    now,
    startHand: () => undefined,
    hasInstance: () => false,
    shadow: runner,
  });
  const drive = async (passes: number, stepMs = 2_000) => {
    for (let i = 0; i < passes; i++) {
      await worker.pass();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      t += stepMs;
    }
    await runner.settled();
  };
  return { calls, worker, runner, drive };
}

const records = (calls: Call[]) => calls.filter((c) => c.fn === 'fn_lightning_shadow_record');
const liveCalls = (calls: Call[]) =>
  calls
    .filter((c) => c.fn === 'fn_lightning_match_and_form')
    .map(({ args: { p_request_id: _id, ...rest } }) => rest);

describe('form-mode A/A calibration carries the authoritative matcher binding', () => {
  it('records every closed window under the binding, m1 against m1-port, scored on the A/A reads', async () => {
    const s = scenario(ON);
    await s.drive(150); // 300 s, a pass every 2 s
    const recs = records(s.calls);
    expect(recs).toHaveLength(4); // 12:00 .. 12:04 closed, 12:04 open
    // The first window holds the pass that ran before the first read
    // answered, so it mixes evidence and records no binding (never counted).
    expect((recs[0].args.p_live as Record<string, any>).snapshot_binding).toBeNull();
    for (const r of recs.slice(1)) {
      const live = r.args.p_live as Record<string, any>;
      const shadow = r.args.p_shadow as Record<string, any>;
      expect(r.args.p_live_version).toBe('m1');
      expect(r.args.p_shadow_version).toBe('m1-port');
      expect(live.snapshot_binding).toBe(BINDING);
      expect(shadow.snapshot_binding).toBe(BINDING);
      // A pass every 2 s, an A/A read at most every 5 s: every third pass,
      // 10 per minute. The 30 form passes are history only.
      expect(live.passes).toBe(10);
      expect(shadow.passes).toBe(live.passes);
      expect(live.seated).toBeGreaterThan(0);
      expect(shadow.seated).toBeGreaterThan(0);
      // A/A: the port plans exactly what the live matcher planned.
      expect(shadow.groups).toBe(live.groups);
      expect(shadow.seated).toBe(live.seated);
    }
    await s.worker.stop();
  });

  it('reads at most once per interval, read-only, with the live matcher version and pass inputs', async () => {
    const s = scenario(ON);
    await s.drive(30);
    const reads = s.calls.filter((c) => c.fn === 'fn_lightning_match');
    expect(reads).toHaveLength(10);
    const at = reads.map((r) => Date.parse(r.args.p_now as string));
    for (let i = 1; i < at.length; i++)
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(LIGHTNING_FORM_AA_INTERVAL_MS);
    for (const r of reads) {
      expect(r.args.p_cluster_id).toBe(CLUSTER);
      expect(r.args.p_matcher_version).toBe('m1');
      expect(r.args.p_disconnected).toEqual([]);
    }
    for (const c of s.calls)
      expect([
        'fn_lightning_match_and_form',
        'fn_lightning_match',
        'fn_lightning_shadow_record',
      ]).toContain(c.fn);
    await s.worker.stop();
  });

  it('never changes a live formation: the same live calls with the A/A reads on or off', async () => {
    const off = scenario(null);
    const on = scenario(ON);
    await off.drive(60);
    await on.drive(60);
    expect(liveCalls(on.calls)).toEqual(liveCalls(off.calls));
    expect(off.calls.every((c) => c.fn === 'fn_lightning_match_and_form')).toBe(true);
    await off.worker.stop();
    await on.worker.stop();
  });

  it('with the comparison off (integrity telemetry only) nothing is read', async () => {
    const s = scenario({ lightning_shadow_matcher: false, integrity_telemetry: true });
    await s.drive(60);
    expect(s.calls.some((c) => c.fn === 'fn_lightning_match')).toBe(false);
    await s.worker.stop();
  });

  it('a matcher that is not deployed is asked once per ten minutes, and form passes are scored as before', async () => {
    const s = scenario(ON, { aaMissing: true });
    await s.drive(Math.floor(LIGHTNING_SHADOW_RPC_RETRY_MS / 2_000) - 1);
    expect(s.calls.filter((c) => c.fn === 'fn_lightning_match')).toHaveLength(1);
    const recs = records(s.calls);
    expect(recs.length).toBeGreaterThan(0);
    // Every form pass is scored, as before the fix, with no binding.
    const live = recs[0].args.p_live as Record<string, any>;
    expect(live.passes).toBe(30);
    expect(live.snapshot_binding).toBeNull();
    await s.drive(2);
    expect(s.calls.filter((c) => c.fn === 'fn_lightning_match')).toHaveLength(2);
    await s.worker.stop();
  });
});
