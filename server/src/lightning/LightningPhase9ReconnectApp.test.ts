/**
 * LIGHTNING PHASE 9 (engine): disconnect and reconnect across the stages.
 *
 *   - presence TRANSITIONS (last socket gone, first socket back) are reported
 *     to the database once, batched per Cluster, never per pass, and a
 *     missing fn_lightning_presence_report is tolerated quietly;
 *   - a hand whose player is disconnected runs the same clock and auto-action
 *     a physical table runs, and settles entirely server-side;
 *   - a returning socket is re-sent the player's private state (their hole
 *     cards) for the live hand;
 *   - a watcher (FOLD & WATCH) whose socket drops leaks nothing once the
 *     hand ends;
 *   - an expired pool session's room answers 4404 (authorize refuses) and a
 *     room still holding sockets is closed by the sweep.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 9 fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 9 fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const {
  LightningPresenceReporter,
  LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS,
  LIGHTNING_PRESENCE_REPORT_RETRY_MS,
} = await import('./LightningPresenceReporter.js');
const { LightningRegistry, LIGHTNING_SESSION_ENDED_REASON } =
  await import('./LightningRegistry.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { buildHost, formedHand, flush, uid } = kit;

const CLUSTER = uid(1);
const P1 = uid(11);
const P2 = uid(12);
const ROOM = uid(200);
const ROOM_B = uid(201);

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe('the presence reporter (fn_lightning_presence_report)', () => {
  function reporter(opts: {
    answer?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
    now?: () => number;
    logger?: typeof quiet & { errors?: unknown[] };
  }) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return opts.answer ? opts.answer(args) : { data: null, error: null };
    };
    const r = new LightningPresenceReporter({
      rpc,
      logger: opts.logger ?? quiet,
      now: opts.now,
      debounceMs: LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS,
    });
    return { r, calls };
  }

  it('batches transitions per Cluster inside the debounce; the last state per player wins', async () => {
    const clock = { v: 1_000_000 };
    const { r, calls } = reporter({ now: () => clock.v });
    r.disconnected(CLUSTER, P2);
    r.disconnected(CLUSTER, P1);
    // P1 came straight back inside the debounce: reported reconnected, once.
    r.reconnected(CLUSTER, P1);
    expect(r.pendingCount()).toBe(2);
    await r.flush(CLUSTER);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('fn_lightning_presence_report');
    expect(calls[0][1]).toEqual({
      p_cluster_id: CLUSTER,
      p_disconnected: [P2],
      p_reconnected: [P1],
      p_now: new Date(clock.v).toISOString(),
    });
    // Nothing pending afterwards, and a flush with nothing sends nothing.
    await r.flush(CLUSTER);
    expect(calls).toHaveLength(1);
  });

  it('the debounce timer sends the one batch on its own', async () => {
    vi.useFakeTimers();
    try {
      const { r, calls } = reporter({});
      r.disconnected(CLUSTER, P1);
      r.disconnected(CLUSTER, P2);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(LIGHTNING_PRESENCE_REPORT_DEBOUNCE_MS + 10);
      expect(calls).toHaveLength(1);
      expect(calls[0][1].p_disconnected).toEqual([P1, P2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates the RPC missing quietly (deploy window), and tries again after the retry time', async () => {
    const clock = { v: 5_000_000 };
    const { r, calls } = reporter({
      answer: () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }),
      now: () => clock.v,
    });
    r.disconnected(CLUSTER, P1);
    await r.flush(CLUSTER); // the refusal marks it unavailable; nothing throws
    expect(calls).toHaveLength(1);
    r.disconnected(CLUSTER, P2); // dropped silently: the RPC is not there
    expect(r.pendingCount()).toBe(0);
    clock.v += LIGHTNING_PRESENCE_REPORT_RETRY_MS + 1;
    r.disconnected(CLUSTER, P2); // after the retry time it is asked again
    expect(r.pendingCount()).toBe(1);
    await r.flush(CLUSTER);
    expect(calls).toHaveLength(2);
  });

  it('drops a failed batch (no retry loop) and only logs it, rate-limited', async () => {
    const errors: unknown[] = [];
    const logger = { ...quiet, error: (m: string) => errors.push(m) };
    const { r, calls } = reporter({
      answer: () => ({ data: null, error: { code: '57014', message: 'canceled' } }),
      logger: logger as never,
    });
    r.disconnected(CLUSTER, P1);
    await r.flush(CLUSTER);
    expect(calls).toHaveLength(1);
    expect(r.pendingCount()).toBe(0);
    expect(errors).toHaveLength(1);
    // The next transition reports again under the ordinary path.
    r.reconnected(CLUSTER, P1);
    await r.flush(CLUSTER);
    expect(calls).toHaveLength(2);
  });
});

describe('the registry reports transitions only', () => {
  async function registryWith(report: {
    disconnected: ReturnType<typeof vi.fn>;
    reconnected: ReturnType<typeof vi.fn>;
  }) {
    const reg = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async (room) => (room === ROOM ? { playerId: P1, clusterId: CLUSTER } : null),
      presenceReport: report,
    });
    await reg.authorize(ROOM, P1);
    return reg;
  }

  it('first socket back and last socket gone are one report each; churn in between is none', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const reg = await registryWith(report);
    reg.connect(ROOM, P1, 'desktop'); // 0 -> 1: the transition
    reg.connect(ROOM, P1); // 1 -> 2: nothing
    expect(report.reconnected.mock.calls).toEqual([[CLUSTER, P1]]);
    reg.disconnect(ROOM, P1); // 2 -> 1: nothing
    expect(report.disconnected).not.toHaveBeenCalled();
    reg.disconnect(ROOM, P1); // 1 -> 0: the transition
    expect(report.disconnected.mock.calls).toEqual([[CLUSTER, P1]]);
    expect(report.reconnected).toHaveBeenCalledTimes(1);
  });

  it('a room whose Cluster is unknown reports nothing, and a throwing reporter never breaks presence', async () => {
    const report = {
      disconnected: vi.fn(() => {
        throw new Error('boom');
      }),
      reconnected: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const reg = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => null, // attribution unknown: no Cluster to report to
      presenceReport: report,
    });
    await reg.authorize(ROOM_B, P2);
    reg.connect(ROOM_B, P2);
    expect(report.reconnected).not.toHaveBeenCalled();
    expect(reg.isConnected(P2, ROOM_B)).toBe(true);
    // A known Cluster with a throwing reporter: presence still works.
    const reg2 = await registryWith(report);
    reg2.connect(ROOM, P1);
    expect(reg2.isConnected(P1, ROOM)).toBe(true);
    reg2.disconnect(ROOM, P1);
    expect(reg2.isConnected(P1, ROOM)).toBe(false);
  });
});

describe('a hand whose players are gone (disconnect after hand start)', () => {
  it('runs the clock and the auto-action for a disconnected player and settles server-side', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const formed = formedHand(3, 9100);
      // Nobody has a live socket: every turn must still resolve on the clock.
      const t = buildHost(formed, [100, 100, 100], { deps: { isConnected: () => false } });
      await t.host.start();
      await flush();
      expect(t.host.lifecycle).toBe('dealing');
      // The registry's transition reaches the hand (the transport saw the drop).
      for (const p of t.participants) t.host.notePresence(p.playerId, false);
      // Past the reconnect grace: the felt's truth says who is gone.
      await vi.advanceTimersByTimeAsync(16_000);
      await flush(4);
      const snap = t.hub.frames.filter((f) => f.kind === 'publish').at(-1)!;
      const seats = (snap.payload.players ?? []) as Array<{ is_disconnected?: boolean }>;
      expect(seats.length).toBe(3);
      expect(seats.some((p) => p.is_disconnected === true)).toBe(true);
      for (let i = 0; i < 600 && t.host.lifecycle === 'dealing'; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await flush(4);
      }
      // Settlement needed no client: the hand completed and settled once.
      expect(t.host.lifecycle).toBe('complete');
      expect(t.calls.settle).toHaveLength(1);
      const s = t.calls.settle[0];
      const sum = s.results.reduce((a: number, r: { stackAfter: number }) => a + r.stackAfter, 0);
      expect(Math.round((sum + s.rake + s.bbj) * 100)).toBe(30_000);
      // Every timeout came from the clock, never a player submission.
      const acted = (t.host as never as { actions: Array<{ origin?: string }> }).actions.filter(
        (a) => a.origin && a.origin !== 'forced'
      );
      expect(acted.length).toBeGreaterThan(0);
      expect(acted.every((a) => a.origin === 'unknown')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a returning socket is re-sent the player’s own hole cards for the live hand, and only theirs', async () => {
    const formed = formedHand(3, 9200);
    const t = buildHost(formed, [150, 150, 150]);
    await t.host.start();
    await flush();
    const p = t.participants[0];
    t.hub.frames.length = 0;
    // The transport's onResync path: the registry asks the host to re-push.
    t.host.rePushHoleCards(p.playerId);
    const privates = t.hub.frames.filter((f) => f.kind === 'private');
    expect(privates).toHaveLength(1);
    expect(privates[0].room).toBe(p.poolSessionId);
    expect(privates[0].userId).toBe(p.playerId);
    expect(privates[0].payload.kind).toBe('hole_cards');
    expect(privates[0].payload.row.cards).toHaveLength(2);
    // Nothing public replayed from here: the hub's SNAPSHOT does that on subscribe.
    expect(t.hub.frames.filter((f) => f.kind !== 'private')).toEqual([]);
    // After the hand is over the host re-pushes nothing (the hand is gone).
    await kit.playOut(t.host, () => 0.42);
    await flush();
    t.hub.frames.length = 0;
    t.host.rePushHoleCards(p.playerId);
    expect(t.hub.frames).toEqual([]);
  });
});

describe('a watcher who drops, and an expired session', () => {
  it('a FOLD & WATCH room whose socket drops leaks nothing once the hand ends', async () => {
    const host = {
      instanceId: uid(900),
      clusterId: CLUSTER,
      participantIds: () => [P1],
      roomOf: () => ROOM,
      notePresence: () => undefined,
      rePushHoleCards: () => undefined,
    } as never;
    const viewAccess = vi.fn(async () => true);
    const reg = new LightningRegistry({
      viewAccess,
      roomOwner: async () => ({ playerId: P1, clusterId: CLUSTER }),
    });
    reg.register(host);
    reg.connect(ROOM, P1);
    reg.disconnect(ROOM, P1); // the watcher's socket drops mid-hand
    expect(reg.isRoom(ROOM)).toBe(true); // the hand still owns the room
    reg.unregister(host); // the hand ends
    await Promise.resolve();
    expect(reg.isRoom(ROOM)).toBe(false); // nothing left behind
    // No ended-room question was asked for a room with no sockets.
    expect(viewAccess.mock.calls.length).toBe(0);
  });

  it('an expired pool session answers 4404 on reconnect, and a held room is closed by the sweep', async () => {
    let expired = false;
    const closed: Array<[string, string]> = [];
    const reg = new LightningRegistry({
      viewAccess: async () => !expired,
      roomOwner: async () => ({ playerId: P1, clusterId: CLUSTER }),
      clusterMode: async () => 'lightning',
      closeRoom: (roomId, reason) => closed.push([roomId, reason]),
    });
    await reg.authorize(ROOM, P1);
    reg.connect(ROOM, P1);
    // The DB reaper exits the session (player_expired). A socket still open:
    // the supervisor's sweep closes the room with the session-ended reason.
    expired = true;
    expect(await reg.sweepEndedRooms()).toBe(1);
    expect(closed).toEqual([[ROOM, LIGHTNING_SESSION_ENDED_REASON]]);
    expect(reg.isRoom(ROOM)).toBe(false);
    // A reconnect afterwards is refused as not found: the client's 4404,
    // which sends it to fn_lightning_reconnect_state for the summary.
    const verdict = await reg.authorize(ROOM, P1);
    expect(verdict).toMatchObject({ allowed: false, reason: 'table_not_found' });
  });
});
