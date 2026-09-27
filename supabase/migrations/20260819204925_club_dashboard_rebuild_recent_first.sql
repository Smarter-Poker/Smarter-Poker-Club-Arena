-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819204925 "club_dashboard_rebuild_recent_first"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4942f969f311140dc4afe66f99a841b7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The rebuild driver picked tables in arbitrary order. The two largest clubs
-- have ~4.5k and ~2.8k tables, so a bounded backfill has to spend its budget
-- where the dashboard actually reads: the default Time Range is "week", so
-- rebuild the most recently active tables first.
CREATE OR REPLACE FUNCTION public.ca_rebuild_club_member_stats(
  p_club_id uuid,
  p_limit   integer DEFAULT 25,
  p_since   timestamptz DEFAULT now() - interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_done integer := 0;
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
    PERFORM ca_rebuild_club_member_stats_table(r.id);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;
