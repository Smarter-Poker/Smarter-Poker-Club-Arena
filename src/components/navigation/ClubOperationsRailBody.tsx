import { Link, useLocation } from 'react-router-dom';
import {
  getActiveClubOperationPath,
  getClubOperationBadge,
  getClubOperationItems,
  getClubOperationRailItems,
} from '../../config/clubOperationsNavigation';
import type { ClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useClubOperationsOverview } from '../../hooks/useClubOperationsOverview';
import { formatInt } from '../../utils/clubDashboard';
import styles from './ClubOperationsRail.module.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HALF OF THE RAIL THAT READS, LOADED ONLY WHERE IT CAN RENDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS (2026-09-03)
 *
 * The rail mounts in AppLayout on every page that shows the global header, so
 * it is in the entry chunk - the bundle every player downloads before first
 * paint, before they have opened anything. Phase 1 gave the rail queue badges,
 * and the reading hook came with them: `scripts/ci/entry-chunk-delta.mjs`
 * caught three modules arriving in first paint on a club operator's account -
 * useClubOperationsOverview, useVisibilityRefresh and clubDashboard - paid for
 * by every player who will never open a staff tool.
 *
 * A limit would have let this through; the gate asks who just started paying.
 * The answer here is "nobody should", so the rail is split rather than the
 * baseline updated. ClubOperationsRail stays in the entry and decides whether
 * the rail applies at all - a route check and a permission check, both already
 * in first paint for other reasons. This file, which holds everything that
 * queries, loads only once that check says yes.
 */
export default function ClubOperationsRailBody({
  clubId,
  access,
}: {
  clubId: string;
  access: ClubNavigationAccess;
}) {
  const location = useLocation();
  const workspace = useClubWorkspace();
  /* The rail follows the operator across every tool, so it is where a queue
     badge earns the most. It reads through the same shared cache the
     operations page uses, so mounting both costs one query, not two. */
  const { overview } = useClubOperationsOverview(
    clubId === workspace.routeClubId || clubId === workspace.clubUUID ? workspace.clubUUID : null
  );

  const items = getClubOperationRailItems(clubId, access);
  const permitted = getClubOperationItems(clubId, access);
  const counts = overview?.counts || null;
  const activePath = getActiveClubOperationPath(location.pathname, items);
  const overviewItem = permitted.find((item) => item.id === 'overview');
  const homeBadge = overviewItem ? getClubOperationBadge(overviewItem, counts, permitted) : 0;
  // The Operations Center is where the identity plate goes. It is also the
  // Overview item, so the two must agree on one path rather than hard-coding
  // the suffix in a second place.
  const homePath = items.find((i) => i.id === 'overview')?.path ?? `/clubs/${clubId}/operations`;

  return (
    <nav className={styles.rail} aria-label="Club Operations Sections">
      <div className={styles.chassis}>
        {/*
          This read as the first button in the strip - same chassis, same
          casing, sitting left of Overview - and it was a div with
          aria-hidden. Clicking it did nothing, which is indistinguishable
          from a broken button. It is now the link its appearance already
          promised: the Operations Center, which is the parent of every
          other item in the rail. It carries aria-current when that page is
          the one you are on, so it is no longer possible for the whole rail
          to show nothing selected while you stand on /operations.
        */}
        <Link
          className={`${styles.identity} ${homePath === activePath ? styles.identityActive : ''}`}
          to={homePath}
          aria-current={homePath === activePath ? 'page' : undefined}
          title="Open The Club Operations Center"
        >
          <span className={styles.statusLight} aria-hidden="true" />
          <span>Club Operations</span>
          {homeBadge > 0 && (
            <span className={styles.badge} aria-label={`${homeBadge} Waiting`}>
              {formatInt(homeBadge)}
            </span>
          )}
        </Link>
        <ul className={styles.items}>
          {items.map((item) => {
            const isActive = item.path === activePath;
            /* The identity plate IS the Overview link and already carries the
               workspace total, so the Overview item in the strip would print
               the same number a second time, six pixels away. */
            const badge =
              item.id === 'overview' ? 0 : getClubOperationBadge(item, counts, permitted);
            return (
              <li key={item.id}>
                <Link
                  className={`${styles.item} ${isActive ? styles.active : ''}`}
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item.label}
                  {badge > 0 && (
                    <span className={styles.badge} aria-label={`${badge} Waiting`}>
                      {formatInt(badge)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
