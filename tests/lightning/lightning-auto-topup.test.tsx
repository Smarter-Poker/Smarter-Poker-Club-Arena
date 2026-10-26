import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
const f = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: f }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.report }));
import {
  readLightningTopUp,
  useLightningAutoTopUp,
} from '../../src/lightning/useLightningAutoTopUp';
const pool = '11111111-1111-4111-8111-111111111111';
const cluster = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const table = '44444444-4444-4444-8444-444444444444';
const occupancy = '55555555-5555-4555-8555-555555555555';
const history = '66666666-6666-4666-8666-666666666666';
const other = '77777777-7777-4777-8777-777777777777';
const room = { poolSessionId: pool, clusterId: cluster, meta: null };
const receipt = {
  type: 'hand_history_saved',
  table_id: pool,
  pool_session_id: pool,
  player_id: user,
  hand_id: history,
  lightning_hand_id: other,
};
const target = { stack: 1.37, maximum: 4 };
function setup() {
  const add = vi.fn(
    async (
      _amount: number,
      _opId: string,
      _isCurrent: () => boolean,
      _isScopeCurrent: () => boolean
    ) => true
  );
  const read = vi.fn(async () => target);
  const onAdded = vi.fn();
  const props = {
    room,
    userId: user,
    enabled: true,
    balance: 20 as number | null,
    event: null as Record<string, unknown> | null,
    add,
    read,
    onAdded,
  };
  const hook = renderHook((p) => useLightningAutoTopUp(p), { initialProps: props });
  return { ...hook, props, add, read, onAdded };
}
beforeEach(() => vi.clearAllMocks());
describe('Lightning opt-in top-up at its committed receipt', () => {
  it('is wired to the existing event and keeps the ordinary effect off pool rooms', () => {
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(source).toContain('useLightningAutoTopUp({');
    expect(source).toMatch(/event: engineLastEvent/);
    expect(source).toMatch(/!lightningRoomRef.current\s*&&\s*isAutoRebuyEnabled/);
    expect(source).toContain(
      "handleAddChipsRef.current(amount, opId, { source: 'auto', isCurrent, isScopeCurrent })"
    );
  });
  it('keeps a committed response in scope after opt-out, but fences a changed room', async () => {
    const h = setup();
    let finish!: (value: boolean) => void;
    h.add.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    h.rerender({ ...h.props, event: receipt });
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    const [, , mayDispatch, mayApplyReceipt] = h.add.mock.calls[0];
    h.rerender({ ...h.props, enabled: false, event: receipt });
    expect(mayDispatch()).toBe(false);
    expect(mayApplyReceipt()).toBe(true);
    await act(async () => finish(true));
    expect(h.onAdded).not.toHaveBeenCalled();
    h.rerender({ ...h.props, room: { ...room, poolSessionId: other }, event: receipt });
    expect(mayApplyReceipt()).toBe(false);
    const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
    const response = source.slice(
      source.indexOf('const res = await GameServerAPI.addChips(addOnTableId')
    );
    const bookkeeping = response.slice(0, response.indexOf('applyBalanceDelta('));
    expect(bookkeeping).toContain('opts?.isScopeCurrent && !opts.isScopeCurrent()');
    expect(bookkeeping).not.toMatch(/opts\?\.isCurrent/);
  });
  it('uses fresh own anchor arithmetic with no fabricated hand seat', async () => {
    const h = setup();
    h.rerender({ ...h.props, event: receipt });
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    expect(h.read).toHaveBeenCalledWith(cluster, pool, user, false);
    expect(h.add.mock.calls[0][0]).toBe(2.63);
    expect(h.add.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.add.mock.calls[0][2]()).toBe(true);
    expect(h.onAdded).toHaveBeenCalledWith(2.63);
  });
  it.each([
    { type: 'hand_complete' },
    { type: 'SNAPSHOT' },
    { replayed: true },
    { pool_session_id: other },
    { table_id: other },
    { player_id: other },
    { hand_id: 'unknown' },
    { lightning_hand_id: null },
  ])('does not fund from an uncommitted, replayed or foreign event %j', async (patch) => {
    const h = setup();
    h.rerender({ ...h.props, event: { ...receipt, ...patch } });
    await act(async () => {});
    expect(h.read).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });
  it('does not spend on an old receipt when the player switches on', async () => {
    const h = setup();
    h.rerender({ ...h.props, enabled: false, event: receipt });
    h.rerender({ ...h.props, enabled: true, event: receipt });
    await act(async () => {});
    expect(h.read).not.toHaveBeenCalled();
    h.rerender({ ...h.props, event: { ...receipt, hand_id: other } });
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
  });
  it('never repeats the same settlement intent, including after a refusal', async () => {
    const h = setup();
    h.add.mockResolvedValue(false);
    h.rerender({ ...h.props, event: receipt });
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, event: { ...receipt } });
    await act(async () => {});
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.onAdded).not.toHaveBeenCalled();
  });
  it.each(['off', 'room', 'unmount'])(
    'fences a delayed own-anchor read after %s',
    async (change) => {
      const h = setup();
      let resolve!: (v: typeof target) => void;
      h.read.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          })
      );
      h.rerender({ ...h.props, event: receipt });
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
      if (change === 'unmount') h.unmount();
      else
        h.rerender({
          ...h.props,
          event: receipt,
          ...(change === 'off' ? { enabled: false } : { room: { ...room, poolSessionId: other } }),
        });
      await act(async () => resolve(target));
      expect(h.add).not.toHaveBeenCalled();
    }
  );
  it('shares a single in-flight intent and preserves its scope check until dispatch', async () => {
    const h = setup();
    let resolve!: (v: boolean) => void;
    h.add.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    h.rerender({ ...h.props, event: receipt });
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    h.rerender({ ...h.props, event: { ...receipt, hand_id: other } });
    expect(h.add).toHaveBeenCalledTimes(1);
    const current = h.add.mock.calls[0][2];
    h.rerender({ ...h.props, enabled: false, event: receipt });
    expect(current()).toBe(false);
    await act(async () => resolve(true));
    expect(h.onAdded).not.toHaveBeenCalled();
  });
  it.each([null, 0, -1, Number.NaN])('never invents funding from balance %s', async (balance) => {
    const h = setup();
    h.rerender({ ...h.props, event: receipt, balance });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    expect(h.add).not.toHaveBeenCalled();
  });
  it('reports a failed read without funding or retrying', async () => {
    const h = setup();
    h.read.mockRejectedValue(new Error('read failed'));
    h.rerender({ ...h.props, event: receipt });
    await waitFor(() => expect(f.report).toHaveBeenCalledTimes(1));
    expect(h.add).not.toHaveBeenCalled();
  });
});

function database(rawPatch = {}, seatPatch = {}, tablePatch = {}) {
  f.rpc.mockResolvedValue({
    data: {
      pool_session_id: pool,
      state: 'active',
      in_hand: false,
      stack: 1.37,
      anchor_table_id: table,
      occupancy_id: occupancy,
      seat_number: 2,
      ...rawPatch,
    },
    error: null,
  });
  const rows = {
    table_seats: {
      table_id: table,
      user_id: user,
      occupancy_id: occupancy,
      seat_number: 2,
      left_at: null,
      leave_pending: false,
      is_sitting_out: false,
      ...seatPatch,
    },
    tables: {
      id: table,
      cluster_id: cluster,
      tournament_id: null,
      big_blind: 0.02,
      min_buy_in: 0.8,
      max_buy_in: 4,
      club_id: other,
      union_id: null,
      arena: { id: other, asset: 'chips', is_platform: false, union_id: null },
      ...tablePatch,
    },
  };
  f.from.mockImplementation((name: keyof typeof rows) => {
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      maybeSingle: async () => ({ data: rows[name], error: null }),
    };
    return query;
  });
}
describe('a settled event still reads the actual legal funding boundary', () => {
  it('reads the real physical table ceiling and own stack', async () => {
    database({}, {}, { max_buy_in: 3 });
    expect(await readLightningTopUp(cluster, pool, user)).toEqual({ stack: 1.37, maximum: 3 });
    expect(f.rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: cluster });
  });
  it.each([
    { in_hand: undefined },
    { pool_session_id: other },
    { state: 'leave_pending' },
    { stack: null },
    { stack: -1 },
  ])('refuses a changed or unknown pool %j', async (p) => {
    database(p);
    expect(await readLightningTopUp(cluster, pool, user)).toBeNull();
  });
  it('an older engine cannot queue an overlapping hand', async () => {
    database({ in_hand: true });
    expect(await readLightningTopUp(cluster, pool, user)).toBeNull();
  });
  it('a live overlapping hand may record an uncharged intent after own occupancy validation', async () => {
    database({ in_hand: true });
    expect(await readLightningTopUp(cluster, pool, user, true)).toEqual(target);
  });

  it.each([
    { leave_pending: true },
    { is_sitting_out: true },
    { user_id: other },
    { occupancy_id: other },
    { left_at: '2026-10-20' },
  ])('refuses a changed physical chair %j', async (p) => {
    database({}, p);
    expect(await readLightningTopUp(cluster, pool, user)).toBeNull();
  });
  it.each([{ cluster_id: other }, { tournament_id: other }])(
    'refuses another financial scope %j',
    async (p) => {
      database({}, {}, p);
      expect(await readLightningTopUp(cluster, pool, user)).toBeNull();
    }
  );
});
