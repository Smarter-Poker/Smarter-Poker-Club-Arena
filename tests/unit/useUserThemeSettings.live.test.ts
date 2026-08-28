/**
 * REGRESSION (audit 2026-08-19): live theme application.
 *
 * masterBus.subscribe() hands its handler the EVENT WRAPPER
 * ({ type, payload, timestamp }), not the raw payload. The original live-theme
 * listener read `.key` / `.value` straight off the wrapper, so `selection` was
 * always undefined, the handler returned early on every emit, and changing a
 * table skin or background silently did nothing until the table remounted.
 *
 * These tests lock the contract from both ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// tests/setup.ts replaces MasterBus with a no-op global mock — which is exactly
// why the wrapper bug below shipped green. Restore the REAL bus for this file so
// the subscribe/emit contract is genuinely exercised.
vi.mock('../../src/core/MasterBus', async () => await vi.importActual('../../src/core/MasterBus'));

const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
    }),
  },
}));

import { masterBus } from '../../src/core/MasterBus';
import { useUserThemeSettings } from '../../src/hooks/useUserThemeSettings';

describe('masterBus subscriber contract', () => {
  it('delivers the event wrapper, not the bare payload', async () => {
    const seen: unknown[] = [];
    const off = masterBus.subscribe('UI_THEME_CHANGED', (e) => seen.push(e));
    masterBus.emit('UI_THEME_CHANGED', {
      key: 'ALL',
      value: { table_id: 'contract_probe' },
    } as never);
    off();
    expect(seen).toHaveLength(1);
    // The guard that was violated: fields live under .payload.
    expect(seen[0]).toHaveProperty('payload');
    expect((seen[0] as { payload: { key: string } }).payload.key).toBe('ALL');
    expect((seen[0] as { key?: string }).key).toBeUndefined();
  });
});

describe('useUserThemeSettings live application', () => {
  beforeEach(() => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('applies a theme change broadcast for ALL without a remount', async () => {
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.theme.table_id;

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', { key: 'ALL', value: { table_id: 'jade_city' } } as never);
    });

    await waitFor(() => expect(result.current.theme.table_id).toBe('jade_city'));
    expect(before).not.toBe('jade_city');
  });

  it('repaints every mounted table hook from one appearance event', async () => {
    const { result } = renderHook(() => ({
      first: useUserThemeSettings('user-1', 'nlh'),
      second: useUserThemeSettings('user-1', 'plo4'),
      third: useUserThemeSettings('user-1', 'nlh'),
    }));
    await waitFor(() => {
      expect(result.current.first.loading).toBe(false);
      expect(result.current.second.loading).toBe(false);
      expect(result.current.third.loading).toBe(false);
    });

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { background_id: 'vegas_night', button_id: 'gold-metal' },
      } as never);
    });

    await waitFor(() => {
      for (const table of Object.values(result.current)) {
        expect(table.theme.background_id).toBe('vegas_night');
        expect(table.theme.button_id).toBe('gold-metal');
      }
    });
  });

  it('keeps the newest optimistic art visible while older database echoes arrive', async () => {
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'appearance-2',
        state: 'pending',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'jade_city' },
        userId: 'user-1',
        mutationId: 'appearance-2',
      });
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'classic_green' },
        userId: 'user-1',
      });
    });
    expect(result.current.theme.table_id).toBe('jade_city');

    act(() => {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'table-appearance',
        scope: 'user-1:ALL',
        mutationId: 'appearance-2',
        state: 'confirmed',
      });
    });
  });

  it('ignores appearance events belonging to a different signed-in account', async () => {
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.theme.table_id;

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'jade_city' },
        userId: 'user-2',
      });
    });
    expect(result.current.theme.table_id).toBe(before);
  });

  it('does not paint a signed-in account appearance onto a guest table', async () => {
    const { result } = renderHook(() => useUserThemeSettings(null, 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.theme.table_id;

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'ALL',
        value: { table_id: 'jade_city' },
        userId: 'signed-out-user',
      });
    });
    expect(result.current.theme.table_id).toBe(before);
  });

  it('ignores a change saved against a different game type', async () => {
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.theme.table_id;

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', {
        key: 'PLO',
        value: { table_id: 'carbon_ion' },
      } as never);
    });

    expect(result.current.theme.table_id).toBe(before);
  });

  it('ignores the unrelated useSettingsStore emit that shares this event name', async () => {
    // useSettingsStore emits { key: 'theme', value: '<string>' } — spreading a
    // string into the selection object would produce garbage keys.
    const { result } = renderHook(() => useUserThemeSettings('user-1', 'nlh'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = { ...result.current.theme };

    act(() => {
      masterBus.emit('UI_THEME_CHANGED', { key: 'theme', value: 'dark' } as never);
    });

    expect(result.current.theme).toEqual(before);
  });
});
