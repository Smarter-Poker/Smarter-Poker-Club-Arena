-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210006 "club_dashboard_rebuild_resilient_driver_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e35fe3ab63ea001af3ae3ecbc3743011 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Robustness: one oversized table (tens of thousands of hands) can exceed the
-- statement timeout, and because the driver called the per-table rebuild in a
-- bare PERFORM, that single failure aborted the entire batch and every table
-- after it. A backfill that cannot make partial progress is not a backfill.
--
-- Each table is now attempted in its own exception block. A failure is
-- recorded in club_stats_rebuild_log with rows_written = -1 so the driver
-- skips it on later runs (visible for follow-up rather than silently retried
-- forever), and the batch continues with the next table.
--
-- Return type widens to (tables_done, tables_failed), so the old signature is
-- dropped first.
DROP FUNCTION IF EXISTS public.ca_rebuild_club_member_stats(uuid, integer, timestamptz);

CREATE FUNCTION public.ca_rebuild_club_member_stats(
  p_club_id uuid,
  p_limit   integer DEFAULT 25,
  p_since   timestamptz DEFAULT now() - interval '90 days'
)
RETURNS TABLE (tables_done integer, tables_failed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_done   integer := 0;
  v_failed integer := 0;
BEGIN
  FOR r IN
    SELECT t.id
    FROM tables t
    JOIN LATERAL (
      SELECT max(hh.created_at) AS last_hand
      FROM hand_history hh
      WHERE hh.table_id = t.id AND hh.created_at >= p_since
    ) lh ON lh.last_hand IS NOT NULL
    WHERE t.club_id = p_club_id
      AND NOT EXISTS (
        SELECT 1 FROM club_stats_rebuild_log l
        WHERE l.table_id = t.id AND l.rebuilt_at >= p_since
      )
    ORDER BY lh.last_hand DESC
    LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    BEGIN
      PERFORM ca_rebuild_club_member_stats_table(r.id);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Most commonly 57014 (statement timeout) on a very large table.
      INSERT INTO club_stats_rebuild_log (table_id, rebuilt_at, rows_written)
      VALUES (r.id, now(), -1)
      ON CONFLICT (table_id) DO UPDATE SET rebuilt_at = now(), rows_written = -1;
      v_failed := v_failed + 1;
      RAISE WARNING 'rebuild failed for table %: %', r.id, SQLERRM;
    END;
  END LOOP;

  tables_done := v_done;
  tables_failed := v_failed;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;
