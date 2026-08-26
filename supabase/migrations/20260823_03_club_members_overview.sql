-- ============================================================================
-- 20260823_03_club_members_overview
--
-- Dan 2026-08-23, the Players tab brief:
--   "every club and union sees ALL of their players inside of it, it needs to
--    be an overview of everything"
--   "the player number next to their role"
--   "their Club Arena name (alias, not actual name) followed by username"
--   "how many downlines are under the agent, how many chips are in their agent
--    wallet, and player wallet, followed by fees (total rake generated)"
--   "anytime a horse is at a table it must be considered online"
--
-- One RPC answers all of it, because the alternative is what the page did
-- before: one query for club_members, a second in chunks of 30 for profiles,
-- a third for tables, a fourth for seats, and no source at all for downlines,
-- wallets or fees.
--
-- ── WHY "ONLINE NOW" READ 1 ──────────────────────────────────────────────────
-- The page asked `tables` for rows with club_id = <this club> and status in
-- (waiting, running). Club JAQK has 34,138 table rows and every one of them is
-- closed -- the LIVE tables belong to Midway Union, the union the club sits in.
-- The query returned zero tables, the effect bailed out before it ever looked
-- at a seat, and the count fell back to browser presence: one, the person
-- reading the screen. Meanwhile 223 of that club's members were sitting in
-- hands.
--
-- The seat knows what the table does not: table_seats.club_id is the player's
-- HOME club. So membership is resolved from the seat, the table is consulted
-- only for whether it is alive, and a match on either side counts. A horse at a
-- table is online, exactly as asked.
--
-- ── WHY A SCOPE ─────────────────────────────────────────────────────────────
-- A union is a row in `clubs` with is_union = true, and its clubs point back
-- through clubs.union_id (and, historically, union_clubs). Opening the roster
-- on a union must show every player in every club under it, deduplicated -- a
-- member of two clubs in one union is one person, shown at their highest role.
-- ============================================================================

-- ── Scope: which clubs does this roster cover? ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_scope_ids(p_club_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce((SELECT is_union FROM public.clubs WHERE id = p_club_id), false)
      THEN (
        SELECT array_agg(DISTINCT x)
        FROM (
          SELECT p_club_id AS x
          UNION SELECT id      FROM public.clubs       WHERE union_id = p_club_id
          UNION SELECT club_id FROM public.union_clubs WHERE union_id = p_club_id
        ) s
        WHERE x IS NOT NULL
      )
    ELSE ARRAY[p_club_id]
  END;
$$;

COMMENT ON FUNCTION public.fn_club_scope_ids(uuid) IS
  'Clubs a roster covers: a union covers itself plus every club under it; a club covers only itself.';

-- ── Keeping the fee rollup current ──────────────────────────────────────────
-- Deliberately separate from the roster read. The roster is STABLE and must
-- stay that way; advancing a watermark is a write. The page fires this once on
-- load and forgets it -- the advisory lock inside the refresher means a hundred
-- members opening the tab at once still only produces one refresh.
CREATE OR REPLACE FUNCTION public.ca_touch_member_fee_rollup()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_last timestamptz;
BEGIN
  SELECT last_run_at INTO v_last FROM public.member_fee_rollup_state WHERE id;
  -- At most one advance every 30 seconds, however many callers there are.
  IF v_last IS NOT NULL AND v_last > now() - interval '30 seconds' THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'refreshed recently');
  END IF;
  RETURN public.fn_refresh_member_fee_rollup(4000);
END;
$$;

REVOKE ALL ON FUNCTION public.ca_touch_member_fee_rollup() FROM public;
GRANT EXECUTE ON FUNCTION public.ca_touch_member_fee_rollup() TO authenticated, service_role;

-- ── The roster ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.ca_club_members_overview(uuid);
DROP FUNCTION IF EXISTS public.ca_club_members_overview(uuid, boolean);

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
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL
      AND ts.user_id IS NOT NULL
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ),
  wal AS (
    SELECT w.user_id AS w_user_id,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PLAYER')   AS w_player,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'BUSINESS') AS w_agent,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PROMO')    AS w_promo
    FROM public.wallets w
    WHERE w.user_id IN (SELECT b.m_user_id FROM base b)
    GROUP BY w.user_id
  ),
  fees AS (
    SELECT r.user_id AS f_user_id,
           sum(r.fees)  AS f_fees,
           sum(r.hands) AS f_hands
    FROM public.member_fee_rollup r
    WHERE r.user_id IN (SELECT b.m_user_id FROM base b)
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

COMMENT ON FUNCTION public.ca_club_members_overview(uuid) IS
  'Complete Players-tab roster for a club or union: identity, role, player number, wallets, downline counts, fees and live-seat presence, in one round trip.';

REVOKE ALL ON FUNCTION public.ca_club_members_overview(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_club_members_overview(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_scope_ids(uuid) TO authenticated, service_role;
