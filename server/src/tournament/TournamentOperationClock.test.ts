import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperationMaintenanceRuntime,
  type OperationMaintenanceStore,
} from '../maintenance/OperationMaintenanceRuntime.js';
import { MaintenanceBreak } from '../maintenance/MaintenanceBreak.js';
import { setMaintenanceFrozen, isMaintenanceFrozen } from '../maintenance/freezeState.js';
import {
  operationMaintenancePolicy as policy,
  type OperationMaintenanceState,
} from '../maintenance/operationPolicy.js';
import type { OperationTournamentProof } from '../maintenance/OperationTournament.js';
let Base: (typeof import('./TournamentManagerBase.js'))['TournamentManagerBase'];
let supabase: (typeof import('../services/supabase.js'))['supabase'];
let hub: (typeof import('../transport/TableStateHub.js'))['tableStateHub'];
const id = (n: number) => `b1100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = id(10),
  A = id(11),
  B = id(12),
  base = Date.parse('2026-09-11T12:00:00Z');
const structure = [
  { smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
  { smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 10 },
];
const managers: any[] = [],
  runtimes: OperationMaintenanceRuntime[] = [];
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ TournamentManagerBase: Base } = await import('./TournamentManagerBase.js'));
  ({ supabase } = await import('../services/supabase.js'));
  ({ tableStateHub: hub } = await import('../transport/TableStateHub.js'));
}, 60000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(base);
  setMaintenanceFrozen(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(hub, 'emitEvent').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation((name) => {
    throw new Error(`Unexpected relation ${name}`);
  });
  vi.spyOn(supabase, 'rpc').mockImplementation((name) => {
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.fenceForServerShutdown();
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  setMaintenanceFrozen(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function operation(): OperationMaintenanceState {
  return {
    policyVersion: 2,
    operationId: id(1),
    releaseId: id(2),
    intervalId: id(3),
    ownershipToken: id(4),
    generation: 1,
    phase: 'last_hand',
    scope: { type: 'platform' },
    freezeStartedAt: base,
    targetAt: base + policy.normalTargetMs,
    forwardDeadlineAt: base + policy.forwardWorkMs,
    deadlineAt: base + policy.plannedHoldMs,
    observedAt: base,
    releaseReceipt: null,
    reason: 'Engine Maintenance',
    resumeWaves: [],
  };
}
function acknowledged(state = operation()): OperationMaintenanceState {
  return {
    ...state,
    phase: 'releasing',
    releaseReceipt: id(6),
    observedAt: Date.now(),
    resumeWaves: [
      {
        index: 0,
        tableIds: [A, B],
        receiptId: id(20),
        creditedThroughAt: Date.now(),
        resumedAt: Date.now(),
      },
    ],
  };
}
function proof(
  state: OperationMaintenanceState,
  overrides: Partial<OperationTournamentProof> = {}
): OperationTournamentProof {
  return {
    state,
    readback: async () => structuredClone(state),
    isCurrent: () => true,
    now: () => Date.now(),
    ...overrides,
  };
}
class Table {
  paused = false;
  resumes = 0;
  pauseForMaintenance() {
    this.paused = true;
  }
  resumeFromMaintenance() {
    this.paused = false;
    this.resumes++;
  }
  isBetweenHands() {
    return true;
  }
  isParkedBetweenHands() {
    return this.paused;
  }
  isMaintenanceDrained() {
    return this.paused;
  }
  isRunning() {
    return true;
  }
  maintenanceClockGroup() {
    return T;
  }
  pauseAfterHand = vi.fn();
  resumeDealing = vi.fn();
  holdDealingUntil = vi.fn();
  setHub = vi.fn();
  onHandComplete = vi.fn();
  fenceForEngineLeaseLoss = vi.fn();
}
function row(): Record<string, any> {
  return {
    id: T,
    status: 'RUNNING',
    tournament_type: 'mtt',
    current_level: 0,
    blind_structure: structure,
    level_started_at: new Date(base - 30_000).toISOString(),
    prize_pool: 100,
    prize_pool_finalized: true,
    on_break: false,
    break_started_at: null,
    break_ends_at: null,
    addon_period_triggered: false,
    add_on_available: false,
    addon_period_started_at: null,
    addon_period_ends_at: null,
    game_variant: 'nlh',
  };
}
function makeManager(
  r = row(),
  tables = new Map([
    [A, new Table()],
    [B, new Table()],
  ])
) {
  class Harness extends Base {
    readonly frames: Array<{ event: string; data: any }> = [];
    broadcastWait: Promise<void> | null = null;
    reprice = vi.fn(async () => true);
    override requestEliminationSweep = vi.fn(() => true);
    protected override startEliminationChecker() {}
    protected override recalculateEliminatedPrizes() {
      return this.reprice();
    }
    protected override createManagedTableEngine(tableId: string) {
      return tables.get(tableId) as never;
    }
    protected override startManagedTableEngine() {}
    protected override wireEliminationWake() {}
    protected override async restoreDrawnFirstButtons() {}
    protected override async broadcast(event: string, data: unknown) {
      this.frames.push({ event, data });
      if (this.broadcastWait) await this.broadcastWait;
      return true;
    }
    activate() {
      (this as any).lifecycleEpoch.begin();
      this.running = true;
      this.tournamentCache = structuredClone(r);
      this.currentLevel = r.current_level;
      this.blindTimerStartedAt = Date.parse(r.level_started_at);
      this.onBreak = r.on_break;
      this.prizePoolFinalized = r.prize_pool_finalized;
      this.addOnPeriodTriggered = r.addon_period_triggered;
      for (const [key, value] of tables) this.tableEngines.set(key, value as never);
    }
    arm() {
      this.startBlindTimer(structure, 570000);
    }
    advance() {
      return this.advanceBlindLevel(structure);
    }
    entry() {
      return this.reconcileTournamentEntryWindow('test.entry');
    }
    addons() {
      return this.tryTournamentAddOns();
    }
    startAddon() {
      return this.triggerAddOnPeriod();
    }
    closeAddon() {
      return this.finalizeAfterAddOn();
    }
    schedule(delay: number, cb: () => void) {
      return this.setLifecycleTimeout(cb, delay);
    }
    get clock() {
      return { timer: this.blindTimer, anchor: this.blindTimerStartedAt, level: this.currentLevel };
    }
  }
  const m = new Harness(T, { registerTableEngine: () => true } as never);
  managers.push(m);
  return m;
}
function transport(r: Record<string, any>) {
  const writes: Array<{ relation: string; patch: any; id: string }> = [];
  const rpc = vi.fn(async () => ({
    data: { ok: true, entry_closed: false, window_mode: 'levels' },
    error: null,
  }));
  vi.mocked(supabase.rpc).mockImplementation(rpc as never);
  const control = {
    readError: false,
    writeFailure: null as null | 'refused' | 'lost_response',
    beforeRead: async () => {},
    beforeWrite: async (_name: string, _patch: any) => {},
  };
  vi.mocked(supabase.from).mockImplementation((relation: string) => {
    if (!['tournaments', 'tables'].includes(relation))
      throw new Error(`Unexpected relation ${relation}`);
    let patch: any = null,
      key = T;
    const result = async () => {
      if (patch) {
        await control.beforeWrite(relation, patch);
        writes.push({ relation, patch: { ...patch }, id: key });
        if (control.writeFailure !== 'refused' && relation === 'tournaments')
          Object.assign(r, patch);
        return {
          error: control.writeFailure ? { message: control.writeFailure } : null,
          data: null,
        };
      }
      await control.beforeRead();
      return {
        error: control.readError ? { message: 'read unavailable' } : null,
        data: control.readError
          ? null
          : relation === 'tournaments'
            ? structuredClone(r)
            : [A, B].map((id) => ({
                id,
                ...structure[0],
                small_blind: 25,
                big_blind: 50,
                stakes: '25/50',
                first_button_seat: null,
              })),
      };
    };
    const q: any = {
      select: () => q,
      update: (value: any) => {
        patch = value;
        return q;
      },
      eq: (_column: string, value: string) => {
        key = value;
        return q;
      },
      in: () => q,
      maybeSingle: result,
      then: (ok: any, no: any) => result().then(ok, no),
    };
    return q;
  });
  return { writes, rpc, control };
}
class Store implements OperationMaintenanceStore {
  op = operation();
  listener = () => {};
  ready = 0;
  acks = 0;
  recoveries = 0;
  ackWait: Promise<void> | null = null;
  globalWait = false;
  constructor(readonly row: Record<string, any>) {}
  async loadOperation() {
    return {
      policyVersion: 2 as const,
      activationReceipt: id(5),
      observedAt: Date.now(),
      operation: structuredClone({ ...this.op, observedAt: Date.now() }),
    };
  }
  async claimOperation(_s: OperationMaintenanceState, token: string) {
    this.op.ownershipToken = token;
    this.op.generation++;
    return this.loadOperation();
  }
  watchOperations(changed: () => void) {
    this.listener = changed;
    return async () => {};
  }
  async reportOperationReady(
    _s: OperationMaintenanceState,
    _ids: readonly string[],
    waves: readonly (readonly string[])[]
  ) {
    this.ready++;
    this.op.phase = 'ready';
    this.op.resumeWaves = waves.map((tableIds, index) => ({
      index,
      tableIds,
      receiptId: null,
      creditedThroughAt: null,
      resumedAt: null,
    }));
    this.listener();
  }
  async reportOperationRecovery() {
    this.recoveries++;
    this.op.phase = 'recovering';
    this.listener();
  }
  async releaseOperationWave(
    s: OperationMaintenanceState,
    index: number,
    tableIds: readonly string[]
  ) {
    this.op.phase = 'releasing';
    const w = this.op.resumeWaves[index];
    w.receiptId = id(20);
    w.creditedThroughAt = Date.now() + 20;
    return {
      receiptId: w.receiptId,
      intervalId: s.intervalId,
      ownershipToken: s.ownershipToken,
      tableIds,
      creditedThroughAt: w.creditedThroughAt,
    };
  }
  async acknowledgeOperationWave(
    _s: OperationMaintenanceState,
    index: number,
    _receipt: string,
    _ids: readonly string[],
    resumedAt: number
  ) {
    this.acks++;
    if (this.ackWait) await this.ackWait;
    this.op.resumeWaves[index].resumedAt = resumedAt;
    this.row.level_started_at = new Date(resumedAt - 30000).toISOString();
  }
  async completeOperationResume() {
    this.op.observedAt = Date.now();
    if (this.globalWait)
      this.op.globalTail = {
        checkpointId: id(40),
        checkpointNo: 1,
        creditedThroughAt: Date.now(),
        remaining: 1,
        receiptId: null,
        receiptOwnershipToken: null,
        receiptGeneration: null,
        certifiedAt: null,
        targetCount: null,
        targetDigest: null,
        status: 'pending',
      };
    else {
      this.op.phase = 'resumed';
      this.op.globalTail = {
        checkpointId: id(40),
        checkpointNo: 1,
        creditedThroughAt: Date.now(),
        remaining: 0,
        receiptId: id(41),
        receiptOwnershipToken: this.op.ownershipToken,
        receiptGeneration: this.op.generation,
        certifiedAt: Date.now() - 1,
        targetCount: 1,
        targetDigest: 'a'.repeat(64),
        status: 'released',
      };
    }
    return structuredClone(this.op);
  }
}
function runtime(m: ReturnType<typeof makeManager>, store: Store, tables: Map<string, Table>) {
  const events: any[] = [],
    errors: unknown[] = [];
  const r = new OperationMaintenanceRuntime({
    store,
    engines: () => tables,
    tournaments: () => [m],
    emit: (id, payload) => events.push({ id, payload }),
    thaw: async (request) => ({
      ...request,
      creditedThroughAt: Date.now() + 10,
      effectiveFrozenSeconds: (Date.now() + 10 - base) / 1000,
    }),
    planWaves: MaintenanceBreak.planOperationResumeWaves,
    waveGapMs: 25,
    onActivated: () => {},
    report: (error) => errors.push(error),
    monotonicNow: () => Date.now(),
  });
  runtimes.push(r);
  return { r, events, errors };
}
describe('actual tournament manager operation clock', () => {
  it('holds an on_break=false clock for16minutes without writes or disabling lease/recovery callbacks', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    m.arm();
    await flush();
    const before = db.writes.length,
      anchor = r.level_started_at;
    m.adoptOperationMaintenance(operation());
    const callback = vi.fn();
    m.schedule(5000, callback);
    await vi.advanceTimersByTimeAsync(16 * 60000);
    expect(callback).toHaveBeenCalledOnce();
    expect(m.clock.level).toBe(0);
    expect(m.isOnBreak()).toBe(false);
    expect(m.clock.timer).toBeNull();
    expect(r.level_started_at).toBe(anchor);
    expect(db.writes).toHaveLength(before);
    expect(m.operationMaintenanceDrain()).toEqual({ ready: true, pending: [], failed: [] });
  });
  it('drains every accepted table/level write and never rearms after freeze during an await', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    const gate = deferred();
    db.control.beforeWrite = async (name) => {
      if (name === 'tables') await gate.promise;
    };
    const transition = m.advance();
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('blind_transition');
    await vi.advanceTimersByTimeAsync(20000);
    gate.resolve();
    await transition;
    expect(db.writes.filter((w) => w.relation === 'tables')).toHaveLength(2);
    expect(r.current_level).toBe(1);
    expect(r.level_started_at).toBe(new Date(base).toISOString());
    expect(m.clock.timer).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(m.operationMaintenanceDrain().ready).toBe(true);
  });
  it('drains an in-flight level broadcast without a late rearm', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    const gate = deferred();
    m.broadcastWait = gate.promise;
    const work = m.advance();
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().ready).toBe(false);
    gate.resolve();
    await work;
    expect(m.clock.timer).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('gates entry close/reprice and addon admission until global release', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    const gate = deferred<any>();
    db.rpc.mockImplementationOnce(() => gate.promise);
    const work = m.entry();
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('entry_close_reprice');
    gate.resolve({
      data: {
        ok: true,
        entry_closed: true,
        finalized: true,
        prize_pool: 100,
        payout_structure: [],
        reprice_pending: true,
      },
      error: null,
    });
    expect(await work).toBe(false);
    expect(m.reprice).not.toHaveBeenCalled();
    await m.entry();
    await m.startAddon();
    await m.closeAddon();
    await m.addons();
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(m.operationMaintenanceDrain().ready).toBe(true);
  });
  it('adopts shifted anchor afterACK without writes or extra duration despite delayed readback', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    m.adoptOperationMaintenance(operation());
    vi.setSystemTime(base + 960000);
    const state = acknowledged();
    r.level_started_at = new Date(Date.now() - 30000).toISOString();
    const gate = deferred();
    db.control.beforeRead = () => gate.promise;
    const job = m.resumeOperationClock(proof(state));
    await flush();
    await vi.advanceTimersByTimeAsync(90000);
    gate.resolve();
    await job;
    expect(db.writes).toEqual([]);
    expect(m.clock.anchor).toBe(base + 930000);
    await vi.advanceTimersByTimeAsync(479999);
    expect(m.clock.level).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.clock.level).toBe(1);
  });
  it.each(['unacknowledged', 'read failure', 'owner change', 'stopped', 'split event'])(
    'keeps held after%s',
    async (fault) => {
      const r = row(),
        db = transport(r),
        m = makeManager(r);
      m.activate();
      m.adoptOperationMaintenance(operation());
      vi.setSystemTime(base + 10000);
      const state = acknowledged();
      if (fault === 'unacknowledged') state.resumeWaves[0].resumedAt = null;
      if (fault === 'read failure') db.control.readError = true;
      if (fault === 'split event') state.resumeWaves[0].tableIds = [A];
      const p = proof(state, {
        readback: async () => {
          if (fault === 'stopped') m.fenceForServerShutdown();
          return fault === 'owner change' ? { ...state, ownershipToken: id(999) } : state;
        },
      });
      await expect(m.resumeOperationClock(p)).rejects.toThrow();
      expect(m.clock.timer).toBeNull();
      expect(db.writes).toEqual([]);
    }
  );
  it('actual resume adopts operation before database rows and timer restoration', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.adoptOperationMaintenance(operation());
    await m.resume();
    expect(m.isRunning()).toBe(true);
    expect(m.getTableIds()).toEqual([A, B]);
    expect(m.clock.timer).toBeNull();
    expect(db.writes).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('a delayed advertised-start callback cannot arm under a newer hold', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    m.schedule(5000, () => m.arm());
    m.adoptOperationMaintenance(operation());
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.clock.timer).toBeNull();
    expect(db.writes).toEqual([]);
  });
});
describe('actual runtime plus manager', () => {
  it('waits for named drain, ACK and strict clock readback before ended frames; global work releases once later', async () => {
    const data = row(),
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables);
    m.activate();
    const pending = deferred();
    db.control.beforeWrite = async () => pending.promise;
    const advancing = m.advance();
    await flush();
    const store = new Store(data);
    store.globalWait = true;
    const x = runtime(m, store, tables);
    await x.r.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(store.ready).toBe(0);
    pending.resolve();
    await advancing;
    db.control.beforeWrite = async () => {};
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.ready).toBe(1);
    const ack = deferred();
    store.ackWait = ack.promise;
    store.op.phase = 'release_authorized';
    store.op.releaseReceipt = id(6);
    store.listener();
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(tables.get(A)!.resumes).toBe(1);
    expect(store.acks).toBe(1);
    expect(m.clock.timer).toBeNull();
    expect(x.events.filter((e) => e.payload.type === 'MAINTENANCE_BREAK_ENDED')).toEqual([]);
    ack.resolve();
    await flush();
    expect(m.clock.timer).not.toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(x.events.filter((e) => e.payload.type === 'MAINTENANCE_BREAK_ENDED')).toHaveLength(2);
    expect(isMaintenanceFrozen()).toBe(true);
    store.globalWait = false;
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(x.errors).toEqual([]);
    expect(x.r.snapshot()).toMatchObject({ operation: { phase: 'resumed' } });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(m.requestEliminationSweep).toHaveBeenCalledWith('operation_global_release');
    await x.r.refresh();
    await flush();
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(x.errors).toEqual([]);
  });
  it('reconnect consumes alreadyACKed wave without replaying physical dealer resume', async () => {
    const data = row(),
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables);
    m.activate();
    const store = new Store(data);
    store.op = acknowledged();
    store.globalWait = true;
    const x = runtime(m, store, tables);
    await x.r.start();
    await flush();
    expect(m.clock.timer).not.toBeNull();
    expect(tables.get(A)!.resumes).toBe(0);
    expect(db.writes).toEqual([]);
  });
});

function certified(
  state: OperationMaintenanceState,
  boundary = Date.now()
): OperationMaintenanceState {
  return {
    ...state,
    globalTail: {
      checkpointId: id(70),
      checkpointNo: 1,
      creditedThroughAt: boundary,
      remaining: 0,
      receiptId: id(71),
      receiptOwnershipToken: state.ownershipToken,
      receiptGeneration: state.generation,
      certifiedAt: boundary - 1,
      targetCount: 1,
      targetDigest: 'c'.repeat(64),
      status: 'certified',
    },
  };
}
describe('global add-on opportunity and independent own-break clocks', () => {
  it('never announces or arms an old addon deadline during the hold and resumes only the committed global endpoint', async () => {
    const r = row();
    Object.assign(r, {
      addon_period_triggered: true,
      add_on_available: true,
      prize_pool_finalized: false,
      addon_period_started_at: new Date(base - 60000).toISOString(),
      addon_period_ends_at: new Date(base + 30000).toISOString(),
    });
    const db = transport(r),
      m = makeManager(r);
    m.activate();
    m.adoptOperationMaintenance(operation());
    setMaintenanceFrozen(true);
    await m.resyncAddOnPeriodAfterMaintenanceThaw();
    await vi.advanceTimersByTimeAsync(960000);
    expect(m.frames).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    const wave = acknowledged();
    r.level_started_at = new Date(Date.now() - 30000).toISOString();
    await m.resumeOperationClock(proof(wave));
    await expect(m.resumeOperationGlobal(proof(wave))).rejects.toThrow('global_release_unproven');
    r.addon_period_ends_at = new Date(Date.now() + 90000).toISOString();
    const final = certified(wave);
    setMaintenanceFrozen(false);
    db.control.readError = true;
    await expect(m.resumeOperationGlobal(proof(final))).rejects.toThrow('addon_anchor_unreadable');
    expect(m.frames).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    db.control.readError = false;
    await m.resumeOperationGlobal(proof(final));
    const starts = m.frames.filter((f) => f.event === 'ADDON_PERIOD_START');
    expect(starts).toHaveLength(1);
    expect(starts[0].data).toMatchObject({ endsAt: r.addon_period_ends_at, durationSeconds: 90 });
    await m.resumeOperationGlobal(proof(final));
    expect(m.frames.filter((f) => f.event === 'ADDON_PERIOD_START')).toHaveLength(1);
    expect(db.writes).toEqual([]);
  });
  it('does not arm financial work one fraction before the global boundary, including a retained prior-generation certificate', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    m.adoptOperationMaintenance(operation());
    const wave = acknowledged(),
      final = certified(wave, Date.now() + 1);
    await m.resumeOperationClock(proof(wave));
    await expect(m.resumeOperationGlobal(proof(final))).rejects.toThrow('global_release_unproven');
    expect(db.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const successor = { ...final, generation: final.generation + 1 };
    m.adoptOperationMaintenance(successor);
    await m.resumeOperationClock(proof(successor));
    await m.resumeOperationGlobal(proof(successor));
    expect(db.rpc).toHaveBeenCalledOnce();
  });
  it('does not let a stopped lifecycle complete a global readback or offer addon chips', async () => {
    const r = row(),
      db = transport(r),
      m = makeManager(r);
    m.activate();
    m.adoptOperationMaintenance(operation());
    const final = certified(acknowledged());
    await m.resumeOperationClock(proof(final));
    const gate = deferred();
    db.control.beforeRead = () => gate.promise;
    const job = m.resumeOperationGlobal(proof(final));
    await flush();
    m.fenceForServerShutdown();
    gate.resolve();
    await expect(job).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(m.frames).toEqual([]);
  });
  it('leaves a separate synchronized break paused through waveACK, then resumes that break once after global proof', async () => {
    const r = row();
    r.on_break = true;
    const db = transport(r),
      m = makeManager(r);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    m.adoptOperationMaintenance(operation());
    await m.resumeFromBreak();
    const wave = acknowledged();
    await m.resumeOperationClock(proof(wave));
    expect(m.isOnBreak()).toBe(true);
    expect(m.clock.timer).toBeNull();
    expect(db.writes).toEqual([]);
    await m.resumeOperationGlobal(proof(certified(wave)));
    expect(m.isOnBreak()).toBe(false);
    expect(m.clock.timer).not.toBeNull();
    expect(m.frames.filter((f) => f.event === 'break_ended')).toHaveLength(1);
    const anchors = db.writes.filter((w) => 'level_started_at' in w.patch);
    expect(anchors).toHaveLength(1); // The independent own-break resumer is the only writer.
  });
});

describe('accepted own-break work composes with operation adoption', () => {
  it('rejects a new synchronized break after operation adoption without setting on_break', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data);
    m.activate();
    m.adoptOperationMaintenance(operation());
    await m.pauseForBreak(300000);
    expect(m.isOnBreak()).toBe(false);
    expect(db.writes).toEqual([]);
    expect(m.frames).toEqual([]);
  });
  it('rechecks an operation adopted while own-break eligibility is being read', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    (m as any).tournamentCache = null;
    db.control.beforeRead = () => gate.promise;
    const job = m.pauseForBreak(300000);
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('own_break_admission');
    gate.resolve();
    await job;
    expect(db.writes).toEqual([]);
    expect(m.isOnBreak()).toBe(false);
    expect(m.operationMaintenanceDrain().ready).toBe(true);
  });
  it('drains a previously accepted own-break flag before readiness can snapshot SQL targets', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    db.control.beforeWrite = () => gate.promise;
    const job = m.pauseForBreak(300000);
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('own_break_admission');
    expect(data.on_break).toBe(false);
    gate.resolve();
    await job;
    expect(data.on_break).toBe(true);
    expect(m.operationMaintenanceDrain().ready).toBe(true);
    expect(m.clock.timer).toBeNull();
  });
  it('atomically clears an own break with its resumed anchor before operation readiness, then adopts only the SQL credited anchor', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.beforeWrite = () => gate.promise;
    const job = m.resumeFromBreak();
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('own_break_resume');
    expect(m.isOnBreak()).toBe(true);
    expect(m.frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000);
    gate.resolve();
    await job;
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].patch).toEqual({
      on_break: false,
      break_ends_at: null,
      level_started_at: new Date(base - 480000).toISOString(),
    });
    expect(m.frames).toEqual([]);
    expect(m.clock.timer).toBeNull();
    expect(m.operationMaintenanceDrain().ready).toBe(true);
    // SQL credits this exact baseline; the manager must not persist it again.
    data.level_started_at = new Date(base - 450000).toISOString();
    await m.resumeOperationClock(proof(acknowledged()));
    expect(db.writes).toHaveLength(1);
    expect(m.clock.anchor).toBe(base - 450000);
    expect(m.frames.filter((f) => f.event === 'break_ended')).toHaveLength(1);
  });
  it('a refused atomic write and unavailable readback retain ownership without an end frame or new level', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'refused';
    db.control.readError = true;
    await expect(m.resumeFromBreak()).rejects.toThrow('refused');
    expect(m.isOnBreak()).toBe(true);
    expect(m.clock.timer).toBeNull();
    expect(m.frames).toEqual([]);
    expect(data.on_break).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    db.control.writeFailure = null;
    db.control.readError = false;
    await m.resumeFromBreak();
    expect(m.isOnBreak()).toBe(false);
    expect(db.writes[1].patch).toEqual(db.writes[0].patch);
    expect(m.clock.anchor).toBe(base - 480000);
    await vi.advanceTimersByTimeAsync(89999);
    expect(m.clock.level).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.clock.level).toBe(1);
    expect(m.frames.filter((f) => f.event === 'break_ended')).toHaveLength(1);
  });
  it('accepts an exact lost commit response by readback and consumes latency without another anchor write', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    // A monotonic DB clock may have a fractional millisecond. Persist/readback
    // compares the exact integer represented by timestamptz ISO serialization.
    (m as any).operationClockNow = () => Date.now() + 0.25;
    db.control.writeFailure = 'lost_response';
    db.control.beforeRead = () => gate.promise;
    const first = m.resumeFromBreak(),
      duplicate = m.resumeFromBreak();
    await flush();
    expect(data.on_break).toBe(false);
    expect(m.isOnBreak()).toBe(true);
    expect(m.frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000);
    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(db.writes).toHaveLength(1);
    expect(m.clock.anchor).toBe(base - 480000);
    expect(m.frames.filter((f) => f.event === 'break_ended')).toHaveLength(1);
    db.control.writeFailure = null;
    await vi.advanceTimersByTimeAsync(90000);
    expect(m.clock.level).toBe(1);
  });
  it('does not accept a changed level or anchor as proof of an ambiguous own-break clear', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'lost_response';
    db.control.beforeRead = async () => {
      data.level_started_at = new Date(base).toISOString();
    };
    await expect(m.resumeFromBreak()).rejects.toThrow('lost_response');
    expect(m.isOnBreak()).toBe(true);
    expect(m.frames).toEqual([]);
    expect(m.clock.timer).toBeNull();
  });
  it('does not clear local ownership if the exact lost-response readback crosses shutdown', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'lost_response';
    db.control.beforeRead = () => gate.promise;
    const job = m.resumeFromBreak();
    await flush();
    m.fenceForServerShutdown();
    gate.resolve();
    await job;
    expect(m.isOnBreak()).toBe(true);
    expect(m.frames).toEqual([]);
    expect(m.clock.timer).toBeNull();
  });
  it('retries a failed deferred own-break resume after the global certificate without dropping the remaining work', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    m.adoptOperationMaintenance(operation());
    await m.resumeFromBreak();
    const final = certified(acknowledged());
    await m.resumeOperationClock(proof(final));
    db.control.writeFailure = 'refused';
    await expect(m.resumeOperationGlobal(proof(final))).rejects.toThrow('refused');
    expect(m.isOnBreak()).toBe(true);
    expect(m.requestEliminationSweep).not.toHaveBeenCalled();
    db.control.writeFailure = null;
    await m.resumeOperationGlobal(proof(final));
    await m.resumeOperationGlobal(proof(final));
    expect(m.isOnBreak()).toBe(false);
    expect(m.frames.filter((f) => f.event === 'break_ended')).toHaveLength(1);
    expect(m.requestEliminationSweep).toHaveBeenCalledOnce();
    expect(m.operationMaintenanceDrain().failed).toEqual([]);
  });
  it('retains a newer global-certificate wake while an older ACK row read is pending', async () => {
    const data = row(),
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables),
      gate = deferred();
    m.activate();
    const store = new Store(data);
    store.op = acknowledged();
    store.globalWait = true;
    db.control.beforeRead = () => gate.promise;
    const x = runtime(m, store, tables);
    await x.r.start();
    await flush();
    expect(m.clock.timer).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    store.op = { ...certified(store.op), phase: 'resumed' };
    store.op.globalTail!.status = 'released';
    await x.r.refresh();
    gate.resolve();
    await flush();
    expect(m.clock.timer).not.toBeNull();
    expect(m.requestEliminationSweep).toHaveBeenCalledWith('operation_global_release');
    expect(db.rpc).toHaveBeenCalledOnce();
    expect(x.errors).toEqual([]);
  });
});

describe('completed and superseded operation identity', () => {
  it('does not apply a historical completed interval to a newly admitted tournament', async () => {
    const data = row(),
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables);
    m.activate();
    await vi.advanceTimersByTimeAsync(1);
    const store = new Store(data);
    store.op = { ...certified(acknowledged()), phase: 'resumed' };
    store.op.globalTail!.status = 'released';
    const x = runtime(m, store, tables);
    await x.r.start();
    x.r.adoptTournament(m);
    await x.r.reconcileTournament(m);
    m.arm();
    await flush();
    expect(m.clock.timer).not.toBeNull();
    expect(m.requestEliminationSweep).not.toHaveBeenCalled();
    expect(x.errors).toEqual([]);
    expect(db.writes).toHaveLength(1); // Normal admission, no active hold exists.
  });
  it('refuses a changed generation during strict clock readback even if the owner token is unchanged', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data);
    m.activate();
    m.adoptOperationMaintenance(operation());
    const state = acknowledged();
    await expect(
      m.resumeOperationClock(
        proof(state, { readback: async () => ({ ...state, generation: state.generation + 1 }) })
      )
    ).rejects.toThrow('owner_changed');
    expect(m.clock.timer).toBeNull();
    expect(db.writes).toEqual([]);
  });
});

describe('exact target and accepted countdown drain', () => {
  it('waits for an already accepted own-break countdown write before reporting readiness', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data),
      gate = deferred();
    m.activate();
    db.control.beforeWrite = () => gate.promise;
    const job = m.beginBreakCountdown(300000);
    await flush();
    m.adoptOperationMaintenance(operation());
    expect(m.operationMaintenanceDrain().pending).toContain('own_break_countdown');
    gate.resolve();
    await job;
    expect(m.operationMaintenanceDrain().ready).toBe(true);
  });
  it('does not accept a changed wave credit target under the same receipt during readback', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data);
    m.activate();
    m.adoptOperationMaintenance(operation());
    const state = acknowledged(),
      changed = structuredClone(state);
    changed.resumeWaves[0].creditedThroughAt!--;
    await expect(
      m.resumeOperationClock(proof(state, { readback: async () => changed }))
    ).rejects.toThrow('wave_not_acknowledged');
    expect(m.clock.timer).toBeNull();
    expect(db.writes).toEqual([]);
  });
  it('a broken dealer resume hook cannot strand the remaining own-break timers or dealers', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    tables.get(A)!.resumeDealing.mockImplementation(() => {
      throw new Error('native dealer fixture failure');
    });
    await m.resumeFromBreak();
    expect(tables.get(B)!.resumeDealing).toHaveBeenCalledOnce();
    expect(m.clock.timer).not.toBeNull();
    expect(db.writes).toHaveLength(1);
  });
});

describe('installed TEXT blind structures', () => {
  it('parses the durable text without rewriting the anchor', async () => {
    const data = row(),
      db = transport(data),
      m = makeManager(data);
    m.activate();
    m.adoptOperationMaintenance(operation());
    data.blind_structure = JSON.stringify(structure);
    await m.resumeOperationClock(proof(acknowledged()));
    expect(m.clock.timer).not.toBeNull();
    expect(db.writes).toEqual([]);
    expect((m as any).tournamentCache.blind_structure).toEqual(structure);
  });
  it.each(['not json', '{}', 'null', '[]'])(
    'retains the hold for invalid durable text %s',
    async (raw) => {
      const data = row(),
        db = transport(data),
        m = makeManager(data);
      m.activate();
      m.adoptOperationMaintenance(operation());
      data.blind_structure = raw;
      await expect(m.resumeOperationClock(proof(acknowledged()))).rejects.toThrow(
        'anchor_unreadable'
      );
      expect(m.clock.timer).toBeNull();
      expect(db.writes).toEqual([]);
    }
  );
});

describe('owned read-only resolution before readiness', () => {
  it('resolves a committed but lost own-break response during the existing readiness retry without another write or end frame', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      tables = new Map([
        [A, new Table()],
        [B, new Table()],
      ]),
      m = makeManager(data, tables);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'lost_response';
    db.control.readError = true;
    await expect(m.resumeFromBreak()).rejects.toThrow('lost_response');
    expect(m.isOnBreak()).toBe(true);
    expect(data.on_break).toBe(false);
    const store = new Store(data),
      x = runtime(m, store, tables);
    await x.r.start();
    db.control.readError = false;
    await vi.advanceTimersByTimeAsync(policy.lastHandNoticeMs);
    await flush();
    expect(store.ready).toBe(1);
    expect(db.writes).toHaveLength(1);
    expect(m.isOnBreak()).toBe(false);
    expect(m.clock.timer).toBeNull();
    expect(m.frames).toEqual([]);
    expect(m.operationMaintenanceDrain()).toMatchObject({ ready: true, failed: [] });
    expect(x.errors).toEqual([]);
  });
  it('does not turn an uncommitted intent into a write, an end frame or readiness', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'refused';
    await expect(m.resumeFromBreak()).rejects.toThrow('refused');
    const state = operation();
    m.adoptOperationMaintenance(state);
    await expect(m.reconcileOperationHold(proof(state))).rejects.toThrow('readback_unresolved');
    expect(db.writes).toHaveLength(1);
    expect(m.frames).toEqual([]);
    expect(m.isOnBreak()).toBe(true);
    expect(m.operationMaintenanceDrain().ready).toBe(false);
  });
  it('cannot resolve the intent after the operation is revoked during row readback', async () => {
    const data: Record<string, any> = { ...row(), on_break: true },
      db = transport(data),
      m = makeManager(data);
    m.activate();
    (m as any).savedBlindTimerRemaining = 120000;
    db.control.writeFailure = 'lost_response';
    db.control.readError = true;
    await expect(m.resumeFromBreak()).rejects.toThrow('lost_response');
    const state = operation();
    m.adoptOperationMaintenance(state);
    db.control.readError = false;
    await expect(
      m.reconcileOperationHold(
        proof(state, { readback: async () => ({ ...state, phase: 'recovering' }) })
      )
    ).rejects.toThrow('readback_unowned');
    expect(db.writes).toHaveLength(1);
    expect(m.frames).toEqual([]);
    expect(m.isOnBreak()).toBe(true);
  });
});
