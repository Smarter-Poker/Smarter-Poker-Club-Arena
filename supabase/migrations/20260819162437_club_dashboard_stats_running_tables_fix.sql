-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162437 "club_dashboard_stats_running_tables_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1bc6dfb49af6da672174c850da00e01d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: a table can be status='running' while is_deleted=true (engine keeps
-- dealing). Running/waiting tables must count as active regardless of the
-- is_deleted flag, matching what players actually see in the lobby.
CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'total_members', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    ),
    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND cm.last_active > now() - interval '15 minutes'
      ) x
    ),
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    'hands_today', coalesce((
      SELECT ds.hands_played FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), (
      SELECT count(*) FROM hand_history hh
      JOIN tables t ON t.id = hh.table_id
      WHERE t.club_id = p_club_id
        AND hh.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    )),
    'rake_today', coalesce((
      SELECT ds.rake_collected FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), (
      SELECT coalesce(sum(hh.rake_amount), 0) FROM hand_history hh
      JOIN tables t ON t.id = hh.table_id
      WHERE t.club_id = p_club_id
        AND hh.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    )),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND cm.created_at > now() - interval '7 days'
    )
  );
$fn$;
