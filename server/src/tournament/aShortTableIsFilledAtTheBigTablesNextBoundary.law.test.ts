/**
 * A SHORT TABLE IS FILLED AT THE BIG TABLE'S NEXT HAND BOUNDARY (2026-10-26).
 *
 * Dan: "TABLES NEED TO ALWAYS BE BALANCED 100% OF THE TIME NO MATTER WHAT."
 *
 * Production 2026-10-26 05:00-06:00 UTC: 390 seat moves broke a table and 30
 * balanced one, platform wide, while Diamond Arena events sat at 8/3, 9/4 and
 * 7/6/6/6/6/6/5/5/4 for 10-45 minutes. The gap plan fenced the big table
 * (it was mid-hand), the table parked after its hand and waited 15 seconds
 * for a whole new sweep to come back through the shared queue and claim it.
 * It almost never did; the fence expired and the table dealt on.
 *
 * The law: the fenced source's own park edge makes the move, at once, from a
 * fresh plan, through the same atomic move door; a parked source the fresh
 * plan does not need is given straight back to its dealer; and the edge work
 * never runs while a sweep holds the manager.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
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

function fakeEngine() {
  return {
    dealing: true,
    parkForTournamentMove: vi.fn(async () => false),
    releaseTournamentMovePause: vi.fn(),
    awaitsTournamentMoveClaim: vi.fn(() => false),
    isBetweenHands: () => false,
    hasSettlementInFlight: () => false,
    wakeWaitingForPlayers: vi.fn(),
  };
}

function manager(board: BalancerTable[]) {
  const m: any = new TournamentManager(EVENT, {} as any, GENERATION, performance.now() + 60_000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.eliminationMutationAllowed = () => true;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  m.requestEliminationSweep = vi.fn();
  m.recoverF06OriginalAdmissions = vi.fn(async () => {});
  m.visitTournamentBreakPage = vi.fn(async () => true);
  m.redrivePendingTournamentSeatMoveOutcomes = vi.fn(async () => true);
  m.tournamentBreakDiscoveryComplete = true;
  m.isFinalTable = true;
  m.isOnBreak = () => false;
  m.gameServer = { ownsTournamentTableEngine: () => true };
  m.broadcast = vi.fn(async () => true);
  const engines = new Map<string, ReturnType<typeof fakeEngine>>();
  for (const t of board) engines.set(t.tableId, fakeEngine());
  m.tableEngines = engines;
  m.waitForHandComplete = vi.fn(async (tableId: string) => !engines.get(tableId)!.dealing);
  m.liveTournamentTableIdsWithPlayers = vi.fn(async () =>
    board.filter((t) => t.playerCount > 0).map((t) => t.tableId)
  );
  m.loadBalancerTables = vi.fn(async (ids: string[]) =>
    board
      .filter((t) => ids.includes(t.tableId))
      .map((t) => ({ ...t, players: t.players.map((p) => ({ ...p })) }))
  );
  m.executePlayerMoves = vi.fn(async (moves: unknown[]) => moves.length);
  const park = (tableId: string) => {
    const engine = engines.get(tableId)!;
    engine.dealing = false;
    engine.awaitsTournamentMoveClaim.mockReturnValue(true);
  };
  return { m, engines, park };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe("a short table is filled at the big table's next hand boundary", () => {
  it('the 8/3 shape: a mid-hand source is fenced, and its own park edge moves the players', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, engines, park } = manager([big, short]);

    await m.checkTableBalance();
    // Mid-hand: nothing moved yet, the source is fenced for its boundary.
    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.parkForTournamentMove).toHaveBeenCalled();

    // The hand ends and the source parks: the edge is claimed here, not queued.
    park(big.tableId);
    expect(m.claimGapBalanceAtBoundary(big.tableId)).toBe(true);
    await settle();
    await settle();

    expect(m.executePlayerMoves).toHaveBeenCalledTimes(1);
    const moves = m.executePlayerMoves.mock.calls[0][0] as Array<{
      fromTableId: string;
      toTableId: string;
    }>;
    // 11 players on two tables is 6/5: two players leave the big table.
    expect(moves).toHaveLength(2);
    for (const move of moves) {
      expect(move.fromTableId).toBe(big.tableId);
      expect(move.toTableId).toBe(short.tableId);
    }
    expect(m.broadcast).toHaveBeenCalledWith('table_rebalance', {
      moveCount: 2,
      reason: 'gap_balance',
    });
    // The sweep is asked to prove the shape afterwards; it was not the mover.
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a parked source the fresh plan no longer needs is given straight back to its dealer', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const board = [big, short];
    const { m, engines, park } = manager(board);
    await m.checkTableBalance();

    // Two players bust at the big table during its hand: 6/3 -> still a gap.
    // Then one more: the board is 5/4 and balanced when the edge arrives.
    big.playerCount = 5;
    big.players = big.players.slice(0, 5);
    short.playerCount = 4;
    short.players = [...short.players, { userId: id(9999), stack: 1, seat: 9 }];
    park(big.tableId);
    expect(m.claimGapBalanceAtBoundary(big.tableId)).toBe(true);
    await settle();
    await settle();

    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
  });

  it('a table that was never fenced for balance still sends its edge to the sweep', () => {
    const { m } = manager([table(0, 8), table(1, 3)]);
    // Only a gap-balance source is claimed here; a break source is the sweep's.
    expect(m.claimGapBalanceAtBoundary(id(2000))).toBe(false);
  });

  it('an edge that arrives while a sweep holds the manager is moved when that sweep settles', async () => {
    const big = table(0, 9);
    const short = table(1, 4);
    const { m, park } = manager([big, short]);
    await m.checkTableBalance();

    m.isProcessingEliminations = true;
    park(big.tableId);
    expect(m.claimGapBalanceAtBoundary(big.tableId)).toBe(true);
    await settle();
    expect(m.executePlayerMoves).not.toHaveBeenCalled();

    m.isProcessingEliminations = false;
    m.onEliminationSweepSettled();
    await settle();
    await settle();
    expect(m.executePlayerMoves).toHaveBeenCalledTimes(1);
  });

  it('a sweep admitted during the edge move yields and is owed again afterwards', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, park } = manager([big, short]);
    await m.checkTableBalance();

    let finish!: (n: number) => void;
    m.executePlayerMoves = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)));
    park(big.tableId);
    m.claimGapBalanceAtBoundary(big.tableId);
    await settle();
    await settle();
    expect(m.boundaryBalanceInFlight).toBe(true);

    // The scheduler admits a sweep now: it must not plan beside the edge move.
    const sweepRead = vi.fn();
    m.noteEliminationSweepStep = sweepRead;
    await m.runEliminationSweep(new AbortController().signal);
    expect(sweepRead).not.toHaveBeenCalled();
    expect(m.isProcessingEliminations).toBe(false);

    finish(2);
    await settle();
    await settle();
    expect(m.boundaryBalanceInFlight).toBe(false);
    expect(m.requestEliminationSweep).toHaveBeenCalledWith('boundary_balance_settled');
  });

  it('a frozen platform or a tournament break leaves the source to the sweep and lets it deal', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, engines, park } = manager([big, short]);
    await m.checkTableBalance();
    m.isOnBreak = () => true;
    park(big.tableId);
    m.claimGapBalanceAtBoundary(big.tableId);
    await settle();
    await settle();
    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.releaseTournamentMovePause).toHaveBeenCalledTimes(1);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a seat move whose outcome is unknown keeps the park and wakes the sweep at once', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, engines, park } = manager([big, short]);
    await m.checkTableBalance();

    m.pendingTournamentSeatMoveOutcomes.set('pending', {});
    park(big.tableId);
    expect(m.claimGapBalanceAtBoundary(big.tableId)).toBe(true);
    await settle();
    await settle();

    // Releasing here would let the big table deal again and be fenced again.
    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.releaseTournamentMovePause).not.toHaveBeenCalled();
    expect(m.requestEliminationSweep).toHaveBeenCalledWith('tournament_move_parked');
    expect(m.gapBalanceFencedSources.has(big.tableId)).toBe(true);
  });

  it('a source the fresh plan needs that already sits between hands is fenced and redriven', async () => {
    // 21 players on three tables: no table is broken, only balanced.
    const big = table(0, 9);
    const short = table(1, 5);
    const mid = table(2, 7);
    const board = [big, short, mid];
    const { m, engines, park } = manager(board);
    await m.checkTableBalance();
    expect(engines.get(mid.tableId)!.parkForTournamentMove).not.toHaveBeenCalled();

    // Late registration seats two more at the middle table, which is held
    // at the hand-for-hand gate: its park edge already fired and will not
    // fire again, so only a fence plus a redrive can reach it.
    mid.playerCount = 9;
    mid.players = Array.from({ length: 9 }, (_, i) => ({
      userId: id(5000 + i),
      stack: 10_000,
      seat: i + 1,
    }));
    engines.get(mid.tableId)!.isBetweenHands = () => true;
    m.requestUrgentEliminationSweepAfter.mockClear();
    park(big.tableId);
    m.claimGapBalanceAtBoundary(big.tableId);
    await settle();
    await settle();

    expect(m.executePlayerMoves).toHaveBeenCalledTimes(1);
    expect(engines.get(mid.tableId)!.parkForTournamentMove).toHaveBeenCalled();
    expect(m.gapBalanceFencedSources.has(mid.tableId)).toBe(true);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a parked source whose fence expired while the board was read is fenced again, not released', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, engines, park } = manager([big, short]);
    await m.checkTableBalance();

    park(big.tableId);
    // The fence expired during the reads and the table dealt its next hand.
    m.waitForHandComplete = vi.fn(async () => false);
    engines.get(big.tableId)!.parkForTournamentMove.mockClear();
    m.requestUrgentEliminationSweepAfter.mockClear();
    m.claimGapBalanceAtBoundary(big.tableId);
    await settle();
    await settle();

    expect(m.executePlayerMoves).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.releaseTournamentMovePause).not.toHaveBeenCalled();
    expect(engines.get(big.tableId)!.parkForTournamentMove).toHaveBeenCalled();
    expect(m.gapBalanceFencedSources.has(big.tableId)).toBe(true);
    expect(m.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('a fenced table that became a durable break source sends its edge to the sweep', async () => {
    const big = table(0, 8);
    const short = table(1, 3);
    const { m, engines } = manager([big, short]);
    await m.checkTableBalance();
    expect(m.gapBalanceFencedSources.has(big.tableId)).toBe(true);

    m.retainedTournamentBreakSources.set(big.tableId, {
      breakId: 'break',
      engine: engines.get(big.tableId),
    });
    expect(m.claimGapBalanceAtBoundary(big.tableId)).toBe(false);
    expect(m.gapBalanceFencedSources.has(big.tableId)).toBe(false);
  });
});
