/**
 * A SAT-OUT LIGHTNING PLAYER IS ON THE CASH SIT-OUT CLOCK (2026-10-26).
 *
 * A Lightning player sits out at their anchor seat, and the anchor is parked
 * by the dealing halt for as long as the Cluster is Lightning, so the cash
 * sweep never reached them: in production one player sat SITTING_OUT for
 * 7 h 45 min holding the seat and the chips. The parked anchor of a Cluster
 * that IS Lightning now runs the cash rule - the same five-minute clock, the
 * same thaw, the same cash-out - and never while a conversion is still
 * counting its population (the halt law). Horses and humans alike.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  cashout: vi.fn(),
  frozen: { v: false },
}));
vi.mock('../services/supabase/lightningAnchor.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lightningClusterModeOf: (...a: unknown[]) => mocks.mode(...a),
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  atomicCashout: (...a: unknown[]) => mocks.cashout(...a),
}));
vi.mock('../maintenance/freezeState.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isMaintenanceFrozen: () => mocks.frozen.v,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { DisconnectEngine } = await import('./DisconnectEngine.js');

const TABLE = 'eeeeeeee-1111-4222-8333-444444444444';
const CLUSTER = 'cccccccc-1111-4222-8333-444444444444';
const HUMAN = 'aaaaaaaa-1111-4222-8333-444444444444';
const HORSE = 'bbbbbbbb-1111-4222-8333-444444444444';
const HALT = '2026-10-26T10:00:00.000Z';
const engines: any[] = [];

/** A parked anchor of a Lightning Cluster: an acknowledged Lightning halt. */
function parkedAnchor(players: Array<{ id: string; horse: boolean }>) {
  const e = new ServerTableEngine(TABLE) as any;
  engines.push(e);
  e.tableInfo = {
    id: TABLE,
    game_type: 'cash',
    tournament_id: null,
    cluster_id: CLUSTER,
    dealing_halted_reason: 'lightning',
    nit_game: false,
  };
  e.dealingHaltedAt = HALT;
  e.dealingHaltObservedFor = HALT;
  e.dealingHaltLock = true;
  e.clusterLightningEnabled = true;
  e.handController = null;
  e.seatedPlayers = players.map((p, i) => ({
    user_id: p.id,
    username: p.id.slice(0, 4),
    seat_number: i + 1,
    occupancy_id: `0000000${i}-0000-4000-8000-000000000000`,
    stack: 100,
    is_horse: p.horse,
  }));
  for (const p of players) e.disconnectEngine.registerPlayer(TABLE, p.id);
  e.hub = { emitEvent: vi.fn() };
  // A running, current engine holding its lease (the parked pass's own gate).
  e.lifecycleCanMutate = () => true;
  return e;
}
const sitOut = (e: any, id: string, minutesAgo: number) =>
  e.disconnectEngine.sitOut(TABLE, id, 'voluntary', Date.now() - minutesAgo * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.frozen.v = false;
  mocks.mode.mockResolvedValue('lightning');
  mocks.cashout.mockResolvedValue(100);
  for (const e of engines.splice(0)) e.preciseTimer?.dispose?.();
});

describe('the parked anchor of a Lightning Cluster', () => {
  it('stands a player up through the cash eviction once their sit-out passes the cash limit', async () => {
    const e = parkedAnchor([{ id: HUMAN, horse: false }]);
    const evict = vi.spyOn(e, 'evictExpiredSitOuts');
    sitOut(e, HUMAN, DisconnectEngine.SITOUT_MAX_MS / 60_000 + 1);
    await e.standUpExpiredLightningSitOuts();
    expect(mocks.mode).toHaveBeenCalledWith(CLUSTER);
    expect(evict).toHaveBeenCalledWith({ countOrbit: false, sitOutOnly: true });
    // The cash rule's own cash-out and departure.
    expect(mocks.cashout).toHaveBeenCalledTimes(1);
    expect(mocks.cashout.mock.calls[0].slice(0, 3)).toEqual([HUMAN, TABLE, 1]);
    expect(e.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'seat_left', user_id: HUMAN, reason: 'sit_out_timeout' })
    );
    expect(e.seatedPlayers).toHaveLength(0);
  });

  it('a horse is on exactly the same clock', async () => {
    const e = parkedAnchor([{ id: HORSE, horse: true }]);
    sitOut(e, HORSE, DisconnectEngine.SITOUT_MAX_MS / 60_000 + 1);
    await e.standUpExpiredLightningSitOuts();
    expect(mocks.cashout.mock.calls[0][0]).toBe(HORSE);
  });

  it('nobody is stood up before the limit, and the Cluster is not even asked', async () => {
    const e = parkedAnchor([{ id: HUMAN, horse: false }]);
    sitOut(e, HUMAN, DisconnectEngine.SITOUT_MAX_MS / 60_000 - 1);
    await e.standUpExpiredLightningSitOuts();
    expect(mocks.mode).not.toHaveBeenCalled();
    expect(mocks.cashout).not.toHaveBeenCalled();
  });

  it('only the sit-out clock: a player who is merely away from the anchor (playing in their room) stays', async () => {
    const e = parkedAnchor([
      { id: HUMAN, horse: false },
      { id: HORSE, horse: true },
    ]);
    // HORSE sat out past the limit; HUMAN has no socket on this anchor at all
    // and has been "gone" here far longer - they are playing in their room.
    e.disconnectEngine.markDisconnected(TABLE, HUMAN);
    const state = e.disconnectEngine.getState(TABLE, HUMAN);
    state.disconnectedAt = Date.now() - 60 * 60_000;
    sitOut(e, HORSE, DisconnectEngine.SITOUT_MAX_MS / 60_000 + 1);
    await e.standUpExpiredLightningSitOuts();
    expect(mocks.cashout.mock.calls.map((c) => c[0])).toEqual([HORSE]);
    expect(e.seatedPlayers.map((p: any) => p.user_id)).toEqual([HUMAN]);
  });

  it('never during a conversion: a Cluster whose row is not Lightning keeps every seat', async () => {
    for (const mode of ['must_move', 'pending_off', 'paused', null]) {
      mocks.mode.mockResolvedValueOnce(mode);
      const e = parkedAnchor([{ id: HUMAN, horse: false }]);
      sitOut(e, HUMAN, 30);
      await e.standUpExpiredLightningSitOuts();
    }
    expect(mocks.cashout).not.toHaveBeenCalled();
  });

  it('nothing on a guess: an unreadable mode, an unacknowledged halt or the freeze stands nobody up', async () => {
    mocks.mode.mockRejectedValueOnce(new Error('read failed'));
    const a = parkedAnchor([{ id: HUMAN, horse: false }]);
    sitOut(a, HUMAN, 30);
    await a.standUpExpiredLightningSitOuts();

    const b = parkedAnchor([{ id: HUMAN, horse: false }]);
    b.dealingHaltObservedFor = null; // the halt is not acknowledged yet
    sitOut(b, HUMAN, 30);
    await b.standUpExpiredLightningSitOuts();

    const c = parkedAnchor([{ id: HUMAN, horse: false }]);
    sitOut(c, HUMAN, 30);
    mocks.frozen.v = true;
    await c.standUpExpiredLightningSitOuts();
    expect(mocks.cashout).not.toHaveBeenCalled();
  });

  it('asks the Cluster at most once per check interval', async () => {
    mocks.mode.mockResolvedValue('paused');
    const e = parkedAnchor([{ id: HUMAN, horse: false }]);
    sitOut(e, HUMAN, 30);
    await e.standUpExpiredLightningSitOuts();
    await e.standUpExpiredLightningSitOuts();
    expect(mocks.mode).toHaveBeenCalledTimes(1);
  });

  it('the parked pass runs it, after the departures the player asked for', () => {
    const BASE = readFileSync('src/engine/ServerTableEngineBase.ts', 'utf8');
    const pass = BASE.slice(
      BASE.indexOf('protected async passWhileDealingHalted(): Promise<void> {')
    );
    const body = pass.slice(0, pass.indexOf('\n  }\n'));
    const standUp = body.indexOf('await this.standUpPlayersWhosePoolSessionEnded();');
    const clock = body.indexOf('await this.standUpExpiredLightningSitOuts();');
    expect(standUp).toBeGreaterThan(-1);
    expect(clock).toBeGreaterThan(standUp);
    expect(clock).toBeLessThan(body.indexOf('await this.observeDealingHalt();'));
  });
});
