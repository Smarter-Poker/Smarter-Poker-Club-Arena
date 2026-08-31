/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STATS CACHES — the parts sign-out has to be able to reach
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module exists so `clearUserCaches` can purge the Stats page's two caches
 * WITHOUT importing the page.
 *
 * That import would have been a real regression, not a style point: sign-out
 * runs from the header, so pulling PlayerStatsPage into clearUserCaches would
 * pull its whole import graph into whatever chunk holds it - and the point of
 * the lazy chart split was to keep exactly that weight off the critical path.
 * A leaf module both sides can depend on costs nothing.
 *
 * The two caches:
 *
 *   STATS_CACHE_PREFIX  a localStorage payload per user (lifetime profit,
 *                       session history, hand counts) with a 10-minute TTL. It
 *                       was not in USER_SCOPED_PREFIXES, so it survived a
 *                       sign-out on a shared device and getCachedFull read it
 *                       straight back. The two stats keys that WERE listed are
 *                       different ones: club_arena_player_stats and
 *                       club-arena-player-stats.
 *
 *   rangeMemo           an in-memory payload per (user, range), 60s TTL, added
 *                       so the range pills do not refire a 2.6s RPC. Keyed by
 *                       user id, so account B can never READ account A's entry
 *                       - but A's stats stayed resident in the tab for the rest
 *                       of its life, and a page reopened at /stats/<A> inside
 *                       the TTL still painted from it.
 */

/** localStorage key prefix for the SWR payload. Purged by clearUserCaches. */
export const STATS_CACHE_PREFIX = 'ps_stats_v4_contract2_';

/** How long a memoised per-range payload may be served without a refetch. */
export const RANGE_MEMO_TTL_MS = 60_000;

/**
 * `${userId}:${rangeKey}` -> payload. Deliberately untyped here so this module
 * stays a leaf: the page owns the FullStats shape and casts on the way out.
 */
const rangeMemo = new Map<string, { full: unknown; at: number }>();

export function readStatsRangeMemo(userId: string, rangeKey: string): unknown | null {
  const key = `${userId}:${rangeKey}`;
  const hit = rangeMemo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RANGE_MEMO_TTL_MS) {
    rangeMemo.delete(key);
    return null;
  }
  return hit.full;
}

export function writeStatsRangeMemo(userId: string, rangeKey: string, full: unknown): void {
  rangeMemo.set(`${userId}:${rangeKey}`, { full, at: Date.now() });
}

/** Drop every memoised payload. Sign-out, and any "something changed" refresh. */
export function clearStatsRangeMemo(): void {
  rangeMemo.clear();
}
