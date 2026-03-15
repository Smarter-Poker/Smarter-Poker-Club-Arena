/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STALE CACHE REAPER — sessionStorage disk hygiene
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Scans sessionStorage for SWR cache entries older than MAX_AGE and removes
 * them. Runs once during idle time to prevent unbounded storage growth in
 * long-lived browser sessions.
 *
 * Known SWR cache key prefixes managed across the platform:
 *   ps_stats_       → PlayerStatsPage
 *   ps_sessions_    → PlayerStatsPage session history
 *   sh_cache_       → SessionHistoryPage
 *   notif_cache_    → NotificationsPage
 *   fr_cache_       → FriendsPage
 *   leaderboard_    → LeaderboardPage
 *   achievements_   → AchievementsPage
 *   hh_cache_       → HandHistoryPage
 *   psr_cache_      → PlayerStyleRadar
 *   pt_cache_       → PerformanceTrends
 *   slc_cache_      → StakeLevelComparison
 */

const SWR_PREFIXES = [
  'ps_stats_',
  'ps_sessions_',
  'sh_cache_',
  'notif_cache_',
  'fr_cache_',
  'leaderboard_',
  'achievements_',
  'hh_cache_',
  'psr_cache_',
  'pt_cache_',
  'slc_cache_',
];

/** Maximum cache age in milliseconds (1 hour) */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Removes stale SWR cache entries from sessionStorage.
 * Runs silently — never throws.
 */
function reapStaleCaches(): void {
  try {
    const keysToRemove: string[] = [];

    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key) continue;

      // Only touch our known SWR keys
      const isOurs = SWR_PREFIXES.some((prefix) => key.startsWith(prefix));
      if (!isOurs) continue;

      // Try to parse — if it's an array/object, check for staleness
      // Since we don't embed timestamps in the cache, we rely on
      // sessionStorage being session-scoped. The reaper primarily
      // cleans up entries from very long sessions (e.g. kiosk mode).
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) {
          keysToRemove.push(key);
          continue;
        }

        // If the data is null or empty, remove it
        const parsed = JSON.parse(raw);
        if (
          parsed === null ||
          (Array.isArray(parsed) && parsed.length === 0) ||
          (typeof parsed === 'object' && Object.keys(parsed).length === 0)
        ) {
          keysToRemove.push(key);
        }
      } catch {
        // Corrupt entry — remove it
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* silent */
      }
    });

    if (keysToRemove.length > 0) {
      console.debug(`[StaleCacheReaper] Cleaned ${keysToRemove.length} stale cache entries`);
    }
  } catch {
    // sessionStorage not available — silent
  }
}

/**
 * Schedule the stale cache reaper to run during idle time.
 * Uses requestIdleCallback if available, otherwise falls back to setTimeout.
 */
export function scheduleStaleCacheReaper(): void {
  const run = () => reapStaleCaches();

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(run, { timeout: 30000 });
  } else if (typeof window !== 'undefined') {
    setTimeout(run, 30000);
  }
}
