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

  /* ── INVERTED 2026-08-29 ──────────────────────────────────────────────────
     Two specs here used to pin the rollback: "a rejected optimistic toggle
     rolls back every mounted table" and "two rejected rapid toggles return to
     the last durable value". Both described real behaviour and both described
     a bug. Dan, binding: "NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER
     CHANGES THEM MANUALLY." A dropped request is not the user changing
     anything, and the sister hook `useTableSettings` had already been fixed
     the other way, so the two hooks disagreed about the same table.

     What is pinned now is the replacement: retry quietly, then HOLD the value
     and say so once. The old expectations are kept above in words so nobody
     reads the new ones as a weakening. */

  const valuesOf = (event: string) =>
    emitted.filter((e) => e.event === event).map(({ payload }) => payload.value);
  const toasts = () => emitted.filter((e) => e.event === 'SHOW_TOAST');
  const mutationStates = () =>
    emitted.filter((e) => e.event === 'CUSTOMIZATION_MUTATION_STATE').map((e) => e.payload.state);

  it('a save that fails every attempt holds the value on every mounted table', async () => {
    // Three, because the write is retried twice before anyone is told.
    writeResults.push(
      Promise.resolve({ error: { message: 'denied' } }),
      Promise.resolve({ error: { message: 'denied' } }),
      Promise.resolve({ error: { message: 'denied' } })
    );
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

    // THE SWITCH STAYS WHERE THE USER PUT IT — here and on the other table.
    expect(result.current.first.settings.blue_buttons_enabled).toBe(true);
    expect(result.current.second.settings.blue_buttons_enabled).toBe(true);
    // One broadcast, the user's. No second one undoing it.
    expect(valuesOf('SETTINGS_CHANGED')).toEqual([true]);
    // And the user is told, rather than left believing it synced.
    expect(toasts()).toHaveLength(1);
    expect(mutationStates()).toContain('save-failed');
    expect(mutationStates()).not.toContain('rolled-back');
  });

  it('a write that succeeds on retry never bothers the user', async () => {
    // One failure, then the shared default success from the supabase mock.
    writeResults.push(Promise.resolve({ error: { message: 'blip' } }));
    const { result } = renderHook(() => useUserTableSettings('user-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleSetting('blue_buttons_enabled');
    });

    expect(result.current.settings.blue_buttons_enabled).toBe(true);
    expect(toasts(), 'a blip that recovered is not news').toHaveLength(0);
    expect(mutationStates()).toContain('confirmed');
  });

  it('two rapid failed toggles keep the SECOND tap, and the first stops retrying', async () => {
    /* The first toggle is superseded while it waits to retry, so it abandons
       without a word — re-writing its older value is exactly the auto-change-
       back this whole change removes. Four results: one for the first attempt
       of tap 1, three for tap 2. */
    writeResults.push(
      Promise.resolve({ error: { message: 'first denied' } }),
      Promise.resolve({ error: { message: 'second denied' } }),
      Promise.resolve({ error: { message: 'second denied' } }),
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
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(result.current.settings.blue_buttons_enabled).toBe(false);
    expect(valuesOf('SETTINGS_CHANGED')).toEqual([true, false]);
    // The superseded tap is silent; only the tap that owns the column speaks.
    expect(toasts()).toHaveLength(1);
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
