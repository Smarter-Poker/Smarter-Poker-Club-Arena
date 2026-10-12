/** Canonical aliases are accepted only when the actual native statement request names the original club. */
export function cashierStatementRouteMatches(
  observed: URL,
  requested: URL,
  expectedClubId: string,
  rpcClubId: unknown
): boolean {
  if (rpcClubId !== expectedClubId || observed.origin !== requested.origin) return false;
  const requestedRoute = requested.pathname.match(
    /^(.*\/clubs\/)([^/]+)(\/cashier\/statements)\/?$/
  );
  const observedRoute = observed.pathname.match(/^(.*\/clubs\/)([^/]+)(\/cashier\/statements)\/?$/);
  if (
    !requestedRoute ||
    !observedRoute ||
    requestedRoute[2] !== expectedClubId ||
    observedRoute[1] !== requestedRoute[1] ||
    observedRoute[3] !== requestedRoute[3]
  )
    return false;
  const token = observedRoute[2];
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token)) return token === expectedClubId;
  return token.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token);
}
