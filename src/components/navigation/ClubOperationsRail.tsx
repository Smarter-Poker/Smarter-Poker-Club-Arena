import { Link, useLocation } from 'react-router-dom';
import {
  getActiveClubOperationPath,
  getClubOperationContext,
  getClubOperationRailItems,
} from '../../config/clubOperationsNavigation';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
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

  if (!clubId || access.loading || access.error || !access.isClubStaff) return null;

  const items = getClubOperationRailItems(clubId, access);
  const activePath = getActiveClubOperationPath(location.pathname, items);
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
        </Link>
        <ul className={styles.items}>
          {items.map((item) => {
            const isActive = item.path === activePath;
            return (
              <li key={item.id}>
                <Link
                  className={`${styles.item} ${isActive ? styles.active : ''}`}
                  to={item.path}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
