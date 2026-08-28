/**
 * Visual changes are discrete user actions, not snapshots to deduplicate.
 * These tests pin the two cross-tab contracts that every mounted table relies
 * on: repeated appearance events are delivered in order, and light/dark mode
 * received from another tab updates the persisted UI store immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The global harness intentionally replaces MasterBus with a no-op. This suite
// verifies the transport itself, so restore the production implementation.
vi.mock('../../src/core/MasterBus', async () => await vi.importActual('../../src/core/MasterBus'));

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
});

afterEach(async () => {
  const { masterBus } = await import('../../src/core/MasterBus');
  masterBus.reset();
  vi.unstubAllGlobals();
});

describe('live customization bus', () => {
  it('applies a cross-tab light/dark event to Zustand and the DOM', async () => {
    const { masterBus } = await import('../../src/core/MasterBus');
    const { useSettingsStore } = await import('../../src/stores/useSettingsStore');
    masterBus.reset();
    masterBus.init();
    useSettingsStore.setState({ theme: 'dark' });
    localStorage.setItem(
      'club-arena-user-settings',
      JSON.stringify({ theme: 'dark', soundEnabled: false })
    );

    masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: 'light' });

    expect(useSettingsStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(JSON.parse(localStorage.getItem('club-arena-user-settings') || '{}')).toEqual({
      theme: 'light',
      soundEnabled: false,
    });
  });

  it("does not apply another account's light/dark event", async () => {
    const { masterBus } = await import('../../src/core/MasterBus');
    const { useSettingsStore } = await import('../../src/stores/useSettingsStore');
    const { useUserStore } = await import('../../src/stores/useUserStore');
    masterBus.reset();
    masterBus.init();
    useSettingsStore.setState({ theme: 'dark' });
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
    const { masterBus } = await import('../../src/core/MasterBus');
    const { useSettingsStore } = await import('../../src/stores/useSettingsStore');
    const { useUserStore } = await import('../../src/stores/useUserStore');
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
    const { masterBus } = await import('../../src/core/MasterBus');
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
