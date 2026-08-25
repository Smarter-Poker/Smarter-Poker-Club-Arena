/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Club Bottom Navigation Bar
 * premium-style fixed bottom navigation for club management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, binding, two changes:
 *
 * 1. THE CURRENT PAGE'S OWN TAB IS NOT RENDERED. "When I click any of the pages
 *    on the bottom and that page opens up, it should have all the other
 *    remaining footer options (except the page you just opened)." So the bar is
 *    a list of places you are NOT, and tab positions shift as you navigate.
 *    That is intended - do not "fix" it back to a highlighted active tab.
 *
 * 2. THE BAR NO LONGER NEEDS A clubId FROM ITS CALLER. Marketplace (/marketplace)
 *    and Stats (/stats) are TOP-LEVEL routes with no :clubId in the path, which
 *    is exactly why they used to render with no footer at all - every call site
 *    guarded on `{clubId && <ClubBottomNav .../>}` and those pages had no clubId
 *    to give. The club now resolves from LAST_CLUB / the lobby's cached club
 *    list (see utils/clubQuickLink), the same rule the lobby quick links use.
 *
 * The staggered fade-in is driven off the SAME array that renders, so an item
 * can never be left at opacity:0 - that was a real bug when the list here and
 * the JSX below were maintained separately.
 */

import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { isClubStaff, type ClubRole } from '../../types/clubRoles';
import { Link, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  readLastClubId,
  readCachedQuickLinkClubs,
  fetchQuickLinkClubs,
} from '../../utils/clubQuickLink';
import styles from './ClubBottomNav.module.css';

interface ClubBottomNavProps {
  /** Omit on top-level routes (/marketplace, /stats) - resolved from storage. */
  clubId?: string;
  userRole?: ClubRole;
  clubName?: string;
}

type TabKey = 'admin' | 'players' | 'cashier' | 'marketplace' | 'data' | 'stats';

/**
 * Resolve the club the club-scoped tabs should point at when the caller has no
 * clubId of its own. Memory first (no network); the fetch only runs on a cold
 * cache, e.g. a deep link straight to /stats without ever opening the lobby.
 */
function useResolvedClubId(explicit?: string): string | null {
  const { user } = useAuthUser();
  const [resolved, setResolved] = useState<string | null>(
    () => explicit || readLastClubId() || readCachedQuickLinkClubs()[0]?.id || null
  );

  useEffect(() => {
    if (explicit) {
      setResolved(explicit);
      return;
    }
    const fromStorage = readLastClubId() || readCachedQuickLinkClubs()[0]?.id || null;
    if (fromStorage) {
      setResolved(fromStorage);
      return;
    }
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const clubs = await fetchQuickLinkClubs(user.id);
      if (!cancelled && clubs[0]?.id) setResolved(clubs[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [explicit, user?.id]);

  return explicit || resolved;
}

export default function ClubBottomNav({ clubId, userRole = 'player' }: ClubBottomNavProps) {
  const location = useLocation();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const resolvedClubId = useResolvedClubId(clubId);

  /* The unread-badge block that used to live here was REMOVED with the
     Messenger tab on 2026-08-21. It ran a count query, opened a realtime
     channel on `notifications` and held a MasterBus listener - all of it
     feeding one number that nothing renders any more. Leaving it would have
     kept a live socket open per mounted nav for a badge that cannot appear.
     The header messenger owns unread now. */

  // Reserved for a future staff-only tab. isClubStaff is the shared predicate;
  // keeping the call here documents where that gate belongs.
  void (isClubStaff(userRole) || userRole === 'agent');

  /**
   * Which tab represents the page currently open. Returns null when the route
   * is not one of the six - nothing is hidden then and all six render.
   *
   * Order matters: '/clubs/:id/settings' and '/admin' are the same tab, and
   * '/dashboard' and '/data' are both Club Data.
   */
  const activeTab: TabKey | null = useMemo(() => {
    const path = location.pathname;
    if (path.includes('/players') || path.includes('/members')) return 'players';
    if (path.includes('/cashier')) return 'cashier';
    if (path.includes('/marketplace')) return 'marketplace';
    if (path.includes('/dashboard') || path.includes('/data')) return 'data';
    if (path.includes('/stats')) return 'stats';
    if (path.includes('/settings') || path.includes('/admin')) return 'admin';
    return null;
  }, [location.pathname]);

  /**
   * Every tab, in bar order. Club-scoped destinations need a club; when none
   * could be resolved they are dropped rather than pointed at '/clubs//...'.
   */
  const tabs = useMemo(() => {
    const all: Array<{ key: TabKey; to: string | null; label: string; icon: ReactNode }> = [
      {
        key: 'admin',
        to: resolvedClubId ? `/clubs/${resolvedClubId}/settings` : null,
        label: 'Profile',
        icon: (
          <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
        ),
      },
      {
        key: 'players',
        to: resolvedClubId ? `/clubs/${resolvedClubId}/members` : null,
        label: 'Players',
        icon: (
          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
        ),
      },
      {
        key: 'cashier',
        to: resolvedClubId ? `/clubs/${resolvedClubId}/cashier` : null,
        label: 'Cashier',
        icon: (
          <path d="M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-2 0H3V6h14v8zm-7-7c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm13 0v11c0 1.1-.9 2-2 2H4v-2h17V7h2z" />
        ),
      },
      {
        /* Dan 2026-08-20: /marketplace is a top-level route, not a club-scoped
           one - there is no /clubs/:clubId/marketplace - so this links to the
           real path rather than inventing a nested one that would 404. */
        key: 'marketplace',
        to: '/marketplace',
        label: 'Market',
        icon: (
          <path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zM12 18H6v-4h6v4z" />
        ),
      },
      {
        key: 'data',
        to: resolvedClubId ? `/clubs/${resolvedClubId}/dashboard` : null,
        label: 'Data',
        icon: (
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
        ),
      },
      {
        /* Dan 2026-08-21: "stats should be on the bottom footer link as well".
           /stats is the player's own stats page - top-level, like /marketplace. */
        key: 'stats',
        to: '/stats',
        label: 'Stats',
        icon: (
          <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z" />
        ),
      },
    ];

    // Drop the page you are already on, and any club-scoped tab with no club.
    return all.filter((t) => t.to !== null && t.key !== activeTab) as Array<{
      key: TabKey;
      to: string;
      label: string;
      icon: ReactNode;
    }>;
  }, [resolvedClubId, activeTab]);

  // Stagger the fade-in off the rendered list itself. Re-runs whenever the set
  // of tabs changes (i.e. on navigation), so a tab that was hidden and is now
  // shown always gets its index into visibleItems and never sticks at opacity 0.
  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    setVisibleItems(new Set());
    staggerTimersRef.current = tabs.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, [tabs]);

  if (tabs.length === 0) return null;

  return (
    <nav className={styles.bottomNav}>
      <div className={styles.navItems}>
        {tabs.map((tab, i) => (
          <Link
            key={tab.key}
            to={tab.to}
            className={styles.navItem}
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
              {tab.icon}
            </svg>
            <span className={styles.label}>{tab.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
