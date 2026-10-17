/**
 * A SLOW DATABASE NEVER KILLS A TABLE, AND A SICK TABLE IS NEVER REBUILT IN
 * A LOOP (Dan, 2026-10-17: "THIS CAN NEVER HAPPEN" - the ClubArenaEngineKillStorm
 * alert, 74 engine kills in 15 minutes).
 *
 * Two production storms, two causes, both pinned here.
 *
 * 1. 2026-10-17 12:57:31-58Z - 74 kills on 42 tables in 27 seconds, every one
 *    `start_failed:start_load_table`. The table row had loaded. The read that
 *    failed was the crash-recovery read of hand_state_snapshots (0.1 ms on its
 *    unique index), held past the 8 s service_role statement timeout 57 times.
 *    Postgres answered 57014 - "I cancelled it, nothing was written" - and the
 *    engine took that for a code defect, because isTransientDbError carried
 *    55P03 and 40001 but not 57014, and because only the table-row read was
 *    retried at all. So every table that hit it was killed and rebuilt into
 *    the same slow second.
 *
 * 2. 2026-10-13 13:16-13:53Z - 35 cash tables rebuilt about every 1.8 s for
 *    37 minutes, 1,100-1,190 kills a minute. Both engine owners backed off
 *    between rebuilds, but cleared the backoff when the replacement reported
 *    READY - the early edge, before the table waits for players. A table that
 *    died after ready was therefore on attempt 1, 250 ms, every time.
 *
 * What this law holds:
 *   - a statement timeout is a transient database error, everywhere;
 *   - every boot read that refuses to guess (table row, hand number, crash
 *     snapshot, parked time banks) is retried in place and names its own
 *     phase, so a kill that still happens says which read caused it;
 *   - a table's failure streak survives ready and ends only when a
 *     replacement has stayed up; the wait grows, is capped, and is jittered so
 *     a fleet-wide blip does not rebuild every table in the same second;
 *   - a healthy table's first death is still replaced at once - players are
 *     waiting - and nothing here ever cancels a game: the table is retried for
 *     as long as it is the owner's, it is only retried less often.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const loadSeatedPlayers = vi.fn();
const loadTable = vi.fn();
const getActiveHandSnapshotFull = vi.fn();
const loadTimeBanksFromPark = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
    getActiveHandSnapshotFull: (...a: unknown[]) => getActiveHandSnapshotFull(...a),
    loadTimeBanksFromPark: (...a: unknown[]) => loadTimeBanksFromPark(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineBase } = await import('./ServerTableEngineBase.js');
const { TableRestartBackoff } = await import('./TableRestartBackoff.js');

const TABLE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
/** Exactly what PostgREST handed the engine 57 times at 12:57Z. */
const statementTimeout = () => ({
  code: '57014',
  details: null,
  hint: null,
  message: 'canceling statement due to statement timeout',
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const m of [loadTable, loadSeatedPlayers, getActiveHandSnapshotFull, loadTimeBanksFromPark])
    m.mockReset();
});

/**
 * Everything start() touches is stubbed EXCEPT the two reads on trial: the
 * crash snapshot (through the real checkCrashRecovery) and the parked time
 * banks (through the real readParkedTimeBanks).
 */
function bootable() {
  const engine = new ServerTableEngine(TABLE, null) as any;
  const killed: string[] = [];
  engine.killForRestart = (reason: string) => {
    killed.push(reason);
    engine.running = false;
  };
  engine.refreshOperatorFloor = async () => {};
  engine.sleep = async () => {};
  engine.seedHandCountFromHistory = async () => {};
  engine.restoreButtonFromHistory = async () => {};
  engine.restoreKillFromHistory = async () => {};
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.resolveOrphanedAddOns = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.scheduleHeartbeatCheck = () => {};
  engine.dealingLoop = async () => {};
  loadTable.mockResolvedValue(TABLE_ROW);
  loadSeatedPlayers.mockResolvedValue([seat(1), seat(2)]);
  getActiveHandSnapshotFull.mockResolvedValue(null);
  loadTimeBanksFromPark.mockResolvedValue({});
  return { engine, killed };
}

describe('a statement timeout is the database blinking, not the code being wrong', () => {
  const is = (e: unknown) => (ServerTableEngineBase as any).isTransientDbError(e);

  it('recognises 57014 by code and by the wording PostgREST forwards', () => {
    expect(is(statementTimeout())).toBe(true);
    expect(is(new Error('canceling statement due to statement timeout'))).toBe(true);
  });

  it('still refuses to excuse a permission, schema or code defect', () => {
    expect(is({ code: '42501', message: 'permission denied for table hand_state_snapshots' })).toBe(
      false
    );
    expect(is({ code: 'PGRST202', message: 'Could not find a function in the schema cache' })).toBe(
      false
    );
    expect(is(new TypeError('snapshot.handNumber is not a function'))).toBe(false);
  });

  it('treats it as an outage worth riding out, like a pool timeout', () => {
    const outage = (e: unknown) => (ServerTableEngineBase as any).isStartReadOutage(e);
    expect(outage(statementTimeout())).toBe(true);
    expect(outage({ code: 'PGRST002', message: 'cache unavailable' })).toBe(true);
    expect(outage(new Error('TypeError: fetch failed'))).toBe(false);
  });
});

describe(
  'the 12:57Z storm, replayed: boot reads ride out a slow database',
  { timeout: 60_000 },
  () => {
    it('a crash-snapshot read cancelled on the statement timeout is read again, not killed', async () => {
      const { engine, killed } = bootable();
      getActiveHandSnapshotFull
        .mockRejectedValueOnce(statementTimeout())
        .mockRejectedValueOnce(statementTimeout())
        .mockResolvedValue(null);

      await engine.start();

      expect(getActiveHandSnapshotFull).toHaveBeenCalledTimes(3);
      expect(killed).toEqual([]);
      expect(engine.tableInfo).toMatchObject({ id: TABLE });
      await engine.stop();
    });

    it('keeps reading through a database that stays slow for most of a minute', async () => {
      const { engine, killed } = bootable();
      let clock = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      engine.sleep = async (ms: number) => {
        clock += ms;
      };
      // More than START_LOAD_ATTEMPTS: an outage is not held to five quick tries.
      for (let i = 0; i < 8; i++)
        getActiveHandSnapshotFull.mockRejectedValueOnce(statementTimeout());
      getActiveHandSnapshotFull.mockResolvedValue(null);
      try {
        await engine.start();
        expect(getActiveHandSnapshotFull).toHaveBeenCalledTimes(9);
        expect(killed).toEqual([]);
      } finally {
        await engine.stop();
      }
    });

    it('a parked time-bank read cancelled on the statement timeout is read again, not killed', async () => {
      const { engine, killed } = bootable();
      loadTimeBanksFromPark.mockRejectedValueOnce(statementTimeout()).mockResolvedValue({});

      await engine.start();

      expect(loadTimeBanksFromPark).toHaveBeenCalledTimes(2);
      expect(killed).toEqual([]);
      await engine.stop();
    });

    it('a real defect in a later boot read still fails at once, and names that read', async () => {
      const { engine, killed } = bootable();
      getActiveHandSnapshotFull.mockRejectedValue(new TypeError('state_json is not iterable'));

      await expect(engine.start()).rejects.toThrow('state_json is not iterable');

      expect(getActiveHandSnapshotFull).toHaveBeenCalledTimes(1);
      // Not `start_load_table`: that label on every boot read is why the
      // 12:57Z rows pointed at a read that had succeeded.
      expect(killed).toEqual(['start_failed:start_crash_recovery']);
      await engine.stop();
    });

    it('an outage longer than the budget hands the table back once, naming the read', async () => {
      const { engine, killed } = bootable();
      let clock = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      engine.sleep = async (ms: number) => {
        clock += ms;
      };
      loadTimeBanksFromPark.mockRejectedValue(statementTimeout());
      try {
        await expect(engine.start()).rejects.toMatchObject({ code: '57014' });
        expect(clock).toBe(ServerTableEngineBase['START_READ_OUTAGE_BUDGET_MS' as never]);
        expect(killed).toEqual(['start_failed:start_time_bank_restore']);
      } finally {
        await engine.stop();
      }
    });

    it('the hand-number read is retried the same way (source, it reads the client directly)', () => {
      const SOURCE = readFileSync(
        resolve(process.cwd(), 'src/engine/ServerTableEngineBase.ts'),
        'utf8'
      );
      const seed = sliceMethod(SOURCE, 'private async seedHandCountFromHistory(');
      expect(seed).toContain("this.retryStartRead('start_seed_hand_count'");
      const crash = sliceMethod(SOURCE, 'async checkCrashRecovery(');
      expect(crash).toContain("this.retryStartRead('start_crash_recovery'");
      const banks = sliceMethod(SOURCE, 'protected async readParkedTimeBanks(');
      expect(banks).toContain("this.retryStartRead('start_time_bank_restore'");
    });
  }
);

describe('the 10-13 storm, replayed: a table that keeps failing is retried less often', () => {
  /** A replacement that reaches ready 1.5 s after it is built and dies 0.3 s later. */
  function replay(minutes: number, resetOnReady: boolean) {
    let clock = 0;
    const backoff = new TableRestartBackoff({ now: () => clock, random: () => 0.5 });
    let rebuilds = 0;
    let legacyAttempt = 0;
    while (clock < minutes * 60_000) {
      let delay: number;
      if (resetOnReady) {
        // The owners as they were: attempt count cleared at every ready.
        legacyAttempt += 1;
        delay = Math.min(250 * 2 ** Math.min(legacyAttempt - 1, 6), 15_000);
      } else {
        delay = backoff.recordFailure('t').delayMs;
      }
      clock += delay + 1_500;
      if (resetOnReady) legacyAttempt = 0;
      else backoff.recordReady('t');
      clock += 300;
      rebuilds += 1;
    }
    return rebuilds;
  }

  it('reproduces the loop the old reset produced', () => {
    // 37 minutes at ~2.05 s a turn: the ~1,100 a table that the storm showed.
    expect(replay(37, true)).toBeGreaterThan(1_000);
  });

  it('holds the same failing table to a few rebuilds a minute', () => {
    const rebuilds = replay(37, false);
    expect(rebuilds).toBeLessThan(37 * 4);
    // ...and never gives up on it: it is still being retried at the end.
    expect(rebuilds).toBeGreaterThan(37);
  });

  it('keeps the streak across ready and ends it only on proof of stability', () => {
    let clock = 0;
    const backoff = new TableRestartBackoff({ now: () => clock, random: () => 1 });
    expect(backoff.recordFailure('t')).toEqual({ failures: 1, delayMs: 250 });
    backoff.recordReady('t');
    clock += 1_000;
    expect(backoff.isRepeating('t')).toBe(true);
    expect(backoff.recordFailure('t')).toEqual({ failures: 2, delayMs: 500 });
    backoff.recordReady('t');
    clock += TableRestartBackoff.STABLE_MS;
    expect(backoff.isRepeating('t')).toBe(false);
    // Stable for two minutes: the next death is a fresh first failure.
    expect(backoff.recordFailure('t')).toEqual({ failures: 1, delayMs: 250 });
  });

  it('caps the wait and spreads it, so a fleet-wide blip does not rebuild in lockstep', () => {
    const low = new TableRestartBackoff({ random: () => 0 });
    const high = new TableRestartBackoff({ random: () => 1 });
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 40; i++) {
      lo = low.recordFailure('t').delayMs;
      hi = high.recordFailure('t').delayMs;
    }
    expect(hi).toBe(TableRestartBackoff.CAP_MS);
    expect(lo).toBe(TableRestartBackoff.CAP_MS / 2);
  });

  it('a table that never failed is not repeating, and its first death is replaced at once', () => {
    const backoff = new TableRestartBackoff();
    expect(backoff.isRepeating('healthy')).toBe(false);
  });
});

describe('both engine owners drive the wait from the streak, not from the ready-cleared count', () => {
  const GAME_SERVER = readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');
  const MANAGER = readFileSync(
    resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
    'utf8'
  );

  it('cash: the delay is the streak, ready starts the clock, a repeat death is deferred', () => {
    const schedule = sliceMethod(GAME_SERVER, 'private scheduleDirectTableRecovery(');
    expect(schedule).toContain('this.directTableRestartBackoff.recordFailure(tableId)');
    expect(schedule).not.toMatch(/2 \*\* Math\.min\(attempt/);
    const ready = sliceMethod(GAME_SERVER, 'private trackDirectTableEngineReadiness(');
    expect(ready).toContain('this.directTableRestartBackoff.recordReady(tableId)');
    expect(ready).not.toContain('directTableRestartBackoff.forget');
    const recovery = sliceMethod(GAME_SERVER, 'private async performDirectTableEngineRecovery(');
    expect(recovery).toContain('this.directTableRestartBackoff.isRepeating(tableId)');
  });

  it('tournament manager admission: the same streak, ended only by an admitted, running manager', () => {
    // The manager's attempt count is cleared when a retry wins its lease, before
    // the start that may throw again - the table loop, one level up.
    const schedule = sliceMethod(GAME_SERVER, 'private scheduleTournamentManagerAdmissionRetry(');
    expect(schedule).toContain('this.tournamentManagerRestartBackoff.recordFailure(tournamentId)');
    expect(schedule).not.toMatch(/2 \*\* Math\.min\(attempt/);
    const finish = sliceMethod(GAME_SERVER, 'private async finishTournamentManagerAdmission(');
    expect(finish).toContain('this.tournamentManagerRestartBackoff.recordReady(tournamentId)');
    expect(finish.indexOf('recordReady')).toBeGreaterThan(
      finish.lastIndexOf('!manager.isRunning()')
    );
  });

  it('tournament: the same, without touching the in-flight roster the stage gate reads', () => {
    const schedule = sliceMethod(MANAGER, 'private scheduleManagedTableEngineRecovery(');
    expect(schedule).toContain('this.tableRestartBackoff.recordFailure(tableId)');
    expect(schedule).not.toMatch(/2 \*\* Math\.min\(attempt/);
    expect(MANAGER).toContain('this.tableRestartBackoff.recordReady(tableId);');
    const recovery = sliceMethod(MANAGER, 'private async performManagedTableEngineRecovery(');
    expect(recovery).toContain('this.tableRestartBackoff.isRepeating(tableId)');
  });
});
