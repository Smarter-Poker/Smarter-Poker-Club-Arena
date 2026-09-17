import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { GameServer } = await import('../GameServer.js');
const { supabase } = await import('../services/supabase.js');
const { reportError } = await import('../services/errorReporter.js');

describe('committed final-table presentation is failure-contained', () => {
  it.each([
    ['normal', 'committedFinishReceipt', 'cleanupCommittedTournament'],
    ['satellite', 'committedSatelliteReceipt', 'cleanupCommittedSatellite'],
    ['deal', 'committedFinalTableDealReceipt', 'settleFinalTableDeal'],
  ] as const)(
    'causally retries a retained %s receipt after cleanup refuses',
    async (_kind, field, method) => {
      const manager = Object.create(TournamentManagerEliminations.prototype) as any;
      const receipt = { receipt: field };
      manager.running = true;
      manager.committedFinalTableDealCleanupPending = field === 'committedFinalTableDealReceipt';
      manager.committedFinishReceipt = null;
      manager.committedSatelliteReceipt = null;
      manager.committedFinalTableDealReceipt = null;
      manager[field] = receipt;
      manager[method] = vi.fn().mockResolvedValue(false);
      manager.requestUrgentEliminationSweepAfter = vi.fn();

      await expect(manager.resumeCommittedTerminalCleanup()).resolves.toBe(true);

      expect(manager[method]).toHaveBeenCalledOnce();
      expect(manager[method]).toHaveBeenCalledWith(receipt);
      expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledOnce();
    }
  );

  it('does not schedule another cleanup after the retained receipt tail succeeds', async () => {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    const receipt = { receipt: 'normal' };
    manager.running = true;
    manager.committedFinalTableDealCleanupPending = false;
    manager.committedFinalTableDealReceipt = null;
    manager.committedFinishReceipt = receipt;
    manager.committedSatelliteReceipt = null;
    manager.cleanupCommittedTournament = vi.fn().mockResolvedValue(true);
    manager.requestUrgentEliminationSweepAfter = vi.fn();

    await expect(manager.resumeCommittedTerminalCleanup()).resolves.toBe(true);

    expect(manager.cleanupCommittedTournament).toHaveBeenCalledWith(receipt);
    expect(manager.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
  });

  it('still stops the exact engine and manager when presentation rejects', async () => {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    const stopEngine = vi.fn().mockResolvedValue(undefined);
    manager.tournamentId = '00000000-0000-4000-8000-000000000001';
    manager.tableEngines = new Map([
      ['00000000-0000-4000-8000-000000000002', { stop: stopEngine }],
    ]);
    manager.gameServer = {
      unregisterTableEngine: vi.fn().mockReturnValue(true),
      stopClosedTournamentTableEngine: vi.fn(),
    };
    manager.broadcast = vi.fn().mockRejectedValue(new Error('channel unavailable'));
    manager.cleanupBroadcastChannel = vi.fn().mockResolvedValue(undefined);
    manager.stop = vi.fn().mockResolvedValue(undefined);

    await expect(
      manager.settleFinalTableDeal({
        winnerId: '00000000-0000-4000-8000-000000000003',
        dealShares: [
          {
            userId: '00000000-0000-4000-8000-000000000003',
            place: 1,
            amount: 100,
          },
        ],
        tableClosure: {
          closedTableIds: ['00000000-0000-4000-8000-000000000002'],
        },
      })
    ).resolves.toBe(true);

    expect(stopEngine).toHaveBeenCalledOnce();
    expect(manager.cleanupBroadcastChannel).toHaveBeenCalledOnce();
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it('retires an exact committed-table engine after stop reports cleanup failure', async () => {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    const tableId = '00000000-0000-4000-8000-000000000002';
    const failure = new Error('snapshot flush failed');
    const managerEngine = {
      stop: vi.fn().mockRejectedValue(failure),
      hasReleasedProcessOwnership: vi.fn().mockReturnValue(true),
    };
    const unregisterTableEngine = vi.fn().mockReturnValue(true);
    const stopClosedTournamentTableEngine = vi.fn();
    manager.tournamentId = '00000000-0000-4000-8000-000000000001';
    manager.tableEngines = new Map([[tableId, managerEngine]]);
    manager.gameServer = { unregisterTableEngine, stopClosedTournamentTableEngine };
    manager.cleanupBroadcastChannel = vi.fn().mockResolvedValue(undefined);
    manager.stop = vi.fn().mockResolvedValue(undefined);

    await expect(manager.cleanupCommittedTablesAndManager([tableId])).resolves.toBe(true);

    expect(managerEngine.hasReleasedProcessOwnership).toHaveBeenCalledOnce();
    expect(unregisterTableEngine).toHaveBeenCalledOnce();
    expect(unregisterTableEngine).toHaveBeenCalledWith(tableId, managerEngine);
    expect(stopClosedTournamentTableEngine).not.toHaveBeenCalled();
    expect(manager.tableEngines.size).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      'Tournament.committed_cleanup_engine_stop_cleanup_failed',
      { tableId }
    );
  });

  it('retires a replacement terminal engine only after released ownership is proven', async () => {
    const tableId = '00000000-0000-4000-8000-000000000004';
    const tournamentId = '00000000-0000-4000-8000-000000000001';
    const failure = new Error('snapshot flush failed');
    const current = {
      stop: vi.fn().mockRejectedValue(failure),
      hasReleasedProcessOwnership: vi.fn().mockReturnValue(true),
    };
    const unregisterTableEngine = vi.fn().mockReturnValue(true);
    const terminalRead = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { status: 'closed', tournament_id: tournamentId },
        error: null,
      }),
    };
    const from = vi.spyOn(supabase, 'from').mockReturnValue(terminalRead as any);
    const gameServer = {
      tableEngines: new Map([[tableId, current]]),
      unregisterTableEngine,
    };

    try {
      await expect(
        GameServer.prototype.stopClosedTournamentTableEngine.call(gameServer, tableId)
      ).resolves.toBe(true);
    } finally {
      from.mockRestore();
    }

    expect(current.hasReleasedProcessOwnership).toHaveBeenCalledOnce();
    expect(unregisterTableEngine).toHaveBeenCalledOnce();
    expect(unregisterTableEngine).toHaveBeenCalledWith(tableId, current);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      'GameServer.terminal_table_engine_stop_cleanup_failed',
      { tableId }
    );
  });

  it('awaits every engine teardown when an unknown money result fails closed', async () => {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    let releaseSlowStop!: () => void;
    const slowStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSlowStop = resolve;
        })
    );
    const rejectedStop = vi.fn().mockRejectedValue(new Error('snapshot flush failed'));
    manager.tournamentId = '00000000-0000-4000-8000-000000000001';
    // This partial-recovery fixture bypasses constructor field initializers.
    manager.stoppedDiagnosticOriginals = new Map();
    manager.running = true;
    manager.blindTimer = null;
    manager.eliminationTimer = null;
    manager.tableLivenessInterval = null;
    manager.handForHandSyncInterval = null;
    manager.handForHandRePauseTimer = null;
    manager.broadcastChannel = null;
    manager.broadcastReady = false;
    manager.tableEngines = new Map([
      ['00000000-0000-4000-8000-000000000002', { stop: rejectedStop }],
      ['00000000-0000-4000-8000-000000000003', { stop: slowStop }],
    ]);

    const stopped = manager.stopAndWait();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.running).toBe(false);
    expect(manager.tableEngines.size).toBe(2);
    expect(rejectedStop).toHaveBeenCalledOnce();
    expect(slowStop).toHaveBeenCalledOnce();

    releaseSlowStop();
    await expect(stopped).resolves.toBeUndefined();
    expect(manager.tableEngines.size).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.manager_engine_stop_failed'
    );
  });
});
