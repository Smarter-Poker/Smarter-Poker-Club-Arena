import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { tournamentEliminationScheduler } from './TournamentEliminationScheduler.js';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
class Harness extends TournamentManagerBase {
  protected startEliminationChecker() {}
  protected async recalculateEliminatedPrizes() {
    return true;
  }
  protected async resolveTournamentSeatMoveQuarantine() {
    return true;
  }
}
function manager(): any {
  return new Harness(
    id(1),
    { unregisterTournamentTableEngine: vi.fn() } as any,
    id(2),
    performance.now() + 20_000
  );
}
function original(n: number, stop = () => Promise.resolve()) {
  return {
    getLifecycleDiagnosticSnapshot: vi.fn(() =>
      Object.freeze({ instanceId: id(n), tableId: id(n) })
    ),
    stop: vi.fn(stop),
    hasReleasedProcessOwnership: () => true,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('manager lifecycle diagnostics on the selected non-F06 base', () => {
  it.each([34, 36, 37, 45])(
    'selects exact live tables and retains bounded originals for %i engines',
    async (count) => {
      const value = manager(),
        engines = [];
      for (let i = 0; i < count; i++) {
        const engine = original(100 + i);
        engines.push(engine);
        value.tableEngines.set(id(100 + i), engine);
      }
      const first = value.getLifecycleDiagnosticSnapshot();
      expect(first.originals).toHaveLength(8);
      expect(first).toMatchObject({
        originalsCount: count,
        originalsReturned: 8,
        originalsOmitted: count - 8,
      });
      const last = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(99 + count)] });
      expect(last.originals[0].engine.instanceId).toBe(id(99 + count));
      expect(last.originals[0]).toMatchObject({
        session: null,
        sessionCoverage: 'unavailable_on_selected_base',
      });
      await value.stop();
      expect(engines.every((engine) => engine.stop.mock.calls.length === 2)).toBe(true);
      value.tableEngines.set(id(132), original(999));
      const retained = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100), id(132)] });
      expect(retained).toMatchObject({
        originalSelection: 'retained-stop',
        originalsCount: count,
        retainedOriginalCount: 32,
      });
      expect(retained.originals[0].engine.instanceId).toBe(id(100));
      expect(retained.originals[1]).toMatchObject({ availability: 'unavailable', engine: null });
      expect(retained.selectionMissingCount).toBe(1);
    }
  );

  it('an empty stop snapshot never substitutes engines added later', async () => {
    const value = manager();
    await value.stop();
    value.tableEngines.set(id(100), original(100));
    const result = value.getLifecycleDiagnosticSnapshot({ tableIds: [id(100)] });
    expect(result).toMatchObject({
      originalSelection: 'retained-stop',
      originalsCount: 0,
      retainedOriginalCount: 0,
    });
    expect(result.originals[0].engine).toBeNull();
  });

  it('does not call lease/authority checks during observation and retains exact pending stop', async () => {
    const value = manager();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.tableEngines.set(
      id(100),
      original(100, () => pending)
    );
    const stopping = value.stop();
    const authority = vi.spyOn(value, 'getTournamentLeaseGeneration').mockImplementation(() => {
      throw new Error('must not inspect authority');
    });
    const snapshot = value.getLifecycleDiagnosticSnapshot();
    expect(snapshot.stopPending).toBe(true);
    expect(snapshot.records.map((row: any) => row.event)).toEqual(['stop_initiated']);
    expect(authority).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(value.getLifecycleDiagnosticSnapshot().records.map((row: any) => row.event)).toEqual([
      'stop_initiated',
      'owned_work_joined',
      'stop_completed',
    ]);
  });

  it('binds the same physical promise UUID and preserves its original rejection despite diagnostic failure', async () => {
    const value = manager();
    value.lifecycleIsCurrent = vi.fn(() => true);
    let registration: any;
    vi.spyOn(tournamentEliminationScheduler, 'register').mockImplementation((input) => {
      registration = input;
      return () => {};
    });
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    value.registerEliminationScheduler(() => pending);
    const physical = registration.run(new AbortController().signal);
    const operationId = registration.diagnostics.operationIdFor(physical);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(value.getLifecycleDiagnosticSnapshot().schedulerRecent).toEqual([{ operationId }]);
    const authorityCalls = value.lifecycleIsCurrent.mock.calls.length;
    value.getLifecycleDiagnosticSnapshot();
    expect(value.lifecycleIsCurrent.mock.calls.length).toBe(authorityCalls);
    vi.spyOn(value.managerLifecycleDiagnostics, 'record').mockImplementation(() => {
      throw new Error('diagnostic only');
    });
    const failure = new Error('actual sweep failure');
    const rejected = expect(physical).rejects.toBe(failure);
    reject(failure);
    await rejected;
    expect(value.getLifecycleDiagnosticSnapshot()).toMatchObject({
      schedulerPendingCount: 0,
      diagnosticWriteFailures: 1,
    });
    await value.stop();
  });

  it('retains richer release evidence and rejects oversized, duplicate and malformed table selection', async () => {
    const value = manager();
    const observe = value.captureLeaseReleaseDiagnosticObserver(id(1), id(2));
    observe({ status: 'confirmed', attempts: 1, releasedCount: 0 });
    expect(value.getLifecycleDiagnosticSnapshot().leaseRelease).toMatchObject({
      status: 'confirmed',
      releasedCount: 0,
    });
    expect(value.getLeaseReleaseDiagnosticSnapshot().records[0]).toMatchObject({
      event: 'lease_release_observed',
      leaseStatus: 'confirmed',
      releasedCount: 0,
    });
    for (const tableIds of [
      Array.from({ length: 9 }, (_, n) => id(n)),
      [id(1), id(1)],
      ['malformed'],
    ]) {
      expect(() => value.getLifecycleDiagnosticSnapshot({ tableIds })).toThrow();
    }
    await value.stop();
  });
});
