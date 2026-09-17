/**
 * LAW: THE QUIET TOURNAMENT TABLE BACKS OFF (2026-09-16).
 *
 * A table below its deal minimum waits in start()'s wait-for-players loop,
 * reading `table_seats` every pass. On a tournament table that is where a
 * decided event's last player sits until the event is finished, and on
 * 2026-09-16 there were 2,069 of them: 18,205 of the 22,018 database
 * requests the engine made in one 45-second sample were that one read, all
 * 128 connections of the process's HTTPS pool were busy with 250 to 720
 * requests queued behind them, a one-row read cost 350 to 1,400 ms from
 * inside the process, and the elimination sweeps that would have finished
 * those events waited in the same queue. The poll that waits for a table to
 * fill was why the platform could not finish the events that would have
 * emptied it.
 *
 * So: a tournament table whose roster did not change doubles its pause each
 * pass, 5, 10, 20, 40, then 60 seconds; any roster change resets it; a cash
 * table keeps its five seconds because anyone may sit down from the lobby at
 * any moment; the manager can end a pause the instant it has seated someone;
 * and a stop ends it too, so teardown never waits a minute for a sleeping
 * loop. Every pass still marks progress, and the cap stays far below the
 * 180-second zombie rebuild.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
const { ServerTableEngineBase } = await import('./ServerTableEngineBase.js');

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const TOURNAMENT = '11111111-1111-1111-1111-111111111111';

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

/** Everything after the opening read stubbed; `sleep` records what it was asked for. */
function startable(pauses: number[], stopAfter: number) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.sleep = async (ms: number) => {
    pauses.push(ms);
    if (pauses.length >= stopAfter) engine.running = false;
  };
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

/** Everything after the opening read stubbed; `sleep` is the engine's own, driven by fake timers. */
function pacedByRealTimers() {
  const engine = new ServerTableEngine(TABLE) as any;
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

describe('the quiet tournament table backs off', () => {
  it('doubles the pause on an unchanged tournament roster and caps it at a minute', async () => {
    loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: TOURNAMENT });
    loadSeatedPlayers.mockResolvedValue([seat(1)]);
    const pauses: number[] = [];
    const engine = startable(pauses, 8);
    const progress = vi.spyOn(engine, 'markProgress');
    await engine.start();
    expect(pauses).toEqual([5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(progress).toHaveBeenCalledTimes(8);
    expect(engine.dealingLoop).not.toHaveBeenCalled();
    expect(ServerTableEngineBase.WAIT_FOR_PLAYERS_MAX_POLL_MS).toBeLessThan(180_000);
    await engine.stop();
  });

  it('resets to five seconds when the roster changes', async () => {
    loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: TOURNAMENT });
    loadSeatedPlayers
      .mockResolvedValueOnce([seat(1)])
      .mockResolvedValueOnce([seat(1)])
      .mockResolvedValueOnce([seat(1)])
      .mockResolvedValueOnce([seat(2)]) // the lone player was replaced: a change
      .mockResolvedValue([seat(2)]);
    const pauses: number[] = [];
    const engine = startable(pauses, 6);
    await engine.start();
    expect(pauses).toEqual([5_000, 5_000, 10_000, 5_000, 5_000, 10_000]);
    await engine.stop();
  });

  it('keeps a cash table at five seconds: anyone may sit down at any moment', async () => {
    loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: null });
    loadSeatedPlayers.mockResolvedValue([seat(1)]);
    const pauses: number[] = [];
    const engine = startable(pauses, 5);
    await engine.start();
    expect(pauses).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    await engine.stop();
  });

  it('a seat arrival announced by the manager ends the pause at once and restarts the clock', async () => {
    vi.useFakeTimers();
    loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: TOURNAMENT });
    loadSeatedPlayers.mockResolvedValue([seat(1)]);
    const engine = pacedByRealTimers();
    const asked: number[] = [];
    const realSleep = engine.sleep.bind(engine);
    engine.sleep = (ms: number) => {
      asked.push(ms);
      return realSleep(ms);
    };
    const started = engine.start();
    try {
      // Walk the clock until the loop has asked for its first twenty-second pause.
      for (let i = 0; i < 40 && asked.at(-1) !== 20_000; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(asked.at(-1)).toBe(20_000);
      const beforeWake = loadSeatedPlayers.mock.calls.length;
      // The manager seats someone: the loop looks now, not in twenty seconds.
      engine.wakeWaitingForPlayers();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadSeatedPlayers.mock.calls.length).toBe(beforeWake + 1);
      expect(asked.at(-1)).toBe(5_000);
    } finally {
      engine.running = false;
      engine.wakeWaitingForPlayers();
      await vi.advanceTimersByTimeAsync(1);
      await started;
      await engine.stop();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'a tournament move wakes the quiet loop and claims its physical gate (pending settlement: %s)',
    async (pendingSettlement) => {
      vi.useFakeTimers();
      loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: TOURNAMENT });
      loadSeatedPlayers.mockResolvedValue([seat(1)]);
      const engine = pacedByRealTimers();
      const asked: number[] = [];
      const realSleep = engine.sleep.bind(engine);
      engine.sleep = (ms: number) => {
        asked.push(ms);
        return realSleep(ms);
      };
      const started = engine.start();
      const owner = 'quiet-source-manager-generation';
      let finishSettlement = () => {};
      try {
        // The real start loop must be asleep, not manually placed at the gate.
        for (let i = 0; i < 100 && asked.at(-1) !== 60_000; i++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(asked.at(-1)).toBe(60_000);
        expect(engine.waitForPlayersWake).not.toBeNull();
        expect(engine.handForHandResolve).toBeNull();
        const rosterReads = loadSeatedPlayers.mock.calls.length;

        if (pendingSettlement) {
          const settlement = new Promise<void>((resolve) => {
            finishSettlement = resolve;
          });
          engine.postHandTasksPromise = settlement;
          engine.trackSettlementInFlight(settlement);
        }
        let result: boolean | undefined;
        const parked = engine.parkForTournamentMove(owner, 1_000).then((value: boolean) => {
          result = value;
          return value;
        });
        if (pendingSettlement) {
          await vi.advanceTimersByTimeAsync(1);
          expect(engine.handForHandResolve).not.toBeNull();
          expect(result).toBeUndefined();
          expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(false);
          finishSettlement();
        }
        await vi.advanceTimersByTimeAsync(1_000);
        expect(result).toBe(true);
        await expect(parked).resolves.toBe(true);
        expect(engine.handForHandResolve).not.toBeNull();
        expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
        expect(loadSeatedPlayers).toHaveBeenCalledTimes(rosterReads);
        expect(engine.dealingLoop).not.toHaveBeenCalled();

        // The successfully claimed owner must not expire like an unclaimed
        // 15-second park, and an unrelated release cannot open its boundary.
        await vi.advanceTimersByTimeAsync(15_001);
        engine.releaseTournamentMovePause('another-manager-generation');
        expect(engine.handForHandResolve).not.toBeNull();
        expect(engine.claimedTournamentMovePauseOwners.has(owner)).toBe(true);
        engine.releaseTournamentMovePause(owner);
        await vi.advanceTimersByTimeAsync(1);
        expect(loadSeatedPlayers).toHaveBeenCalledTimes(rosterReads + 1);
        expect(asked.at(-1)).toBe(5_000);
      } finally {
        finishSettlement();
        engine.running = false;
        engine.releaseTournamentMovePause(owner);
        engine.wakeWaitingForPlayers();
        await vi.advanceTimersByTimeAsync(1_001);
        await started;
        await engine.stop();
        vi.useRealTimers();
      }
    }
  );

  it('a stop ends the pause so teardown never waits out a minute', async () => {
    vi.useFakeTimers();
    loadTable.mockResolvedValue({ ...TABLE_ROW, tournament_id: TOURNAMENT });
    loadSeatedPlayers.mockResolvedValue([seat(1)]);
    const engine = pacedByRealTimers();
    const asked: number[] = [];
    const realSleep = engine.sleep.bind(engine);
    engine.sleep = (ms: number) => {
      asked.push(ms);
      return realSleep(ms);
    };
    let startResolved = false;
    const started = engine.start().then(() => (startResolved = true));
    try {
      for (let i = 0; i < 40 && asked.at(-1) !== 20_000; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(asked.at(-1)).toBe(20_000);
      // The loop is inside a twenty-second pause. A stop must not wait it out.
      const stopped = engine.stop();
      await vi.advanceTimersByTimeAsync(1);
      expect(startResolved).toBe(true);
      await stopped;
      expect(engine.dealingLoop).not.toHaveBeenCalled();
    } finally {
      engine.running = false;
      engine.wakeWaitingForPlayers();
      await vi.advanceTimersByTimeAsync(1);
      await started;
      await engine.stop().catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
