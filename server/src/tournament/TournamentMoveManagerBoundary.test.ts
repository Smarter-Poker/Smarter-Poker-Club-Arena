import { beforeEach, describe, expect, it, vi } from 'vitest';

const moveRpc = vi.hoisted(() => vi.fn());
vi.mock('./tournamentSeatMoveRpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tournamentSeatMoveRpc.js')>();
  return { ...actual, moveTournamentPlayerAtomically: moveRpc };
});

import { TournamentManager } from './TournamentManager.js';
import {
  TournamentSeatMoveOutcomeUnknownError,
  TournamentSeatMoveRefusedError,
} from './tournamentSeatMoveRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const DESTINATION_ID = '00000000-0000-4000-8000-000000000003';
const PLAYER_ONE = '00000000-0000-4000-8000-000000000004';
const PLAYER_TWO = '00000000-0000-4000-8000-000000000005';

function receipt(input: any): any {
  return {
    requestId: input.requestId,
    tournamentId: input.tournamentId,
    userId: input.userId,
    sourceTableId: input.sourceTableId,
    destinationTableId: input.destinationTableId,
    sourceSeatId: '00000000-0000-4000-8000-000000000006',
    destinationSeatId: '00000000-0000-4000-8000-000000000007',
    sourceSeatNumber: 2,
    destinationSeatNumber: input.destinationSeatNumber,
    stack: 100,
    movedAt: '2026-09-09T12:00:00.000Z',
    replayed: false,
    sourceMode: input.sourceMode,
  };
}

function liveHarness(owned = true): {
  manager: any;
  engine: any;
  gameServer: any;
} {
  const engine = {
    parkForTournamentMove: vi.fn().mockResolvedValue(true),
    releaseTournamentMovePause: vi.fn(),
    executeTournamentMoveAtBoundary: vi.fn(async (_owner: string, operation: () => Promise<any>) =>
      operation()
    ),
    hasReleasedProcessOwnership: vi.fn(() => true),
    hasClaimedTournamentMoveBoundary: vi.fn(() => false),
  };
  const gameServer = {
    getTableEngine: vi.fn(() => engine),
    ownsTournamentTableEngine: vi.fn(() => owned),
  };
  const manager = new TournamentManager(TOURNAMENT_ID, gameServer as never) as any;
  manager.running = true;
  manager.eliminationSweepSignal = null;
  manager.eliminationSweepDeadlineAt = 0;
  manager.tableEngines = new Map([[SOURCE_ID, engine]]);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  return { manager, engine, gameServer };
}

function move(playerId = PLAYER_ONE, toSeat = 3): any {
  return {
    playerId,
    fromTableId: SOURCE_ID,
    fromSeat: 2,
    toTableId: DESTINATION_ID,
    toSeat,
    reason: 'Balance: source to destination',
  };
}

describe('TournamentManager source move ownership', () => {
  beforeEach(() => {
    moveRpc.mockReset();
  });

  it('does not call the database when local and global engine ownership disagree', async () => {
    const { manager, engine } = liveHarness(false);

    await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);

    expect(engine.parkForTournamentMove).not.toHaveBeenCalled();
    expect(moveRpc).not.toHaveBeenCalled();
  });

  it('releases the source boundary when the actual RPC was never routable', async () => {
    const { manager, engine } = liveHarness();
    const actual = await vi.importActual<typeof import('./tournamentSeatMoveRpc.js')>(
      './tournamentSeatMoveRpc.js'
    );
    const { supabase } = await import('../services/supabase.js');
    const rpcSpy = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'function missing',
        details: '',
        hint: '',
      },
      count: null,
      status: 404,
      statusText: 'Not Found',
    } as never);
    moveRpc.mockImplementation(actual.moveTournamentPlayerAtomically);
    try {
      await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);
      expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
      expect(engine.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
      expect(rpcSpy).toHaveBeenCalledTimes(2);
    } finally {
      rpcSpy.mockRestore();
    }
  });

  it('holds one physical source boundary across every move from that source', async () => {
    const { manager, engine } = liveHarness();
    moveRpc.mockImplementation(async (input) => receipt(input));

    await expect(
      manager.executePlayerMoves([move(PLAYER_ONE, 3), move(PLAYER_TWO, 4)])
    ).resolves.toBe(2);

    expect(engine.parkForTournamentMove).toHaveBeenCalledTimes(1);
    expect(engine.executeTournamentMoveAtBoundary).toHaveBeenCalledTimes(2);
    expect(engine.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
  });

  it('serializes detached repair work with scheduler move work for this manager', async () => {
    const { manager, engine } = liveHarness();
    let finishFirst!: () => void;
    moveRpc
      .mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            finishFirst = () => resolve(receipt(input));
          })
      )
      .mockImplementation(async (input) => receipt(input));

    const first = manager.executePlayerMoves([move(PLAYER_ONE, 3)]);
    await vi.waitFor(() => expect(moveRpc).toHaveBeenCalledTimes(1));
    const second = manager.executePlayerMoves([move(PLAYER_TWO, 4)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(moveRpc).toHaveBeenCalledTimes(1);
    expect(engine.parkForTournamentMove).toHaveBeenCalledTimes(1);

    finishFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    expect(moveRpc).toHaveBeenCalledTimes(2);
    expect(engine.parkForTournamentMove).toHaveBeenCalledTimes(2);
  });

  it('retains an unknown UUID and fence, then replays that exact operation', async () => {
    const { manager, engine } = liveHarness();
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));

    await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);
    const original = moveRpc.mock.calls[0][0];
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(1);
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();

    moveRpc.mockImplementationOnce(async (input) => receipt(input));
    await expect(manager.redrivePendingTournamentSeatMoveOutcomes()).resolves.toBe(true);

    expect(moveRpc.mock.calls[1][0]).toEqual(original);
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
    expect(engine.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
  });

  it('resolves a lost response on the stopped exact generation before recovery releases it', async () => {
    const { manager, engine } = liveHarness();
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    const original = moveRpc.mock.calls[0][0];

    moveRpc.mockImplementationOnce(async (input) => receipt(input));
    await expect(manager.resolveTournamentSeatMoveQuarantine(SOURCE_ID, engine)).resolves.toBe(
      true
    );

    expect(moveRpc.mock.calls[1][0]).toEqual(original);
    expect(moveRpc.mock.calls[1][1]).toEqual({
      outcomeWasAlreadyUnknown: true,
    });
    expect(engine.hasReleasedProcessOwnership).toHaveBeenCalled();
    expect(engine.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
  });

  it('does not erase an earlier unknown UUID when a later local ownership check fails', async () => {
    const { manager, engine, gameServer } = liveHarness();
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    const original = moveRpc.mock.calls[0][0];

    gameServer.ownsTournamentTableEngine.mockReturnValue(false);
    await expect(manager.redrivePendingTournamentSeatMoveOutcomes()).resolves.toBe(false);

    expect(moveRpc).toHaveBeenCalledTimes(1);
    expect(manager.pendingTournamentSeatMoveOutcomes.get(original.requestId)?.input).toEqual(
      original
    );
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
  });

  it('does not erase or release an earlier unknown UUID on a later transport refusal', async () => {
    const { manager, engine } = liveHarness();
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    const original = moveRpc.mock.calls[0][0];

    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveRefusedError('caller no longer admitted'));
    await expect(manager.redrivePendingTournamentSeatMoveOutcomes()).resolves.toBe(false);

    expect(moveRpc.mock.calls[1][0]).toEqual(original);
    expect(manager.pendingTournamentSeatMoveOutcomes.get(original.requestId)?.input).toEqual(
      original
    );
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
  });

  // 2026-09-12: this case used to assert that a live-source move with NO engine
  // anywhere resolved 0 and never reached the database. That assertion was the
  // deadlock: a table of one cannot deal, so it never holds an engine, so the
  // move was re-planned every five seconds for ever while
  // fn_move_tournament_player accepted the identical move. The no-engine path
  // is now open to either mode, and the mode is still carried through to the
  // database exactly as it was planned.
  it('takes the no-engine path in either mode when no engine generation exists', async () => {
    const gameServer = {
      getTableEngine: vi.fn(() => undefined),
      ownsTournamentTableEngine: vi.fn(() => false),
    };
    const manager = new TournamentManager(TOURNAMENT_ID, gameServer as never) as any;
    manager.running = true;
    manager.eliminationSweepSignal = null;
    manager.eliminationSweepDeadlineAt = 0;
    manager.tableEngines = new Map();
    manager.requestUrgentEliminationSweepAfter = vi.fn();
    moveRpc.mockImplementation(async (input) => receipt(input));

    const orphan = { ...move(), reason: 'orphaned_seat_on_closed_table' };
    await expect(manager.executePlayerMoves([orphan])).resolves.toBe(1);
    expect(moveRpc.mock.calls[0][0].sourceMode).toBe('closed_orphan');

    moveRpc.mockClear();
    await expect(manager.executePlayerMoves([move()])).resolves.toBe(1);
    expect(moveRpc.mock.calls[0][0].sourceMode).toBe('live_source');
  });

  it('refuses the no-engine path while either registry still holds an engine', async () => {
    // One registry at a time: the engineless path is exact only when BOTH are
    // empty, so each one alone must refuse. The claim is stubbed to the
    // engineless boundary so that only the request-side re-proof is under test.
    for (const registry of ['manager', 'server'] as const) {
      const { manager, engine, gameServer } = liveHarness();
      if (registry === 'manager') gameServer.getTableEngine = vi.fn(() => undefined);
      else manager.tableEngines = new Map();
      moveRpc.mockReset();
      moveRpc.mockImplementation(async (input) => receipt(input));
      manager.claimTournamentMoveBoundary = vi
        .fn()
        .mockResolvedValue({ sourceMode: 'live_source', engine: null });

      await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);
      expect(moveRpc, registry).not.toHaveBeenCalled();
      expect(engine.executeTournamentMoveAtBoundary, registry).not.toHaveBeenCalled();
    }
  });

  it('retains whole-break custody on explicit refusal while ordinary moves still release', async () => {
    const { manager, engine } = liveHarness();
    expect(manager.retainTournamentBreakSource('break-original', SOURCE_ID, engine)).toBe(true);
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveRefusedError('destination closed'));

    await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);

    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
  });

  it('retains whole-break custody after a last unknown UUID resolves', async () => {
    const { manager, engine } = liveHarness();
    expect(manager.retainTournamentBreakSource('break-original', SOURCE_ID, engine)).toBe(true);
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    const original = moveRpc.mock.calls[0][0];
    moveRpc.mockImplementationOnce(async (input) => receipt(input));

    await expect(manager.redrivePendingTournamentSeatMoveOutcomes()).resolves.toBe(true);

    expect(moveRpc.mock.calls[1][0]).toEqual(original);
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
  });

  it('cannot overwrite retained break custody with another operation or engine', () => {
    const { manager, engine, gameServer } = liveHarness();
    expect(manager.retainTournamentBreakSource('break-original', SOURCE_ID, engine)).toBe(true);
    expect(manager.retainTournamentBreakSource('break-other', SOURCE_ID, engine)).toBe(false);
    const replacement = { ...engine };
    manager.tableEngines.set(SOURCE_ID, replacement);
    gameServer.getTableEngine.mockReturnValue(replacement);
    expect(manager.retainTournamentBreakSource('break-original', SOURCE_ID, replacement)).toBe(
      false
    );
    manager.running = false;
    expect(manager.retainTournamentBreakSource('break-original', SOURCE_ID, engine)).toBe(false);
  });

  it('retries lost begin with original request identities and refuses changed members', async () => {
    const { manager } = liveHarness();
    const members = [
      {
        user_id: PLAYER_ONE,
        source_seat_id: PLAYER_TWO,
        source_seat_number: 2,
        occupancy_id: DESTINATION_ID,
        request_id: TOURNAMENT_ID,
        destination_table_id: DESTINATION_ID,
        destination_seat_number: 3,
      },
    ];
    const begin = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      ok: true,
      state: 'begun',
      break_id: 'break-original',
      source_table_id: SOURCE_ID,
      members,
    });
    manager.tableBreakRpc = () => ({ begin });
    await expect(
      manager.beginTournamentBreak('break-original', SOURCE_ID, members)
    ).rejects.toThrow('response lost');
    await expect(
      manager.beginTournamentBreak('break-original', SOURCE_ID, [
        { ...members[0], destination_seat_number: 4 },
      ])
    ).rejects.toThrow('membership changed');
    await manager.beginTournamentBreak('break-original', SOURCE_ID, members);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(begin.mock.calls[1]).toEqual(begin.mock.calls[0]);
  });

  it('uses the server cursor conflict revision for subsequent discovery', async () => {
    const { manager } = liveHarness();
    const discover = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        cursor_revision: '9007199254740993',
        operations: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        cursor_revision: '9007199254740994',
        operations: [],
      });
    manager.tableBreakRpc = () => ({ discover });
    await expect(manager.discoverTournamentBreaks()).resolves.toBeNull();
    await expect(manager.discoverTournamentBreaks()).resolves.toEqual([]);
    expect(discover.mock.calls).toEqual([
      ['0', 1],
      ['9007199254740993', 1],
    ]);
  });

  it('dispatches the saved active break UUID and skips a member with a winner', async () => {
    const { manager, engine } = liveHarness();
    moveRpc.mockImplementation(async (input) => receipt(input));
    const active = '00000000-0000-4000-8000-000000000020';
    const member = {
      user_id: PLAYER_ONE,
      source_seat_id: '00000000-0000-4000-8000-000000000006',
      source_seat_number: 2,
      destination_table_id: DESTINATION_ID,
      destination_seat_number: 3,
      active_request_id: active,
      winner_request_id: null,
    };
    await manager.dispatchTournamentBreakMembers({
      ok: true,
      state: 'begun',
      break_id: 'break-original',
      source_table_id: SOURCE_ID,
      terminal_handoff_required: false,
      members: [{ ...member, user_id: PLAYER_TWO, winner_request_id: 'already-won' }, member],
    });
    expect(moveRpc).toHaveBeenCalledTimes(1);
    expect(moveRpc.mock.calls[0][0].requestId).toBe(active);
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
  });

  it('replays the exact immutable amendment after a lost response', async () => {
    const { manager } = liveHarness();
    const state = {
      ok: true,
      state: 'begun',
      break_id: 'break-original',
      source_table_id: SOURCE_ID,
      lifecycle: '9007199254740993',
      members: [
        {
          user_id: PLAYER_ONE,
          active_request_id: 'request-original',
          winner_request_id: null,
        },
      ],
    };
    const amend = vi.fn().mockRejectedValue(new Error('response lost'));
    manager.tableBreakRpc = () => ({ amend });
    await expect(
      manager.amendTournamentBreakMember(state, PLAYER_ONE, DESTINATION_ID, 3)
    ).rejects.toThrow();
    await expect(
      manager.amendTournamentBreakMember(state, PLAYER_ONE, DESTINATION_ID, 4)
    ).rejects.toThrow();
    expect(amend.mock.calls[1][0]).toEqual(amend.mock.calls[0][0]);
    expect(amend.mock.calls[0][0].newRequestId).not.toBe('request-original');
    expect(amend.mock.calls[0][0].destinationSeatNumber).toBe(3);
  });

  it('advances to later discovery entries after a permanent refusal', async () => {
    const { manager } = liveHarness();
    const page = [{ break_id: 'refused' }, { break_id: 'eligible' }];
    manager.discoverTournamentBreaks = vi.fn().mockResolvedValue(page);
    const visit = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry mismatch'))
      .mockResolvedValueOnce(undefined);
    await expect(manager.visitTournamentBreakPage(visit)).resolves.toBe(true);
    expect(visit.mock.calls.map(([state]) => state.break_id)).toEqual(['refused', 'eligible']);
  });
  it('requests durable park before physical drain and persisted begin', async () => {
    const { manager, engine } = liveHarness();
    const order: string[] = [];
    engine.parkForTournamentMove.mockImplementation(async () => {
      order.push('physical-park');
      return true;
    });
    const api = {
      tableState: vi.fn(async () => ({
        ok: true,
        excluded: false,
        lifecycle: '1',
        table_id: SOURCE_ID,
      })),
      requestPark: vi.fn(async (breakId: string) => {
        order.push('durable-park');
        return {
          ok: true,
          break_id: breakId,
          source_table_id: SOURCE_ID,
          lifecycle: '1',
          state: 'park_requested',
          members: [],
        };
      }),
      begin: vi.fn(async (breakId: string, members: unknown[]) => {
        order.push('durable-begin');
        return {
          ok: true,
          break_id: breakId,
          source_table_id: SOURCE_ID,
          lifecycle: '1',
          state: 'begun',
          members,
        };
      }),
    };
    manager.tableBreakRpc = () => api;
    const requested = await manager.requestTournamentBreakPark(SOURCE_ID);
    manager.pendingTournamentBreakBegins.set(requested.break_id, [
      {
        user_id: PLAYER_ONE,
        source_seat_id: PLAYER_TWO,
        source_seat_number: 2,
        occupancy_id: DESTINATION_ID,
        request_id: TOURNAMENT_ID,
        destination_table_id: DESTINATION_ID,
        destination_seat_number: 3,
      },
    ]);
    await manager.prepareParkedTournamentBreak(requested);
    expect(order).toEqual(['durable-park', 'physical-park', 'durable-begin']);
    expect(moveRpc).not.toHaveBeenCalled();
  });
  it('does not release break custody when the budget expires during park', async () => {
    const { manager, engine } = liveHarness();
    manager.retainTournamentBreakSource('break-original', SOURCE_ID, engine);
    engine.parkForTournamentMove.mockImplementation(async () => {
      manager.running = false;
      return true;
    });
    await manager.executePlayerMoves([move()]);
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
    expect(moveRpc).not.toHaveBeenCalled();
  });
});
