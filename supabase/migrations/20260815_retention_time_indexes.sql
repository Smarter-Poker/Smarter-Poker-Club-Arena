-- 20260815_retention_time_indexes.sql
--
-- Adds the missing created_at indexes on the two largest append-only tables.
-- APPLIED LIVE 2026-08-15 22:46–22:52 UTC. Recorded here so the schema is
-- reproducible; both statements are IF NOT EXISTS and safe to re-run.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- data_audit_log (970 MB) had a primary key and nothing else. hand_state_snapshots
-- (4.8 GB) had (table_id, updated_at) but no index on created_at at all. Any
-- retention or cleanup job on either — the obvious next thing anyone would
-- write — would have been a full sequential scan of the whole table. On a
-- cluster with statement_timeout = 120s that job does not merely run slowly, it
-- fails, and it holds I/O the poker engine needs while it does. That is exactly
-- how sp_refresh_pending_families managed to produce a six-minute window with
-- zero hands dealt.
--
-- Measured after (EXPLAIN ANALYZE, 1000-row retention probe):
--   data_audit_log        Index Scan, 222 buffers
--   hand_state_snapshots  Index Scan, 890 buffers
-- against roughly 75k and 294k buffers for the sequential scans they replace.
--
-- ── How these must be applied ────────────────────────────────────────────────
-- CONCURRENTLY, and NOT through a pooled client. Two constraints, both learned
-- the hard way today:
--
--   1. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, which
--      rules out anything that wraps statements (including the Supabase MCP
--      apply_migration path).
--   2. The client transport times out long before the build finishes. A 60s
--      client timeout aborted the data_audit_log build mid-flight and left an
--      INVALID index behind, which then blocks the name until it is dropped.
--      The snapshots build took 192s and the audit build 82s — both would also
--      have been killed by the cluster's 120s/2min statement_timeout.
--
-- What worked: schedule each statement as a one-shot pg_cron job (pg_cron runs
-- commands with no transaction wrapper and no client attached), with
-- statement_timeout lifted for the duration:
--
--   ALTER ROLE postgres SET statement_timeout = 0;
--   SELECT cron.schedule('oneshot-build-x', '<one future minute>', '<one statement>');
--   -- wait for cron.job_run_details.status = 'succeeded' ...
--   SELECT cron.unschedule('oneshot-build-x');   -- ONLY after it completes;
--                                                -- unscheduling a running job
--                                                -- kills it mid-build
--   ALTER ROLE postgres RESET statement_timeout;
--
-- Verified during the build: the engine kept dealing throughout (481 -> 1054
-- hands, zero stalled tables), so CONCURRENTLY is safe to run against live
-- traffic on tables of this size. It is NOT safe on solved_spots_gold — see the
-- note at the bottom.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_data_audit_log_created_at
  ON public.data_audit_log (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_state_snapshots_created_at
  ON public.hand_state_snapshots (created_at DESC);

-- ── STILL OPEN: solved_spots_gold ────────────────────────────────────────────
-- idx_ssg_pending_family is still not built. That table is 62 GB total against
-- a 3.5 GB heap — nearly all of it TOAST — and the instance restarts (OOM) when
-- asked to index it under load. The GTO refresh no longer needs it (incremental
-- triggers replaced the scan, taking DB latency from 25s to 0.14s), so this is
-- no longer urgent, but it will need either a maintenance window on a resized
-- instance or a partitioning strategy. Do not attempt it with the recipe above;
-- the failure mode there is a cluster restart, not a timeout.
