/**
 * THE FOUR-COLOUR DECK IS THE STANDARD (Dan 2026-10-17)
 *
 * "USE THE 4 COLOR DECK AS THE STANDARD AND IF USERS WANT TO CHANGE IT, THEY
 * CAN CHANGE IT BACK TO THE TRADITIONAL DECK IN THE TABLE SETTINGS."
 *
 * The store persists its WHOLE object on every write, so a player who ever
 * touched any table setting has `fourColorDeck: false` in localStorage from
 * the days when false was the default, without ever having chosen it. Those
 * players must get four colours. A player who picks Traditional after this
 * ships must keep it, on reload and in every card the app draws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import {
  DEFAULT_TABLE_USER_SETTINGS,
  useTableSettings,
  __resetTableSettingsStoreForTest,
} from '../../src/hooks/useTableSettings';
import { DEFAULT_TABLE_SETTINGS } from '../../src/components/table/SettingsPanel';
import { DEFAULT_SETTINGS as BRIDGE_DEFAULTS } from '../../src/lib/settingsBridge';
import { STORAGE_KEYS } from '../../src/lib/storage';

const KEY = STORAGE_KEYS.TABLE_SETTINGS;

/* useDeckStyle caches per module and invalidates on the bus, which is mocked
   here, so each read comes from a fresh copy of the module: what a page that
   renders cards on a cold load would see. */
async function deckStyleOnColdLoad(): Promise<string> {
  vi.resetModules();
  const mod = await import('../../src/hooks/useDeckStyle');
  return mod.getDeckStyle();
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  __resetTableSettingsStoreForTest();
});

describe('the four-colour deck is the standard', () => {
  it('every default says four colours', () => {
    expect(DEFAULT_TABLE_USER_SETTINGS.fourColorDeck).toBe(true);
    expect(DEFAULT_TABLE_USER_SETTINGS.fourColorDeckExplicit).toBe(false);
    expect(DEFAULT_TABLE_SETTINGS.fourColorDeck).toBe(true);
    expect(BRIDGE_DEFAULTS.fourColorDeck).toBe(true);
  });

  it('a new player with nothing stored is dealt the four-colour deck', async () => {
    expect(await deckStyleOnColdLoad()).toBe('4color');
    const { result } = renderHook(() => useTableSettings());
    expect(result.current.settings.fourColorDeck).toBe(true);
  });

  it('a false saved before the standard, by a whole-object write, is lifted to four colours', () => {
    store[KEY] = JSON.stringify({ fourColorDeck: false, soundVolume: 40 });
    const { result } = renderHook(() => useTableSettings());
    expect(result.current.settings.fourColorDeck).toBe(true);
    // Unrelated choices in the same blob are untouched.
    expect(result.current.settings.soundVolume).toBe(40);
  });

  it('the card renderer agrees with the store before the store has loaded', async () => {
    store[KEY] = JSON.stringify({ fourColorDeck: false });
    expect(await deckStyleOnColdLoad()).toBe('4color');
  });

  it('a player who picks Traditional keeps it across a reload, everywhere', async () => {
    const first = renderHook(() => useTableSettings());
    act(() => first.result.current.updateSetting('fourColorDeck', false));
    expect(first.result.current.settings.fourColorDeck).toBe(false);
    expect(JSON.parse(store[KEY]).fourColorDeckExplicit).toBe(true);

    __resetTableSettingsStoreForTest();
    const reloaded = renderHook(() => useTableSettings());
    expect(reloaded.result.current.settings.fourColorDeck).toBe(false);
    expect(await deckStyleOnColdLoad()).toBe('2color');
  });

  it('switching back to four colours is a choice too', () => {
    const { result } = renderHook(() => useTableSettings());
    act(() => result.current.updateSetting('fourColorDeck', false));
    act(() => result.current.updateSetting('fourColorDeck', true));
    expect(result.current.settings.fourColorDeck).toBe(true);
    expect(JSON.parse(store[KEY]).fourColorDeckExplicit).toBe(true);
  });
});
