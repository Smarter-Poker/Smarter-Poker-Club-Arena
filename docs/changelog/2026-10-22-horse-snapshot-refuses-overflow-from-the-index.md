# The Horse Observation Snapshot Refuses An Overflowing Window From The Index

Date: 2026-10-22

## What Was Still Slow

PR #7669 (`20261022034135`, installed 05:27 UTC, run 39727159245) moved the
candidate search of `fn_horse_committed_observation_snapshot` off the roster
GIN onto `ca_hand_player_idx`: a six-hour call went from 9.7 s to 1.6-3.7 s.
Measured after install, `pg_stat_statements` showed 64 calls at a mean of
2,424 ms. The remaining cost was one case: the capture worker's first slice
is usually the full six hours, an active horse plays 1,800-2,700 hands in it,
and the function read 513 history rows (random heap, roster recheck, receipt
join, payload sizes) only to answer `hand_budget_exceeded`. The worker then
refines the slice and asks again. On production the index read that finds
those hands took 2-15 ms; the 513 heap probes took 0.4-3 s cold.

## The Fix

Migration `20261022054023`: before any history row is read, count up to 513
index rows for the actor in the window whose `(created_at, id)` still exists
in `hand_history`. Each index row is written by the projector from the hand's
own roster with the hand's own `created_at` (production, one full hour of
253,474 rows: 0 orphans, 0 timestamp mismatches, 0 users absent from the
roster), so 513 of them prove overflow. The check reads
`idx_ca_hand_player_idx_user_time` and `idx_hand_history_time_identity` only.

It can only refuse. Under the budget the unchanged roster-qualified read runs,
so every snapshot is identical to the predecessor's, and a refusal only makes
the worker refine to a smaller slice that is read exactly. The refusal keeps
the old overflow answer's keys, reason and empty hand list; `actionCount` and
`sourceBytes` are NULL because nothing was measured, and the engine reads
only `status` and `reason` from an unavailable answer.

## Proof Before Shipping

- Production, read-only: 25 active actors x (6 h, 3 h, 1 h) windows, the
  precheck against the installed function. 43 overflow, 32 snapshot; 0 false
  refusals, 0 overflows missed. Precheck total 422 ms for all 75 windows;
  the installed function 48,818 ms for the same 75.
- Native PostgreSQL (`scripts/ci/test-horse-snapshot-overflow-precheck.py`,
  workflow `horse-snapshot-overflow-precheck.yml`): applies the migration
  chain, checks it reproduces production's predecessor md5, and compares old
  and new definitions in one statement for: empty, 40 hands among another
  player's, 512 and 513 hands, 400 hands with 200 orphan and 200
  out-of-window index rows, outbox / voided / roster-over-index hands, and a
  missing receipt. Replay is accepted by the md5 guard.

## After Install

Recorded in the PR once the migration is installed.
