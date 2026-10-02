-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221214 "phase50c_restore_home_games_one_active_per_group_per_date"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 280488c454409b19ef6a08c5d5c368f2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 50c — Restore the double-booking guard on commander_home_games
--
-- WHY: unique index `uq_commander_home_games_one_active_per_group_per_date`
-- was applied by migration
--   20260423230236_20260421070000_bug14_home_games_unique_group_date
-- which IS recorded in supabase_migrations.schema_migrations, but the index
-- is ABSENT from pg_indexes in production. It was dropped out-of-band.
--
-- IMPACT: the TOCTOU race that migration closed is fully live again. Every
-- path that creates an event for a group/date - clone, template apply,
-- recurring generator, and the unguarded POST /events - can double-book a
-- group on the same calendar date. The database is the only place this can
-- be enforced atomically; application-level checks lose the race.
--
-- SAFETY: verified 2026-08-12 that ZERO violating rows exist
-- (0 groups have >1 non-cancelled game on the same scheduled_date), so the
-- index builds without data cleanup. The pre-flight re-checks this at apply
-- time rather than trusting the earlier observation.
--
-- NOTE ON CONCURRENTLY: apply_migration runs inside a transaction block and
-- CREATE INDEX CONCURRENTLY is not permitted there. A plain CREATE UNIQUE
-- INDEX takes a brief ACCESS EXCLUSIVE lock; acceptable at this table's size
-- (asserted below). If the table ever grows large, rebuild concurrently
-- out-of-band instead.
--
-- Tier 3 (constraint addition). ROLLBACK at the bottom.
-- =====================================================================

-- ---------- PRE-FLIGHT ----------
DO $$
DECLARE
    v_dupes int;
    v_rows  bigint;
BEGIN
    SELECT COUNT(*) INTO v_dupes FROM (
        SELECT group_id, scheduled_date
        FROM public.commander_home_games
        WHERE status IS DISTINCT FROM 'cancelled'
        GROUP BY group_id, scheduled_date
        HAVING COUNT(*) > 1
    ) d;

    IF v_dupes > 0 THEN
        RAISE EXCEPTION
          'PRE-FLIGHT FAILED: % (group_id, scheduled_date) pairs already violate the intended uniqueness. De-duplicate before applying.', v_dupes;
    END IF;

    SELECT COUNT(*) INTO v_rows FROM public.commander_home_games;
    IF v_rows > 500000 THEN
        RAISE EXCEPTION
          'PRE-FLIGHT FAILED: commander_home_games has % rows; build this index CONCURRENTLY out-of-band instead of in a migration transaction.', v_rows;
    END IF;

    RAISE NOTICE 'pre-flight OK: 0 duplicates, % rows.', v_rows;
END $$;

-- ---------- APPLY ----------
CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_home_games_one_active_per_group_per_date
    ON public.commander_home_games (group_id, scheduled_date)
    WHERE status IS DISTINCT FROM 'cancelled';

COMMENT ON INDEX public.uq_commander_home_games_one_active_per_group_per_date IS
  'Double-booking guard: at most one non-cancelled game per group per calendar date. Originally added by bug14_home_games_unique_group_date, found DROPPED out-of-band in the 2026-08-12 audit and restored by phase50c. Do NOT drop - application-level checks lose the TOCTOU race. Cancelled games are excluded so a date can be re-used after cancellation.';

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE
    v_isunique boolean;
    v_pred     text;
BEGIN
    SELECT ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid)
      INTO v_isunique, v_pred
    FROM pg_class c
    JOIN pg_index ix ON ix.indexrelid = c.oid
    WHERE c.relname = 'uq_commander_home_games_one_active_per_group_per_date';

    IF v_isunique IS NULL THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: index was not created';
    END IF;
    IF NOT v_isunique THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: index exists but is not UNIQUE';
    END IF;
    IF v_pred IS NULL THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: index is not partial - it would block re-using a date after cancellation';
    END IF;

    RAISE NOTICE 'phase50c OK: unique partial index present (predicate: %).', v_pred;
END $$;

-- =====================================================================
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.uq_commander_home_games_one_active_per_group_per_date;
--
-- NOTE: rolling back re-opens the double-booking race. If a legitimate
-- product need exists for multiple games per group per day, change the
-- index definition (e.g. include start_time) rather than dropping it.
-- =====================================================================
