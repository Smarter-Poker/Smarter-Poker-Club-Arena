import { describe, expect, it } from 'vitest';
import { SettlementAwait } from './SettlementAwait.js';
import { settlementHealthSnapshot } from './SettlementHealth.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('settlement await evidence preserves physical ownership', () => {
  it('keeps the original pending promise and reports its exact hand in blocked health', async () => {
    const trace = new SettlementAwait();
    const work = deferred();
    const observed = trace.observe('hand_history_write', 34, 10900197, (progress) => {
      progress('rpc_request:1');
      return work.promise;
    });
    expect(observed).toBe(work.promise);
    const snapshot = trace.snapshot();
    expect(snapshot).toEqual([
      {
        stage: 'hand_history_write',
        generation: 34,
        handNumber: 10900197,
        ageMs: expect.any(Number),
        detail: 'rpc_request:1',
      },
    ]);
    expect(
      settlementHealthSnapshot([
        {
          tableId: 'table',
          handCount: 10900197,
          settlementAgeMs: 35_000,
          settlementAwaits: snapshot,
        },
      ]).blockedSettlements[0]
    ).toMatchObject({ awaits: snapshot, ageMs: 35_000 });
    work.resolve();
    await observed;
    expect(trace.snapshot()).toEqual([]);
  });

  it('an older completion cannot erase another same-stage operation or its evidence', async () => {
    const trace = new SettlementAwait();
    const old = deferred(),
      next = deferred();
    trace.observe('post_hand', 1, 101, () => old.promise);
    trace.observe('post_hand', 2, 102, () => next.promise);
    const snapshot = trace.snapshot();
    snapshot[1].stage = 'changed outside observer';
    old.resolve();
    await old.promise;
    expect(trace.snapshot()).toMatchObject([
      { stage: 'post_hand', generation: 2, handNumber: 102 },
    ]);
    const error = new Error('canonical refusal');
    next.reject(error);
    await expect(next.promise).rejects.toBe(error);
    await Promise.resolve();
    expect(trace.snapshot()).toEqual([]);
  });

  it('bounds diagnostics while all original operations still execute and settle', async () => {
    const trace = new SettlementAwait();
    const jobs = Array.from({ length: 12 }, deferred);
    let invoked = 0;
    for (const [i, work] of jobs.entries()) {
      expect(
        trace.observe('x'.repeat(100), i, i, (progress) => {
          invoked++;
          progress('y'.repeat(100));
          return work.promise;
        })
      ).toBe(work.promise);
    }
    expect(invoked).toBe(12);
    expect(trace.snapshot()).toHaveLength(8);
    expect(trace.snapshot().every((x) => x.stage.length === 64 && x.detail?.length === 64)).toBe(
      true
    );
    jobs.forEach((work) => work.resolve());
    await Promise.all(jobs.map((work) => work.promise));
    expect(trace.snapshot()).toEqual([]);
  });

  it('preserves a synchronous failure without leaving an active observation', () => {
    const trace = new SettlementAwait(),
      error = new Error('refused before dispatch');
    expect(() =>
      trace.observe('post_hand', 1, 101, () => {
        throw error;
      })
    ).toThrow(error);
    expect(trace.snapshot()).toEqual([]);
  });
});
