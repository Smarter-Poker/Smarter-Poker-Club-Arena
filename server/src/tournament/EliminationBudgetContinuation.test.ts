import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => vi.useRealTimers());

describe('an interrupted elimination stage retains its continuation', () => {
  it('does not mark table balancing complete when its helper yields within the stage', async () => {
    vi.useFakeTimers();
    const manager = Object.create(TournamentManagerEliminations.prototype) as any;
    Object.assign(manager, {
      tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
      running: true,
      pendingManagerWakes: new Map(),
      pendingManagerWakeGenerations: new Map(),
      eliminationSweepCursor: new TournamentSweepWorkCursor(),
      resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
      requestEliminationSweep: vi.fn(),
      tableEngines: new Map(),
      checkTableBalance: vi.fn(async () => {
        vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
      }),
      checkDynamicTableExpansion: vi.fn().mockResolvedValue(true),
    });
    manager.eliminationSweepCursor.advanceTo(5);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminationSweepCursor.nextStage).toBe(5);
    expect(manager.requestEliminationSweep).toHaveBeenCalledOnce();
    expect(manager.checkDynamicTableExpansion).not.toHaveBeenCalled();
    manager.checkTableBalance.mockResolvedValue(undefined);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(2);
    expect(manager.eliminationSweepCursor.nextStage).toBe(0);
  });

  it.each(['budget', 'stopped', 'aborted'])(
    'retains unfinished expansion after %s only while the same manager is authoritative',
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const manager = Object.create(TournamentManagerEliminations.prototype) as any;
      Object.assign(manager, {
        tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
        running: true,
        pendingManagerWakes: new Map(),
        pendingManagerWakeGenerations: new Map(),
        eliminationSweepCursor: new TournamentSweepWorkCursor(),
        resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
        requestEliminationSweep: vi.fn(),
        tableEngines: new Map(),
        checkDynamicTableExpansion: vi.fn(async () => {
          vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS + 1);
          if (reason === 'stopped') manager.running = false;
          if (reason === 'aborted') controller.abort();
          return false;
        }),
      });
      manager.eliminationSweepCursor.advanceTo(6);
      await manager.runEliminationSweep(controller.signal);
      expect(manager.requestEliminationSweep).toHaveBeenCalledTimes(reason === 'budget' ? 1 : 0);
      expect(manager.eliminationSweepCursor.nextStage).toBe(6);
      expect(manager.isProcessingEliminations).toBe(false);
      expect(manager.eliminationSweepSignal).toBeNull();
      expect(manager.eliminationSweepDeadlineAt).toBe(0);
      if (reason === 'budget') {
        manager.checkDynamicTableExpansion.mockResolvedValue(true);
        await manager.runEliminationSweep(controller.signal);
        expect(manager.eliminationSweepCursor.nextStage).toBe(0);
        expect(manager.requestEliminationSweep).toHaveBeenCalledOnce();
      }
    }
  );
});
