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
- The migration installs on top of
  `20260924033701_tournament_creation_refuses_what_the_client_refuses.sql`: its
  preimage is the definition 033701 leaves (`pg_get_functiondef` md5
  `f56ec7122c5a2cc2b72f5b6f13aeefbb`), and its replacement body keeps 033701's
  creation-rule check (`fn_tournament_config_refusal` on a changed configuration)
  alongside the zone. The first version pinned the same older preimage as 033701, so
  installed in version order it would always have refused on drift. Without 033701 it
  now refuses as `SCHEDULE_TIME_ZONE_REQUIRES_20260924033701` and changes nothing.
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

- `scripts/ci/test-schedule-time-zone.py` (new CI step): 69 cases passed on a local
  PostgreSQL 16 cluster. CI runs it on 17. It installs 033701 verbatim first (from
  `supabase/migrations/`, or `--creation-rules-migration PATH`; with neither it exits 2
  naming the dependency), proves this migration refuses without it, and proves after
  it that a new or changed configuration the creation rules refuse is still refused
  and writes nothing while an unchanged accepted one still toggles. Its post-image md5s
  and `@live-proof` lines come from that run.
  The engine and the database share the case table
  `scripts/ci/fixtures/schedule-time-zone/cases.json`.
- `scripts/ci/test-tournament-creation-rules.py`: 90 cases still pass for 033701 alone.
- `server/src/services/scheduleWallClock.test.ts`,
  `tests/unit/scheduleKeepsItsTimeZone.test.tsx`.

## Pending

- Install 20260924033701 first, then this migration, before this client is published.
  `TournamentScheduleService` selects `time_zone`, which does not exist until the
  migration runs. The owner confirms
  the pinned md5s of `fn_upsert_tournament_schedule(jsonb)` first (see the migration
  header). Once this is installed, 033701's own `@live-proof` md5 for
  `fn_upsert_tournament_schedule` no longer holds, by design; 033701's validator
  object still proves it live.
- An engine release is needed for zoned rows to be spawned on their wall clock.
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`scheduleTimeZoneIntegration`).
