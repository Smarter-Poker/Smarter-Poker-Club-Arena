import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as db from '../services/supabase.js';
import * as moves from '../services/supabase/seatMoves.js';

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
  engine.forcedLeaves = new Set(['forced']);
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.onLeaveRefusedAtSettlement = vi.fn();
  const leaves = deferred<string[]>();
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
    expect(h.leaveCall).toHaveBeenCalledWith(
      h.engine.tableId,
      'club',
      expect.any(Function),
      h.engine.forcedLeaves
    );
    expect(h.moveRead).toHaveBeenCalledWith(h.engine.tableId);
    h.pending.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    h.leaves.resolve(['departed']);
    await boundary;
    expect(completed).toHaveBeenCalledWith({ cashedOutIds: ['departed'], pendingMoves: [] });
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
  it('retired authority neither starts work nor reflects a delayed leave refusal', async () => {
    const h = setup();
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    await h.engine.readCashHandDepartures();
    expect(h.leaveCall).not.toHaveBeenCalled();
    h.engine.lifecycleCanMutate.mockReturnValue(true);
    const boundary = h.engine.readCashHandDepartures();
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    h.leaveCall.mock.calls[0][2]?.('forced', 4000);
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

  it('a read that FAILED executes nothing and is not an empty boundary', async () => {
    /* D1: `null` is "could not read". Before this it was `[]`, which every
       caller took for "no moves pending" - and the announce path PRUNES from
       that answer, releasing swap holds that are the only thing keeping a
       player out of a hand the other table is about to move them out of. */
    const rpc = vi.spyOn(db.supabase, 'rpc');
    const result = await moves.executePendingSeatMoves('table', { announcedOnly: true }, null);
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ done: [], held: [], refused: [] });
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
