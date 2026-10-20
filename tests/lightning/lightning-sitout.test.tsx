import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
const fixture = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: fixture }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: fixture.report }));
import {
  readLightningSitOut,
  useLightningSitOut,
  type LightningSitOutState,
} from '../../src/lightning/useLightningSitOut';
const pool = '11111111-1111-4111-8111-111111111111';
const cluster = '22222222-2222-4222-8222-222222222222';
const anchor = '33333333-3333-4333-8333-333333333333';
const occupancy = '44444444-4444-4444-8444-444444444444';
const user = '55555555-5555-4555-8555-555555555555';
const room = { poolSessionId: pool, clusterId: cluster, meta: null };
const paused = { sittingOut: true, since: Date.parse('2026-10-20T19:00:00Z') };
function database(patch = {}, sessionPatch = {}) {
  fixture.rpc.mockResolvedValue({
    data: {
      pool_session_id: pool,
      state: 'active',
      anchor_table_id: anchor,
      seat_number: 2,
      occupancy_id: occupancy,
      ...sessionPatch,
    },
    error: null,
  });
  const calls: unknown[] = [];
  const q = {
    select: () => q,
    eq: (field: string, value: unknown) => {
      calls.push([field, value]);
      return q;
    },
    is: (field: string, value: unknown) => {
      calls.push([field, value]);
      return q;
    },
    maybeSingle: async () => ({
      data: {
        table_id: anchor,
        user_id: user,
        seat_number: 2,
        occupancy_id: occupancy,
        left_at: null,
        leave_pending: false,
        is_sitting_out: true,
        sit_out_at: '2026-10-20T19:00:00Z',
        ...patch,
      },
      error: null,
    }),
  };
  fixture.from.mockReturnValue(q);
  return calls;
}
function deferred() {
  let resolve!: (state: LightningSitOutState | null) => void;
  const promise = new Promise<LightningSitOutState | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => vi.clearAllMocks());
describe('own Lightning sit-out anchor', () => {
  it('reads the authenticated own pool, actual physical chair, occupancy and server stamp', async () => {
    const calls = database();
    expect(await readLightningSitOut(cluster, pool, user)).toEqual(paused);
    expect(fixture.rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: cluster });
    expect(calls).toEqual([
      ['table_id', anchor],
      ['user_id', user],
      ['seat_number', 2],
      ['occupancy_id', occupancy],
      ['left_at', null],
    ]);
  });
  it('does not adopt a replacement pool', async () => {
    database({}, { pool_session_id: occupancy });
    expect(await readLightningSitOut(cluster, pool, user)).toBeNull();
    expect(fixture.from).not.toHaveBeenCalled();
  });
  it.each([
    { user_id: occupancy },
    { occupancy_id: pool },
    { left_at: '2026-10-20' },
    { seat_number: 3 },
    { table_id: pool },
    { sit_out_at: 'invalid' },
  ])('refuses mismatched or unverifiable chair %j', async (patch) => {
    database(patch);
    await expect(readLightningSitOut(cluster, pool, user)).rejects.toThrow(/Unverified/);
  });
  it('never exposes return for a pending exit', async () => {
    database({ leave_pending: true });
    expect(await readLightningSitOut(cluster, pool, user)).toBeNull();
  });
});
describe('Lightning idle return and recovery', () => {
  it('bootstraps a paused owner without any hand seat and rereads only on connection events', async () => {
    const read = vi.fn().mockResolvedValue(paused);
    const { result, rerender } = renderHook(
      ({ status }) => useLightningSitOut({ room, userId: user, connectionStatus: status, read }),
      { initialProps: { status: 'connected' } }
    );
    await waitFor(() => expect(result.current.sittingOut).toBe(true));
    expect(result.current.since).toBe(paused.since);
    rerender({ status: 'connected' });
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ status: 'reconnecting' });
    rerender({ status: 'connected' });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
  it('reconciles only the exact owner persisted event and preserves it through unrelated events', async () => {
    const pending = deferred();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sittingOut: false, since: null })
      .mockImplementationOnce(() => pending.promise);
    const event = {
      type: 'lightning_sitout_changed',
      pool_session_id: pool,
      player_id: user,
      occupancy_id: occupancy,
      sitting_out: true,
      sit_out_at: '2026-10-20T19:00:00Z',
    };
    const { result, rerender } = renderHook(
      ({ nextEvent }) =>
        useLightningSitOut({
          room,
          userId: user,
          connectionStatus: 'connected',
          event: nextEvent,
          read,
        }),
      { initialProps: { nextEvent: null as Record<string, unknown> | null } }
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rerender({ nextEvent: { ...event, player_id: occupancy } });
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ nextEvent: event });
    expect(read).toHaveBeenCalledTimes(2);
    rerender({ nextEvent: { type: 'hand_started' } });
    await act(async () => pending.resolve(paused));
    expect(result.current.sittingOut).toBe(true);
    expect(result.current.since).toBe(paused.since);
  });
  it('a newer accepted pause or resume cannot be overwritten by an older bootstrap', async () => {
    const pending = deferred();
    const read = vi.fn(() => pending.promise);
    const { result } = renderHook(() =>
      useLightningSitOut({ room, userId: user, connectionStatus: 'connected', read })
    );
    act(() => {
      expect(result.current.acknowledge(pool, user, true)).toBe(true);
    });
    expect(result.current.sittingOut).toBe(true);
    await act(async () => pending.resolve({ sittingOut: false, since: null }));
    expect(result.current.sittingOut).toBe(true);
    act(() => {
      result.current.acknowledge(pool, user, false);
    });
    expect(result.current.sittingOut).toBe(false);
    expect(result.current.since).toBeNull();
  });
  it.each(['pool', 'user'] as const)(
    'ignores stale reads and acknowledgments after %s replacement',
    async (change) => {
      const pending = deferred();
      const read = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(null);
      const { result, rerender } = renderHook(
        ({ nextRoom, nextUser }) =>
          useLightningSitOut({
            room: nextRoom,
            userId: nextUser,
            connectionStatus: 'connected',
            read,
          }),
        { initialProps: { nextRoom: room, nextUser: user } }
      );
      rerender({
        nextRoom: change === 'pool' ? { ...room, poolSessionId: occupancy } : room,
        nextUser: change === 'user' ? occupancy : user,
      });
      act(() => {
        expect(result.current.isCurrent(pool, user)).toBe(false);
        expect(result.current.acknowledge(pool, user, true)).toBe(false);
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await act(async () => pending.resolve(paused));
      expect(result.current.sittingOut).toBe(false);
    }
  );
  it('does not read ordinary tables or disconnected rooms; refuses unmounted acknowledgments', () => {
    const read = vi.fn();
    const ordinary = renderHook(() =>
      useLightningSitOut({ room: null, userId: user, connectionStatus: 'connected', read })
    );
    expect(read).not.toHaveBeenCalled();
    ordinary.unmount();
    const disconnected = renderHook(() =>
      useLightningSitOut({ room, userId: user, connectionStatus: 'reconnecting', read })
    );
    expect(read).not.toHaveBeenCalled();
    disconnected.unmount();
    expect(disconnected.result.current.acknowledge(pool, user, true)).toBe(false);
  });
  it('reports unreadable reconnect state without clearing a known accepted pause', async () => {
    const read = vi.fn().mockResolvedValue(paused);
    const { result, rerender } = renderHook(
      ({ status }) => useLightningSitOut({ room, userId: user, connectionStatus: status, read }),
      { initialProps: { status: 'connected' } }
    );
    await waitFor(() => expect(result.current.sittingOut).toBe(true));
    read.mockRejectedValue(new Error('unreadable'));
    rerender({ status: 'reconnecting' });
    rerender({ status: 'connected' });
    await waitFor(() => expect(fixture.report).toHaveBeenCalled());
    expect(result.current.sittingOut).toBe(true);
  });
});
it('the actual footer permits idle Lightning return before spectator/reserved branches', () => {
  const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
  expect(source).toMatch(/heroIsSittingOut =[\s\S]*?lightningSitOut\.sittingOut/);
  expect(source).toMatch(/heroSeat <= 0\s*&&\s*!heroIsSittingOut \? \(/);
  expect(source).toMatch(/heroIsSittingOut \? \([\s\S]*?data-state="sitting-out"/);
  expect(source).toMatch(/lightningSitOut\.acknowledge\(tableId, String\(userId\), true\)/);
  expect(source).toMatch(/lightningSitOut\.acknowledge\(tableId, String\(userId\), false\)/);
});

it('settings and footer cannot submit competing opposite sit-out requests', () => {
  const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
  const at = source.indexOf('if (settingsUpdate.sitOutNextHand !== undefined');
  const block = source.slice(at, source.indexOf('/* The `autoMuckWinners`', at));
  expect(block).toMatch(/!sitOutRequestInFlightRef.current/);
  expect(block.indexOf('sitOutRequestInFlightRef.current = true')).toBeLessThan(
    block.indexOf('setSitOut(tableId, wanted)')
  );
  expect(block).toMatch(/\.finally\(\(\) => \{\s*sitOutRequestInFlightRef.current = false/);
  expect(block).toMatch(/lightningSitOut.isCurrent\(tableId, String\(userId\)\)/);
  expect(block).toMatch(/setSitOutNextHand\(!wanted\)/);
});
