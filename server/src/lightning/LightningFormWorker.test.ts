/**
 * LIGHTNING PHASE 6: the worker in 'form' mode, end to end with mocks - one
 * match_and_form per pass, a host per formed hand, a wake on a freed player,
 * the same request id only to retry an unknown outcome, and a stop when the
 * barrier froze the Cluster. And the seat proxy and room door.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the form-worker fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the form-worker fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { LightningClusterWorker } = await import('./LightningClusterWorker.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { LightningRegistry, LightningHosting } = await import('./LightningRegistry.js');
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
import type { LightningConfig } from './LightningConfig.js';
import type { LightningFormedHand } from './LightningHandHost.js';

const { uid, formedHand, fakeBackend, RecordingHub, flush, playOut } = kit;
const CLUSTER = uid(1);
const form: LightningConfig = {
  matcherVersion: null,
  workerMode: 'form',
  passIntervalMs: 1_000,
  keepaliveIntervalMs: 5_000,
  maxHandsPerPass: 7,
  dealWindowMs: 600_000,
};
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function formReply(
  hands: Array<Partial<Record<string, unknown>>>,
  extra: Record<string, unknown> = {}
) {
  return {
    ok: true,
    formed: hands.length,
    hands,
    frozen: false,
    stopped_reason: 'plan_exhausted',
    ...extra,
  };
}

function handRow(n: number, base: number) {
  const f = formedHand(n, base);
  return {
    hand_id: f.handId,
    instance_id: f.instanceId,
    bb: f.bb,
    sb: f.sb,
    btn: f.btn,
    players: f.players,
  };
}

function worker(
  rpcImpl: (fn: string, args: any) => any,
  started: LightningFormedHand[],
  extra: Record<string, unknown> = {}
) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args));
  const metrics = new LightningMetrics(new MetricsRegistry());
  const w = new LightningClusterWorker(CLUSTER, form, {
    rpc,
    presence: new LightningPresence(() => []),
    metrics,
    logger: quiet,
    startHand: (h) => started.push(h),
    ...extra,
  });
  return { w, rpc, metrics };
}

afterEach(() => vi.useRealTimers());

describe("the worker in 'form' mode", () => {
  it('makes one match_and_form per pass, bounded, and starts a host per formed hand', async () => {
    const started: LightningFormedHand[] = [];
    const { w, rpc, metrics } = worker(
      () => ({ data: formReply([handRow(3, 100), handRow(2, 200)]), error: null }),
      started
    );
    const out = await w.pass();
    expect(out).toEqual({ outcome: 'formed', formed: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('fn_lightning_match_and_form');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_cluster_id: CLUSTER, p_max_hands: 7 });
    expect(started.map((h) => h.players.length)).toEqual([3, 2]);
    expect(started[0]).toMatchObject({ clusterId: CLUSTER, bb: started[0].players[0] });
    expect(metrics.formedTotal.get()).toBe(2);
    // A fresh request id per pass.
    await w.pass();
    expect(rpc.mock.calls[1][1].p_request_id).not.toBe(rpc.mock.calls[0][1].p_request_id);
  });

  it('retries an UNKNOWN outcome under the same request id, and a replay starts no duplicate host', async () => {
    const started: LightningFormedHand[] = [];
    let call = 0;
    const row = handRow(2, 300);
    const known = new Set<string>();
    const { w, rpc } = worker(
      () =>
        ++call === 1
          ? { data: null, error: { message: 'socket hang up' } }
          : { data: formReply([row], { replayed: true }), error: null },
      started,
      { hasInstance: (id: string) => known.has(id) }
    );
    expect((await w.pass()).outcome).toBe('error');
    expect((await w.pass()).outcome).toBe('formed');
    expect(rpc.mock.calls[1][1].p_request_id).toBe(rpc.mock.calls[0][1].p_request_id);
    expect(started).toHaveLength(1);
    known.add(row.instance_id as string);
    await w.pass();
    expect(started).toHaveLength(1);
  });

  it('formation_invariant_failed stops the worker for good', async () => {
    const started: LightningFormedHand[] = [];
    const frozen = vi.fn();
    const { w, rpc } = worker(
      () => ({
        data: { ok: false, frozen: true, stopped_reason: 'frozen', hands: [] },
        error: null,
      }),
      started,
      { onClusterFrozen: frozen }
    );
    w.start();
    await vi.waitFor(() => expect(frozen).toHaveBeenCalledWith(CLUSTER));
    expect(w.isRunning).toBe(false);
    const calls = rpc.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(rpc.mock.calls.length).toBe(calls);
  });

  it('a skipped pass (pass_in_progress) forms nothing and is not an error', async () => {
    const started: LightningFormedHand[] = [];
    const { w } = worker(
      () => ({
        data: { ok: true, formed: 0, skipped: true, reason: 'pass_in_progress' },
        error: null,
      }),
      started
    );
    expect(await w.pass()).toEqual({ outcome: 'skipped', reason: 'pass_in_progress' });
    expect(started).toEqual([]);
  });

  it('a wake runs the next pass at once instead of a pass interval later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const started: LightningFormedHand[] = [];
    const { w, rpc } = worker(() => ({ data: formReply([]), error: null }), started);
    w.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(rpc).toHaveBeenCalledTimes(1);
    w.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    await w.stop();
  });

  it('end to end: a formed hand is dealt and settled by a host, and its players wake the worker', async () => {
    const formed = formedHand(3, 400);
    const fb = fakeBackend(formed, [100, 100, 100], new Set());
    const hub = new RecordingHub();
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => null,
    });
    const hosting = new LightningHosting({
      registry,
      backend: fb.backend,
      hub,
      leaseFor: () => ({ instance: 'i', generation: uid(4242) }),
      metrics: new LightningMetrics(new MetricsRegistry()),
      hostOptions: { sleep: () => Promise.resolve(), logger: quiet },
    });
    const wakes = vi.fn();
    const hosts: any[] = [];
    const reply = formReply([
      {
        hand_id: formed.handId,
        instance_id: formed.instanceId,
        bb: formed.bb,
        sb: formed.sb,
        btn: formed.btn,
        players: formed.players,
      },
    ]);
    const { w } = worker(() => ({ data: reply, error: null }), [], {
      startHand: (h: LightningFormedHand) => hosts.push(hosting.startHand(h, form, wakes)),
      hasInstance: (id: string) => hosting.hasInstance(id),
    });
    await w.pass();
    await flush();
    expect(hosts).toHaveLength(1);
    expect(registry.hasInstance(formed.instanceId)).toBe(true);
    // The player's room routes POST /action to the host through the seat proxy.
    const room = hosts[0].roomOf(formed.players[0]);
    expect(registry.actionEngineFor(room)).toBeDefined();
    await playOut(hosts[0], mulberry32(5));
    await flush();
    expect(hosts[0].lifecycle).toBe('complete');
    expect(fb.calls.settle).toHaveLength(1);
    expect(wakes).toHaveBeenCalled();
    expect(registry.hasInstance(formed.instanceId)).toBe(false);
    // A replay naming the finished instance is not dealt twice (the host is gone,
    // and begin_dealing refuses a non-reserved instance in the database).
    expect(registry.hostForRoom(room)).toBeUndefined();
  });

  it('leadership loss abandons every hand not yet settling', async () => {
    const formed = formedHand(2, 500);
    const fb = fakeBackend(formed, [100, 100], new Set());
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => null,
    });
    const hosting = new LightningHosting({
      registry,
      backend: fb.backend,
      hub: new RecordingHub(),
      leaseFor: () => ({ instance: 'i', generation: uid(4242) }),
      metrics: new LightningMetrics(new MetricsRegistry()),
      hostOptions: { sleep: () => Promise.resolve(), logger: quiet },
    });
    const host = hosting.startHand(formed, form, () => {});
    await flush();
    expect(host.lifecycle).toBe('dealing');
    await hosting.abortAll('leadership_lost');
    expect(host.lifecycle).toBe('abandoned');
    expect(fb.calls.abandon).toEqual(['leadership_lost']);
    expect(fb.calls.settle).toEqual([]);
  });
});

describe('the seat proxy and the room door', () => {
  it('authorizes only the pool session owner, fails closed, and routes actions to the room’s host', async () => {
    const owner = uid(10);
    const room = uid(20);
    const access = vi.fn(async (r: string, u: string) => r === room && u === owner);
    const registry = new LightningRegistry({
      viewAccess: access,
      roomOwner: async () => ({ playerId: owner, clusterId: CLUSTER }),
    });
    expect((await registry.authorize(room, uid(11))).allowed).toBe(false);
    expect((await registry.authorize('not-a-uuid', owner)).allowed).toBe(false);
    const broken = new LightningRegistry({
      viewAccess: async () => {
        throw new Error('down');
      },
    });
    expect(await broken.authorize(room, owner)).toMatchObject({
      allowed: false,
      reason: 'check_failed',
    });
    expect(registry.isRoom(room)).toBe(false);
    expect(await registry.authorize(room, owner)).toMatchObject({
      allowed: true,
      reason: 'seated',
    });
    expect(registry.isRoom(room)).toBe(true);
    // Presence: the room's owner, attributed to the Cluster, connected while a socket is up.
    registry.connect(room, owner);
    expect([...registry.presenceReports()]).toEqual([
      { tableId: room, clusterId: CLUSTER, players: [{ userId: owner, presence: 'connected' }] },
    ]);
    const proxy = registry.actionEngineFor(room)!;
    expect(proxy.handlePlayerAction(owner, 'call')).toMatchObject({
      success: false,
      code: 'NO_ACTIVE_HAND',
    });
    expect(registry.actionEngineFor(uid(99))).toBeUndefined();
  });

  it('a player cannot act through another player’s room', async () => {
    const formed = formedHand(2, 600);
    const t = kit.buildHost(formed, [100, 100]);
    await t.host.start();
    const registry = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => null,
    });
    registry.register(t.host);
    const roomA = t.host.roomOf(formed.players[0])!;
    const proxy = registry.actionEngineFor(roomA)!;
    expect(proxy.handlePlayerAction(formed.players[1], 'fold')).toMatchObject({
      success: false,
      error: 'Player not found at this table',
    });
  });
});
