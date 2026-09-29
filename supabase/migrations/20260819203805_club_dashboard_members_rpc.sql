-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819203805 "club_dashboard_members_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3255944252891c5cfa2f925aa9b40d27 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The Players tab headed "Club Members (327)" but listed only the players who
-- had hands in the selected range — a member who never played was invisible,
-- and there was no way to search the roster. This RPC returns the real roster
-- (paged + searchable), joined to each member's profit/hands for the range so
-- the tab can show both roster and performance in one list.
CREATE OR REPLACE FUNCTION public.ca_club_members(
  p_club_id uuid,
  p_search  text        DEFAULT NULL,
  p_since   timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50,
  p_offset  integer     DEFAULT 0
)
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  is_horse     boolean,
  role         text,
  status       text,
  joined_at    timestamptz,
  last_active  timestamptz,
  chip_balance numeric,
  hands_played bigint,
  profit       numeric,
  total_count  bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH roster AS (
    SELECT cm.user_id, cm.role, cm.status, cm.created_at AS joined_at,
           cm.last_active, cm.chip_balance::numeric AS chip_balance,
           coalesce(pr.display_name, cm.display_name, 'Player') AS display_name,
           pr.avatar_url,
           coalesce(pr.is_horse, false) AS is_horse
    FROM club_members cm
    LEFT JOIN profiles pr ON pr.id = cm.user_id
    WHERE cm.club_id = p_club_id
      AND coalesce(cm.status, 'active') NOT IN ('banned')
      AND (v_search IS NULL
           OR coalesce(pr.display_name, cm.display_name, '') ILIKE '%' || v_search || '%')
  ),
  perf AS (
    SELECT s.user_id,
           sum(s.hands_played)::bigint AS hands_played,
           sum(s.profit)               AS profit
    FROM club_member_daily_stats s
    WHERE s.club_id = p_club_id
      AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
    GROUP BY s.user_id
  ),
  counted AS (SELECT count(*) AS n FROM roster)
  SELECT
    r.user_id, r.display_name, r.avatar_url, r.is_horse, r.role, r.status,
    r.joined_at, r.last_active, r.chip_balance,
    coalesce(p.hands_played, 0)::bigint,
    coalesce(p.profit, 0),
    c.n
  FROM roster r
  LEFT JOIN perf p ON p.user_id = r.user_id
  CROSS JOIN counted c
  ORDER BY coalesce(p.hands_played, 0) DESC, r.joined_at DESC NULLS LAST
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer) TO authenticated, service_role;
