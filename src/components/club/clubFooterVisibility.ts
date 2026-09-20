import { isDiamondArenaClubKey, isDiamondArenaClubPath } from '../../lib/constants';
import { PUBLIC_PATHS, normalisePath } from '../../lib/seo';
import { isDiamondArenaPlayerPath } from '../arena/diamondArenaRoutes';
import { readClubContextParam } from '../../utils/clubScopedPath';

/** The query the Diamond footer's Hand History door carries. */
export const DIAMOND_HAND_HISTORY_PARAM = 'arena';
export const DIAMOND_HAND_HISTORY_VALUE = 'diamond';

/** Routes whose own immersive or public chrome must not be covered by the
 * authenticated Club Arena navigation footer. Every other application route
 * receives the one global footer from App.tsx. */
const FOOTERLESS_ROUTE_PATTERNS: readonly RegExp[] = [
  // The Club Arena root is the card-first lobby. Its own action tiles are the
  // navigation surface, and a fixed footer covers the bottom row at common
  // laptop/tablet heights.
  /^\/?$/,
  /^\/auth(?:\/|$)/,
  /^\/share\/hand(?:\/|$)/,
  /^\/replay(?:\/|$)/,
  /^\/sim(?:\/|$)/,
  /^\/table(?:\/|$)/,
  /^\/health(?:\/|$)/,
  /^\/legal(?:\/|$)/,
];

export function shouldShowClubFooter(pathname: string): boolean {
  if (isDiamondArenaClubPath(pathname)) return false;
  return !FOOTERLESS_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * The footer belongs to the LOBBY, not to a URL (Dan 2026-09-04: "it needs to
 * be there anytime you are in the lobby, regardless of how you got there or
 * which route you took"). The in-table "+" opens the club lobby as a tab while
 * the URL stays /table/<id>, so the route gate alone hid it. The second input
 * is the multi-table container saying "the tab on screen is a lobby".
 */
export function shouldShowClubFooterFor(
  pathname: string,
  inTabLobbyActive: boolean,
  selectedClubId?: string | null
): boolean {
  if (inTabLobbyActive && (selectedClubId === null || isDiamondArenaClubKey(selectedClubId)))
    return false;
  if (isDiamondArenaClubPath(pathname)) return false;
  return inTabLobbyActive || shouldShowClubFooter(pathname);
}

/**
 * DISCOVERABILITY PHASE 5 (2026-09-17). The footer is the AUTHENTICATED
 * navigation: every destination on it sits behind AuthGuard. On a public page
 * (the landing, Help Center, the legal documents - src/lib/seo.ts) a
 * signed-out visitor, and every crawler, was still served it, which is a
 * row of links to the login page plus 2.6 MB of footer artwork on a page
 * whose whole job is to be light and readable (Help Center measured 3.8 MB
 * on a phone in scripts/ci/route-performance.mjs; 1.2 MB without it). A
 * signed-in player keeps the footer on those pages exactly as before.
 */
/**
 * A DIAMOND PLAYER CAN FIND THEIR WAY (2026-09-19).
 *
 * The chip footer is kept off every Diamond Arena route by the three rules
 * above, and that is right: its six cells are chip club doors (the wheel, the
 * chip cashier, Club Data) and the artwork says so. What was wrong is that
 * nothing took its place, so a Diamond player standing in the lobby had no
 * way to Players, Hand History, Stats, Messages or the wallet.
 *
 * This is the answer for the DIAMOND footer. It is true in three places:
 *
 *   - a Diamond PLAYER route (`isDiamondArenaPlayerPath`): the lobby, the
 *     tournaments, the roster and its profiles, the messenger. Never an
 *     operator route, which keeps the safe shell and has no footer at all.
 *   - the Diamond lobby opened as a TAB on `/table/<id>`, for the same reason
 *     `shouldShowClubFooterFor` reads that input: the URL does not move.
 *   - the two global doors the footer itself opens, while they are scoped to
 *     the arena: `/hand-history?arena=diamond` and `/stats?club=diamond-arena`.
 *     Clearing the scope returns the page to the estate and the estate's
 *     footer.
 *
 * ONE BOTTOM EDGE, ONE BAR - AND ONLY THE FIRST TWO CASES ARE EXCLUSIVE ON
 * THEIR OWN. Under the arena, and in an arena lobby tab, the rules above
 * already answer false, so the two can never both be true. The third case is
 * different and saying "exclusive by construction" of it would be wrong:
 * `/hand-history` and `/stats` are ESTATE pages that `shouldShowClubFooter`
 * has always returned true for, and it cannot see a query string to change
 * its mind. So on those two paths BOTH rules are true, and `App.tsx` decides
 * it - the Diamond bar owns the edge and suppresses the chip one
 * (`!diamondFooterVisible &&`). `tests/the-lobby-always-has-its-footer.law.test.ts`
 * holds that guard, and `tests/unit/clubFooterRouteAudit.test.ts` states the
 * overlap as a fact rather than leaving a comment claiming it cannot happen.
 */
export function shouldShowDiamondFooterFor(
  pathname: string,
  search: string | null | undefined,
  inTabLobbyActive: boolean,
  selectedClubId?: string | null
): boolean {
  if (inTabLobbyActive) return isDiamondArenaClubKey(selectedClubId);
  if (isDiamondArenaPlayerPath(pathname)) return true;
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/hand-history') {
    const params = new URLSearchParams(search || '');
    return params.get(DIAMOND_HAND_HISTORY_PARAM) === DIAMOND_HAND_HISTORY_VALUE;
  }
  if (path === '/stats') return isDiamondArenaClubKey(readClubContextParam(search));
  return false;
}

export function shouldShowClubFooterForVisitor(
  pathname: string,
  inTabLobbyActive: boolean,
  selectedClubId: string | null | undefined,
  signedIn: boolean
): boolean {
  if (!signedIn && !inTabLobbyActive && PUBLIC_PATHS.includes(normalisePath(pathname)))
    return false;
  return shouldShowClubFooterFor(pathname, inTabLobbyActive, selectedClubId);
}
