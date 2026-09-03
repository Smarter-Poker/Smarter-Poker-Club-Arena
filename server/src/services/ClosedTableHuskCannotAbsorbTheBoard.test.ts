/**
 * The SNG board died for ten hours because a REGISTERING game that owned a
 * CLOSED table still counted as covering its price point.
 *
 * Thirty-two heads-up SNGs, each owning exactly one table with
 * status='closed', sat REGISTERING fifteen to twenty-five hours past their
 * start time. Nobody could sit at them, so they never filled and never
 * started - and because ensureBoardOpen asked only whether a table row
 * EXISTED, all thirty-two configs read as covered and not one replacement was
 * opened. Zero SNGs created in ten hours while Spins ran at 150/hr.
 *
 * These pins are the three rules that broke, one behavioural and two on the
 * shipped source of the call site itself, because the call site is where the
 * regression would come back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJoinableTableRow } from './TournamentRecurringService.js';
import {
  planTableReopens,
  isJoinableTable,
  isLiveTournamentStatus,
  MIN_SEATS_TO_REOPEN_RUNNING,
} from './liveTournamentTableRecovery.js';
import {
  canCloseTournamentTable,
  isTerminalTournamentStatus,
  tablesASweepMayClose,
} from './tableCloseGuard.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);
const GAME_SERVER = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');

describe('a closed table is not a joinable table', () => {
  it('a waiting table is joinable', () => {
    expect(isJoinableTableRow({ status: 'waiting', is_deleted: false })).toBe(true);
  });

  it('a running table is joinable', () => {
    expect(isJoinableTableRow({ status: 'running', is_deleted: false })).toBe(true);
  });

  it('a CLOSED table is not - this is the whole outage', () => {
    expect(isJoinableTableRow({ status: 'closed', is_deleted: false })).toBe(false);
  });

  it('case does not rescue it', () => {
    expect(isJoinableTableRow({ status: 'CLOSED' })).toBe(false);
  });

  it('a deleted row is not joinable however it is statused', () => {
    expect(isJoinableTableRow({ status: 'waiting', is_deleted: true })).toBe(false);
  });

  it('a missing row is not joinable', () => {
    expect(isJoinableTableRow(null)).toBe(false);
  });
});

describe('ensureBoardOpen asks for joinability, not existence', () => {
  it('reads status and is_deleted, not just the id', () => {
    expect(RECURRING).toContain("'tournament_id, status, is_deleted'");
  });

  it('filters the set through isJoinableTableRow', () => {
    expect(RECURRING).toContain(
      '.filter((r) => isJoinableTableRow(r as TournamentTableJoinability))'
    );
  });

  it('coverage is decided from the joinable set', () => {
    expect(RECURRING).toContain('withJoinableTable.has(r.id)');
    // The old name is gone: a rename that left the old set behind would pass
    // every test above and still ship the bug.
    expect(RECURRING).not.toContain('withTable.has(r.id)');
  });
});

describe('the recovery sweep reopens a table closed under a live tournament', () => {
  const closedTable = {
    id: 'tbl-closed',
    tournament_id: 'sng-1',
    status: 'closed',
    is_deleted: false,
    created_at: '2026-08-30T17:31:15Z',
  };

  it('REGISTERING and RUNNING are live; everything else is not', () => {
    expect(isLiveTournamentStatus('REGISTERING')).toBe(true);
    expect(isLiveTournamentStatus('RUNNING')).toBe(true);
    expect(isLiveTournamentStatus('COMPLETED')).toBe(false);
    expect(isLiveTournamentStatus('CANCELLED')).toBe(false);
    expect(isLiveTournamentStatus('ANNOUNCED')).toBe(false);
    expect(isLiveTournamentStatus(null)).toBe(false);
  });

  it('reopens the husk to waiting and restarts its human window', () => {
    const plans = planTableReopens(
      [{ id: 'sng-1', status: 'REGISTERING' }],
      [closedTable],
      new Map()
    );
    expect(plans).toEqual([
      {
        tableId: 'tbl-closed',
        tournamentId: 'sng-1',
        toStatus: 'waiting',
        currentPlayers: 0,
        refreshHumanWindow: true,
      },
    ]);
  });

  it('leaves a tournament alone when it still owns one joinable table', () => {
    const plans = planTableReopens(
      [{ id: 'sng-1', status: 'REGISTERING' }],
      [closedTable, { ...closedTable, id: 'tbl-open', status: 'waiting' }],
      new Map()
    );
    expect(plans).toEqual([]);
  });

  it('leaves a tournament with no table at all to the creation path', () => {
    expect(planTableReopens([{ id: 'sng-1', status: 'REGISTERING' }], [], new Map())).toEqual([]);
  });

  it('never revives a deleted row', () => {
    const plans = planTableReopens(
      [{ id: 'sng-1', status: 'REGISTERING' }],
      [{ ...closedTable, is_deleted: true }],
      new Map()
    );
    expect(plans).toEqual([]);
  });

  it('puts a RUNNING field back on its felt with its seat count resynced', () => {
    const plans = planTableReopens(
      [{ id: 'mtt-1', status: 'RUNNING' }],
      [{ ...closedTable, tournament_id: 'mtt-1' }],
      new Map([['tbl-closed', 6]])
    );
    expect(plans).toEqual([
      {
        tableId: 'tbl-closed',
        tournamentId: 'mtt-1',
        toStatus: 'running',
        currentPlayers: 6,
        refreshHumanWindow: false,
      },
    ]);
  });

  it('does NOT resurrect a RUNNING game that is already decided', () => {
    const plans = planTableReopens(
      [{ id: 'mtt-1', status: 'RUNNING' }],
      [{ ...closedTable, tournament_id: 'mtt-1' }],
      new Map([['tbl-closed', MIN_SEATS_TO_REOPEN_RUNNING - 1]])
    );
    expect(plans).toEqual([]);
  });

  it('ignores a tournament that has finished', () => {
    expect(
      planTableReopens([{ id: 'sng-1', status: 'COMPLETED' }], [closedTable], new Map())
    ).toEqual([]);
  });

  it('reopens at most ONE table per tournament, the newest', () => {
    const plans = planTableReopens(
      [{ id: 'mtt-1', status: 'RUNNING' }],
      [
        { ...closedTable, id: 'old', tournament_id: 'mtt-1', created_at: '2026-08-30T10:00:00Z' },
        { ...closedTable, id: 'new', tournament_id: 'mtt-1', created_at: '2026-08-30T18:00:00Z' },
      ],
      new Map([
        ['old', 4],
        ['new', 4],
      ])
    );
    expect(plans.map((p) => p.tableId)).toEqual(['new']);
  });

  it('shares its joinability rule with the board guard', () => {
    expect(isJoinableTable(closedTable)).toBe(false);
    expect(isJoinableTable({ ...closedTable, status: 'waiting' })).toBe(true);
  });

  it('is scheduled by GameServer, not merely written', () => {
    expect(GAME_SERVER).toContain('reopenTablesClosedUnderLiveTournaments()');
    expect(GAME_SERVER).toContain('this.lastClosedTableReopenSweepAt = Date.now();');
  });

  it('reopens only a row that is still closed, so it cannot race an opener', () => {
    expect(GAME_SERVER).toContain(".eq('status', 'closed');");
  });
});

describe('a sweep may not close a table under a live tournament', () => {
  it('COMPLETED and CANCELLED are the only terminal statuses', () => {
    expect(isTerminalTournamentStatus('COMPLETED')).toBe(true);
    expect(isTerminalTournamentStatus('cancelled')).toBe(true);
    expect(isTerminalTournamentStatus('RUNNING')).toBe(false);
    expect(isTerminalTournamentStatus('REGISTERING')).toBe(false);
  });

  it('refuses a sweep close on a REGISTERING tournament', () => {
    expect(canCloseTournamentTable('REGISTERING', 'sweep')).toBe(false);
  });

  it('refuses a sweep close on a RUNNING tournament', () => {
    expect(canCloseTournamentTable('RUNNING', 'sweep')).toBe(false);
  });

  it('refuses a sweep close when the status could not be read', () => {
    expect(canCloseTournamentTable(undefined, 'sweep')).toBe(false);
  });

  it('allows a sweep close once the tournament is finished', () => {
    expect(canCloseTournamentTable('COMPLETED', 'sweep')).toBe(true);
    expect(canCloseTournamentTable('CANCELLED', 'sweep')).toBe(true);
  });

  it('never blocks the tournament own lifecycle - break, finish, deal, cancel', () => {
    expect(canCloseTournamentTable('RUNNING', 'tournament_lifecycle')).toBe(true);
    expect(canCloseTournamentTable('RUNNING', 'tournament_cancelled')).toBe(true);
  });

  it('filters a batch down to the tables a sweep may actually close', () => {
    const kept = tablesASweepMayClose(
      [
        { tableId: 'a', tournamentId: 'done' },
        { tableId: 'b', tournamentId: 'live' },
        { tableId: 'c', tournamentId: 'unknown' },
      ],
      new Map([
        ['done', 'COMPLETED'],
        ['live', 'RUNNING'],
      ])
    );
    expect(kept).toEqual(['a']);
  });

  it('the orphan sweep re-reads the status in the same pass as the write', () => {
    expect(GAME_SERVER).toContain('tablesASweepMayClose(batchRows, statusByTournament)');
    expect(GAME_SERVER).toContain('GameServer.orphan_status_reread_failed');
  });
});
