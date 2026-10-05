import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  getActiveArenaSectionPath,
  getArenaSectionNavigation,
} from '../../config/arenaSectionNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { withClubContext } from '../../utils/clubScopedPath';
import styles from './ArenaSectionRail.module.css';
import { useCanCreateUnion, useCanOperateUnionNetwork } from '../../hooks/useCanCreateUnion';
import { useUnionRouteId } from '../../hooks/useUnionRouteId';
import { useAuthUser } from '../../hooks/useAuthUser';
import { unionService } from '../../services/UnionService';
import { reportError } from '../../utils/errorReporter';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

interface UnionRailAuthority {
  unionId: string;
  userId: string;
  revision: number;
  canOversee: boolean;
  canManageGames: boolean;
}

export default function ArenaSectionRail() {
  const location = useLocation();
  const { canCreateUnion } = useCanCreateUnion();
  const { canOperateUnionNetwork } = useCanOperateUnionNetwork();
  const { user } = useAuthUser();
  const unionRouteRef = useMemo(() => {
    const match = location.pathname.match(/^\/unions\/([^/]+)/);
    if (!match || match[1] === 'create') return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }, [location.pathname]);
  const { unionId, unionRef } = useUnionRouteId(unionRouteRef);
  const [unionAuthority, setUnionAuthority] = useState<UnionRailAuthority | null>(null);
  const [authorityRevision, setAuthorityRevision] = useState(0);
  /* This is the rail in Dan's 2026-09-02 screenshot — PLAY RECORDS / OVERVIEW
     / TOURNAMENTS / RESULTS / HANDS / SESSIONS / LEADERBOARDS. Its items are
     module-level constants with no club in scope, so every tab was a one-way
     door out of the club: arrive at Leaderboards carrying Deep Stack Society,
     click Sessions, and the club is gone. Reading the workspace here keeps
     the whole strip inside whichever club the current URL names. */
  const { routeClubId } = useClubWorkspace();

  useMasterBusSubscription('UNION_UPDATED', (payload) => {
    if (unionId && (!payload.unionId || payload.unionId === unionId)) {
      setAuthorityRevision((current) => current + 1);
    }
  });
  useMasterBusSubscription('GAME_MANAGEMENT_ACCESS_CHANGED', () => {
    if (unionId) setAuthorityRevision((current) => current + 1);
  });

  useEffect(() => {
    let live = true;
    setUnionAuthority(null);
    if (!user?.id || !unionRef || !unionId) {
      return () => {
        live = false;
      };
    }

    void Promise.allSettled([
      unionService.canOverseeUnion(unionId),
      unionService.isUnionAdmin(unionId, user.id),
    ]).then(([overseer, gameManager]) => {
      if (!live) return;
      if (overseer.status === 'rejected') {
        reportError(overseer.reason, 'ArenaSectionRail.union_overseer_authority', { unionId });
      }
      if (gameManager.status === 'rejected') {
        reportError(gameManager.reason, 'ArenaSectionRail.union_game_authority', { unionId });
      }
      setUnionAuthority({
        unionId,
        userId: user.id,
        revision: authorityRevision,
        canOversee: overseer.status === 'fulfilled' && overseer.value,
        canManageGames: gameManager.status === 'fulfilled' && gameManager.value,
      });
    });

    return () => {
      live = false;
    };
  }, [authorityRevision, unionId, unionRef, user?.id]);

  const authorityForCurrentUnion =
    unionAuthority &&
    unionAuthority.unionId === unionId &&
    unionAuthority.userId === user?.id &&
    unionAuthority.revision === authorityRevision
      ? unionAuthority
      : null;
  const section = getArenaSectionNavigation(location.pathname, {
    canCreateUnion,
    canOperateUnionNetwork,
    canOverseeCurrentUnion: authorityForCurrentUnion?.canOversee === true,
    canManageCurrentUnionGames: authorityForCurrentUnion?.canManageGames === true,
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
