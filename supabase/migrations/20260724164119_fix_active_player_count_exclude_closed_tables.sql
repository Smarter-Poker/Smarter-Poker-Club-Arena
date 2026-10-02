-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260724164119 as "fix_active_player_count_exclude_closed_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Active-player count must only include players seated at LIVE tables. The prior
-- definition counted any table_seats row with left_at IS NULL regardless of the
-- table's status, so seats orphaned on closed/finished tables (a real backlog:
-- 129 such seats existed) inflated every club's "active" number. Excluding
-- non-live table statuses makes the count accurate and self-correcting even if a
-- seat is ever left dangling again.
CREATE OR REPLACE FUNCTION public.fn_get_active_player_count(p_club_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COUNT(DISTINCT ts.user_id)
  FROM table_seats ts
  INNER JOIN tables t ON ts.table_id = t.id
  WHERE t.club_id = p_club_id
    AND ts.left_at IS NULL
    AND COALESCE(ts.is_away, false) = false
    AND lower(COALESCE(t.status,'')) NOT IN ('closed','completed','cancelled','finished');
$function$;
