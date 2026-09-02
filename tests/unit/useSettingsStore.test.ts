/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSettingsStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { useSettingsStore } from '../../src/stores/useSettingsStore';

describe('useSettingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ theme: 'dark' });
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
    localStorage.setItem(
      'club-arena-user-settings',
      JSON.stringify({ theme: 'dark', soundVolume: 42, cardBack: 'classic_red' })
    );

    useSettingsStore.getState().setTheme('light', 'user-1');

    expect(JSON.parse(localStorage.getItem('club-arena-user-settings') || '{}')).toEqual({
      theme: 'light',
      soundVolume: 42,
      cardBack: 'classic_red',
    });
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
