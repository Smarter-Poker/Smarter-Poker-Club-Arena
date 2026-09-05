/**
 * READY IS NOT DEALING (2026-09-05).
 *
 * `start()` resolves when the dealing loop begins - after the table has its
 * AutoStart figure of players seated. For a one-player table that is "when a
 * second player arrives". `ensureCashTableEngine` returned that promise, so
 * GET /state, GET /actions, the WS `ensureTable` and the cluster wake all
 * waited for a second player before they could serve the first (the cluster
 * controller's BUG 4 of 2026-09-05 parked the whole controller on one
 * lone-seated Main 1).
 *
 * `engine.ready` settles the moment the FSM reaches `waiting`: row loaded,
 * sub-engines configured, waiting snapshot publishable. These pin that it
 * resolves true while start() is still waiting for players, false when start
 * fails or the engine is stopped before it got there, and that the on-demand
 * door hands out THAT promise.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const loadSeatedPlayers = vi.fn();
const loadTable = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

afterEach(() => {
  vi.restoreAllMocks();
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
});

const TABLE_ROW = {
  id: TABLE,
  small_blind: 1,
  big_blind: 2,
  ante: 0,
  game_variant: 'nlh',
  action_time_seconds: 15,
  max_players: 6,
};

const seat = (n: number) => ({
  user_id: 'u' + n,
  seat_number: n,
  username: 'p' + n,
  stack: 1000,
  is_horse: true,
});

/** Same shape as EngineStartResilience's helper: everything after the opening
    read stubbed, EXCEPT sleep - the wait-for-players loop must really pace so
    "start() has not resolved" is observable rather than a race. */
function startable() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));
  engine.seedHandCountFromHistory = async () => {};
  engine.restoreButtonFromHistory = async () => {};
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.checkCrashRecovery = async () => false;
  engine.resolveOrphanedAddOns = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.scheduleHeartbeatCheck = () => {};
  engine.dealingLoop = async () => {};
  return engine;
}

const settled = async <T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> => {
  const marker = Symbol('pending');
  const v = await Promise.race([p, Promise.resolve(marker)]);
  return v === marker ? { done: false } : { done: true, value: v as T };
};

describe('engine.ready', () => {
  it('resolves true at `waiting` while start() is still waiting for a second player', async () => {
    loadTable.mockResolvedValue(TABLE_ROW);
    loadSeatedPlayers.mockResolvedValue([seat(1)]); // one player: start() cannot deal

    const engine = startable();
    const started = engine.start().then(() => 'dealing');

    expect(await engine.ready).toBe(true);
    expect(engine.tableFSM.state).toBe('waiting');
    // Give the wait loop a few passes: start() must still be parked.
    await new Promise((r) => setTimeout(r, 60));
    expect(await settled(started)).toEqual({ done: false });

    await engine.stop();
    await started; // the loop exits on running=false; start() resolves without dealing
  });

  it('resolves false when start() fails before `waiting`', async () => {
    loadTable.mockRejectedValue(new Error('row is gone')); // not transient: no retry
    const engine = startable();
    engine.killForRestart = () => {
      engine.running = false;
    };
    await engine.start();
    expect(await engine.ready).toBe(false);
  });

  it('resolves false when the engine is stopped before it got there', async () => {
    loadTable.mockImplementation(() => new Promise(() => {})); // never answers
    const engine = startable();
    void engine.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(await settled(engine.ready)).toEqual({ done: false });
    await engine.stop();
    expect(await engine.ready).toBe(false);
  });

  it('settles once: a later kill does not flip a true', async () => {
    loadTable.mockResolvedValue(TABLE_ROW);
    loadSeatedPlayers.mockResolvedValue([seat(1)]);
    const engine = startable();
    void engine.start();
    expect(await engine.ready).toBe(true);
    engine.killForRestart('drill');
    expect(await engine.ready).toBe(true);
  });
});

describe('the on-demand door hands out `ready`, not `start()`', () => {
  it('ensureCashTableEngine returns engine.ready and keeps the start chain for its failure handling', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'GameServer.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async ensureCashTableEngine('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toContain('const readyPromise: Promise<boolean> = engine.ready.finally(');
    expect(body).toContain('this.tableEngineStartPromises.set(tableId, readyPromise);');
    expect(body).toContain('return readyPromise;');
    expect(body).not.toContain('return startPromise;');
    // The failure handling on the start chain stays: a failed start still
    // frees the map slot, the hub room and the lease.
    expect(body).toContain("reportError(startError, 'GameServer.on_demand_table_start_failed')");
    expect(body).toContain('await releaseTables([tableId]);');
  });
});
