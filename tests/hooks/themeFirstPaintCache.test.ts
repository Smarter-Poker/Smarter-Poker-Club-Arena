/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE FIRST FRAME WEARS THE SAVED THEME (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: opening a table showed the previous or default table art for a split
 * second before snapping to the saved selection. Root cause: state began at
 * DEFAULT_THEME on every mount and the saved theme arrived only after a
 * Supabase round trip.
 *
 * Pinned here:
 *   - a cached theme paints on the VERY FIRST render — no flash, no waiting;
 *   - the database remains the truth: a successful load refreshes the cache;
 *   - a live UI_THEME_CHANGED application is merged into the cache, so a
 *     refresh immediately after a change still first-paints the new choice;
 *   - a cold cache falls back to the defaults exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Restore the REAL bus — tests/setup.ts installs a no-op mock, and the cache
// write on live application only happens when the subscription genuinely fires.
vi.mock('../../src/core/MasterBus', async () => await vi.importActual('../../src/core/MasterBus'));

const eq = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq }) }),
  },
}));

import { masterBus } from '../../src/core/MasterBus';
import { useUserThemeSettings, resolveCachedTheme } from '../../src/hooks/useUserThemeSettings';

const CACHE_KEY = 'ca_user_theme_rows:user-1';

const cachedRows = [
  {
    game_type: 'ALL',
    theme_id: 'default-dark',
    table_id: 'jade_city',
    button_id: 'gold-metal',
    background_id: 'vegas_night',
    cards_id: 'royal_blue',
  },
];

describe('theme first paint comes from the cache', () => {
  beforeEach(() => {
    localStorage.clear();
    eq.mockResolvedValue({ data: null, error: null });
  });

  it('paints the cached theme on the very first render — no default flash', () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    // Synchronous: asserted BEFORE any await. This is the whole fix.
    expect(result.current.theme.table_id).toBe('jade_city');
    expect(result.current.theme.background_id).toBe('vegas_night');
    expect(result.current.theme.cards_id).toBe('royal_blue');
  });

  it('a cold cache still opens on the defaults', async () => {
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    expect(result.current.theme.table_id).toBe('classic_green');
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('a successful load refreshes the cache from the database', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    const dbRows = [{ ...cachedRows[0], table_id: 'ice_cavern' }];
    eq.mockResolvedValue({ data: dbRows, error: null });

    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.theme.table_id).toBe('ice_cavern'));

    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    expect(stored[0].table_id).toBe('ice_cavern');
  });

  it('the database answering "no rows" evicts a stale cache back to defaults', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    eq.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    expect(result.current.theme.table_id).toBe('jade_city'); // first paint
    await waitFor(() => expect(result.current.theme.table_id).toBe('classic_green'));
  });

  it('a failed load keeps the cached theme on screen rather than defaults', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    eq.mockResolvedValue({ data: null, error: { message: 'network down' } });

    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.theme.table_id).toBe('jade_city');
  });

  it('a live change is merged into the cache, so the NEXT mount first-paints it', async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    const { result, unmount } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'carbon_ion' },
        userId: 'user-1',
      } as never);
    });
    await waitFor(() => expect(result.current.theme.table_id).toBe('carbon_ion'));
    unmount();

    // A remount (page change, refresh) opens already wearing the change.
    expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_ion');
    const { result: second } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    expect(second.current.theme.table_id).toBe('carbon_ion');
  });

  it('a confirmed ALL save advances cache precedence over an older game-specific row', async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        { ...cachedRows[0], updated_at: '2026-08-01T00:00:00Z' },
        {
          ...cachedRows[0],
          game_type: 'NLH',
          table_id: 'ocean_blue',
          updated_at: '2026-08-20T00:00:00Z',
        },
      ])
    );
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    expect(result.current.theme.table_id).toBe('ocean_blue');
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'confirmed-all',
        state: 'pending',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'carbon_ion' },
        userId: 'user-1',
        mutationId: 'confirmed-all',
      });
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'confirmed-all',
        state: 'confirmed',
      });
    });

    expect(resolveCachedTheme('user-1', 'NLH')?.table_id).toBe('carbon_ion');
  });

  it("never paints one account's cache onto another account or a guest", () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cachedRows));
    expect(resolveCachedTheme('user-2', 'NLH')).toBeNull();
    expect(resolveCachedTheme(null, 'NLH')).toBeNull();
    const { result } = renderHook(() => useUserThemeSettings('user-2', 'nlh'));
    expect(result.current.theme.table_id).toBe('classic_green');
  });
});
