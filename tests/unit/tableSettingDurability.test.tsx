import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  writes: [] as Array<{ row: any; resolve: (value: any) => void }>,
  row: {} as Record<string, unknown>,
  handlers: new Map<string, Array<(event: any) => void>>(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }),
      }),
      upsert: (row: any) => new Promise((resolve) => state.writes.push({ row, resolve })),
    }),
    rpc: async () => ({ error: null }),
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (name: string, payload: any) =>
      state.handlers.get(name)?.forEach((fn) => fn({ payload })),
    subscribe: (name: string, fn: (event: any) => void) => {
      const list = state.handlers.get(name) ?? [];
      list.push(fn);
      state.handlers.set(name, list);
      return () => {
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
  },
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    setEnabled: vi.fn(),
    setMasterVolume: vi.fn(),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { masterBus } from '../../src/core/MasterBus';
import { useUserStore } from '../../src/stores/useUserStore';
import {
  useTableSettings,
  __resetTableSettingsStoreForTest,
} from '../../src/hooks/useTableSettings';

beforeEach(() => {
  localStorage.clear();
  state.handlers.clear();
  state.writes.length = 0;
  state.row = { settings_touched: ['show_ticker'], show_ticker: true };
  __resetTableSettingsStoreForTest();
  useUserStore.setState({ user: { id: 'durability-user' } as any });
});

it('does not let a stale database echo reset a newer selection', async () => {
  const { result } = renderHook(() => useTableSettings());
  await act(async () => {});
  act(() => result.current.updateSetting('showTicker', false));
  act(() =>
    masterBus.emit('SETTINGS_CHANGED', {
      setting: 'show_ticker',
      value: true,
      userId: 'durability-user',
      origin: 'postgres-sync:user-table-settings',
    })
  );
  expect(result.current.settings.showTicker).toBe(false);
  state.writes[0].resolve({ error: null });
  await act(async () => {});
});

it('persists rapid changes in selection order', async () => {
  const { result } = renderHook(() => useTableSettings());
  await act(async () => {});
  act(() => {
    result.current.updateSetting('showTicker', false);
    result.current.updateSetting('showTicker', true);
  });
  expect(state.writes.map((w) => w.row.show_ticker)).toEqual([false]);
  state.writes[0].resolve({ error: null });
  await waitFor(() => expect(state.writes).toHaveLength(2));
  state.writes[1].resolve({ error: null });
  await act(async () => {});
});

it('preserves a failed save across a store restart instead of accepting the older row', async () => {
  const first = renderHook(() => useTableSettings());
  await act(async () => {});
  act(() => first.result.current.updateSetting('showTicker', false));
  state.writes[0].resolve({ error: { message: 'offline' } });
  await act(async () => {});
  first.unmount();
  state.handlers.clear();
  __resetTableSettingsStoreForTest();
  const second = renderHook(() => useTableSettings());
  await act(async () => {});
  expect(second.result.current.settings.showTicker).toBe(false);
  expect(state.writes).toHaveLength(2);
  state.writes[1].resolve({ error: null });
  await act(async () => {});
});
