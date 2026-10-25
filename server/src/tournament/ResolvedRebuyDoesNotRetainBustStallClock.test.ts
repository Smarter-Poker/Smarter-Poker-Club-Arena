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
    let head = false;
    const query: any = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = options?.head === true;
        return query;
      },
      eq: () => query,
      lte: () => query,
      in: () => query,
      order: () => query,
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
              : { data: users.map((user_id) => ({ user_id, chips: 0 })), error: null }
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
    tableEngines: new Map(),
    tournamentLeaseAuthorityIsCurrent: () => true,
    gameServer: { handTournamentToSuccessorGeneration: vi.fn() },
  }) as any;
  manager.eliminationSweepCursor.advanceTo(1);
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
});
