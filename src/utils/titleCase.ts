/**
 * TITLE CASE
 * ============================================================================
 * Dan's house rule, first written for popups (2026-08-20) and extended to the
 * Players tab and everything hanging off it (2026-08-23): "make sure the first
 * letter of every word is capitalized (including the ghost writing in the
 * search bar)".
 *
 * The transform lived inside utils/popupStyle.ts, reachable only through the
 * Toast layer. Screens that needed the same rule for a placeholder, a column
 * heading or a tab label had no way to ask for it and hand-capitalised instead,
 * which is how "Search members..." survived. One definition, two callers.
 *
 * Interior capitals are deliberately preserved, so acronyms (VIP, BBJ, NLH,
 * MTT), camel-case arena names (nutFlush, bountyHuntr) and proper nouns come
 * through untouched. Hyphens are word boundaries: "sub-agent" is two words to a
 * reader, so both halves get their capital.
 */

/**
 * Words start after whitespace, an opening bracket or quote, or a hyphen.
 * Byte-identical to the pattern popupStyle.ts used before it started importing
 * from here, so no popup message changes as a result of the move.
 */
const WORD_START = /(^|[\s([{"'‘“-])([a-z])/g;

export function toTitleCase(text: string): string {
  if (!text) return text;
  return text.replace(
    WORD_START,
    (_match, boundary: string, letter: string) => boundary + letter.toUpperCase()
  );
}

/**
 * Role and status values arrive from Postgres as snake_case enums
 * ('super_agent', 'sub_agent'). Underscores are not word boundaries a reader
 * sees, so they become spaces first: 'super_agent' -> 'Super Agent'.
 */
export function enumToTitleCase(value: string | null | undefined): string {
  if (!value) return '';
  return toTitleCase(value.replace(/_/g, ' '));
}
