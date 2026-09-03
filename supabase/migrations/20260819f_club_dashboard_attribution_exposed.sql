-- ============================================================================
-- 20260819f_club_dashboard_attribution_exposed.sql
-- Club Dashboard — expose hands_attributed + backfill resilience (Tier 2)
--
-- Applied to production as:
--   club_dashboard_resilient_driver_v2
--   club_dashboard_rebuild_statement_timeout
--   club_dashboard_top_players_expose_attribution
--
-- 1. hands_attributed was STORED but never RETURNED, so the UI could only
--    quote hands_played beside a profit derived from a smaller set — exactly
--    the quietly-misleading number this rebuild exists to remove. It is now
--    returned by ca_club_top_players and rendered as "profit measured on N of
--    M player-hands (X%)".
--
-- 2. The rebuild driver now attempts each table inside its own exception
--    block and records failures as rows_written = -1, so one bad table no
--    longer aborts the whole batch.
--
-- 3. A nested exception block CANNOT rescue a statement timeout — 57014 kills
--    the outer statement, so the handler never runs. The backfill functions
--    therefore carry their own statement_timeout at function scope. These are
--    service_role-only maintenance paths (no EXECUTE for authenticated/anon),
--    so a request-facing role can never hold a connection this long, and the
--    read RPCs the dashboard calls keep the default timeout.
--
-- ROLLBACK:
--   ALTER FUNCTION public.ca_rebuild_club_member_stats_table(uuid) RESET statement_timeout;
--   ALTER FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) RESET statement_timeout;
--   re-apply ca_club_top_players from 20260819b (without hands_attributed).
-- ============================================================================

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

ALTER FUNCTION public.ca_rebuild_club_member_stats_table(uuid)
  SET statement_timeout = '180s';
ALTER FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz)
  SET statement_timeout = '600s';

DROP FUNCTION IF EXISTS public.ca_club_top_players(uuid, timestamptz, integer);

CREATE FUNCTION public.ca_club_top_players(
  p_club_id uuid,
  p_since   timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50
)
RETURNS TABLE (
  user_id          uuid,
  display_name     text,
  avatar_url       text,
  is_horse         boolean,
  hands_played     bigint,
  hands_attributed bigint,
  hands_won        bigint,
  total_won        numeric,
  profit           numeric,
  biggest_pot_won  numeric,
  win_rate         numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    s.user_id,
    coalesce(pr.display_name, 'Player')      AS display_name,
    pr.avatar_url,
    coalesce(pr.is_horse, false)             AS is_horse,
    sum(s.hands_played)::bigint              AS hands_played,
    sum(s.hands_attributed)::bigint          AS hands_attributed,
    sum(s.hands_won)::bigint                 AS hands_won,
    sum(s.total_won)                         AS total_won,
    sum(s.profit)                            AS profit,
    max(s.biggest_pot_won)                   AS biggest_pot_won,
    round(100.0 * sum(s.hands_won) / nullif(sum(s.hands_played), 0), 1) AS win_rate
  FROM club_member_daily_stats s
  LEFT JOIN profiles pr ON pr.id = s.user_id
  WHERE s.club_id = p_club_id
    AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
  GROUP BY s.user_id, pr.display_name, pr.avatar_url, pr.is_horse
  HAVING sum(s.hands_played) > 0
  ORDER BY sum(s.profit) DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_rebuild_club_member_stats(uuid, integer, timestamptz) TO service_role;
