# 2026-09-10: the >80% CPU alert, and what was done about it

Supabase paged "more than 80% of the available CPU" on PokerIQ-Production at
20:00 CT on 2026-09-09. Dan asked for a permanent fix, not another tier bump:
the compute add-on had gone Medium -> Large -> XL in about ten days.

## What was measured (pg_stat_statements, reset 2026-09-09 07:55 UTC, 17 h)

~57 h of query execution on a 4-core XL = ~3.3 backends busy on average, at
~10k hands/h. Monday 2026-09-08 ran 25-35k hands/h. Where it went:

| share | what                                                                                                                                                                |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  ~27% | per-hand settlement: `fn_ca_commit_hand_settlement` 159 ms/hand, `fn_ca_process_hand_post_commit_obligations` 74 ms, `fn_project_hand_side_effects` 33 ms x2        |
|  ~10% | audit/reconcile crons (~130 pg_cron jobs)                                                                                                                           |
|   ~8% | `fn_cash_clusters_tick_all` ~900 ms every ~6 s + per-game ticks                                                                                                     |
|   ~7% | Realtime WAL decoding, driven by the engine's service_role subscription on `hand_projection_outbox` (494k writes / 17 h)                                            |
|   ~5% | `fn_aggregate_gto_v31_next`; ~5% `fn_seat_horse_in_seat_first_game` at 1.1 s/call; ~2.5% PostgREST pre-request at ~150 req/s; ~2% tournaments lobby query at 775 ms |

During the 01:05-02:30 UTC evening ramp (13k hands/h) settlement averaged
**1,370 ms/hand** with 25 active backends on 4 cores: the box was queueing.

## Migration 20260910011554 - audit crons use partial indexes and rest between runs

Two crons were full-scanning big tables to find nothing:

- `sp_prune_ca_settlements` (5x/hour) parallel seq-scanned all 3.9 GB of
  `ca_settlements`, reading 366k pages from disk each run, to delete 0 rows.
  **24.5 s -> 0.04 ms** with `idx_ca_settlements_final_updated_at`
  (`(updated_at) WHERE state='final'`). Real cron runs: 27-31 s -> 0.55 s.
- `fn_ca_drain_orphaned_post_commit_envelopes` (every 10 min) seq-scanned
  1.45 GB of `hand_atomic_commits` twice to find ~14 rows. **11.4 s -> 0.18 s**
  with `idx_hand_atomic_commits_post_commit_pending` (32 kB, pending rows
  only). Real cron runs: 27-53 s -> 0.8-1.2 s.

Both built with `CREATE INDEX CONCURRENTLY` on production (no write lock).

Three checks that are heavy by nature were re-judging the same window too
often: `ca-cash-pot-conservation-hourly` (128 s, 24 h window) -> every 6 h;
`ca-settlement-correctness-30m` (51 s) -> hourly; `ca-quick-reconcile-5m`
(13 s) -> every 10 min. Job names unchanged (ca_guard_inventory keys on them).

## Migration 20260910020459 - a cash seat stack write skips the tournament and club guards it never needed

Rolled-back probe (`EXPLAIN ANALYZE UPDATE table_seats SET stack = stack + 1`
on one live cash seat, warm): **18.75 ms, of which 16.63 ms triggers**, the row
itself ~2 ms. Cold: 92 ms / 89 ms. Three triggers were 14.1 ms of the 16.6:

- `aa_tournament_live_seat_proof_lock` 6.4 ms - a tournament guard on a cash seat
- `trg_table_seats_stamp_club` 6.0 ms - re-deriving the club on a stack-only write
- `terminal_tournament_seat_is_immutable` 1.7 ms - a tournament guard on a cash seat

Each got an early exit on rows where its own body provably ends in RETURN NEW
(both tournament ids NULL; nothing the stamp derives from changed). No guard
was removed; tournament seats run every original line. After: the three total
**0.25 ms**; a cash seat write is ~2 ms of guards plus `zz_freeze_guard`
(0.9-37 ms, noisy under load - the next target).

## Compute XL -> 2XL, 02:31 UTC

Dan's call, applied from the dashboard at 02:31 UTC (NOT at the :55 break;
Dan asked for it immediately). Project `RESIZING` 02:31-02:35. Verified from
inside Postgres, not the dashboard: postmaster restarted 02:34:36 UTC;
`shared_buffers` 4 -> 8 GB, `effective_cache_size` 12 -> 24 GB,
`max_connections` 240 -> 380, `max_parallel_workers` 4 -> 8, `work_mem`
16 -> 20 MB, `maintenance_work_mem` 1 -> 2 GB.

**Consequence of resizing outside the freeze:** cash games resumed within a
minute, but the engine did not re-adopt its RUNNING tournaments after the 4-min
outage. Ten tournaments dealt zero hands from 02:31 until the scheduled :55
engine restart re-adopted them (tournament hands back to ~230/min at 03:00).
Do the resize inside the :55 break next time; that is what the break is for.

## After (03:04 UTC, 30 min since restart, cache warm from ~02:45)

- 3.56 backends busy on 8 cores (was 3.3-3.7 on 4); 6-8 active backends
  (was 25); cache hit 98.8%.
- Settlement ~200 ms/hand with tournaments now ~55% of hands (was 1,370 ms
  in the hour before). Post-commit obligations 74 -> 31 ms. Side effects
  33 -> 26 ms.
- All cron runs since the restart succeeded.

## Open, found tonight, NOT fixed

**128 Spin tournaments are stuck in REGISTERING with 3 paid players each**, and
the engine calls `fn_spin_draw_and_settle_atomic` for them in a tight loop:
~87 calls/second since the restart (121k calls in 30 min, ~0.6 of a core).
Rolled-back probe on one of them returns
`{"ok": false, "reason": "projected_spin_draw_has_no_funding_proof"}`:
`tournaments.spin_multiplier` is set but there is no `spin_reserve_ledger`
row of kind `jackpot_draw`. Registrations date from 01:36 UTC onward, before
tonight's changes; it was 41k calls over the previous 17 h on the slower box.
Two things need doing, neither done here: (1) the engine's spin launcher needs
a backoff, a retry every second per spin against a deterministic refusal is a
loop; (2) the 128 spins hold real buy-ins (e.g. 300 chips in "100 Chip Deep
Stack Spin") and need either a funding proof or a refund - section 10.9 work,
with a probe first.

## Still to do for the per-hand cost (in order)

1. `zz_freeze_guard` / `fn_refuse_while_frozen`: check `fn_platform_frozen()`
   first and return; only serialize the row during the five frozen minutes.
2. Tournament seats: the same early-exit discipline for the guards that only
   apply to a status transition, not a stack write.
3. `hand_projection_outbox`: replace the engine's Realtime subscription with
   `NOTIFY` from the insert trigger + `LISTEN` in the engine (7% of DB time).
4. `fn_cash_clusters_tick_all` cadence/scope, `fn_seat_horse_in_seat_first_game`
   (1.1 s/call), the 775 ms tournaments lobby query.

Then measure, and size the compute back down at a :55 if the numbers say so.
