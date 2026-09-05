/**
 * localTime - the player's clock, for the two places the stats page needs it
 * (Stats Page Programme phase 3).
 *
 * Day buckets are cut server-side by `ca_player_stats_full(p_user, p_days,
 * p_tz)`, so the page must SAY which zone the player is in, and must then
 * read the 'YYYY-MM-DD' labels that come back as LOCAL dates. `new Date('2026-
 * 09-03')` parses a date-only ISO string as UTC midnight, which every zone
 * west of Greenwich renders as the previous evening: a Chicago player's
 * "Sep 3" bar was labelled "Sep 2". Both helpers exist so that mistake has
 * one place to be wrong in, and it is not.
 */

/** IANA zone name from the browser, or 'UTC' when the runtime cannot say. */
export function resolvedTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * 'YYYY-MM-DD' (optionally longer) to a Date at LOCAL midnight of that day,
 * so `toLocaleDateString` labels the day the server bucketed, not the UTC
 * instant. Anything that is not a date-only string falls back to the
 * platform parser, which handles full timestamps correctly.
 */
export function localDateFromYmd(value: string): Date {
  const m = YMD.exec(value);
  if (m && value.length === 10) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(value);
}
