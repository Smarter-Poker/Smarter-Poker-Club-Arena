/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useSessionCache — SWR-like SessionStorage Cache for Instant Page Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 * When navigating between Club Arena pages, the user sees a loading spinner
 * while Supabase data loads. This hook caches page data in sessionStorage
 * so subsequent visits show cached data INSTANTLY, then refresh in background.
 *
 * PATTERN: "Stale-While-Revalidate" for page data
 *   1. On mount: return cached data immediately (if available)
 *   2. In background: fetch fresh data from Supabase
 *   3. When fresh data arrives: update cache + return new data
 *
 * USAGE:
 *   const { data, isLoading, isStale } = useSessionCache<MyData[]>(
 *     'club-members-list',
 *     () => supabase.from('members').select('*').eq('club_id', clubId),
 *     [clubId]
 *   );
 *
 * The `data` will be the cached version on first render, then the fresh version
 * once the fetch completes. `isStale` is true while showing cached data.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { reportError } from '../utils/errorReporter';

interface SessionCacheResult<T> {
  data: T | null;
  isLoading: boolean;
  isStale: boolean;
  refresh: () => void;
}

const CACHE_PREFIX = 'ca-swr-';
const MAX_AGE_MS = 5 * 60 * 1000; // Cache entries older than 5 minutes are discarded

/**
 * 2026-08-24 (perf pass): backing store switched sessionStorage -> localStorage.
 * sessionStorage dies with the tab — every fresh visit (and iOS Safari's
 * aggressive tab reclaim) started from zero and showed skeletons everywhere.
 * localStorage survives restarts, so a returning player paints instantly from
 * the last visit and revalidates silently. The 5-minute max age still bounds
 * staleness, and clearSessionCache() on logout still prevents cross-user
 * bleed. Falls back to sessionStorage where localStorage throws (private
 * mode / storage denied).
 */
function cacheStore(): Storage {
  try {
    // Touch it — Safari private mode throws on setItem, not on access.
    localStorage.getItem(`${CACHE_PREFIX}__probe`);
    return localStorage;
  } catch {
    return sessionStorage;
  }
}

function readCache<T>(key: string): T | null {
  try {
    const store = cacheStore();
    const raw = store.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    // Discard stale entries
    if (Date.now() - ts > MAX_AGE_MS) {
      store.removeItem(`${CACHE_PREFIX}${key}`);
      return null;
    }
    return data as T;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  const store = cacheStore();
  try {
    store.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // Quota exceeded — clear old entries
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(CACHE_PREFIX)) keysToRemove.push(k);
      }
      // Remove oldest half
      keysToRemove.sort();
      keysToRemove.slice(0, Math.ceil(keysToRemove.length / 2)).forEach((k) => store.removeItem(k));
      // Retry write
      store.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ data, ts: Date.now() }));
    } catch {
      /* give up */
    }
  }
}

export function useSessionCache<T>(
  cacheKey: string,
  fetcher: () => Promise<{ data: T | null; error: any }>,
  deps: any[] = []
): SessionCacheResult<T> {
  const cached = readCache<T>(cacheKey);
  const [data, setData] = useState<T | null>(cached);
  const [isLoading, setIsLoading] = useState(!cached);
  const [isStale, setIsStale] = useState(!!cached);
  const mountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcher();
      if (!mountedRef.current) return;
      if (!result.error && result.data !== null) {
        setData(result.data);
        setIsStale(false);
        writeCache(cacheKey, result.data);
      }
    } catch (e) {
      reportError(e, 'useSessionCache.useCallback');
      /* silent — stale data is better than no data */
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, ...deps]);

  useEffect(() => {
    mountedRef.current = true;
    doFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    doFetch();
  }, [doFetch]);

  return { data, isLoading, isStale, refresh };
}

/**
 * Imperatively clear all SWR cache entries.
 * Call on logout to prevent stale cross-user data.
 */
export function clearSessionCache(): void {
  // Sweep BOTH stores: localStorage (current backing) and sessionStorage
  // (legacy entries from before the 2026-08-24 switch, and the private-mode
  // fallback). Cross-user bleed on a shared device is the failure this guards.
  for (const store of [localStorage, sessionStorage] as Storage[]) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(CACHE_PREFIX)) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => store.removeItem(k));
    } catch {
      /* silent */
    }
  }
}
