import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let tableStateHub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub } = await import('../transport/TableStateHub.js'));
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:10:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function manager(row: Record<string, any>, tableIds: string[]) {
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'level-restart',
    tournamentCache: structuredClone(row),
    running: true,
    currentLevel: row.current_level,
    onBreak: false,
    addOnBreakActive: false,
    blindTimer: null,
    blindTimerStartedAt: Date.parse(row.level_started_at),
    tableEngines: new Map(tableIds.map((id) => [id, {}])),
    lifecycleEpoch: { current: () => 1, isCurrent: () => state.running },
    lifecycleIsCurrent: () => state.running,
    assertLifecycleCurrent: () => {
      if (!state.running) throw new Error('stale manager');
    },
    createManagedTableEngine: () => ({ setHub: vi.fn() }),
    wireEliminationWake: vi.fn(),
    admitManagedTableEngine: vi.fn(),
    startManagedTableEngine: vi.fn(),
    restoreDrawnFirstButtons: vi.fn().mockResolvedValue(undefined),
    drainTableEngineStartJobs: vi.fn().mockResolvedValue(undefined),
    startEliminationChecker: vi.fn(),
    unregisterEliminationScheduler: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn().mockResolvedValue(undefined),
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn().mockResolvedValue(undefined),
    trackLifecycleJob: (promise: Promise<unknown>) => promise,
    setLifecycleTimeout: (callback: () => unknown, delay: number) => ({ callback, delay }),
    clearLifecycleTimeout: vi.fn(),
  });
  return state;
}

describe('durable blind-level transition', () => {
  it('keeps a failed transition due through a break without consuming the break as play', async () => {
    const structure = [
      { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
      { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
    ];
    const row = {
      current_level: 0,
      level_started_at: '2026-09-10T12:00:00.000Z',
      blind_structure: structure,
      prize_pool_finalized: true,
    };
    const state = manager(row, ['table-one']);
    let fail = true;
    vi.spyOn(supabase, 'from').mockImplementation(
      (relation: string) =>
        ({
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              if (relation === 'tournaments') {
                Object.assign(row, patch); // The write committed; only its reply was lost.
                if (fail) return { error: { message: 'reply lost' } };
              }
              return { error: null };
            },
          }),
        }) as never
    );
    await state.advanceBlindLevel(structure);
    vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
    state.onBreak = true;
    state.suspendLevelClock();
    expect(state.blindTimer).toBeNull();
    expect(state.savedBlindTimerRemaining).toBe(1000);
    await state.advanceBlindLevel(structure);
    expect(state.blindTimer).toBeNull();
    vi.setSystemTime(new Date('2026-09-10T12:15:02.000Z'));
    fail = false;
    state.onBreak = false;
    state.startBlindTimer(structure, state.savedBlindTimerRemaining);
    expect(state.blindTimer.delay).toBe(1000);
    await state.blindTimer.callback();
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(598000);
    expect(row.level_started_at).toBe('2026-09-10T12:15:00.000Z');
  });

  it('retains the next-level clock when notification throws after durable publication', async () => {
    const structure = [
      { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
      { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
    ];
    const row = {
      current_level: 0,
      level_started_at: '2026-09-10T12:00:00.000Z',
      blind_structure: structure,
      prize_pool_finalized: true,
    };
    const state = manager(row, ['table-one']);
    vi.spyOn(supabase, 'from').mockReturnValue({
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          Object.assign(row, patch);
          return { error: null };
        },
      }),
    } as never);
    state.broadcast.mockRejectedValueOnce(new Error('notification unavailable'));
    await state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(600000);
    expect(state.pendingBlindTransition).toBeNull();
    expect(state.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(1000);
  });

  it('does not retry or publish a write that returns to a fenced manager', async () => {
    const structure = [
      { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
      { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
    ];
    const row = {
      current_level: 0,
      level_started_at: '2026-09-10T12:00:00.000Z',
      blind_structure: structure,
      prize_pool_finalized: true,
    };
    const state = manager(row, ['table-one']);
    vi.spyOn(supabase, 'from').mockReturnValue({
      update: () => ({
        eq: async () => {
          state.running = false;
          return { error: { message: 'stale owner' } };
        },
      }),
    } as never);
    await state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(0);
    expect(state.blindTimer).toBeNull();
    expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
    expect(state.broadcast).not.toHaveBeenCalled();
  });

  it.each(['table', 'level', 'lost-acknowledgment'])(
    'retries the same level without announcing success after a %s failure',
    async (failure) => {
      const structure = [
        { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
        { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
        { smallBlind: 100, bigBlind: 200, durationMinutes: 10 },
      ];
      const row: Record<string, any> = {
        current_level: 0,
        level_started_at: '2026-09-10T12:00:00.000Z',
        blind_structure: structure,
        prize_pool_finalized: true,
      };
      const state = manager(row, ['table-one', 'table-two']);
      let fail = true;
      const levelWrites: Record<string, unknown>[] = [];
      vi.spyOn(supabase, 'from').mockImplementation(
        (relation: string) =>
          ({
            update: (patch: Record<string, unknown>) => ({
              eq: async (_column: string, id: string) => {
                if (relation === 'tables') {
                  if (fail && failure === 'table' && id === 'table-two') {
                    return { error: { message: 'table unavailable' } };
                  }
                } else if (relation === 'tournaments') {
                  if ('current_level' in patch) {
                    levelWrites.push(patch);
                    if (fail && failure !== 'table') {
                      if (failure === 'lost-acknowledgment') Object.assign(row, patch);
                      return { error: { message: 'level acknowledgment unavailable' } };
                    }
                  }
                  Object.assign(row, patch);
                }
                return { error: null };
              },
            }),
          }) as never
      );
      await state.advanceBlindLevel(structure);
      expect(state.currentLevel).toBe(0);
      expect(row.current_level).toBe(failure === 'lost-acknowledgment' ? 1 : 0);
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
      expect(state.broadcast).not.toHaveBeenCalled();
      expect(state.blindTimer?.delay).toBe(1000);
      fail = false;
      vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      await state.blindTimer.callback();
      expect(state.currentLevel).toBe(1);
      expect(row.current_level).toBe(1);
      expect(levelWrites.every((patch) => patch.current_level === 1)).toBe(true);
      if (failure !== 'table') {
        expect(levelWrites[1].level_started_at).toBe(levelWrites[0].level_started_at);
        expect(state.blindTimer.delay).toBe(598_000);
      }
      expect(state.broadcast).toHaveBeenCalledTimes(1);
      expect(tableStateHub.emitEvent).toHaveBeenCalledTimes(2);
    }
  );

  it('admits only one transition while a write is pending', async () => {
    const structure = [
      { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
      { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
    ];
    const row = {
      current_level: 0,
      level_started_at: '2026-09-10T12:00:00.000Z',
      blind_structure: structure,
      prize_pool_finalized: true,
    };
    const state = manager(row, ['table-one']);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = vi.fn((patch: Record<string, unknown>) => ({
      eq: async () => {
        await pending;
        if ('current_level' in patch) Object.assign(row, patch);
        return { error: null };
      },
    }));
    vi.spyOn(supabase, 'from').mockReturnValue({ update } as never);
    const first = state.advanceBlindLevel(structure);
    const second = state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(0);
    expect(update).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(state.currentLevel).toBe(1);
    expect(state.broadcast).toHaveBeenCalledOnce();
  });

  it.each(['stopped', 'continued'])(
    'keeps one level deadline after publication with the manager %s',
    async (mode) => {
      const structure = [
        { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
        { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
      ];
      const row: Record<string, any> = {
        current_level: 0,
        level_started_at: '2026-09-10T12:00:00.000Z',
        blind_structure: structure,
        on_break: false,
        prize_pool_finalized: true,
      };
      const tableIds = ['table-one', 'table-two'];
      const tables = new Map(
        tableIds.map((id) => [id, { small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }])
      );
      const old = manager(row, tableIds);
      old.broadcast.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      });
      vi.spyOn(supabase, 'from').mockImplementation(
        (relation: string) =>
          ({
            update: (patch: Record<string, unknown>) => ({
              eq: async (_column: string, id: string) => {
                if (relation === 'tournaments') {
                  Object.assign(row, patch);
                  if ('current_level' in patch && mode === 'stopped') old.running = false;
                } else if (relation === 'tables') {
                  Object.assign(tables.get(id)!, patch);
                } else throw new Error('unexpected write: ' + relation);
                return { error: null };
              },
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: structuredClone(row), error: null }),
                in: async () => ({ data: tableIds.map((id) => ({ id })), error: null }),
              }),
            }),
          }) as never
      );
      await old.advanceBlindLevel(structure);
      if (mode === 'stopped') expect(old.blindTimer).toBeNull();
      expect(row.current_level).toBe(1);
      for (const table of tables.values()) {
        expect(table).toEqual({ small_blind: 50, big_blind: 100, ante: 0, stakes: '50/100' });
      }

      vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      const replacement = mode === 'stopped' ? manager(row, []) : old;
      if (mode === 'stopped') await replacement.resumeLifecycle(1);
      expect(replacement.running).toBe(true);
      expect(replacement.currentLevel).toBe(1);
      expect([...replacement.tableEngines.keys()]).toEqual(tableIds);
      expect(replacement.resolveBlindLevel(row.blind_structure, replacement.currentLevel)).toEqual(
        structure[1]
      );
      expect(replacement.blindTimer?.delay).toBe(598_000);
      expect(row.level_started_at).toBe('2026-09-10T12:10:00.000Z');
    }
  );
});

describe('blind rows at manager recovery', () => {
  it.each(['repaired', 'unavailable'])(
    'reconciles persisted blinds before any dealer admission when the table write is %s',
    async (mode) => {
      const structure = [
        { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
        { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
      ];
      const row: Record<string, any> = {
        current_level: 0,
        level_started_at: '2026-09-10T12:00:00.000Z',
        blind_structure: structure,
        on_break: false,
        prize_pool_finalized: true,
      };
      const tableIds = ['table-one', 'table-two'];
      const tables = new Map(
        tableIds.map((id) => [id, { small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }])
      );
      const expected = { small_blind: 50, big_blind: 100, ante: 0, stakes: '50/100' };
      const old = manager(row, tableIds);
      let recovering = false;
      const recoveryWrites: string[] = [];
      vi.spyOn(supabase, 'from').mockImplementation(
        (relation: string) =>
          ({
            update: (patch: Record<string, unknown>) => ({
              eq: async (_column: string, id: string) => {
                if (relation === 'tournaments') Object.assign(row, patch);
                else if (relation === 'tables') {
                  if (recovering) recoveryWrites.push(id);
                  if (id === 'table-two' && (!recovering || mode === 'unavailable')) {
                    return { error: { message: 'table blind write unavailable' } };
                  }
                  Object.assign(tables.get(id)!, patch);
                } else throw new Error('unexpected write: ' + relation);
                return { error: null };
              },
            }),
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: structuredClone(row), error: null }),
                in: async () => ({
                  data: tableIds.map((id) => ({ id, ...tables.get(id) })),
                  error: null,
                }),
              }),
            }),
          }) as never
      );
      // Legacy partial publication from before acknowledgment gating: the new
      // manager must still repair it before admitting a dealer after restart.
      Object.assign(row, { current_level: 1, level_started_at: '2026-09-10T12:10:00.000Z' });
      Object.assign(tables.get('table-one')!, expected);
      expect(tables.get('table-two')?.big_blind).toBe(50);
      old.running = false;
      recovering = true;
      const replacement = manager(row, []);
      const admitted: unknown[][] = [];
      replacement.startManagedTableEngine.mockImplementation(() => {
        admitted.push(structuredClone([...tables.values()]));
      });
      await replacement.resumeLifecycle(1);
      expect(recoveryWrites).toEqual(['table-two']);

      if (mode === 'unavailable') {
        expect(admitted).toEqual([]);
        expect(replacement.running).toBe(false);
        expect(replacement.tableEngines.size).toBe(0);
      } else {
        expect(replacement.running).toBe(true);
        expect(admitted).toEqual([
          [expected, expected],
          [expected, expected],
        ]);
        expect(replacement.currentLevel).toBe(1);
      }
    }
  );
});
