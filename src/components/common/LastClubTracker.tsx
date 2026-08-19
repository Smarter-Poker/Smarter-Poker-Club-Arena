/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAST CLUB TRACKER — records the last-visited club on every /clubs/:clubId route
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Before this existed, LAST_CLUB was only written when tapping a club card in
 * the lobby carousel, so deep links and bottom-nav entries left the lobby
 * quick links pointing at a stale club. Mounted once in App.tsx; renders
 * nothing.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { clubParamToUuid, rememberLastClub } from '../../utils/clubQuickLink';

const CLUB_ROUTE = /^\/clubs\/([^/]+)/;

export default function LastClubTracker() {
  const { pathname } = useLocation();

  useEffect(() => {
    const match = CLUB_ROUTE.exec(pathname);
    if (!match) return;
    const segment = decodeURIComponent(match[1]);
    if (segment === 'create') return; // /clubs/create is not a club visit
    const uuid = clubParamToUuid(segment);
    if (uuid) rememberLastClub(uuid);
  }, [pathname]);

  return null;
}
