/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB SLUG + ILIKE HELPERS — shared by every club-creation path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * clubs.slug has a UNIQUE index (idx_clubs_slug). Different club names can
 * normalize to the same slug ("Alpha Club!" and "Alpha  Club" both become
 * "alpha-club"), so a plain name-derived slug can collide even after the
 * duplicate-NAME check passes. When that happened, the create retry loop
 * retried with a fresh club_id but the SAME slug and failed every attempt
 * with an unhelpful "Failed to create club".
 *
 * Strategy: attempt 0 uses the pretty slug; later attempts (or an empty
 * normalization, e.g. a name of all symbols) append/use the unique 5-digit
 * club_id so the slug is unique by construction.
 */

/** Normalize a club name to a URL slug (may be empty for all-symbol names). */
export function normalizeClubSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Slug for a create attempt. Attempt 0 tries the pretty slug; any retry
 * (which only happens after a unique-violation) makes it collision-proof by
 * appending the random 5-digit club_id chosen for that attempt.
 */
export function buildClubSlug(name: string, clubIdNumber: number, attempt: number): string {
  const base = normalizeClubSlug(name);
  if (!base) return `club-${clubIdNumber}`;
  return attempt === 0 ? base : `${base}-${clubIdNumber}`;
}

/**
 * Escape ilike pattern characters in user input so a club named "100%" is
 * matched literally in duplicate-name checks instead of acting as a wildcard.
 */
export function escapeIlikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}
