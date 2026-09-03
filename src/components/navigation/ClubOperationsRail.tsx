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

  return (
    <nav className={styles.rail} aria-label="Club Operations Sections">
      <div className={styles.chassis}>
        <div className={styles.identity} aria-hidden="true">
          <span className={styles.statusLight} />
          <span>Club Operations</span>
        </div>
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
