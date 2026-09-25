# 2026-09-24 - a schedule is written with a zone only once the engine reads zones

## What changed

`src/utils/scheduleTimeZone.ts` gains `SCHEDULE_ZONES_REACH_THE_ENGINE` (false) and
`scheduleWriteTimeZone()`. The Create Tournament modal and the table-config schedule
editor take the zone from it, so every recurring schedule is written exactly as before
the time-zone change: UTC weekday and time, no zone.

## Why

#5188 merged the whole time-zone change: the database half is installed and the client
is published (2e851e8d). The engine half (scheduleWallClock) is merged but not live: every
`auto-deploy-hetzner.yml` run since at least 2026-09-24 14:01 UTC stops at the legacy
checkpoint (`captureEngine.bank_metadata_without_bank`), and production still runs engine
8825af51. That engine reads every row's weekday and time as UTC, so a row saved as
"Friday 20:00 America/Chicago" would have started at 20:00 UTC, five hours early.
No zoned row had been written (0 of 211 rows at 17:44 UTC).

## Evidence

`tests/unit/scheduleKeepsItsTimeZone.test.tsx`: the gate is closed, a gated-on write
carries the device zone, and Repeats Weekly saves Saturday 01:00 UTC with no zone.

## Pending

Set `SCHEDULE_ZONES_REACH_THE_ENGINE` to true in the change that records the engine
release containing #5188 verified at https://engine.smarter.poker/health.
