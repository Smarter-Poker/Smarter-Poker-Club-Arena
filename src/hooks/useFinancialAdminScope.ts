/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHICH CLUB IS THIS MONEY PAGE ABOUT, AND MAY THIS PERSON SEE IT?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The financial admin pages live at GLOBAL paths (/financial-admin,
 * /settlement-dashboard, /settlement-history, /credit-admin, /rate-audit) and
 * until 2026-09-10 not one of them asked either question. Each read a money
 * table with no club filter, so:
 *
 *   - an operator of two clubs saw both clubs' rake, agents and settlements
 *     summed into one set of tiles, with no column saying which was which;
 *   - a union overseer (whose RLS grant covers every club in the union) saw
 *     the whole union's invoices rendered as "this club's history";
 *   - the only gate on the credit console was "is staff of ANY club", so a
 *     co-owner of one club opened the credit limits of every club RLS let
 *     them read.
 *
 * RLS contained the worst of it, which is exactly why nobody noticed: the
 * numbers were plausible, just not the club's.
 *
 * THIS HOOK IS THE ONE ANSWER, built from the pieces the already-scoped pages
 * use rather than a fresh membership query:
 *
 *   1. The club named on the URL wins (`/clubs/:clubId/...` or `?club=`), read
 *      through `resolvePageClubId` steps 1-2 - the same reader the wallet,
 *      Flash Pool and XMTT pages use. It is resolved to a UUID, and a name that
 *      resolves to nothing is an error, never a silent substitute.
 *   2. Without a club on the URL, PLATFORM STAFF (`fn_is_platform_admin`'s
 *      list, mirrored by `isPlatformStaffRole`) see the whole platform: that
 *      is the audience these pages were written for, and narrowing Dan to one
 *      club would take the estate view away from the one account that needs it.
 *   3. Everyone else gets the club where they hold a FINANCE role, chosen by
 *      `pickPreferredClubId` (last club visited, else the first of a stable
 *      list) - the rule the admin and agent dashboards already follow.
 *   4. A club is only handed back once the viewer's role in it passes
 *      `getClubNavigationCapabilities(...).canViewFinance` - the vocabulary
 *      the club rail, the hamburger and ClubCapabilityGuard already share.
 *      `ca_can_view_club_finances` in Postgres is the same list; the database
 *      remains the enforcement boundary.
 *
 * Fails CLOSED: not signed in, no finance role anywhere, an unreadable
 * membership, a club that does not resolve - all of them are `denied` or
 * `error`, and `clubScoped()` below refuses to build a query for either.
 *
 * `tests/admin-money-pages-are-scoped.law.test.ts` pins that every money read
 * on those pages goes through `clubScoped` and binds its error.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from './useAuthUser';
import { reportError } from '../utils/errorReporter';
import { isPlatformStaffRole } from '../utils/platformRoles';
import { pickPreferredClubId, resolvePageClubId } from '../utils/resolvePageClubId';
import { readClubContextParam } from '../utils/clubScopedPath';
import { CLUB_FINANCE_ROLES, getClubNavigationCapabilities } from '../config/clubArenaNavigation';

export type FinancialAdminScopeStatus = 'loading' | 'ready' | 'denied' | 'error';

export interface FinancialAdminScope {
  status: FinancialAdminScopeStatus;
  /**
   * The UUID every money read on the page is filtered to. Null in exactly
   * one `ready` case: `platformWide`. Null in every non-ready state.
   */
  clubId: string | null;
  /** Platform staff standing on no club see the whole platform. */
  platformWide: boolean;
  /** The viewer's club_members.role in `clubId`, when there is one. */
  clubRole: string | null;
  isPlatformStaff: boolean;
  userId: string | null;
  /** What to tell the viewer when `denied` or `error`. Title Case, no dashes. */
  message: string | null;
  reload: () => void;
}

const LOADING: Omit<FinancialAdminScope, 'reload'> = {
  status: 'loading',
  clubId: null,
  platformWide: false,
  clubRole: null,
  isPlatformStaff: false,
  userId: null,
  message: null,
};

const NO_FINANCE_ROLE_MESSAGE =
  'This Page Is For Club Owners, Admins And Super Agents. Your Clubs Have Not Been Changed.';
const CLUB_NOT_FOUND_MESSAGE = 'That Club Could Not Be Found. Nothing Has Been Changed.';
const UNVERIFIED_MESSAGE = 'Your Club Access Could Not Be Verified. Nothing Has Been Changed.';

/**
 * Resolve the club a global-path money page renders, and whether the signed-in
 * viewer may see its finances.
 */
export function useFinancialAdminScope(): FinancialAdminScope {
  const { user, isHydrating } = useAuthUser();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const location = useLocation();
  const explicitRef = routeClubId || readClubContextParam(location.search);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  const [state, setState] = useState<Omit<FinancialAdminScope, 'reload'>>(LOADING);

  useEffect(() => {
    let cancelled = false;
    const userId = user?.id || null;

    if (!userId) {
      if (!isHydrating) {
        setState({
          ...LOADING,
          status: 'denied',
          message: 'Sign In To Open This Page.',
        });
      } else {
        setState(LOADING);
      }
      return undefined;
    }

    setState(LOADING);

    (async () => {
      try {
        const profileResult = await supabase
          .from('profiles')
          .select('role')
          .eq('id', userId)
          .maybeSingle();
        if (cancelled) return;
        if (profileResult.error) {
          reportError(profileResult.error, 'FinancialAdminScope.platform_role_lookup');
        }
        // An unreadable profile is not staff. Fail closed.
        const isPlatformStaff =
          !profileResult.error && isPlatformStaffRole(profileResult.data?.role);

        // 1. A club named on the URL. Resolved through the shared reader, with
        //    the fallback OFF: on a money page "some other club" is worse than
        //    "no club".
        if (explicitRef) {
          const clubId = await resolvePageClubId({
            routeClubId,
            search: location.search,
            userId,
            allowFallback: false,
          });
          if (cancelled) return;
          if (!clubId) {
            setState({
              ...LOADING,
              status: 'error',
              isPlatformStaff,
              userId,
              message: CLUB_NOT_FOUND_MESSAGE,
            });
            return;
          }
          const membership = await supabase
            .from('club_members')
            .select('role')
            .eq('club_id', clubId)
            .eq('user_id', userId)
            .maybeSingle();
          if (cancelled) return;
          if (membership.error) throw membership.error;
          const clubRole = membership.data?.role || null;
          const allowed = getClubNavigationCapabilities(clubRole, isPlatformStaff).canViewFinance;
          setState({
            status: allowed ? 'ready' : 'denied',
            clubId: allowed ? clubId : null,
            platformWide: false,
            clubRole,
            isPlatformStaff,
            userId,
            message: allowed ? null : NO_FINANCE_ROLE_MESSAGE,
          });
          return;
        }

        // 2. Platform staff on no club: the whole platform.
        if (isPlatformStaff) {
          setState({
            status: 'ready',
            clubId: null,
            platformWide: true,
            clubRole: null,
            isPlatformStaff: true,
            userId,
            message: null,
          });
          return;
        }

        // 3. The club where the viewer holds a finance role. The filter is
        //    deliberately role-scoped (a club where they are a plain member
        //    would only be refused a line later), and the choice among several
        //    is the shared last-visited-else-first rule.
        const memberships = await supabase
          .from('club_members')
          .select('club_id, role')
          .eq('user_id', userId)
          .in('role', [...CLUB_FINANCE_ROLES])
          .order('joined_at', { ascending: true });
        if (cancelled) return;
        if (memberships.error) throw memberships.error;
        const rows = memberships.data || [];
        const clubId = pickPreferredClubId(rows.map((m) => m.club_id));
        if (!clubId) {
          setState({
            ...LOADING,
            status: 'denied',
            isPlatformStaff,
            userId,
            message: NO_FINANCE_ROLE_MESSAGE,
          });
          return;
        }
        const clubRole = rows.find((m) => m.club_id === clubId)?.role || null;
        setState({
          status: 'ready',
          clubId,
          platformWide: false,
          clubRole,
          isPlatformStaff,
          userId,
          message: null,
        });
      } catch (err) {
        reportError(err, 'FinancialAdminScope.load_failed');
        if (!cancelled) {
          setState({
            ...LOADING,
            status: 'error',
            userId,
            message: UNVERIFIED_MESSAGE,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // location.search is folded into explicitRef; routeClubId feeds the resolver.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isHydrating, explicitRef, routeClubId, revision]);

  return { ...state, reload };
}

/**
 * Apply the scope to a money query. The ONLY way a read on an admin money page
 * is allowed to touch a club-keyed table (the law test checks for this call).
 *
 * - platform-wide: the query is returned as it is - the viewer is platform
 *   staff and RLS is the boundary;
 * - a club: `.eq(column, clubId)`;
 * - anything else: THROWS. A page must not issue a money read before the scope
 *   is `ready`; the throw lands in the page's own catch and renders as a load
 *   failure rather than as somebody else's numbers.
 */
export function clubScoped<Q extends object>(
  query: Q,
  scope: Pick<FinancialAdminScope, 'status' | 'clubId' | 'platformWide'>,
  column: string = 'club_id'
): Q {
  if (scope.status !== 'ready') {
    throw new Error('A financial read was attempted before the club scope was ready.');
  }
  if (scope.platformWide) return query;
  if (!scope.clubId) {
    throw new Error('A financial read was attempted with no club in scope.');
  }
  // PostgREST's `.eq` returns `this`; the cast only tells the compiler so.
  return (query as unknown as { eq: (c: string, v: string) => Q }).eq(column, scope.clubId);
}
