import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as db from '../services/supabase.js';
import * as moves from '../services/supabase/seatMoves.js';
import { LeavePendingAttempt } from '../observability/LeavePendingDiagnostic.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(cluster = true) {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = 'aaaaaaaa-1111-4111-8111-111111111111';
  engine.tableInfo = { club_id: 'club', cluster_id: cluster ? 'game' : null };
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.onLeaveRefusedAtSettlement = vi.fn();
  const leaves = deferred<Array<{ userId: string; occupancyId: string }>>();
  const pending = deferred<moves.PendingSeatMove[]>();
  const leaveCall = vi.spyOn(db, 'processLeavePending').mockReturnValue(leaves.promise);
  const moveRead = vi.spyOn(moves, 'pendingSeatMoves').mockReturnValue(pending.promise);
  return { engine, leaves, pending, leaveCall, moveRead };
}
afterEach(() => vi.restoreAllMocks());

describe('cash boundary overlaps candidate reads without moving ahead of departures', () => {
  it('starts both calls and does not complete while a cash-out still runs', async () => {
    const h = setup();
    const completed = vi.fn();
    const boundary = h.engine.readCashHandDepartures().then(completed);
    /* PIN MOVED 2026-09-11 (CLAUDE.md 5.8, drift incident bf4ef6e0): the sweep
       now also takes a DEPARTURE REPORTER, so a cash-out that has already
       committed is owed a teardown even when this boundary goes on to throw.
       Same two calls starting together, one argument wider - the pin follows
       the mechanism and gets stricter, rather than being relaxed to `any`. */
    expect(h.leaveCall).toHaveBeenCalledWith(
      h.engine.tableId,
      'club',
      expect.any(Function),
      expect.any(Function),
      undefined
    );
    h.leaveCall.mock.calls[0][3]?.('departed', 'occupancy-departed');
    expect(h.engine.departedSeatsAwaitingTeardown).toEqual([
      { userId: 'departed', occupancyId: 'occupancy-departed' },
    ]);
    expect(h.moveRead).toHaveBeenCalledWith(h.engine.tableId, undefined);
    h.pending.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    h.leaves.resolve([{ userId: 'departed', occupancyId: 'original' }]);
    await boundary;
    expect(completed).toHaveBeenCalledWith({
      cashedOutIds: [{ userId: 'departed', occupancyId: 'original' }],
      pendingMoves: [],
    });
  });
  it('observes a move-read rejection immediately but waits for the leave result', async () => {
    const h = setup();
    const failed = vi.fn();
    const boundary = h.engine.readCashHandDepartures().catch(failed);
    const error = new Error('move read unavailable');
    h.pending.reject(error);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    h.leaves.resolve([]);
    await boundary;
    expect(failed).toHaveBeenCalledWith(error);
  });
  it('does not release the boundary after a leave failure until its sibling read settles', async () => {
    const h = setup();
    const failed = vi.fn();
    const boundary = h.engine.readCashHandDepartures().catch(failed);
    const error = new Error('leave failed');
    h.leaves.reject(error);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    h.pending.resolve([]);
    await boundary;
    expect(failed).toHaveBeenCalledWith(error);
  });
  it('does not read move candidates for a table outside a cluster', async () => {
    const h = setup(false);
    h.leaves.resolve([]);
    await expect(h.engine.readCashHandDepartures()).resolves.toEqual({
      cashedOutIds: [],
      pendingMoves: [],
    });
    expect(h.moveRead).not.toHaveBeenCalled();
  });
  it.each(['leaves', 'moves'] as const)(
    'retains both failures when %s rejects first',
    async (first) => {
      const h = setup();
      const diagnostic = new LeavePendingAttempt(2);
      const leaveError = Object.freeze(new Error('departure timeout'));
      const moveError = Object.freeze(new Error('move timeout'));
      const failed = vi.fn();
      const boundary = h.engine.readCashHandDepartures(diagnostic).catch(failed);
      if (first === 'leaves') h.leaves.reject(leaveError);
      else h.pending.reject(moveError);
      await Promise.resolve();
      await Promise.resolve();
      expect(failed).not.toHaveBeenCalled();
      if (first === 'leaves') h.pending.reject(moveError);
      else h.leaves.reject(leaveError);
      await boundary;
      expect(failed).toHaveBeenCalledWith(leaveError);
      expect(diagnostic.snapshot()).toMatchObject({
        selected_failure: 'departures',
        departures: { status: 'rejected', error: { message: 'departure timeout' } },
        move_read: { status: 'rejected', error: { message: 'move timeout' } },
      });
      expect(h.engine.lifecycleCanMutate).toHaveBeenCalledTimes(1);
    }
  );
  it('retains the actual skipped branch even if cluster metadata changes during the sweep', async () => {
    const h = setup(false);
    const diagnostic = new LeavePendingAttempt(1);
    const boundary = h.engine.readCashHandDepartures(diagnostic);
    h.engine.tableInfo.cluster_id = 'new-game';
    h.leaves.resolve([]);
    await boundary;
    expect(diagnostic.snapshot().move_read.status).toBe('skipped_non_cluster');
    expect(h.moveRead).not.toHaveBeenCalled();
  });
  it('retired authority neither starts work nor reflects a delayed leave refusal', async () => {
    const h = setup();
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    await h.engine.readCashHandDepartures();
    expect(h.leaveCall).not.toHaveBeenCalled();
    h.engine.lifecycleCanMutate.mockReturnValue(true);
    const boundary = h.engine.readCashHandDepartures();
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    h.leaveCall.mock.calls[0][2]?.('forced', 4000, 'original');
    expect(h.engine.onLeaveRefusedAtSettlement).not.toHaveBeenCalled();
    h.leaves.resolve([]);
    h.pending.resolve([]);
    await boundary;
  });
});

describe('a prefetched move still goes through the authoritative executor', () => {
  const candidate = {
    move_id: 'move',
    player_id: 'player',
    announced_at: '2026-09-08',
    reason: 'seat_change',
  } as moves.PendingSeatMove;
  it('keeps a later mirror failure local after the move service returned', async () => {
    const engine = Object.create(ServerTableEngine.prototype) as any;
    engine.tableId = 'table';
    engine.tableInfo = { cluster_id: 'game' };
    engine.isTournamentTable = () => false;
    engine.lifecycleCanMutate = vi.fn(() => true);
    engine.reconcileSeatMoveHolds = vi.fn();
    engine.announcedSeatMoves = new Set();
    engine.heldForSwap = new Set();
    const failure = Object.freeze(new Error('mirror unavailable'));
    engine.hub = {
      emitEvent: vi.fn(() => {
        throw failure;
      }),
    };
    const execution = vi.spyOn(moves, 'executePendingSeatMoves').mockResolvedValue({
      done: [],
      held: [],
      refused: [{ move_id: 'move', player_id: 'player', reason: 'destination_full' }],
    });
    const diagnostic = new LeavePendingAttempt(1);
    await expect(
      engine.executePendingSeatMoves({ announcedOnly: true }, [candidate], diagnostic)
    ).rejects.toBe(failure);
    expect(execution).toHaveBeenCalledOnce();
    expect(diagnostic.snapshot()).toMatchObject({
      local_phase: 'move_mirrors',
      selected_failure: 'local',
      move_execution: { status: 'fulfilled', error: null },
    });
    expect(engine.lifecycleCanMutate).toHaveBeenCalledTimes(2);
  });
  it('executes an announced candidate once and respects a disappeared source seat', async () => {
    const rpc = vi
      .spyOn(db.supabase, 'rpc')
      .mockResolvedValue({ data: { ok: false, reason: 'player_not_seated' }, error: null } as any);
    const result = await moves.executePendingSeatMoves('table', { announcedOnly: true }, [
      candidate,
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_cash_seat_move_execute', { p_move_id: 'move' });
    /* PIN MOVED 2026-09-09 (must-move audit lane D, CLAUDE.md 5.8). The
       behaviour this guards is unchanged - the candidate is executed once and
       nothing lands - but the outcome now also REPORTS the refusal, because a
       player who was promised "Moving After This Hand" and then was not moved
       used to be told nothing at all. `player_not_seated` is terminal, so it
       belongs in `refused`; the freeze and a retryable deadlock never do. */
    expect(result).toEqual({
      done: [],
      held: [],
      refused: [{ move_id: 'move', player_id: 'player', reason: 'player_not_seated' }],
    });
  });

  it('a read that FAILED throws out of the boundary rather than reading as empty', async () => {
    /* D1, through main's contract (merged 2026-09-10): an unreadable
       enumeration must never be mistaken for "no moves pending", because the
       announce path PRUNES from that answer and would release a swap hold -
       the only thing keeping a player out of a hand the OTHER table's
       transaction is about to move them out of. The service throws; the
       engine translates that into "change nothing" at its two call sites, and
       settlement's runStep owns it as a reported, alerted step failure. */
    const rpc = vi
      .spyOn(db.supabase, 'rpc')
      .mockResolvedValue({ data: null, error: { message: 'read failed' } } as any);
    await expect(moves.executePendingSeatMoves('table', { announcedOnly: true })).rejects.toThrow(
      'read failed'
    );
    expect(rpc).toHaveBeenCalledWith('fn_cash_seat_moves_pending', { p_table_id: 'table' });
  });
  it('does not execute unannounced candidates or re-read a known empty boundary', async () => {
    const rpc = vi.spyOn(db.supabase, 'rpc');
    await moves.executePendingSeatMoves('table', { announcedOnly: true }, [
      { ...candidate, announced_at: null },
    ]);
    await moves.executePendingSeatMoves('table', { announcedOnly: true }, []);
    expect(rpc).not.toHaveBeenCalled();
  });
});
