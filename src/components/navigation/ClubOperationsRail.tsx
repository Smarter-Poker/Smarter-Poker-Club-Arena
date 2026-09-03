import { Link, useLocation } from 'react-router-dom';
import {
  getActiveClubOperationPath,
  getClubOperationBadge,
  getClubOperationContext,
  getClubOperationItems,
  getClubOperationRailItems,
} from '../../config/clubOperationsNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import { useClubOperationsOverview } from '../../hooks/useClubOperationsOverview';
import { formatInt } from '../../utils/clubDashboard';
import styles from './ClubOperationsRail.module.css';

/**
 * The compact sibling rail for club staff pages. The fuller tool inventory
 * lives at /clubs/:clubId/operations; this rail keeps the highest-frequency
 * destinations one action away without rebuilding each page.
 */
export default function ClubOperationsRail() {
  const location = useLocation();
  const clubId = getClubOperationContext(location.pathname);
  const access = useClubNavigationAccess(clubId);
  const workspace = useClubWorkspace();
  /* The rail follows the operator across every tool, so it is where a queue
     badge earns the most. It reads through the same shared cache the
     operations page uses, so mounting both costs one query, not two. */
  const { overview } = useClubOperationsOverview(
    clubId &&
      access.isClubStaff &&
      !access.loading &&
      !access.error &&
      (clubId === workspace.routeClubId || clubId === workspace.clubUUID)
      ? workspace.clubUUID
      : null
  );

  if (!clubId || access.loading || access.error || !access.isClubStaff) return null;

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
            const badge = getClubOperationBadge(item, counts, permitted);
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
