import { emptyManagerWakeInbox } from './__fixtures__/emptyManagerWakeInbox.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: fixture.from, rpc: fixture.rpc },
  maintenanceSupabase: { from: fixture.from, rpc: fixture.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { TournamentSweepWorkCursor } = await import('./TournamentSweepWorkCursor.js');

const USER = 'aaaaaaaa-0000-4000-8000-000000000002';
const EVENT = 'aaaaaaaa-0000-4000-8000-000000000001';

function setup(mode: 'rebought' | 'concurrent-rebuy' | 'unreadable', users = [USER]) {
  fixture.from.mockImplementation((table: string) => {
    if (table === 'tournament_manager_wakes') return emptyManagerWakeInbox();
    let head = false;
    let columns = '';
    const query: any = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = options?.head === true;
        columns = _columns;
        return query;
      },
      eq: () => query,
      lte: () => query,
      in: () => query,
      order: () => query,
      not: () => query,
      is: () => query,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          table === 'tournament_knockout_candidates'
            ? {
                data: users.map((userId) => ({
                  id: userId,
                  eliminated_user_id: userId,
                  hand_number: 123,
                  stack_before: 1000,
                  state: 'pending',
                  created_at: new Date(1000).toISOString(),
                })),
                count: users.length,
                error: null,
              }
            : head
              ? { count: users.length + 4, data: null, error: null }
              : {
                  data:
                    columns === 'position' ? [] : users.map((user_id) => ({ user_id, chips: 0 })),
                  error: null,
                }
        ).then(resolve),
    };
    return query;
  });
  fixture.rpc.mockResolvedValue(
    mode === 'unreadable'
      ? { data: null, error: { message: 'rebuy decision read unavailable' } }
      : // An omitted row is the authoritative contract for a player who rebought
        // concurrently after the initial playing-zero snapshot was captured.
        { data: [], error: null }
  );
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    recoveredOriginalAdmissions: new Map(),
    tournamentId: EVENT,
    running: true,
    pendingManagerWakes: new Map(),
    pendingManagerWakeGenerations: new Map(),
    eliminationSweepCursor: new TournamentSweepWorkCursor(),
    bustRefusalStreak: new Map(),
    bustAwaitingSinceMs: 1000,
    tournamentCache: { is_rebuy: true, is_reentry: true },
    resumeCommittedTerminalCleanup: vi.fn().mockResolvedValue(false),
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    tryTournamentRebuys: vi.fn().mockResolvedValue({
      rebought: new Set(mode === 'rebought' ? users.slice(0, 20) : []),
      deferredUntil: new Map(),
      answered: new Set(),
    }),
    checkDynamicTableExpansion: vi.fn().mockResolvedValue(true),
    tableEngines: new Map(),
    tournamentLeaseAuthorityIsCurrent: () => true,
    gameServer: { handTournamentToSuccessorGeneration: vi.fn() },
    // A pass whose busts all rebought or are still deciding goes on to its
    // later stages (aRebuyWindowDoesNotStarveTheBalancer). They are isolated
    // here; this file measures the bust clock, and the pass yields after the
    // balance stage on top of the real work budget.
    checkSatelliteQualifierCompletion: vi.fn(async () => 'continue'),
    checkFinalTableDeal: vi.fn(async () => true),
    checkTableBalance: vi.fn(async () => undefined),
    eliminationWorkBudgetExpired(this: any) {
      return (
        this.eliminationSweepCursor.nextStage >= 6 ||
        (TournamentManagerEliminations.prototype as any).eliminationWorkBudgetExpired.call(this)
      );
    },
  }) as any;
  manager.eliminationSweepCursor.advanceTo(1);
  return manager;
}

/** A real bust assignment and cursor yield; only the authoritative door is isolated. */
function assignmentManager(accepted: boolean) {
  const manager = setup('concurrent-rebuy');
  fixture.rpc.mockResolvedValue({ data: [{ user_id: USER, decision_open: false }], error: null });
  Object.assign(manager, {
    // The door's durable success/refusal is the input. Spend the work budget
    // after it answers so actual completedStage(2) retains a continuation.
    eliminatePlayer: vi.fn(async () => {
      vi.setSystemTime(Date.now() + 5001);
      return accepted;
    }),
    checkSatelliteQualifierCompletion: vi.fn(async () => {
      vi.setSystemTime(Date.now() + 5001);
      return 'continue';
    }),
  });
  return manager;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(130000);
});
afterEach(() => vi.useRealTimers());

describe('resolved rebuys do not manufacture a stalled tournament manager', () => {
  it.each(['rebought', 'concurrent-rebuy'] as const)(
    'clears the old bust clock after %s',
    async (mode) => {
      const manager = setup(mode);
      await manager.runEliminationSweep(new AbortController().signal);
      expect(manager.tryTournamentRebuys).toHaveBeenCalledOnce();
      expect(fixture.reportError).not.toHaveBeenCalled();
      expect(manager.isProcessingEliminations).toBe(false);
      expect(manager.getStalledEliminationSweep(130000)).toBeNull();
      expect(manager.requestSuccessorForStalledEliminationSweep()).toBe(false);
      expect(manager.gameServer.handTournamentToSuccessorGeneration).not.toHaveBeenCalled();
    }
  );

  it('retains an unresolved bust when its authoritative decision read fails', async () => {
    const manager = setup('unreadable');
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.getStalledEliminationSweep(130000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 129000,
    });
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'rebuy decision read unavailable' }),
      'Tournament.rebuy_decisions_unavailable'
    );
    expect(manager.requestSuccessorForStalledEliminationSweep()).toBe(true);
    expect(manager.gameServer.handTournamentToSuccessorGeneration).toHaveBeenCalledOnce();
  });

  it('starts a fresh pending clock for an authoritative future open decision', async () => {
    const manager = setup('concurrent-rebuy');
    fixture.rpc.mockResolvedValue({
      data: [
        { user_id: USER, decision_open: true, rebuy_prompt_until: new Date(160000).toISOString() },
      ],
      error: null,
    });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(fixture.reportError).not.toHaveBeenCalled();
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
    expect(manager.getStalledEliminationSweep(130000)).toBeNull();
    expect(manager.getStalledEliminationSweep(249999)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 119999,
    });
    expect(manager.getStalledEliminationSweep(250000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 120000,
    });
  });

  it.each([undefined, 'not-a-date', new Date(129999).toISOString()])(
    'retains the original clock when an open decision has no proven future deadline (%s)',
    async (deadline) => {
      const manager = setup('concurrent-rebuy');
      fixture.rpc.mockResolvedValue({
        data: [{ user_id: USER, decision_open: true, rebuy_prompt_until: deadline }],
        error: null,
      });
      await manager.runEliminationSweep(new AbortController().signal);
      expect(manager.getStalledEliminationSweep(130000)).toMatchObject({
        msInFlight: 0,
        msBustWaiting: 129000,
      });
    }
  );

  it('keeps a fresh pending clock when only the first twenty of twenty-one busts rebought', async () => {
    const users = Array.from(
      { length: 21 },
      (_, index) => `aaaaaaaa-0000-4000-8000-${String(index + 2).padStart(12, '0')}`
    );
    const manager = setup('rebought', users);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.tryTournamentRebuys).toHaveBeenCalledOnce();
    expect(manager.tryTournamentRebuys.mock.calls[0][0]).toEqual(users.slice(0, 20));
    expect(fixture.reportError).not.toHaveBeenCalled();
    expect(manager.bustAwaitingSinceMs).toBe(130000);
    expect(manager.getStalledEliminationSweep(249999)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 119999,
    });
    expect(manager.getStalledEliminationSweep(250000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 120000,
    });
  });

  it('retires a fully committed bust before later cursor stages can age it into a stall', async () => {
    const manager = assignmentManager(true);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminatePlayer).toHaveBeenCalledWith(USER, 5);
    expect(manager.eliminationSweepNextStage).toBe(2);
    // A later admission consumes its real continuation, without another bust
    // read. Successful assignment must already have retired that obligation.
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.checkSatelliteQualifierCompletion).toHaveBeenCalledOnce();
    expect(manager.eliminationSweepNextStage).toBe(3);
    expect(manager.isProcessingEliminations).toBe(false);
    expect(fixture.reportError).not.toHaveBeenCalled();
    expect(manager.getStalledEliminationSweep(Date.now() + 120000)).toBeNull();
  });

  it('keeps a refused assignment pending across later cursor stages', async () => {
    const manager = assignmentManager(false);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminatePlayer).toHaveBeenCalledWith(USER, 5);
    expect(manager.eliminationSweepNextStage).toBe(2);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminationSweepNextStage).toBe(3);
    expect(manager.getStalledEliminationSweep(Date.now() + 120000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 125001,
    });
  });

  it('retains a new hand-complete bust that arrives while the captured assignment is awaited', async () => {
    const manager = assignmentManager(true);
    let handComplete: ((tableId: string, stacks: Array<{ stack: number }>) => void) | undefined;
    const engine = {
      onHandComplete: (callback: typeof handComplete) => {
        handComplete = callback;
      },
      onPauseReady: vi.fn(),
      onRestartRequired: vi.fn(),
    };
    Object.assign(manager, {
      isCohortSatellite: () => false,
      mysteryActivationMayOpenOnBust: () => false,
      declareFieldDecidedIfOneStackRemains: vi.fn(),
      horseRebuyOfferMayHaveOpened: vi.fn(),
    });
    manager.wireEliminationWake(engine);
    manager.eliminatePlayer.mockImplementationOnce(async () => {
      await Promise.resolve();
      vi.setSystemTime(Date.now() + 5001);
      handComplete!('another-table', [{ stack: 0 }, { stack: 2000 }]);
      return true;
    });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminatePlayer).toHaveBeenCalledOnce();
    expect(manager.requestEliminationSweep).toHaveBeenCalled();
    expect(manager.bustAwaitingSinceMs).toBeGreaterThan(0);
    expect(manager.getStalledEliminationSweep(Date.now() + 120000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 120000,
    });
  });

  it('keeps the first of two new hand-complete bust times during an awaited receipt', async () => {
    const manager = assignmentManager(true);
    let handComplete: ((tableId: string, stacks: Array<{ stack: number }>) => void) | undefined;
    const engine = {
      onHandComplete: (callback: typeof handComplete) => {
        handComplete = callback;
      },
      onPauseReady: vi.fn(),
      onRestartRequired: vi.fn(),
    };
    Object.assign(manager, {
      isCohortSatellite: () => false,
      mysteryActivationMayOpenOnBust: () => false,
      declareFieldDecidedIfOneStackRemains: vi.fn(),
      horseRebuyOfferMayHaveOpened: vi.fn(),
    });
    manager.wireEliminationWake(engine);
    manager.eliminatePlayer.mockImplementationOnce(async () => {
      await Promise.resolve();
      vi.setSystemTime(135001);
      handComplete!('first-table', [{ stack: 0 }, { stack: 2000 }]);
      vi.setSystemTime(136001);
      handComplete!('second-table', [{ stack: 0 }, { stack: 3000 }]);
      return true;
    });
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.bustAwaitingSinceMs).toBe(135001);
    expect(manager.getStalledEliminationSweep(255001)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 120000,
    });
    expect(manager.bustObservationInFlight).toBeNull();
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it('retains the old clock when a successful bust query has no authoritative rows', async () => {
    const manager = assignmentManager(true);
    const query: any = {
      select: () => query,
      eq: () => query,
      lte: () => Promise.resolve({ data: null, error: null }),
    };
    fixture.from.mockReturnValueOnce(emptyManagerWakeInbox()).mockReturnValueOnce(query);
    await manager.runEliminationSweep(new AbortController().signal);
    expect(manager.eliminatePlayer).not.toHaveBeenCalled();
    expect(manager.getStalledEliminationSweep(130000)).toMatchObject({
      msInFlight: 0,
      msBustWaiting: 129000,
    });
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('authoritative rows missing') }),
      'Tournament.busted_list_unavailable'
    );
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(5000);
    expect(manager.bustObservationInFlight).toBeNull();
  });
});
