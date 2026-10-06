/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSettingsStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { interfaceThemeCacheKey, useSettingsStore } from '../../src/stores/useSettingsStore';
import { readSettingsPageCache, writeSettingsPageCache } from '../../src/lib/settingsPageCache';

describe('useSettingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      theme: 'dark',
      themePreference: 'dark',
      interfaceThemeUserId: null,
      interfaceThemeScopeReady: false,
      interfaceThemeHydrationState: 'idle',
    });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  /* ── INVERTED 2026-08-29 ────────────────────────────────────────────────────
     Four cases here pinned `soundEnabled`, `notificationsEnabled`,
     `toggleSound` and `toggleNotifications`. They tested that dead code
     existed, which is the least useful thing a test can do — and worse than
     useless here, because the state they pinned was a FOURTH persisted copy of
     "is sound on" (after `ca_sound_enabled`, `club_arena_sounds` and
     `TableUserSettings.isSoundEnabled` plus its column) sitting in localStorage
     free to disagree with the real ones forever.

     Repo-wide, the only members ever read off this store are `theme` and
     `setTheme`; the three toggles had zero call sites and the three fields zero
     readers. All six are gone. What replaces those cases is the assertion that
     they stay gone — `tests/unit/settingsHaveOneOwner.test.ts`, "the zustand
     store keeps only the interface mode it actually owns" — because the real
     risk was never that they broke. It was that somebody would find a
     plausibly-named `toggleSound` and wire a switch to it. */

  it('should have dark theme by default', () => {
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('should set theme to light', () => {
    useSettingsStore.getState().setTheme('light');
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('should set theme back to dark', () => {
    useSettingsStore.getState().setTheme('light');
    useSettingsStore.getState().setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('keeps the full Settings page cache synchronized without replacing other preferences', () => {
    writeSettingsPageCache('user-1', {
      theme: 'dark',
      soundVolume: 42,
      cardBack: 'classic_red',
    });

    useSettingsStore.getState().bindInterfaceThemeScope('user-1');
    useSettingsStore.getState().setTheme('light', 'user-1');

    expect(readSettingsPageCache('user-1')).toEqual({
      theme: 'light',
      soundVolume: 42,
      cardBack: 'classic_red',
    });
    expect(localStorage.getItem('club-arena-user-settings')).toBeNull();
  });

  it('hydrates the first frame only from the active account cache', () => {
    localStorage.setItem('club-arena-settings', JSON.stringify({ state: { theme: 'light' } }));
    localStorage.setItem(interfaceThemeCacheKey('user-a'), 'light');
    localStorage.setItem(interfaceThemeCacheKey('user-b'), 'dark');

    useSettingsStore.getState().bindInterfaceThemeScope('user-a');
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    useSettingsStore.getState().bindInterfaceThemeScope('user-b');
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('club-arena-settings')).toBeNull();
  });

  it('resets a cache miss to dark instead of showing the previous account', () => {
    localStorage.setItem(interfaceThemeCacheKey('user-a'), 'light');
    useSettingsStore.getState().bindInterfaceThemeScope('user-a');
    expect(useSettingsStore.getState().theme).toBe('light');

    useSettingsStore.getState().bindInterfaceThemeScope('user-b');
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(useSettingsStore.getState().interfaceThemeHydrationState).toBe('loading');
  });

  it('rejects a stale response or rollback from the previous auth scope', () => {
    useSettingsStore.getState().bindInterfaceThemeScope('user-a');
    useSettingsStore.getState().applyAuthoritativeInterfaceTheme('user-a', 'light');
    useSettingsStore.getState().bindInterfaceThemeScope('user-b');

    expect(useSettingsStore.getState().applyAuthoritativeInterfaceTheme('user-a', 'light')).toBe(
      false
    );
    useSettingsStore.getState().setTheme('light', 'user-a');

    expect(useSettingsStore.getState().interfaceThemeUserId).toBe('user-b');
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(localStorage.getItem(interfaceThemeCacheKey('user-b'))).toBeNull();
  });

  it('preserves Auto as the account preference while applying its effective mode', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    useSettingsStore.getState().bindInterfaceThemeScope('user-a');
    useSettingsStore.getState().setTheme('auto', 'user-a');

    expect(useSettingsStore.getState()).toMatchObject({
      theme: 'light',
      themePreference: 'auto',
      interfaceThemeUserId: 'user-a',
    });
    expect(localStorage.getItem(interfaceThemeCacheKey('user-a'))).toBe('auto');
    vi.unstubAllGlobals();
  });

  it('exports the one action it owns, and no revived duplicates', () => {
    const state = useSettingsStore.getState() as Record<string, unknown>;
    expect(typeof state.setTheme).toBe('function');
    for (const gone of [
      'toggleSound',
      'toggleFourColorDeck',
      'toggleNotifications',
      'soundEnabled',
      'fourColorDeck',
      'notificationsEnabled',
    ]) {
      expect(state[gone], `${gone} is a duplicate of a preference owned elsewhere`).toBeUndefined();
    }
  });
});
