import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type BusEvent = { payload: Record<string, unknown> };
type ProfileRead = () => Promise<{
  data: { settings?: unknown } | null;
  error: unknown;
}>;

const mocks = vi.hoisted(() => ({
  localUserId: null as string | null,
  reads: new Map<string, ProfileRead>(),
  listeners: new Map<string, Set<(event: BusEvent) => void>>(),
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () =>
    mocks.localUserId
      ? {
          userId: mocks.localUserId,
          username: null,
          expiresAt: Date.now() + 60_000,
          accessToken: 'test-token',
          rawData: {},
        }
      : null,
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: vi.fn((type: string, listener: (event: BusEvent) => void) => {
      const listeners = mocks.listeners.get(type) || new Set<(event: BusEvent) => void>();
      listeners.add(listener);
      mocks.listeners.set(type, listeners);
      return () => listeners.delete(listener);
    }),
    emit: vi.fn((type: string, payload: Record<string, unknown>) => {
      for (const listener of mocks.listeners.get(type) || []) listener({ payload });
    }),
  },
}));

vi.mock('../../src/lib/ownProfile', () => ({
  ownProfile: (userId: string) => ({
    select: (columns: string) => {
      if (columns !== 'settings') throw new Error(`Unexpected columns: ${columns}`);
      return {
        maybeSingle: () => {
          const read = mocks.reads.get(userId);
          if (!read) throw new Error(`No profile read arranged for ${userId}`);
          return read();
        },
      };
    },
  }),
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));

import { masterBus } from '../../src/core/MasterBus';
import { useInterfaceThemeHydration } from '../../src/hooks/useInterfaceThemeHydration';
import { interfaceThemeCacheKey, useSettingsStore } from '../../src/stores/useSettingsStore';

function resolvedTheme(theme: 'light' | 'dark' | 'auto'): ProfileRead {
  return () => Promise.resolve({ data: { settings: { theme } }, error: null });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useInterfaceThemeHydration', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.localUserId = null;
    mocks.reads.clear();
    mocks.listeners.clear();
    mocks.reportError.mockReset();
    useSettingsStore.setState({
      theme: 'dark',
      themePreference: 'dark',
      interfaceThemeUserId: null,
      interfaceThemeScopeReady: false,
      interfaceThemeHydrationState: 'idle',
    });
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  });

  it('hydrates a fresh device from the signed-in profile and caches it by account', async () => {
    mocks.localUserId = 'user-a';
    mocks.reads.set('user-a', resolvedTheme('light'));

    renderHook(() => useInterfaceThemeHydration());

    await waitFor(() => expect(useSettingsStore.getState().theme).toBe('light'));
    expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('ready');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem(interfaceThemeCacheKey('user-a'))).toBe('light');
  });

  it('preserves Auto as the durable preference while resolving the current device mode', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    mocks.localUserId = 'user-a';
    mocks.reads.set('user-a', resolvedTheme('auto'));

    renderHook(() => useInterfaceThemeHydration());

    await waitFor(() =>
      expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('ready')
    );
    expect(useSettingsStore.getState()).toMatchObject({
      theme: 'light',
      themePreference: 'auto',
      interfaceThemeUserId: 'user-a',
    });
    expect(localStorage.getItem(interfaceThemeCacheKey('user-a'))).toBe('auto');
    vi.unstubAllGlobals();
  });

  it('fences A before B paints and then hydrates B in the same React context', async () => {
    mocks.localUserId = 'user-a';
    localStorage.setItem(interfaceThemeCacheKey('user-a'), 'light');
    mocks.reads.set('user-a', resolvedTheme('light'));
    mocks.reads.set('user-b', resolvedTheme('dark'));
    renderHook(() => useInterfaceThemeHydration());
    await waitFor(() => expect(useSettingsStore.getState().theme).toBe('light'));

    act(() => {
      masterBus.emit('AUTH_STATE_CHANGED', { userId: 'user-b', isAuthenticated: true });
    });

    expect(useSettingsStore.getState().interfaceThemeUserId).toBe('user-b');
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await waitFor(() =>
      expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('ready')
    );
  });

  it('ignores a stale A response that resolves after the auth scope changed to B', async () => {
    const staleA = deferred<{ data: { settings: { theme: 'light' } }; error: null }>();
    mocks.localUserId = 'user-a';
    mocks.reads.set('user-a', () => staleA.promise);
    mocks.reads.set('user-b', resolvedTheme('dark'));
    renderHook(() => useInterfaceThemeHydration());

    act(() => {
      masterBus.emit('AUTH_STATE_CHANGED', { userId: 'user-b', isAuthenticated: true });
    });
    await waitFor(() =>
      expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('ready')
    );

    await act(async () => {
      staleA.resolve({ data: { settings: { theme: 'light' } }, error: null });
      await staleA.promise;
    });

    expect(useSettingsStore.getState().interfaceThemeUserId).toBe('user-b');
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(localStorage.getItem(interfaceThemeCacheKey('user-b'))).toBe('dark');
  });

  it('keeps the account cache on bounded read failure and marks hydration unknown', async () => {
    mocks.localUserId = 'user-b';
    localStorage.setItem(interfaceThemeCacheKey('user-a'), 'light');
    localStorage.setItem(interfaceThemeCacheKey('user-b'), 'dark');
    mocks.reads.set('user-b', () =>
      Promise.resolve({ data: null, error: { code: '500', message: 'offline' } })
    );

    renderHook(() => useInterfaceThemeHydration());

    await waitFor(() =>
      expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('error')
    );
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });
});
