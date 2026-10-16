# An Idle Floor Is Not A Lagging Stats Index

Migration `20261015223846` (held draft; the owner installs it).

## What Happened

The owner parked the floor at 16:53 UTC on 2026-10-15. The last hand before
the resume was written at 17:33:14 and the next at 18:11:31. The stats index
had every hand there was: `ca_refresh_hand_player_index` sets `idx_ceil` to the
newest hand it indexed, so the ceiling stood at 17:33:14 because nothing newer
existed.

`ca_stats_health()` reported `indexLagSeconds` as `now()` minus that ceiling,
so the idle floor read as lag growing one second per second.
`ClubArenaStatsIndexLag` fired at 18:03 and `StatsHandIndexLagging` at 18:12
("38m 15s behind"), both for an index that was complete.

## The Fix

`indexLagSeconds` is now the age of the oldest hand the index has not reached:
the first `hand_history` row newer than the ceiling. With no newer hand the
lag is 0. With hands flowing, the oldest unindexed hand is the one right after
the ceiling, so a roller that really stops still reads as lag climbing one
second per second and both alerts keep their 30-minute bar. A NULL ceiling
still reads NULL. The read is one index probe (0.2 ms on production).

The engine's `StatsHealthMonitor` and the Prometheus rule read the same number
and need no change.

## Proof

`scripts/ci/test-an-idle-floor-is-not-index-lag.py` (native PostgreSQL,
workflow `an-idle-floor-is-not-index-lag.yml`), 17 checks: production's exact
text reads a 40-minute idle floor as 2,400 s; after the migration it reads 0,
a hand 10 s old after the idle floor reads 10 s, a roller stalled for 39
minutes with hands flowing still reads 2,340 s, a NULL ceiling reads NULL, the
postimage md5 equals production's derivation, grants and SECURITY DEFINER hold,
and a second run is refused.
