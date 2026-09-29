/**
 * Multi-day tournaments, engine half (R2 + R5). MULTI-DAY-DESIGN.md section 8
 * "Engine" and the restart-at-every-boundary cases that can be expressed with
 * the database answering exactly what the migration's RPCs answer.
 *
 * The harness is the real TournamentManagerBase prototype with the database
 * replaced by a routing fake: every `from(table)` and `rpc(name)` is recorded,
 * and answered by the handler the test installs for it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import { TournamentLifecycleEpoch } from './TournamentLifecycleEpoch.js';

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
  setMaintenanceFrozen(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
});

const T = 'tournament-md';
const GEN = 'lease-generation-1';
const MAX_HEALTHY_PAUSE_MS = 10 * 60 * 1000;

type Query = {
  table: string;
  op: 'select' | 'insert' | 'update';
  filters: Record<string, unknown>;
  payload?: unknown;
};
type Handlers = {
  tables?: Record<string, (q: Query) => unknown>;
  rpc?: Record<string, (args: any) => unknown>;
};

/** Route every database call to a per-table / per-RPC answer and record it. */
function fakeDb(handlers: Handlers) {
  const from: Query[] = [];
  const rpc: Array<[string, any]> = [];
  vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
    const q: Query = { table: name, op: 'select', filters: {} };
    from.push(q);
    const answer = () =>
      Promise.resolve(handlers.tables?.[name]?.(q) ?? { data: null, error: null });
    const chain: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'then')
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              answer().then(resolve, reject);
          if (prop === 'maybeSingle') return () => answer();
          return (...args: unknown[]) => {
            if (prop === 'insert' || prop === 'update') {
              q.op = prop;
              q.payload = args[0];
            } else if (['eq', 'in', 'gt', 'is', 'lt'].includes(prop)) {
              q.filters[String(args[0])] = args[1];
            }
            return chain;
          };
        },
      }
    );
    return chain;
  }) as never);
  vi.spyOn(
    supabase as unknown as { rpc: (n: string, a: any) => Promise<any> },
    'rpc'
  ).mockImplementation((async (name: string, args: any) => {
    rpc.push([name, args]);
    const handler = handlers.rpc?.[name];
    if (!handler) return { data: null, error: { message: `unexpected rpc ${name}` } };
    return handler(args);
  }) as never);
  return { from, rpc, rpcNames: () => rpc.map(([name]) => name) };
}

const structure = [
  { smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
  { smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 10 },
  { smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 10 },
  { smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 20 },
  { smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 20 },
];

function engine(opts: { parked?: boolean } = {}) {
  return {
    pauseAfterHand: vi.fn(),
    resumeDealing: vi.fn(),
    holdDealingUntil: vi.fn(),
    isParkedBetweenHands: vi.fn(() => opts.parked ?? true),
    isMaintenancePaused: vi.fn(() => false),
    isBetweenHands: vi.fn(() => opts.parked ?? true),
    setHub: vi.fn(),
    isRunning: vi.fn(() => false),
  };
}

/** The real prototype, with only process plumbing stubbed. */
function manager(overrides: Record<string, unknown> = {}) {
  const epoch = new TournamentLifecycleEpoch();
  const state: any = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: T,
    tournamentLeaseGeneration: GEN,
    tournamentLeaseProofDeadlineMonotonicMs: Number.MAX_SAFE_INTEGER,
    lifecycleEpoch: epoch,
    lifecycleTimeouts: new Set(),
    lifecycleJobs: new Set(),
    tableEngineRecoveryAttempts: new Map(),
    tableEngines: new Map(),
    running: true,
    onBreak: false,
    addOnBreakActive: false,
    handForHandActive: false,
    isProcessingEliminations: false,
    blindTimer: null,
    blindStartTimer: null,
    multiDayPlan: null,
    stageEndPause: null,
    stageBagInFlight: false,
    stageBagCommitted: false,
    stageBagHeldReason: null,
    stageBagRedrives: 0,
    stageThawUnsubscribe: null,
    stageBagFrozenRetryUsed: false,
    stageBagAskAgainWhenSettled: false,
    stageResumeInProgress: false,
    currentLevel: 0,
    lastObservedHandCompletedAtMs: Date.now(),
    blindTimerStartedAt: Date.now() - 600_000,
    stalledLevelHoldAnnouncedFor: new Set(),
    tournamentCache: {
      id: T,
      tournament_type: 'MTT',
      variant: 'freezeout',
      blind_structure: structure,
      prize_pool_finalized: true,
    },
    broadcast: vi.fn(async () => true),
    requestEliminationSweep: vi.fn(() => true),
    requestUrgentEliminationSweepAfter: vi.fn(),
    reconcileTournamentEntryWindow: vi.fn(async () => true),
    stop: vi.fn(() => Promise.resolve()),
    standDownForDatabaseFence: vi.fn(),
    armTournamentLeaseExpiryTimer: vi.fn(),
    ...overrides,
  });
  epoch.begin();
  return state;
}

function activePlan(stages: Array<Partial<Record<string, unknown>>>) {
  return {
    kind: 'active',
    timeZone: 'America/Chicago',
    stages: stages.map((stage, index) => ({
      stageNo: index + 1,
      endAfterLevel: null,
      scheduledStartUtc: index === 0 ? null : '2026-09-25T17:00:00.000Z',
      scheduleGeneration: 1,
      state: 'planned',
      ...stage,
    })),
  };
}

function publishHandler(state: any) {
  return (args: any) => ({
    data: {
      ok: true,
      tournament_id: state.tournamentId,
      current_level: args.p_next_level,
      level_started_at: new Date().toISOString(),
      blind_level_state: {
        index: args.p_next_level,
        small_blind: args.p_small_blind,
        big_blind: args.p_big_blind,
        ante: args.p_ante,
      },
    },
    error: null,
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// ───────────────────────────────────────────────────────────────────────────
describe('inert unless a sealed plan exists AND the capability is available', () => {
  it.each([
    { tournament_type: 'MTT', variant: 'spin' },
    { tournament_type: 'MTT', variant: 'sng' },
    { tournament_type: 'SNG', variant: 'freezeout' },
    {},
  ])('a format the seal refuses (%o) asks the database nothing', async (row) => {
    const db = fakeDb({});
    const state = manager();
    await state.loadMultiDayPlan(row, state.lifecycleEpoch.current());
    expect(state.multiDayPlan).toEqual({ kind: 'none' });
    expect(db.from).toHaveLength(0);
    expect(db.rpc).toHaveLength(0);
  });

  it.each(['42P01', 'PGRST205'])(
    'a missing plan table (%s) reads as no multi-day, before the migrations exist',
    async (code) => {
      const db = fakeDb({
        tables: { tournament_stage_plans: () => ({ data: null, error: { code, message: 'x' } }) },
      });
      const state = manager();
      await state.loadMultiDayPlan(state.tournamentCache, state.lifecycleEpoch.current());
      expect(state.multiDayPlan).toEqual({ kind: 'none' });
      expect(db.rpc).toHaveLength(0);
    }
  );

  it.each(['42883', 'PGRST202'])(
    'a missing capability function (%s) reads as no multi-day',
    async (code) => {
      fakeDb({
        tables: { tournament_stage_plans: () => ({ data: planRow(), error: null }) },
        rpc: { fn_capability_available: () => ({ data: null, error: { code, message: 'x' } }) },
      });
      const state = manager();
      await state.loadMultiDayPlan(state.tournamentCache, state.lifecycleEpoch.current());
      expect(state.multiDayPlan).toEqual({ kind: 'none' });
    }
  );

  it('no plan row, or the capability answering false, is no multi-day', async () => {
    const noPlan = fakeDb({});
    const a = manager();
    await a.loadMultiDayPlan(a.tournamentCache, a.lifecycleEpoch.current());
    expect(a.multiDayPlan).toEqual({ kind: 'none' });
    expect(noPlan.rpc).toHaveLength(0);
    vi.restoreAllMocks();

    const db = fakeDb({
      tables: { tournament_stage_plans: () => ({ data: planRow(), error: null }) },
      rpc: { fn_capability_available: () => ({ data: false, error: null }) },
    });
    const b = manager();
    await b.loadMultiDayPlan(b.tournamentCache, b.lifecycleEpoch.current());
    expect(b.multiDayPlan).toEqual({ kind: 'none' });
    expect(db.from.map((q) => q.table)).toEqual(['tournament_stage_plans']);
    expect(db.rpc).toEqual([
      ['fn_capability_available', { p_capability_id: 'tournament.multi_day.single_flight' }],
    ]);
  });

  it('an unreadable plan is UNKNOWN, never folded into "no plan"', async () => {
    fakeDb({
      tables: {
        tournament_stage_plans: () => ({
          data: null,
          error: { code: '57014', message: 'timeout' },
        }),
      },
    });
    const state = manager();
    await state.loadMultiDayPlan(state.tournamentCache, state.lifecycleEpoch.current());
    expect(state.multiDayPlan.kind).toBe('unknown');
  });

  it('a live plan with the capability available reads its stages', async () => {
    fakeDb({
      tables: {
        tournament_stage_plans: () => ({ data: planRow(), error: null }),
        tournament_stages: () => ({ data: stageRows(), error: null }),
      },
      rpc: { fn_capability_available: () => ({ data: true, error: null }) },
    });
    const state = manager();
    await state.loadMultiDayPlan(state.tournamentCache, state.lifecycleEpoch.current());
    expect(state.multiDayPlan).toMatchObject({
      kind: 'active',
      stages: [
        { stageNo: 1, endAfterLevel: 2, state: 'planned' },
        { stageNo: 2, endAfterLevel: null, state: 'planned' },
      ],
    });
  });

  it('with no plan, a level advances byte-for-byte as it did before multi-day existed', async () => {
    const runs: Array<{ rpc: Array<[string, any]>; tables: string[]; events: unknown[] }> = [];
    for (const plan of [undefined, null, { kind: 'none' }]) {
      vi.restoreAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const emit = vi.spyOn(tableStateHub, 'emitEvent').mockImplementation(() => {});
      const state = manager({ multiDayPlan: plan, currentLevel: 2 });
      state.tableEngines.set('table-a', engine());
      const db = fakeDb({ rpc: { fn_publish_tournament_blind_level: publishHandler(state) } });
      state.setLifecycleTimeout = vi.fn(() => 0);
      await state.advanceBlindLevel(structure);
      runs.push({
        rpc: db.rpc,
        tables: db.from.map((q) => q.table),
        events: emit.mock.calls.map(([, event]: any[]) => ({ ...event, timestamp: 0 })),
      });
      expect(state.currentLevel).toBe(3);
      expect(state.stageEndPause).toBeNull();
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].rpc.map(([name]) => name)).toEqual(['fn_publish_tournament_blind_level']);
  });
});

function planRow() {
  return { tournament_id: T, time_zone: 'America/Chicago', stage_count: 2 };
}
function stageRows(state1 = 'planned', state2 = 'planned') {
  return [
    {
      stage_no: 1,
      end_after_level: 2,
      scheduled_start_utc: null,
      schedule_generation: 1,
      state: state1,
    },
    {
      stage_no: 2,
      end_after_level: null,
      scheduled_start_utc: '2026-09-25T17:00:00.000Z',
      schedule_generation: 1,
      state: state2,
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
describe('no level is published past end_after_level', () => {
  function dayEnd(outcome: unknown) {
    const state = manager({
      multiDayPlan: activePlan([{ endAfterLevel: 2 }, {}]),
      currentLevel: 2,
    });
    const table = engine({ parked: false });
    state.tableEngines.set('table-a', table);
    state.setLifecycleTimeout = vi.fn(() => 0);
    const db = fakeDb({
      rpc: {
        fn_begin_stage_end: () => outcome,
        fn_publish_tournament_blind_level: publishHandler(state),
      },
    });
    return { state, table, db };
  }

  it('the day ends instead: intent recorded, tables held, clock unarmed, nothing published', async () => {
    const { state, table, db } = dayEnd({
      data: { ok: true, replay: false, day_end_id: 'd1', stage_no: 1, ended_level: 2 },
      error: null,
    });
    await state.advanceBlindLevel(structure);
    expect(db.rpc).toEqual([
      [
        'fn_begin_stage_end',
        { p_tournament_id: T, p_lease_generation: GEN, p_stage_no: 1, p_ended_level: 2 },
      ],
    ]);
    expect(db.rpcNames()).not.toContain('fn_publish_tournament_blind_level');
    expect(state.currentLevel).toBe(2);
    expect(state.stageEndPause).toEqual({ stageNo: 1, endedLevel: 2 });
    expect(table.pauseAfterHand).toHaveBeenCalledWith(MAX_HEALTHY_PAUSE_MS, {
      beforeNextHand: true,
      untilResumed: true,
    });
    expect(state.setLifecycleTimeout).not.toHaveBeenCalled();
    expect(state.broadcast).toHaveBeenCalledWith('stage_day_ending', { stageNo: 1, level: 2 });
  });

  it('a level before the day ends is published exactly as always', async () => {
    const state = manager({
      multiDayPlan: activePlan([{ endAfterLevel: 4 }, {}]),
      currentLevel: 2,
    });
    state.setLifecycleTimeout = vi.fn(() => 0);
    const db = fakeDb({ rpc: { fn_publish_tournament_blind_level: publishHandler(state) } });
    await state.advanceBlindLevel(structure);
    expect(db.rpcNames()).toEqual(['fn_publish_tournament_blind_level']);
    expect(state.currentLevel).toBe(3);
    expect(state.stageEndPause).toBeNull();
  });

  it('the final stage has no day end: its levels keep publishing', async () => {
    const state = manager({
      multiDayPlan: activePlan([
        { endAfterLevel: 1, state: 'closed' },
        { endAfterLevel: null, state: 'running' },
      ]),
      currentLevel: 2,
    });
    state.setLifecycleTimeout = vi.fn(() => 0);
    const db = fakeDb({ rpc: { fn_publish_tournament_blind_level: publishHandler(state) } });
    await state.advanceBlindLevel(structure);
    expect(db.rpcNames()).toEqual(['fn_publish_tournament_blind_level']);
  });

  it('an unacknowledged intent holds the level and replays the same call; it never publishes', async () => {
    const { state, db } = dayEnd({ data: null, error: { message: 'fetch failed' } });
    await state.advanceBlindLevel(structure);
    expect(db.rpcNames()).toEqual(['fn_begin_stage_end']);
    expect(state.stageEndPause).toBeNull();
    expect(state.setLifecycleTimeout).toHaveBeenCalledWith(expect.any(Function), 15_000);
  });

  it('a stage the database already records as ending re-arms the pause without asking again', async () => {
    const state = manager({
      multiDayPlan: activePlan([{ endAfterLevel: 2, state: 'day_ending' }, {}]),
      currentLevel: 2,
    });
    state.setLifecycleTimeout = vi.fn(() => 0);
    const db = fakeDb({});
    await state.advanceBlindLevel(structure);
    expect(db.rpc).toHaveLength(0);
    expect(state.stageEndPause).toEqual({ stageNo: 1, endedLevel: 2 });
  });

  it('a withdrawn capability reads as no multi-day: the event plays on', async () => {
    const { state, db } = dayEnd({
      data: { ok: false, reason: 'capability_unavailable' },
      error: null,
    });
    await state.advanceBlindLevel(structure);
    expect(db.rpcNames()).toEqual(['fn_begin_stage_end', 'fn_publish_tournament_blind_level']);
    expect(state.multiDayPlan).toEqual({ kind: 'none' });
  });

  it('a lost lease stands the manager down; nothing is published', async () => {
    const { state, db } = dayEnd({ data: { ok: false, reason: 'lease_lost' }, error: null });
    await state.advanceBlindLevel(structure);
    expect(db.rpcNames()).toEqual(['fn_begin_stage_end']);
    expect(state.standDownForDatabaseFence).toHaveBeenCalledOnce();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the stage-end pause is its own authority', () => {
  it('a replacement engine inherits it before it can deal', () => {
    const state = manager({ stageEndPause: { stageNo: 1, endedLevel: 2 } });
    const replacement = engine();
    state.prepareManagedTableEngineForPlay(replacement);
    expect(replacement.pauseAfterHand).toHaveBeenCalledWith(MAX_HEALTHY_PAUSE_MS, {
      beforeNextHand: true,
      untilResumed: true,
    });
  });

  it('pauseForBreak is refused while the day is ending, and while a stage is resuming', async () => {
    for (const flags of [
      { stageEndPause: { stageNo: 1, endedLevel: 2 } },
      { stageResumeInProgress: true },
    ]) {
      vi.restoreAllMocks();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const db = fakeDb({});
      const state = manager(flags);
      const table = engine();
      state.tableEngines.set('table-a', table);
      await state.pauseForBreak(5 * 60 * 1000);
      expect(state.onBreak).toBe(false);
      expect(db.from).toHaveLength(0);
      expect(state.broadcast).not.toHaveBeenCalled();
      expect(table.pauseAfterHand).not.toHaveBeenCalled();
    }
  });

  it('a break ending never lifts it: no table resumes and no level clock is armed', async () => {
    const state = manager({ onBreak: true, stageEndPause: { stageNo: 1, endedLevel: 2 } });
    const table = engine();
    state.tableEngines.set('table-a', table);
    state.clearPersistedBreak = vi.fn(async () => undefined);
    state.advanceHandForHandBarrier = vi.fn();
    state.startBlindTimer = vi.fn();
    state.scheduleBlindLevelWake = vi.fn();
    await state.resumeFromBreak();
    expect(state.onBreak).toBe(false);
    expect(table.resumeDealing).not.toHaveBeenCalled();
    expect(state.startBlindTimer).not.toHaveBeenCalled();
    expect(state.scheduleBlindLevelWake).not.toHaveBeenCalled();
    expect(state.isOnBreak()).toBe(true);
  });

  it('holds the maintenance resume and hand-for-hand: isOnBreak answers for it', () => {
    const state = manager();
    expect(state.isOnBreak()).toBe(false);
    state.stageEndPause = { stageNo: 1, endedLevel: 2 };
    expect(state.isOnBreak()).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('BAGGED readers', () => {
  function lifecycleHarness(row: Record<string, unknown>) {
    const db = fakeDb({
      tables: {
        tournaments: () => ({ data: row, error: null }),
        tables: () => ({ data: [], error: null }),
      },
    });
    const state = manager({
      createTablesAndSeatPlayers: vi.fn(async () => {}),
      createManagedTableEngine: vi.fn(() => engine()),
      startBlindTimer: vi.fn(),
      startEliminationChecker: vi.fn(),
      unregisterEliminationScheduler: vi.fn(),
      readTournamentClub: vi.fn(async () => {}),
    });
    return { db, state };
  }

  it('startLifecycle refuses a BAGGED row: no tables, no clock, no manager', async () => {
    const { state, db } = lifecycleHarness({
      id: T,
      status: 'BAGGED',
      format_contract: 'mtt-v1',
      tournament_type: 'MTT',
      blind_structure: structure,
    });
    await state.startLifecycle(state.lifecycleEpoch.current());
    expect(state.running).toBe(false);
    expect(state.createTablesAndSeatPlayers).not.toHaveBeenCalled();
    expect(state.startBlindTimer).not.toHaveBeenCalled();
    expect(db.from.map((q) => q.table)).toEqual(['tournaments']);
  });

  it('resumeLifecycle leaves a BAGGED row to the stage-resume lane', async () => {
    const { state, db } = lifecycleHarness({
      id: T,
      status: 'BAGGED',
      format_contract: 'mtt-v1',
      tournament_type: 'MTT',
    });
    await state.resumeLifecycle(state.lifecycleEpoch.current());
    expect(state.running).toBe(false);
    expect(state.createManagedTableEngine).not.toHaveBeenCalled();
    expect(db.from.map((q) => q.table)).toEqual(['tournaments']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('restart after the day-end receipt (boundary 1)', () => {
  it('re-arms the stage-end pause before any replacement dealer exists, and arms no clock', async () => {
    const row = {
      id: T,
      status: 'RUNNING',
      format_contract: 'mtt-v1',
      tournament_type: 'MTT',
      variant: 'freezeout',
      blind_structure: structure,
      current_level: 2,
      level_started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      prize_pool_finalized: true,
      on_break: false,
    };
    fakeDb({
      tables: {
        tournaments: () => ({ data: row, error: null }),
        tables: () => ({
          data: [{ id: 'table-a', small_blind: 100, big_blind: 200, ante: 25, stakes: '100/200' }],
          error: null,
        }),
        tournament_stage_plans: () => ({ data: planRow(), error: null }),
        tournament_stages: () => ({ data: stageRows('day_ending'), error: null }),
      },
      rpc: { fn_capability_available: () => ({ data: true, error: null }) },
    });
    const order: string[] = [];
    const replacement = engine({ parked: false });
    replacement.pauseAfterHand.mockImplementation(() => order.push('paused'));
    const state = manager({
      readTournamentClub: vi.fn(async () => {}),
      createManagedTableEngine: vi.fn(() => replacement),
      wireEliminationWake: vi.fn(),
      admitManagedTableEngine: vi.fn(),
      startManagedTableEngine: vi.fn(() => order.push('started')),
      restoreDrawnFirstButtons: vi.fn(async () => {}),
      drainTableEngineStartJobs: vi.fn(async () => {}),
      startBlindTimer: vi.fn(),
      startEliminationChecker: vi.fn(),
    });
    await state.resumeLifecycle(state.lifecycleEpoch.current());
    expect(state.stageEndPause).toEqual({ stageNo: 1, endedLevel: 2 });
    expect(order).toEqual(['paused', 'started']);
    expect(replacement.pauseAfterHand).toHaveBeenCalledWith(MAX_HEALTHY_PAUSE_MS, {
      beforeNextHand: true,
      untilResumed: true,
    });
    expect(state.startBlindTimer).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the stage-end barrier and the bag', () => {
  function barrier(bag: (args: any) => unknown, opts: { parked?: boolean } = {}) {
    const state = manager({
      multiDayPlan: activePlan([{ endAfterLevel: 2, state: 'day_ending' }, {}]),
      stageEndPause: { stageNo: 1, endedLevel: 2 },
    });
    state.tableEngines.set('table-a', engine({ parked: opts.parked ?? true }));
    state.tableEngines.set('table-b', engine({ parked: opts.parked ?? true }));
    const db = fakeDb({
      tables: {
        tables: () => ({
          data: [
            { id: 'table-a', status: 'running', is_deleted: false },
            { id: 'table-b', status: 'running', is_deleted: false },
            { id: 'table-old', status: 'closed', is_deleted: false },
          ],
          error: null,
        }),
        hand_atomic_commits: (q) => ({
          data: q.filters.table_id === 'table-a' ? { hand_number: 41 } : null,
          error: null,
        }),
      },
      rpc: { fn_bag_tournament_stage: bag },
    });
    return { state, db };
  }
  const bagged = {
    data: {
      ok: true,
      replay: false,
      bag_id: 'bag-1',
      stage_no: 1,
      next_stage_no: 2,
      players: 12,
      total_chips: 120000,
      next_stage_start_utc: '2026-09-25T17:00:00+00:00',
      time_zone: 'America/Chicago',
    },
    error: null,
  };

  it('waits while a table still has cards in the air', async () => {
    const { state, db } = barrier(() => bagged, { parked: false });
    state.advanceStageEndBarrier();
    await flush();
    expect(db.rpc).toHaveLength(0);
  });

  it('bags every open table at its last accepted hand, then stands the manager down', async () => {
    const { state, db } = barrier(() => bagged);
    state.advanceStageEndBarrier();
    await flush();
    expect(db.rpc).toEqual([
      [
        'fn_bag_tournament_stage',
        {
          p_tournament_id: T,
          p_lease_generation: GEN,
          p_stage_no: 1,
          p_watermarks: [
            { table_id: 'table-a', last_hand_number: 41 },
            { table_id: 'table-b', last_hand_number: null },
          ],
        },
      ],
    ]);
    expect(state.broadcast).toHaveBeenCalledWith(
      'stage_bagged',
      expect.objectContaining({ stageNo: 1, nextStageNo: 2, players: 12, totalChips: 120000 })
    );
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it('a frozen refusal is retried only after the thaw notification, never on a timer', async () => {
    let answer: unknown = { data: { ok: false, reason: 'platform_frozen' }, error: null };
    const { state, db } = barrier(() => answer);
    setMaintenanceFrozen(true);
    // Inside the freeze nothing is even asked.
    state.advanceStageEndBarrier();
    await flush();
    expect(db.rpc).toHaveLength(0);
    // The thaw is the edge. The database answered frozen after the local
    // freeze had lifted, so its thaw edge has passed: it is asked once more,
    // and then waits for the next thaw notification.
    setMaintenanceFrozen(false);
    await flush();
    expect(db.rpc).toHaveLength(2);
    setMaintenanceFrozen(true);
    await flush();
    expect(db.rpc).toHaveLength(2);
    answer = bagged;
    setMaintenanceFrozen(false);
    await flush();
    expect(db.rpc).toHaveLength(3);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it('bag committed and response lost (boundary 4): stand down for the durable record, no retry', async () => {
    const { state, db } = barrier(() => ({ data: null, error: { message: 'socket hang up' } }));
    state.advanceStageEndBarrier();
    await flush();
    expect(state.stop).toHaveBeenCalledOnce();
    state.advanceStageEndBarrier();
    await flush();
    expect(db.rpc).toHaveLength(1);
  });

  it('a felt not yet at rest is re-driven through the elimination sweep, bounded', async () => {
    const { state, db } = barrier(() => ({
      data: { ok: false, reason: 'stack_invalid' },
      error: null,
    }));
    for (let i = 0; i < 12; i++) {
      state.advanceStageEndBarrier();
      await flush();
    }
    // Five re-drives plus two per table (two tables), then the refusal is
    // held for a fix and reported.
    expect(db.rpc).toHaveLength(10);
    expect(state.requestEliminationSweep).toHaveBeenCalledTimes(9);
    expect(state.stageBagHeldReason).toBe('stack_invalid');
  });

  it('a lost lease stands the manager down', async () => {
    const { state } = barrier(() => ({ data: { ok: false, reason: 'lease_lost' }, error: null }));
    state.advanceStageEndBarrier();
    await flush();
    expect(state.standDownForDatabaseFence).toHaveBeenCalledOnce();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the next stage resumes (resumeStageLifecycle)', () => {
  const baggedRow = {
    id: T,
    status: 'BAGGED',
    format_contract: 'mtt-v1',
    tournament_type: 'MTT',
    variant: 'freezeout',
    name: 'Two Day Main',
    club_id: 'club-1',
    table_size: 2,
    game_type: 'NLH',
    blind_structure: JSON.stringify(structure),
    blind_level_state: { index: 3, small_blind: 200, big_blind: 400, ante: 50 },
    prize_pool_finalized: true,
  };
  const entitlementRows = [
    { id: 'e-human-1', user_id: 'human-1', stack: 40000, state: 'active' },
    { id: 'e-horse-1', user_id: 'horse-1', stack: 50000, state: 'active' },
    { id: 'e-human-2', user_id: 'human-2', stack: 30000, state: 'active' },
  ];

  function resume(opts: {
    row?: Record<string, unknown>;
    stages?: unknown[];
    begin?: (args: any) => unknown;
    seat?: (args: any) => unknown;
    complete?: (args: any) => unknown;
    entitlements?: unknown[];
    tables?: unknown[];
    liveSeats?: unknown[];
  }) {
    const db = fakeDb({
      tables: {
        tournaments: () => ({ data: opts.row ?? { ...baggedRow }, error: null }),
        tournament_stage_plans: () => ({ data: planRow(), error: null }),
        tournament_stages: () => ({
          data: opts.stages ?? stageRows('bagged', 'scheduled'),
          error: null,
        }),
        tournament_stage_clock_snapshots: () => ({ data: { next_level_index: 3 }, error: null }),
        tournament_qualification_entitlements: () => ({
          data: opts.entitlements ?? entitlementRows,
          error: null,
        }),
        tables: (q) =>
          q.op === 'insert'
            ? { data: { id: `new-table-${Math.random().toString(36).slice(2, 8)}` }, error: null }
            : { data: opts.tables ?? [], error: null },
        table_seats: () => ({ data: opts.liveSeats ?? [], error: null }),
      },
      rpc: {
        fn_capability_available: () => ({ data: true, error: null }),
        fn_begin_stage_resume:
          opts.begin ??
          ((args: any) => ({
            data: { ok: true, replay: false, completed: false, resume_id: args.p_resume_id },
            error: null,
          })),
        fn_seat_stage_entitlement:
          opts.seat ??
          ((args: any) => ({
            data: { ok: true, entitlement_id: args.p_entitlement_id },
            error: null,
          })),
        fn_complete_stage_resume:
          opts.complete ??
          (() => ({
            data: { ok: true, players: 3, current_level: 3, status: 'RUNNING' },
            error: null,
          })),
      },
    });
    const state = manager({ multiDayPlan: null, tournamentCache: null });
    state.resumeLifecycle = vi.fn(async () => {});
    return { db, state };
  }

  it('begins with the engine own first level, seats every entitlement once, completes, runs on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T17:00:05.000Z'));
    try {
      const { db, state } = resume({});
      await state.resumeStage();
      const begin = db.rpc.find(([name]) => name === 'fn_begin_stage_resume')![1];
      expect(begin).toMatchObject({
        p_tournament_id: T,
        p_stage_no: 2,
        p_schedule_generation: 1,
        p_lease_generation: GEN,
        p_first_level: {
          index: 3,
          small_blind: 200,
          big_blind: 400,
          ante: 50,
          duration_ms: 1_200_000,
        },
      });
      expect(Object.keys(begin.p_first_level).sort()).toEqual([
        'ante',
        'big_blind',
        'duration_ms',
        'index',
        'small_blind',
      ]);
      const seats = db.rpc
        .filter(([name]) => name === 'fn_seat_stage_entitlement')
        .map(([, a]) => a);
      expect(seats.map((a) => a.p_entitlement_id).sort()).toEqual(
        ['e-horse-1', 'e-human-1', 'e-human-2'].sort()
      );
      for (const seat of seats) {
        expect(seat.p_resume_id).toBe(begin.p_resume_id);
        expect(seat.p_lease_generation).toBe(GEN);
      }
      // Two seats per table (table_size 2): two tables for three players, no chair twice.
      const chairs = seats.map((a) => `${a.p_table_id}#${a.p_seat_number}`);
      expect(new Set(chairs).size).toBe(3);
      expect(new Set(seats.map((a) => a.p_table_id)).size).toBe(2);
      expect(db.rpcNames().at(-1)).toBe('fn_complete_stage_resume');
      expect(state.resumeLifecycle).toHaveBeenCalledOnce();
      expect(state.stageResumeInProgress).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume begin committed with no seats (boundary 6): the successor adopts the receipt resume id', async () => {
    const { db, state } = resume({
      stages: stageRows('bagged', 'resuming'),
      begin: () => ({
        data: {
          ok: true,
          replay: true,
          completed: false,
          adopted: true,
          resume_id: 'resume-original',
        },
        error: null,
      }),
    });
    await state.resumeStage();
    const seats = db.rpc.filter(([name]) => name === 'fn_seat_stage_entitlement');
    expect(seats).toHaveLength(3);
    for (const [, args] of seats) expect(args.p_resume_id).toBe('resume-original');
    expect(db.rpc.find(([name]) => name === 'fn_complete_stage_resume')![1]).toEqual({
      p_tournament_id: T,
      p_resume_id: 'resume-original',
      p_lease_generation: GEN,
    });
    expect(state.resumeLifecycle).toHaveBeenCalledOnce();
  });

  it('partial seating (boundary 7): only the unseated are drawn, around the chairs already taken', async () => {
    const { db, state } = resume({
      stages: stageRows('bagged', 'resuming'),
      begin: () => ({
        data: { ok: true, replay: true, completed: false, resume_id: 'resume-original' },
        error: null,
      }),
      entitlements: [
        {
          id: 'e-human-1',
          user_id: 'human-1',
          stack: 40000,
          state: 'consumed',
          consumed_table_id: 'day2-t1',
          consumed_seat_number: 1,
        },
        { id: 'e-horse-1', user_id: 'horse-1', stack: 50000, state: 'active' },
        { id: 'e-human-2', user_id: 'human-2', stack: 30000, state: 'active' },
      ],
      tables: [
        { id: 'day2-t1', max_players: 2 },
        { id: 'day2-t2', max_players: 2 },
      ],
      liveSeats: [{ user_id: 'human-1', table_id: 'day2-t1', seat_number: 1 }],
    });
    await state.resumeStage();
    const seats = db.rpc.filter(([name]) => name === 'fn_seat_stage_entitlement').map(([, a]) => a);
    expect(seats.map((a) => a.p_entitlement_id).sort()).toEqual(['e-horse-1', 'e-human-2']);
    for (const seat of seats) {
      expect(`${seat.p_table_id}#${seat.p_seat_number}`).not.toBe('day2-t1#1');
    }
    expect(db.from.filter((q) => q.table === 'tables' && q.op === 'insert')).toHaveLength(0);
    expect(state.resumeLifecycle).toHaveBeenCalledOnce();
  });

  it('complete committed and response lost (boundary 9): stand down, then the successor runs on', async () => {
    const first = resume({
      stages: stageRows('bagged', 'resuming'),
      complete: () => ({ data: null, error: { message: 'fetch failed' } }),
    });
    await first.state.resumeStage();
    expect(first.state.running).toBe(false);
    expect(first.state.resumeLifecycle).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The successor reads the row the lost answer committed: RUNNING. No
    // begin, no seat, no complete - it simply continues as the running manager.
    const db = fakeDb({
      tables: { tournaments: () => ({ data: { ...baggedRow, status: 'RUNNING' }, error: null }) },
    });
    const successor = manager({ multiDayPlan: null, tournamentCache: null });
    successor.resumeLifecycle = vi.fn(async () => {});
    await successor.resumeStage();
    expect(db.rpc).toHaveLength(0);
    expect(successor.resumeLifecycle).toHaveBeenCalledOnce();
  });

  it('a completion that finds an entitlement unseated seats once more, then completes', async () => {
    let completes = 0;
    const { db, state } = resume({
      complete: () =>
        ++completes === 1
          ? { data: { ok: false, reason: 'unseated_entitlements', unseated: 1 }, error: null }
          : { data: { ok: true, players: 3 }, error: null },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T17:00:05.000Z'));
    try {
      await state.resumeStage();
    } finally {
      vi.useRealTimers();
    }
    expect(db.rpcNames().filter((n) => n === 'fn_complete_stage_resume')).toHaveLength(2);
    expect(state.resumeLifecycle).toHaveBeenCalledOnce();
  });

  it('a stage that is not due yet is left to its timer: nothing begins', async () => {
    const { db, state } = resume({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T16:00:00.000Z'));
    try {
      await state.resumeStage();
    } finally {
      vi.useRealTimers();
    }
    expect(db.rpcNames()).not.toContain('fn_begin_stage_resume');
    expect(state.running).toBe(false);
  });

  it('inside the freeze nothing begins; the thaw notification lets it through', async () => {
    const { db, state } = resume({ stages: stageRows('bagged', 'resuming') });
    setMaintenanceFrozen(true);
    const running = state.resumeStage();
    await flush();
    expect(db.rpcNames()).not.toContain('fn_begin_stage_resume');
    setMaintenanceFrozen(false);
    await running;
    expect(db.rpcNames()).toContain('fn_begin_stage_resume');
    expect(state.resumeLifecycle).toHaveBeenCalledOnce();
  });

  it('a stale schedule generation stands down without reporting a fault', async () => {
    const { db, state } = resume({
      stages: stageRows('bagged', 'resuming'),
      begin: () => ({ data: { ok: false, reason: 'schedule_generation_stale' }, error: null }),
    });
    await state.resumeStage();
    expect(db.rpcNames()).not.toContain('fn_seat_stage_entitlement');
    expect(state.running).toBe(false);
  });
});
