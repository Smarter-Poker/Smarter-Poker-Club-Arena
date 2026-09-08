# 2026-09-07 - Phase 8, part 1: a completed hand snapshot is kept for hours, not a week

`hand_state_snapshots` was 9.2 GB / 3.7 M rows - as many rows as
`hand_history` - because completed snapshots were kept for seven days.
Nothing reads a completed snapshot: every reader (engine restart recovery,
the tournament balancer's mid-hand check, the browser's RLS read) filters
`is_complete = false`. The hand itself lives in `hand_history`.

`sp_prune_hand_state_snapshots` now deletes completed snapshots after 6 hours
(incomplete ones keep their 30-day backstop), in 2,000-row rounds until a 20s
budget is spent so the call always fits inside the cron's 30s
statement_timeout - a single 10,000-row delete measured 19-30s under load and
would have been cut off whole. Measured, rolled back: 32,000 rows in 20.4s per
run, so the ~3.6 M-row backlog drains in four to five hours on the existing
2-minute cron, with no large delete.

Why this is Phase 8's first cut: the database is the root cause behind the
hourly crons timing out at 2 minutes and the daily deadlocks in
`refresh-player-stats`; the largest table by far (`solved_spots_gold`, 80 GB,
almost all TOAST) is the horse brain's solver artifact and is read, not
churned; `hand_history` (10 GB) is already held to Dan's 7-day horse retention
by a pruner that keeps up (2,235 rows older than 7 days at the time of
writing). The snapshot table was pure write amplification.

Applied live 22:20 UTC.
