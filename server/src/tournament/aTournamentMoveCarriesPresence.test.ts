/**
 * A TOURNAMENT MOVE CARRIES PRESENCE (2026-10-05).
 *
 * fn_move_tournament_player opens the destination chair with
 * is_sitting_out=false and sit_out_at=NULL, and nothing engine-side crossed
 * with the player, so an absent player met every new table as a fresh,
 * CONNECTED seat with a clean strike count: the whole action clock again,
 * a new reconnect allowance, the ladder restarted. The source's presence is
 * now deposited before the RPC and adopted by the destination ahead of any
 * registration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moveRpc = vi.hoisted(() => vi.fn());
vi.mock('./tournamentSeatMoveRpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tournamentSeatMoveRpc.js')>();
  return { ...actual, moveTournamentPlayerAtomically: moveRpc };
});

import { TournamentManager } from './TournamentManager.js';
import { TournamentSeatMoveRefusedError } from './tournamentSeatMoveRpc.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import {
  claimTournamentMovePresence,
  depositTournamentMovePresence,
  resetTournamentMovePresence,
} from '../engine/SeatMovePresence.js';
import type { DisconnectFsmEntry } from '../engine/DisconnectEngine.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-0000000000a1';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000a2';
const DESTINATION_ID = '00000000-0000-4000-8000-0000000000a3';
const PLAYER = '00000000-0000-4000-8000-0000000000a4';

const satOut = (sinceMs: number): DisconnectFsmEntry => ({
  state: 'SAT_OUT',
  sinceMs,
  graceDeadlineMs: null,
  sitOutSinceMs: sinceMs,
  sitOutOrbits: 1,
  sitOutReason: 'forced',
  strikes: 3,
});

function receipt(input: any): any {
  return {
    requestId: input.requestId,
    tournamentId: input.tournamentId,
    userId: input.userId,
    sourceTableId: input.sourceTableId,
    destinationTableId: input.destinationTableId,
    sourceSeatId: '00000000-0000-4000-8000-0000000000a6',
    destinationSeatId: '00000000-0000-4000-8000-0000000000a7',
    sourceSeatNumber: 2,
    destinationSeatNumber: input.destinationSeatNumber,
    stack: 100,
    movedAt: '2026-10-05T12:00:00.000Z',
    replayed: false,
    sourceMode: input.sourceMode,
  };
}

function harness(presence: DisconnectFsmEntry | null) {
  const engine = {
    parkForTournamentMove: vi.fn().mockResolvedValue(true),
    releaseTournamentMovePause: vi.fn(),
    executeTournamentMoveAtBoundary: vi.fn(async (_o: string, op: () => Promise<any>) => op()),
    hasReleasedProcessOwnership: vi.fn(() => true),
    hasClaimedTournamentMoveBoundary: vi.fn(() => false),
    presenceForTournamentMove: vi.fn(() => presence),
  };
  const gameServer = {
    getTableEngine: vi.fn(() => engine),
    ownsTournamentTableEngine: vi.fn(() => true),
  };
  const manager = new TournamentManager(TOURNAMENT_ID, gameServer as never) as any;
  manager.running = true;
  manager.eliminationSweepSignal = null;
  manager.eliminationSweepDeadlineAt = 0;
  manager.tableEngines = new Map([[SOURCE_ID, engine]]);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  return { manager, engine };
}

const move = () => ({
  playerId: PLAYER,
  fromTableId: SOURCE_ID,
  fromSeat: 2,
  toTableId: DESTINATION_ID,
  toSeat: 3,
  reason: 'Balance: source to destination',
});

beforeEach(() => {
  moveRpc.mockReset();
  resetTournamentMovePresence();
});
afterEach(() => vi.restoreAllMocks());

describe('the manager hands the source presence to the destination', () => {
  it('deposits it before the move RPC runs', async () => {
    const entry = satOut(Date.now() - 60_000);
    const { manager } = harness(entry);
    let seenDuringRpc: unknown = 'not called';
    moveRpc.mockImplementation(async (input: any) => {
      // What the destination would see if it swept its roster mid-RPC.
      seenDuringRpc = claimTournamentMovePresence(PLAYER, DESTINATION_ID);
      if (seenDuringRpc) {
        depositTournamentMovePresence(PLAYER, DESTINATION_ID, seenDuringRpc as any);
      }
      return receipt(input);
    });
    await expect(manager.executePlayerMoves([move()])).resolves.toBe(1);
    expect(seenDuringRpc).toMatchObject({ fromTableId: SOURCE_ID, fsm: entry });
    expect(claimTournamentMovePresence(PLAYER, DESTINATION_ID)?.fsm).toEqual(entry);
  });

  it('withdraws it when the move is refused', async () => {
    const { manager } = harness(satOut(Date.now()));
    moveRpc.mockRejectedValue(new TournamentSeatMoveRefusedError('refused'));
    await manager.executePlayerMoves([move()]);
    expect(claimTournamentMovePresence(PLAYER, DESTINATION_ID)).toBeNull();
  });

  it('a source that cannot answer never blocks the move', async () => {
    const { manager, engine } = harness(null);
    engine.presenceForTournamentMove.mockImplementation(() => {
      throw new Error('boom');
    });
    moveRpc.mockImplementation(async (input: any) => receipt(input));
    await expect(manager.executePlayerMoves([move()])).resolves.toBe(1);
  });
});

describe('the destination adopts it ahead of any registration', () => {
  function destination() {
    const engine = new ServerTableEngine(DESTINATION_ID) as any;
    engine.isTournamentTable = () => true;
    engine.seatedPlayers = [
      { user_id: PLAYER, seat_number: 3, is_horse: false, is_sitting_out: true, stack: 100 },
    ];
    return engine;
  }

  it('an absent player arrives still sat out, with their strikes and clock', () => {
    const since = Date.now() - 90_000;
    depositTournamentMovePresence(PLAYER, DESTINATION_ID, {
      requestId: '00000000-0000-4000-8000-0000000000a9',
      fromTableId: SOURCE_ID,
      fsm: satOut(since),
    });
    const engine = destination();
    engine.adoptTournamentMovePresence();
    expect(engine.disconnectEngine.isSittingOut(DESTINATION_ID, PLAYER)).toBe(true);
    const fsm = engine.disconnectEngine.getFsmState(DESTINATION_ID, PLAYER);
    expect(fsm).toMatchObject({ state: 'SAT_OUT', sitOutSinceMs: since, strikes: 3 });
    // Taken once.
    expect(claimTournamentMovePresence(PLAYER, DESTINATION_ID)).toBeNull();
  });

  it('runs inside adoptMovedPresence, which both loops call before registering', async () => {
    depositTournamentMovePresence(PLAYER, DESTINATION_ID, {
      requestId: '00000000-0000-4000-8000-0000000000aa',
      fromTableId: SOURCE_ID,
      fsm: satOut(Date.now()),
    });
    const engine = destination();
    engine.lifecycleCanMutate = () => true;
    await expect(engine.adoptMovedPresence()).resolves.toBe(true);
    expect(engine.disconnectEngine.isSittingOut(DESTINATION_ID, PLAYER)).toBe(true);
  });

  it('a cash table never claims a tournament deposit', () => {
    depositTournamentMovePresence(PLAYER, DESTINATION_ID, {
      requestId: '00000000-0000-4000-8000-0000000000ab',
      fromTableId: SOURCE_ID,
      fsm: satOut(Date.now()),
    });
    const engine = destination();
    engine.isTournamentTable = () => false;
    expect(engine.presenceForTournamentMove(PLAYER)).toBeNull();
  });
});
