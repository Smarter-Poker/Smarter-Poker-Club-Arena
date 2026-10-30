import { describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({ supabase: io, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { TournamentManager } from './TournamentManager.js';
import { GameServer } from '../GameServer.js';
const tournament = '00000000-0000-4000-8000-000000009901';
const operation = '00000000-0000-4000-8000-000000009902';
const generation = '00000000-0000-4000-8000-000000009903';

describe('abort certificates retain physical source and lease identity', () => {
  it('joins lifecycle completion, its queued movement and the writer that movement admits', async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const lifecycle = deferred();
    const movement = deferred();
    const bank = deferred();
    const manager = new TournamentManager(tournament, {} as any) as any;
    let movementStarted = false;
    let bankStarted = false;
    let joined = false;
    void manager.trackLifecycleJob(
      lifecycle.promise.then(() => {
        void manager.runWithTournamentSeatMoveAuthority(async () => {
          movementStarted = true;
          await movement.promise;
          bankStarted = true;
          void manager.trackLifecycleJob(bank.promise);
        });
      })
    );
    const join = manager.joinTournamentAbortManagerTails(true).then(() => {
      joined = true;
    });
    lifecycle.resolve();
    await vi.waitFor(() => expect(movementStarted).toBe(true));
    expect(joined).toBe(false);
    movement.resolve();
    await vi.waitFor(() => expect(bankStarted).toBe(true));
    expect(joined).toBe(false);
    bank.resolve();
    await join;
    expect(joined).toBe(true);
    io.rpc.mockResolvedValue({ data: null, error: null });
    await manager.stop();
    io.rpc.mockReset();
  });
  it('joins queued movement promises before reading and retaining any physical roster', async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let secondStarted = false;
    const manager = new TournamentManager(
      tournament,
      {} as any,
      generation,
      performance.now() + 30_000
    ) as any;
    const request = {
      operation_id: operation,
      tournament_id: tournament,
      current_generation: generation,
      tables: [{ table_id: 'old-table', lifecycle: '1', required: true }],
    };
    io.rpc.mockClear();
    io.rpc.mockImplementation(async (name: string) =>
      name === 'fn_ca_tournament_abort_stop_state'
        ? {
            data: {
              ok: true,
              ...request,
              tables: [{ table_id: 'new-table', lifecycle: '2', required: true }],
            },
            error: null,
          }
        : { data: null, error: null }
    );
    void manager.runWithTournamentSeatMoveAuthority(async () => {
      await first;
      void manager.runWithTournamentSeatMoveAuthority(async () => {
        secondStarted = true;
        await second;
        manager.tableEngines.set('new-table', {});
      });
    });
    const result = manager.acknowledgeTournamentAbortBoundary(request);
    await Promise.resolve();
    expect(io.rpc).not.toHaveBeenCalled();
    finishFirst();
    await vi.waitFor(() => expect(secondStarted).toBe(true));
    expect(io.rpc).not.toHaveBeenCalled();
    expect(manager.tournamentAbortBoundary).toBeNull();
    finishSecond();
    expect(await result).toMatchObject({
      state: 'pending',
      reason: 'original_graph_changed_before_capture',
    });
    expect(manager.tournamentAbortBoundary).toBeNull();
    manager.tableEngines.clear();
    await manager.stop();
    io.rpc.mockReset();
  });
  it.each([
    'horseRebuyInputInFlight',
    'horseRebuyPending',
    'bountyRevealQueues',
    'mixedRecoveryOperation',
  ])('refuses an accepted detached business tail in %s before revoking its callback', (field) => {
    const manager = new TournamentManager(tournament, {} as any) as any;
    expect(manager.tournamentAbortBusinessTailsDrained()).toBe(true);
    if (field === 'horseRebuyInputInFlight') manager[field] = true;
    else if (field === 'horseRebuyPending')
      manager[field] = new Map([['purchase', Promise.resolve()]]);
    else if (field === 'mixedRecoveryOperation') manager[field] = Promise.resolve();
    else manager[field].set('table', { waiting: [{}], active: null, coalesceTimer: null });
    expect(manager.tournamentAbortBusinessTailsDrained()).toBe(false);
  });
  it.each([
    'stoppedDiagnosticOriginals',
    'satelliteQualifierEngines',
    'retainedTournamentBreakSources',
    'pendingTableBreakRetirement',
  ])('refuses a detached original in %s even when the live table UUID matches', (source) => {
    const manager = new TournamentManager(tournament, {} as any) as any;
    const original = {};
    manager.tableEngines.set('table', original);
    expect(manager.tournamentAbortSourcesMatch([['table', original]])).toBe(true);
    const detached = {};
    if (source === 'retainedTournamentBreakSources')
      manager[source].set('table', { engine: detached });
    else if (source === 'pendingTableBreakRetirement')
      manager[source] = { tableId: 'table', engine: detached };
    else manager[source].set('table', detached);
    expect(manager.tournamentAbortSourcesMatch([['table', original]])).toBe(false);
  });

  function server(state: Record<string, unknown>) {
    const manager = {
      getTournamentLeaseGeneration: () => generation,
      hasCurrentTournamentLeaseAuthority: () => true,
      retainsTournamentAbortBoundary: () => true,
      releaseTournamentAbortBoundary: vi.fn(),
      acknowledgeTournamentAbortBoundary: vi.fn(async () => ({ state: 'acknowledged' })),
    };
    const server = Object.create(GameServer.prototype) as any;
    server.tournamentEngines = new Map([[tournament, manager]]);
    server.tournamentManagerPendingLeaseReleases = new Map();
    server.tournamentManagerLeaseReleaseOperations = new Map();
    server.tournamentManagerAdmissionLeaseGenerations = new Map();
    server.stopTournamentManagerIfOwned = vi.fn(async () => {
      server.tournamentEngines.delete(tournament);
      return true;
    });
    io.rpc.mockResolvedValue({
      data: {
        ok: true,
        operation_id: operation,
        tournament_id: tournament,
        current_generation: generation,
        tables: [],
        ...state,
      },
      error: null,
    });
    return { server, manager };
  }
  it('re-proves quiescence from a previous manager generation', async () => {
    const f = server({
      state: 'quiesced',
      current_boundary_valid: false,
      quiescence_generation: 'old-generation',
    });
    await f.server.acknowledgeTournamentAbortBoundary(operation, tournament);
    expect(f.manager.acknowledgeTournamentAbortBoundary).toHaveBeenCalledTimes(1);
  });
  it('reads an effective current certificate without dispatching another physical drain', async () => {
    const f = server({
      state: 'quiesced',
      current_boundary_valid: true,
      quiescence_generation: generation,
    });
    expect(await f.server.acknowledgeTournamentAbortBoundary(operation, tournament)).toMatchObject({
      state: 'quiesced',
    });
    expect(f.manager.acknowledgeTournamentAbortBoundary).not.toHaveBeenCalled();
  });
  it('refuses terminal cleanup without the immutable fully settled receipt', async () => {
    const f = server({
      state: 'settled',
      receipt: { fully_settled: false },
      tournament_status: 'CANCELLED',
    });
    await expect(
      f.server.acknowledgeTournamentAbortBoundary(operation, tournament)
    ).rejects.toThrow('terminal_receipt_unproven');
    expect(f.server.stopTournamentManagerIfOwned).not.toHaveBeenCalled();
  });
  it('releases only the same operation and generation after actual terminal receipt readback', async () => {
    const f = server({
      state: 'settled',
      receipt: {
        fully_settled: true,
        operation_id: operation,
        tournament_id: tournament,
        quiescence: { generation },
      },
      tournament_status: 'CANCELLED',
    });
    await f.server.acknowledgeTournamentAbortBoundary(operation, tournament);
    expect(f.manager.releaseTournamentAbortBoundary).toHaveBeenCalledWith(operation);
    expect(f.server.stopTournamentManagerIfOwned).toHaveBeenCalledWith(
      tournament,
      f.manager,
      expect.any(String)
    );
  });
  it('keeps a false retirement pending and retries the same operation after its release flag changed', async () => {
    const f = server({
      state: 'settled',
      current_generation: null,
      tournament_status: 'CANCELLED',
      receipt: {
        fully_settled: true,
        operation_id: operation,
        tournament_id: tournament,
        quiescence: { generation },
      },
    });
    f.manager.retainsTournamentAbortBoundary = () => false;
    f.server.stopTournamentManagerIfOwned.mockResolvedValueOnce(false);
    await expect(
      f.server.acknowledgeTournamentAbortBoundary(operation, tournament)
    ).rejects.toThrow('retirement_unconfirmed');
    expect(f.server.tournamentEngines.get(tournament)).toBe(f.manager);
    expect(await f.server.acknowledgeTournamentAbortBoundary(operation, tournament)).toMatchObject({
      runtime_retired: true,
    });
    expect(f.manager.releaseTournamentAbortBoundary).toHaveBeenNthCalledWith(1, operation);
    expect(f.manager.releaseTournamentAbortBoundary).toHaveBeenNthCalledWith(2, operation);
  });
  it('rejects a different current generation even with a fully settled old receipt', async () => {
    const f = server({
      state: 'settled',
      current_generation: 'different-generation',
      tournament_status: 'CANCELLED',
      receipt: {
        fully_settled: true,
        operation_id: operation,
        tournament_id: tournament,
        quiescence: { generation },
      },
    });
    await expect(
      f.server.acknowledgeTournamentAbortBoundary(operation, tournament)
    ).rejects.toThrow('generation_unproven');
    expect(f.server.stopTournamentManagerIfOwned).not.toHaveBeenCalled();
  });
  it('never releases another pending generation after the original manager slot is gone', async () => {
    const f = server({
      state: 'settled',
      current_generation: null,
      tournament_status: 'CANCELLED',
      receipt: {
        fully_settled: true,
        operation_id: operation,
        tournament_id: tournament,
        quiescence: { generation },
      },
    });
    f.server.tournamentEngines.clear();
    f.server.tournamentManagerPendingLeaseReleases.set(tournament, 'foreign-generation');
    io.rpc.mockClear();
    await expect(
      f.server.acknowledgeTournamentAbortBoundary(operation, tournament)
    ).rejects.toThrow('release_generation_mismatch');
    expect(io.rpc.mock.calls.map(([name]) => name)).toEqual(['fn_ca_tournament_abort_stop_state']);
  });
});
