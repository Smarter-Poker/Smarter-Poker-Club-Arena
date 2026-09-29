/**
 * A RETAINED BREAK SOURCE IS NOT A SEAT MOVE (2026-09-25).
 *
 * On production release 778075b4, thirteen tournaments logged
 *
 *   Error: Tournament <id> retained an unresolved seat-move UUID
 *
 * 5,678 times in twenty-five minutes, inside the AggregateError that failed
 * every `TournamentManagerBase.stop()`. Not one of them had a seat-move UUID:
 * `Tournament.atomic_move_refused_or_unknown` - the only event that can put an
 * ambiguous UUID in `pendingTournamentSeatMoveOutcomes` - had not fired once in
 * the six-hour life of the process, and neither had any of the four replay
 * diagnostics. The refusal came from `retainedTournamentBreakSources.size > 0`,
 * a guard #4799 added to the manager-SHUTDOWN branch of the same certificate
 * that the recovery branch uses, and which nothing on the shutdown path can
 * ever clear. Twenty managers quarantined, the restart gate shut.
 *
 * These cases pin both halves of the repair:
 *
 *  1. The shutdown certificate no longer refuses for a retained break source
 *     whose engine has released process ownership - that retention is local
 *     bookkeeping this teardown discards, while the break row, its members and
 *     their immutable request identities are durable and re-discovered by the
 *     successor.
 *  2. Everything that IS an obligation still refuses, and now says which one it
 *     is. A pending UUID is still replayed to a receipt and never dropped; a
 *     retained source that still owns a running engine still refuses; the
 *     recovery branch's own sibling guard is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const moveRpc = vi.hoisted(() => vi.fn());
vi.mock('./tournamentSeatMoveRpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tournamentSeatMoveRpc.js')>();
  return { ...actual, moveTournamentPlayerAtomically: moveRpc };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { TournamentManager } from './TournamentManager.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentSeatMoveOutcomeUnknownError } from './tournamentSeatMoveRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000101';
const SOURCE_ID = '00000000-0000-4000-8000-000000000102';
const DESTINATION_ID = '00000000-0000-4000-8000-000000000103';
const PLAYER_ONE = '00000000-0000-4000-8000-000000000104';
const BREAK_ID = 'break-original';

function receipt(input: any): any {
  return {
    requestId: input.requestId,
    tournamentId: input.tournamentId,
    userId: input.userId,
    sourceTableId: input.sourceTableId,
    destinationTableId: input.destinationTableId,
    sourceSeatId: '00000000-0000-4000-8000-000000000105',
    destinationSeatId: '00000000-0000-4000-8000-000000000106',
    sourceSeatNumber: 2,
    destinationSeatNumber: input.destinationSeatNumber,
    stack: 100,
    movedAt: '2026-09-25T12:00:00.000Z',
    replayed: true,
    sourceMode: input.sourceMode,
  };
}

function harness(): { manager: any; engine: any; gameServer: any } {
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
    ownsTournamentTableEngine: vi.fn(() => true),
  };
  const manager = new TournamentManager(TOURNAMENT_ID, gameServer as never) as any;
  manager.running = true;
  manager.eliminationSweepSignal = null;
  manager.eliminationSweepDeadlineAt = 0;
  manager.tableEngines = new Map([[SOURCE_ID, engine]]);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  return { manager, engine, gameServer };
}

function move(): any {
  return {
    playerId: PLAYER_ONE,
    fromTableId: SOURCE_ID,
    fromSeat: 2,
    toTableId: DESTINATION_ID,
    toSeat: 3,
    reason: 'Balance: source to destination',
  };
}

describe('the manager-shutdown seat-move certificate', () => {
  beforeEach(() => {
    moveRpc.mockReset();
  });

  it('certifies a teardown whose only retention is a drained break source', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);

    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(true);

    expect(manager.seatMoveQuarantineRefusal()).toBeNull();
    // The retention itself is untouched: `captureDrainedF06Custody` still reads
    // it on the failed-stop fallback path.
    expect(manager.retainedTournamentBreakSources.size).toBe(1);
  });

  it('certifies a retained source whose engine has already left the registry', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);
    manager.tableEngines.delete(SOURCE_ID);

    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(true);
    expect(manager.seatMoveQuarantineRefusal()).toBeNull();
  });

  it('still refuses, by name, while a retained source owns an unjoined engine', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);
    engine.hasReleasedProcessOwnership.mockReturnValue(false);

    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(false);
    expect(manager.seatMoveQuarantineRefusal()).toBe('shutdown:break_source_owns_running_engine');
  });

  it('still refuses, by name, while an engine claims a move boundary', async () => {
    const { manager, engine } = harness();
    engine.hasClaimedTournamentMoveBoundary.mockReturnValue(true);

    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(false);
    expect(manager.seatMoveQuarantineRefusal()).toBe('shutdown:claimed_move_boundary');
  });

  it('never discards an ambiguous UUID: a failed replay refuses and keeps it', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(1);
    const original = moveRpc.mock.calls[0][0];

    moveRpc.mockRejectedValueOnce(new Error('replay transport refused'));
    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(false);

    expect(manager.seatMoveQuarantineRefusal()).toBe('shutdown:replay_unresolved');
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(1);
    expect(moveRpc.mock.calls[1][0]).toEqual(original);
  });

  it('certifies only after the exact UUID has replayed to a receipt', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);
    moveRpc.mockRejectedValueOnce(new TournamentSeatMoveOutcomeUnknownError('response lost'));
    await manager.executePlayerMoves([move()]);
    const original = moveRpc.mock.calls[0][0];

    moveRpc.mockImplementationOnce(async (input: any) => receipt(input));
    await expect(manager.resolveTournamentSeatMoveQuarantine(null, null)).resolves.toBe(true);

    expect(moveRpc.mock.calls[1][0]).toEqual(original);
    expect(manager.pendingTournamentSeatMoveOutcomes.size).toBe(0);
    expect(manager.seatMoveQuarantineRefusal()).toBeNull();
  });

  it('leaves the recovery branch refusing for its own retained source with a claimed park', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);
    engine.hasClaimedTournamentMoveBoundary.mockReturnValue(true);

    await expect(manager.resolveTournamentSeatMoveQuarantine(SOURCE_ID, engine)).resolves.toBe(
      false
    );

    expect(manager.seatMoveQuarantineRefusal()).toBe('recovery:break_source_retained');
    expect(engine.releaseTournamentMovePause).not.toHaveBeenCalled();
    expect(manager.retainedTournamentBreakSources.get(SOURCE_ID)?.engine).toBe(engine);
  });

  // 2026-09-26: a retained source whose park was never claimed holds no move
  // decision; recovery releases it so the killed engine can be replaced
  // (anUnclaimedBreakSourceIsRebuilt.law.test.ts).
  it('lets recovery replace a retained source whose park was never claimed', async () => {
    const { manager, engine } = harness();
    expect(manager.retainTournamentBreakSource(BREAK_ID, SOURCE_ID, engine)).toBe(true);

    await expect(manager.resolveTournamentSeatMoveQuarantine(SOURCE_ID, engine)).resolves.toBe(
      true
    );

    expect(manager.seatMoveQuarantineRefusal()).toBeNull();
    expect(manager.retainedTournamentBreakSources.has(SOURCE_ID)).toBe(false);
  });
});

describe('the stop diagnostic', () => {
  class Harness extends TournamentManagerBase {
    refusal: string | null = null;
    protected startEliminationChecker() {}
    protected async recalculateEliminatedPrizes() {
      return true;
    }
    protected async resolveTournamentSeatMoveQuarantine(): Promise<boolean> {
      this.noteSeatMoveQuarantineRefusal(this.refusal);
      return this.refusal === null;
    }
  }

  const reasons = async (manager: any): Promise<string[]> => {
    try {
      await manager.stop();
    } catch (error) {
      const inner = (error as AggregateError).errors ?? [error];
      return inner.map((item: unknown) => String((item as Error).message ?? item));
    }
    return [];
  };

  it('reports the clause that refused, not a UUID it never held', async () => {
    const manager = new Harness(TOURNAMENT_ID, {
      unregisterTournamentTableEngine: vi.fn(() => true),
    } as never) as any;
    manager.refusal = 'shutdown:claimed_move_boundary';

    const messages = await reasons(manager);

    expect(messages).toEqual([
      `Tournament ${TOURNAMENT_ID} refused its seat-move release certificate: ` +
        'shutdown:claimed_move_boundary',
    ]);
    expect(messages.join('\n')).not.toContain('unresolved seat-move UUID');
  });

  it('names an unnamed refusal rather than inventing one', async () => {
    const manager = new Harness(TOURNAMENT_ID, {
      unregisterTournamentTableEngine: vi.fn(() => true),
    } as never) as any;
    vi.spyOn(manager, 'resolveTournamentSeatMoveQuarantine').mockResolvedValue(false);

    const messages = await reasons(manager);

    expect(messages).toEqual([
      `Tournament ${TOURNAMENT_ID} refused its seat-move release certificate: refusal_unnamed`,
    ]);
  });
});
