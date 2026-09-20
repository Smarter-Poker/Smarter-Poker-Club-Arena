/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A COUNT HAS THREE ANSWERS, NOT TWO (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every player-facing count in the lobby used to be typed `number | null` and
 * rendered `null` as the string "0". That folds "I could not tell" into
 * "nobody is here", which CLAUDE.md 10.86 rule 1 forbids by name: "'I could
 * not tell' is a distinct outcome and must have its own name. Never fold it
 * into pending, green, empty, zero or silence."
 *
 * It was not a theoretical risk. The Diamond Arena hit it on both of its
 * surfaces at once, and in both cases the zero was structural rather than
 * transient - it was never going to correct itself:
 *
 *  - on the home carousel, the ACTIVE figure came from
 *    `fn_batch_club_realtime_active_counts`, which reaches its seats through
 *    `club_members ... status IN ('active','approved')`. Diamond membership is
 *    an ENTITLEMENT - one row, status `automatic` - so that join matched
 *    nobody and the answer was 0 however many players were seated;
 *  - in the lobby, `get_club_home` short-circuits for a diamonds arena with
 *    `{found, access_only, arena_context}` and carries no `players_playing` at
 *    all, so the rail's only writer never ran and it printed 0 for ever.
 *
 * ═══ THE THREE ANSWERS ═════════════════════════════════════════════════════
 *
 *   a number        the figure. Printed.
 *   null / absent   NOT YET ASKED. Prints "0", because Dan's lobby rule is
 *                   "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS" and a first
 *                   paint has not failed at anything yet.
 *   COUNT_UNKNOWN   the read happened and could not tell. Prints the word.
 *
 * The distinction between the second and the third is the caller's to make,
 * and it is deliberately NOT inferred from null: only the caller knows whether
 * it is still waiting or has already been refused. A component that guesses
 * between those two is the defect this replaces.
 */

/** The read happened and could not answer. Never rendered as a number. */
export const COUNT_UNKNOWN = 'unknown';

/** A count rail's figure: the number, `COUNT_UNKNOWN`, or absent for loading. */
export type CountFigure = number | null | typeof COUNT_UNKNOWN;

/**
 * What an unreadable count says.
 *
 * The same word the freeroll clock beside it uses, and the same word the
 * wallet row uses for a balance it could not fetch: unknown has one name
 * across the lobby, so a player learns it once.
 */
export const COUNT_UNKNOWN_TEXT = 'Unavailable';

/** True when the figure is the explicit "could not tell". */
export function isCountUnknown(figure: CountFigure | undefined): boolean {
  return figure === COUNT_UNKNOWN;
}

/** What a rail prints for a figure. Never invents a number for an unknown. */
export function countText(figure: CountFigure | undefined): string {
  if (figure === COUNT_UNKNOWN) return COUNT_UNKNOWN_TEXT;
  if (figure == null) return '0';
  return figure.toLocaleString();
}
