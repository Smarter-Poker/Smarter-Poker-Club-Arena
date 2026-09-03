/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET CACHE — the instant-paint contract for money panels
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-23 (Dan): wallets in clubs and unions took too long to load because
 * nothing survived a navigation, let alone a reload. walletCache.ts is the
 * shared stale-while-revalidate layer under DynamicWallet, useSpinsWallet and
 * the union dashboard. These tests pin the properties that make it safe to
 * cache money: versioned keys per user, TTL expiry, write-through, in-flight
 * dedupe, and a sign-out purge that leaves nothing behind (memory included).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WALLET_CACHE_PREFIX,
  walletCacheKey,
  readWalletCache,
  readWalletCacheEntry,
  writeWalletCache,
  writeWalletCacheDebounced,
  flushWalletCacheWrites,
  dedupedFetch,
  clearWalletMemoryCache,
} from '@/lib/walletCache';
import { clearUserCaches } from '@/utils/clearUserCaches';
import { CLUB_UUID_MAP_KEY } from '@/utils/clubIdResolver';

const USER = '00000000-0000-0000-0000-000000000001';

describe('walletCache', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearWalletMemoryCache();
  });

  it('round-trips a payload and keys it under the purgeable prefix + user id', () => {
    const key = walletCacheKey(USER, '25450', 'club');
    expect(key.startsWith(WALLET_CACHE_PREFIX)).toBe(true);
    expect(key).toContain(USER);

    writeWalletCache(key, { chipBalance: 1234.56 });
    expect(readWalletCache<{ chipBalance: number }>(key)).toEqual({ chipBalance: 1234.56 });
    // Persisted, not just in memory — a reload must still paint instantly.
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('survives a memory purge by re-hydrating from localStorage', () => {
    const key = walletCacheKey(USER, '25450', 'club');
    writeWalletCache(key, { clubBank: 99 });
    clearWalletMemoryCache(); // simulates a fresh page load
    expect(readWalletCache<{ clubBank: number }>(key)).toEqual({ clubBank: 99 });
  });

  it('treats entries older than the TTL as absent — no week-old money paints', () => {
    const key = walletCacheKey(USER, '25450', 'club');
    writeWalletCache(key, { chipBalance: 500 });
    clearWalletMemoryCache();
    // Rewind the stored envelope 25 hours
    const raw = JSON.parse(localStorage.getItem(key)!);
    raw.at = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(key, JSON.stringify(raw));
    expect(readWalletCache(key)).toBeNull();
    // And a custom (shorter) TTL is honored too: 1s-old entry, 500ms budget.
    writeWalletCache(key, { chipBalance: 500 });
    clearWalletMemoryCache();
    const raw2 = JSON.parse(localStorage.getItem(key)!);
    raw2.at = Date.now() - 1000;
    localStorage.setItem(key, JSON.stringify(raw2));
    expect(readWalletCache(key, 500)).toBeNull();
  });

  it('returns null for corrupt entries instead of throwing', () => {
    const key = walletCacheKey(USER, 'bad');
    localStorage.setItem(key, '{not json');
    expect(readWalletCache(key)).toBeNull();
  });

  it('keys are isolated per user — one account can never paint another account money', () => {
    const a = walletCacheKey('user-a', '25450', 'club');
    const b = walletCacheKey('user-b', '25450', 'club');
    expect(a).not.toBe(b);
    writeWalletCache(a, { chipBalance: 1 });
    expect(readWalletCache(b)).toBeNull();
  });

  it('dedupedFetch shares ONE in-flight promise per key, then releases it', async () => {
    const fetcher = vi.fn().mockResolvedValue('panel');
    const [r1, r2] = await Promise.all([dedupedFetch('k1', fetcher), dedupedFetch('k1', fetcher)]);
    expect(r1).toBe('panel');
    expect(r2).toBe('panel');
    expect(fetcher).toHaveBeenCalledTimes(1);
    // After settlement the key is released — a later call fetches fresh.
    await dedupedFetch('k1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupedFetch releases the key after a rejection so retries are possible', async () => {
    const failing = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('ok');
    await expect(dedupedFetch('k2', failing)).rejects.toThrow('down');
    await expect(dedupedFetch('k2', failing)).resolves.toBe('ok');
  });

  it('readWalletCacheEntry exposes the entry age so callers can honor a fresh window', () => {
    const key = walletCacheKey(USER, '25450', 'club');
    const before = Date.now();
    writeWalletCache(key, { chipBalance: 42 });
    const entry = readWalletCacheEntry<{ chipBalance: number }>(key);
    expect(entry).not.toBeNull();
    expect(entry!.data).toEqual({ chipBalance: 42 });
    // `at` is the write moment — a mount seconds later can tell "just
    // written on the page I left" from "written an hour ago".
    expect(entry!.at).toBeGreaterThanOrEqual(before);
    expect(entry!.at).toBeLessThanOrEqual(Date.now());
    // The plain reader stays a thin wrapper over the same entry.
    expect(readWalletCache(key)).toEqual({ chipBalance: 42 });
    // And after a reload (memory purge), the age survives via localStorage.
    clearWalletMemoryCache();
    const rehydrated = readWalletCacheEntry<{ chipBalance: number }>(key);
    expect(rehydrated!.at).toBe(entry!.at);
  });

  describe('debounced storage writes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('memory is written synchronously; localStorage settles after the debounce', () => {
      const key = walletCacheKey(USER, '25450', 'club');
      writeWalletCacheDebounced(key, { chipBalance: 1 }, 800);
      // In-session readers see the new value immediately (memory layer)...
      expect(readWalletCache(key)).toEqual({ chipBalance: 1 });
      // ...but storage has not been touched yet.
      expect(localStorage.getItem(key)).toBeNull();
      vi.advanceTimersByTime(800);
      expect(JSON.parse(localStorage.getItem(key)!).data).toEqual({ chipBalance: 1 });
    });

    it('a burst of writes stays out of storage until the burst settles, then lands the LAST value', () => {
      const key = walletCacheKey(USER, '25450', 'club');
      for (let i = 1; i <= 20; i++) {
        writeWalletCacheDebounced(key, { chipBalance: i }, 800);
        vi.advanceTimersByTime(100); // 100ms apart — every write inside the window
        // Trailing debounce: while the burst is live, storage is untouched.
        expect(localStorage.getItem(key)).toBeNull();
      }
      vi.advanceTimersByTime(800); // burst over — the one deferred write fires
      expect(JSON.parse(localStorage.getItem(key)!).data).toEqual({ chipBalance: 20 });
    });

    it('flushWalletCacheWrites lands pending values immediately (pagehide path)', () => {
      const key = walletCacheKey(USER, '25450', 'club');
      writeWalletCacheDebounced(key, { chipBalance: 777 }, 800);
      expect(localStorage.getItem(key)).toBeNull();
      flushWalletCacheWrites(); // what the pagehide/hidden listener calls
      expect(JSON.parse(localStorage.getItem(key)!).data).toEqual({ chipBalance: 777 });
    });

    it('a memory purge cancels pending flushes — sign-out cannot resurrect a balance', () => {
      const key = walletCacheKey(USER, '25450', 'club');
      writeWalletCacheDebounced(key, { chipBalance: 999 }, 800);
      clearWalletMemoryCache(); // what clearUserCaches calls
      vi.advanceTimersByTime(800);
      expect(localStorage.getItem(key)).toBeNull();
    });
  });

  it('sign-out purges every wallet cache entry, the uuid map, and the memory layer', () => {
    const key = walletCacheKey(USER, '25450', 'club');
    writeWalletCache(key, { chipBalance: 777 });
    localStorage.setItem(CLUB_UUID_MAP_KEY, '{"25450":"550e8400-e29b-41d4-a716-446655440000"}');

    clearUserCaches();

    const leftovers = Object.keys(localStorage).filter((k) => k.startsWith(WALLET_CACHE_PREFIX));
    expect(leftovers).toEqual([]);
    expect(localStorage.getItem(CLUB_UUID_MAP_KEY)).toBeNull();
    // Memory layer must be gone too — clearUserCaches calls clearWalletMemoryCache.
    expect(readWalletCache(key)).toBeNull();
  });
});
