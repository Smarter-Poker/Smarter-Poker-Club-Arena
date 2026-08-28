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
    useSettingsStore.setState({
      theme: 'dark',
      soundEnabled: true,
      notificationsEnabled: true,
    });
  });

  it('should have dark theme by default', () => {
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('should have sound enabled by default', () => {
    expect(useSettingsStore.getState().soundEnabled).toBe(true);
  });

  it('should toggle notifications', () => {
    useSettingsStore.getState().toggleNotifications();
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
    useSettingsStore.getState().toggleNotifications();
    expect(useSettingsStore.getState().notificationsEnabled).toBe(true);
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

  it('should toggle sound', () => {
    useSettingsStore.getState().toggleSound();
    expect(useSettingsStore.getState().soundEnabled).toBe(false);
  });

  it('should export store with all actions', () => {
    const state = useSettingsStore.getState();
    expect(typeof state.toggleSound).toBe('function');
    expect(typeof state.toggleNotifications).toBe('function');
    expect(typeof state.setTheme).toBe('function');
  });
});
