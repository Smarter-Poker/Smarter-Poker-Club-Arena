-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210514 "club_dashboard_top_players_expose_attribution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3924e34458886c81591af754d45e063f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- club_member_daily_stats.hands_attributed records how many of a player's
-- hands the profit figure could actually be proven on (the rest span a re-buy
-- or a table re-join and are deliberately not attributed). It was being stored
-- but never returned, so the UI could only quote hands_played next to a profit
-- derived from a smaller set — the exact kind of quietly-misleading number
-- this whole rebuild exists to remove. Expose it.
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
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated, service_role;
