# The write path keeps only the indexes it reads (2026-10-03)

Launch-gate sweep. Migration `20261003031000`.

## What the rows said

The database is saturated on WAL writes, which is what stretches PostgREST calls past the engine's lease-proof window, slows tournament finishes and slows cash accrual. Since the stats reset at 2026-09-28 16:36 UTC: 1.31 TB of WAL (206 MB/min on average; 343-577 MB/min in 90-second samples on 2026-10-03 02:46 and 03:26 UTC), 294.7M full-page images, 1,164 timed against 41 requested checkpoints (so checkpoints come every 5 minutes, on `checkpoint_timeout`), and roughly 75% of WAL bytes are full-page images. The top writer is the hand commit RPC (`fn_ca_commit_hand_submission`: 4.07M calls, 276 GB, ~10 full-page images per hand), then hand side effects (107 GB), post-commit obligations (80 GB), commission batches (59 GB) and hand retention (57 GB).

Index maintenance that nothing reads is part of that bill:

- **agent_commissions** (3.45M inserts): three indexes were strict prefixes of another index with the same predicate - `idx_agent_commissions_club_id` (of `idx_agent_commissions_club_created`), `idx_agent_commissions_user` (of `agent_commissions_user_recent_idx`) and `agent_commissions_unsettled_idx` (of `agent_commissions_open_idx`, same `settled_at IS NULL` predicate, every key and included column).
- **ca_horse_fleet_state** (9.2M updates, 30% HOT): three indexes with zero scans; `stuck_idx` on `last_action_at` made every seat touch a non-HOT update.
- **horse_mind_pairs.updated_at** and **ca_hand_facts all-in partial**: zero scans against 2.3M upserts and 11.6M inserts.
- **club_member_daily_stats** (11.3M updates, 0 HOT): two covering indexes carried `hands_played` / `biggest_pot_won` in their INCLUDE lists, and those columns change on every hand, so no per-hand update could be HOT.

## What changed

- The ten indexes are dropped (`DROP INDEX CONCURRENTLY`, each the whole command of its own one-shot pg_cron job, 03:28-03:31 UTC; none took longer than 7.6 s and none queued a table lock).
- The two club_member_daily_stats covering indexes are replaced by the same keys without the per-hand columns (`idx_cmds_club_date_hot`, `idx_cmds_user_stat_date_hot`); within minutes the per-hand upserts started being HOT.
- `idx_chip_ledger_treasury_out`, which twice failed to build on 2026-10-02 under the postgres role's 2-minute limit, is built: a one-shot pg_cron job ran the single `CREATE INDEX CONCURRENTLY` while `ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '15min'` was in force for 22 seconds around its start, then reset. It took 120.3 s.

No unique, primary-key or constraint index is touched; no function body, grant or schedule changes.

## What only the owner can change

Full-page images dominate, and they are reset by every checkpoint. `checkpoint_timeout` is the Postgres default 300 s and `max_wal_size` is 4 GB; raising them (Supabase Management API / CLI postgres config) is the largest single lever left and is not reachable from SQL.
