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
    server.stopTournamentManagerIfOwned = vi.fn(async () => true);
    io.rpc.mockResolvedValueOnce({
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
      receipt: { fully_settled: true },
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
});
