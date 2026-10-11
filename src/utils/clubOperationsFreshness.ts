/**
 * Title Cased "how long ago". `formatAgo` in utils/clubDashboard returns
 * "just now" / "12s ago", which is correct for the pages already using it and
 * wrong for a page whose every word is capitalized, so the casing lives here
 * rather than changing a helper five other surfaces read.
 */
export function ago(then: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 10) return 'Just Now';
  if (secs < 60) return `${secs}s Ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m Ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h Ago`;
  return `${Math.floor(hours / 24)}d Ago`;
}

/**
 * What the freshness line says. A failed refresh must not take the AGE off
 * the numbers that are still on screen: an operator reading stale figures has
 * to be able to see how stale they are, and the first version of this line
 * dropped the timestamp the moment a poll failed.
 */
export function freshnessLabel({
  error,
  denied,
  loading,
  refreshedAt,
  now = Date.now(),
}: {
  error: boolean;
  denied: boolean;
  loading: boolean;
  refreshedAt: number | null;
  now?: number;
}): string {
  if (error) {
    return refreshedAt
      ? `Live Readings Unavailable, Last Read ${ago(refreshedAt, now)}`
      : 'Live Readings Unavailable';
  }
  if (denied) return 'Live Readings Restricted For This Role';
  if (refreshedAt) return `Updated ${ago(refreshedAt, now)}`;
  return loading ? 'Reading The Club' : 'Awaiting First Reading';
}
