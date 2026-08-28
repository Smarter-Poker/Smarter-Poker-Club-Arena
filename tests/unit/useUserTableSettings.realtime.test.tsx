import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type BusHandler = (event: { payload: any }) => void;
const handlers = new Map<string, BusHandler[]>();
const emitted: Array<{ event: string; payload: any }> = [];

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (event: string, handler: BusHandler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return () => {
        const current = handlers.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    emit: (event: string, payload: any) => {
      emitted.push({ event, payload });
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ payload });
    },
  },
}));

const rows: Record<string, unknown>[] = [];
const writeResults: Array<Promise<{ error: unknown }>> = [];

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
      upsert: (row: Record<string, unknown>) => {
        rows.push(row);
        return writeResults.shift() ?? Promise.resolve({ error: null });
      },
    }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useUserTableSettings } from '../../src/hooks/useUserTableSettings';

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  rows.length = 0;
  writeResults.length = 0;
  localStorage.clear();
});

describe('useUserTableSettings live mutation ordering', () => {
  it('ignores the legacy global cache instead of leaking another account settings', async () => {
    localStorage.setItem(
      'user_table_settings_cache',
      JSON.stringify({ blue_buttons_enabled: true })
    );
    const { result } = renderHook(() => useUserTableSettings('user-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings.blue_buttons_enabled).toBe(false);
  });

  it('two rapid visual toggles are calculated and persisted in tap order', async () => {
    const { result } = renderHook(() => useUserTableSettings('user-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveFirst: ((value: { error: null }) => void) | undefined;
    writeResults.push(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
      Promise.resolve({ error: null })
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.toggleSetting('blue_buttons_enabled');
      second = result.current.toggleSetting('blue_buttons_enabled');
    });

    expect(result.current.settings.blue_buttons_enabled).toBe(false);
    expect(
      emitted
        .filter(({ event }) => event === 'SETTINGS_CHANGED')
        .slice(0, 2)
        .map(({ payload }) => payload.value)
    ).toEqual([true, false]);
    await Promise.resolve();
    expect(rows.map((row) => row.blue_buttons_enabled)).toEqual([true]);

    resolveFirst?.({ error: null });
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(rows.map((row) => row.blue_buttons_enabled)).toEqual([true, false]);
    expect(result.current.settings.blue_buttons_enabled).toBe(false);
  });

  it('a rejected optimistic toggle rolls back every mounted table', async () => {
    writeResults.push(Promise.resolve({ error: { message: 'denied' } }));
    const { result } = renderHook(() => {
      const first = useUserTableSettings('user-1');
      const second = useUserTableSettings('user-1');
      return { first, second };
    });
    await waitFor(() => {
      expect(result.current.first.loading).toBe(false);
      expect(result.current.second.loading).toBe(false);
    });

    await act(async () => {
      await result.current.first.toggleSetting('blue_buttons_enabled');
    });

    expect(result.current.first.settings.blue_buttons_enabled).toBe(false);
    expect(result.current.second.settings.blue_buttons_enabled).toBe(false);
    expect(
      emitted
        .filter(({ event }) => event === 'SETTINGS_CHANGED')
        .map(({ payload }) => payload.value)
    ).toEqual([true, false]);
  });

  it('two rejected rapid toggles return to the last durable value', async () => {
    writeResults.push(
      Promise.resolve({ error: { message: 'first denied' } }),
      Promise.resolve({ error: { message: 'second denied' } })
    );
    const { result } = renderHook(() => useUserTableSettings('user-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.toggleSetting('blue_buttons_enabled');
      second = result.current.toggleSetting('blue_buttons_enabled');
    });
    await act(async () => Promise.all([first, second]));

    expect(result.current.settings.blue_buttons_enabled).toBe(false);
    expect(
      emitted
        .filter(({ event }) => event === 'SETTINGS_CHANGED')
        .map(({ payload }) => payload.value)
    ).toEqual([true, false, false]);
  });

  it('does not let an old account failed write roll back the newly signed-in account', async () => {
    let resolveOldWrite: ((value: { error: unknown }) => void) | undefined;
    writeResults.push(
      new Promise((resolve) => {
        resolveOldWrite = resolve;
      })
    );
    localStorage.setItem(
      'user_table_settings_cache:user-2',
      JSON.stringify({ blue_buttons_enabled: true })
    );

    const { result, rerender } = renderHook(({ userId }) => useUserTableSettings(userId), {
      initialProps: { userId: 'user-1' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let oldWrite!: Promise<void>;
    act(() => {
      oldWrite = result.current.toggleSetting('blue_buttons_enabled');
    });
    expect(result.current.settings.blue_buttons_enabled).toBe(true);

    rerender({ userId: 'user-2' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.settings.blue_buttons_enabled).toBe(true);
    });

    resolveOldWrite?.({ error: { message: 'old account denied' } });
    await act(async () => oldWrite);

    expect(result.current.settings.blue_buttons_enabled).toBe(true);
  });
});
