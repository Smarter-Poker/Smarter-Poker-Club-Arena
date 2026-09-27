-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233901 "club_stats_maintenance_probes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2573c889e0cd47920dbc195f74402e7b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Probes for the scheduled maintenance job, so the handler never has to
-- hardcode a club list (new clubs are picked up automatically) and each run is
-- a cheap no-op once the backlog is gone.

-- Clubs that still have tables with recent hands and no completed rebuild.
CREATE OR REPLACE FUNCTION public.ca_clubs_with_rebuild_backlog(
  p_since timestamptz DEFAULT now() - interval '90 days',
  p_limit integer     DEFAULT 10
)
RETURNS TABLE (club_id uuid, tables_pending bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT t.club_id, count(*)::bigint
  FROM tables t
  LEFT JOIN club_stats_rebuild_log l ON l.table_id = t.id
  WHERE t.club_id IS NOT NULL
    AND coalesce(l.complete, false) = false
    AND EXISTS (
      SELECT 1 FROM hand_history hh
      WHERE hh.table_id = t.id AND hh.created_at >= p_since
    )
  GROUP BY t.club_id
  ORDER BY count(*) DESC
  LIMIT greatest(coalesce(p_limit, 10), 1);
$fn$;

-- Clubs that dealt hands on a given day but have no club_hand_daily row yet.
CREATE OR REPLACE FUNCTION public.ca_clubs_missing_hand_daily(p_date date)
RETURNS TABLE (club_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT DISTINCT t.club_id
  FROM tables t
  WHERE t.club_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM club_hand_daily d
      WHERE d.club_id = t.club_id AND d.stat_date = p_date
    )
    AND EXISTS (
      SELECT 1 FROM hand_history hh
      WHERE hh.table_id = t.id
        AND hh.created_at >= p_date::timestamp AT TIME ZONE 'UTC'
        AND hh.created_at <  (p_date + 1)::timestamp AT TIME ZONE 'UTC'
    );
$fn$;

REVOKE ALL ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_clubs_missing_hand_daily(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_clubs_with_rebuild_backlog(timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_clubs_missing_hand_daily(date) TO service_role;
