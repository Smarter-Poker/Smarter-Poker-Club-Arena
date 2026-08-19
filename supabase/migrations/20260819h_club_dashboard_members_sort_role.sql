-- ============================================================================
-- 20260819h_club_dashboard_members_sort_role.sql
-- Club Dashboard — server-side member sorting, role filter, live presence
--
-- Applied to production as: club_dashboard_members_sort_and_role
--
-- WHY SERVER-SIDE: the roster is paged (25 at a time out of 327+). Sorting the
-- rows the client happens to be holding would reorder ONE PAGE and present it
-- as the ranking of the whole roster — the same class of quietly-wrong number
-- this rebuild has been removing throughout. Ordering therefore belongs in
-- SQL, ahead of LIMIT/OFFSET.
--
-- p_sort is matched against a fixed whitelist inside a CASE expression and is
-- never interpolated into SQL text, so there is no injection surface. An
-- unrecognised value falls through to the stable tiebreak (joined_at, user_id)
-- rather than erroring.
--
-- Also adds:
--   * p_role  — filter to owner/admin/agent/player/member.
--   * is_online — seated at a live club table right now, or active in the last
--     15 minutes. Same definition as the Online Now metric card, so the two
--     surfaces cannot disagree.
--
-- The stable trailing sort (joined_at DESC, user_id) matters for paging: without
-- a total order, rows with equal sort keys can repeat or vanish across pages.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text);
--   then re-apply 20260819d_club_dashboard_members_rpc.sql for the 5-arg form.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ca_club_members(
  p_club_id uuid,
  p_search  text        DEFAULT NULL,
  p_since   timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50,
  p_offset  integer     DEFAULT 0,
  p_sort    text        DEFAULT 'hands',
  p_role    text        DEFAULT NULL
)
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  is_horse     boolean,
  is_online    boolean,
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
  v_role   text := nullif(btrim(coalesce(p_role, '')), '');
  v_sort   text := lower(coalesce(p_sort, 'hands'));
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH seated AS (
    SELECT DISTINCT ts.user_id
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
  ),
  roster AS (
    SELECT cm.user_id, cm.role, cm.status, cm.created_at AS joined_at,
           cm.last_active, cm.chip_balance::numeric AS chip_balance,
           coalesce(pr.display_name, cm.display_name, 'Player') AS display_name,
           pr.avatar_url,
           coalesce(pr.is_horse, false) AS is_horse,
           (s.user_id IS NOT NULL
            OR cm.last_active > now() - interval '15 minutes') AS is_online
    FROM club_members cm
    LEFT JOIN profiles pr ON pr.id = cm.user_id
    LEFT JOIN seated s ON s.user_id = cm.user_id
    WHERE cm.club_id = p_club_id
      AND coalesce(cm.status, 'active') NOT IN ('banned')
      AND (v_search IS NULL
           OR coalesce(pr.display_name, cm.display_name, '') ILIKE '%' || v_search || '%')
      AND (v_role IS NULL OR coalesce(cm.role, 'member') = v_role)
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
    r.user_id, r.display_name, r.avatar_url, r.is_horse, r.is_online,
    r.role, r.status, r.joined_at, r.last_active, r.chip_balance,
    coalesce(p.hands_played, 0)::bigint,
    coalesce(p.profit, 0),
    c.n
  FROM roster r
  LEFT JOIN perf p ON p.user_id = r.user_id
  CROSS JOIN counted c
  ORDER BY
    CASE WHEN v_sort = 'profit' THEN coalesce(p.profit, 0) END DESC NULLS LAST,
    CASE WHEN v_sort = 'hands'  THEN coalesce(p.hands_played, 0) END DESC NULLS LAST,
    CASE WHEN v_sort = 'joined' THEN r.joined_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'last_active' THEN r.last_active END DESC NULLS LAST,
    CASE WHEN v_sort = 'name'   THEN lower(r.display_name) END ASC NULLS LAST,
    -- Stable tiebreak: without a total order, equal sort keys make rows repeat
    -- or disappear between pages.
    r.joined_at DESC NULLS LAST,
    r.user_id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) TO authenticated, service_role;

-- Retire the 5-arg signature so only one definition is callable.
DROP FUNCTION IF EXISTS public.ca_club_members(uuid, text, timestamptz, integer, integer);
