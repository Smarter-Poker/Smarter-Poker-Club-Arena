# A Stuck Table Does Not Stop The Field, And A Dealing Tournament Is Never Dark

2026-10-21. Found by the follow-up to the 2026-10-20 horse daily audit, which saw
`phase6_context_issue_level_timing_stale` jump from 15.6k to 220k decisions.

## What Happened

Turbo Tuesday PKO `bc8e3d86-d970-4992-9e4d-15a2d4da3261` started 03:00 UTC with
a few-hour turbo ladder and finished at 23:12 UTC.

- Table `cc98f791` seated two players at 03:17 and never dealt: its admission was
  refused `F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN` (fixed at the source by
  #7588, migration `20261021172832`). The two were moved at 22:14.
- `advanceBlindLevel`'s no-dealer guard (2026-10-16) held the level for the whole
  field while that table failed admission, with no end. Hand history: big blind
  150 from 03:20 to 11:00, 250 from 11:00 to 22:14, then the owed turbo levels ran
  out in the last hour (to 386,100 at level 25).
- With the level held, no table row was written and few players busted, so
  `fn_ca_tournament_dark_candidates` read a tournament dealing 20 hands a minute as
  dark. The engine's dark sweep rebuilt its manager about hourly (for example
  14:07:04, six minutes after the 14:00 break ended), and each rebuild stopped
  every table for ten to twenty minutes: ten rebuild alerts and ten dark pages.

Prize and bounty pools were paid in full; no money correction is owed.

## What Changed

1. `TournamentManagerBase.FIELD_WITHOUT_DEALER_HOLD_MAX_MS` (10 minutes, equal to
   `TABLE_ADMISSION_PAGE_AFTER_MS`). A table without a dealer still holds the level
   from 30 seconds, so a refusal that heals quickly costs the parked seats nothing.
   Past ten minutes the table has paged as critical and the field plays on,
   announced once per table.
2. Migration `20261022010444`: `fn_ca_tournament_dark_candidates` counts the
   event's latest `hand_history` row as activity (one index-only probe on
   `idx_hand_history_tournament_created`; 33 ms for 161 running events).

## Pinned By

- `server/src/tournament/aLevelIsNotSpentWhilePartOfTheFieldHasNoDealer.law.test.ts`
- `server/src/aDealingTournamentIsNeverDark.law.test.ts`
