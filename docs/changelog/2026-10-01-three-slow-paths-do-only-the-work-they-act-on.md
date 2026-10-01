# Three slow paths do only the work they act on (2026-10-01)

Migration `20261001010106_three_slow_paths_do_only_the_work_they_act_on`.
Law: `tests/three-slow-paths-do-only-the-work-they-act-on.law.test.ts`.

Production was cancelling 700-1,300 statements every 10 minutes. Three paths
were named: the cash buy-in, the Daily Missions outbox drain, and the Club Data
snapshot. Each cost below was read from production, not inferred. A concurrent
agent owns the post-hand chain; none of it is touched here, and where a path's
time was contention the blocker is named.

## 1. `atomic_table_buyin` - its own reads, not a lock

Before: 7,519 calls at 7,269 ms mean (pg_stat_statements since 2026-09-28);
13-45 statement timeouts per 10 minutes on 2026-09-30 19:00-01:00 UTC
(Postgres log, `parsed.query`), 82 calls at 9.0 s mean in the 30 minutes to
01:09 UTC.

Contention or own work: 44 samples of buy-in backends at 0.2 s found **no lock
waits**: 39 were `DataFileRead`/`DataFilePrefetch`, 4 CPU, 1 BufferMapping.

The reads: the buy-in gate calls `fn_nit_check(table, user, NULL)` and refuses
only on `reason = 'career_vpip'`. 42 live cash tables have NIT on with a
maintain floor and none has a career floor, so every buy-in at them ran the
MAINTAIN branch. On a fresh buy-in the player has no live roster row, the
window start is NULL, and the branch counts the player's whole history in the
game: `idx_ca_hand_facts_user_pos` over `ca_hand_facts` (14 M rows, 9.8 GB).

| measurement                           | value                                    |
| ------------------------------------- | ---------------------------------------- |
| EXPLAIN (ANALYZE, BUFFERS), one horse | 10,760 rows, 8,767 page reads, 14,651 ms |
| rolled-back probe, horse A            | fn_nit_check 7,755 ms cold               |
| rolled-back probe, horse B            | fn_nit_check 14,510 ms cold              |
| rest of the buy-in (same probes)      | 21-138 ms                                |

The answer was then discarded. The fix asks only what the door acts on:
`fn_nit_career_check(table, user)` is fn_nit_check's career block verbatim
(same table read, same `ca_hand_facts` count, same reasons), and the gate calls
it instead. `fn_nit_check` itself, and the engine's NIT eviction that uses its
maintain answer, are unchanged.

### Money is identical

One `DO` block, rolled back: the live gate and the patched gate (built in
`pg_temp`) bought the same fixture - horse `2930eb16`, table `75fded97`
(PLO8 0.25/0.50, NIT on, maintain floor set), seat 4, 50.00, same idempotency
key - each in a sub-block that was rolled back before the next ran.

- Rows: club wallets, the seat, the wallet journal row, the chip ledger row,
  the cash session, the original-funding receipt, the idempotency key and
  `tables.current_players` compared field by field (ids and wall-clock
  columns excluded): **identical**.
- Write set from `pg_stat_xact_user_tables` (inserts, updates, deletes per
  table): **identical across all 14 tables** the buy-in touches -
  tables, chip_ledger, table_seats, club_members, cash_game_roster,
  cash_player_session, wallet_transactions, ca_club_player_daily,
  game_management_events, union_pnl_original_flows (1),
  union_pnl_inventory_events (2), transaction_idempotency_keys,
  union_pnl_transaction_frames, cash_participant_funding_receipts.
- Time: **49,130 ms cold old vs 138 ms new**; on a second run with the old
  path's pages cached, 294 ms vs 119 ms.

A horse buys in through the same RPC and the same check; nothing branches on
`is_horse`.

## 2. `sp_drain_daily_challenge_event_outbox` - mostly waiting on the horse claim

Before: 13,311 calls at 12,596 ms mean; 118 calls at 14.8 s mean in the 30
minutes to 01:09 UTC. The queue is not behind (966 rows, oldest two minutes);
the four shards run every minute until it is empty, about 2,000 events a
minute.

One event's own work is small. Rolled-back probes: enqueue 2.7 ms warm, the
receipt index probe on the 14 GB `daily_challenge_progress_events` 3-10 ms
cold, the three period assignments 2.2 ms.

Where the time goes - 1,278 samples of the drain backends at 0.1 s:

| state                              | share     |
| ---------------------------------- | --------- |
| Lock/advisory                      | 41% (524) |
| WAL (WALWrite, WalSync, WALInsert) | 21% (274) |
| DataFileRead                       | 14% (180) |
| CPU                                | 14% (174) |
| MultiXact SLRU                     | 9% (117)  |

Every advisory wait sampled (124 of 124) was blocked by
`SELECT public.fn_ca_horse_claim_due(500)`, which holds each horse's
`daily-missions-user` key until its run commits (cron: 23.9 s average, 120 s
max over the last two hours). The drain waited 250 ms for that key - 3 s after
three skips - and then skipped the player anyway.

Changes:

- `fn_drain_daily_challenge_event_outbox_user` tries the player key once
  (`pg_try_advisory_xact_lock`, the same key `fn_lock_daily_mission_user`
  takes) and, if it is held, raises `lock_not_available` into the existing
  skip handler at once. The profile lock and its patience are unchanged.
- `sp_drain_daily_challenge_event_outbox` commits each player's transaction
  with `synchronous_commit = off`. The event is booked and its outbox row
  deleted in that one transaction, so a crash that loses an unflushed commit
  loses both and the event is drained again; any later synchronous commit
  flushes it first.

Not changed, and the owner should look: `fn_ca_horse_claim_due` holding up to
500 claims' player locks for its whole run (another lane changed it at
`20260930233500`). Committing per claim would remove the contention at its
source; it is a design change in that lane.

## 3. `ca_club_data_snapshot` - a sort no index could serve

The live check `tests/e2e/club-data-deep.spec.ts:110` reads shark-club. Cold,
the snapshot took 14 s (statement timeout 8 s): summary 5.7 s, previous
summary 2.3 s, rows 4.6 s, data_updated_at 1.8 s.

- `fn_ca_club_game_rows` picks the 100 newest tournaments with facts in range
  `ORDER BY tr.start_time DESC NULLS LAST`. `idx_tournaments_start_time` read
  backward yields `DESC NULLS FIRST`, so the planner read all 299,393
  tournaments (parallel index-only scan, 12,557 buffers, 9,850 ms cold) and
  sorted them. `tournaments.start_time` is NOT NULL (no NULL rows, column
  constraint), so `DESC` is the same order; with it the plan walks the index
  backward and stops at 370 rows: **10.5 ms**. The migration refuses to run if
  the column ever becomes nullable.
- The summaries read the club's daily rows through the primary key with a heap
  fetch each (55,649 buffers for 53,688 rows in 14 days).
  `ca_club_tournament_daily_club_day_cover_idx (club_id, stat_date) INCLUDE
(tournament_id, fee, winnings, updated_at)` makes them index-only, and the
  table, never autovacuumed (1,712 of 5,666 pages all-visible), gets
  thresholds so the visibility map stays fresh - the idiom of
  `20260929130144`.

The 57 s read at 20:14 UTC fell inside a minute with 153 cancellations across
the database; that burst is the shared-buffer churn the buy-in scan above was
part of (8,767 random reads of a 9.8 GB table per buy-in).

## After

(see below - measured after the apply)
