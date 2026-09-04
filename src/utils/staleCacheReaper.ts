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
 *   psr_cache_      → PlayerStyleRadar (component retired 2026-09-04; keys still reaped)
 *   pt_cache_       → PerformanceTrends (retired 2026-09-04; keys still reaped)
 *   slc_cache_      → StakeLevelComparison (retired 2026-09-04; keys still reaped)
 *   profile_cache_  → ProfilePage (Phase 4)
 *   members_cache_  → ClubMembersPage (Phase 4)
 *   tx_cache_       → TransactionHistoryPage (Phase 8)
 *   club_home_cache_ → ClubHomePage (Phase 8)
 */

import { ROSTER_CACHE_PREFIX, ROSTER_CACHE_TTL_MS, ROSTER_SEARCH_PREFIX } from '../lib/rosterCache';
import { CLUB_DATA_CACHE_PREFIX } from '../lib/clubDataCache';

/**
 * The canonical list of sessionStorage SWR cache prefixes.
 *
 * Exported because clearUserCaches.ts must purge exactly this set on sign-out.
 * Two copies of this list would drift, and the failure mode of a drifted copy
 * is one account's cached data being read by the next one.
 */
export const SWR_CACHE_PREFIXES = [
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
  'profile_cache_',
  'members_cache_',
  'tx_cache_',
  'club_home_cache_',
  ROSTER_CACHE_PREFIX,
  ROSTER_SEARCH_PREFIX,
  CLUB_DATA_CACHE_PREFIX,
];

/**
 * Wallet instant-paint entries live in LOCALstorage (they must survive a
 * reload — that is their whole point) under this prefix, with a timestamped
 * envelope `{ at, data }`. readWalletCache already ignores-and-deletes
 * expired entries on READ, but an entry for a club never revisited would
 * otherwise sit on the device until sign-out. The idle reaper sweeps them.
 * Kept as a literal here (mirrored by walletCache.ts and pinned by its
 * tests) to avoid pulling the whole cache module into this tiny utility.
 */
const WALLET_CACHE_PREFIX_LOCAL = 'wallet_cache_';
const WALLET_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes expired wallet instant-paint entries from localStorage. */
function reapExpiredWalletCaches(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(WALLET_CACHE_PREFIX_LOCAL)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof parsed.at !== 'number' ||
          Date.now() - parsed.at > WALLET_CACHE_MAX_AGE_MS
        ) {
          doomed.push(key);
        }
      } catch {
        doomed.push(key); // corrupt — remove
      }
    }
    doomed.forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* silent */
      }
    });
    if (doomed.length > 0) {
      console.debug(`[StaleCacheReaper] Cleaned ${doomed.length} expired wallet cache entries`);
    }
  } catch {
    /* localStorage unavailable — silent */
  }
}

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
      const isOurs = SWR_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
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
          key.startsWith(ROSTER_CACHE_PREFIX) &&
          (typeof parsed?.at !== 'number' || Date.now() - parsed.at > ROSTER_CACHE_TTL_MS)
        ) {
          keysToRemove.push(key);
          continue;
        }
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
  const run = () => {
    reapStaleCaches();
    reapExpiredWalletCaches();
  };

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(run, { timeout: 30000 });
  } else if (typeof window !== 'undefined') {
    setTimeout(run, 30000);
  }
}
