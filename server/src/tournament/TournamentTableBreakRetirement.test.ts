import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { MoveInstruction } from '../engine/TableBalancer.js';
import { supabase } from '../services/supabase.js';
import * as errorReporter from '../services/errorReporter.js';
import { TournamentManager } from './TournamentManager.js';
import { unregisterOwnedTournamentTableEngine } from './TournamentManagerOwnership.js';

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TABLE_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const LEASE_GENERATION = 'cccccccc-0000-4000-8000-000000000001';

class TableBreakHarness extends TournamentManager {
  constructor(gameServer: GameServer) {
    super(TOURNAMENT_ID, gameServer, LEASE_GENERATION, performance.now() + 20_000);
    this.running = true;
  }

  addEngine(engine: ServerTableEngine): void {
    this.tableEngines.set(TABLE_ID, engine);
  }

  close(engine: ServerTableEngine): Promise<boolean> {
    return this.closeBrokenTableAndReleaseEngine(TABLE_ID, engine);
  }

  public override executePlayerMoves(moves: MoveInstruction[]): Promise<number> {
    return super.executePlayerMoves(moves);
  }

  ownsEngine(engine: ServerTableEngine): boolean {
    return this.tableEngines.get(TABLE_ID) === engine;
  }
}

function closeReceipt() {
  return {
    data: {
      ok: true,
      reason: 'closed',
      table_id: TABLE_ID,
      tournament_id: TOURNAMENT_ID,
      status: 'closed',
      current_players: 0,
    },
    error: null,
  };
}

function fixture() {
  const events: string[] = [];
  const engine = {
    stop: vi.fn(async () => {
      events.push('engine-stopped');
    }),
    hasReleasedProcessOwnership: vi.fn(() => true),
  } as unknown as ServerTableEngine;
  const globalEngines = new Map([[TABLE_ID, engine]]);
  const tournamentOwnedTables = new Set([TABLE_ID]);
  const hubDrop = vi.fn(() => events.push('hub-dropped'));
  const unregister = vi.fn((tableId: string, expected: ServerTableEngine) => {
    events.push('global-unregistered');
    return unregisterOwnedTournamentTableEngine(
      globalEngines,
      tournamentOwnedTables,
      tableId,
      expected,
      hubDrop
    );
  });
  const manager = new TableBreakHarness({
    unregisterTournamentTableEngine: unregister,
  } as unknown as GameServer);
  manager.addEngine(engine);
  return {
    events,
    engine,
    globalEngines,
    tournamentOwnedTables,
    hubDrop,
    unregister,
    manager,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tournament table-break retirement is one durable ownership chain', () => {
  it('stops, proves the exact DB close, then releases every registry by identity CAS', async () => {
    const f = fixture();
    vi.spyOn(supabase, 'rpc').mockImplementation(((name: string, args: Record<string, unknown>) => {
      f.events.push('db-closed');
      expect(name).toBe('fn_close_empty_tournament_table');
      expect(args).toEqual({
        p_tournament_id: TOURNAMENT_ID,
        p_table_id: TABLE_ID,
        p_lease_generation: LEASE_GENERATION,
      });
      return Promise.resolve(closeReceipt());
    }) as never);

    await expect(f.manager.close(f.engine)).resolves.toBe(true);
    expect(f.events).toEqual(['engine-stopped', 'db-closed', 'global-unregistered', 'hub-dropped']);
    expect(f.manager.ownsEngine(f.engine)).toBe(false);
    expect(f.globalEngines.has(TABLE_ID)).toBe(false);
    expect(f.tournamentOwnedTables.has(TABLE_ID)).toBe(false);
    expect(f.unregister).toHaveBeenCalledWith(TABLE_ID, f.engine);
  });

  it('retains the stopped generation everywhere until a later call proves a possibly committed close', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
      .mockResolvedValueOnce(closeReceipt() as never);

    await expect(f.manager.close(f.engine)).resolves.toBe(false);
    expect(f.manager.ownsEngine(f.engine)).toBe(true);
    expect(f.globalEngines.get(TABLE_ID)).toBe(f.engine);
    expect(f.tournamentOwnedTables.has(TABLE_ID)).toBe(true);
    expect(f.unregister).not.toHaveBeenCalled();

    await expect(f.manager.close(f.engine)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(f.engine.stop).toHaveBeenCalledTimes(2);
    expect(f.globalEngines.has(TABLE_ID)).toBe(false);
    expect(f.tournamentOwnedTables.has(TABLE_ID)).toBe(false);
  });

  it('quarantines an engine whose stop has not released process ownership', async () => {
    const f = fixture();
    const failure = new Error('dealer loop still owns scheduler');
    f.engine.stop = vi.fn(async () => Promise.reject(failure));
    f.engine.hasReleasedProcessOwnership = vi.fn(() => false);
    const rpc = vi.spyOn(supabase, 'rpc');

    await expect(f.manager.close(f.engine)).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(f.manager.ownsEngine(f.engine)).toBe(true);
    expect(f.globalEngines.get(TABLE_ID)).toBe(f.engine);
    expect(f.tournamentOwnedTables.has(TABLE_ID)).toBe(true);
  });
});

describe('closed-source ambiguity reaches the actual manager diagnostic', () => {
  it('reports both observed sources without choosing a stack or executing a move', async () => {
    const f = fixture();
    const tables = [
      { id: 'open', status: 'running', max_players: 9 },
      { id: 'closed-a', status: 'closed', max_players: 9 },
      { id: 'closed-b', status: 'closed', max_players: 9 },
    ];
    const seats = [
      { table_id: 'closed-b', user_id: 'twice', seat_number: 2, stack: '250.00' },
      { table_id: 'closed-a', user_id: 'twice', seat_number: 1, stack: 100 },
    ];
    const tableFilter = vi.fn().mockResolvedValue({ data: tables, error: null });
    const liveFilter = vi.fn().mockResolvedValue({ data: seats, error: null });
    const seatFilter = vi.fn(() => ({ is: liveFilter }));
    const tableSelect = vi.fn(() => ({ eq: tableFilter }));
    const seatSelect = vi.fn(() => ({ in: seatFilter }));
    const reads = vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
      if (relation === 'tables') return { select: tableSelect };
      if (relation === 'table_seats') return { select: seatSelect };
      throw new Error(`Unexpected relation: ${relation}`);
    }) as never);
    const report = vi.spyOn(errorReporter, 'reportError').mockImplementation(() => {});
    const moves = vi.spyOn(f.manager, 'executePlayerMoves').mockResolvedValue(0);
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((() => {
      throw new Error('Ambiguous-only recovery must not call an RPC');
    }) as never);

    await expect(f.manager.absorbOrphanedSeats()).resolves.toBe(0);

    expect(reads.mock.calls.map(([relation]) => relation)).toEqual(['tables', 'table_seats']);
    expect(tableSelect).toHaveBeenCalledWith('id, status, is_deleted, max_players');
    expect(tableFilter).toHaveBeenCalledWith('tournament_id', TOURNAMENT_ID);
    expect(seatSelect).toHaveBeenCalledWith('table_id, user_id, seat_number, stack');
    expect(seatFilter).toHaveBeenCalledWith(
      'table_id',
      tables.map(({ id }) => id)
    );
    expect(liveFilter).toHaveBeenCalledWith('left_at', null);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.orphan_closed_sources_ambiguous_not_moved',
      {
        tournamentId: TOURNAMENT_ID,
        ambiguousClosedSources: [{ userId: 'twice', sources: [seats[1], seats[0]] }],
      }
    );
    expect(moves).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(f.engine.stop).not.toHaveBeenCalled();
    expect(f.unregister).not.toHaveBeenCalled();
  });
});
