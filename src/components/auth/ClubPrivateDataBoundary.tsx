import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useUserStore } from '../../stores/useUserStore';
import { clearClubPrivateReadCaches } from '../../lib/clubPrivateReadCaches';
export { clearClubPrivateReadCaches } from '../../lib/clubPrivateReadCaches';

/** Only private reporting/management routes restart. Cashier drafts and tables stay mounted. */
export function isPrivateClubDataRoute(path: string): boolean {
  return /\/clubs\/[^/]+\/(members|data|agents|agent-dashboard|dashboard-full|operations|finance|control)(\/|$)/.test(
    path
  );
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
        if (!clubUUID || !userId || (payload.clubId && payload.clubId !== clubUUID)) return;
        if (payload.userId && payload.userId !== userId) return;
        clearClubPrivateReadCaches(userId, clubUUID);
        // The member detail owns immediate capability withdrawal in place.
        // Rejoining a scope must not discard its drafts or refetch every card.
        const memberDetail = /(?:^|\/)clubs\/[^/]+\/members\/[^/]+\/?$/.test(pathname);
        if (isPrivateClubDataRoute(pathname) && !memberDetail) setGeneration((value) => value + 1);
      }),
    [clubUUID, userId, pathname]
  );
  return <Fragment key={`${userId}:${clubUUID}:${generation}`}>{children}</Fragment>;
}
