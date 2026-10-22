import { describe, expect, it, vi } from 'vitest';
import { GameServer } from './GameServer.js';

/*
 * A TOURNAMENT TABLE WITH NO DEALER IS HANDED ON, NOT LEFT (2026-10-22).
 *
 * 02:48 UTC: Midweek Bounty table 9ca9c3a8 was killed in a database stall and
 * its manager never replaced it; eight players waited over half an hour. And a
 * closed PKO table whose stopped engine stayed registered read as six players
 * at a dead table and paged "Tables Have Stopped Dealing".
 */

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const EVENT = 'eeeeeeee-0000-4000-8000-000000000001';
const MIN = 60_000;

function eng(running: boolean, opts: { tournament?: boolean; progressMs?: number } = {}) {
  return {
    isRunning: () => running,
    isTournament: () => opts.tournament ?? true,
    msSinceProgress: () => opts.progressMs ?? 1_000,
  };
}

function manager(tableIds: string[], failing: Array<{ tableId: string; msFailing: number }> = []) {
  return {
    getTableIds: () => tableIds,
    getTablesFailingAdmission: () => failing,
    requestSuccessorForStuckTable: vi.fn(() => true),
  };
}

function server(tables: [string, any][], managers: [string, any][]) {
  const s = Object.create(GameServer.prototype) as any;
  s.tableEngines = new Map(tables);
  s.tournamentEngines = new Map(managers);
  s.tournamentOwnedTables = new Set(tables.filter(([, e]) => e.isTournament()).map(([id]) => id));
  s.stuckTournamentTableSince = new Map();
  s.stuckTournamentTableHandoffs = new Map();
  s.stuckTournamentLastHandoffAt = new Map();
  s.unregisterTableEngine = vi.fn((id: string) => {
    s.tableEngines.delete(id);
    return true;
  });
  return s;
}

const run = (s: any, now: number) => s.escalateStuckTournamentTables(now);

describe('a tournament table with no dealer is handed on, not left', () => {
  it('hands the event on once a stopped table has had no dealer for five minutes', () => {
    const m = manager([T, OTHER]);
    const s = server(
      [
        [T, eng(false)],
        [OTHER, eng(true)],
      ],
      [[EVENT, m]]
    );
    run(s, 0);
    run(s, 4 * MIN);
    expect(m.requestSuccessorForStuckTable).not.toHaveBeenCalled();
    run(s, 5 * MIN);
    expect(m.requestSuccessorForStuckTable).toHaveBeenCalledWith(T);
    expect(m.requestSuccessorForStuckTable).toHaveBeenCalledTimes(1);
  });

  it('counts a failing admission from when it began failing', () => {
    const m = manager([OTHER], [{ tableId: T, msFailing: 6 * MIN }]);
    const s = server([[OTHER, eng(true)]], [[EVENT, m]]);
    run(s, 10 * MIN);
    expect(m.requestSuccessorForStuckTable).toHaveBeenCalledWith(T);
  });

  it('leaves a running table alone', () => {
    const m = manager([T]);
    const s = server([[T, eng(true)]], [[EVENT, m]]);
    run(s, 0);
    run(s, 30 * MIN);
    expect(m.requestSuccessorForStuckTable).not.toHaveBeenCalled();
  });

  it('forgets a table that deals again before the threshold', () => {
    const m = manager([T]);
    const e = { ...eng(false), isRunning: vi.fn(() => false) };
    const s = server([[T, e]], [[EVENT, m]]);
    run(s, 0);
    e.isRunning.mockReturnValue(true);
    run(s, 3 * MIN);
    e.isRunning.mockReturnValue(false);
    run(s, 6 * MIN);
    expect(m.requestSuccessorForStuckTable).not.toHaveBeenCalled();
  });

  it('asks again on the next pass while other tables are still mid-hand', () => {
    const m = manager([T]);
    m.requestSuccessorForStuckTable.mockReturnValueOnce(false);
    const s = server([[T, eng(false)]], [[EVENT, m]]);
    run(s, 0);
    run(s, 5 * MIN);
    run(s, 5 * MIN + 5_000);
    expect(m.requestSuccessorForStuckTable).toHaveBeenCalledTimes(2);
  });

  it('spaces hand-offs per event and stops after three per table', () => {
    const m = manager([T]);
    const s = server([[T, eng(false)]], [[EVENT, m]]);
    run(s, 0);
    for (let t = 5 * MIN; t <= 120 * MIN; t += 5_000) run(s, t);
    expect(m.requestSuccessorForStuckTable).toHaveBeenCalledTimes(3);
    const calls = (m.requestSuccessorForStuckTable.mock.calls as unknown[]).length;
    expect(calls).toBe(3);
  });

  it('keeps the hand-off budget across a manager generation that owns the same table', () => {
    const first = manager([T]);
    const s = server([[T, eng(false)]], [[EVENT, first]]);
    run(s, 0);
    run(s, 5 * MIN);
    expect(first.requestSuccessorForStuckTable).toHaveBeenCalledTimes(1);
    s.tournamentEngines = new Map();
    run(s, 5 * MIN + 5_000);
    const second = manager([T]);
    s.tournamentEngines = new Map([[EVENT, second]]);
    for (let t = 6 * MIN; t <= 200 * MIN; t += 5_000) run(s, t);
    expect(second.requestSuccessorForStuckTable).toHaveBeenCalledTimes(2);
  });

  it('drops a stopped tournament engine that no manager owns', () => {
    const m = manager([OTHER]);
    const s = server(
      [
        [T, eng(false)],
        [OTHER, eng(true)],
      ],
      [[EVENT, m]]
    );
    run(s, 0);
    expect(s.unregisterTableEngine).toHaveBeenCalledTimes(1);
    expect(s.unregisterTableEngine.mock.calls[0][0]).toBe(T);
    expect(s.tableEngines.has(T)).toBe(false);
    expect(m.requestSuccessorForStuckTable).not.toHaveBeenCalled();
  });

  it('never drops a cash table or a running engine', () => {
    const cash = 'cccccccc-0000-4000-8000-000000000001';
    const s = server(
      [
        [cash, eng(false, { tournament: false })],
        [T, eng(true)],
      ],
      []
    );
    s.tournamentOwnedTables = new Set();
    run(s, 0);
    expect(s.unregisterTableEngine).not.toHaveBeenCalled();
  });
});
