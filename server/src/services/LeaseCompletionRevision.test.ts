import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { AllocatorIssuerMeasurement } from './AllocatorIssuerMeasurement.js';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};
function installed() {
  const e: any = new ServerTableEngine('aaaaaaaa-0000-4000-8000-000000000001');
  e.installFinancialPublicationBoundary(
    () => true,
    () => {}
  );
  return { e, q: e.getFinancialPublicationBoundary() };
}
function actualListener(e: any, releaseHandWait: () => void) {
  const source = readFileSync(
    new URL('../engine/ServerTableEngineDealing.ts', import.meta.url),
    'utf8'
  );
  const start = 'unsub = controllerForHand.onEvent((event: HandEvent) => {';
  const body = source.split(start)[1].split('\n        });\n        this.activeHandWaitRelease')[0];
  if (!body) throw new Error('listener source not found');
  const js = ts.transpileModule('function listener(event: HandEvent) {' + body + '\n}', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(
    'players',
    'persistenceGeneration',
    'reportError',
    'handStartMs',
    'releaseHandWait',
    js + '\nreturn listener;'
  )([], 1, vi.fn(), Date.now(), releaseHandWait).bind(e);
}
it.each(['idle', 'blocked_ingress'])(
  'actual listener and settlement capture final controller stacks under %s',
  async (mode) => {
    const { supabase } = await import('./supabase.js');
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: null } as never);
    const { e, q } = installed();
    await q.start(
      () => {},
      () => {}
    );
    e.handCount = 1000001;
    const final = {
      players: [
        { user_id: 'one', stack: 140 },
        { user_id: 'two', stack: 60 },
      ],
      communityCards: [],
      pot: 0,
      stage: 'SHOWDOWN',
    };
    const controller = {
      getState: vi.fn(() => final),
      getRemainingDeck: () => ['Ac', 'Kd'],
      isDoubleBoardActive: () => false,
    };
    e.handController = controller;
    e.atomicStackService.initializeStack(e.tableId, 'one', 100);
    e.atomicStackService.initializeStack(e.tableId, 'two', 100);
    const verify = vi
      .spyOn(e.stateVerifier, 'verify')
      .mockReturnValue({ valid: true, violations: [] });
    // Stop after executing real controller capture and real atomic final stacks.
    // Later financial persistence is outside this local regression.
    vi.spyOn(e.actionValidator, 'clearTable').mockImplementation(() => {
      throw new Error('capture checkpoint');
    });
    e.handleHandEvent = (event: any, players: any, generation: any) =>
      e.handleHandCompleteEvent(event, players, generation);
    let canonical: Promise<void> | undefined;
    const original = e.dispatchFinancialHandComplete.bind(e);
    e.dispatchFinancialHandComplete = (dispatch: any) => {
      canonical = original(dispatch);
      return canonical;
    };
    const blocked = deferred(),
      entered = deferred();
    let ingress: Promise<unknown> | undefined;
    if (mode === 'blocked_ingress') {
      ingress = q.ingress(async (c: any) => {
        entered.resolve();
        await blocked.promise;
        c.assertCurrent();
      });
      await entered.promise;
    }
    const listener = actualListener(e, () => {
      e.handController = null;
    });
    listener({ type: 'HAND_COMPLETE' });
    expect(e.handController).toBeNull();
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ players: final.players }));
    expect(e.atomicStackService.getStackWithVersion(e.tableId, 'one').stack).toBe(140);
    expect(e.atomicStackService.getStackWithVersion(e.tableId, 'two').stack).toBe(60);
    expect(e.rabbitHuntOffers.get(1000001).cards).toEqual(['Ac', 'Kd']);
    await expect(canonical).rejects.toThrow('capture checkpoint');
    if (ingress) {
      blocked.resolve();
      await expect(ingress).rejects.toThrow('boundary_changed');
    }
    rpc.mockRestore();
  }
);
it('unknown ingress cannot discard completion and reconciliation cannot dispatch it twice', async () => {
  const { e, q } = installed();
  await q.start(
    () => {},
    () => {}
  );
  await expect(
    q.ingress(async () => {
      throw new Error('unknown delivery');
    })
  ).rejects.toThrow('unknown delivery');
  const complete = deferred();
  const dispatch = vi.fn(() => complete.promise);
  const first = e.dispatchFinancialHandComplete(dispatch),
    same = e.dispatchFinancialHandComplete(dispatch);
  expect(first).toBe(same);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await q.reconcile(async (assert: any) => assert());
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(q.obligationsComplete(() => {})).rejects.toThrow('unproven');
  complete.resolve();
  await first;
  await q.obligationsComplete(() => {});
  const start = vi.fn();
  await q.start(() => {}, start);
  expect(start).toHaveBeenCalledOnce();
});
it('blocked ingress loses phase authority while canonical completion runs synchronously', async () => {
  const { e, q } = installed();
  await q.start(
    () => {},
    () => {}
  );
  const gate = deferred(),
    entered = deferred(),
    publish = vi.fn();
  const ingress = q.ingress(async (c: any) => {
    entered.resolve();
    await gate.promise;
    c.assertCurrent();
    publish();
  });
  await entered.promise;
  const canonical = vi.fn(async () => {});
  const done = e.dispatchFinancialHandComplete(canonical);
  expect(canonical).toHaveBeenCalledOnce();
  gate.resolve();
  await expect(ingress).rejects.toThrow('boundary_changed');
  await done;
  expect(publish).not.toHaveBeenCalled();
  await expect(q.obligationsComplete(() => {})).rejects.toThrow('unproven');
  await q.reconcile(async (assert: any) => assert());
  await q.obligationsComplete(() => {});
});
it.each([NaN, Infinity, -Infinity, 0, -1, 60001])('rejects invalid deadline %s', (deadline) => {
  const r = new AllocatorIssuerMeasurement('issuer', () => 0);
  expect(() => r.beginAttempt('release', deadline)).toThrow('invalid');
  expect(r.snapshot().fence).toBeNull();
});
it('finite bounded deadline uses one clock sample and expires only at deadline', () => {
  let now = 10,
    calls = 0;
  const r = new AllocatorIssuerMeasurement('issuer', () => {
    calls++;
    return now;
  });
  r.beginAttempt('release', 20);
  expect(calls).toBe(1);
  now = NaN;
  expect(() => r.expireUnqualified('release')).toThrow('not_expired');
  now = 19;
  expect(() => r.expireUnqualified('release')).toThrow('not_expired');
  now = 20;
  r.expireUnqualified('release');
  expect(r.snapshot().fence).toBeNull();
});
it.each([NaN, Infinity, -Infinity])('rejects nonfinite clock %s', (now) => {
  const r = new AllocatorIssuerMeasurement('issuer', () => now);
  expect(() => r.beginAttempt('release', 10)).toThrow('invalid');
});
it('stale owner completion rejection still allows actual listener teardown', async () => {
  const e: any = new ServerTableEngine('aaaaaaaa-0000-4000-8000-000000000002');
  let current = true;
  e.installFinancialPublicationBoundary(
    () => current,
    () => {}
  );
  await e.getFinancialPublicationBoundary().start(
    () => {},
    () => {}
  );
  let completion: Promise<void> | undefined;
  const dispatch = e.dispatchFinancialHandComplete.bind(e);
  e.dispatchFinancialHandComplete = (fn: any) => (completion = dispatch(fn));
  e.handleHandEvent = vi.fn(async () => {});
  const release = vi.fn();
  current = false;
  expect(() => actualListener(e, release)({ type: 'HAND_COMPLETE' })).not.toThrow();
  expect(release).toHaveBeenCalledOnce();
  await expect(completion).rejects.toThrow('owner_changed');
  expect(e.handleHandEvent).not.toHaveBeenCalled();
});
it('reconciliation does not convert failed canonical completion into successful settlement', async () => {
  const { e, q } = installed();
  await q.start(
    () => {},
    () => {}
  );
  const dispatch = vi.fn(async () => {
    throw new Error('canonical settlement failed');
  });
  await expect(e.dispatchFinancialHandComplete(dispatch)).rejects.toThrow(
    'canonical settlement failed'
  );
  await q.reconcile(async () => {});
  await expect(q.obligationsComplete(() => {})).rejects.toThrow('unproven');
  expect(dispatch).toHaveBeenCalledOnce();
});
it.each(['9007199254740992', 9007199254740992, '1000000.5', '1e6', 999999])(
  'ordinary actual allocator refuses %s without another allocation',
  async (data) => {
    const { supabase } = await import('./supabase.js');
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({ data, error: null } as never);
    const { e } = installed();
    await expect(e.allocateGlobalHandNumber()).rejects.toThrow('unsafe_or_invalid_integer');
    expect(rpc).toHaveBeenCalledOnce();
    rpc.mockRestore();
  }
);
it('last safe integer is accepted while an unsafe preexisting cache is discarded', async () => {
  const { supabase } = await import('./supabase.js');
  const rpc = vi
    .spyOn(supabase, 'rpc')
    .mockResolvedValue({ data: '9007199254740991', error: null } as never);
  const { e } = installed();
  expect(await e.allocateGlobalHandNumber()).toBe(Number.MAX_SAFE_INTEGER);
  rpc.mockRestore();
  e.preparedHandNumberValue = { n: 9007199254740992, at: Date.now(), epoch: null };
  expect(() => e.takePreparedHandNumber()).toThrow('cached_number_unsafe');
  expect(e.preparedHandNumberValue).toBeNull();
});
