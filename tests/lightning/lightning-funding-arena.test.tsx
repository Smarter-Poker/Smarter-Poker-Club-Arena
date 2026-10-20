import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const fixture = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: fixture }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: fixture.report }));
import {
  readLightningFundingArena,
  useLightningFundingArena,
} from '../../src/lightning/useLightningFundingArena';
const cluster = '22222222-2222-4222-8222-222222222222';
const anchor = '33333333-3333-4333-8333-333333333333';
const pool = '11111111-1111-4111-8111-111111111111';
const club = '44444444-4444-4444-8444-444444444444';
const room = { clusterId: cluster, poolSessionId: pool, meta: null };
const arena = { id: club, kind: 'chip_club' as const, asset: 'chips' as const };
function database(patch: Record<string, unknown> = {}, error: unknown = null) {
  fixture.rpc.mockResolvedValue({
    data: {
      pool_session_id: pool,
      state: 'active',
      anchor_table_id: anchor,
      seat_number: 2,
      occupancy_id: club,
    },
    error: null,
  });
  const calls: unknown[] = [];
  const q = {
    select: (columns: string) => {
      calls.push(columns);
      return q;
    },
    eq: (field: string, value: unknown) => {
      calls.push([field, value]);
      return q;
    },
    maybeSingle: async () => ({
      data: {
        id: anchor,
        cluster_id: cluster,
        club_id: club,
        union_id: null,
        arena: { id: club, asset: 'chips', is_platform: false, union_id: null },
        ...patch,
      },
      error,
    }),
  };
  fixture.from.mockImplementation((table) => {
    calls.push(table);
    return q;
  });
  return calls;
}
beforeEach(() => vi.clearAllMocks());
describe('Lightning funding identity', () => {
  it('reads the own anchor and its actual arena instead of querying the room as a table', async () => {
    const calls = database();
    expect(await readLightningFundingArena(cluster, pool)).toEqual(arena);
    expect(fixture.rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: cluster });
    expect(calls).toContainEqual(['id', anchor]);
    expect(calls).not.toContainEqual(['id', pool]);
    expect(String(calls)).toContain('clubs!fk_tables_club_id');
  });
  it('does not invent a chip arena when the player has no own anchor', async () => {
    fixture.rpc.mockResolvedValue({
      data: { pool_session_id: pool, state: 'closed' },
      error: null,
    });
    expect(await readLightningFundingArena(cluster, pool)).toBeNull();
    expect(fixture.from).not.toHaveBeenCalled();
  });
  it.each([
    { cluster_id: club },
    { id: pool },
    { arena: null },
    { arena: { id: pool, asset: 'chips', is_platform: false } },
    { arena: { id: club, asset: 'unknown', is_platform: false } },
  ])('rejects malformed or mismatched anchor metadata %j', async (patch) => {
    database(patch);
    await expect(readLightningFundingArena(cluster, pool)).rejects.toBeDefined();
  });
  it('refuses a replacement pool in the same cluster before reading its table', async () => {
    database();
    fixture.rpc.mockResolvedValue({
      data: {
        pool_session_id: club,
        state: 'active',
        anchor_table_id: anchor,
        seat_number: 2,
        occupancy_id: club,
      },
      error: null,
    });
    expect(await readLightningFundingArena(cluster, pool)).toBeNull();
    expect(fixture.from).not.toHaveBeenCalled();
  });
  it('preserves Diamond identity instead of silently selecting a chip wallet', async () => {
    database({ arena: { id: club, asset: 'diamonds', is_platform: true, union_id: null } });
    expect(await readLightningFundingArena(cluster, pool)).toEqual({
      id: club,
      kind: 'diamond_arena',
      asset: 'diamonds',
    });
  });
  it('reports a failed read without supplying a financial default', async () => {
    const readArena = vi.fn().mockRejectedValue(new Error('unavailable')),
      onArena = vi.fn();
    renderHook(() => useLightningFundingArena({ room, userId: club, onArena, readArena }));
    await waitFor(() => expect(fixture.report).toHaveBeenCalled());
    expect(onArena).not.toHaveBeenCalled();
  });
  it('ignores old room/account results and does not refresh on ordinary rerenders', async () => {
    let finish!: (v: typeof arena) => void;
    const readArena = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          })
      )
      .mockResolvedValue(arena);
    const onArena = vi.fn();
    const h = renderHook(
      ({ userId }) => useLightningFundingArena({ room, userId, onArena, readArena }),
      { initialProps: { userId: club } }
    );
    h.rerender({ userId: pool });
    await waitFor(() => expect(onArena).toHaveBeenCalledTimes(1));
    finish(arena);
    await Promise.resolve();
    expect(onArena).toHaveBeenCalledTimes(1);
    h.rerender({ userId: pool });
    expect(readArena).toHaveBeenCalledTimes(2);
    h.unmount();
  });
  it('is wired into the actual room page with the returned asset and route identity guard', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(page).toContain('useLightningFundingArena({');
    expect(page).toContain('prev.tableId !== poolSessionId');
    expect(page).toContain('arenaAsset: arena.asset');
    expect(page).toContain('arenaId: arena.id');
  });
});
