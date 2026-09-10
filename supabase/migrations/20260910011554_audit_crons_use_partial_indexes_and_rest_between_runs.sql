-- 20260910011554_audit_crons_use_partial_indexes_and_rest_between_runs.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Supabase paged "more than 80% of the available CPU" on PokerIQ-Production
-- at 20:00 CT on 2026-09-09. Measured over the preceding 17 hours
-- (pg_stat_statements, reset 2026-09-09 07:55 UTC): ~57 hours of query
-- execution on a 4-core XL instance, i.e. ~3.3 cores busy on average, at
-- ~10k hands/hour - a THIRD of Monday's 25-35k hands/hour.
--
-- The per-hand pipeline is ~27% of that and is not touched here (it is a
-- trigger-architecture problem, see docs). This migration takes back the
-- part that was pure waste: audit and housekeeping crons re-reading whole
-- tables to find nothing.
--
-- 1. sp_prune_ca_settlements (cron sp_prune_ca_settlements_10m, 5x/hour):
--    `WHERE state='final' AND updated_at < cutoff ORDER BY updated_at LIMIT
--    5000` had no usable index, so every run was a parallel seq scan of the
--    whole 3.9 GB / 4.7M-row ca_settlements table - 366k pages READ FROM
--    DISK per run (shared_buffers is 4 GB, so it also evicted everything
--    else) - to delete ZERO rows (nothing is older than 30 days yet).
--    Measured: 24.5 s -> 0.04 ms with the partial index below.
--
-- 2. fn_ca_drain_orphaned_post_commit_envelopes (cron
--    ca-post-commit-orphan-drain-10m): `post_commit_payload IS NOT NULL AND
--    post_commit_completed_at IS NULL` had no index, so every run seq-scanned
--    1.45 GB / 557k rows of hand_atomic_commits - twice, because the
--    predecessor NOT EXISTS is correlated on the same predicate - to find ~14
--    rows. Measured: 11.4 s -> 0.18 s with the partial index below (which is
--    32 kB, because it only holds the pending rows).
--
-- 3. Three checks that are heavy BY NATURE (they reconstruct hands from
--    jsonb) re-judged the same rows far more often than their window needs:
--      ca-cash-pot-conservation-hourly  128 s avg, hourly, over a 24 h window
--                                       -> every 6 h (each hand judged 4x, not 24x)
--      ca-settlement-correctness-30m     51 s avg, every 30 min, windows of
--                                       60 min / 24 h / 7 d -> hourly
--      ca-quick-reconcile-5m             13 s avg, every 5 min -> every 10 min
--                                       (stuck-settlement detection now lags
--                                       up to 10 min instead of 5; it files an
--                                       incident for a human either way)
--    Job NAMES are unchanged on purpose: ca_guard_inventory matches crons by
--    jobname and fn_ca_cron_failure_watch keys on it too. The suffix is now
--    history, not a promise.
--
-- Everything else from the same measurement (for whoever picks it up next):
--   - ~27%  fn_ca_commit_hand_settlement 159 ms/hand + post-commit 74 ms +
--           fn_project_hand_side_effects 33 ms x2: 35 triggers on table_seats,
--           30 on tables, 15 on chip_ledger, 11 on wallet_transactions, and
--           fn_refuse_while_frozen does to_jsonb(NEW)/to_jsonb(OLD) per row.
--   - ~8%   fn_cash_clusters_tick_all ~900 ms every ~6 s (+122k per-game ticks)
--   - ~7%   Realtime WAL decoding: the engine's service_role subscription on
--           hand_projection_outbox (494k writes / 17 h)
--   - ~5%   fn_aggregate_gto_v31_next batches; ~5% fn_seat_horse_in_seat_first_game
--           at 1.1 s a call; ~2.5% PostgREST pre-request at ~150 req/s;
--           ~2% the tournaments lobby query at 775 ms x 5k calls.
--
-- PRODUCTION NOTE: both indexes were built on production on 2026-09-10 with
-- CREATE INDEX CONCURRENTLY (no write lock on two hot tables; ca_settlements
-- takes a row per hand). CONCURRENTLY cannot run inside a transaction, so this
-- file uses the plain form under IF NOT EXISTS: a no-op on production, a normal
-- build anywhere else (branches, local). The cron.alter_job calls are not DDL
-- and do not fire the PostgREST schema reload.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ca_settlements_final_updated_at
  ON public.ca_settlements (updated_at)
  WHERE state = 'final';

CREATE INDEX IF NOT EXISTS idx_hand_atomic_commits_post_commit_pending
  ON public.hand_atomic_commits (table_id, hand_number)
  WHERE post_commit_payload IS NOT NULL AND post_commit_completed_at IS NULL;

-- Cadence. alter_job by name so this is safe on a database whose job ids differ.
DO $cron$
DECLARE
  v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-cash-pot-conservation-hourly';
  IF v_id IS NOT NULL THEN PERFORM cron.alter_job(job_id := v_id, schedule := '34 */6 * * *'); END IF;

  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-settlement-correctness-30m';
  IF v_id IS NOT NULL THEN PERFORM cron.alter_job(job_id := v_id, schedule := '15 * * * *'); END IF;

  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-quick-reconcile-5m';
  IF v_id IS NOT NULL THEN PERFORM cron.alter_job(job_id := v_id, schedule := '*/10 * * * *'); END IF;
END
$cron$;

COMMIT;
