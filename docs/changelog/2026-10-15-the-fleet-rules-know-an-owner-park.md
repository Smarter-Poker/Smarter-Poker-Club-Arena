# The Fleet Rules Know An Owner Park

## What Happened

On 2026-10-15 from 16:53 to 18:10 UTC the owner parked every cash table for a
horse wallet reset (operation `3d9c1ba1`, renewed once, resumed by its own
program). HorseCashActionsStopped (17:21), EngineTableCountAnomaly (17:22),
SLOHandsAreNotBeingDealt (17:32), HorseFleetCollapsed (17:33) and the engine's
own ClubArenaFleetFloorLost (17:33) all paged. Every one measured a stop the
owner had scheduled: the fleet rules honour the hourly break and knew nothing
of a park.

## The Fix

- `server/src/services/FloorParkWatch.ts` reads
  `fn_ca_operator_floor_park_share()` (migration `20261015181538`) every 30
  seconds and publishes `poker_operator_floor_park_share` and
  `poker_operator_floor_park_known` on the always-on registry. A failed,
  malformed or two-minute-stale read publishes 0, which silences nothing;
  before the migration is installed the share stays 0 and every rule pages as
  before.
- EngineTableCountAnomaly, HorseFleetCollapsed,
  HorseFleetThroughputRelativeDrop, HorseCashActionsStopped,
  HorseFleetNotSeated and SLOHandsAreNotBeingDealt carry
  `unless on() max_over_time(poker_operator_floor_park_share[6m]) >= 0.5`
  beside their break guard.
- DealRateVerifier stands ClubArenaFleetFloorLost down on the same fresh read,
  inside its below-floor branch only, with its streak reset.

## Why 0.5

Those rules page at half the healthy floor or below (HorseCashActionsStopped
150 of 313 actions a minute, HorseFleetThroughputRelativeDrop half of the same
hour). A park of less than half the floor cannot explain their breach, so it
silences nothing. The 2026-10-15 park held a share of 1.0.

## What Is Never Guarded

EngineHandsStopped and EngineHandsPerSecDropped: seated players dealt nothing
is a stall whatever the floor holds. A park cannot hide an outage for long:
the hold is a 60-minute lease only its own operation can renew, and the
floor-hold watchdog pages a lease nobody renewed or a hold renewed past 180
minutes.

## Proof

`server/src/services/FloorParkWatch.test.ts` and
`tests/an-owner-floor-park-is-not-an-outage.law.test.ts`.
