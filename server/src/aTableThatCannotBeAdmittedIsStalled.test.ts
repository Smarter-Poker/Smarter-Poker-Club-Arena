/**
 * A TOURNAMENT TABLE ITS MANAGER CANNOT ADMIT IS A STALLED TABLE (2026-10-03)
 *
 * Heads-up SNG b290375a sat RUNNING with two real players and 0 hands for 6.5
 * hours. Its only table's F06 admission was refused every 15 s: an engine was
 * created, refused, stopped ("Dealt 0 hands") and removed, so between retries
 * the table had no engine and /health reported stalledTableCount 0. The
 * manager now remembers when each table it is trying to bring back first
 * failed, and /health counts and names one failing for over 120 s - without
 * feeding it to the liveness verdict, which would restart healthy tables.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from './GameServer.js';
import { TournamentManagerBase } from './tournament/TournamentManagerBase.js';

afterEach(() => vi.restoreAllMocks());

const BASE = readFileSync(
  resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

type FailingProbe = {
  tableAdmissionFailingSince: Map<string, number>;
  tableEngineRecoveryTimers: Map<string, unknown>;
  tableEngineRecoveryExpected: Map<string, unknown>;
  tableEngineRecoveryAttempts: Map<string, number>;
  clearLifecycleTimeout: (timer: unknown) => void;
};

function probe(): FailingProbe {
  return {
    tableAdmissionFailingSince: new Map(),
    tableEngineRecoveryTimers: new Map(),
    tableEngineRecoveryExpected: new Map(),
    tableEngineRecoveryAttempts: new Map(),
    clearLifecycleTimeout: () => {},
  };
}

const proto = TournamentManagerBase.prototype as unknown as {
  getTablesFailingAdmission(
    this: FailingProbe,
    now?: number
  ): Array<{
    tableId: string;
    msFailing: number;
  }>;
  clearManagedTableEngineRecovery(this: FailingProbe, tableId: string, reset?: boolean): void;
  clearManagedTableEngineRecoveries(this: FailingProbe): void;
};

describe('the manager remembers when a table started failing admission', () => {
  it('reports each failing table with its age', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set('t1', 1_000);
    expect(proto.getTablesFailingAdmission.call(m, 181_000)).toEqual([
      { tableId: 't1', msFailing: 180_000 },
    ]);
  });

  it('forgets a table only when its engine reports ready or the manager retires', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set('t1', 1_000);
    m.tableAdmissionFailingSince.set('t2', 1_000);
    // A retry that keeps its attempt count is not a recovery.
    proto.clearManagedTableEngineRecovery.call(m, 't1', false);
    expect(m.tableAdmissionFailingSince.has('t1')).toBe(true);
    proto.clearManagedTableEngineRecovery.call(m, 't1');
    expect(m.tableAdmissionFailingSince.has('t1')).toBe(false);
    proto.clearManagedTableEngineRecoveries.call(m);
    expect(m.tableAdmissionFailingSince.size).toBe(0);
  });

  it('stamps the first failure, not the latest retry', () => {
    const schedule = BASE.slice(
      BASE.indexOf('private scheduleManagedTableEngineRecovery('),
      BASE.indexOf('/** Admit a table retired after a failed start')
    );
    expect(schedule).toMatch(
      /if \(!this\.tableAdmissionFailingSince\.has\(tableId\)\) \{\s*this\.tableAdmissionFailingSince\.set\(tableId, Date\.now\(\)\);\s*\}\s*if \(this\.tableEngineRecoveryTimers\.has\(tableId\)\) return;/
    );
  });
});

describe('/health counts a table its manager cannot admit as stalled', () => {
  function serverWith(tables: Array<{ tableId: string; msFailing: number }>): GameServer {
    const server = new GameServer();
    const engines = (server as unknown as { tournamentEngines: Map<string, unknown> })
      .tournamentEngines;
    engines.set('b290375a-5c44-4593-a6a7-09dc844090f3', {
      getPublicLiveTableFormat: () => 'sng',
      getPublicLiveTableClubId: () => null,
      getTableIds: () => [],
      getTablesFailingAdmission: () => tables,
    });
    return server;
  }

  it('names a table failing admission for over two minutes', () => {
    const before = new GameServer().getStatus();
    const status = serverWith([
      { tableId: '4f6b8c6f-85a3-4e58-9f9a-34d05a06c6fe', msFailing: 23_400_000 },
      { tableId: 'fresh-retry', msFailing: 30_000 },
    ]).getStatus();
    expect(status.stalledTableCount).toBe(1);
    expect(status.stalledTables).toEqual([
      {
        tableId: '4f6b8c6f-85a3-4e58-9f9a-34d05a06c6fe',
        dealable: 0,
        secsIdle: 23_400,
        admission: 'failing',
      },
    ]);
    expect(status.tableLivenessSummary.stalled).toBe(1);
    // Identification only: the liveness verdict is not moved by it.
    expect(status.deadStalledCount).toBe(before.deadStalledCount);
    expect(status.wholeFleetStalled).toBe(before.wholeFleetStalled);
  });

  it('counts nothing when every table is admitted', () => {
    expect(serverWith([]).getStatus().stalledTableCount).toBe(0);
  });
});
