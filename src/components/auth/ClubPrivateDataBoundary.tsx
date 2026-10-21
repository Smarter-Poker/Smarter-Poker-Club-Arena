import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useUserStore } from '../../stores/useUserStore';
import { purgeRosterCache } from '../../lib/rosterCache';
import { removeClubDataCaches } from '../../lib/clubDataCache';
import { clearMembershipsWarmCache } from '../../lib/membershipWarmState';
import { clearStatsRangeMemo, STATS_CACHE_PREFIX } from '../../lib/statsCache';

/** Only private reporting/management routes restart. Cashier drafts and tables stay mounted. */
export function isPrivateClubDataRoute(path: string): boolean {
  return /\/clubs\/[^/]+\/(members|data|agents|agent-dashboard|dashboard-full|operations|finance|control)(\/|$)/.test(
    path
  );
}

export function clearClubPrivateReadCaches(userId: string, clubId: string): void {
  purgeRosterCache(userId, clubId);
  removeClubDataCaches(userId, clubId);
  clearMembershipsWarmCache();
  clearStatsRangeMemo();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STATS_CACHE_PREFIX)) continue;
      const identity = JSON.parse(key.slice(STATS_CACHE_PREFIX.length));
      if (Array.isArray(identity) && identity[1] === userId && identity[3] === clubId)
        localStorage.removeItem(key);
    }
  } catch {
    // Storage is optional; server authorization and the new component generation still apply.
  }
}

export default function ClubPrivateDataBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { clubUUID } = useClubWorkspace();
  const userId = useUserStore((state) => state.user?.id);
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      masterBus.subscribe('GAME_MANAGEMENT_ACCESS_CHANGED', (event) => {
        const payload = event.payload;
        if (!clubUUID || !userId || payload.clubId !== clubUUID) return;
        if (payload.userId && payload.userId !== userId) return;
        clearClubPrivateReadCaches(userId, clubUUID);
        if (isPrivateClubDataRoute(pathname)) setGeneration((value) => value + 1);
      }),
    [clubUUID, userId, pathname]
  );
  return <Fragment key={`${userId}:${clubUUID}:${generation}`}>{children}</Fragment>;
}
