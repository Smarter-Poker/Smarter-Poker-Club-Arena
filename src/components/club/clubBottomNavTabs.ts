/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB BOTTOM NAV — which tab is the page you are already on?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Split out of ClubBottomNav.tsx so it can be unit-tested against the route
 * table without mounting React (and so the component file exports a component
 * and nothing else, which is what react-refresh wants).
 *
 * WHY SEGMENTS, NOT SUBSTRINGS
 *
 * This was a chain of `path.includes('/dashboard')`. Substring matching against
 * a route table this size is a standing trap:
 *
 *   /settlement-dashboard, /agent-dashboard, /union-dashboard  ->  read as Data
 *   /admin  (the PLATFORM console, not the club Profile page)  ->  read as Profile
 *
 * Matching whole path segments makes each of those an explicit decision. The
 * consequence of a wrong answer is not cosmetic: the matched tab is REMOVED
 * from the bar, so a false positive silently deletes a destination.
 */

export type TabKey = 'profile' | 'players' | 'cashier' | 'marketplace' | 'data' | 'stats';

/**
 * Path segments that mean "you are already on this tab's page", by tab.
 *
 * `dashboard-full` is the older multi-tab club dashboard and is deliberately
 * the SAME destination as Club Data, so it hides the Data tab too.
 * `cashier-classic` is the full cashier behind the Trade front door.
 * Deliberately ABSENT: `admin`, `agent-dashboard`, `settlement-dashboard`,
 * `union-dashboard`, `player-sessions` - different pages that a substring
 * match used to swallow.
 */
export const TAB_SEGMENTS: Record<TabKey, readonly string[]> = {
  profile: ['settings'],
  players: ['members', 'players'],
  cashier: ['cashier', 'cashier-classic'],
  marketplace: ['marketplace'],
  data: ['dashboard', 'dashboard-full', 'data'],
  stats: ['stats'],
};

/** The tab representing the page currently open, or null for anything else. */
export function activeTabForPath(pathname: string): TabKey | null {
  const segments = new Set(pathname.split('/').filter(Boolean));
  for (const [key, owned] of Object.entries(TAB_SEGMENTS) as Array<[TabKey, readonly string[]]>) {
    if (owned.some((s) => segments.has(s))) return key;
  }
  return null;
}
