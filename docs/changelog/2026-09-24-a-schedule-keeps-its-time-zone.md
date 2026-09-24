# 2026-09-24 - a recurring schedule keeps its time zone

## What changed

- `supabase/migrations/20260924045822_a_schedule_keeps_its_time_zone.sql` adds a
  nullable `tournament_schedules.time_zone` (an IANA name, checked by
  `tournament_schedules_time_zone_known`). When it is NULL, the stored weekday and
  `HH:MM` stay UTC, which is the original contract, and no existing row is re-timed.
  When it is set, they are the wall clock in that zone.
  `fn_upsert_tournament_schedule` accepts an optional `timeZone`: leaving it out on an
  update keeps the stored zone, null clears it, and an unknown name is refused as
  `time_zone_unknown`. The function body is pinned by md5 before it is replaced.
- Engine: `server/src/services/scheduleWallClock.ts` converts each zoned occurrence to
  UTC for its own local date. Daylight saving follows one rule: a time in the
  spring-forward gap runs at the first valid instant after it, and a time in the
  fall-back overlap runs once. `ScheduledTournamentService` uses it, and a zoned row's
  spawn key is unique per local date.
- Client: the schedule editors save the device zone with the row and name the zone
  wherever times are shown (`src/utils/scheduleTimeZone.ts`).

## Why

A Chicago owner's weekly 8:00 PM event was stored as 01:00 UTC on the next weekday.
After each daylight-saving change it ran one local hour off, twice a year.

## Evidence

- `scripts/ci/test-schedule-time-zone.py` (new CI step): 58 cases passed on a local
  PostgreSQL 16 cluster. CI runs it on 17. The engine and the database share the case
  table `scripts/ci/fixtures/schedule-time-zone/cases.json`.
- `server/src/services/scheduleWallClock.test.ts`,
  `tests/unit/scheduleKeepsItsTimeZone.test.tsx`.

## Pending

- Install the migration before this client is published. `TournamentScheduleService`
  selects `time_zone`, which does not exist until the migration runs. The owner confirms
  the pinned md5s of `fn_upsert_tournament_schedule(jsonb)` first (see the migration
  header).
- An engine release is needed for zoned rows to be spawned on their wall clock.
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`scheduleTimeZoneIntegration`).
