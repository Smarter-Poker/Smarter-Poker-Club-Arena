/**
 * Club Arena's authoritative global footer.
 *
 * The approved artwork is the visual source of truth. The DOM above it only
 * supplies six semantic, full-cell navigation targets; it does not redraw or
 * substitute the approved icons, labels, leather, metal, or lighting.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  resolveTargetClub,
} from '../../utils/clubQuickLink';
import { withClubContext } from '../../utils/clubScopedPath';
import { clubIdFromPath } from './clubIdFromPath';
import { activeTabForPath, type TabKey } from './clubBottomNavTabs';
import styles from './ClubBottomNav.module.css';

interface ClubBottomNavProps {
  clubId?: string;
}

interface FooterDestination {
  key: TabKey;
  label: string;
  to: string;
}

const APPROVED_FOOTER_ART = `${import.meta.env.BASE_URL}images/club-footer/club-arena-footer.webp`;

function useResolvedClubId(explicit?: string, routeClubId?: string | null): string | null {
  const { user } = useAuthUser();
  const [resolved, setResolved] = useState<string | null>(
    () => explicit || routeClubId || resolveTargetClub(readCachedQuickLinkClubs())?.id || null
  );

  useEffect(() => {
    if (explicit || routeClubId) return;

    const fromCache = resolveTargetClub(readCachedQuickLinkClubs())?.id ?? null;
    if (fromCache) {
      setResolved(fromCache);
      return;
    }
    if (!user?.id) return;

    let cancelled = false;
    void fetchQuickLinkClubs(user.id).then((clubs) => {
      if (!cancelled) setResolved(resolveTargetClub(clubs)?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [explicit, routeClubId, user?.id]);

  return explicit || routeClubId || resolved;
}

export default function ClubBottomNav({ clubId }: ClubBottomNavProps) {
  const location = useLocation();
  const routeClubId = useMemo(() => clubIdFromPath(location.pathname), [location.pathname]);
  const resolvedClubId = useResolvedClubId(clubId, routeClubId);
  const activeTab = useMemo(() => activeTabForPath(location.pathname), [location.pathname]);

  const destinations = useMemo<FooterDestination[]>(() => {
    const clubRoot = resolvedClubId ? `/clubs/${resolvedClubId}` : null;
    return [
      { key: 'profile', label: 'Settings', to: clubRoot ? `${clubRoot}/settings` : '/settings' },
      { key: 'players', label: 'Players', to: clubRoot ? `${clubRoot}/members` : '/players' },
      { key: 'cashier', label: 'Cashier', to: clubRoot ? `${clubRoot}/cashier` : '/cashier' },
      /* Market and Stats have no club-scoped ROUTE, so they used to be
         hardcoded global while the four cells around them were club-aware —
         the same footer both keeping and dropping the club depending on which
         cell you pressed. Both pages read `?club=`, and `resolvedClubId` was
         already sitting right here; `withClubContext` supplies it. */
      {
        key: 'marketplace',
        label: 'Market',
        to: withClubContext('/marketplace', resolvedClubId),
      },
      { key: 'data', label: 'Data', to: clubRoot ? `${clubRoot}/data` : '/data' },
      { key: 'stats', label: 'Stats', to: withClubContext('/stats', resolvedClubId) },
    ];
  }, [resolvedClubId]);

  return (
    <nav className={styles.bottomNav} aria-label="Club Arena">
      <div className={styles.viewport}>
        <div className={styles.artwork}>
          <img
            className={styles.artworkImage}
            src={APPROVED_FOOTER_ART}
            alt=""
            width="1916"
            height="256"
            decoding="async"
            draggable={false}
          />
          <ul className={styles.navItems}>
            {destinations.map((destination) => (
              <li key={destination.key} className={styles.navCell}>
                <Link
                  className={styles.navItem}
                  to={destination.to}
                  aria-label={destination.label}
                  aria-current={activeTab === destination.key ? 'page' : undefined}
                  data-footer-control={destination.key}
                >
                  <span className={styles.visuallyHidden}>{destination.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </nav>
  );
}
