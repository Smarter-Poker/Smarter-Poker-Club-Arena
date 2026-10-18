import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
const account = vi.hoisted(() => ({
  user: null as { id: string } | null,
  row: null as Record<string, unknown> | null,
}));
vi.mock('../../src/stores/useUserStore', () => {
  const useUserStore = Object.assign(
    (selector: (state: typeof account) => unknown) => selector(account),
    { getState: () => account }
  );
  return { useUserStore };
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: account.row, error: null }) }),
      }),
      upsert: async () => ({ error: null }),
    }),
    rpc: async () => ({ error: null }),
  },
}));
import { CardImage, getCardImagePath, SUIT_COLOR } from '../../src/components/table/CardImage';
import {
  __resetTableSettingsStoreForTest,
  setTableSetting,
  useTableSettings,
} from '../../src/hooks/useTableSettings';
import { useDeckStyle } from '../../src/hooks/useDeckStyle';
import { STORAGE_KEYS } from '../../src/lib/storage';

beforeEach(() => {
  account.user = null;
  account.row = null;
  localStorage.clear();
  __resetTableSettingsStoreForTest();
});

describe('four colors are the standard and the cards follow the switch', () => {
  it('repairs an old implicit OFF while retaining a deliberate opt-out after reload', () => {
    localStorage.setItem(STORAGE_KEYS.TABLE_SETTINGS, JSON.stringify({ fourColorDeck: false }));
    const hook = renderHook(() => useTableSettings());
    expect(hook.result.current.settings.fourColorDeck).toBe(true);
    act(() => setTableSetting('fourColorDeck', false));
    hook.unmount();
    __resetTableSettingsStoreForTest();
    const restored = renderHook(() => useTableSettings());
    expect(restored.result.current.settings.fourColorDeck).toBe(false);
  });

  it('updates already mounted cards even when the bus delivers no messages', () => {
    const cards = render(
      <>
        <CardImage card={{ rank: 'A', suit: 'd' }} />
        <CardImage card={{ rank: 'A', suit: 'c' }} />
      </>
    );
    const panel = renderHook(() => useTableSettings());
    const reader = renderHook(() => useDeckStyle());
    expect(reader.result.current).toBe('4color');
    act(() => panel.result.current.updateSetting('fourColorDeck', false));
    expect(reader.result.current).toBe('2color');
    expect(
      [...cards.container.querySelectorAll('img')].every((i) => i.src.includes('/2color/'))
    ).toBe(true);
    act(() => panel.result.current.updateSetting('fourColorDeck', true));
    expect(
      [...cards.container.querySelectorAll('img')].every((i) => i.src.includes('/4color/'))
    ).toBe(true);
  });

  it('repaints mounted cards when account hydration changes the preference without a bus event', async () => {
    account.user = { id: 'deck-test-user' };
    account.row = { four_color_deck: false, settings_touched: ['four_color_deck'] };
    const cards = render(<CardImage card={{ rank: 'A', suit: 'd' }} />);
    expect(cards.container.querySelector('img')!.src).toContain('/4color/');
    const panel = renderHook(() => useTableSettings());
    await act(async () => {
      await Promise.resolve();
    });
    expect(panel.result.current.settings.fourColorDeck).toBe(false);
    expect(cards.container.querySelector('img')!.src).toContain('/2color/');
    expect(panel.result.current.settings.fourColorDeckExplicit).toBe(true);
  });

  it('ON loaded from the account replaces stale OFF on already mounted cards', async () => {
    localStorage.setItem(
      STORAGE_KEYS.TABLE_SETTINGS,
      JSON.stringify({ fourColorDeck: false, fourColorDeckExplicit: true })
    );
    account.user = { id: 'deck-test-user' };
    account.row = { four_color_deck: true, settings_touched: ['four_color_deck'] };
    const cards = render(<CardImage card={{ rank: 'A', suit: 'c' }} />);
    expect(cards.container.querySelector('img')!.src).toContain('/2color/');
    const panel = renderHook(() => useTableSettings());
    await act(async () => {
      await Promise.resolve();
    });
    expect(panel.result.current.settings.fourColorDeck).toBe(true);
    expect(cards.container.querySelector('img')!.src).toContain('/4color/');
  });

  it('keeps table props and card readers together on a cross-tab storage fallback', () => {
    const panel = renderHook(() => useTableSettings());
    const reader = renderHook(() => useDeckStyle());
    act(() => {
      localStorage.setItem(
        STORAGE_KEYS.TABLE_SETTINGS,
        JSON.stringify({ fourColorDeck: false, fourColorDeckExplicit: true })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.TABLE_SETTINGS }));
    });
    expect(panel.result.current.settings.fourColorDeck).toBe(false);
    expect(reader.result.current).toBe('2color');
  });

  it('refuses a storage fallback owned by another signed-in account', () => {
    account.user = { id: 'deck-test-user' };
    const panel = renderHook(() => useTableSettings());
    act(() => {
      localStorage.setItem('ca_table_settings_owner', 'other-user');
      localStorage.setItem(
        STORAGE_KEYS.TABLE_SETTINGS,
        JSON.stringify({ fourColorDeck: false, fourColorDeckExplicit: true })
      );
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.TABLE_SETTINGS }));
    });
    expect(panel.result.current.settings.fourColorDeck).toBe(true);
  });

  it.each(['d', 'diamonds'] as const)(
    'keeps the chosen colors when both image formats fail for %s',
    (suit) => {
      const cards = render(
        <CardImage card={{ rank: 'A', suit: suit as 'd' }} deckStyle="2color" />
      );
      const image = cards.container.querySelector('img')!;
      fireEvent.error(image);
      fireEvent.error(image);
      expect(cards.container.querySelector<HTMLElement>('.card-image__fallback')!.style.color).toBe(
        '#ef4444'
      );
      expect(getCardImagePath({ rank: 'A', suit: 'c' })).toContain('/4color/');
      expect(SUIT_COLOR.h).toBe('#ef4444');
    }
  );
});
