/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Club Bottom Navigation Bar
 * premium-style fixed bottom navigation for club management
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { isClubStaff, type ClubRole } from '../../types/clubRoles';
import { Link, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './ClubBottomNav.module.css';
import { reportError } from '../../utils/errorReporter';

interface ClubBottomNavProps {
  clubId: string;
  userRole?: ClubRole;
  clubName?: string;
}

export default function ClubBottomNav({
  clubId,
  userRole = 'player',
  clubName,
}: ClubBottomNavProps) {
  const location = useLocation();
  const { user } = useAuthUser();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    // Dan 2026-08-20: Marketplace added. This list only drives the staggered
    // fade-in indices, but it MUST stay in sync with the links rendered below —
    // an item missing from here never gets its index added to visibleItems, so
    // it stays at opacity:0 forever. A nav tab that renders invisible is worse
    // than one that is absent.
    // Dan 2026-08-21: Stats added.
    const items = ['players', 'cashier', 'marketplace', 'data', 'stats', 'admin'];
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = items.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, []);

  /* The unread-badge block that used to live here was REMOVED with the
     Messenger tab on 2026-08-21. It ran a count query, opened a realtime
     channel on `notifications` and held a MasterBus listener - all of it
     feeding one number that nothing renders any more. Leaving it would have
     kept a live socket open per mounted nav for a badge that cannot appear.
     The header messenger owns unread now. */

  // Check if user has elevated permissions (can see Players/Admin tabs)
  const hasAdminAccess = isClubStaff(userRole) || userRole === 'agent';

  // Determine active tab from URL
  const getActiveTab = () => {
    const path = location.pathname;
    if (path.includes('/messages')) return 'messages';
    if (path.includes('/players') || path.includes('/members')) return 'players';
    if (path.includes('/cashier')) return 'cashier';
    if (path.includes('/marketplace')) return 'marketplace';
    if (path.includes('/dashboard') || path.includes('/data')) return 'data';
    if (path.includes('/stats')) return 'stats';
    if (path.includes('/settings') || path.includes('/admin')) return 'admin';
    return 'messages'; // default
  };

  const activeTab = getActiveTab();

  return (
    <nav className={styles.bottomNav}>
      {/* Navigation icons */}
      <div className={styles.navItems}>
        {/* Dan 2026-08-21: the Messenger tab is GONE from this bar.
            It is already in the global header, so the footer copy was a second
            door to the same room - and it was the one carrying the unread
            badge, which is why the badge appeared to float in the wrong place:
            .badge is absolutely positioned against .navItem, and this item's
            icon is narrower than the cell, so `right: 8px` put the dot in the
            gap between two tabs rather than on the icon.

            Removing the tab removes the badge with it, and the whole unread
            subscription that fed it (see above) - that query, its realtime
            channel and its bus listener existed ONLY for this badge. */}

        {/* Players - Always visible */}
        <Link
          to={`/clubs/${clubId}/members`}
          className={`${styles.navItem} ${activeTab === 'players' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(0) ? 1 : 0,
            transform: visibleItems.has(0) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
          </svg>
          <span className={styles.label}>Players</span>
        </Link>

        {/* Cashier */}
        <Link
          to={`/clubs/${clubId}/cashier`}
          className={`${styles.navItem} ${activeTab === 'cashier' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(1) ? 1 : 0,
            transform: visibleItems.has(1) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-2 0H3V6h14v8zm-7-7c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm13 0v11c0 1.1-.9 2-2 2H4v-2h17V7h2z" />
          </svg>
          <span className={styles.label}>Cashier</span>
        </Link>

        {/* Marketplace (Dan 2026-08-20).
            /marketplace is a top-level route, not a club-scoped one — there is
            no /clubs/:clubId/marketplace — so this links to the real path
            rather than inventing a nested one that would 404. */}
        <Link
          to="/marketplace"
          className={`${styles.navItem} ${activeTab === 'marketplace' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(2) ? 1 : 0,
            transform: visibleItems.has(2) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zM12 18H6v-4h6v4z" />
          </svg>
          <span className={styles.label}>Market</span>
        </Link>

        {/* Data/Dashboard */}
        <Link
          to={`/clubs/${clubId}/dashboard`}
          className={`${styles.navItem} ${activeTab === 'data' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(3) ? 1 : 0,
            transform: visibleItems.has(3) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
          </svg>
          <span className={styles.label}>Data</span>
        </Link>

        {/* Stats (Dan 2026-08-21: "stats should be on the bottom footer link
            as well"). /stats is the player's own stats page — a top-level
            route, like /marketplace above. */}
        <Link
          to="/stats"
          className={`${styles.navItem} ${activeTab === 'stats' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(4) ? 1 : 0,
            transform: visibleItems.has(4) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z" />
          </svg>
          <span className={styles.label}>Stats</span>
        </Link>

        {/* Admin — staff only.
            `hasAdminAccess` was computed and then never referenced, so this
            link rendered unconditionally and every ordinary member saw an
            Admin tab into /settings. That also made the `userRole` prop dead
            and `.navItem.disabled` dead CSS. */}
        {hasAdminAccess && (
          <Link
            to={`/clubs/${clubId}/settings`}
            className={`${styles.navItem} ${activeTab === 'admin' ? styles.active : ''}`}
            style={{
              opacity: visibleItems.has(6) ? 1 : 0,
              transform: visibleItems.has(6) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
            <span className={styles.label}>Admin</span>
          </Link>
        )}
      </div>
    </nav>
  );
}
