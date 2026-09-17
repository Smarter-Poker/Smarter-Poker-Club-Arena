import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerEliminations } from './TournamentManagerEliminations.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { TournamentSweepWorkCursor } from './TournamentSweepWorkCursor.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { supabase } from '../services/supabase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMaintenanceFrozen(false);
});

function balanceStageManager() {
  const manager = Object.create(TournamentManagerEliminations.prototype) as any;
  Object.assign(manager, {
    tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
    running: true,
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    tableEngines: new Map(),
    checkTableBalance: vi.fn().mockResolvedValue(undefined),
    checkDynamicTableExpansion: vi.fn().mockResolvedValue(true),
  });
  manager.eliminationSweepCursor.advanceTo(5);
  return manager;
}

describe('an interrupted elimination stage retains its continuation', () => {
  it('does not start balancing or expansion when the admitted stage is already frozen', async () => {
    setMaintenanceFrozen(true);
    const manager = balanceStageManager();
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkTableBalance).not.toHaveBeenCalled();
    expect(manager.checkDynamicTableExpansion).not.toHaveBeenCalled();
    expect(manager.eliminationSweepCursor.nextStage).toBe(0);
  });

  it('continues committed retirement, then leaves blocked balance so a new bust is reachable', async () => {
    const manager = balanceStageManager();
    manager.checkTableBalance
      .mockResolvedValueOnce({ kind: 'table-retired', tableId: 'retired-one' })
      .mockResolvedValueOnce(undefined);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(2);
    expect(manager.checkDynamicTableExpansion).toHaveBeenCalledOnce();
    expect(manager.eliminationSweepCursor.nextStage).toBe(0);

    // No successful retirement on the second read: do not pin cursor 5 while
    // waiting for roster chairs which only the earlier bust stage can release.
    Object.assign(manager, {
      refreshChipCapInputs: vi.fn().mockResolvedValue(undefined),
      recoverPendingBountyObligations: vi.fn().mockResolvedValue(true),
      checkFinalTableDeal: vi.fn().mockResolvedValue(true),
    });
    const bustRead = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'bust-stage reached' } });
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), lte: bustRead };
    const read = vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(read).toHaveBeenCalledWith('tournament_players');
    expect(query.eq).toHaveBeenCalledWith('status', 'playing');
    expect(bustRead).toHaveBeenCalledWith('chips', 0);
    expect(manager.eliminationSweepCursor.nextStage).toBe(1);
    expect(manager.checkTableBalance).toHaveBeenCalledTimes(2);
  });

  it.each(['budget', 'stopped', 'aborted', 'frozen'])(
    'does not continue a committed retirement after the %s boundary',
    async (reason) => {
      vi.useFakeTimers();
      const manager = balanceStageManager();
      const controller = new AbortController();
      manager.checkTableBalance.mockImplementationOnce(async () => {
        if (reason === 'budget')
          vi.setSystemTime(Date.now() + TournamentManagerBase.SWEEP_WORK_BUDGET_MS);
        if (reason === 'stopped') manager.running = false;
        if (reason === 'aborted') controller.abort();
        if (reason === 'frozen') setMaintenanceFrozen(true);
        return { kind: 'table-retired', tableId: 'retired-one' };
      });
      await manager.runEliminationSweep(controller.signal);
      expect(manager.checkTableBalance).toHaveBeenCalledOnce();
      expect(manager.checkDynamicTableExpansion).not.toHaveBeenCalled();
      expect(manager.eliminationSweepCursor.nextStage).toBe(reason === 'frozen' ? 0 : 5);
      expect(manager.requestEliminationSweep).toHaveBeenCalledTimes(reason === 'budget' ? 1 : 0);
    }
  );

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
