import { purgeRosterCache, ROSTER_CACHE_PREFIX, ROSTER_SEARCH_PREFIX } from './rosterCache';
import { removeClubDataCaches, CLUB_DATA_CACHE_PREFIX } from './clubDataCache';
import { clearMembershipsWarmCache } from './membershipWarmState';
import { clearStatsRangeMemo, STATS_CACHE_PREFIX } from './statsCache';

/** Invalidate reads only. Durable transfer intents and cashier drafts are preserved. */
export function clearClubPrivateReadCaches(userId: string, clubId?: string): void {
  clearMembershipsWarmCache();
  clearStatsRangeMemo();
  if (clubId) {
    purgeRosterCache(userId, clubId);
    removeClubDataCaches(userId, clubId);
  }
  try {
    const rosterPrefix = `${ROSTER_CACHE_PREFIX}${userId}_`;
    const searchPrefix = `${ROSTER_SEARCH_PREFIX}${userId}_`;
    const dataPrefix = `${CLUB_DATA_CACHE_PREFIX}${userId}:`;
    const dashboardPrefix = `agent_dashboard_swr_${userId}_`;
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (!key) continue;
      if (
        (!clubId &&
          (key.startsWith(rosterPrefix) ||
            key.startsWith(searchPrefix) ||
            key.startsWith(dataPrefix) ||
            key.startsWith(dashboardPrefix))) ||
        (clubId && (key === `${dashboardPrefix}${clubId}` || key === `${searchPrefix}${clubId}`))
      )
        sessionStorage.removeItem(key);
    }
  } catch {
    // Server authorization remains authoritative when storage is unavailable.
  }
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STATS_CACHE_PREFIX)) continue;
      try {
        const identity = JSON.parse(key.slice(STATS_CACHE_PREFIX.length));
        if (
          Array.isArray(identity) &&
          identity[1] === userId &&
          (!clubId || identity[3] === clubId)
        )
          localStorage.removeItem(key);
      } catch {
        // A malformed unrelated key must not stop removal of valid owned entries.
      }
    }
  } catch {
    // Read caches are optional, and mounted consumers still receive the boundary.
  }
}
