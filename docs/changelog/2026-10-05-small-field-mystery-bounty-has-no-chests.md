# A mystery bounty of 10 or fewer entries has no chests (engine)

Dan, 2026-10-05, verbatim:

> "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS, ITS TREATING LIKE A SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT PERCENTAGES"

## What was true

Measured on production over the last seven days: every mystery bounty with 10
or fewer entries paid 100% to first and never opened its chests. The chests
stayed shut only by accident: activation defaults to "at the money", the
generated ladder paid one place, and one player left is the champion. The
companion database change (`claude/small-field-mystery-db-20261005`) pays those
events 50/30/20, and with three paid places "at the money" would open the
chests at three players left. So the rule has to be stated, not inferred.

## What changed

- `server/src/tournament/mysteryBountyActivation.ts`:
  `MYSTERY_BOUNTY_SMALL_FIELD_MAX_ENTRIES = 10` and
  `mysteryBountyFieldTooSmall`. `shouldActivateMysteryBounty` refuses with
  `small_field` at 10 or fewer total entries in every activation mode
  (at_the_money, percent_field, player_count), and with
  `entry_count_unknown` when the count is unreadable or nonsensical (fail
  closed). Every knockout keeps paying the flat pre-activation bounty, and
  the champion's residual is untouched.
- `TournamentManagerBase.maybeActivateMysteryBounty` reads the closed entry
  count (`readMysteryTotalEntries`, the same rows-plus-rebuys count as
  #6178) for every mode, not only percent_field; an unreadable count waits
  for the next sweep.
- `mysteryActivationMayOpenOnBust` never holds the table boundary for a
  field of 10 or fewer, and holds (so the sweep can read the count) when the
  count is still unread after entry closes.

Events with 11 or more entries are unchanged. Horses count as entries exactly
like humans (CLAUDE.md 10.5).

## Tests

`mysteryBountyActivation.test.ts`, `MysteryActivationCutoff.test.ts`,
`aMysteryPhaseOpensAtAHeldBoundary.test.ts`: refusal at 2..10 entries and
activation at 11 in each mode, re-entries counted, unknown counts wait, the
sweep seeds nothing at 10 and seeds at 11, and the bust boundary is never
held for a small field. All fail on the previous code.
