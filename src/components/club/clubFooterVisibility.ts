import { isDiamondArenaClubKey, isDiamondArenaClubPath } from '../../lib/constants';
import { PUBLIC_PATHS, normalisePath } from '../../lib/seo';

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
