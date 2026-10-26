import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<object>()),
  supabase: db,
}));
import {
  parseLightningTopUpReceipt,
  requestLightningTopUp,
  type LightningTopUpReceipt,
} from './LightningTopUp.js';
import { LightningHandHost } from './LightningHandHost.js';
import { ServerTableEngineSeating } from '../engine/ServerTableEngineSeating.js';
const T = '00000000-0000-4000-8000-000000000001',
  U = '00000000-0000-4000-8000-000000000002';
const O = '00000000-0000-4000-8000-000000000003';
const receipt = (extra = {}): LightningTopUpReceipt => ({
  success: true,
  queued: false,
  charged: true,
  applied: 30,
  requested: 30,
  request_id: 'request01',
  table_id: T,
  user_id: U,
  pool_session_id: 'pool',
  occupancy_id: O,
  stack: 50,
  status: 'applied',
  ...extra,
});
function deferred<T>() {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function chain(promise: Promise<unknown>) {
  const x: any = { maybeSingle: () => promise };
  for (const k of ['select', 'eq', 'is']) x[k] = () => x;
  return x;
}
function engine() {
  const e: any = Object.create(ServerTableEngineSeating.prototype);
  e.tableId = T;
  e.seatedPlayers = [{ user_id: U, occupancy_id: O, stack: 50 }];
  e.lifecycleCanMutate = () => true;
  e.broadcastCurrentState = vi.fn();
  e.lightningTopUpRefresh = new Map();
  return e;
}
beforeEach(() => vi.clearAllMocks());
describe('Lightning original purchase receipts', () => {
  it('keeps queued uncharged and refuses an inconsistent charge claim', () => {
    expect(
      parseLightningTopUpReceipt(
        receipt({ status: 'pending', queued: true, charged: false, applied: 0, stack: null })
      ).applied
    ).toBe(0);
    expect(() =>
      parseLightningTopUpReceipt(receipt({ status: 'pending', queued: true, applied: 0 }))
    ).toThrow();
  });
  it('submits one exact original request and propagates uncertain outcome without a new key', async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: new Error('transport unknown') });
    await expect(requestLightningTopUp(T, U, 'request01', 30)).rejects.toThrow('unknown');
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0][1]).toEqual({
      p_table_id: T,
      p_user_id: U,
      p_request_id: 'request01',
      p_amount: 30,
    });
  });
  it('refuses a response for another original amount', async () => {
    db.rpc.mockResolvedValueOnce({ data: receipt({ requested: 31 }), error: null });
    await expect(requestLightningTopUp(T, U, 'request01', 30)).rejects.toThrow('Identity');
  });
  it('replayed old receipt reads current stack instead of restoring historical chips', async () => {
    const e = engine();
    e.seatedPlayers[0].stack = 70;
    db.from.mockReturnValue(
      chain(Promise.resolve({ data: { stack: 90, occupancy_id: O }, error: null }))
    );
    await e.reflectLightningTopUp(receipt({ stack: 50 }));
    expect(e.seatedPlayers[0].stack).toBe(90);
  });
  it('a slow refresh A cannot overwrite the faster current refresh B', async () => {
    const e = engine(),
      a = deferred<any>(),
      b = deferred<any>();
    db.from.mockReturnValueOnce(chain(a.promise)).mockReturnValueOnce(chain(b.promise));
    const first = e.reflectLightningTopUp(receipt()),
      second = e.reflectLightningTopUp(receipt({ request_id: 'request02' }));
    b.resolve({ data: { stack: 90, occupancy_id: O }, error: null });
    await second;
    a.resolve({ data: { stack: 60, occupancy_id: O }, error: null });
    await first;
    expect(e.seatedPlayers[0].stack).toBe(90);
    expect(e.broadcastCurrentState).toHaveBeenCalledTimes(1);
  });
  it('a delayed receipt cannot replace a new occupancy or a changed live stack', async () => {
    const e = engine(),
      a = deferred<any>();
    db.from.mockReturnValueOnce(chain(a.promise));
    const first = e.reflectLightningTopUp(receipt());
    e.seatedPlayers = [{ user_id: U, occupancy_id: 'new', stack: 200 }];
    a.resolve({ data: { stack: 50, occupancy_id: O }, error: null });
    await first;
    expect(e.seatedPlayers[0].stack).toBe(200);
    expect(e.broadcastCurrentState).not.toHaveBeenCalled();
    const b = deferred<any>();
    e.seatedPlayers = [{ user_id: U, occupancy_id: O, stack: 100 }];
    db.from.mockReturnValueOnce(chain(b.promise));
    const second = e.reflectLightningTopUp(receipt());
    e.seatedPlayers[0].stack = 120;
    b.resolve({ data: { stack: 70, occupancy_id: O }, error: null });
    await second;
    expect(e.seatedPlayers[0].stack).toBe(120);
  });
});

describe('original horse intent host boundary wiring', () => {
  it('retains an early-folded horse for top-up intent without adding it to cluster auto-rebuy', async () => {
    const host: any = Object.create(LightningHandHost.prototype);
    const report = vi.fn();
    host.deps = { onHandSettled: report };
    host.rules = { big_blind: 1 };
    host.participants = new Map([
      ['horse', { playerId: 'horse', isHorse: true }],
      ['human', { playerId: 'human', isHorse: false }],
    ]);
    await host.reportSettledBoundary([
      { playerId: 'horse', foldType: 'fast', stackAfter: 20 },
      { playerId: 'human', stackAfter: 50 },
    ]);
    expect(report.mock.calls[0][0].horsePlayers).toEqual([{ playerId: 'horse' }]);
    expect(report.mock.calls[0][0].players).toEqual([{ playerId: 'human', stackAfter: 50 }]);
  });
});
