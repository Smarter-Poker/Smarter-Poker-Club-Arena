/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableSettings
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SHOWDOWN AUDIT 2026-08-25: the autoMuck migration. The old default was
 * FALSE and the hook persists the whole settings object on every write, so
 * any player who ever changed any setting has autoMuck:false stored WITHOUT
 * ever choosing it. Dan's rule is "auto-muck ON by default; users turn it
 * off MANUALLY" — so a stored false counts only when the autoMuckExplicit
 * marker proves the user's own toggle wrote it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock localStorage
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
  /* 2026-08-28: the settings now live in ONE module-level store shared by every
     consumer, because a per-instance `useState` meant up to eight copies (six
     MultiTablePage tables, SettingsPage, the ticker) each rewriting the whole
     blob over one localStorage key — the mechanism behind Dan's "settings auto
     change back". A singleton has to be forgotten between cases the same way
     localStorage is, or the second test in this file asserts against the first
     test's load. */
  __resetTableSettingsStoreForTest();
});

describe('useTableSettings', () => {
  it('should export useTableSettings as a function', () => {
    expect(typeof useTableSettings).toBe('function');
  });

  it('auto-muck defaults ON with no stored settings', () => {
    const { result } = renderHook(() => useTableSettings());
    expect(result.current.settings.autoMuck).toBe(true);
  });

  it('a stale stored autoMuck:false from the old default era is lifted to ON', () => {
    // The exact hostile state: a player who changed SOME setting before
    // 2026-08-25 has the whole object — old default included — persisted.
    store[KEY] = JSON.stringify({ soundVolume: 40, autoMuck: false });
    const { result } = renderHook(() => useTableSettings());
    expect(result.current.settings.autoMuck).toBe(true); // migrated
    expect(result.current.settings.soundVolume).toBe(40); // untouched
  });

  it('a deliberate OFF — marked autoMuckExplicit — is honoured', () => {
    store[KEY] = JSON.stringify({ autoMuck: false, autoMuckExplicit: true });
    const { result } = renderHook(() => useTableSettings());
    expect(result.current.settings.autoMuck).toBe(false);
  });

  it("the user's own toggle writes the explicit marker, so their OFF survives reload", () => {
    const first = renderHook(() => useTableSettings());
    act(() => {
      first.result.current.updateSetting('autoMuck', false);
    });
    expect(first.result.current.settings.autoMuck).toBe(false);
    expect(first.result.current.settings.autoMuckExplicit).toBe(true);
    first.unmount();

    /* A REAL reload, not just a remount. The store is a module singleton now,
       so a second renderHook would otherwise read the copy still in memory and
       this case would pass without ever exercising the load-time migration it
       exists to pin. Forgetting the store is what makes the next line read
       localStorage again — which is the whole assertion. */
    __resetTableSettingsStoreForTest();

    // Reload: the persisted explicit false must NOT be migrated away.
    const second = renderHook(() => useTableSettings());
    expect(second.result.current.settings.autoMuck).toBe(false);
  });
});
