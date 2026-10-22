# The Horse Observation Snapshot Finds Hands Through The Player Index

Date: 2026-10-22

## What Was Slow

Live PostgREST transactions (usename `authenticator`) were sampled every 200ms
on production for transactions older than 200ms that held a lock on
`public.tables`, `public.hand_history` or `public.clubs`. The single largest
long holder was `fn_horse_committed_observation_snapshot`:

| Sample (02:45-03:30 UTC)                     | Result                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| 150 samples, any lock on the three tables    | snapshot present in 65 (next largest: 11)                                     |
| 60 samples, by relation                      | snapshot held `hand_history` AccessShare in 25                                |
| Oldest transaction seen                      | 7,523 ms                                                                      |
| `pg_stat_statements` since 2026-10-04        | 135,286 calls, mean 1,355 ms, sd 1,612 ms, max 7,999 ms (the 8s cap)          |
| 12 real actors x (6h, 1h, 15m), auto plans   | 6h windows: 74.4 s total, max 21.1 s per call                                 |

The engine aborts this read at 5 seconds, so a long call is also wasted work:
the capture worker records `source_unavailable` and retries the same window,
which is why queued capture rows carry 9 to 23 attempts.

## Why

`EXPLAIN (ANALYZE, BUFFERS)` of the candidate scan for an active horse:

```
Bitmap Index Scan on idx_hand_history_players_gin  rows=38,473
Bitmap Heap Scan  Filter: created_at window  Rows Removed by Filter: 36,704
Heap Blocks: exact=36,910   Buffers: read=35,531   Execution Time: 5,440 ms
```

The roster GIN (`players @> [{userId}]`) has no time dimension. It returns
every retained hand the horse ever played, and the six-hour window is checked
on the heap: tens of thousands of random page reads to keep 513 rows. When
the planner picked a generic plan it BitmapAnd-ed with
`idx_hand_history_created` instead, which reads all ~340,000 platform hands in
the window (0.6-0.8 s). Either way the cost scales with the whole platform's
volume, not the one horse's.

## The Fix

Migration `20261022034135_horse_observation_snapshot_finds_hands_through_the_player_in.sql`
(CREATE OR REPLACE FUNCTION only, so no table lock and it installs during live
play) finds candidates through `ca_hand_player_idx (user_id, created_at)`,
then qualifies each by a primary-key probe of the history row that rechecks the
canonical roster containment and the window. The index narrows the search; it
never decides membership.

Completeness inside the function's single snapshot:

- `fn_ca_commit_hand_settlement_before_lease_generation` writes the history
  row and its `hand_projection_outbox` row in one transaction.
- The projector writes the `ca_hand_player_idx` rows (with the hand's own
  `created_at`) and deletes the outbox row in one transaction.
- So every visible committed hand is reachable through the outbox or the
  index. The only per-player index delete that leaves the hand in place is a
  stat-fact `void` revision; those hands are added from
  `ca_hand_fact_revisions`. The horse-retention archive only runs on hands
  leaving `hand_history`, older than the one-day source window.

Signature, STABLE SECURITY INVOKER, search_path, grants, every refusal and
budget, the response shape and atomic receipt binding are unchanged.

## Equivalence, Measured Before Shipping

- 40 real actors, 30-minute windows, and 10 actors at 6h / 1h / 15m: the new
  candidate set equals the old GIN result exactly (0 mismatches).
- Every hand of the last 24 hours had all of its seated players in
  `ca_hand_player_idx`, except hands still in the outbox.
- Native PostgreSQL 16 differential test (old body vs new body, same fixture):
  identical responses for base, narrow window, missing receipt, budget
  overflow, 512/513 boundary, invalid window and null actor.
- The native probe `scripts/ci/probes/horse-committed-snapshot-native.mjs`
  installs this migration and adds a case: an outbox-pending hand and a voided
  index row are found, and an index row naming the actor for a hand whose
  roster does not is ignored.

## Before And After

See the PR for the live after measurement once installed.
