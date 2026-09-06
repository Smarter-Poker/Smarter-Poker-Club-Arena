/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLEAR USER CACHES — signing out must not leave the account behind
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-23: SIGNED_OUT cleared the store, Sentry and realtime, and no
 * storage at all. The next person to use the device was served the previous
 * account's cached club list, club lobby, hand history and — because
 * sessionStorage dies with the TAB, not the session — their profile,
 * transaction history and session stats after a sign-out/sign-in in the same
 * tab.
 *
 * These tests pin the three properties that matter: account data goes, device
 * preferences stay, and the Supabase auth key is never touched by us.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { clearUserCaches, CLUB_HOME_CACHE_PREFIX } from '@/utils/clearUserCaches';
import { SWR_CACHE_PREFIXES } from '@/utils/staleCacheReaper';
import { STORAGE_KEYS } from '@/lib/storage';
import {
  CASHIER_RECOVERY_PREFIX,
  CASHIER_REQUEST_RECOVERY_PREFIX,
} from '@/services/CashierResilience';
import { UNION_WALLET_RECOVERY_PREFIX } from '@/services/UnionWalletRecovery';

describe('clearUserCaches', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes the previous account cached club list and profile', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '[{"name":"Shark Club"}]');
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE_TS, '123');
    localStorage.setItem(STORAGE_KEYS.USER_PROFILE, '{"alias":"someone"}');
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, 'club-uuid');

    clearUserCaches();

    expect(localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.CLUBS_CACHE_TS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.USER_PROFILE)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.LAST_CLUB)).toBeNull();
  });

  it('removes every dynamic per-club and per-table entry, not just the first', () => {
    // removeItem() re-indexes localStorage, so a forward loop silently skips
    // the entry that slides into the vacated slot. Several of each on purpose.
    localStorage.setItem(`${CLUB_HOME_CACHE_PREFIX}v2_club-a`, '{}');
    localStorage.setItem(`${CLUB_HOME_CACHE_PREFIX}v2_club-b`, '{}');
    localStorage.setItem(`${CLUB_HOME_CACHE_PREFIX}v2_club-c`, '{}');
    localStorage.setItem('hand_history_table-1', '[]');
    localStorage.setItem('hand_history_table-2', '[]');
    localStorage.setItem('ca_saved_start_time_club-a', '1');
    localStorage.setItem('dismissed_announcements_club-a', '[]');
    localStorage.setItem('referral_club-a', 'x');
    localStorage.setItem(`${CASHIER_RECOVERY_PREFIX}:user-a:club-a`, '{"private":true}');
    localStorage.setItem(
      `${CASHIER_REQUEST_RECOVERY_PREFIX}:user-a:club-a:intent-a`,
      '{"private":true}'
    );
    localStorage.setItem(`${UNION_WALLET_RECOVERY_PREFIX}:user-a:union-a:chips`, '{}');

    clearUserCaches();

    const leftovers = Object.keys(localStorage).filter(
      (k) =>
        k.startsWith(CLUB_HOME_CACHE_PREFIX) ||
        k.startsWith('hand_history_') ||
        k.startsWith('ca_saved_start_time_') ||
        k.startsWith('dismissed_announcements_') ||
        k.startsWith('referral_') ||
        k.startsWith(CASHIER_RECOVERY_PREFIX) ||
        k.startsWith(CASHIER_REQUEST_RECOVERY_PREFIX) ||
        k.startsWith(UNION_WALLET_RECOVERY_PREFIX)
    );
    expect(leftovers).toEqual([]);
  });

  it('empties every sessionStorage SWR cache — they outlive the session, not the tab', () => {
    for (const prefix of SWR_CACHE_PREFIXES) {
      sessionStorage.setItem(`${prefix}someone`, '{"private":true}');
    }

    clearUserCaches();

    const leftovers = Object.keys(sessionStorage).filter((k) =>
      SWR_CACHE_PREFIXES.some((p) => k.startsWith(p))
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps device preferences — a sign-out is not a factory reset', () => {
    const prefs: [string, string][] = [
      [STORAGE_KEYS.SOUNDS, 'false'],
      [STORAGE_KEYS.VIBRATIONS, 'true'],
      [STORAGE_KEYS.LANGUAGE, 'es'],
      [STORAGE_KEYS.CARD_COLOR, 'gold'],
      [STORAGE_KEYS.DECK_STYLE, 'carbon'],
      [STORAGE_KEYS.TABLE_FELT_THEME, 'emerald'],
      [STORAGE_KEYS.SHOW_STACK_BB, 'true'],
      [STORAGE_KEYS.PWA_INSTALLED, 'true'],
    ];
    for (const [k, v] of prefs) localStorage.setItem(k, v);

    clearUserCaches();

    for (const [k, v] of prefs) {
      expect(localStorage.getItem(k), `${k} should survive sign-out`).toBe(v);
    }
  });

  it('never touches the Supabase auth key', () => {
    // Supabase owns 'smarter-poker-auth' and is mid-sign-out when this runs.
    // Deleting it underneath the SDK is how a session half-ends.
    localStorage.setItem(STORAGE_KEYS.SSO_AUTH, '{"access_token":"x"}');

    clearUserCaches();

    expect(localStorage.getItem(STORAGE_KEYS.SSO_AUTH)).toBe('{"access_token":"x"}');
  });

  it('does not throw when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is disabled');
      },
    });

    // A failed purge is worth strictly less than a stuck sign-out.
    expect(() => clearUserCaches()).not.toThrow();

    if (original) Object.defineProperty(window, 'localStorage', original);
  });
});
