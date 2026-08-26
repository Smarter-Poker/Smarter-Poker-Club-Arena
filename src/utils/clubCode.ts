/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT COUNTS AS A CLUB CODE — ONE DEFINITION, SHARED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two screens let a player type a club code, and until 2026-08-26 they disagreed
 * about what a code is.
 *
 * HomePage's join modal accepted 10000-999999. ClubsPage's Discover tab required
 * `joinClubId.length !== 6` -- exactly six characters. Every club that exists has
 * a FIVE-digit `club_id`:
 *
 *     SHARK CLUB 25450 | Midway Union 55555 | Club JAQK 77777
 *
 * because all three creation paths generate `Math.floor(10000 + random * 90000)`.
 * So on the Discover tab, typing a real club code left JOIN CLUB permanently
 * greyed out, with no error text to say why -- the guard also returned early
 * without setting `joinError`. A working code, a dead button, and silence.
 *
 * Six digits still have to be accepted: `clubs.club_id` carries the column
 * default `(100000 + floor(random() * 900000))::integer`, so any insert path
 * that omits club_id -- a migration, a script, a future admin tool -- mints a
 * six-digit club, and that club must remain joinable.
 *
 * Import this rather than writing the check again. A third spelling of this
 * rule is how the first two came to disagree.
 */

/** The lowest and highest club_id either generator can produce. */
export const MIN_CLUB_CODE = 10000;
export const MAX_CLUB_CODE = 999999;

/**
 * True when `raw` is a club code a player could actually join with: all digits,
 * five or six of them, inside the range both generators produce.
 *
 * Whitespace is trimmed, so a pasted code with a trailing space still works.
 */
export function isJoinableClubCode(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (!/^\d{5,6}$/.test(trimmed)) return false;
  const n = Number(trimmed);
  return n >= MIN_CLUB_CODE && n <= MAX_CLUB_CODE;
}

/** The parsed integer, or null when the code is not joinable. */
export function parseClubCode(raw: string | null | undefined): number | null {
  return isJoinableClubCode(raw) ? Number((raw ?? '').trim()) : null;
}
