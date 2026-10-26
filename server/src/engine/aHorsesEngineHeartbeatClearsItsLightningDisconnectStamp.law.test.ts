/**
 * A HORSE'S ENGINE HEARTBEAT CLEARS ITS LIGHTNING DISCONNECT STAMP (2026-10-24).
 *
 * CLAUDE.md 10.5 item 2: a horse has no browser, so its anchor engine is its
 * input device (the synthetic heartbeat keeps the seat alive). The presence
 * door (`fn_lightning_presence_report`) was told `reconnected` only by a
 * Lightning ROOM socket (LightningRegistry.connect), so a horse stamped
 * disconnected could never be un-stamped. Measured on "FLH 0.25/0.50 Lightning
 * Games", 2026-10-24: one `player_disconnected` batch stamped seven horses at
 * 15:49:46 UTC right after an engine restart, room sockets cleared three
 * within 40 s, and `fn_lightning_reap_expired_disconnects` exited the other
 * four at 15:52:50 'disconnect_expired' while their anchor engine was
 * heartbeating every one of them.
 *
 * Pinned here:
 *   - the parked pass runs the hook before the ended-session stand-up and the
 *     halt acknowledgement;
 *   - a horse whose heartbeat is live here and whose open pool session carries
 *     a stamp is reported `reconnected` through the SAME reporter a returning
 *     room socket uses, all the way to the one RPC;
 *   - never for a seat the horse account's own client controls;
 *   - never for a person (a person is cleared only by their own socket);
 *   - never for a horse whose heartbeat is not live, on an unreadable pool, or
 *     during the freeze; and the read answers only stamped OPEN sessions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stamped: vi.fn(),
  frozen: vi.fn(() => false),
}));
vi.mock('../services/supabase/lightningAnchor.js', async (original) => ({
  ...(await original<typeof import('../services/supabase/lightningAnchor.js')>()),
  lightningStampedPoolSessions: (...args: unknown[]) => mocks.stamped(...args),
}));
vi.mock('../maintenance/freezeState.js', async (original) => ({
  ...(await original<typeof import('../maintenance/freezeState.js')>()),
  isMaintenanceFrozen: () => mocks.frozen(),
}));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineDealing } = await import('./ServerTableEngineDealing.js');
const { deadlineScheduler } = await import('./DeadlineScheduler.js');
const { LightningRegistry } = await import('../lightning/LightningRegistry.js');
const { LightningPresenceReporter } = await import('../lightning/LightningPresenceReporter.js');
const { setLightningEngineInputDeviceSink, reportLightningEngineInputDeviceLive } =
  await import('../lightning/LightningEngineInputDevice.js');

const table = '70000000-0000-4000-8000-0000000000d1';
const cluster = '5be919f7-d306-4349-a514-22b88b18f98e';
const horseId = '0f14f372-0c43-47ff-9257-1324a7e94488';
const personId = '1a2b3c4d-0000-4000-8000-0000000000d2';
const room = '70000000-0000-4000-8000-0000000000d3';
const SRC = (f: string) => readFileSync(join(process.cwd(), 'src', f), 'utf8');
const CHECK = ServerTableEngineDealing.ENGINE_PRESENCE_CHECK_MS;

let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  deadlineScheduler.cancelAll(table);
  setLightningEngineInputDeviceSink(null);
  vi.restoreAllMocks();
  mocks.stamped.mockReset();
  mocks.frozen.mockImplementation(() => false);
});

function anchor(players: Array<Record<string, unknown>>, live = true) {
  const e = new ServerTableEngine(table) as any;
  e.tableInfo = { club_id: 'club', big_blind: 0.5, cluster_id: cluster };
  e.seatedPlayers = players;
  e.isTournamentTable = () => false;
  e.lifecycleCanMutate = () => true;
  if (live) {
    for (const p of players) {
      e.disconnectEngine.registerPlayer(table, p.user_id as string);
      e.disconnectEngine.heartbeat(table, p.user_id as string);
    }
  }
  return e;
}
const horse = { user_id: horseId, username: 'horse', stack: 38.74, seat_number: 3, is_horse: true };
const person = {
  user_id: personId,
  username: 'person',
  stack: 20,
  seat_number: 4,
  is_horse: false,
};

describe("a horse's engine heartbeat clears its Lightning disconnect stamp", () => {
  it('the parked pass asks before the ended-session stand-up and the halt acknowledgement', () => {
    const base = SRC('engine/ServerTableEngineBase.ts');
    const pass = base.slice(
      base.indexOf('protected async passWhileDealingHalted('),
      base.indexOf('protected async completeQueuedLeavesWhileHalted(')
    );
    const busted = pass.indexOf('await this.recoverBustedHorsesWhileHalted();');
    const heartbeat = pass.indexOf('await this.reportHorsesTheEngineHeartbeatKeepsHere();');
    const ended = pass.indexOf('await this.standUpPlayersWhosePoolSessionEnded();');
    const ack = pass.indexOf('await this.observeDealingHalt();');
    expect(busted).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(busted);
    expect(ended).toBeGreaterThan(heartbeat);
    expect(ack).toBeGreaterThan(ended);
    // Wired at boot to the registry, through the one reporter.
    const gs = SRC('GameServer.ts');
    expect(gs).toMatch(
      /setLightningEngineInputDeviceSink\(\(clusterId, playerId, poolSessionId\) =>\s*this\.lightningRooms\.engineInputDeviceLive\(clusterId, playerId, poolSessionId\)/
    );
    expect(gs).toContain('setLightningEngineInputDeviceSink(null);');
  });

  it('a stamped horse the engine is heartbeating is reported reconnected, through to the RPC', async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const reporter = new LightningPresenceReporter({ rpc, debounceMs: 60_000 });
    const registry = new LightningRegistry({ presenceReport: reporter });
    setLightningEngineInputDeviceSink((c, p, s) => registry.engineInputDeviceLive(c, p, s));

    const e = anchor([horse]);
    mocks.stamped.mockResolvedValue(new Map([[horseId, room]]));
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(mocks.stamped).toHaveBeenCalledWith(cluster, [horseId]);
    expect(reporter.pendingCount()).toBe(1);
    await reporter.flush(cluster);
    expect(rpc).toHaveBeenCalledWith('fn_lightning_presence_report', {
      p_cluster_id: cluster,
      p_disconnected: [],
      p_reconnected: [horseId],
      p_now: expect.any(String),
    });
    await reporter.stop();
  });

  it('asks at most once per window', async () => {
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    const e = anchor([horse]);
    mocks.stamped.mockResolvedValue(new Map([[horseId, room]]));
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    clock += CHECK - 1;
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(mocks.stamped).toHaveBeenCalledTimes(1);
    clock += 1;
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(mocks.stamped).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledWith(cluster, horseId, room);
  });

  it('a person is never asked for or reported: only their own socket clears them', async () => {
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    const e = anchor([person]);
    mocks.stamped.mockResolvedValue(new Map([[personId, room]]));
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(mocks.stamped).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it('a horse whose heartbeat is not live here is not reported', async () => {
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    const e = anchor([horse], false);
    mocks.stamped.mockResolvedValue(new Map([[horseId, room]]));
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(sink).not.toHaveBeenCalled();
  });

  it('an unreadable pool and the freeze report nobody', async () => {
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    const e = anchor([horse]);
    mocks.stamped.mockRejectedValue(new Error('lightning_pool_session read failed'));
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(sink).not.toHaveBeenCalled();

    const f = anchor([horse]);
    mocks.frozen.mockImplementation(() => true);
    mocks.stamped.mockResolvedValue(new Map([[horseId, room]]));
    await f.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(mocks.stamped).toHaveBeenCalledTimes(1); // only the unreadable ask
    expect(sink).not.toHaveBeenCalled();
  });

  it('a horse whose session is not stamped is not reported', async () => {
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    const e = anchor([horse]);
    mocks.stamped.mockResolvedValue(new Map());
    await e.reportHorsesTheEngineHeartbeatKeepsHere();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('the registry door: the engine is refused where the account client controls', () => {
  it('a seat the horse account client controls is refused; one it does not, is reported', async () => {
    const report = { disconnected: vi.fn(), reconnected: vi.fn() };
    const registry = new LightningRegistry({
      presenceReport: report,
      viewAccess: async () => true,
      roomOwner: async () => ({ playerId: horseId, clusterId: cluster }),
    });
    await registry.authorize(room, horseId);
    registry.connect(room, horseId);
    registry.noteClientClaim(room, horseId);
    report.reconnected.mockClear();
    expect(registry.isClientControlling(horseId, room)).toBe(true);
    expect(registry.engineInputDeviceLive(cluster, horseId, room)).toBe(false);
    expect(report.reconnected).not.toHaveBeenCalled();

    // The client's last socket goes: the engine is the input device again.
    registry.disconnect(room, horseId);
    expect(registry.engineInputDeviceLive(cluster, horseId, room)).toBe(true);
    expect(report.reconnected).toHaveBeenCalledWith(cluster, horseId);
  });

  it('the port is inert unwired, refuses bad ids, and never throws', () => {
    expect(reportLightningEngineInputDeviceLive(cluster, horseId, room)).toBe(false);
    setLightningEngineInputDeviceSink(() => {
      throw new Error('boom');
    });
    expect(reportLightningEngineInputDeviceLive(cluster, horseId, room)).toBe(false);
    const sink = vi.fn(() => true);
    setLightningEngineInputDeviceSink(sink);
    expect(reportLightningEngineInputDeviceLive('nope', horseId, room)).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('the read: which open pool sessions carry a stamp', () => {
  async function readWith(rows: Array<Record<string, unknown>>, fail = false) {
    vi.resetModules();
    const filters: Array<[string, unknown]> = [];
    vi.doMock('../services/supabase/client.js', () => ({
      supabase: {
        from: () => {
          const chain: any = {
            select: () => chain,
            eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
            in: (k: string, v: unknown) => (filters.push([k, v]), chain),
            is: (k: string, v: unknown) => (filters.push(['is:' + k, v]), chain),
            not: (k: string) => (filters.push(['not:' + k, null]), chain),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(
                fail ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }
              ).then(resolve),
          };
          return chain;
        },
      },
    }));
    const mod = await vi.importActual<typeof import('../services/supabase/lightningAnchor.js')>(
      '../services/supabase/lightningAnchor.js'
    );
    return { read: mod.lightningStampedPoolSessions, filters };
  }
  afterEach(() => {
    vi.doUnmock('../services/supabase/client.js');
    vi.resetModules();
  });

  it('answers player -> room for stamped OPEN sessions in this Cluster', async () => {
    const { read, filters } = await readWith([{ id: room, player_id: horseId }]);
    expect(await read(cluster, [horseId])).toEqual(new Map([[horseId, room]]));
    expect(filters).toEqual([
      ['cluster_id', cluster],
      ['player_id', [horseId]],
      ['is:exited_at', null],
      ['not:disconnected_at', null],
    ]);
  });

  it('a failed read throws rather than answering empty', async () => {
    const { read } = await readWith([], true);
    await expect(read(cluster, [horseId])).rejects.toThrow(/lightning_pool_session read failed/);
  });
});
