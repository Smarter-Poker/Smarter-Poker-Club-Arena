import { describe, expect, it, vi } from 'vitest';
import { TournamentAbortBoundary } from './TournamentAbortBoundary.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const identity = {
    lifecycle: '23',
    hand_number: 17,
    engine_id: 'original-engine',
    allocation_epoch: 'epoch',
  };
  const engine = {
    parkForTournamentAbort: vi.fn(async () => true),
    prepareTournamentAbortBoundary: vi.fn(async () => {}),
    captureParkedTournamentAbortIdentity: vi.fn(() => identity as typeof identity | null),
    captureStoppedTournamentAbortIdentity: vi.fn(() => identity as typeof identity | null),
    retireTournamentAbortBoundary: vi.fn(async () => {}),
  };
  const deps = {
    current: vi.fn(() => true),
    joinManagerTails: vi.fn(async () => {}),
    joinRetiredManagerTails: vi.fn(async () => {}),
    managerReadyToFence: vi.fn(() => true),
    fenceManager: vi.fn(),
    managerDrained: vi.fn(() => true),
    acknowledge: vi.fn(
      async (_table: string, _hand: number, _evidence: Record<string, unknown>) => ({ ok: true })
    ),
  };
  const request = {
    operation_id: 'operation',
    tournament_id: 'tournament',
    current_generation: 'generation',
    tables: [{ table_id: 'table', lifecycle: '23', required: true }],
  };
  const owner = new TournamentAbortBoundary(request, [['table', engine]], deps);
  return { owner, engine, deps, request };
}
describe('the explicit abort owner positively joins original writers', () => {
  it('joins duplicate requests while the accepted hand is still running', async () => {
    const f = fixture();
    const hand = deferred();
    f.engine.parkForTournamentAbort.mockImplementation(async () => {
      await hand.promise;
      return true;
    });
    const first = f.owner.run();
    const second = f.owner.run();
    expect(first).toBe(second);
    expect(f.deps.fenceManager).not.toHaveBeenCalled();
    expect(f.deps.acknowledge).not.toHaveBeenCalled();
    hand.resolve();
    await first;
    expect(f.engine.parkForTournamentAbort).toHaveBeenCalledTimes(1);
    await f.owner.run();
    expect(f.deps.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('does not revoke an accepted manager tail before it finishes', async () => {
    const f = fixture();
    const tail = deferred();
    f.deps.joinManagerTails.mockReturnValueOnce(tail.promise);
    const run = f.owner.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.deps.fenceManager).not.toHaveBeenCalled();
    tail.resolve();
    await run;
    expect(f.deps.joinManagerTails).toHaveBeenCalledTimes(2);
    expect(f.deps.acknowledge).toHaveBeenCalledWith(
      'table',
      17,
      expect.objectContaining({
        physical_stopped: true,
        parked_before_retirement: true,
        manager_tail_joined: true,
        bank_state_write_pending: false,
        source_table_ids: ['table'],
        engine_id: 'original-engine',
        lifecycle: '23',
      })
    );
  });
  it('never turns a park timeout into permission to refund or unpark', async () => {
    const f = fixture();
    f.engine.parkForTournamentAbort.mockResolvedValue(false);
    expect(await f.owner.run()).toMatchObject({ state: 'pending' });
    expect(f.deps.fenceManager).not.toHaveBeenCalled();
    expect(f.deps.acknowledge).not.toHaveBeenCalled();
  });
  it('leaves an accepted award timer alive until its original tail finishes', async () => {
    const f = fixture();
    f.deps.managerReadyToFence.mockReturnValue(false);
    expect(await f.owner.run()).toMatchObject({ reason: 'accepted_manager_tail_pending' });
    expect(f.deps.fenceManager).not.toHaveBeenCalled();
    expect(f.deps.acknowledge).not.toHaveBeenCalled();
    f.deps.managerReadyToFence.mockReturnValue(true);
    expect(await f.owner.run()).toMatchObject({ state: 'acknowledged' });
  });
  it('refuses incomplete physical writer coverage, including a pending bank save', async () => {
    const f = fixture();
    f.engine.captureParkedTournamentAbortIdentity.mockReturnValue(null);
    expect(await f.owner.run()).toMatchObject({ reason: 'physical_writer_not_drained' });
    expect(f.deps.acknowledge).not.toHaveBeenCalled();
  });
  it('retains original ownership on unknown ACK and reattaches the same operation', async () => {
    const f = fixture();
    f.deps.acknowledge.mockRejectedValueOnce(Error('response lost'));
    await expect(f.owner.run()).rejects.toThrow('response lost');
    expect(await f.owner.run()).toMatchObject({ state: 'acknowledged', operation_id: 'operation' });
    expect(f.deps.acknowledge).toHaveBeenCalledTimes(2);
    expect(f.deps.acknowledge.mock.calls[0][0]).toBe(f.deps.acknowledge.mock.calls[1][0]);
  });
  it('re-proves the same originals when persisted current certification became ineffective', async () => {
    const f = fixture();
    await f.owner.run();
    f.engine.captureStoppedTournamentAbortIdentity.mockReturnValue(null);
    expect(await f.owner.run(true)).toMatchObject({ reason: 'physical_writer_not_drained' });
    expect(f.deps.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('joins the original stopped-bank write before ACK and retains a partial stop on retry', async () => {
    const f = fixture();
    const bank = deferred();
    f.engine.retireTournamentAbortBoundary.mockImplementationOnce(async () => {
      await bank.promise;
      throw Error('unknown bank write');
    });
    const run = f.owner.run();
    await vi.waitFor(() => expect(f.engine.retireTournamentAbortBoundary).toHaveBeenCalledTimes(1));
    expect(f.deps.acknowledge).not.toHaveBeenCalled();
    bank.resolve();
    await expect(run).rejects.toThrow('unknown bank write');
    await f.owner.run();
    expect(f.engine.parkForTournamentAbort).toHaveBeenCalledTimes(1);
    expect(f.deps.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('refuses a foreign generation before any physical side effect', async () => {
    const f = fixture();
    f.deps.current.mockReturnValue(false);
    expect(await f.owner.run()).toMatchObject({ reason: 'original_owner_changed' });
    expect(f.engine.parkForTournamentAbort).not.toHaveBeenCalled();
  });
  it('refuses missing original tables instead of certifying their absence', async () => {
    const f = fixture();
    f.request.tables.push({ table_id: 'retained-other-table', lifecycle: '24', required: true });
    expect(await f.owner.run()).toMatchObject({ reason: 'original_table_coverage_incomplete' });
    expect(f.engine.parkForTournamentAbort).not.toHaveBeenCalled();
  });
});
