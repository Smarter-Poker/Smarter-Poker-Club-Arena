import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function engine(n: number): any {
  const value = new ServerTableEngine(id(n)) as any;
  value.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  return value;
}
afterEach(() => vi.restoreAllMocks());

describe('bounded engine lifecycle observations', () => {
  it('reads retained work without joining and observes actual settlement before cleanup', async () => {
    const value = engine(701),
      raw = deferred();
    const owned = raw.promise.finally(() => value.settlementInFlight.delete(owned));
    value.settlementInFlight.add(owned);
    const stopping = value.stop();
    expect(value.stop()).toBe(stopping);
    const terminal = value.leavePendingLifecycleSnapshot().first_terminal;
    const pending = value.getLifecycleDiagnosticSnapshot();
    expect(pending.retainedWork).toMatchObject({ settlements: 1, readContinuations: null });
    expect(pending.readContinuationCoverage).toBe('unavailable_on_selected_base');
    expect(pending.leaseReleaseAck).toBe('unobserved-owner-boundary');
    expect(pending.records.map((row: any) => row.event)).toEqual(['stop_initiated']);
    expect(value.flushSnapshot).not.toHaveBeenCalled();
    expect(value.leavePendingLifecycleSnapshot().first_terminal).toEqual(terminal);
    raw.resolve();
    await stopping;
    expect(value.getLifecycleDiagnosticSnapshot().records.map((row: any) => row.event)).toEqual([
      'stop_initiated',
      'owned_work_joined',
      'stop_completed',
    ]);
    expect(value.stop()).toBe(stopping);
  });

  it('diagnostic write failure does not turn an actual failed writer into success', async () => {
    const value = engine(702),
      raw = deferred();
    const failure = new Error('owned writer rejected');
    const owned = raw.promise.finally(() => value.settlementInFlight.delete(owned));
    value.settlementInFlight.add(owned);
    vi.spyOn(value.lifecycleDiagnostics, 'record').mockImplementation(() => {
      throw new Error('diagnostic only');
    });
    const stopping = value.stop();
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
    });
    raw.reject(failure);
    await rejected;
    expect(value.getLifecycleDiagnosticSnapshot().diagnosticWriteFailures).toBeGreaterThan(0);
    expect(value.getLifecycleDiagnosticSnapshot().leaseReleaseAck).toBe(
      'unobserved-owner-boundary'
    );
  });

  it('retains bounded immutable records and preserves existing terminal reason semantics', async () => {
    const value = engine(703);
    for (let i = 0; i < 40; i++)
      value.lifecycleDiagnostics.record('writer_pending', {
        attempt: i,
        payload: 'PRIVATE',
      } as any);
    const before = value.getLifecycleDiagnosticSnapshot();
    expect(before.records).toHaveLength(32);
    expect(before.droppedRecords).toBe(8);
    expect(JSON.stringify(before)).not.toContain('PRIVATE');
    expect(Object.isFrozen(before.records[0])).toBe(true);
    value.killForRestartPublic('tournament_lease_proof_expired');
    const originalTerminal = value.leavePendingLifecycleSnapshot().first_terminal;
    await value.stop();
    expect(value.leavePendingLifecycleSnapshot().first_terminal).toEqual(originalTerminal);
    expect(before.lastSequence).toBe(40);
    expect(
      value.getLifecycleDiagnosticSnapshot().records.some((r: any) => r.event === 'engine_fenced')
    ).toBe(true);
  });
});
