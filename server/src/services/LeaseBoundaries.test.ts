import { it, expect, vi } from 'vitest';
import { ServerTableEngineBase } from '../engine/ServerTableEngineBase.js';
import { ServerTableEngineDealing } from '../engine/ServerTableEngineDealing.js';
import {
  AllocatorIssuerMeasurement,
  allocatorRequestContext,
} from './AllocatorIssuerMeasurement.js';
const deferred = () => {
  let resolve!: (v?: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { resolve, promise };
};
function boundary() {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  e.running = false;
  e.financialPublicationBoundary = null;
  let current = true;
  e.installFinancialPublicationBoundary(
    () => current,
    () => {
      if (!current) throw new Error('stale');
    }
  );
  return { e, q: e.getFinancialPublicationBoundary(), lose: () => (current = false) };
}
it('actual Base publication queue orders ingress before controller start', async () => {
  const { e, q } = boundary();
  const gate = deferred(),
    order: string[] = [];
  const ingress = q.ingress(async ({ assertCurrent }: any) => {
    await gate.promise;
    assertCurrent();
    order.push('published');
  });
  const start = q.start(
    () => {},
    () => order.push('controller')
  );
  await Promise.resolve();
  expect(order).toEqual([]);
  gate.resolve();
  await ingress;
  await start;
  expect(order).toEqual(['published', 'controller']);
});
it('completion captures immediately during ingress and start waits for reconciliation and obligations', async () => {
  const { q } = boundary();
  await q.start(
    () => {},
    () => {}
  );
  const gate = deferred(),
    entered = deferred(),
    order: string[] = [];
  const ingress = q.ingress(async (c: any) => {
    entered.resolve();
    await gate.promise;
    c.assertCurrent();
    order.push('pending');
  });
  await entered.promise;
  const completion = q.handComplete(async () => {
    order.push('settlement');
  });
  expect(order).toEqual(['settlement']);
  gate.resolve();
  await expect(ingress).rejects.toThrow('boundary_changed');
  await completion;
  await expect(
    q.start(
      () => {},
      () => {}
    )
  ).rejects.toThrow('unproven');
  await q.reconcile(async () => {});
  await q.obligationsComplete(() => order.push('canonical projection'));
  await q.start(
    () => {},
    () => order.push('next controller')
  );
  expect(order.slice(-2)).toEqual(['canonical projection', 'next controller']);
});
it('unknown ingress blocks start until explicit authority reconciliation', async () => {
  const { q } = boundary();
  await expect(
    q.ingress(async () => {
      throw new Error('lost');
    })
  ).rejects.toThrow('lost');
  await expect(
    q.start(
      () => {},
      () => {}
    )
  ).rejects.toThrow('unproven');
  await q.reconcile(async (assert: any) => assert());
  await q.start(
    () => {},
    () => {}
  );
});
it('owner change after ingress await refuses publication and releases queue', async () => {
  const { q, lose } = boundary();
  const gate = deferred(),
    publish = vi.fn();
  const work = q.ingress(async (c: any) => {
    await gate.promise;
    c.assertCurrent();
    publish();
  });
  await Promise.resolve();
  lose();
  gate.resolve();
  await expect(work).rejects.toThrow('owner_changed');
  expect(publish).not.toHaveBeenCalled();
  await expect(
    q.start(
      () => {},
      () => {}
    )
  ).rejects.toThrow('owner_changed');
});
it('actual Base allocator request survives timeout classification and fences ordinary retry', async () => {
  const { supabase } = await import('./supabase.js');
  const gate = deferred();
  let requestId = '';
  const rpc = vi.spyOn(supabase, 'rpc').mockImplementation((() => {
    requestId = allocatorRequestContext.getStore()!.requestId;
    return gate.promise;
  }) as any);
  const e: any = Object.create(ServerTableEngineBase.prototype);
  Object.assign(e, { running: false, f06Allocator: null, allocatorMeasurement: null });
  const registry = new AllocatorIssuerMeasurement('issuer', () => 0);
  e.installAllocatorMeasurement(registry);
  const pending = e.allocateGlobalHandNumber();
  await Promise.resolve();
  registry.beginAttempt('release', 100);
  expect(registry.snapshot().active).toBe(1);
  gate.resolve({ data: null, error: new Error('timeout') });
  await expect(pending).rejects.toThrow('fenced');
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(registry.snapshot().unknown).toBe(1);
  registry.complete(requestId, {
    requestId,
    receiptId: 'transport-proof',
    kind: 'transport_owner_barrier',
  });
  expect(registry.snapshot().unknown).toBe(0);
  rpc.mockRestore();
});
it('actual Dealing preparation remains counted after its field clears and burns delayed fenced result', async () => {
  const e: any = Object.create(ServerTableEngineDealing.prototype);
  const registry = new AllocatorIssuerMeasurement('issuer', () => 0),
    gate = deferred();
  Object.assign(e, {
    running: false,
    allocatorMeasurement: null,
    f06Allocator: () => gate.promise,
    f06AllocationCurrent: () => true,
    f06AllocationEpoch: 'epoch',
    preparedHandNumber: null,
    preparedHandNumberValue: null,
    preparedF06AllocationError: null,
    isTournamentTable: () => true,
    acquireSeatBoundary: async () => () => {},
    readNextHandInputs: async () => [],
  });
  e.installAllocatorMeasurement(registry);
  await e.prepareNextHand();
  const settle = e.settlePreparedHandNumber();
  expect(e.preparedHandNumber).toBeNull();
  expect(registry.snapshot().pendingPreparations).toBe(1);
  registry.beginAttempt('release', 100);
  gate.resolve(1000001);
  await settle;
  expect(registry.snapshot().pendingPreparations).toBe(0);
  expect(e.preparedHandNumberValue).toBeNull();
  expect(registry.snapshot().unknown).toBe(1);
});
it('unqualified issuer attempt expires without authorizing floor or stale epoch retries', () => {
  let time = 0;
  const r = new AllocatorIssuerMeasurement('issuer', () => time),
    old = r.capture();
  r.beginAttempt('release', 50);
  time = 50;
  r.expireUnqualified('release');
  expect(() => r.assertAdmission(old)).toThrow('fenced');
  expect(() => r.assertAdmission(r.capture())).not.toThrow();
  expect(r.snapshot().floorEnabled).toBe(false);
});

it('actual completion dispatch preserves immediate canonical callback during ingress', async () => {
  const { e, q } = boundary();
  Object.assign(e, {
    postHandTasksPromise: null,
    settlementInFlight: new Set(),
    settlementStartedAtMs: null,
    notifyBoundaryPauseWaiters: () => {},
  });
  await q.start(
    () => {},
    () => {}
  );
  const gate = deferred(),
    entered = deferred();
  const ingress = q.ingress(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const dispatched = vi.fn(async () => {});
  const completion = e.dispatchFinancialHandComplete(dispatched);
  expect(dispatched).toHaveBeenCalledTimes(1);
  gate.resolve();
  await expect(ingress).rejects.toThrow('boundary_changed');
  await completion;
  await expect(
    q.start(
      () => {},
      () => {}
    )
  ).rejects.toThrow('unproven');
});
