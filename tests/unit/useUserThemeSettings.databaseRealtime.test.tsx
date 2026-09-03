import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  channelCalls: 0,
  removeCalls: 0,
  queryCalls: 0,
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

import {
  __themeRealtimeChannelCount,
  useUserThemeSettings,
} from '../../src/hooks/useUserThemeSettings';

describe('useUserThemeSettings database realtime', () => {
  beforeEach(() => {
    mocks.channelCalls = 0;
    mocks.removeCalls = 0;
    mocks.queryCalls = 0;
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
});
