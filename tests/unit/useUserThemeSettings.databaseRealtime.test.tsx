import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  channelCalls: 0,
  removeCalls: 0,
  realtime: undefined as undefined | ((payload: Record<string, unknown>) => void),
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
    subscribe: vi.fn(() => channel),
  };
  return {
    supabase: {
      from: vi.fn(() => {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
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
    mocks.realtime = undefined;
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
});
