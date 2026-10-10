import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertChangeData } from '@supabase/realtime-js/dist/module/lib/transformers';

const mocks = vi.hoisted(() => ({
  channelCalls: 0,
  removeCalls: 0,
  queryCalls: 0,
  deferredRead: undefined as undefined | ((value: unknown) => void),
  deferRead: false,
  rows: [] as Array<Record<string, unknown>>,
  realtime: undefined as undefined | ((payload: Record<string, unknown>) => void),
  realtimeStatus: undefined as undefined | ((status: string) => void),
}));

vi.mock('../../src/core/MasterBus', async () => await vi.importActual('../../src/core/MasterBus'));
vi.mock('../../src/lib/supabase', () => {
  const channel = {
    on: vi.fn(
      (_event: string, _filter: unknown, callback: (payload: Record<string, unknown>) => void) => {
        mocks.realtime = callback;
        return channel;
      }
    ),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      mocks.realtimeStatus = callback;
      callback?.('SUBSCRIBED');
      return channel;
    }),
  };
  return {
    supabase: {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          then: (resolve: (value: unknown) => unknown) => {
            mocks.queryCalls += 1;
            if (mocks.deferRead) {
              return new Promise((done) => {
                mocks.deferredRead = done;
              }).then(resolve);
            }
            return Promise.resolve({ data: mocks.rows, error: null }).then(resolve);
          },
        };
        return builder;
      }),
      channel: vi.fn(() => {
        mocks.channelCalls += 1;
        return channel;
      }),
      removeChannel: vi.fn(async () => {
        mocks.removeCalls += 1;
      }),
    },
  };
});

import { masterBus } from '../../src/core/MasterBus';
import {
  resolveCachedTheme,
  __themeRealtimeChannelCount,
  useUserThemeSettings,
} from '../../src/hooks/useUserThemeSettings';

describe('useUserThemeSettings database realtime', () => {
  beforeEach(() => {
    mocks.channelCalls = 0;
    mocks.removeCalls = 0;
    mocks.queryCalls = 0;
    mocks.deferRead = false;
    mocks.deferredRead = undefined;
    mocks.rows = [];
    mocks.realtime = undefined;
    mocks.realtimeStatus = undefined;
    localStorage.clear();
  });

  it('shares one account channel and repaints every mounted table from a cross-device row', async () => {
    const { result, unmount } = renderHook(() => ({
      nlh: useUserThemeSettings('user-1', 'nlh'),
      plo: useUserThemeSettings('user-1', 'plo4'),
      secondNlh: useUserThemeSettings('user-1', 'nlh'),
    }));
    await waitFor(() => expect(result.current.nlh.loading).toBe(false));
    expect(mocks.channelCalls).toBe(1);
    expect(__themeRealtimeChannelCount()).toBe(1);

    act(() => {
      mocks.realtime?.({
        eventType: 'UPDATE',
        new: {
          user_id: 'user-1',
          game_type: 'ALL',
          table_id: 'jade_city',
          background_id: 'place_paris',
        },
        old: {},
      });
    });

    await waitFor(() => {
      for (const table of Object.values(result.current)) {
        expect(table.theme.table_id).toBe('jade_city');
        expect(table.theme.background_id).toBe('place_paris');
      }
    });

    unmount();
    expect(__themeRealtimeChannelCount()).toBe(0);
    expect(mocks.removeCalls).toBe(1);
  });

  it('re-reads authoritative rows after a dropped channel reconnects', async () => {
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.realtimeState).toBe('live'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const readsBeforeDisconnect = mocks.queryCalls;

    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
    });
    expect(result.current.realtimeState).toBe('error');

    // This row changed while the channel was down, so no change event exists to
    // replay. SUBSCRIBED must trigger an authoritative reconciliation read.
    mocks.rows = [
      {
        game_type: 'ALL',
        table_id: 'carbon_ion',
        background_id: 'place_monaco',
        updated_at: '2026-08-30T06:00:00.000Z',
      },
    ];
    act(() => {
      result.current.retryRealtime();
    });

    await waitFor(() => expect(result.current.theme.table_id).toBe('carbon_ion'));
    expect(result.current.theme.background_id).toBe('place_monaco');
    expect(mocks.queryCalls).toBeGreaterThan(readsBeforeDisconnect);
    expect(mocks.channelCalls).toBe(2);
    expect(mocks.removeCalls).toBe(1);
    unmount();
  });

  it('resolves the remaining fallback after a game-specific row is deleted', async () => {
    mocks.rows = [
      { game_type: 'ALL', table_id: 'classic_green', updated_at: '2026-08-01T00:00:00Z' },
      { game_type: 'NLH', table_id: 'jade_city', updated_at: '2026-08-20T00:00:00Z' },
    ];
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.theme.table_id).toBe('jade_city'));

    mocks.rows = [
      { game_type: 'ALL', table_id: 'classic_green', updated_at: '2026-08-01T00:00:00Z' },
    ];
    act(() => {
      mocks.realtime?.({
        eventType: 'DELETE',
        new: {},
        old: { game_type: 'NLH', table_id: 'jade_city' },
      });
    });

    await waitFor(() => expect(result.current.theme.table_id).toBe('classic_green'));
    unmount();
  });

  it('does not overwrite a committed cross-device row with an earlier reconciliation read', async () => {
    mocks.rows = [
      { game_type: 'ALL', table_id: 'classic_green', updated_at: '2026-10-07T04:50:00Z' },
    ];
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.deferRead = true;
    act(() => {
      mocks.realtimeStatus?.('CHANNEL_ERROR');
      mocks.realtimeStatus?.('SUBSCRIBED');
    });
    await waitFor(() => expect(mocks.deferredRead).toBeTypeOf('function'));
    act(() => {
      mocks.realtime?.({
        eventType: 'UPDATE',
        new: {
          user_id: 'user-1',
          game_type: 'ALL',
          table_id: 'carbon_red',
          updated_at: '2026-10-07T04:51:00Z',
        },
      });
    });
    expect(result.current.theme.table_id).toBe('carbon_red');
    await act(async () => {
      mocks.deferredRead?.({ data: mocks.rows, error: null });
    });
    expect(result.current.theme.table_id).toBe('carbon_red');
    // The fence belongs to that read, not to the account forever. A later
    // independent recovery still accepts the current authoritative rows.
    mocks.deferRead = false;
    mocks.rows = [{ game_type: 'ALL', table_id: 'jade_city', updated_at: '2026-10-07T04:52:00Z' }];
    act(() => {
      result.current.retryRealtime();
    });
    await waitFor(() => expect(result.current.theme.table_id).toBe('jade_city'));
    unmount();
  });
  function row(bucket: string, felt: string, updatedAt: string) {
    mocks.realtime?.({
      eventType: 'UPDATE',
      new: {
        user_id: 'user-1',
        game_type: bucket,
        table_id: felt,
        updated_at: updatedAt,
      },
    });
  }

  it.each([
    '2026-10-10 01:50:18.817999+00',
    '2026-10-10T01:50:18.817999+00',
    '2026-10-09 20:50:18.817999-05',
    '2026-10-10 07:20:18.817999+0530',
    '2026-10-10 07:20:18.817999+05:30',
  ])(
    'orders native Realtime timestamp %s with PostgREST versions on every table',
    async (native) => {
      mocks.rows = [
        { game_type: 'ALL', table_id: 'classic_green', updated_at: '2026-10-10T01:50:17Z' },
      ];
      const { result, unmount } = renderHook(() => ({
        first: useUserThemeSettings('user-1', 'nlh'),
        second: useUserThemeSettings('user-1', 'plo4'),
      }));
      await waitFor(() => expect(result.current.first.loading).toBe(false));
      const converted = convertChangeData([{ name: 'updated_at', type: 'timestamptz' }], {
        updated_at: native,
      });
      // The actual SDK does not normalize timestamptz, unlike timestamp.
      expect(converted.updated_at).toBe(native);
      act(() => row('ALL', 'carbon_red', converted.updated_at as string));
      for (const table of Object.values(result.current)) {
        expect(table.theme.table_id).toBe('carbon_red');
      }
      act(() => {
        row('ALL', 'classic_green', '2026-10-10T01:50:18.817998+00:00');
        row('ALL', 'classic_green', '2026-10-10T01:50:18.817999Z');
        row('ALL', 'carbon_red', '2026-10-10T01:50:18.817999Z');
      });
      for (const table of Object.values(result.current)) {
        expect(table.theme.table_id).toBe('carbon_red');
      }
      expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_red');
      act(() => row('ALL', 'jade_city', '2026-10-10T01:50:18.818000Z'));
      for (const table of Object.values(result.current)) {
        expect(table.theme.table_id).toBe('jade_city');
      }
      unmount();
    }
  );

  it('uses native server versions for cached ALL precedence and the read fence', async () => {
    mocks.rows = [
      { game_type: 'ALL', table_id: 'carbon_red', updated_at: '2026-10-10 01:50:18.817999+00' },
      { game_type: 'NLH', table_id: 'jade_city', updated_at: '2026-10-10T01:50:18.817998Z' },
    ];
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.theme.table_id).toBe('carbon_red');
    act(() => row('ALL', 'classic_green', '2026-10-10T01:50:18.817998Z'));
    expect(result.current.theme.table_id).toBe('carbon_red');
    expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_red');
    unmount();
  });

  it.each([
    '2026-10-10 01:50:18.817999',
    '2026-10-10 01:50:18.8179999+00',
    '2026-10-10 01:50:18+0',
    '2026-10-10 01:50:18+24',
    '2026-10-10 01:50:18+00:60',
    'not-a-server-timestamp',
  ])(
    'refuses malformed or unzoned server timestamp %s without changing paint or cache',
    async (bad) => {
      mocks.rows = [
        { game_type: 'ALL', table_id: 'carbon_red', updated_at: '2026-10-10T01:50:17Z' },
      ];
      const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => row('ALL', 'classic_green', bad));
      expect(result.current.theme.table_id).toBe('carbon_red');
      expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_red');
      unmount();
    }
  );

  it('rejects an older same-bucket DB row without changing paint or first-paint cache', async () => {
    const { result, unmount } = renderHook(() => ({
      first: useUserThemeSettings('user-1', 'nlh'),
      second: useUserThemeSettings('user-1', 'nlh'),
    }));
    await waitFor(() => expect(result.current.first.loading).toBe(false));
    act(() => {
      row('ALL', 'carbon_red', '2026-10-10T00:14:07.406955+00:00');
      row('ALL', 'classic_green', '2026-10-10T00:14:07.406954+00:00');
    });
    expect(result.current.first.theme.table_id).toBe('carbon_red');
    expect(result.current.second.theme.table_id).toBe('carbon_red');
    expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_red');
    unmount();
  });

  it('seeds the server fence from a successful database read', async () => {
    mocks.rows = [{ game_type: 'ALL', table_id: 'carbon_red', updated_at: '2026-10-10T00:14:07Z' }];
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => row('ALL', 'classic_green', '2026-10-10T00:14:06Z'));
    expect(result.current.theme.table_id).toBe('carbon_red');
    unmount();
  });

  it('accepts equal-version fanout but refuses a conflicting value at that version', async () => {
    const { result, unmount } = renderHook(() => ({
      first: useUserThemeSettings('user-1', 'nlh'),
      second: useUserThemeSettings('user-1', 'plo4'),
    }));
    await waitFor(() => expect(result.current.first.loading).toBe(false));
    act(() => {
      row('ALL', 'carbon_red', '2026-10-10T00:14:07Z');
      row('ALL', 'carbon_red', '2026-10-10T00:14:07Z');
      row('ALL', 'classic_green', '2026-10-10T00:14:07Z');
    });
    expect(result.current.first.theme.table_id).toBe('carbon_red');
    expect(result.current.second.theme.table_id).toBe('carbon_red');
    unmount();
  });

  it('resolves older/newer ALL and per-game rows through the same cached precedence', async () => {
    mocks.rows = [
      { game_type: 'ALL', table_id: 'classic_green', updated_at: '2026-10-10T00:10:00Z' },
      { game_type: 'NLH', table_id: 'jade_city', updated_at: '2026-10-10T00:12:00Z' },
    ];
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => row('ALL', 'ocean_blue', '2026-10-10T00:11:00Z'));
    expect(result.current.theme.table_id).toBe('jade_city');
    act(() => row('ALL', 'carbon_red', '2026-10-10T00:14:00Z'));
    expect(result.current.theme.table_id).toBe('carbon_red');
    act(() => row('NLH', 'classic_green', '2026-10-10T00:13:00Z'));
    expect(result.current.theme.table_id).toBe('carbon_red');
    act(() => row('NLH', 'jade_city', '2026-10-10T00:15:00Z'));
    expect(result.current.theme.table_id).toBe('jade_city');
    unmount();
  });

  it('does not use a skewed client confirmation timestamp to refuse a later server save', async () => {
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => row('ALL', 'classic_green', '2026-10-10T00:10:00Z'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    act(() => {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'skew',
        state: 'pending',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'jade_city' },
        userId: 'user-1',
        mutationId: 'skew',
      });
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'skew',
        state: 'confirmed',
      });
      row('ALL', 'carbon_red', '2026-10-10T00:12:00Z');
    });
    vi.useRealTimers();
    expect(result.current.theme.table_id).toBe('carbon_red');
    expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_red');
    unmount();
  });

  it('retains server ordering while pending paints and a failed rollback own their fields', async () => {
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      row('ALL', 'classic_green', '2026-10-10T00:10:00Z');
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'fail',
        state: 'pending',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'jade_city' },
        userId: 'user-1',
        mutationId: 'fail',
      });
      row('ALL', 'carbon_red', '2026-10-10T00:12:00Z');
    });
    expect(result.current.theme.table_id).toBe('jade_city');
    act(() => {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'fail',
        state: 'rolling-back',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'classic_green' },
        userId: 'user-1',
        mutationId: 'fail',
      });
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'fail',
        state: 'rolled-back',
      });
      row('ALL', 'ocean_blue', '2026-10-10T00:11:00Z');
    });
    expect(result.current.theme.table_id).toBe('classic_green');
    act(() => row('ALL', 'carbon_red', '2026-10-10T00:12:00Z'));
    expect(result.current.theme.table_id).toBe('carbon_red');
    unmount();
  });
});
