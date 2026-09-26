import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  error: null as unknown,
  reads: [] as Record<string, unknown>[],
  emit: vi.fn(),
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'reader' } }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const request: Record<string, unknown> = { table };
      const query = {
        select: (fields: string) => {
          request.fields = fields;
          return query;
        },
        eq: (field: string, value: string) => {
          request[field] = value;
          return query;
        },
        gt: (field: string, value: string) => {
          request.after = [field, value];
          return query;
        },
        order: (field: string, options: unknown) => {
          request.order = [field, options];
          return query;
        },
        limit: (limit: number) => {
          request.limit = limit;
          return query;
        },
        abortSignal: async (signal: AbortSignal) => {
          mocks.reads.push(request);
          expect(signal).toBeInstanceOf(AbortSignal);
          return { data: mocks.rows, error: mocks.error };
        },
      };
      return query;
    },
  },
}));

import { useGameManagementRealtime } from '../../src/hooks/useGameManagementRealtime';
const base = { scope: 'club' as const, scopeId: 'club-1', enabled: true };
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const tick = () => act(() => vi.advanceTimersByTimeAsync(20_000));
const row = (sequence: number, extra = {}) => ({
  sequence,
  scope_kind: 'club',
  scope_id: 'club-1',
  entity_type: 'table',
  entity_id: 't-1',
  ...extra,
});

describe('visible management feed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.emit.mockReset();
    mocks.reads = [];
    mocks.error = null;
    mocks.rows = [row(10)];
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads only its authorized scope and resyncs after establishing a bounded baseline', async () => {
    const onResync = vi.fn();
    const { result } = renderHook(() => useGameManagementRealtime({ ...base, onResync }));
    expect(result.current).toBe('connecting');
    await flush();
    expect(mocks.reads[0]).toMatchObject({
      table: 'game_management_events',
      scope_kind: 'club',
      scope_id: 'club-1',
      limit: 128,
    });
    expect(result.current).toBe('current');
    expect(onResync).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalled(); // historical baseline is not a new command
    mocks.rows = [];
    await tick();
    expect(mocks.reads[1].after).toBeUndefined();
    // An empty RLS result can mean access was revoked. Revalidate the board.
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('ignores wrong-scope rows and emits the named table invalidation from another client', async () => {
    renderHook(() => useGameManagementRealtime({ ...base, onResync: vi.fn() }));
    await flush();
    mocks.rows = [row(12, { scope_id: 'club-2' }), row(11)];
    await tick();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('TABLE_UPDATED', { tableId: 't-1' });
  });

  it('delivers targeted access revocation and each managed content event', async () => {
    renderHook(() => useGameManagementRealtime({ ...base, onResync: vi.fn() }));
    await flush();
    mocks.rows = [
      row(14, { event_type: 'management_access_changed', club_id: 'club-1' }),
      row(13, { event_type: 'announcement_changed', club_id: 'club-1' }),
      row(12, { event_type: 'club_identity_changed', club_id: 'club-1' }),
      row(11, { event_type: 'ticker_settings_changed' }),
    ];
    await tick();
    expect(mocks.emit.mock.calls).toEqual([
      ['TICKER_SETTINGS_CHANGED', { scope: 'club', scopeId: 'club-1' }],
      ['CLUB_UPDATED', { clubId: 'club-1' }],
      ['ANNOUNCEMENT_CHANGED', { clubId: 'club-1', action: 'created' }],
      ['GAME_MANAGEMENT_ACCESS_CHANGED', { scope: 'club', scopeId: 'club-1', clubId: 'club-1' }],
    ]);
  });

  it('observes a lower sequence that committed after the previous read', async () => {
    renderHook(() => useGameManagementRealtime({ ...base, onResync: vi.fn() }));
    await flush();
    mocks.rows = [row(10), row(9, { entity_id: 'late-table' })];
    await tick();
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith('TABLE_UPDATED', { tableId: 'late-table' });
    await tick();
    expect(mocks.emit).toHaveBeenCalledOnce();
  });

  it('resyncs after a gap or full batch instead of silently omitting changed games', async () => {
    const onResync = vi.fn();
    const { result } = renderHook(() => useGameManagementRealtime({ ...base, onResync }));
    await flush();
    mocks.rows = Array.from({ length: 128 }, (_, i) => row(138 - i));
    await tick();
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(mocks.emit).not.toHaveBeenCalled();
    mocks.error = new Error('Not available');
    await tick();
    expect(result.current).toBe('degraded');
    mocks.error = null;
    mocks.rows = [];
    await tick();
    expect(result.current).toBe('current');
    expect(onResync).toHaveBeenCalledTimes(3);
  });

  it('never calls an unreadable or invalid sequence a current feed', async () => {
    mocks.error = new Error('Permission denied');
    const { result } = renderHook(() => useGameManagementRealtime({ ...base, onResync: vi.fn() }));
    await flush();
    expect(result.current).toBe('degraded');
    mocks.error = null;
    mocks.rows = [row(Number.NaN)];
    await tick();
    expect(result.current).toBe('degraded');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('starts a fresh baseline when the operator changes scope', async () => {
    const onResync = vi.fn();
    const hook = renderHook(
      ({ scopeId }) => useGameManagementRealtime({ ...base, scopeId, onResync }),
      { initialProps: { scopeId: 'club-1' } }
    );
    await flush();
    hook.rerender({ scopeId: 'club-2' });
    await flush();
    expect(mocks.reads[1]).toMatchObject({ scope_id: 'club-2', limit: 128 });
    expect(mocks.reads[1].after).toBeUndefined();
    expect(onResync).toHaveBeenCalledTimes(2);
  });
});
