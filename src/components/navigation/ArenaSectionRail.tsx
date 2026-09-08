import { Link, useLocation } from 'react-router-dom';
import {
  getActiveArenaSectionPath,
  getArenaSectionNavigation,
} from '../../config/arenaSectionNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { withClubContext } from '../../utils/clubScopedPath';
import styles from './ArenaSectionRail.module.css';
import { useCanCreateUnion, useCanOperateUnionNetwork } from '../../hooks/useCanCreateUnion';

export default function ArenaSectionRail() {
  const location = useLocation();
  const { canCreateUnion } = useCanCreateUnion();
  const { canOperateUnionNetwork } = useCanOperateUnionNetwork();
  /* This is the rail in Dan's 2026-09-02 screenshot — PLAY RECORDS / OVERVIEW
     / TOURNAMENTS / RESULTS / HANDS / SESSIONS / LEADERBOARDS. Its items are
     module-level constants with no club in scope, so every tab was a one-way
     door out of the club: arrive at Leaderboards carrying Deep Stack Society,
     click Sessions, and the club is gone. Reading the workspace here keeps
     the whole strip inside whichever club the current URL names. */
  const { routeClubId } = useClubWorkspace();
  const section = getArenaSectionNavigation(location.pathname, {
    canCreateUnion,
    canOperateUnionNetwork,
  });

  if (!section) return null;

  /* Active state is matched on the BARE path, before the club is stamped —
     `getActiveArenaSectionPath` compares pathnames, and a query string would
     never equal one. Stamping happens only on the `to` prop below. */
  const activePath = getActiveArenaSectionPath(location.pathname, section.items);

  return (
    <nav
      className={styles.rail}
      aria-label={`${section.label} Sections`}
      data-arena-section={section.id}
    >
      <div className={styles.chassis}>
        <div className={styles.identity} aria-hidden="true">
          <span className={styles.statusLight} />
          <span>{section.label}</span>
        </div>
        <ul className={styles.items}>
          {section.items.map((item) => {
            const isActive = item.path === activePath;
            return (
              <li key={item.path}>
                <Link
                  className={`${styles.item} ${isActive ? styles.active : ''}`}
                  to={withClubContext(item.path, routeClubId)}
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
