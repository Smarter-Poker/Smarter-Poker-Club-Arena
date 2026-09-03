/**
 * Short-lived, user-scoped Club Data snapshots for stale-while-revalidate.
 * Financial payloads live in sessionStorage only, are keyed by user + club +
 * exact query, expire after two minutes, and are purged by clearUserCaches.
 */

export const CLUB_DATA_CACHE_PREFIX = 'club_data_swr_v1_';
export const CLUB_DATA_CACHE_TTL_MS = 2 * 60_000;

interface CacheEnvelope<T> {
  userId: string;
  clubId: string;
  queryKey: string;
  at: number;
  data: T;
}

function storageKey(userId: string, clubId: string, queryKey: string): string {
  return `${CLUB_DATA_CACHE_PREFIX}${userId}:${clubId}:${queryKey}`;
}

export function clubDataQueryKey(values: Record<string, string | number | null>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
    .join('&');
}

export function readClubDataCache<T>(
  userId: string,
  clubId: string,
  queryKey: string,
  now = Date.now()
): T | null {
  const key = storageKey(userId, clubId, queryKey);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    if (
      parsed.userId !== userId ||
      parsed.clubId !== clubId ||
      parsed.queryKey !== queryKey ||
      typeof parsed.at !== 'number' ||
      now - parsed.at > CLUB_DATA_CACHE_TTL_MS ||
      parsed.data === undefined
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage can be unavailable. The live RPC remains authoritative.
    }
    return null;
  }
}

/**
 * Drop this club's expired entries.
 *
 * A read removes an entry it finds stale, so an entry that is never read again
 * is never removed - it just sits there until the tab closes. That was small
 * while the key was scope plus period. Once the rake snapshot put the SORT in
 * its key the space quadrupled, and an operator cycling sorts across periods
 * can leave dozens of dead snapshots behind, each holding a page of rows.
 *
 * Swept on write rather than on a timer: writes are the only thing that grows
 * the store, so that is the moment the sweep is worth its pass over the keys.
 */
export function purgeExpiredClubDataCaches(
  userId: string,
  clubId: string,
  now = Date.now()
): void {
  try {
    const prefix = `${CLUB_DATA_CACHE_PREFIX}${userId}:${clubId}:`;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = sessionStorage.getItem(key);
      if (!raw) continue;
      let at: unknown;
      try {
        at = (JSON.parse(raw) as Partial<CacheEnvelope<unknown>>).at;
      } catch {
        // Unreadable is as dead as expired.
        sessionStorage.removeItem(key);
        continue;
      }
      if (typeof at !== 'number' || now - at > CLUB_DATA_CACHE_TTL_MS) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Best effort. Every read still validates identity, route, query and age,
    // so a failed sweep costs space, never correctness.
  }
}

export function writeClubDataCache<T>(
  userId: string,
  clubId: string,
  queryKey: string,
  data: T,
  now = Date.now()
): void {
  try {
    purgeExpiredClubDataCaches(userId, clubId, now);
    const envelope: CacheEnvelope<T> = { userId, clubId, queryKey, at: now, data };
    sessionStorage.setItem(storageKey(userId, clubId, queryKey), JSON.stringify(envelope));
  } catch {
    // Storage quota/privacy failures must not break the financial page.
  }
}

export function removeClubDataCaches(userId: string, clubId: string): void {
  try {
    const prefix = `${CLUB_DATA_CACHE_PREFIX}${userId}:${clubId}:`;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    // Best effort; every read still validates identity, route, query, and age.
  }
}
