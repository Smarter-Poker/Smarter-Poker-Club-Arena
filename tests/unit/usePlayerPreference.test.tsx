import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const state = vi.hoisted(() => ({
  row: null as null | { value: unknown },
  writes: [] as any[],
  error: null as unknown,
  read: null as Promise<any> | null,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => {
        const builder = {
          eq: () => builder,
          maybeSingle: () => state.read ?? Promise.resolve({ data: state.row, error: null }),
        };
        return builder;
      },
      upsert: async (row: any) => {
        state.writes.push(row);
        return { error: state.error };
      },
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useUserStore } from '../../src/stores/useUserStore';
import { usePlayerPreference } from '../../src/hooks/usePlayerPreference';
import { readTableSettingIntent } from '../../src/lib/tableSettingIntents';
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
beforeEach(() => {
  localStorage.clear();
  state.row = null;
  state.writes = [];
  state.error = null;
  state.read = null;
  useUserStore.setState({ user: { id: 'preference-a' } as any });
});
afterEach(() => vi.useRealTimers());
it('saves a selection immediately and restores it after remount without writing defaults', async () => {
  const first = renderHook(() => usePlayerPreference('history:filter', 'all'), { wrapper });
  act(() => first.result.current[1]('mine'));
  expect(localStorage.getItem('ca_player_preference:preference-a:history:filter:global')).toBe(
    '"mine"'
  );
  first.unmount();
  await waitFor(() => expect(state.writes).toHaveLength(1));
  const second = renderHook(() => usePlayerPreference('history:filter', 'all'), { wrapper });
  expect(second.result.current[0]).toBe('mine');
  await act(async () => {});
  expect(state.writes).toHaveLength(1);
});
it('does not replace a newer selection when an older read arrives', async () => {
  let reply!: (value: any) => void;
  state.read = new Promise((resolve) => {
    reply = resolve;
  });
  const { result, unmount } = renderHook(() => usePlayerPreference('history:sort', 'recent'), {
    wrapper,
  });
  act(() => result.current[1]('largest'));
  await act(async () => {
    reply({ data: { value: 'recent' }, error: null });
  });
  expect(result.current[0]).toBe('largest');
  unmount();
  await act(async () => {});
});
it('keeps failed account saves pending across remount and refuses another account cache', async () => {
  state.error = { message: 'offline' };
  const first = renderHook(() => usePlayerPreference('history:filter', 'all'), { wrapper });
  act(() => first.result.current[1]('mine'));
  first.unmount();
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(readTableSettingIntent('preference-a', 'page:history:filter:global')).not.toBeNull();
  state.row = { value: 'all' };
  const second = renderHook(() => usePlayerPreference('history:filter', 'all'), { wrapper });
  expect(second.result.current[0]).toBe('mine');
  await act(async () => {});
  act(() => useUserStore.setState({ user: { id: 'preference-b' } as any }));
  expect(second.result.current[0]).toBe('all');
});
it('flushes one final search value instead of writing every keystroke', async () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => usePlayerPreference('history:search', ''), {
    wrapper,
  });
  act(() => {
    for (const value of ['a', 'ab', 'abc']) result.current[1](value);
  });
  expect(state.writes).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(state.writes.map((row) => row.value)).toEqual(['abc']);
  unmount();
});
