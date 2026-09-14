import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OperationMaintenanceRuntime,
  type OperationMaintenanceStore,
} from './OperationMaintenanceRuntime.js';
import { MaintenanceBreak, type MaintenanceBreakStore } from './MaintenanceBreak.js';
import {
  operationMaintenancePolicy as policy,
  type OperationMaintenanceState,
} from './operationPolicy.js';
import { setMaintenanceFrozen } from './freezeState.js';

const id = (n: number) => `a0000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const base = Date.parse('2026-09-11T12:34:00Z');
class Engine {
  paused = false;
  landed = true;
  pending = false;
  resumes = 0;
  pauseForMaintenance() {
    this.paused = true;
  }
  resumeFromMaintenance() {
    this.paused = false;
    this.resumes++;
  }
  isBetweenHands() {
    return this.landed;
  }
  isParkedBetweenHands() {
    return this.paused && this.landed;
  }
  isMaintenanceDrained() {
    return this.isParkedBetweenHands() && !this.pending;
  }
  isRunning() {
    return true;
  }
}
class Store implements OperationMaintenanceStore {
  op: OperationMaintenanceState | null = {
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
  listener = () => {};
  claims = 0;
  ready = 0;
  recovery: string[] = [];
  acknowledgments = 0;
  completed = 0;
  async loadOperation() {
    return {
      policyVersion: 2 as const,
      activationReceipt: id(5),
      observedAt: Date.now(),
      operation: this.op ? structuredClone({ ...this.op, observedAt: Date.now() }) : null,
    };
  }
  async claimOperation(s: OperationMaintenanceState, token: string) {
    expect(this.op?.ownershipToken).toBe(s.ownershipToken);
    this.claims++;
    this.op = { ...this.op!, ownershipToken: token, generation: this.op!.generation + 1 };
    return this.loadOperation();
  }
  watchOperations(changed: () => void) {
    this.listener = changed;
    return async () => {
      this.listener = () => {};
    };
  }
  async reportOperationReady(
    _s: OperationMaintenanceState,
    _ids: readonly string[],
    waves: readonly (readonly string[])[]
  ) {
    this.ready++;
    this.op = {
      ...this.op!,
      phase: 'ready',
      resumeWaves: waves.map((tableIds, index) => ({
        index,
        tableIds: [...tableIds],
        receiptId: null,
        creditedThroughAt: null,
        resumedAt: null,
      })),
    };
    this.listener();
  }
  async reportOperationRecovery(_s: OperationMaintenanceState, reason: string) {
    this.recovery.push(reason);
    this.op = {
      ...this.op!,
      phase: Date.now() >= this.op!.deadlineAt ? 'recovery_required' : 'recovering',
    };
    this.listener();
  }
  async releaseOperationWave(s: OperationMaintenanceState, index: number, ids: readonly string[]) {
    const receiptId = id(20 + index),
      creditedThroughAt = Date.now() + 10;
    this.op = {
      ...this.op!,
      phase: 'releasing',
      resumeWaves: this.op!.resumeWaves.map((w) =>
        w.index === index ? { ...w, receiptId, creditedThroughAt } : w
      ),
    };
    return {
      receiptId,
      intervalId: s.intervalId,
      ownershipToken: s.ownershipToken,
      tableIds: ids,
      creditedThroughAt,
    };
  }
  async acknowledgeOperationWave(
    _s: OperationMaintenanceState,
    index: number,
    _receipt: string,
    _ids: readonly string[],
    resumedAt: number
  ) {
    this.acknowledgments++;
    this.op = {
      ...this.op!,
      resumeWaves: this.op!.resumeWaves.map((w) => (w.index === index ? { ...w, resumedAt } : w)),
    };
  }
  async completeOperationResume() {
    this.completed++;
    this.op = {
      ...this.op!,
      phase: 'resumed',
      globalTail: {
        checkpointId: id(90),
        checkpointNo: 1,
        creditedThroughAt: Date.now(),
        remaining: 0,
        receiptId: id(91),
        receiptOwnershipToken: this.op!.ownershipToken,
        receiptGeneration: this.op!.generation,
        certifiedAt: Date.now() - 1,
        targetCount: 0,
        targetDigest: 'a'.repeat(64),
        status: 'released',
      },
    };
    this.listener();
    return this.op;
  }
}
const running: OperationMaintenanceRuntime[] = [];
function setup(store = new Store(), engines = new Map([[id(10), new Engine()]])) {
  const events: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const errors: unknown[] = [];
  const thaw = vi.fn(async (request: any) => ({
    ...request,
    creditedThroughAt: Date.now() + 10,
    effectiveFrozenSeconds: (Date.now() + 10 - request.freezeStartedAt) / 1000,
  }));
  const runtime = new OperationMaintenanceRuntime({
    store,
    engines: () => engines,
    emit: (id, payload) => events.push({ id, payload }),
    thaw,
    planWaves: (tables) => tables.map((table) => [table]),
    waveGapMs: 25,
    onActivated: () => {},
    report: (e) => errors.push(e),
    monotonicNow: () => Date.now(),
  });
  running.push(runtime);
  return { store, engines, events, errors, thaw, runtime };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(base);
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
  vi.useRealTimers();
  setMaintenanceFrozen(false);
});

describe('the actual operation runtime', () => {
  it('keeps a real hand and its pending settlement held beyond the notice, without forcing completion', async () => {
    const x = setup();
    const engine = [...x.engines.values()][0];
    engine.landed = false;
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(x.store.ready).toBe(0);
    expect(engine.resumes).toBe(0);
    engine.landed = true;
    engine.pending = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(x.store.ready).toBe(0);
    engine.pending = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(x.store.ready).toBe(1);
    expect(x.runtime.readyForRestart()).toBe(true);
  });
  it('does not release at the target or either deadline; recovery state remains owned', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(policy.plannedHoldMs + 10000);
    expect(x.thaw).not.toHaveBeenCalled();
    expect([...x.engines.values()][0].resumes).toBe(0);
    expect(x.store.recovery).toEqual(['recover', 'recovery_required']);
    expect(x.runtime.active()).toBe(true);
    expect(x.runtime.readyForRestart()).toBe(false);
  });
  it('adopts a16minute hold without resetting the absolute budget or discarding the row', async () => {
    vi.setSystemTime(base + 16 * 60000);
    const x = setup();
    await x.runtime.start();
    expect(x.store.claims).toBe(1);
    expect(x.store.op?.freezeStartedAt).toBe(base);
    await vi.advanceTimersByTimeAsync(4 * 60000);
    expect(x.store.recovery).toEqual(['recover']);
    expect(x.runtime.active()).toBe(true);
  });
  it('uses the persisted complete wave plan and exact clock receipts before notifying clients', async () => {
    const x = setup(
      new Store(),
      new Map([
        [id(10), new Engine()],
        [id(11), new Engine()],
      ])
    );
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(200);
    expect(x.store.completed).toBe(1);
    expect(x.store.acknowledgments).toBe(2);
    expect([...x.engines.values()].map((e) => e.resumes)).toEqual([1, 1]);
    expect(x.events.filter((e) => e.payload.type === 'MAINTENANCE_BREAK_ENDED')).toHaveLength(2);
    expect(x.runtime.active()).toBe(false);
    expect(x.errors).toEqual([]);
  });
  it('fences a superseded engine instead of stealing the token back', async () => {
    const x = setup();
    await x.runtime.start();
    x.store.op = { ...x.store.op!, ownershipToken: id(80), generation: 3 };
    await expect(x.runtime.refresh()).rejects.toThrow('maintenance_operation_ownership_lost');
    expect(x.store.claims).toBe(1);
    expect(x.runtime.readyForRestart()).toBe(false);
    expect([...x.engines.values()][0].resumes).toBe(0);
  });
  it('preserves an unsorted durable event wave for authorization, physical resume and acknowledgment', async () => {
    const x = setup(
      new Store(),
      new Map([
        [id(10), new Engine()],
        [id(11), new Engine()],
        [id(12), new Engine()],
      ])
    );
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    const groups = [[id(11), id(10)], [id(12)]];
    x.store.op = {
      ...x.store.op!,
      phase: 'release_authorized',
      releaseReceipt: id(7),
      resumeWaves: groups.map((tableIds, index) => ({
        index,
        tableIds,
        receiptId: null,
        creditedThroughAt: null,
        resumedAt: null,
      })),
    };
    const authorize = vi.spyOn(x.store, 'releaseOperationWave');
    const acknowledge = vi.spyOn(x.store, 'acknowledgeOperationWave');
    const physical: string[] = [];
    for (const [tableId, engine] of x.engines) {
      const resume = engine.resumeFromMaintenance.bind(engine);
      vi.spyOn(engine, 'resumeFromMaintenance').mockImplementation(() => {
        physical.push(tableId);
        resume();
      });
    }
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(200);
    expect(authorize.mock.calls.map((args) => args[2])).toEqual(groups);
    expect(acknowledge.mock.calls.map((args) => args[3])).toEqual(groups);
    expect(physical).toEqual(groups.flat());
    expect(x.store.completed).toBe(1);
    expect(x.errors).toEqual([]);
  });
  it('keeps the hold when thaw cannot prove its matching release', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    x.thaw.mockImplementationOnce(async (request: any) => ({
      ...request,
      ownershipToken: id(81),
      creditedThroughAt: Date.now(),
      effectiveFrozenSeconds: 120,
    }));
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(1);
    expect([...x.engines.values()][0].resumes).toBe(0);
    expect(x.store.recovery).toContain('thaw_or_wave_unproven');
  });
  it('joins shutdown while waiting for a future certified boundary', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    x.thaw.mockImplementationOnce(async (request: any) => ({
      ...request,
      creditedThroughAt: Date.now() + 60000,
      effectiveFrozenSeconds: 180,
    }));
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(1);
    await x.runtime.stop();
    await vi.advanceTimersByTimeAsync(70000);
    expect([...x.engines.values()][0].resumes).toBe(0);
    expect(x.store.completed).toBe(0);
  });
  it('waits past a fractional boundary and uses one integer endpoint for physical resume and SQL', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    const original = x.store.releaseOperationWave.bind(x.store);
    let boundary = 0;
    vi.spyOn(x.store, 'releaseOperationWave').mockImplementation(async (...args) => {
      const proof = await original(...args);
      boundary = Date.now() + 10.75;
      x.store.op = {
        ...x.store.op!,
        resumeWaves: x.store.op!.resumeWaves.map((w) => ({ ...w, creditedThroughAt: boundary })),
      };
      return { ...proof, creditedThroughAt: boundary };
    });
    const physical: number[] = [];
    const engine = [...x.engines.values()][0];
    vi.spyOn(engine, 'resumeFromMaintenance').mockImplementation(() => {
      physical.push(Date.now());
      engine.resumes++;
    });
    const acknowledge = vi.spyOn(x.store, 'acknowledgeOperationWave');
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(physical).toHaveLength(1);
    expect(physical[0]).toBeGreaterThanOrEqual(Math.ceil(boundary));
    expect(acknowledge.mock.calls[0][4]).toBe(physical[0]);
    expect(x.store.completed).toBe(1);
    expect(x.errors).toEqual([]);
  });
  it('retries a failed readiness write through the same owned state without a new notification', async () => {
    const x = setup();
    const ready = vi
      .spyOn(x.store, 'reportOperationReady')
      .mockRejectedValueOnce(new Error('connection lost'));
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(x.runtime.readyForRestart()).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(x.store.claims).toBe(1);
    expect(x.runtime.readyForRestart()).toBe(true);
  });
  it('does not resume after release authority is revoked while a certified boundary is pending', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    x.thaw.mockImplementationOnce(async (request: any) => ({
      ...request,
      creditedThroughAt: Date.now() + 60000,
      effectiveFrozenSeconds: 180,
    }));
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(1);
    x.store.op = { ...x.store.op!, phase: 'recovering' };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(60000);
    expect([...x.engines.values()][0].resumes).toBe(0);
    expect(x.runtime.active()).toBe(true);
  });
  it('does not repeat a physical wave after an uncertain acknowledgment', async () => {
    const x = setup();
    await x.runtime.start();
    await vi.advanceTimersByTimeAsync(120000);
    vi.spyOn(x.store, 'acknowledgeOperationWave').mockRejectedValue(
      new Error('lost acknowledgment')
    );
    x.store.op = { ...x.store.op!, phase: 'release_authorized', releaseReceipt: id(7) };
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    await x.runtime.refresh();
    await vi.advanceTimersByTimeAsync(10000);
    expect([...x.engines.values()][0].resumes).toBe(1);
    expect(x.events.filter((e) => e.payload.type === 'MAINTENANCE_BREAK_ENDED')).toHaveLength(0);
    expect(x.runtime.snapshot().releaseInDoubt).toBe(true);
    expect(x.store.completed).toBe(0);
  });
});

describe('MaintenanceBreak composes the activated runtime', () => {
  it.each(Array.from({ length: 60 }, (_, minute) => minute))(
    'no prepared operation produces no platform pause at minute%i',
    async (minute) => {
      vi.setSystemTime(Date.UTC(2026, 8, 11, 12, minute));
      const operation = new Store();
      operation.op = null;
      const load = vi.fn(async () => null);
      const store: MaintenanceBreakStore = {
        operation,
        load,
        save: async () => {},
        claim: async () => null,
        clear: async () => {},
        loadReleaseBoundary: async () => null,
      };
      const engine = new Engine();
      const legacy = new MaintenanceBreak({
        engines: () => new Map([[id(10), engine]]),
        store,
        emit: () => {},
        isRunning: () => true,
        thaw: async (request) => ({
          ...request,
          creditedThroughAt: Date.now(),
          effectiveFrozenSeconds: 1,
        }),
      });
      await legacy.start();
      await vi.advanceTimersByTimeAsync(61 * 60000);
      expect(load).not.toHaveBeenCalled();
      expect(legacy.isActive()).toBe(false);
      expect(engine.paused).toBe(false);
      await legacy.stop();
    }
  );
});
