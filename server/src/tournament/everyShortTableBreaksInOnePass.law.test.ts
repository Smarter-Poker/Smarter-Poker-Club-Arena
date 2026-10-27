/**
 * EVERY SHORT TABLE BREAKS IN ONE PASS (2026-10-01).
 *
 * Production 2026-10-01 ~20:18Z: event e604d224 held 25 players on 17 tables,
 * nine of them single-player tables. The balancer requested ONE park per
 * sweep and then stopped to wait for the next one; a source in the middle of
 * a hand cannot begin until that hand ends (`source_park_probe_missed`), so
 * the field merged one table per hand-plus-redrive. Industry standard: every
 * short table is broken at its own next hand boundary, so 25 players at
 * nine-handed tables are on three or four tables within a hand or two.
 *
 * The law: one balance pass parks every table the field can absorb, and never
 * one whose players the remaining tables could not seat, counting the players
 * of parks from earlier passes that have not begun yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';
import * as freezeState from '../maintenance/freezeState.js';
import type { BalancerTable } from '../engine/TableBalancer.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const GENERATION = id(9);

function table(n: number, players: number): BalancerTable {
  return {
    tableId: id(2000 + n),
    playerCount: players,
    maxSeats: 9,
    players: Array.from({ length: players }, (_, i) => ({
      userId: id(3000 + n * 10 + i),
      stack: 10_000,
      seat: i + 1,
    })),
  };
}

function manager(board: BalancerTable[]) {
  const m: any = new TournamentManager(EVENT, {} as any, GENERATION, performance.now() + 60_000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.eliminationMutationAllowed = () => true;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.recoverF06OriginalAdmissions = vi.fn(async () => {});
  m.visitTournamentBreakPage = vi.fn(async () => true);
  m.redrivePendingTournamentSeatMoveOutcomes = vi.fn(async () => true);
  m.tournamentBreakDiscoveryComplete = true;
  m.isFinalTable = true;
  const parked = () =>
    new Set([...m.durableTournamentBreaks.values()].map((s: any) => s.source_table_id));
  const live = () => board.filter((t) => t.playerCount > 0 && !parked().has(t.tableId));
  m.liveTournamentTableIdsWithPlayers = vi.fn(async () => live().map((t) => t.tableId));
  m.loadBalancerTables = vi.fn(async (ids: string[]) =>
    live()
      .filter((t) => ids.includes(t.tableId))
      .map((t) => ({ ...t, players: t.players.map((p) => ({ ...p })) }))
  );
  let breaks = 0;
  m.requestTournamentBreakPark = vi.fn(async (tableId: string) => {
    const state = {
      ok: true,
      reason: null,
      break_id: id(5000 + ++breaks),
      tournament_id: EVENT,
      source_table_id: tableId,
      lifecycle: '1',
      state: 'park_requested',
      revision: '0',
      custody_id: null,
      custody_generation: null,
      terminal_handoff_required: false,
      members: [],
    };
    m.rememberTournamentBreak(state);
    return state;
  });
  // Every source is mid-hand: the probe misses and the park stays unbegun.
  m.recoverTournamentBreak = vi.fn(async () => {});
  return m;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function slowPreparation(
  board: BalancerTable[],
  afterRead: (read: number, manager: any) => void = () => {},
  readMs = 1400
) {
  vi.useFakeTimers();
  let reads = 0;
  const m = manager(board);
  delete m.eliminationMutationAllowed;
  delete m.loadBalancerTables;
  m.liveTournamentTableIdsWithPlayers.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 1500);
    return board.map((t) => t.tableId);
  });
  vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
    const rows =
      name === 'tables'
        ? board.map((t) => ({ id: t.tableId, max_players: t.maxSeats }))
        : name === 'table_seats'
          ? board.flatMap((t) =>
              t.players.map((p) => ({
                table_id: t.tableId,
                user_id: p.userId,
                stack: p.stack,
                seat_number: p.seat,
              }))
            )
          : board.flatMap((t) =>
              t.players.map((p) => ({ table_id: t.tableId, seat_number: p.seat }))
            );
    const query: any = {};
    for (const method of ['select', 'in', 'is', 'eq']) query[method] = () => query;
    query.then = (resolve: any, reject: any) => {
      vi.setSystemTime(Date.now() + readMs);
      afterRead(++reads, m);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return query;
  }) as any);
  m.eliminationSweepDeadlineAt = Date.now() + 5000;
  return m;
}

describe('one balance preparation can finish before it yields', () => {
  it('does not restart the same slow read prefix forever before creating a single park', async () => {
    vi.useFakeTimers();
    const board = [table(0, 1), table(1, 1), table(2, 1)];
    const m = slowPreparation(board);
    try {
      for (
        let admission = 0;
        admission < 3 && m.requestTournamentBreakPark.mock.calls.length === 0;
        admission++
      ) {
        m.eliminationSweepDeadlineAt = Date.now() + 5000;
        await m.checkTableBalance();
      }
      expect(m.requestTournamentBreakPark).toHaveBeenCalledTimes(1);
      expect(m.recoverTournamentBreak).not.toHaveBeenCalled();
      expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
      expect(m.eliminationMutationAllowed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['stop', 'abort', 'freeze'])(
    'still refuses a fresh park when %s arrives during the read prefix',
    async (fence) => {
      const frozen = vi.spyOn(freezeState, 'isMaintenanceFrozen').mockReturnValue(false);
      const m = slowPreparation([table(0, 1), table(1, 1)], (read, owner) => {
        if (read !== 3) return;
        if (fence === 'stop') owner.running = false;
        if (fence === 'abort') owner.eliminationSweepSignal = AbortSignal.abort();
        if (fence === 'freeze') frozen.mockReturnValue(true);
      });
      await m.checkTableBalance();
      expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
      expect(m.balancePreparationOpen).toBe(false);
    }
  );

  it('a freeze also refuses the preparation while its ordinary budget is still available', async () => {
    const frozen = vi.spyOn(freezeState, 'isMaintenanceFrozen').mockReturnValue(false);
    const m = slowPreparation([table(0, 1), table(1, 1)], () => frozen.mockReturnValue(true), 100);
    await m.checkTableBalance();
    expect(m.eliminationWorkBudgetExpired()).toBe(false);
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('an unreadable board does not become an invented park or leak the preparation window', async () => {
    const m = slowPreparation([table(0, 1), table(1, 1)], (read) => {
      if (read === 3) throw new Error('fixture roster unavailable');
    });
    await m.checkTableBalance();
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('an unproven original admission keeps its original budget and cannot start a late fresh park', async () => {
    const m = slowPreparation([table(0, 1), table(1, 1)]);
    m.recoverF06OriginalAdmissions.mockRejectedValue(new Error('fixture original outcome unknown'));
    await m.checkTableBalance();
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('working an existing break does not acquire another over-budget fresh preparation', async () => {
    const m = slowPreparation([table(0, 1), table(1, 1)]);
    m.visitTournamentBreakPage.mockImplementation(
      async (visit: (state: unknown) => Promise<void>) => {
        await visit({});
        return true;
      }
    );
    await m.checkTableBalance();
    expect(m.recoverTournamentBreak).toHaveBeenCalledOnce();
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('replays an unknown park before a slow fresh board can starve its original identity', async () => {
    const board = [table(0, 1), table(1, 1)];
    const m = slowPreparation(board);
    const pending = { breakId: id(6000), lifecycle: '1', boundaryId: id(6001) };
    m.pendingTournamentParkRequests.set(board[0].tableId, pending);
    delete m.requestTournamentBreakPark;
    const tableState = vi.fn(() => {
      throw new Error('an unknown request must retain its original lifecycle');
    });
    const requestPark = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 6000);
      return {
        ok: true,
        reason: null,
        break_id: pending.breakId,
        tournament_id: EVENT,
        source_table_id: board[0].tableId,
        lifecycle: pending.lifecycle,
        state: 'park_requested',
        revision: '0',
        custody_id: null,
        custody_generation: null,
        terminal_handoff_required: false,
        members: [],
      };
    });
    m.tableBreakRpc = () => ({ tableState, requestPark });
    requestPark.mockRejectedValueOnce(new Error('fixture reply lost'));
    await expect(m.checkTableBalance()).rejects.toThrow('fixture reply lost');
    expect(m.pendingTournamentParkRequests.get(board[0].tableId)).toBe(pending);
    m.eliminationSweepDeadlineAt = Date.now() + 5000;
    await m.checkTableBalance();
    expect(requestPark).toHaveBeenCalledTimes(2);
    for (const call of requestPark.mock.calls)
      expect(call).toEqual([
        pending.breakId,
        board[0].tableId,
        pending.lifecycle,
        pending.boundaryId,
      ]);
    expect(tableState).not.toHaveBeenCalled();
    expect(m.liveTournamentTableIdsWithPlayers).not.toHaveBeenCalled();
    expect(m.pendingTournamentParkRequests.size).toBe(0);
    expect(m.eliminationWorkBudgetExpired()).toBe(true);
  });

  it('stops after the first refused intent when the preparation spent the admission', async () => {
    const m = slowPreparation([table(0, 1), table(1, 1), table(2, 1)]);
    m.requestTournamentBreakPark.mockResolvedValue(null);
    await m.checkTableBalance();
    expect(m.requestTournamentBreakPark).toHaveBeenCalledTimes(1);
    expect(m.recoverTournamentBreak).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('fences the source after its durable park and yields before dispatching any members', async () => {
    const board = [table(0, 1), table(1, 1), table(2, 1)];
    const m = slowPreparation(board);
    const order: string[] = [];
    const request = m.requestTournamentBreakPark.getMockImplementation();
    m.requestTournamentBreakPark.mockImplementation(async (tableId: string) => {
      const state = await request(tableId);
      order.push('durable');
      return state;
    });
    m.gameServer = { ownsTournamentTableEngine: () => true };
    m.tableEngines = new Map(
      board.map((t) => [
        t.tableId,
        {
          getCurrentButtonSeat: () => 1,
          parkForTournamentMove: vi.fn(async () => {
            order.push('fence');
            return false;
          }),
        },
      ])
    );
    await m.checkTableBalance();
    expect(order).toEqual(['durable', 'fence']);
    expect(m.recoverTournamentBreak).not.toHaveBeenCalled();
    expect(m.balancePreparationOpen).toBe(false);
  });

  it('a slow gap plan hands one source to its original boundary owner instead of restarting its reads', async () => {
    const board = [table(0, 9), table(1, 9), table(2, 9), table(3, 1)];
    const m = slowPreparation(board);
    m.gameServer = { ownsTournamentTableEngine: () => true };
    const park = vi.fn(async () => false);
    m.tableEngines = new Map(
      board.map((t) => [
        t.tableId,
        {
          getCurrentButtonSeat: () => 1,
          parkForTournamentMove: park,
        },
      ])
    );
    m.executePlayerMoves = vi.fn();
    await m.checkTableBalance();
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(park).toHaveBeenCalledTimes(1);
    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(m.eliminationMutationAllowed()).toBe(false);
  });
});

describe('every short table breaks in one pass', () => {
  it('the e604d224 shape: 25 players on 17 tables are parked down to the size of the field in one pass', async () => {
    const board = [
      ...Array.from({ length: 8 }, (_, i) => table(i, 2)),
      ...Array.from({ length: 9 }, (_, i) => table(8 + i, 1)),
    ];
    const m = manager(board);
    await m.checkTableBalance();

    const parked = new Set(
      m.requestTournamentBreakPark.mock.calls.map((call: unknown[]) => call[0] as string)
    );
    const survivors = board.filter((t) => !parked.has(t.tableId));
    // Within one table of the minimum: the balancer keeps one spare seat per
    // surviving table until the last merge (TableBalancer.shouldBreakTable).
    expect(survivors.length).toBeLessThanOrEqual(Math.ceil(25 / 9) + 1);
    // Nothing is parked that the survivors cannot seat.
    const moving = board
      .filter((t) => parked.has(t.tableId))
      .reduce((s, t) => s + t.playerCount, 0);
    const free = survivors.reduce((s, t) => s + t.maxSeats - t.playerCount, 0);
    expect(moving).toBeLessThanOrEqual(free);
    // Each park is worked in the same pass, and the remainder is redriven.
    expect(m.recoverTournamentBreak).toHaveBeenCalledTimes(parked.size);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a park from an earlier pass that has not begun keeps the seats its players need', async () => {
    const plan = async (pendingPlayers: number) => {
      vi.restoreAllMocks();
      const board = [table(0, 7), table(1, 1), table(2, 1), table(3, 1)];
      const m = manager(board);
      // An earlier pass parked a table whose hand has not ended yet.
      m.rememberTournamentBreak({
        ok: true,
        reason: null,
        break_id: id(4000),
        tournament_id: EVENT,
        source_table_id: id(2099),
        lifecycle: '1',
        state: 'park_requested',
        revision: '0',
        custody_id: null,
        custody_generation: null,
        terminal_handoff_required: false,
        members: [],
      });
      vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
        if (name !== 'table_seats') throw new Error(`unexpected table ${name}`);
        const rows = Array.from({ length: pendingPlayers }, () => ({ table_id: id(2099) }));
        return {
          select: () => ({ in: () => ({ is: async () => ({ data: rows, error: null }) }) }),
        };
      }) as any);
      await m.checkTableBalance();
      return m.requestTournamentBreakPark.mock.calls.length;
    };
    // Nothing waiting: both spare single tables are parked together.
    expect(await plan(0)).toBe(2);
    // Ten players waiting for seats: the pass still makes the one break this
    // step always made, but parks nothing more that would take their seats.
    expect(await plan(10)).toBe(1);
  });

  it('the 4d2afa41 shape: a full table never jumps an unbegun park', async () => {
    const plan = async (pendingPlayers: number) => {
      vi.restoreAllMocks();
      // 4/6/6/6 at nine-handed tables: the 4-player table is the emptiest and
      // the field can absorb it (TableBalancer soft capacity), but it is not
      // a stranded short table.
      const board = [table(0, 4), table(1, 6), table(2, 6), table(3, 6)];
      const m = manager(board);
      m.rememberTournamentBreak({
        ok: true,
        reason: null,
        break_id: id(4001),
        tournament_id: EVENT,
        source_table_id: id(2098),
        lifecycle: '1',
        state: 'park_requested',
        revision: '0',
        custody_id: null,
        custody_generation: null,
        terminal_handoff_required: false,
        members: [],
      });
      vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
        if (name !== 'table_seats') throw new Error(`unexpected table ${name}`);
        const rows = Array.from({ length: pendingPlayers }, () => ({ table_id: id(2098) }));
        return {
          select: () => ({ in: () => ({ is: async () => ({ data: rows, error: null }) }) }),
        };
      }) as any);
      await m.checkTableBalance();
      return m.requestTournamentBreakPark.mock.calls.map((call: unknown[]) => call[0] as string);
    };
    // Nothing waiting: the 4-player table is consolidated.
    expect(await plan(0)).toEqual([id(2000)]);
    // Nine players of an earlier park still need the seats it would take:
    // no further park, so one stuck park cannot cascade into frozen tables.
    expect(await plan(9)).toEqual([]);
  });

  it('the 09a56a25 shape: a gap move deferred by a running hand fences its source', async () => {
    // 9/9/9/1: the lone player cannot be broken into full tables, so players
    // come to them; every source table is in the middle of a hand.
    const board = [table(0, 9), table(1, 9), table(2, 9), table(3, 1)];
    const m = manager(board);
    m.gameServer = { ownsTournamentTableEngine: () => true };
    const engines = new Map(
      board.map((t) => [
        t.tableId,
        {
          isBetweenHands: () => false,
          hasSettlementInFlight: () => false,
          parkForTournamentMove: vi.fn(async () => false),
        },
      ])
    );
    m.tableEngines = engines;
    m.executePlayerMoves = vi.fn(async () => 0);
    await m.checkTableBalance();
    expect(m.requestTournamentBreakPark).not.toHaveBeenCalled();
    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    // A snapshot of "between hands" is a moment; the fence makes it a state.
    // Each deferred source stops at its next boundary and its park edge wakes
    // the sweep that moves the player (the claim's own fence, expiring alone).
    const fenced = board.filter(
      (t) => engines.get(t.tableId)!.parkForTournamentMove.mock.calls.length > 0
    );
    expect(fenced.length).toBeGreaterThan(0);
    for (const t of fenced) {
      expect(engines.get(t.tableId)!.parkForTournamentMove).toHaveBeenCalledWith(
        m.tournamentMoveBoundaryOwner,
        0
      );
      expect(t.playerCount).toBe(9);
    }
  });
});
