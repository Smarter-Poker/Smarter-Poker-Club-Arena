# A stats refresh steps around a live hand (2026-10-03)

Launch-gate sweep. Migration `20261003032438`.

## What the rows said

refresh-player-stats-hourly (job 76), `cron.job_run_details`: of the 7 runs to 03:17 UTC, 4 were cancelled by the role's 120 s limit (the budget is fixed in `20261003025058`) and 2 died as the deadlock victim, the second at 03:17 after the budget had landed: `deadlock detected ... while inserting index tuple in relation "player_stats"`.

## Why

The refresh upserts every (user, club) row of the last 90 minutes in one `INSERT ... ON CONFLICT`, in no particular order, holding each row lock until the cron transaction commits. The per-hand writers of `player_stats` (the hand_history fold-stats trigger and the post-commit projection) lock a hand's seat rows in their own order. Two writers taking the same rows in different orders form a cycle.

## What changed

- Existing rows are locked first, in key order, `FOR UPDATE SKIP LOCKED`; a row a live hand is writing is left to that hand and refreshed by the next run (same 90-minute window).
- The upsert writes only the rows it locked plus keys that do not exist yet, in key order.
- A block still chosen as a deadlock victim rolls back alone, releasing its locks, and is retried up to three times before failing as before.

Exact substitution against the pinned preimage `a823ee7a...`, postimage `7b24a8ea...`; owner, security, settings and grants unmoved. Not money, not a watched guard.
