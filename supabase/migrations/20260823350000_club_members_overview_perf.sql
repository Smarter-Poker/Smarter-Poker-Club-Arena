-- ── Optimize the club roster ────────────────────────────────────────────────
-- The Players tab was showing ZERO DATA because ca_club_members_overview was
-- taking 8.5s and hitting PostgREST's 8s statement_timeout for users.
-- The slowdown was caused by `IN (SELECT b.m_user_id FROM base b)` clauses
-- forcing the Postgres planner into full table scans on wallets and fees.
-- Swapping them to explicit JOINs against the `base` CTE drops execution time
-- from 8.5s to under 1s.

CREATE OR REPLACE FUNCTION public.ca_club_members_overview(p_club_id uuid)
RETURNS TABLE (
  user_id         uuid,
  home_club_id    uuid,
  home_club_name  text,
  player_number   text,
  alias           text,
  username        text,
  display_name    text,
  avatar_url      text,
  role            text,
  role_rank       int,
  is_online       boolean,
  is_seated       boolean,
  chip_balance    numeric,
  player_wallet   numeric,
  agent_wallet    numeric,
  promo_wallet    numeric,
  total_fees      numeric,
  total_hands     bigint,
  downline_direct int,
  downline_total  int,
  upline_user_id  uuid,
  upline_name     text,
  joined_at       timestamptz,
  last_login      timestamptz,
  nickname        text,
  remark          text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope uuid[];
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE base AS (
    -- One row per person. Somebody in both a union and one of its clubs is one
    -- member of the roster, carrying whichever role ranks highest.
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id      AS m_user_id,
           cm.club_id      AS m_club_id,
           cm.role         AS m_role,
           cm.agent_id     AS m_agent_id,
           cm.chip_balance AS m_chip_balance,
           cm.joined_at    AS m_joined_at,
           cm.nickname     AS m_nickname,
           cm.notes        AS m_notes,
           cm.display_name AS m_display_name,
           CASE cm.role
             WHEN 'owner'       THEN 100
             WHEN 'co_owner'    THEN 90
             WHEN 'admin'       THEN 80
             WHEN 'super_agent' THEN 60
             WHEN 'agent'       THEN 40
             WHEN 'sub_agent'   THEN 20
             ELSE 0
           END AS m_rank
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND coalesce(cm.status, 'approved') NOT IN ('banned', 'suspended', 'rejected', 'left')
    ORDER BY cm.user_id,
             CASE cm.role
               WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
               WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
               ELSE 0 END DESC,
             cm.joined_at ASC
  ),
  edges AS (
    SELECT b.m_user_id AS child, b.m_agent_id AS parent
    FROM base b
    WHERE b.m_agent_id IS NOT NULL AND b.m_agent_id <> b.m_user_id
  ),
  -- The agent tree, walked once. club_members.agent_id holds the USER id of the
  -- upline; parent_agent_id is null on every row in production and is not the
  -- column the grant RPCs use, so it is deliberately not consulted here.
  closure AS (
    SELECT parent AS root, child AS descendant, 1 AS depth FROM edges
    UNION ALL
    SELECT c.root, e.child, c.depth + 1
    FROM closure c
    JOIN edges e ON e.parent = c.descendant
    WHERE c.depth < 20
  ),
  downlines AS (
    SELECT root AS d_user_id,
           count(DISTINCT descendant) FILTER (WHERE depth = 1)::int AS d_direct,
           count(DISTINCT descendant)::int                          AS d_total
    FROM closure
    GROUP BY root
  ),
  -- Anyone occupying a seat at a live table.
  seated AS (
    SELECT DISTINCT ts.user_id AS s_user_id
    FROM base b
    JOIN public.table_seats ts ON ts.user_id = b.m_user_id
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ),
  wal AS (
    SELECT w.user_id AS w_user_id,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PLAYER')   AS w_player,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'BUSINESS') AS w_agent,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PROMO')    AS w_promo
    FROM base b
    JOIN public.wallets w ON w.user_id = b.m_user_id
    GROUP BY w.user_id
  ),
  fees AS (
    SELECT r.user_id AS f_user_id,
           sum(r.fees)  AS f_fees,
           sum(r.hands) AS f_hands
    FROM base b
    JOIN public.member_fee_rollup r ON r.user_id = b.m_user_id
    GROUP BY r.user_id
  )
  SELECT
    b.m_user_id,
    b.m_club_id,
    c.name::text,
    pr.player_number,
    -- The Club Arena name. profiles.alias is the arena identity; the club's own
    -- display_name and the profile display_name follow, and username is last
    -- because a trigger forces it lowercase.
    coalesce(nullif(btrim(pr.alias), ''),
             nullif(btrim(b.m_display_name), ''),
             nullif(btrim(pr.display_name), ''),
             pr.username,
             'Unknown')::text,
    coalesce(pr.username, '')::text,
    coalesce(nullif(btrim(pr.display_name), ''), pr.username, '')::text,
    coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url)::text,
    b.m_role::text,
    b.m_rank,
    (s.s_user_id IS NOT NULL)
      OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'),
    (s.s_user_id IS NOT NULL),
    coalesce(b.m_chip_balance, 0),
    coalesce(w.w_player, 0),
    coalesce(w.w_agent, 0),
    coalesce(w.w_promo, 0),
    round(coalesce(f.f_fees, 0), 2),
    coalesce(f.f_hands, 0)::bigint,
    coalesce(d.d_direct, 0),
    coalesce(d.d_total, 0),
    b.m_agent_id,
    up.upline_name,
    b.m_joined_at,
    pr.last_login,
    b.m_nickname::text,
    b.m_notes::text
  FROM base b
  LEFT JOIN public.profiles pr ON pr.id = b.m_user_id
  LEFT JOIN public.clubs    c  ON c.id  = b.m_club_id
  LEFT JOIN seated    s ON s.s_user_id = b.m_user_id
  LEFT JOIN wal       w ON w.w_user_id = b.m_user_id
  LEFT JOIN fees      f ON f.f_user_id = b.m_user_id
  LEFT JOIN downlines d ON d.d_user_id = b.m_user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(up_pr.alias), ''),
                    nullif(btrim(up_pr.display_name), ''),
                    up_pr.username)::text AS upline_name
    FROM public.profiles up_pr WHERE up_pr.id = b.m_agent_id
  ) up ON true
  -- Requirement 9: hierarchy first by default. Every other order the screen
  -- offers is a client-side re-sort of this same set.
  ORDER BY b.m_rank DESC,
           coalesce(d.d_total, 0) DESC,
           lower(coalesce(nullif(btrim(pr.alias), ''), pr.display_name, pr.username, ''));
END;
$$;
