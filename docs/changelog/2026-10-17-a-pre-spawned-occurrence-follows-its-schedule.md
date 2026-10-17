# A pre-spawned occurrence follows its schedule (2026-10-17)

## The class defect, named

The engine spawns occurrences days ahead and keys them on their slot time.
When a schedule's times change, the 2026-10-16 doubles-protection
(`scheduleTimeChange` / `resolveTimeChange`) correctly refuses to spawn new
times beside existing old-time occurrences — by keeping every date that
already holds one **on the old times**. Nothing then moved the occurrences
themselves, so a board change took the whole pre-spawn horizon (up to days)
to reach players. That is exactly what paged Dan on 2026-10-17: #7173 moved
the five Free Buy schedules to the :30 Chicago board and the 28 occurrences
already spawned for 10-17..19 sat at :00 until migration `20261017105003`
moved them by hand, two hours before the first slot.

A data migration needed twice for one cause was never a fix (10.11). This is
the hard-coded root fix, in the live path (10.12): no cron, no sweep, no
repair job — the board writer's own 60-second poll.

## The fix

`ScheduledTournamentService`:

- **`planOccurrenceConform` (pure).** For each look-ahead date at or past the
  change, pairs the date's claimed old-time keys with the schedule's new
  times, positionally on the two sorted lists, and plans each move (new
  start instant, new key spelling). Fail-closed: old/new lists of different
  lengths are ambiguous and plan nothing; a date before the change or already
  run on a retired timetable stays; a claimed new-key twin is never
  overwritten; a slot inside `CONFORM_MIN_LEAD_MS` (20 min) is too late to
  move onto.
- **`conformClaimedOccurrences`.** Re-reads each occurrence from rows and
  moves it only while it still qualifies — ANNOUNCED/REGISTERING, pool not
  finalized, pre-start by the same lead — guarded by the `start_time` it was
  read at. **Order is the safety:** `start_time` moves first, the spawn key
  renames second, so a failure between the two leaves the date reading "old
  time claimed", which `resolveTimeChange` keeps on the old times — nothing
  can double, and the rename is retried next poll (`alreadyMoved`). Stands
  down during the maintenance freeze. At most
  `OCCURRENCE_CONFORM_MAX_PER_POLL` (40) moves per schedule per poll.
- Wired into `processTimedSchedule` **before** `resolveTimeChange`, mutating
  the claimed set, so a conformed date takes its new times in the same poll.

**The guarantee is never part of a conform.** It is the settlement contract
`trg_freeze_registered_tournament_settlement_contract` froze at the first
entrant — the law migration `20261017105003` honored. A tier change reaches
the board when new occurrences mint from the schedule, exactly as the Free
Buy doubled tiers do from 2026-10-20.

## Pinned

`server/src/services/aPreSpawnedOccurrenceFollowsItsSchedule.law.test.ts`:
the Free Buy shape moves whole (14 of 15 slots over three dates, the dying
slot skipped), fail-closed cases, the 20-minute lead, move-before-rename
order read from source, no money columns in the conform, the freeze
standdown, the wiring order, and no cron/sweep/repair anywhere in the
service.
