import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

let TournamentManagerBase: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let TournamentManagerEliminations: (typeof import('./TournamentManagerEliminations.js'))['TournamentManagerEliminations'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let tableStateHub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase } = await import('./TournamentManagerBase.js'));
  ({ TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub } = await import('../transport/TableStateHub.js'));
});
beforeEach(() => {
  setMaintenanceFrozen(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T12:10:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
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
  const read = vi.fn(async () => ({
    data: { id: state.tournamentId, status: 'RUNNING', ...structuredClone(row) },
    error: null as { message: string } | null,
  }));
  const writes = vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: read }) }),
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
  return { row, state, writes, publish, rpc, read };
}

describe('durable atomic blind-level transition', () => {
  const terminalReceipt = {
    winnerId: 'winner',
    winnerAmount: 50,
    dealShares: [{ userId: 'winner', place: 1, amount: 50 }],
    tableClosure: { closedTableIds: ['table-one', 'table-two'] },
    sourceCloseout: { sourceTableIds: ['table-one', 'table-two'] },
  };

  function retainTerminalCleanup(state: any) {
    Object.setPrototypeOf(state, TournamentManagerEliminations.prototype);
    state.broadcast = vi.fn().mockResolvedValue(true);
    state.cleanupCommittedTablesAndManager = vi.fn().mockResolvedValue(false);
    state.stop = vi.fn();
  }

  it.each(['cleanupCommittedTournament', 'cleanupCommittedSatellite', 'settleFinalTableDeal'])(
    '%s retires the blind clock while exact physical cleanup remains pending',
    async (method) => {
      const { state, rpc, writes } = fixture();
      retainTerminalCleanup(state);
      state.startBlindTimer(structure, 1000);
      const queuedWake = state.blindTimer;
      writes.mockClear();
      await expect(state[method](terminalReceipt)).resolves.toBe(false);
      expect(state.clearLifecycleTimeout).toHaveBeenCalledWith(queuedWake);
      expect(state.blindTimer).toBeNull();
      expect(state.running).toBe(true);
      expect(state.tableEngines.size).toBe(2);
      expect(state.stop).not.toHaveBeenCalled();

      // A callback already delivered before clearTimeout cannot restart work;
      // nor may maintenance or another caller arm this completed level clock.
      await queuedWake.callback();
      state.startBlindTimer(structure, 1000);
      state.scheduleBlindLevelWake(structure, 1000);
      expect(state.blindTimer).toBeNull();
      expect(rpc).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'refusal'])(
    'ignores a late blind %s after verified terminal commitment without clearing cleanup ownership',
    async (result) => {
      const { state, rpc, publish, writes } = fixture();
      retainTerminalCleanup(state);
      let resolve!: (value: unknown) => void;
      rpc.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }) as never
      );
      const advancing = state.advanceBlindLevel(structure);
      expect(rpc).toHaveBeenCalledOnce();
      const args = rpc.mock.calls[0][1];
      await state.cleanupCommittedTournament(terminalReceipt);
      resolve(
        result === 'success'
          ? publish(args)
          : { data: { ok: false, reason: 'tournament_not_running' }, error: null }
      );
      await advancing;
      expect(state.currentLevel).toBe(0);
      expect(state.pendingBlindTransition).toBeNull();
      expect(state.blindTimer).toBeNull();
      expect(rpc).toHaveBeenCalledOnce();
      expect(writes).not.toHaveBeenCalled();
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
      expect(state.running).toBe(true);
      expect(state.tableEngines.size).toBe(2);
      expect(state.stop).not.toHaveBeenCalled();
    }
  );

  it('does not retire a live clock from the precommit finish latch alone', async () => {
    const { state, rpc } = fixture();
    state.tournamentFinished = true;
    await state.advanceBlindLevel(structure);
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.currentLevel).toBe(1);
  });

  it.each([
    ['paused', 'paused'],
    ['tournament_not_running', 'tournament_not_running'],
    ['untrusted response body', 'unverified_receipt'],
  ])(
    'records the bounded refusal cause %s without accepting a blind level',
    async (reason, expected) => {
      const { state, rpc } = fixture();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      rpc.mockResolvedValueOnce({ data: { ok: false, reason }, error: null } as never);
      await state.advanceBlindLevel(structure);
      const record = errors.mock.calls.find(
        ([context]) => context === '[Tournament.blind_transition_failed]'
      );
      expect((record?.[1] as Error).message).toContain(
        `${expected}; tournament=level-restart; attemptedLevel=1`
      );
      expect((record?.[1] as Error).message).not.toContain('untrusted response body');
      expect(state.currentLevel).toBe(0);
      expect(state.blindTimer.delay).toBe(1000);
      expect(tableStateHub.emitEvent).not.toHaveBeenCalled();
    }
  );

  it('holds a due clock locally during maintenance and restores the shifted remaining time', async () => {
    const { row, state, rpc, writes, read } = fixture();
    const originalAnchor = state.blindTimerStartedAt;
    setMaintenanceFrozen(true);
    await state.advanceBlindLevel(structure);
    for (let i = 0; i < 3; i++) await state.blindTimer.callback();
    expect(rpc).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(state.currentLevel).toBe(0);
    expect(state.blindTimerStartedAt).toBe(originalAnchor);
    expect(state.blindTimer.delay).toBe(1000);

    // The level had five minutes left when the seven-minute freeze began.
    row.level_started_at = '2026-09-10T12:07:00.000Z';
    vi.setSystemTime(new Date('2026-09-10T12:12:00.000Z'));
    setMaintenanceFrozen(false);
    await state.blindTimer.callback();
    expect(read).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
    expect(state.blindTimer.delay).toBe(300000);
    expect(row.level_started_at).toBe('2026-09-10T12:07:00.000Z');
    vi.setSystemTime(new Date('2026-09-10T12:17:00.000Z'));
    await state.blindTimer.callback();
    expect(read).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(600000);
  });

  it('replays a lost publication after thaw using the same level and shifted receipt', async () => {
    const { row, state, rpc, publish, writes } = fixture();
    rpc.mockImplementationOnce(async (_name, args) => {
      publish(args);
      return { data: null, error: { message: 'response lost' } } as never;
    });
    await state.advanceBlindLevel(structure);
    setMaintenanceFrozen(true);
    await state.blindTimer.callback();
    expect(rpc).toHaveBeenCalledOnce();
    expect(writes).not.toHaveBeenCalled();
    row.level_started_at = '2026-09-10T12:17:00.000Z';
    vi.setSystemTime(new Date('2026-09-10T12:17:02.000Z'));
    setMaintenanceFrozen(false);
    await state.blindTimer.callback();
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(state.currentLevel).toBe(1);
    expect(state.blindTimer.delay).toBe(598000);
  });

  it('does not overwrite a committed anchor when maintenance starts before the response', async () => {
    const { row, state, rpc, publish, writes } = fixture();
    rpc.mockImplementationOnce(async (_name, args) => {
      const result = publish(args);
      setMaintenanceFrozen(true);
      return result as never;
    });
    await state.advanceBlindLevel(structure);
    expect(state.currentLevel).toBe(1);
    expect(writes).not.toHaveBeenCalled();
    expect(state.blindTimer.delay).toBe(1000);
    row.level_started_at = '2026-09-10T12:17:00.000Z';
    vi.setSystemTime(new Date('2026-09-10T12:17:02.000Z'));
    setMaintenanceFrozen(false);
    await state.blindTimer.callback();
    expect(rpc).toHaveBeenCalledOnce();
    expect(state.blindTimer.delay).toBe(598000);
  });

  it.each(['read failure', 'replacement', 'freeze resumed', 'wrong level', 'invalid anchor'])(
    'retains the clock without publication when thaw resynchronization sees %s',
    async (fault) => {
      const { state, rpc, read, row } = fixture();
      setMaintenanceFrozen(true);
      await state.advanceBlindLevel(structure);
      setMaintenanceFrozen(false);
      read.mockImplementationOnce(async () => {
        if (fault === 'replacement') state.running = false;
        if (fault === 'freeze resumed') setMaintenanceFrozen(true);
        return {
          data: {
            id: state.tournamentId,
            status: 'RUNNING',
            ...structuredClone(row),
            current_level: fault === 'wrong level' ? 2 : row.current_level,
            level_started_at: fault === 'invalid anchor' ? 'bad' : row.level_started_at,
          },
          error: fault === 'read failure' ? { message: 'unavailable' } : null,
        };
      });
      await state.blindTimer.callback();
      expect(rpc).not.toHaveBeenCalled();
      expect(state.currentLevel).toBe(0);
      if (fault === 'replacement') expect(state.blindTimer).toBeNull();
      else expect(state.blindTimer.delay).toBe(1000);
    }
  );

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
