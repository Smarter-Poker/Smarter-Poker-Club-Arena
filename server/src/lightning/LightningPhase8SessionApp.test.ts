/**
 * LIGHTNING PHASE 8 (engine): the client's device class reaches the matcher
 * (p_player_platforms, tolerating the old SQL signature), and every decision
 * a player owes in any Lightning hand is announced to each of their rooms
 * and retracted once it is no longer owed, on the engine's clock.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 8 fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 8 fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { clientDevicePlatform, framePlatformOf } =
  await import('../transport/EngineWebSocketServer.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { lightningMatch, lightningMatchAndForm, playerPlatformsArg } =
  await import('./LightningRpc.js');
const { LightningRegistry, lightningDecisionUrgency } = await import('./LightningRegistry.js');
const { LightningClusterWorker, LIGHTNING_PLATFORMS_RETRY_MS } =
  await import('./LightningClusterWorker.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

const CLUSTER = uid(1);
const OTHER_CLUSTER = uid(2);
const P1 = uid(11);
const P2 = uid(12);
const P3 = uid(13);

const MATCH_OK = {
  matcher_version: 'v1',
  groups: [],
  diagnosis: [],
  pool_diversity_score: null,
  legal_count: 0,
  generated_at: null,
};

describe('the device class a socket reports', () => {
  it('reads ?p= as desktop, tablet or mobile, and anything else as not reported', () => {
    const at = (q: string) => clientDevicePlatform(new URL(`http://x/ws/table/t${q}`));
    expect(at('?v=1&p=desktop')).toBe('desktop');
    expect(at('?v=1&p=tablet')).toBe('tablet');
    expect(at('?p=mobile&v=1')).toBe('mobile');
    expect(at('?v=1')).toBeNull();
    expect(at('?v=1&p=phone')).toBeNull();
    expect(at('?p=DESKTOP')).toBeNull();
    // The mux SUBSCRIBE frame carries the same three words.
    expect(framePlatformOf('mobile')).toBe('mobile');
    expect(framePlatformOf(undefined)).toBeNull();
    expect(framePlatformOf({ p: 'desktop' })).toBeNull();
  });
});

describe('the presence feed carries platforms', () => {
  it('names a platform only for this Cluster’s players, and the narrowest report wins', () => {
    const presence = new LightningPresence(() => [
      {
        tableId: uid(100),
        clusterId: CLUSTER,
        players: [{ userId: P1, presence: 'connected', platform: 'desktop' }],
      },
      {
        // The same player's room in another Cluster, on a phone.
        tableId: uid(101),
        clusterId: OTHER_CLUSTER,
        players: [{ userId: P1, presence: 'connected', platform: 'mobile' }],
      },
      {
        tableId: uid(102),
        clusterId: CLUSTER,
        players: [{ userId: P2, presence: 'connected', platform: 'tablet' }],
      },
      {
        tableId: uid(103),
        clusterId: CLUSTER,
        players: [{ userId: P3, presence: 'connected' }],
      },
      {
        // A player of another Cluster only: never sent to this matcher.
        tableId: uid(104),
        clusterId: OTHER_CLUSTER,
        players: [{ userId: uid(14), presence: 'connected', platform: 'desktop' }],
      },
    ]);
    const snap = presence.snapshot(CLUSTER);
    expect(snap.platforms).toEqual({ [P1]: 'mobile', [P2]: 'tablet' });
    expect(snap.connected).toEqual([P1, P2, P3]);
  });

  it('the registry reports each room’s platform with its presence', () => {
    const reg = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async () => ({ playerId: P1, clusterId: CLUSTER }),
    });
    return reg.authorize(uid(200), P1).then(() => {
      reg.connect(uid(200), P1, 'tablet');
      const reports = [...reg.presenceReports()];
      expect(reports).toEqual([
        {
          tableId: uid(200),
          clusterId: CLUSTER,
          players: [{ userId: P1, presence: 'connected', platform: 'tablet' }],
        },
      ]);
    });
  });
});

describe('p_player_platforms reaches the matcher', () => {
  const now = new Date('2026-10-07T12:00:00Z');

  it('is sent to both matcher functions when a platform is known', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return {
        data: fn === 'fn_lightning_match' ? MATCH_OK : { ok: true, hands: [] },
        error: null,
      };
    };
    const m = await lightningMatch(rpc, {
      clusterId: CLUSTER,
      now,
      disconnected: [],
      matcherVersion: null,
      playerPlatforms: { [P2]: 'tablet', [P1]: 'desktop' },
    });
    expect(m.status).toBe('ok');
    expect(m.platforms).toBe('sent');
    const f = await lightningMatchAndForm(rpc, {
      clusterId: CLUSTER,
      now,
      disconnected: [],
      maxHands: 2,
      requestId: uid(300),
      playerPlatforms: { [P1]: 'mobile' },
    });
    expect(f.platforms).toBe('sent');
    expect(calls.map(([fn]) => fn)).toEqual(['fn_lightning_match', 'fn_lightning_match_and_form']);
    expect(calls[0][1].p_player_platforms).toEqual({ [P1]: 'desktop', [P2]: 'tablet' });
    expect(calls[1][1].p_player_platforms).toEqual({ [P1]: 'mobile' });
  });

  it('falls back to the old signature once when the argument is unknown', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      if ('p_player_platforms' in args)
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      return { data: { ok: true, hands: [] }, error: null };
    };
    const f = await lightningMatchAndForm(rpc, {
      clusterId: CLUSTER,
      now,
      disconnected: [],
      maxHands: 1,
      requestId: uid(301),
      playerPlatforms: { [P1]: 'desktop' },
    });
    expect(f.status).toBe('ok');
    expect(f.platforms).toBe('dropped');
    expect(calls).toHaveLength(2);
    expect('p_player_platforms' in calls[1]).toBe(false);
    // Same request id both times: the writer never ran twice under two ids.
    expect(calls[0].p_request_id).toBe(calls[1].p_request_id);
  });

  it('sends nothing extra when no platform is known, and drops malformed entries', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: MATCH_OK, error: null };
    };
    const m = await lightningMatch(rpc, {
      clusterId: CLUSTER,
      now,
      disconnected: [],
      matcherVersion: null,
      playerPlatforms: {},
    });
    expect(m.platforms).toBe('none');
    expect('p_player_platforms' in calls[0]).toBe(false);
    expect(
      playerPlatformsArg({ 'not-a-uuid': 'desktop', [P1]: 'watch' as never, [P2]: 'mobile' })
    ).toEqual({ [P2]: 'mobile' });
    expect(playerPlatformsArg(null)).toBeNull();
  });
});

describe('the worker and the old matcher signature', () => {
  it('after one refusal it stops sending platforms until the retry time, then tries again', async () => {
    const clock = { v: Date.parse('2026-10-07T12:00:00Z') };
    let newSignature = false;
    const calls: Array<Record<string, unknown>> = [];
    const rpc = async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      if ('p_player_platforms' in args && !newSignature)
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      return { data: MATCH_OK, error: null };
    };
    const presence = new LightningPresence(() => [
      {
        tableId: uid(100),
        clusterId: CLUSTER,
        players: [{ userId: P1, presence: 'connected', platform: 'mobile' }],
      },
    ]);
    const w = new LightningClusterWorker(
      CLUSTER,
      {
        matcherVersion: null,
        workerMode: 'shadow',
        passIntervalMs: 2_000,
        keepaliveIntervalMs: 30_000,
        maxHandsPerPass: 4,
        dealWindowMs: 600_000,
      },
      {
        rpc,
        presence,
        metrics: new LightningMetrics(new MetricsRegistry()),
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date(clock.v),
      }
    );
    expect((await w.pass()).outcome).toBe('matched');
    expect(calls).toHaveLength(2); // refused with platforms, answered without
    calls.length = 0;
    await w.pass();
    expect(calls).toHaveLength(1);
    expect('p_player_platforms' in calls[0]).toBe(false);
    // The migration lands; after the retry time the platforms go again.
    newSignature = true;
    clock.v += LIGHTNING_PLATFORMS_RETRY_MS;
    calls.length = 0;
    await w.pass();
    expect(calls).toHaveLength(1);
    expect(calls[0].p_player_platforms).toEqual({ [P1]: 'mobile' });
  });
});

describe('the decision queue (registry)', () => {
  async function registryWithRooms(nowMs: { v: number }) {
    const sent: Array<{ room: string; user: string; payload: Record<string, unknown> }> = [];
    const owners: Record<string, { playerId: string; clusterId: string }> = {
      [uid(400)]: { playerId: P1, clusterId: CLUSTER },
      [uid(401)]: { playerId: P1, clusterId: OTHER_CLUSTER },
      [uid(402)]: { playerId: P2, clusterId: CLUSTER },
    };
    const reg = new LightningRegistry({
      viewAccess: async () => true,
      roomOwner: async (room) => owners[room] ?? null,
      now: () => nowMs.v,
    });
    reg.setUserEventSink((room, user, payload) => {
      sent.push({ room, user, payload });
      return 1;
    });
    for (const [room, o] of Object.entries(owners)) {
      await reg.authorize(room, o.playerId);
      reg.connect(room, o.playerId, 'desktop');
    }
    return { reg, sent };
  }

  it('announces an owed decision to every room of that player, with the engine clock', async () => {
    const clock = { v: 1_000_000 };
    const { reg, sent } = await registryWithRooms(clock);
    expect(reg.roomsOfUser(P1)).toEqual([uid(400), uid(401)]);
    reg.announceDecision(P1, {
      poolSessionId: uid(401),
      handId: 'hand-a',
      street: 'flop',
      deadlineAt: clock.v + 12_000,
    });
    expect(sent.map((s) => s.room)).toEqual([uid(400), uid(401)]);
    for (const s of sent) {
      expect(s.user).toBe(P1);
      expect(s.payload).toEqual({
        type: 'lightning_decision',
        pool_session_id: uid(401),
        hand_id: 'hand-a',
        street: 'flop',
        time_remaining_ms: 12_000,
        deadline_at: 1_012_000,
        urgency: 'normal',
        server_now: 1_000_000,
      });
    }
  });

  it('retracts once, to every room, and a reconnect re-sends only what is still owed', async () => {
    const clock = { v: 2_000_000 };
    const { reg, sent } = await registryWithRooms(clock);
    reg.announceDecision(P1, {
      poolSessionId: uid(400),
      handId: 'hand-b',
      street: 'preflop',
      deadlineAt: clock.v + 8_000,
    });
    reg.announceDecision(P1, {
      poolSessionId: uid(401),
      handId: 'hand-c',
      street: 'river',
      deadlineAt: clock.v + 3_000,
    });
    expect(reg.openDecisions(P1).map((d) => d.handId)).toEqual(['hand-c', 'hand-b']);
    sent.length = 0;
    clock.v += 4_000;
    // RESYNC on one room: only hand-b is still on the clock.
    reg.rePushHoleCards(uid(400), P1);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      hand_id: 'hand-b',
      time_remaining_ms: 4_000,
      urgency: 'critical',
    });
    sent.length = 0;
    reg.clearDecision(P1, 'hand-b', 'acted');
    reg.clearDecision(P1, 'hand-b', 'acted');
    expect(sent.map((s) => [s.room, s.payload.type, s.payload.reason])).toEqual([
      [uid(400), 'lightning_decision_cleared', 'acted'],
      [uid(401), 'lightning_decision_cleared', 'acted'],
    ]);
    // Another player's rooms never hear any of it.
    expect(sent.every((s) => s.user === P1)).toBe(true);
  });

  it('grades urgency on the remaining time', () => {
    expect(lightningDecisionUrgency(20_000)).toBe('normal');
    expect(lightningDecisionUrgency(10_000)).toBe('high');
    expect(lightningDecisionUrgency(5_000)).toBe('critical');
    expect(lightningDecisionUrgency(0)).toBe('critical');
  });
});

describe('the decision queue (hand host)', () => {
  it('every human turn is announced with its deadline and retracted; horses are never queued', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = mulberry32(seed);
      const n = 2 + (seed % 4);
      const formed = formedHand(n, 500 + seed * 10);
      const horses = new Set<string>(seed % 3 === 0 ? [formed.players[0]] : []);
      const events: Array<{ player: string; decision: any; reason?: string }> = [];
      const t = buildHost(
        formed,
        Array.from({ length: n }, () => 200),
        {
          horses,
          deps: {
            onDecision: (player, decision, reason) => events.push({ player, decision, reason }),
          },
        }
      );
      await t.host.start();
      await flush();
      await playOut(t.host, rnd);
      await flush();
      expect(t.host.lifecycle).toBe('complete');
      const open = new Map<string, number>();
      for (const e of events) {
        expect(horses.has(e.player)).toBe(false);
        if (e.decision) {
          const room = t.participants.find((p) => p.playerId === e.player)!.poolSessionId;
          expect(e.decision.poolSessionId).toBe(room);
          expect(e.decision.handId).toBe(formed.handId);
          expect(['preflop', 'flop', 'turn', 'river']).toContain(e.decision.street);
          expect(e.decision.deadlineAt).toBeGreaterThan(0);
          open.set(e.player, (open.get(e.player) ?? 0) + 1);
        } else {
          expect(open.get(e.player) ?? 0).toBeGreaterThan(0);
          open.set(e.player, 0);
          expect(typeof e.reason).toBe('string');
        }
      }
      // Nothing is left owed once the hand is over.
      expect([...open.values()].every((v) => v === 0)).toBe(true);
      expect(events.some((e) => e.decision)).toBe(true);
    }
  });
});
