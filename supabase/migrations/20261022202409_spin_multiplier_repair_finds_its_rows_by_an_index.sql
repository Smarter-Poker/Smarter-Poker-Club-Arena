-- 20261022202409_spin_multiplier_repair_finds_its_rows_by_an_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_spin_sweep_unbooked still reached its 8 s statement timeout after
-- 20261022193319 (20:22 UTC), because the first thing it does is call
-- fn_spin_repair_missing_multiplier with the same 14-day lookback, and that
-- scan filters COALESCE(spin_multiplier, 0) <= 0 over every RUNNING/COMPLETED
-- Spin: 479,711 rows read and discarded to find none (1.15 s warm, far more
-- cold). A partial index holding exactly the rows that predicate admits is
-- empty in normal operation and serves the scan directly: 0.08 ms. Built
-- CONCURRENTLY on 2026-10-22 20:23 UTC and recorded here with IF NOT EXISTS.
-- No function or row changes.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tournaments_spin_missing_multiplier
    ON public.tournaments ((COALESCE(started_at, created_at)))
 WHERE variant = 'spin' AND status IN ('RUNNING', 'COMPLETED') AND COALESCE(spin_multiplier, 0) <= 0;

COMMIT;
