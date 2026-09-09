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
  engine.dealingLoop = vi.fn(async () => {});
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
    expect(engine.dealingLoop).not.toHaveBeenCalled();
    expect(engine.tableFSM.state).toBe('closed');
  });

  it.each([null, '11111111-1111-1111-1111-111111111111'])(
    'records completed one-player waiting work without starting a hand (%s)',
    async (tournamentId) => {
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: tournamentId });
      loadSeatedPlayers.mockResolvedValue([seat(1)]);
      const engine = startable();
      const progress = vi.spyOn(engine, 'markProgress');
      let passes = 0;
      engine.sleep = async () => {
        expect(engine.msSinceProgress()).toBe(0);
        expect(engine.dealingLoop).not.toHaveBeenCalled();
        passes++;
        now += 181_000;
        if (passes === 2) engine.running = false;
      };
      try {
        await engine.start();
        expect(passes).toBe(2);
        expect(progress).toHaveBeenCalledTimes(2);
      } finally {
        await engine.stop();
      }
    }
  );

  it('does not refresh progress while the waiting roster read is unresolved', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    loadTable.mockResolvedValue({
      ...TABLE_ROW,
      tournament_id: '11111111-1111-1111-1111-111111111111',
    });
    let release!: (value: ReturnType<typeof seat>[]) => void;
    const held = new Promise<ReturnType<typeof seat>[]>((resolve) => {
      release = resolve;
    });
    loadSeatedPlayers.mockResolvedValueOnce([seat(1)]).mockReturnValue(held);
    const engine = startable();
    const progress = vi.spyOn(engine, 'markProgress');
    const started = engine.start();
    try {
      expect(await engine.ready).toBe(true);
      now += 181_000;
      expect(engine.msSinceProgress()).toBeGreaterThan(180_000);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      engine.running = false;
      release([seat(1)]);
      await started;
      await engine.stop();
    }
  });

  it('resolves false when start() fails before `waiting`', async () => {
    loadTable.mockRejectedValue(new Error('row is gone')); // not transient: no retry
    const engine = startable();
    engine.killForRestart = () => {
      engine.running = false;
    };
    await expect(engine.start()).rejects.toThrow('row is gone');
    expect(await engine.ready).toBe(false);
    await engine.stop();
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
    await engine.stop();
    expect(engine.dealingLoop).not.toHaveBeenCalled();
  });
});

describe('the on-demand door hands out `ready`, not `start()`', () => {
  it('ensureCashTableEngine returns engine.ready and keeps the start chain for its failure handling', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'GameServer.ts'), 'utf8');
    const start = src.indexOf('private async performCashTableEngineAdmission(');
    const end = src.indexOf('\n  /**\n   * Get a table engine by ID', start);
    const body = src.slice(start, end);
    expect(body).toContain(
      'const readyPromise = this.trackDirectTableEngineReadiness(tableId, engine)'
    );
    expect(body).toContain('const readiness = await readyPromise;');
    expect(body).toContain(
      "return this.dealerAdmissionIsCurrent(generation) ? readiness : 'not_wakeable';"
    );
    expect(body).not.toContain('return startPromise;');
    // The failure handling on the start chain stays: a failed start retires
    // that exact generation and retains one causal admission obligation.
    expect(body).toContain("reportError(startError, 'GameServer.direct_table_start_failed')");
    expect(body).toContain(
      "await this.recoverDirectTableEngine(tableId, engine, 'direct_start_failed', true)"
    );
  });
});

describe('a refusal to start settles ready (final sweep 2026-09-08)', () => {
  /* start()'s three refusals throw BEFORE the try whose catch settles
     `ready` false, so a refused engine left `ready` pending for ever - and
     GameServer's readiness tracker, GET /state, GET /actions and the cluster
     controller's wake job await it with no deadline. */
  it('a terminal engine refuses, and ready resolves false at once', async () => {
    const engine = startable();
    engine.terminal = true;
    await expect(engine.start()).rejects.toThrow(/terminal/);
    const r = await settled(engine.ready as Promise<boolean>);
    expect(r).toEqual({ done: true, value: false });
  });

  it('a second process-local generation refuses, and ready resolves false at once', async () => {
    const engine = startable();
    engine.engineLeaseAuthorityIsCurrent = () => true;
    engine.claimProcessOwnership = () => false;
    await expect(engine.start()).rejects.toThrow(/process-local generation/);
    const r = await settled(engine.ready as Promise<boolean>);
    expect(r).toEqual({ done: true, value: false });
  });
});
