/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POPUP STYLE — Dan's House Rule For Every Popup In Club Arena (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, from a live table session, verbatim: "any and all pop ups need the
 * first letter of every word capitalized, and forbid the use of em bars."
 *
 * Enforced HERE, in one transform the Toast layer applies to every message it
 * renders — not as a convention call sites are asked to remember. The codebase
 * carries hundreds of toast strings written by many agents over months; a
 * style that lives in a doc drifts by the next commit, a style that lives in
 * the render path cannot.
 *
 * THE TWO RULES
 *
 *  1. TITLE CASE — the first letter of every word is capitalized. Existing
 *     interior capitals are preserved, so acronyms (VIP, BBJ, NLH), camel-case
 *     product names and proper nouns come through intact: "check your
 *     connection" → "Check Your Connection", "reconnected to the table" →
 *     "Reconnected To The Table".
 *
 *  2. NO EM DASHES — U+2014 (and its en-dash sibling U+2013, which reads the
 *     same on a phone) never appear. A dash used as a clause break becomes a
 *     period + space; a dash used as a range or joiner keeps the hyphen.
 *     "Connection lost — the server may fold for you" →
 *     "Connection Lost. The Server May Fold For You".
 */

/**
 * Words start after whitespace, an opening bracket/quote, or a hyphen —
 * "auto-fold" is two words to a reader, so both halves get their capital.
 */
const WORD_START = /(^|[\s([{"'‘“-])([a-z])/g;

/** An em/en dash used as a clause break: surrounded by spaces. */
const DASH_CLAUSE = /\s+[--]\s+/g;

/** Any stray em/en dash left over (unspaced, decorative, doubled). */
const DASH_ANY = /[--]/g;

export function formatPopupText(message: string): string {
  if (!message) return message;
  return (
    message
      // Clause-break dashes become sentence breaks…
      .replace(DASH_CLAUSE, '. ')
      // …anything else dash-like becomes a plain hyphen.
      .replace(DASH_ANY, '-')
      // First letter of every word up. Interior capitals untouched.
      .replace(WORD_START, (_, boundary: string, letter: string) => boundary + letter.toUpperCase())
  );
}
