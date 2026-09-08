import { isDiamondArenaClubPath } from '../../lib/constants';

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
export function shouldShowClubFooterFor(pathname: string, inTabLobbyActive: boolean): boolean {
  if (isDiamondArenaClubPath(pathname)) return false;
  return inTabLobbyActive || shouldShowClubFooter(pathname);
}
