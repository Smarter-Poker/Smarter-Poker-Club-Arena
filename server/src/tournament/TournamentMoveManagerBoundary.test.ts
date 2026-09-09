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

function liveHarness(owned = true): { manager: any; engine: any; gameServer: any } {
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
    expect(moveRpc.mock.calls[1][1]).toEqual({ outcomeWasAlreadyUnknown: true });
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

  it('uses the no-engine path only for the explicit closed-orphan mode', async () => {
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
    await expect(manager.executePlayerMoves([move()])).resolves.toBe(0);
    expect(moveRpc).not.toHaveBeenCalled();
  });
});
