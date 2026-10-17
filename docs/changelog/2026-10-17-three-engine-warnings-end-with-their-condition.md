# Three engine warnings end with their condition (2026-10-17)

Three warnings stayed open after the condition they describe had ended.

## The Free Buy audit and the published timetable

On 2026-10-16 the board moved to "a real room's day": Free Buys at 8:30, 12:30,
4:30, 8:30 and 12:30 Chicago, with guarantees 500 and 1,000. As
`docs/changelog/2026-10-16-a-real-rooms-day.md` records, the dates already
published, through Monday 2026-10-19, deliberately keep the timetable they were
published under (on the hour, 250 and 500). Read live on 2026-10-17: 15 such
events, and the first half-hour event is Tuesday 00:30.

The hourly audit judged those dates against the new timetable. It raised "40
problem(s) across 20 event(s)" at 03:01 UTC and would have kept reporting
through Tuesday. `auditFreeBuyRow` now reads a date before
`FREE_BUY_HALF_HOUR_BOARD_FROM` (2026-10-20) that sits on the previous
timetable's minute against that timetable's guarantees. A short prize on those
dates is still caught, and from 2026-10-20 the hour is wrong again. The watch
closes its own alert on a clean read, as before.

## The Stable Hand counter write

All three `HorseFleet.stableHandState` warnings ever raised were transient and
each was closed by hand. The 2026-10-16 13:02 one was the first cycle after
the thaw: its upsert never reached the API (no POST in the edge log), and the
next cycle, 30 seconds later, wrote. Two changes:

- `writeStateRows` sends a failed chunk once more inside the same cycle. It is
  a full-row upsert keyed on `horse_id`, so the second attempt is the same
  write.
- The fleet closes the warning after a cycle in which every folded row was
  accepted (`stableHandStateAlert.ts`), checked at most every ten minutes and
  read from the database, so a warning left by a replaced engine also closes.

## The rake spec checksum

`RakeSpec.checksum_unavailable` describes one unreadable tick, and every later
tick of 2026-10-17 matched. The guard now resolves open rows on the next
readable tick (match or mismatch), and on its first readable tick after boot.

Pinned in `FreeBuy.test.ts`, `stableHandStateAlert.test.ts` and
`rakeSpecGuard.test.ts`.
