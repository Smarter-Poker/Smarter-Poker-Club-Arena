-- 20261022191059_spin_sweep_finds_recent_spins_by_an_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_spin_sweep_unbooked hit the 8 s statement timeout about four times an
-- hour, all day, on 2026-10-22 (inside "SQL function fn_poker_diamond_tournament
-- statement 1 ... fn_spin_sweep_unbooked line 14 at FOR over SELECT rows").
-- Its candidate scan, run twice per call, filters
--     COALESCE(t.started_at, t.created_at) > now() - interval
-- deliberately (a Spin whose start write was lost must still be found), but
-- the index that was built for this scan, idx_tournaments_spin_unbooked_scan,
-- is on started_at alone, so it can never serve that predicate. Every call
-- walked all 479,125 RUNNING/COMPLETED Spins and called the per-row Diamond
-- check on each: 1.29 s warm, past 8 s cold under load.
--
-- THE FIX is an index on the expression the scan actually filters by, with
-- the same partial predicate. Measured after a CONCURRENT build on
-- 2026-10-22 19:10 UTC: the plan is an Index Scan on this index and the
-- candidate scan takes 0.20 s. No function changes; no rows touched.
--
-- Built CONCURRENTLY first (no write lock on tournaments); this file records it
-- with IF NOT EXISTS so a replay is a no-op.
--
-- ROLLBACK: DROP INDEX CONCURRENTLY public.idx_tournaments_spin_unbooked_effective_start;

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tournaments_spin_unbooked_effective_start
    ON public.tournaments ((COALESCE(started_at, created_at)))
 WHERE variant = 'spin' AND status IN ('RUNNING', 'COMPLETED');

COMMIT;
