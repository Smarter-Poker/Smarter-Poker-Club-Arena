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
    tournamentLeaseGeneration: 'active-generation',
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

const structure = [
  { smallBlind: 25, bigBlind: 50, durationMinutes: 10 },
  { smallBlind: 50, bigBlind: 100, durationMinutes: 10 },
  { smallBlind: 100, bigBlind: 200, durationMinutes: 10 },
];
function fixture() {
  const row: Record<string, any> = {
    current_level: 0,
    level_started_at: '2026-09-10T12:00:00.000Z',
    blind_structure: structure,
    prize_pool_finalized: true,
  };
  const state = manager(row, ['table-one', 'table-two']);
  const writes = vi.spyOn(supabase, 'from').mockReturnValue({
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        Object.assign(row, patch);
        return { error: null };
      },
    }),
  } as never);
  const publish = (args: any) => {
    if (row.current_level !== args.p_next_level)
      Object.assign(row, {
        current_level: args.p_next_level,
        level_started_at: new Date().toISOString(),
        blind_level_state: {
          index: args.p_next_level,
          small_blind: args.p_small_blind,
          big_blind: args.p_big_blind,
          ante: args.p_ante,
        },
      });
    return {
      data: {
        ok: true,
        tournament_id: state.tournamentId,
        current_level: row.current_level,
        level_started_at: row.level_started_at,
        blind_level_state: structuredClone(row.blind_level_state),
      },
      error: null,
    };
  };
  const rpc = vi
    .spyOn(supabase as unknown as { rpc: (name: string, args: any) => Promise<any> }, 'rpc')
    .mockImplementation(async (_name: string, args: any) => publish(args) as never);
  return { row, state, writes, publish, rpc };
}

describe('durable atomic blind-level transition', () => {
  it('publishes once for the whole event and announces only its matching receipt', async () => {
    const { state, rpc, writes } = fixture();
    await state.advanceBlindLevel(structure);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      'fn_publish_tournament_blind_level',
      expect.objectContaining({
        p_tournament_id: 'level-restart',
        p_lease_generation: 'active-generation',
        p_previous_level: 0,
        p_next_level: 1,
        p_small_blind: 50,
        p_big_blind: 100,
        p_ante: 0,
      })
    );
    expect(writes.mock.calls.every(([relation]) => relation === 'tournaments')).toBe(true);
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(600000);
    expect(tableStateHub.emitEvent).toHaveBeenCalledTimes(2);
  });

  it.each(['write failure', 'lost response'])(
    'retries exactly the same transition after %s without premature announcements',
    async (mode) => {
      const { row, state, rpc, publish } = fixture();
      rpc.mockImplementationOnce(async (_name: string, args: any) => {
        if (mode === 'lost response') publish(args);
        return { data: null, error: { message: mode } } as never;
      });
      await state.advanceBlindLevel(structure);
      expect(state.currentLevel).toBe(0);
      expect(row.current_level).toBe(mode === 'lost response' ? 1 : 0);
      expect(state.blindTimer.delay).toBe(1000);
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
      vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
      await state.blindTimer.callback();
      expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
      expect(state.currentLevel).toBe(1);
      expect(state.blindTimer.delay).toBe(mode === 'lost response' ? 598000 : 600000);
      expect(state.broadcast).toHaveBeenCalledOnce();
    }
  );

  it('uses the durable shifted anchor when a lost response is retried after a break', async () => {
    const { row, state, rpc, publish } = fixture();
    rpc.mockImplementationOnce(async (_name: string, args: any) => {
      publish(args);
      return { data: null, error: { message: 'reply lost' } } as never;
    });
    await state.advanceBlindLevel(structure);
    vi.setSystemTime(new Date('2026-09-10T12:10:02.000Z'));
    state.onBreak = true;
    state.suspendLevelClock();
    await state.advanceBlindLevel(structure);
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.blindTimer).toBeNull();
    vi.setSystemTime(new Date('2026-09-10T12:15:02.000Z'));
    // The database thaw, not the replay request, owns the durable clock shift.
    row.level_started_at = '2026-09-10T12:15:00.000Z';
    state.onBreak = false;
    state.startBlindTimer(structure, state.savedBlindTimerRemaining);
    await state.blindTimer.callback();
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(598000);
    expect(row.level_started_at).toBe('2026-09-10T12:15:00.000Z');
  });

  it.each(['missing', 'false', 'wrong event', 'wrong level', 'wrong amounts', 'invalid clock'])(
    'does not acknowledge a %s receipt',
    async (fault) => {
      const { state, rpc, publish } = fixture();
      rpc.mockImplementationOnce(async (_name: string, args: any) => {
        const result = publish(args);
        if (fault === 'missing') return { data: null, error: null } as never;
        if (fault === 'false') result.data.ok = false;
        if (fault === 'wrong event') result.data.tournament_id = 'another-event';
        if (fault === 'wrong level') result.data.current_level = 2;
        if (fault === 'wrong amounts') result.data.blind_level_state.big_blind = 200;
        if (fault === 'invalid clock') result.data.level_started_at = 'bad';
        return result as never;
      });
      await state.advanceBlindLevel(structure);
      expect(state.currentLevel).toBe(0);
      expect(state.blindTimer.delay).toBe(1000);
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
    }
  );

  it('retains the next-level clock when notification fails after publication', async () => {
    const { state } = fixture();
    state.broadcast.mockRejectedValueOnce(new Error('notification unavailable'));
    await state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(1);
    expect(state.pendingBlindTransition).toBeNull();
    expect(state.blindTimer.delay).toBe(600000);
    expect(state.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(1000);
  });

  it('does not publish locally or arm a timer for a replaced manager', async () => {
    const { state, rpc, publish } = fixture();
    rpc.mockImplementationOnce(async (_name: string, args: any) => {
      const receipt = publish(args);
      state.running = false;
      return receipt as never;
    });
    await state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(0);
    expect(state.blindTimer).toBeNull();
    expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
  });

  it('keeps one in-flight publication when a second clock wake arrives', async () => {
    const { state, rpc, publish } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc.mockImplementationOnce(async (_name: string, args: any) => {
      await pending;
      return publish(args) as never;
    });
    const first = state.advanceBlindLevel(structure);
    await state.advanceBlindLevel(structure);
    expect(rpc).toHaveBeenCalledOnce();
    release();
    await first;
    expect(state.broadcast).toHaveBeenCalledOnce();
  });

  it('restores committed amounts even when recomputing the cap would differ', () => {
    const { state, row } = fixture();
    row.current_level = 1;
    row.blind_level_state = { index: 1, small_blind: 45, big_blind: 90, ante: 9 };
    expect(state.resolveCommittedBlindLevel(row, 1)).toEqual({
      smallBlind: 45,
      bigBlind: 90,
      ante: 9,
      durationMinutes: 10,
    });
    row.blind_level_state.index = 0;
    expect(() => state.resolveCommittedBlindLevel(row, 1)).toThrow('snapshot is invalid');
  });
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
