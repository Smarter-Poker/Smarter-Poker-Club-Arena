# 2026-09-29 - The legal pages say when they last changed

Found walking the app for store review. Every legal date was stale:

| Document                            | Said             | Words last changed                                                                 | Now says           |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ------------------ |
| Terms Of Service page               | January 29, 2026 | 2026-09-08, chip wording (#3604)                                                   | September 8, 2026  |
| Terms acceptance modal (in the app) | January 2026     | 2026-09-08, chip wording (#3604)                                                   | September 8, 2026  |
| Privacy Policy page                 | January 29, 2026 | 2026-09-08, Third-Party Services added (#3604); 2026-09-16, Sentry removed (#4718) | September 16, 2026 |

Fair Gaming and Promotions (August 29, 2026) are correct: neither has changed
since.

No wording changed. Only the dates, which are facts about the history of the
text, checked against `git log` for each file.

## So it cannot drift again

- `src/components/legal/legalDates.ts` is now the one place the dates live.
  The Terms page and the acceptance modal read the SAME constant, so they can
  no longer disagree with each other.
- `tests/legal-dates-move-with-the-words.law.test.tsx` (registered in
  `docs/laws.d/`) fingerprints each document's rendered words beside its date.
  Changing a word without moving the date fails it, with instructions.
  Verified by changing one word of the Privacy Policy: only the privacy
  fingerprint failed; restored, all three pass.

## Not changed, and why

One account accepted the Terms before the 2026-09-08 wording change
(2026-09-07 23:49 UTC); every other acceptance (55) is of the current text.
Whether a wording change should ask players to accept again is a legal
decision (CLAUDE.md 10.9), not a date fix, so nothing here re-prompts anyone.
