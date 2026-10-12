/**
 * When each legal document's WORDS last changed - the one place that says so.
 *
 * 2026-09-29: the Terms page and the in-app acceptance modal both still said
 * January 2026 after the chip wording changed on 2026-09-08, and the Privacy
 * Policy said January 29 after a whole "Third-Party Services" section was
 * added on 2026-09-08 and Sentry was removed from it on 2026-09-16. A date on
 * a legal document that does not move with the text is a false statement.
 *
 * Change a date here in the same commit as the words it covers.
 * tests/legal-dates-move-with-the-words.law.test.tsx fingerprints each
 * document's rendered text and fails when the words move and the date does
 * not.
 */

/** The Terms of Service page and the acceptance modal that summarises them. */
export const TERMS_LAST_UPDATED = 'September 8, 2026';

/** The Privacy Policy page. */
export const PRIVACY_LAST_UPDATED = 'September 16, 2026';
