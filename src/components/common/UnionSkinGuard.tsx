/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION SKIN GUARD — no player, agent or super agent stands on a union's club
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, binding: "players, agents, super agents, nobody should ever
 * see the union skins."
 *
 * A union lives in the `clubs` table as its own HUB CLUB (`is_union = true`),
 * so every `/clubs/:clubId/*` route — lobby, tournaments, cashier, financials,
 * dashboard, 28 of them — will happily render the UNION through the club
 * chrome: Union Bank, rake treasury, clubs wallet, "+ Create Tournament".
 *
 * Two separate bugs put people there, and both are now fixed at source:
 *   • the in-table "+" and every table-exit path stored `tables.club_id`, which
 *     is the union hub on a union game (see utils/clubQuickLink);
 *   • the MTT ticker opened `/clubs/${clubId}/tournaments` off that same column
 *     (see components/tournament/TournamentStartingTicker).
 *
 * This is the backstop for the ones nobody has found yet. Source fixes close
 * the links that exist today; this stops the page rendering at all, however the
 * player reached the URL — a stale bookmark, a shared link, or a new feature
 * that makes the same mistake next month.
 *
 * WHO IS EXEMPT: the union's own owner, and its `union_admins`. HomePage's
 * carousel already shows the union house-club card to its owner alone (UNION
 * LAW, 2026-08-19, HomePage.tsx:342), and that card is a deliberate
 * destination — this guard must not break the one person the surface is for.
 *
 * WHY IT FAILS OPEN: `isConfirmedUnionClubId` ejects only on a confirmed
 * `is_union = true`. A network blip must never throw a player out of their own
 * club lobby, so "don't know" has to mean "leave them alone".
 *
 * Mounted once in App.tsx. Renders nothing.
 */

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useUserStore } from '../../stores/useUserStore';
import { isUUID } from '../../utils/clubIdResolver';
import {
  clubParamToUuid,
  isConfirmedUnionClubId,
  resolveLobbyClubId,
} from '../../utils/clubQuickLink';
import { reportError } from '../../utils/errorReporter';

const CLUB_ROUTE = /^\/clubs\/([^/]+)/;

/** Route segments that are words, not clubs. */
const NON_CLUB_SEGMENTS = new Set(['create']);

/**
 * True when this user may stand on a union's own club surfaces: the union's
 * owner, or one of its admins.
 *
 * This half FAILS CLOSED — anything unproven is a no. By the time it is asked
 * the club is already CONFIRMED to be a union, so the cost of a wrong "yes" is
 * showing the union's treasury to an agent, and the cost of a wrong "no" is one
 * redirect for an owner who can re-enter from their carousel.
 */
async function mayViewUnionClub(clubUuid: string, userId: string): Promise<boolean> {
  try {
    const { data: club, error } = await supabase
      .from('clubs')
      .select('owner_id, union_id')
      .eq('id', clubUuid)
      .maybeSingle();
    if (error || !club) return false;
    if (club.owner_id && club.owner_id === userId) return true;
    if (!club.union_id) return false;

    const { data: admin } = await supabase
      .from('union_admins')
      .select('user_id')
      .eq('union_id', club.union_id)
      .eq('user_id', userId)
      .maybeSingle();
    return !!admin;
  } catch (err) {
    reportError(err, 'UnionSkinGuard.mayViewUnionClub');
    return false;
  }
}

/**
 * The viewer's id, from the store if it has hydrated and from the Supabase
 * session if it has not.
 *
 * AUDIT 2026-08-25 — THE RACE THIS CLOSES. The guard used to read
 * `useUserStore.getState().user?.id` once, inside an effect keyed only on the
 * pathname. On a cold load the store hydrates (and `loadProfile` finishes)
 * AFTER the first render, so a union owner opening their own club by link or
 * bookmark was seen as `userId === null`, the owner check was skipped
 * entirely, and they were redirected out of the one surface this guard's
 * exemption exists to protect. The effect never re-ran, because the user was
 * not a dependency — so it stayed wrong for the whole visit.
 *
 * Asking Supabase for the SESSION (a local read, not a network round trip)
 * settles it: an id means check the exemption, and a genuine "no session"
 * means an anonymous visitor, who cannot be the owner and should be ejected.
 */
async function resolveViewerId(): Promise<string | null> {
  const fromStore = useUserStore.getState().user?.id ?? null;
  if (fromStore) return fromStore;
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch (err) {
    reportError(err, 'UnionSkinGuard.resolveViewerId');
    return null;
  }
}

export default function UnionSkinGuard() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  /**
   * Subscribed, not read once: when the profile lands the guard re-evaluates
   * instead of standing on the answer it got before anyone was logged in.
   */
  const storeUserId = useUserStore((s) => s.user?.id ?? null);

  useEffect(() => {
    const match = CLUB_ROUTE.exec(pathname);
    if (!match) return;
    const segment = decodeURIComponent(match[1]);
    if (NON_CLUB_SEGMENTS.has(segment)) return;

    let cancelled = false;

    (async () => {
      // A 6-digit club code resolves from the cached list; one that cannot be
      // resolved is left alone rather than guessed at.
      const clubUuid = isUUID(segment) ? segment : clubParamToUuid(segment);
      if (!clubUuid) return;

      if (!(await isConfirmedUnionClubId(clubUuid))) return; // ordinary club
      if (cancelled) return;

      const userId = await resolveViewerId();
      if (cancelled) return;
      if (userId && (await mayViewUnionClub(clubUuid, userId))) return; // owner / union admin
      if (cancelled) return;

      // Eject. The destination is the same rule the "+" button and every table
      // exit now use: the club they entered through, never a union.
      const destination = await resolveLobbyClubId({
        viewerClubId: useUserStore.getState().currentClubId,
        tableClubId: null,
      });
      if (cancelled) return;

      // `replace` on purpose: Back must not bounce them straight into the union
      // again, which would read as the app fighting them.
      navigate(destination ? `/clubs/${destination}` : '/', { replace: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [pathname, navigate, storeUserId]);

  return null;
}
