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

export function writeClubDataCache<T>(
  userId: string,
  clubId: string,
  queryKey: string,
  data: T,
  now = Date.now()
): void {
  try {
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
