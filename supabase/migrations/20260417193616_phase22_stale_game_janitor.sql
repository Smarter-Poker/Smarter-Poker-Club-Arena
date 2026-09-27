-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417193616 "phase22_stale_game_janitor"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4c92bf00f9f93ad7c0613497c018607c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — Stale game janitor
--  -----------------------------------------------------------------------
--  Fresh audit check C10 had 2 rows today that needed manual cleanup
--  ("Game Night 3" on 2026-02-16, ~60d stale, still status='scheduled').
--  As home groups schedule more tournaments, this will happen on its own
--  whenever a scheduled game passes without the host manually closing it.
--
--  Ships a janitor function that flips every past-dated status='scheduled'
--  row to status='completed'. Intended to be called on a schedule (Vercel
--  Cron or Supabase pg_cron). Returns the number of rows updated so the
--  caller can log it.
--
--  Rationale:
--    - 'scheduled' is for future games; once the date passes without
--      explicit transition, 'completed' is the correct state per the
--      status CHECK constraint ('draft','scheduled','confirmed',
--      'in_progress','completed','cancelled').
--    - We use a 1-day grace window so games that started late or
--      ran long (set 'in_progress' after start) aren't touched if
--      they're still 'scheduled' on the same day.
--    - 'in_progress' rows aren't touched — those need explicit
--      close by the host or a longer-window sweeper.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.fn_cleanup_stale_scheduled_home_games(
    p_grace_days int DEFAULT 1
)
RETURNS TABLE (rows_updated int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    v_updated int;
BEGIN
    IF p_grace_days < 0 THEN
        RAISE EXCEPTION 'p_grace_days must be non-negative' USING ERRCODE = '22023';
    END IF;

    UPDATE commander_home_games
       SET status     = 'completed',
           updated_at = NOW()
     WHERE status = 'scheduled'
       AND scheduled_date < CURRENT_DATE - (p_grace_days || ' days')::interval;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN QUERY SELECT v_updated;
END;
$func$;

COMMENT ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int) IS
  'Phase 22 janitor. Flips past-dated status=scheduled home games to status=completed. Call from cron; default 1-day grace window. Returns count of rows updated.';

-- Intentionally NOT granting to anon/authenticated — cron-only.
GRANT EXECUTE ON FUNCTION public.fn_cleanup_stale_scheduled_home_games(int)
    TO service_role;

NOTIFY pgrst, 'reload schema';
