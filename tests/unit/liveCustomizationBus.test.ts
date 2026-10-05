/**
 * Visual changes are discrete user actions, not snapshots to deduplicate.
 * These tests pin the two cross-tab contracts that every mounted table relies
 * on: repeated appearance events are delivered in order, and light/dark mode
 * received from another tab updates the persisted UI store immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { masterBus } from '../../src/core/MasterBus';
import { readSettingsPageCache, writeSettingsPageCache } from '../../src/lib/settingsPageCache';
import { useSettingsStore } from '../../src/stores/useSettingsStore';
import { useUserStore } from '../../src/stores/useUserStore';

// The global harness intentionally replaces MasterBus with a no-op. This suite
// verifies the transport itself, so restore the production implementation.
// `vi.unmock` is hoisted, so the production module is collected once before
// test timeouts begin. The former per-test dynamic import could time out while
// the full suite saturated the transform pool, then leave an incomplete module
// cached with `masterBus: undefined` for every remaining assertion.
vi.unmock('../../src/core/MasterBus');

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    value: FakeBroadcastChannel,
  });
  localStorage.clear();
  useUserStore.setState({ user: null, isAuthenticated: false });
  useSettingsStore.setState({
    theme: 'dark',
    themePreference: 'dark',
    interfaceThemeUserId: null,
    interfaceThemeScopeReady: false,
    interfaceThemeHydrationState: 'idle',
  });
});

afterEach(() => {
  masterBus.reset();
  vi.unstubAllGlobals();
});

describe('live customization bus', () => {
  it('applies a cross-tab light/dark event to Zustand and the DOM', async () => {
    masterBus.reset();
    masterBus.init();
    useSettingsStore.getState().bindInterfaceThemeScope('user-1');
    useUserStore.setState({ user: { id: 'user-1' } as never });
    writeSettingsPageCache('user-1', { theme: 'dark', soundEnabled: false });

    masterBus.emit('UI_THEME_CHANGED', {
      key: 'theme',
      value: 'light',
      userId: 'user-1',
    });

    expect(useSettingsStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(readSettingsPageCache('user-1')).toEqual({
      theme: 'light',
      soundEnabled: false,
    });
    expect(localStorage.getItem('club-arena-user-settings')).toBeNull();
  });

  it("does not apply another account's light/dark event", async () => {
    masterBus.reset();
    masterBus.init();
    useSettingsStore.getState().bindInterfaceThemeScope('user-1');
    useUserStore.setState({ user: { id: 'user-1' } as never });

    masterBus.emit('UI_THEME_CHANGED', {
      key: 'theme',
      value: 'light',
      userId: 'user-2',
    });

    expect(useSettingsStore.getState().theme).toBe('dark');
    useUserStore.setState({ user: null });
  });

  it('does not apply a signed-in account theme after that account logs out', async () => {
    masterBus.reset();
    masterBus.init();
    useSettingsStore.setState({ theme: 'dark' });
    useUserStore.setState({ user: null });

    masterBus.emit('UI_THEME_CHANGED', {
      key: 'theme',
      value: 'light',
      userId: 'signed-out-user',
    });

    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('never deduplicates ordered player appearance taps or rollbacks', async () => {
    masterBus.reset();
    masterBus.init();
    const seen: string[] = [];
    const off = masterBus.subscribe('PLAYER_APPEARANCE_CHANGED', (event) => {
      seen.push(event.payload.avatar || '');
    });
    const payload = {
      userId: 'user-1',
      avatar: '/avatars/table/free_shark@2x.webp',
      source: 'avatar-picker' as const,
    };

    masterBus.emit('PLAYER_APPEARANCE_CHANGED', payload);
    masterBus.emit('PLAYER_APPEARANCE_CHANGED', payload);

    off();
    expect(seen).toEqual([payload.avatar, payload.avatar]);
  });
});

it('preserves Auto across a cross-device theme event and persistence', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  masterBus.reset();
  masterBus.init();
  useUserStore.setState({ user: { id: 'user-1' } as never });
  useSettingsStore.getState().bindInterfaceThemeScope('user-1');
  writeSettingsPageCache('user-1', { theme: 'dark', soundVolume: 42 });
  masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: 'auto', userId: 'user-1' });
  expect(useSettingsStore.getState()).toMatchObject({ theme: 'light', themePreference: 'auto' });
  expect(readSettingsPageCache('user-1')).toEqual({ theme: 'auto', soundVolume: 42 });
  expect(localStorage.getItem('club-arena-user-settings')).toBeNull();
});

it.each(['PROFILE_UPDATED', 'SETTINGS_UPDATED', 'DIAMOND_BALANCE_CHANGED'] as const)(
  'fences private %s before dispatch from another browser account',
  (type) => {
    masterBus.reset();
    masterBus.init();
    useUserStore.setState({ user: { id: 'user-1' } as never });
    const seen = vi.fn();
    const off = masterBus.subscribe(type, seen);
    masterBus.emit(
      type,
      {
        userId: 'user-2',
        source: 'profile-account',
        updates: {},
        settings: {},
        newBalance: 999,
        delta: 0,
      },
      true
    );
    expect(seen).not.toHaveBeenCalled();
    masterBus.emit(
      type,
      {
        userId: 'user-1',
        source: 'profile-account',
        updates: {},
        settings: {},
        newBalance: 999,
        delta: 0,
      },
      true
    );
    expect(seen).toHaveBeenCalledOnce();
    off();
  }
);
