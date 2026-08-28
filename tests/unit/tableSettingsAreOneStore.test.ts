/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETTINGS NEVER CHANGE BACK ON THEIR OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, binding: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE
 * SETTINGS, THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL
 * PAGES. AND NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
 * MANUALLY."
 *
 * The mechanism behind "auto change back" was structural, not a bug in any one
 * setting. `useTableSettings` kept the settings in a per-instance `useState`
 * and persisted the WHOLE object to one localStorage key on every write. It is
 * called by TablePage, SettingsPage and TournamentStartingTicker, and
 * MultiTablePage keeps up to six TablePages mounted — so there were commonly
 * eight independent copies, each writing its own complete blob over the same
 * key.
 *
 * Keeping them in step depended entirely on a `SETTINGS_CHANGED` bus message
 * reaching every copy. Any copy that missed one went stale silently, and the
 * next time anything changed in that copy its stale full object overwrote the
 * key — reverting every setting the user had changed elsewhere in between. No
 * error, no console, and it un-sticks itself the next time you change anything,
 * which is exactly how the bug was described.
 *
 * These tests pin the property that removes it by construction: there is ONE
 * store. Divergence is then impossible rather than merely unlikely, and a
 * change is visible everywhere in the same tick whether or not the bus
 * delivers.
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
  useTableSettings,
  __resetTableSettingsStoreForTest,
} from '../../src/hooks/useTableSettings';
import { STORAGE_KEYS } from '../../src/lib/storage';

const KEY = STORAGE_KEYS.TABLE_SETTINGS;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  __resetTableSettingsStoreForTest();
});

describe('every consumer shares one settings store', () => {
  it('a change in one consumer is visible in another immediately', () => {
    /* Two mounted hooks stand in for two open tables. Before the shared store
       this passed ONLY if the bus echo was delivered; now it holds because
       there is one object. The bus is mocked to a no-op here on purpose — that
       is the point of the test. */
    const tableA = renderHook(() => useTableSettings());
    const tableB = renderHook(() => useTableSettings());

    expect(tableB.result.current.settings.showPotOdds).toBe(false);

    act(() => {
      tableA.result.current.updateSetting('showPotOdds', true);
    });

    expect(
      tableB.result.current.settings.showPotOdds,
      'a second table must see the change with no bus message at all'
    ).toBe(true);
  });

  it('a stale consumer cannot overwrite a change made elsewhere', () => {
    /* THE REGRESSION ITSELF. Table A changes one setting; table B then changes
       a DIFFERENT one. With per-instance copies, B still held the pre-change
       value of A's setting and its full-object write reverted it. */
    const tableA = renderHook(() => useTableSettings());
    const tableB = renderHook(() => useTableSettings());

    act(() => {
      tableA.result.current.updateSetting('showPotOdds', true);
    });
    act(() => {
      tableB.result.current.updateSetting('fourColorDeck', true);
    });

    expect(tableA.result.current.settings.showPotOdds).toBe(true);
    expect(tableB.result.current.settings.showPotOdds).toBe(true);

    const persisted = JSON.parse(store[KEY]);
    expect(persisted.showPotOdds, 'the second write must not revert the first').toBe(true);
    expect(persisted.fourColorDeck).toBe(true);
  });

  it('unmounting one consumer does not disturb the others', () => {
    const tableA = renderHook(() => useTableSettings());
    const tableB = renderHook(() => useTableSettings());

    act(() => {
      tableA.result.current.updateSetting('showTicker', false);
    });
    tableA.unmount();

    expect(tableB.result.current.settings.showTicker).toBe(false);
    expect(JSON.parse(store[KEY]).showTicker).toBe(false);
  });

  it('persists on every change, so a reload keeps the user choice', () => {
    const { result } = renderHook(() => useTableSettings());
    act(() => {
      result.current.updateSetting('soundVolume', 25);
    });
    expect(JSON.parse(store[KEY]).soundVolume).toBe(25);

    __resetTableSettingsStoreForTest();
    const reloaded = renderHook(() => useTableSettings());
    expect(reloaded.result.current.settings.soundVolume).toBe(25);
  });
});
