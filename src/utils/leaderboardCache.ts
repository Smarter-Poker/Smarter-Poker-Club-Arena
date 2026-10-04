import type { LeaderboardEntry } from '../services/LeaderboardService';

export const LEADERBOARD_CACHE_PREFIX = 'lb_cache_v2_';
export const LEADERBOARD_CACHE_TTL_MS = 5 * 60 * 1000;
export const LEADERBOARD_CACHE_MAX_RECORDS = 20;

export interface LeaderboardCacheRecord {
  version: 2;
  storedAt: number;
  entries: LeaderboardEntry[];
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LeaderboardEntry>;
  return (
    Number.isFinite(entry.rank) &&
    typeof entry.userId === 'string' &&
    typeof entry.username === 'string' &&
    Number.isFinite(entry.value)
  );
}

export function getCachedLeaderboardEntries(key: string): LeaderboardCacheRecord | null {
  const storageKey = LEADERBOARD_CACHE_PREFIX + key;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LeaderboardCacheRecord>;
    if (
      parsed.version !== 2 ||
      !Number.isFinite(parsed.storedAt) ||
      (parsed.storedAt as number) > Date.now() ||
      Date.now() - (parsed.storedAt as number) > LEADERBOARD_CACHE_TTL_MS ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isLeaderboardEntry)
    ) {
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return parsed as LeaderboardCacheRecord;
  } catch {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Storage can be disabled; the network refresh remains authoritative.
    }
    return null;
  }
}

export function setCachedLeaderboardEntries(key: string, entries: LeaderboardEntry[]): void {
  try {
    const record: LeaderboardCacheRecord = { version: 2, storedAt: Date.now(), entries };
    sessionStorage.setItem(LEADERBOARD_CACHE_PREFIX + key, JSON.stringify(record));

    const records: { key: string; storedAt: number }[] = [];
    const corruptKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey?.startsWith(LEADERBOARD_CACHE_PREFIX)) continue;
      try {
        const cached = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
        records.push({ key: storageKey, storedAt: Number(cached.storedAt) || 0 });
      } catch {
        corruptKeys.push(storageKey);
      }
    }
    corruptKeys.forEach((storageKey) => sessionStorage.removeItem(storageKey));
    records
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(LEADERBOARD_CACHE_MAX_RECORDS)
      .forEach((recordToRemove) => sessionStorage.removeItem(recordToRemove.key));
  } catch {
    // Quota or disabled storage must never block a fresh leaderboard read.
  }
}
