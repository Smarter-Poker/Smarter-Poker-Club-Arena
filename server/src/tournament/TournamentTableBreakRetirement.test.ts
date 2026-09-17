import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { MoveInstruction } from '../engine/TableBalancer.js';
import { supabase } from '../services/supabase.js';
import * as errorReporter from '../services/errorReporter.js';
import { TournamentManager } from './TournamentManager.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { unregisterOwnedTournamentTableEngine } from './TournamentManagerOwnership.js';

const TOURNAMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TABLE_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const LEASE_GENERATION = 'cccccccc-0000-4000-8000-000000000001';

class TableBreakHarness extends TournamentManager {
  constructor(gameServer: GameServer) {
    super(TOURNAMENT_ID, gameServer, LEASE_GENERATION, performance.now() + 20_000);
    this.running = true;
    this.isFinalTable = true;
  }

  addEngine(engine: ServerTableEngine, tableId = TABLE_ID): void {
    this.tableEngines.set(tableId, engine);
  }

  close(engine: ServerTableEngine, movedPlayers = 0): Promise<boolean> {
    return this.closeBrokenTableAndReleaseEngine(TABLE_ID, engine, movedPlayers);
  }

  balance() {
    return this.checkTableBalance();
  }

  fence(): void {
    this.running = false;
  }

  public override broadcast = vi.fn(async () => true);

  public override requestUrgentEliminationSweepAfter = vi.fn();

  public override waitForHandComplete = vi.fn(async () => true);

  public override redrivePendingTournamentSeatMoveOutcomes(): Promise<boolean> {
    return super.redrivePendingTournamentSeatMoveOutcomes();
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
    getCurrentButtonSeat: vi.fn(() => 1),
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
  vi.useRealTimers();
});

describe('tournament table-break retirement is one durable ownership chain', () => {
  it.each(['clear', 'roster-blocked', 'lost-close'])(
    'continues fresh retirement inside one admission and stops on %s state',
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      const tableIds = [
        TABLE_ID,
        'dddddddd-0000-4000-8000-000000000001',
        'eeeeeeee-0000-4000-8000-000000000001',
      ];
      const tables = tableIds.map((id) => ({ id, max_players: 9, status: 'running' }));
      const seats = tableIds.map((table_id, index) => ({
        table_id,
        user_id: `player-${index}`,
        seat_number: 1,
        stack: 100,
        left_at: null,
      }));
      const reserved: Record<string, unknown>[] = [];
      for (const tableId of tableIds.slice(1)) {
        const engine = {
          stop: vi.fn(async () => {}),
          hasReleasedProcessOwnership: vi.fn(() => true),
          getCurrentButtonSeat: vi.fn(() => 1),
        } as unknown as ServerTableEngine;
        f.manager.addEngine(engine, tableId);
        f.globalEngines.set(tableId, engine);
        f.tournamentOwnedTables.add(tableId);
      }
      const rosterSnapshots: string[][] = [];
      vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
        let rows: Record<string, unknown>[];
        if (relation === 'tables') rows = tables;
        else if (relation === 'table_seats') rows = seats;
        else if (relation === 'tournament_players') {
          rows = [...seats.map((seat) => ({ ...seat, status: 'playing' })), ...reserved];
          rosterSnapshots.push(
            seats.map((seat) => `${seat.user_id}:${seat.table_id}:${seat.seat_number}`)
          );
        } else throw new Error(`Unexpected relation: ${relation}`);
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => {
            if (key !== 'tournament_id') rows = rows.filter((row) => row[key] === value);
            return query;
          },
          in: (key: string, values: unknown[]) => {
            rows = rows.filter((row) => values.includes(row[key]));
            return query;
          },
          is: (key: string, value: unknown) => {
            rows = rows.filter((row) => row[key] === value);
            return query;
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve),
        };
        return query;
      }) as never);
      const movedRosters: string[][] = [];
      vi.spyOn(f.manager, 'executePlayerMoves').mockImplementation(async (plan) => {
        movedRosters.push(plan.map((move) => move.playerId));
        for (const move of plan) {
          const seat = seats.find((row) => row.user_id === move.playerId)!;
          expect(seat.table_id).toBe(move.fromTableId);
          expect(tables.find((row) => row.id === move.toTableId)?.status).toBe('running');
          expect(
            seats.some((row) => row.table_id === move.toTableId && row.seat_number === move.toSeat)
          ).toBe(false);
          seat.table_id = move.toTableId;
          seat.seat_number = move.toSeat;
        }
        return plan.length;
      });
      const closed: string[] = [];
      const closeAttempts: string[] = [];
      vi.spyOn(supabase, 'rpc').mockImplementation(((
        name: string,
        args: Record<string, unknown>
      ) => {
        expect(name).toBe('fn_close_empty_tournament_table');
        expect(args.p_tournament_id).toBe(TOURNAMENT_ID);
        expect(args.p_lease_generation).toBe(LEASE_GENERATION);
        const tableId = args.p_table_id as string;
        closeAttempts.push(tableId);
        expect(seats.filter((seat) => seat.table_id === tableId)).toHaveLength(0);
        if (!closed.includes(tableId)) closed.push(tableId);
        tables.find((table) => table.id === tableId)!.status = 'closed';
        vi.setSystemTime(Date.now() + 100);
        if (state === 'roster-blocked') {
          // A new bust can leave a chair in the authoritative roster without a
          // live seat. No further break is admissible until bust processing.
          for (const table of tables.filter((row) => row.status === 'running')) {
            for (let chair = 1; chair <= table.max_players; chair++) {
              if (!seats.some((seat) => seat.table_id === table.id && seat.seat_number === chair)) {
                reserved.push({ table_id: table.id, seat_number: chair, status: 'playing' });
              }
            }
          }
        }
        if (state === 'lost-close' && closeAttempts.length === 2) {
          return Promise.resolve({ data: null, error: { message: 'committed reply lost' } });
        }
        return Promise.resolve({
          ...closeReceipt(),
          data: { ...closeReceipt().data, table_id: tableId },
        });
      }) as never);
      const manager = f.manager as any;
      vi.spyOn(manager, 'resumeCommittedTerminalCleanup').mockResolvedValue(false);
      const requeue = vi.spyOn(manager, 'requestEliminationSweep').mockImplementation(() => {});
      const expansion = vi.spyOn(manager, 'checkDynamicTableExpansion');
      manager.eliminationSweepCursor.advanceTo(5);
      const started = Date.now();

      // Real sweep -> real balancing/planning -> exact close receipt -> real
      // registry release. Only the database transport and committed seat moves
      // are simulated; the result must not require another scheduler admission.
      await manager.runEliminationSweep(new AbortController().signal);

      expect(closed).toHaveLength(state === 'roster-blocked' ? 1 : 2);
      expect(movedRosters.map((players) => [...players].sort())).toEqual(
        state === 'roster-blocked' ? [['player-0']] : [['player-0'], ['player-0', 'player-1']]
      );
      expect(rosterSnapshots[1]).not.toEqual(rosterSnapshots[0]);
      expect(new Set(seats.map((seat) => seat.table_id)).size).toBe(
        state === 'roster-blocked' ? 2 : 1
      );
      expect(new Set(seats.map((seat) => `${seat.table_id}:${seat.seat_number}`)).size).toBe(3);
      expect(seats.reduce((sum, seat) => sum + seat.stack, 0)).toBe(300);
      expect(f.globalEngines.size).toBe(state === 'clear' ? 1 : 2);
      expect(f.unregister).toHaveBeenCalledTimes(state === 'clear' ? 2 : 1);
      expect(expansion).toHaveBeenCalledOnce();
      expect(manager.breakOccurredThisCycle).toBe(false);
      expect(manager.eliminationSweepCursor.nextStage).toBe(0);
      expect(requeue).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(TournamentManagerBase.SWEEP_WORK_BUDGET_MS);
      if (state === 'lost-close') {
        // The unknown close does not itself authorize another same-admission
        // attempt or move. A later admission replays that exact retained table.
        expect(closeAttempts).toHaveLength(2);
        expect(manager.pendingTableBreakRetirement.tableId).toBe(closeAttempts[1]);
        manager.eliminationSweepCursor.advanceTo(5);
        await manager.runEliminationSweep(new AbortController().signal);
        expect(closeAttempts).toEqual([tableIds[0], tableIds[1], tableIds[1]]);
        expect(movedRosters).toHaveLength(2);
        expect(f.globalEngines.size).toBe(1);
        expect(manager.pendingTableBreakRetirement).toBeNull();
      }
    }
  );

  it.each([
    { sourceStatus: 'running', occupiedTables: 0 },
    { sourceStatus: 'running', occupiedTables: 1 },
    { sourceStatus: 'closed', occupiedTables: 0 },
    { sourceStatus: 'closed', occupiedTables: 1 },
  ])(
    'the next balance pass retries a lost close with $occupiedTables occupied tables and source $sourceStatus',
    async ({ sourceStatus, occupiedTables }) => {
      const f = fixture();
      const occupied = Array.from({ length: occupiedTables }, (_, index) => ({
        id: `occupied-${index}`,
      }));
      // Use the real occupied-table reader. The retired source either remains
      // open but empty, or its close committed before the response was lost.
      vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
        if (relation === 'tables')
          return {
            select: () => ({
              eq: () => ({
                in: () =>
                  Promise.resolve({
                    data: [...occupied, ...(sourceStatus === 'running' ? [{ id: TABLE_ID }] : [])],
                    error: null,
                  }),
              }),
            }),
          };
        if (relation === 'table_seats')
          return {
            select: () => ({
              in: () => ({
                is: () =>
                  Promise.resolve({
                    data: occupied.map(({ id }) => ({ table_id: id })),
                    error: null,
                  }),
              }),
            }),
          };
        throw new Error(`Unexpected relation: ${relation}`);
      }) as never);
      const rpc = vi
        .spyOn(supabase, 'rpc')
        .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
        .mockResolvedValueOnce(closeReceipt() as never);

      await expect(f.manager.close(f.engine)).resolves.toBe(false);
      await f.manager.balance();

      expect(rpc).toHaveBeenCalledTimes(2);
      expect(f.manager.ownsEngine(f.engine)).toBe(false);
      expect(f.globalEngines.has(TABLE_ID)).toBe(false);
      expect(f.manager.broadcast).toHaveBeenCalledWith('table_rebalance', {
        closedTableId: TABLE_ID,
        movedPlayers: 0,
        reason: 'table_break',
      });
      // A completed retirement must not be repeated on another ordinary pass.
      await f.manager.balance();
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(f.manager.broadcast).toHaveBeenCalledTimes(1);
    }
  );

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

  it('makes only one retry per pass and preserves the original moved-player count', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
      .mockResolvedValueOnce({ data: null, error: { message: 'still unavailable' } } as never)
      .mockResolvedValueOnce(closeReceipt() as never);
    const reads = vi.spyOn(supabase, 'from').mockImplementation((() => {
      throw new Error('A pending retirement must run before any new planning read');
    }) as never);

    await expect(f.manager.close(f.engine, 3)).resolves.toBe(false);
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.manager.broadcast).not.toHaveBeenCalled();
    expect(f.manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(5_000);

    await f.manager.balance();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(reads).not.toHaveBeenCalled();
    expect(f.manager.broadcast).toHaveBeenCalledWith('table_rebalance', {
      closedTableId: TABLE_ID,
      movedPlayers: 3,
      reason: 'table_break',
    });
  });

  it('reaches retirement through the actual planner, moves the complete source roster once, and retries only the close', async () => {
    const f = fixture();
    const destinationId = 'dddddddd-0000-4000-8000-000000000001';
    const tables = [TABLE_ID, destinationId].map((id) => ({
      id,
      max_players: 9,
      status: 'running',
    }));
    const seats = [
      { table_id: TABLE_ID, user_id: 'source-one', seat_number: 1, stack: 100, left_at: null },
      { table_id: TABLE_ID, user_id: 'source-two', seat_number: 2, stack: 200, left_at: null },
      {
        table_id: destinationId,
        user_id: 'destination',
        seat_number: 1,
        stack: 300,
        left_at: null,
      },
    ];
    vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
      let rows: Record<string, unknown>[];
      if (relation === 'tables') rows = tables;
      else if (relation === 'table_seats') rows = seats;
      else if (relation === 'tournament_players')
        rows = seats.map((seat) => ({ ...seat, status: 'playing' }));
      else throw new Error(`Unexpected relation: ${relation}`);
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          if (key !== 'tournament_id') rows = rows.filter((row) => row[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        is: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    }) as never);
    const moves = vi.spyOn(f.manager, 'executePlayerMoves').mockImplementation(async (plan) => {
      expect(plan).toHaveLength(2);
      for (const move of plan) {
        const seat = seats.find((row) => row.user_id === move.playerId)!;
        expect(move.fromTableId).toBe(TABLE_ID);
        expect(move.toTableId).toBe(destinationId);
        seat.table_id = move.toTableId;
        seat.seat_number = move.toSeat;
      }
      return plan.length;
    });
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
      .mockResolvedValueOnce(closeReceipt() as never);

    await f.manager.balance();
    expect(moves).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledOnce();
    expect(f.globalEngines.get(TABLE_ID)).toBe(f.engine);
    expect(f.manager.waitForHandComplete).toHaveBeenCalledWith(TABLE_ID);

    await f.manager.balance();
    expect(moves).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(f.unregister).toHaveBeenCalledOnce();
    expect(f.manager.broadcast).toHaveBeenCalledWith('table_rebalance', {
      closedTableId: TABLE_ID,
      movedPlayers: 2,
      reason: 'table_break',
    });
  });

  it('resolves ambiguous seat moves before retrying a pending retirement', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
      .mockResolvedValueOnce(closeReceipt() as never);
    await f.manager.close(f.engine);
    const redrive = vi
      .spyOn(f.manager, 'redrivePendingTournamentSeatMoveOutcomes')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledOnce();
    expect(f.unregister).not.toHaveBeenCalled();
    await f.manager.balance();
    expect(redrive).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not release registries if manager authority ends while the close is in flight', async () => {
    const f = fixture();
    vi.spyOn(supabase, 'rpc').mockImplementation((async () => {
      f.manager.fence();
      return closeReceipt();
    }) as never);
    await expect(f.manager.close(f.engine)).resolves.toBe(false);
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.manager.ownsEngine(f.engine)).toBe(true);
    expect(f.manager.broadcast).not.toHaveBeenCalled();
  });

  it('retains the retirement and wake when the close transport throws', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockRejectedValueOnce(new Error('transport threw'))
      .mockResolvedValueOnce(closeReceipt() as never);
    await expect(f.manager.close(f.engine)).rejects.toThrow('transport threw');
    expect(f.manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(5_000);
    expect(f.globalEngines.get(TABLE_ID)).toBe(f.engine);
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(f.unregister).toHaveBeenCalledOnce();
  });

  it('does not retire a stopped manager or stop a replacement engine', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: null, error: { message: 'response lost' } } as never);
    await expect(f.manager.close(f.engine)).resolves.toBe(false);

    const replacement = { stop: vi.fn() } as unknown as ServerTableEngine;
    f.manager.addEngine(replacement);
    f.globalEngines.set(TABLE_ID, replacement);
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.manager.ownsEngine(replacement)).toBe(true);

    f.manager.addEngine(f.engine);
    f.globalEngines.set(TABLE_ID, f.engine);
    f.manager.fence();
    await f.manager.balance();
    await expect(f.manager.close(f.engine)).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(f.engine.stop).toHaveBeenCalledTimes(1);
  });

  it('never retires from a mismatched or nonempty receipt on a retry', async () => {
    const f = fixture();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({ data: null, error: { message: 'response lost' } } as never)
      .mockResolvedValueOnce({
        ...closeReceipt(),
        data: { ...closeReceipt().data, table_id: 'other' },
      } as never)
      .mockResolvedValueOnce({
        ...closeReceipt(),
        data: { ...closeReceipt().data, current_players: 1 },
      } as never)
      .mockResolvedValueOnce(closeReceipt() as never);
    await f.manager.close(f.engine);
    await f.manager.balance();
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.manager.ownsEngine(f.engine)).toBe(true);
    await f.manager.balance();
    expect(f.unregister).toHaveBeenCalledOnce();
  });

  it('keeps a failed physical stop quarantined until that exact engine releases ownership', async () => {
    const f = fixture();
    f.engine.stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('physical writer still running'))
      .mockResolvedValue(undefined);
    f.engine.hasReleasedProcessOwnership = vi.fn().mockReturnValue(false);
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue(closeReceipt() as never);
    await expect(f.manager.close(f.engine)).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    f.engine.hasReleasedProcessOwnership = vi.fn().mockReturnValue(true);
    await f.manager.balance();
    expect(rpc).toHaveBeenCalledOnce();
    expect(f.unregister).toHaveBeenCalledWith(TABLE_ID, f.engine);
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
