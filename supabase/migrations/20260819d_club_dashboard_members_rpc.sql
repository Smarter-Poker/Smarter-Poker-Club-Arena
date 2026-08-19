-- ============================================================================
-- 20260819d_club_dashboard_members_rpc.sql
-- Club Dashboard — real member roster for the Players tab (Tier 2, additive)
--
-- WHY: the Players tab was headed "Club Members (327)" but rendered the
-- leaderboard array, so it only ever listed members who had played hands in
-- the selected range — 327 members, at most 50 rows, no way to find anyone.
-- A member who never sat down was invisible in the members view.
--
-- This returns the actual roster: paged, searchable by display name, with
-- role/status/joined/last-active, and LEFT JOINed to each member's hands and
-- profit for the selected range so one list serves both purposes. Banned
-- members are excluded. total_count rides along on every row so the client
-- can page without a second count query.
--
-- SECURITY: SECURITY DEFINER, gated by ca_can_view_club() exactly like the
-- other dashboard RPCs. anon has no EXECUTE.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_club_members(uuid, text, timestamptz, integer, integer);
-- ============================================================================

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
