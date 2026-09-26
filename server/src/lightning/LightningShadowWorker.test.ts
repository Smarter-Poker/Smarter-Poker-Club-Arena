/**
 * THE DARK LIGHTNING WORKER (2026-09-25): config, RPC doors, presence feed,
 * the per-Cluster worker and the leader-only supervisor, all over a mocked
 * database and fake timers. Nothing here reaches a real client.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../observability/Metrics.js';
import {
  LIGHTNING_CONFIG_DEFAULTS,
  LIGHTNING_DISCOVERY_INTERVAL_MS,
  LIGHTNING_PASS_INTERVAL_MAX_MS,
  LIGHTNING_PASS_INTERVAL_MIN_MS,
  parseLightningConfig,
  type LightningConfig,
} from './LightningConfig.js';
import {
  lightningConfig,
  lightningMatch,
  lightningMatchAndForm,
  summarizeLightningMatch,
  validateLightningMatchResult,
  type LightningRpcClient,
} from './LightningRpc.js';
import {
  LightningPresence,
  presenceFromFsm,
  type PresenceTableReport,
} from './LightningPresence.js';
import { LightningClusterWorker, type LightningWorkerLogger } from './LightningClusterWorker.js';
import { LightningMetrics } from './LightningMetrics.js';
import { LightningSupervisor } from './LightningSupervisor.js';
import { RateLimitedLog } from './RateLimitedLog.js';
import { isLightningHandInProgress, isMissingFunctionError } from './rpcErrors.js';

const CLUSTER_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const CLUSTER_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const P3 = '11111111-0000-4000-8000-000000000003';
const P4 = '11111111-0000-4000-8000-000000000004';

const NOT_FOUND = {
  code: 'PGRST202',
  message: 'Could not find the function public.fn_lightning_match in the schema cache',
};

const shadow: LightningConfig = {
  matcherVersion: 'm-2026-09-25',
  workerMode: 'shadow',
  passIntervalMs: 2_000,
  keepaliveIntervalMs: 30_000,
};

function matchReply() {
  return {
    matcher_version: 'm-2026-09-25',
    groups: [{ players: [P1, P2], bb: P2, keys: { stakes: '1/2' } }],
    diagnosis: [
      { player_id: P1, state: 'MATCHED', reason_code: null },
      { player_id: P2, state: 'MATCHED', reason_code: null },
      { player_id: P3, state: 'WAITING_FOR_RECONNECT', reason_code: 'disconnected' },
      { player_id: P4, state: 'BLOCKED_WITH_REASON', reason_code: 'recent_opponent' },
    ],
    pool_diversity_score: 0.5,
    legal_count: 3,
    generated_at: '2026-09-25T20:00:00.000Z',
  };
}

const quiet = (): LightningWorkerLogger & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
  };
};

function rpcWith(
  impl: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }
) {
  return vi.fn(async (fn: string, args: Record<string, unknown>) => impl(fn, args)) as ReturnType<
    typeof vi.fn
  > &
    LightningRpcClient;
}

const noPresence = new LightningPresence(() => []);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LightningConfig', () => {
  it('fails closed: nothing readable is off', () => {
    for (const raw of [null, undefined, 'x', 7, [], {}]) {
      expect(parseLightningConfig(raw).workerMode).toBe('off');
    }
    expect(parseLightningConfig({ worker_mode: 'turbo' }).workerMode).toBe('off');
    expect(parseLightningConfig(null)).toEqual(LIGHTNING_CONFIG_DEFAULTS);
  });

  it('reads the contract keys and clamps every number', () => {
    expect(
      parseLightningConfig({
        matcher_version: ' v3 ',
        worker_mode: 'SHADOW',
        pass_interval_ms: '1500',
        keepalive_interval_ms: 45_000,
      })
    ).toEqual({
      matcherVersion: 'v3',
      workerMode: 'shadow',
      passIntervalMs: 1500,
      keepaliveIntervalMs: 45_000,
    });
    expect(parseLightningConfig({ worker_mode: 'form', pass_interval_ms: 0 }).passIntervalMs).toBe(
      LIGHTNING_PASS_INTERVAL_MIN_MS
    );
    expect(parseLightningConfig({ pass_interval_ms: 10 ** 9 }).passIntervalMs).toBe(
      LIGHTNING_PASS_INTERVAL_MAX_MS
    );
    expect(parseLightningConfig({ pass_interval_ms: 'soon' }).passIntervalMs).toBe(
      LIGHTNING_CONFIG_DEFAULTS.passIntervalMs
    );
  });
});

describe('error classification', () => {
  it('names a missing function and a Lightning refusal, and nothing else', () => {
    expect(isMissingFunctionError(NOT_FOUND)).toBe(true);
    expect(isMissingFunctionError({ code: '42883', message: 'function x does not exist' })).toBe(
      true
    );
    expect(isMissingFunctionError({ code: '57014', message: 'statement timeout' })).toBe(false);
    expect(isLightningHandInProgress({ message: 'LIGHTNING_HAND_IN_PROGRESS: seat 3' })).toBe(true);
    expect(isLightningHandInProgress({ message: 'LEAVE_LOCKED:1200' })).toBe(false);
    expect(isLightningHandInProgress(null)).toBe(false);
  });

  it('RateLimitedLog admits once per interval per key and stays bounded', () => {
    const log = new RateLimitedLog(1_000, 3);
    expect(log.shouldLog('a', 0)).toBe(true);
    expect(log.shouldLog('a', 500)).toBe(false);
    expect(log.shouldLog('a', 1_000)).toBe(true);
    for (const k of ['b', 'c', 'd', 'e']) log.shouldLog(k, 2_000);
    expect(log.size).toBe(3);
  });
});

describe('LightningRpc', () => {
  it('validates the match contract and summarises it', async () => {
    const rpc = rpcWith(() => ({ data: matchReply(), error: null }));
    const out = await lightningMatch(rpc, {
      clusterId: CLUSTER_A,
      now: new Date('2026-09-25T20:00:00Z'),
      disconnected: [P3, P3, 'not-a-uuid'],
      matcherVersion: 'm-2026-09-25',
    });
    expect(out.status).toBe('ok');
    expect(rpc).toHaveBeenCalledWith('fn_lightning_match', {
      p_cluster_id: CLUSTER_A,
      p_now: '2026-09-25T20:00:00.000Z',
      p_disconnected: [P3],
      p_matcher_version: 'm-2026-09-25',
    });
    if (out.status !== 'ok') throw new Error('unreachable');
    const s = summarizeLightningMatch(out.value);
    expect(s.byState.MATCHED).toBe(2);
    expect(s.byState.WAITING_FOR_RECONNECT).toBe(1);
    expect(s.byReason).toEqual({ disconnected: 1, recent_opponent: 1 });
    expect(s.groups).toBe(1);
  });

  it('refuses an answer outside the contract', () => {
    const bad = (mut: (r: any) => void) => {
      const r: any = matchReply();
      mut(r);
      return validateLightningMatchResult(r);
    };
    expect(bad((r) => (r.groups[0].bb = P3)).ok).toBe(false); // bb outside the group
    expect(bad((r) => (r.diagnosis[0].state = 'DEALT')).ok).toBe(false);
    expect(bad((r) => (r.diagnosis[2].state = 'MATCHED')).ok).toBe(false); // matched, no group
    expect(bad((r) => (r.legal_count = -1)).ok).toBe(false);
    expect(bad((r) => r.groups.push({ players: [P1, P3], bb: P3, keys: {} })).ok).toBe(false);
    expect(validateLightningMatchResult('nope').ok).toBe(false);
  });

  it('a function that is not deployed is "unavailable", from an error or a throw', async () => {
    const answered = rpcWith(() => ({ data: null, error: NOT_FOUND }));
    expect((await lightningConfig(answered, CLUSTER_A)).status).toBe('unavailable');
    const thrown = vi.fn(async () => {
      throw NOT_FOUND;
    }) as unknown as LightningRpcClient;
    expect(
      (
        await lightningMatch(thrown, {
          clusterId: CLUSTER_A,
          now: new Date(),
          disconnected: [],
          matcherVersion: null,
        })
      ).status
    ).toBe('unavailable');
    const broken = rpcWith(() => ({ data: null, error: { message: 'boom' } }));
    expect((await lightningConfig(broken, CLUSTER_A)).status).toBe('error');
  });

  it('the writer door validates its arguments and is typed, but nothing here calls it', async () => {
    const rpc = rpcWith(() => ({ data: { formed: 0 }, error: null }));
    expect(
      (
        await lightningMatchAndForm(rpc, {
          clusterId: CLUSTER_A,
          now: new Date(),
          disconnected: [],
          maxHands: 0,
          requestId: P1,
        })
      ).status
    ).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('LightningPresence', () => {
  const reports: PresenceTableReport[] = [
    {
      tableId: 't1',
      clusterId: CLUSTER_A,
      players: [
        { userId: P1, presence: 'connected' },
        { userId: P2, presence: 'disconnected' },
        { userId: P3, presence: 'unknown' },
      ],
    },
    {
      tableId: 't2',
      clusterId: CLUSTER_A,
      // P2 seen live at a second anchor: a live socket anywhere wins.
      players: [{ userId: P2, presence: 'connected' }],
    },
    { tableId: 't3', clusterId: CLUSTER_B, players: [{ userId: P4, presence: 'disconnected' }] },
  ];

  it('feeds disconnected AND unknown players, never failing open', () => {
    const snap = new LightningPresence(() => reports).snapshot(CLUSTER_A, [P4]);
    expect(snap.connected).toEqual([P1, P2]);
    // P3 has no presence entry; P4 is a pool member nobody here observes.
    expect(snap.unknown).toEqual([P3, P4]);
    expect(snap.pDisconnected).toEqual([P3, P4]);
    expect(snap.anchorTables).toBe(2);
  });

  it('a definite disconnect is reported as one', () => {
    const snap = new LightningPresence(() => [reports[0]]).snapshot(CLUSTER_A);
    expect(snap.disconnected).toEqual([P2]);
    expect(snap.pDisconnected).toEqual([P2, P3]);
  });

  it('maps the DisconnectEngine FSM, and a missing entry is unknown', () => {
    expect(presenceFromFsm('CONNECTED', true)).toBe('connected');
    expect(presenceFromFsm('MISSING', false)).toBe('disconnected');
    expect(presenceFromFsm('DISCONNECTED', false)).toBe('disconnected');
    expect(presenceFromFsm('SAT_OUT', true)).toBe('connected');
    expect(presenceFromFsm('SAT_OUT', false)).toBe('disconnected');
    expect(presenceFromFsm(null, true)).toBe('unknown');
  });
});

describe('LightningClusterWorker', () => {
  function worker(config: LightningConfig, rpc: LightningRpcClient, presence = noPresence) {
    const logger = quiet();
    const metrics = new LightningMetrics(new MetricsRegistry());
    const w = new LightningClusterWorker(CLUSTER_A, config, { rpc, presence, metrics, logger });
    return { w, logger, metrics };
  }

  it('makes exactly one match RPC per pass, and feeds it the presence list', async () => {
    const rpc = rpcWith(() => ({ data: matchReply(), error: null }));
    const presence = new LightningPresence(() => [
      {
        tableId: 't1',
        clusterId: CLUSTER_A,
        players: [
          { userId: P1, presence: 'connected' },
          { userId: P3, presence: 'disconnected' },
        ],
      },
    ]);
    const { w, metrics } = worker(shadow, rpc, presence);
    const first = await w.pass();
    expect(first.outcome).toBe('matched');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('fn_lightning_match');
    expect(rpc.mock.calls[0][1].p_disconnected).toEqual([P3]);
    // The second pass knows the pool from the first diagnosis: P2 and P4 are
    // named by the matcher but observed nowhere here, so they are withheld.
    await w.pass();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1].p_disconnected).toEqual([P2, P3, P4]);
    expect(metrics.passesTotal.get({ outcome: 'matched' })).toBe(2);
    expect(metrics.diagnosisPlayers.get({ state: 'MATCHED' })).toBe(2);
  });

  it("refuses 'form': no RPC at all, and it says why", async () => {
    const rpc = rpcWith(() => ({ data: matchReply(), error: null }));
    const { w, logger } = worker({ ...shadow, workerMode: 'form' }, rpc);
    const out = await w.pass();
    await w.pass();
    expect(out).toEqual({ outcome: 'refused_form', reason: 'dealing_host_not_available' });
    expect(rpc).not.toHaveBeenCalled();
    expect(logger.lines.filter((l) => /REFUSED/.test(l))).toHaveLength(1); // rate-limited
  });

  it("'off' does nothing", async () => {
    const rpc = rpcWith(() => ({ data: matchReply(), error: null }));
    const { w } = worker({ ...shadow, workerMode: 'off' }, rpc);
    expect((await w.pass()).outcome).toBe('off');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('tolerates the matcher not being deployed yet, and says so once', async () => {
    const rpc = rpcWith(() => ({ data: null, error: NOT_FOUND }));
    const { w, logger } = worker(shadow, rpc);
    expect((await w.pass()).outcome).toBe('unavailable');
    expect((await w.pass()).outcome).toBe('unavailable');
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(logger.lines.filter((l) => /not deployed/.test(l))).toHaveLength(1);
  });

  it('an answer outside the contract is recorded as invalid, not trusted', async () => {
    const rpc = rpcWith(() => ({ data: { groups: 'many' }, error: null }));
    const { w } = worker(shadow, rpc);
    expect((await w.pass()).outcome).toBe('invalid');
  });

  it('runs on its timer without overlap, and stop() leaves no timer behind', async () => {
    vi.useFakeTimers();
    const rpc = rpcWith(() => ({ data: matchReply(), error: null }));
    const { w } = worker(shadow, rpc);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(shadow.passIntervalMs * 3);
    expect(rpc).toHaveBeenCalledTimes(4);
    await w.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(shadow.passIntervalMs * 5);
    expect(rpc).toHaveBeenCalledTimes(4);
    w.start(); // a stopped worker stays stopped
    await vi.advanceTimersByTimeAsync(shadow.passIntervalMs * 2);
    expect(rpc).toHaveBeenCalledTimes(4);
  });
});

describe('LightningSupervisor', () => {
  function supervisor(opts: {
    discover: () => Promise<string[]>;
    config: (clusterId: string) => { data: unknown; error: unknown };
  }) {
    const rpc = rpcWith((fn, args) => {
      if (fn === 'fn_lightning_config') return opts.config(String(args.p_cluster_id));
      if (fn === 'fn_lightning_match') return { data: matchReply(), error: null };
      throw new Error('unexpected rpc ' + fn);
    });
    const logger = quiet();
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: vi.fn(opts.discover),
      rpc,
      logger,
      frozen: () => false,
      metrics: new LightningMetrics(new MetricsRegistry()),
    });
    return { sup, rpc, logger };
  }

  it('starts nothing when no Cluster qualifies - today, every Cluster', async () => {
    const { sup, rpc } = supervisor({
      discover: async () => [],
      config: () => ({ data: null, error: null }),
    });
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a Lightning Cluster whose config is 'off', unreadable or not deployed gets no worker", async () => {
    const { sup } = supervisor({
      discover: async () => [CLUSTER_A, CLUSTER_B],
      config: (id) =>
        id === CLUSTER_A
          ? { data: { worker_mode: 'off' }, error: null }
          : { data: null, error: NOT_FOUND },
    });
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
  });

  it('starts one worker per qualifying Cluster, and stops it when the Cluster leaves', async () => {
    vi.useFakeTimers();
    let lightning = [CLUSTER_A, CLUSTER_B];
    const { sup, rpc } = supervisor({
      discover: async () => lightning,
      config: () => ({ data: { worker_mode: 'shadow', pass_interval_ms: 2_000 }, error: null }),
    });
    sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.activeClusters()).toEqual([CLUSTER_A, CLUSTER_B].sort());
    const a = sup.workerFor(CLUSTER_A)!;
    expect(a.isRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const matchCalls = () => rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_match');
    expect(matchCalls().length).toBeGreaterThanOrEqual(2);

    // Cluster A converts back (or is disabled): its worker goes.
    lightning = [CLUSTER_B];
    await vi.advanceTimersByTimeAsync(LIGHTNING_DISCOVERY_INTERVAL_MS);
    expect(sup.activeClusters()).toEqual([CLUSTER_B]);
    expect(a.isRunning).toBe(false);

    // Leadership lost / shutdown: everything stops and nothing is left armed.
    await sup.stop();
    expect(sup.activeClusters()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const after = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIGHTNING_DISCOVERY_INTERVAL_MS * 3);
    expect(rpc.mock.calls.length).toBe(after);
  });

  it("a Cluster switched to 'form' keeps a worker that refuses, and makes no match RPC", async () => {
    vi.useFakeTimers();
    const { sup, rpc } = supervisor({
      discover: async () => [CLUSTER_A],
      config: () => ({ data: { worker_mode: 'form' }, error: null }),
    });
    sup.start();
    await sup.reconcile();
    const w = sup.workerFor(CLUSTER_A)!;
    expect((await w.pass()).outcome).toBe('refused_form');
    expect(rpc.mock.calls.filter((c) => c[0] === 'fn_lightning_match')).toHaveLength(0);
    await sup.stop();
  });

  it('a discovery read that fails changes nothing, and a stopped supervisor starts nothing', async () => {
    vi.useFakeTimers();
    let fail = false;
    const { sup } = supervisor({
      discover: async () => {
        if (fail) throw new Error('timeout');
        return [CLUSTER_A];
      },
      config: () => ({ data: { worker_mode: 'shadow' }, error: null }),
    });
    // Not started (a standby, or after leadership loss): a pass does nothing.
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([]);
    sup.start();
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([CLUSTER_A]);
    fail = true;
    await sup.reconcile();
    expect(sup.activeClusters()).toEqual([CLUSTER_A]);
    await sup.stop();
  });
});

describe('the engine and GameServer wiring', () => {
  it('an engine reports every seated player, horses exactly as humans, unknown when unobserved', async () => {
    vi.doMock('../services/supabase/client.js', () => ({
      supabase: { from: vi.fn(), rpc: vi.fn() },
      maintenanceSupabase: {},
    }));
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine('0c0c0c0c-0000-4000-8000-00000000000c') as any;
    e.tableInfo = { id: e.tableId, game_type: 'cash', cluster_id: CLUSTER_A };
    e.seatedPlayers = [
      { user_id: P1, seat_number: 1, stack: 100, is_horse: false },
      { user_id: P2, seat_number: 2, stack: 100, is_horse: true },
      { user_id: P3, seat_number: 3, stack: 100, is_horse: false },
      { user_id: P4, seat_number: 4, stack: 100, is_horse: true },
    ];
    for (const id of [P1, P2, P4]) e.disconnectEngine.registerPlayer(e.tableId, id);
    e.disconnectEngine.markDisconnected(e.tableId, P4);
    const report = e.lightningPresenceReport();
    expect(report.clusterId).toBe(CLUSTER_A);
    expect(report.players).toEqual([
      { userId: P1, presence: 'connected' },
      { userId: P2, presence: 'connected' },
      { userId: P3, presence: 'unknown' },
      { userId: P4, presence: 'disconnected' },
    ]);
    e.preciseTimer?.dispose?.();
    vi.doUnmock('../services/supabase/client.js');
  });

  it('GameServer starts the supervisor beside the Cluster controller, on the leader only, and stops it with it', () => {
    const SRC = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    const standbyReturn = SRC.indexOf('return;', SRC.indexOf('await renewLeadership()'));
    const controllerStart = SRC.indexOf('this.clusterController.start();');
    const supervisorStart = SRC.indexOf('this.lightningSupervisor.start();');
    expect(supervisorStart).toBeGreaterThan(controllerStart);
    expect(controllerStart).toBeGreaterThan(standbyReturn);
    expect(SRC).toMatch(
      /\['ClusterController', \(\) => this\.clusterController\.stop\(\)\],\s*\['LightningSupervisor', \(\) => this\.lightningSupervisor\.stop\(\)\],/
    );
  });
});
