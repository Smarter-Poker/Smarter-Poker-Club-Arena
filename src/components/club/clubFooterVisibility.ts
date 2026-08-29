/** Routes whose own immersive or public chrome must not be covered by the
 * authenticated Club Arena navigation footer. Every other application route
 * receives the one global footer from App.tsx. */
const FOOTERLESS_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/auth(?:\/|$)/,
  /^\/share\/hand(?:\/|$)/,
  /^\/replay(?:\/|$)/,
  /^\/sim(?:\/|$)/,
  /^\/table(?:\/|$)/,
  /^\/health(?:\/|$)/,
  /^\/legal(?:\/|$)/,
];

export function shouldShowClubFooter(pathname: string): boolean {
  return !FOOTERLESS_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}
