/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Club Bottom Navigation Bar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, binding:
 *
 * 1. THE CURRENT PAGE'S OWN TAB IS NOT RENDERED. "When I click any of the pages
 *    on the bottom and that page opens up, it should have all the other
 *    remaining footer options (except the page you just opened)." The bar is a
 *    list of places you are NOT, so tab positions shift as you navigate. That
 *    is intended - do not "fix" it back to a highlighted active tab.
 *
 * 2. THE BAR DOES NOT NEED A clubId FROM ITS CALLER. Marketplace (/marketplace)
 *    and Stats (/stats) are TOP-LEVEL routes with no :clubId in the path, which
 *    is exactly why they used to render with no footer at all - every call site
 *    guarded on `{clubId && <ClubBottomNav .../>}` and those pages had no clubId
 *    to give. The club resolves through resolveTargetClub (utils/clubQuickLink),
 *    the same rule the lobby quick links use: the last club you visited if you
 *    are still a member of it, otherwise your first club, unions excluded.
 *
 * The active tab is matched on whole path SEGMENTS, not substrings - see
 * clubBottomNavTabs.ts for why that distinction matters here.
 *
 * The staggered fade-in runs off the SAME array that renders, so an item can
 * never be left at opacity:0 - that was a real bug when the stagger list and
 * the JSX were maintained separately.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import {
  readCachedQuickLinkClubs,
  fetchQuickLinkClubs,
  resolveTargetClub,
} from '../../utils/clubQuickLink';
import { activeTabForPath, type TabKey } from './clubBottomNavTabs';
import styles from './ClubBottomNav.module.css';

interface ClubBottomNavProps {
  /**
   * The club the club-scoped tabs point at. OMIT on top-level routes
   * (/marketplace, /stats) - it is resolved from your club list instead.
   */
  clubId?: string;
}

interface Tab {
  key: TabKey;
  /** null when the destination needs a club and none could be resolved. */
  to: string | null;
  label: string;
  icon: ReactNode;
}

/**
 * Resolve the club the club-scoped tabs should point at when the caller has no
 * clubId of its own. Memory first (no network); the fetch only runs on a cold
 * cache, e.g. a deep link straight to /stats without ever opening the lobby.
 */
function useResolvedClubId(explicit?: string): string | null {
  const { user } = useAuthUser();
  const [resolved, setResolved] = useState<string | null>(
    () => resolveTargetClub(readCachedQuickLinkClubs())?.id ?? null
  );

  useEffect(() => {
    if (explicit) return; // the caller already knows; nothing to resolve
    const fromCache = resolveTargetClub(readCachedQuickLinkClubs())?.id ?? null;
    if (fromCache) {
      setResolved(fromCache);
      return;
    }
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const clubs = await fetchQuickLinkClubs(user.id);
      if (cancelled) return;
      setResolved(resolveTargetClub(clubs)?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [explicit, user?.id]);

  return explicit || resolved;
}

const ICONS: Record<TabKey, ReactNode> = {
  profile: (
    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  ),
  players: (
    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  ),
  cashier: (
    <path d="M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-2 0H3V6h14v8zm-7-7c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm13 0v11c0 1.1-.9 2-2 2H4v-2h17V7h2z" />
  ),
  marketplace: (
    <path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zM12 18H6v-4h6v4z" />
  ),
  data: (
    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
  ),
  stats: <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z" />,
};

export default function ClubBottomNav({ clubId }: ClubBottomNavProps) {
  const location = useLocation();
  const resolvedClubId = useResolvedClubId(clubId);
  const activeTab = useMemo(() => activeTabForPath(location.pathname), [location.pathname]);

  /**
   * Every tab, in bar order, minus the page you are on and minus any
   * club-scoped tab with no club - a link to '/clubs//settings' would route to
   * the club list and read as a broken tab.
   */
  const tabs = useMemo<Array<Tab & { to: string }>>(() => {
    const club = resolvedClubId;
    const all: Tab[] = [
      {
        key: 'profile',
        to: club ? `/clubs/${club}/settings` : null,
        label: 'Profile',
        icon: ICONS.profile,
      },
      {
        key: 'players',
        to: club ? `/clubs/${club}/members` : null,
        label: 'Players',
        icon: ICONS.players,
      },
      {
        key: 'cashier',
        to: club ? `/clubs/${club}/cashier` : null,
        label: 'Cashier',
        icon: ICONS.cashier,
      },
      // /marketplace and /stats are top-level routes. There is no
      // /clubs/:clubId/marketplace, so linking to one would 404.
      { key: 'marketplace', to: '/marketplace', label: 'Market', icon: ICONS.marketplace },
      {
        key: 'data',
        to: club ? `/clubs/${club}/dashboard` : null,
        label: 'Data',
        icon: ICONS.data,
      },
      { key: 'stats', to: '/stats', label: 'Stats', icon: ICONS.stats },
    ];
    return all.filter((t): t is Tab & { to: string } => t.to !== null && t.key !== activeTab);
  }, [resolvedClubId, activeTab]);

  // Stagger off the rendered list itself, so a tab that was hidden and is now
  // shown always gets its index and never sticks at opacity 0. The hook honours
  // prefers-reduced-motion (everything visible at once, no transition).
  const { style } = useStaggerAnimation(tabs.length, { staggerMs: 60 });

  /* Defensive only. `marketplace` and `stats` never resolve to null and the
     filter removes at most one entry, so this cannot fire today - but the
     alternative is rendering an empty <nav>, and a future tab list that is
     entirely club-scoped would make it reachable. */
  if (tabs.length === 0) return null;

  return (
    <nav className={styles.bottomNav} aria-label="Club Sections">
      <ul className={styles.navItems}>
        {tabs.map((tab, i) => (
          <li key={tab.key} className={styles.navCell}>
            <Link className={styles.navItem} to={tab.to} style={style(i)}>
              <svg
                className={styles.icon}
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                {tab.icon}
              </svg>
              <span className={styles.label}>{tab.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
