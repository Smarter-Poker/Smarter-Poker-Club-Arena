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
import {
  clubParamToUuid,
  isConfirmedUnionClubId,
  rememberLastClub,
} from '../../utils/clubQuickLink';

const CLUB_ROUTE = /^\/clubs\/([^/]+)/;

export default function LastClubTracker() {
  const { pathname } = useLocation();

  useEffect(() => {
    const match = CLUB_ROUTE.exec(pathname);
    if (!match) return;
    const segment = decodeURIComponent(match[1]);
    if (segment === 'create') return; // /clubs/create is not a club visit
    const uuid = clubParamToUuid(segment);
    if (!uuid) return;

    let cancelled = false;
    (async () => {
      /**
       * UNION LAW (Dan 2026-08-23): a union is a `clubs` row, so a visit to a
       * union's hub club used to be recorded as "your last club". LAST_CLUB
       * feeds the cashier and marketplace quick links and the lobby fallback in
       * resolveLobbyClubId — all of which filter unions out, so nothing broke,
       * but it meant one wrong navigation (the MTT ticker's, before it was
       * fixed) quietly overwrote the real answer with one every consumer then
       * had to throw away. Don't record what nothing may use.
       *
       * Fails OPEN, like UnionSkinGuard: only a CONFIRMED union is skipped, so
       * a network blip cannot stop an ordinary club from being remembered.
       */
      if (await isConfirmedUnionClubId(uuid)) return;
      if (cancelled) return;
      rememberLastClub(uuid);
    })();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return null;
}
