import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { reportError } = await import('../services/errorReporter.js');

describe('committed final-table presentation is failure-contained', () => {
  it('still stops the engine and manager when broadcasts and cleanup reject', async () => {
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    const stopEngine = vi.fn().mockResolvedValue(undefined);
    manager.tournamentId = '00000000-0000-4000-8000-000000000001';
    manager.tableEngines = new Map([
      ['00000000-0000-4000-8000-000000000002', { stop: stopEngine }],
    ]);
    manager.broadcast = vi.fn().mockRejectedValue(new Error('channel unavailable'));
    manager.cleanupBroadcastChannel = vi.fn().mockRejectedValue(new Error('cleanup unavailable'));
    manager.stop = vi.fn();

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
      })
    ).resolves.toBeUndefined();

    expect(stopEngine).toHaveBeenCalledOnce();
    expect(manager.cleanupBroadcastChannel).toHaveBeenCalledOnce();
    expect(manager.stop).toHaveBeenCalledOnce();
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
