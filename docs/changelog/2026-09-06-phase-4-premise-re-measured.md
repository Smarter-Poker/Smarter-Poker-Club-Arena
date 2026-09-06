# 2026-09-06 - Phase 4's premise, re-measured before building it

The chip-accounting roadmap's phase 4 reads:

> **Realtime load: partition and DROP PARTITION (roadmap 8.4).** WAL
> 1,854 kB/s against 1,880 kB/s capacity, and it fails as a spiral (a lagging
> slot reads WAL from disk).

Before building a partitioning project on a live money platform, I measured the
premise. **It no longer holds.** Every number below is from production between
23:19 and 23:29 UTC, at 520 hands/minute — normal peak load, not a quiet
window.

## What the numbers say

| what                  | roadmap                      | measured                                                                                                                                                   |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WAL generation        | 1,854 kB/s vs 1,880 capacity | **1,304 kB/s** over an 86-second sample (~70% of that capacity)                                                                                            |
| replication slots     | "fails as a spiral"          | 2 slots, both `active`, `wal_status: reserved`, 9 MB → 35 MB → 29 MB behind against **3.2 GB** of `safe_wal_size`. Drifting and recovering, not spiralling |
| realtime partitioning | to be built                  | **already built** — `realtime.messages` is partitioned by day, `messages_2026_09_03` .. `_09_09`, with future partitions pre-created and old ones dropped  |

A first 6-second sample read 1,448 kB/s; the 86-second one is the number to
trust, and it is the one quoted above.

## The high-churn tables are not what feeds it

Of the fourteen busiest tables by write volume, only `table_seats` is in the
`supabase_realtime` publication. `ca_settlements` (15.2M updates),
`ca_hand_player_idx` (8.9M inserts), `daily_challenge_progress_events` (8.5M
inserts), `table_hole_cards`, `hand_state_snapshots` — none of them are
published, so none is being decoded and fanned out to clients. The WAL is raw
write volume, and the decoder is already only reading what someone subscribes
to (#3339, merged today).

## Two tables I was wrong about

`hand_state_snapshots` is 8.7 GB with 2.95M rows older than 24 hours, and
`daily_challenge_progress_events` is 3.2 GB with 8.78M. I read that as ~16 GB
of stale data and a missing retention policy. Both readings were wrong, and
the data refuted each one in turn:

1. I guessed the prune was not running. `cron.job` 119
   (`sp_prune_hand_state_snapshots_2m`) runs every five minutes and has
   **succeeded 72 of 72 times in the last six hours**, averaging 2.7 seconds.
2. I guessed its predicate missed the rows — that the backlog was orphaned
   `is_complete = false` snapshots. It is the opposite: **2,946,785 of the old
   rows are `is_complete = true`**, exactly what the prune targets. Only 1,985
   are incomplete.

Reading the function settled it. `sp_prune_hand_state_snapshots` keeps
completed snapshots for **7 days** as a deliberate forensic window and
incomplete ones for 30 days, and the oldest completed row on the table is
2026-08-30 — exactly seven days old. The prune is working precisely as
designed; 8.7 GB is what that policy costs, not evidence of a defect. The
missions table is the same story (`fn_prune_daily_mission_operations(30)`,
daily at 05:23, 30-day retention).

Changing either window is a retention decision, and CLAUDE.md 10.5 records
that retention is Dan's to set — he decided the 7-day horse hand-history
window himself, on the record. So it is not changed here.

## Recommendation

**Do not build phase 4 as written.** There is no spiral to fix: WAL is at ~70%
of capacity with slots stable and 3.2 GB of headroom, the partitioning it
proposes already exists for the table that needed it, and the tables it would
target are large by working policy rather than by neglect. The realtime work
that merged today and over the preceding days appears to have closed it.

Its premise should be re-derived before anyone spends the effort. If WAL
pressure returns, the levers this measurement points at, in order, are the
unpublished high-churn tables (`ca_settlements`, `ca_hand_player_idx`,
`hand_state_snapshots`) and the retention windows that size them — the second
of which is Dan's call, not an agent's.
