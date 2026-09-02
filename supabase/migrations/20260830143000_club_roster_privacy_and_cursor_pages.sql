-- CLUB ROSTER PRIVACY, LIVE WALLET SOURCES, AND CURSOR PAGINATION
--
-- The original roster RPC returned every wallet, fee total, internal note, and
-- last-login timestamp to every approved club member. It also read the frozen
-- public.wallets table and returned the entire roster in one payload. This
-- migration makes authorization a row-level server contract, moves every
-- balance to the live pools, adds keyset pages and a lightweight summary, and
-- gives note edits and exports an audited server path.

-- ---------------------------------------------------------------------------
-- One access decision shared by Member Management and its subordinate RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_roster_access(
  p_club_id uuid,
  p_target_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
BEGIN
  IF p_club_id IS NULL OR p_target_user_id IS NULL THEN
    RETURN 'none';
  END IF;

  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN 'none';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.club_members target
     WHERE target.user_id = p_target_user_id
       AND target.club_id = ANY(v_scope)
       AND coalesce(target.status, 'approved') IN ('active', 'approved')
  ) THEN
    RETURN 'none';
  END IF;

  IF v_service THEN
    RETURN 'service';
  END IF;
  IF v_actor IS NULL THEN
    RETURN 'none';
  END IF;

  SELECT coalesce(p.is_admin, false)
    INTO v_platform_admin
    FROM public.profiles p
   WHERE p.id = v_actor;
  IF v_platform_admin THEN
    RETURN 'staff';
  END IF;

  v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  IF v_union_staff THEN
    RETURN 'staff';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.club_members actor
     WHERE actor.user_id = v_actor
       AND actor.club_id = ANY(v_scope)
       AND coalesce(actor.status, 'approved') IN ('active', 'approved')
  ) THEN
    RETURN 'none';
  END IF;

  -- Club staff may inspect only members of clubs they actually staff. Staff of
  -- one child club do not inherit financial access to an entire union roster.
  IF EXISTS (
    SELECT 1
      FROM public.club_members actor
      JOIN public.club_members target ON target.club_id = actor.club_id
     WHERE actor.user_id = v_actor
       AND target.user_id = p_target_user_id
       AND actor.club_id = ANY(v_scope)
       AND actor.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(actor.status, 'approved') IN ('active', 'approved')
       AND coalesce(target.status, 'approved') IN ('active', 'approved')
  ) THEN
    RETURN 'staff';
  END IF;

  -- An agent can inspect themselves and anyone recursively beneath them.
  IF EXISTS (
    SELECT 1
      FROM public.club_members actor
     WHERE actor.user_id = v_actor
       AND actor.club_id = ANY(v_scope)
       AND actor.role IN ('super_agent', 'agent', 'sub_agent')
       AND coalesce(actor.status, 'approved') IN ('active', 'approved')
  ) THEN
    IF p_target_user_id = v_actor THEN
      RETURN 'downline';
    END IF;

    IF EXISTS (
      WITH RECURSIVE edges AS (
        SELECT DISTINCT cm.agent_id AS parent, cm.user_id AS child
          FROM public.club_members cm
         WHERE cm.club_id = ANY(v_scope)
           AND cm.agent_id IS NOT NULL
           AND cm.agent_id <> cm.user_id
           AND coalesce(cm.status, 'approved') IN ('active', 'approved')
      ), tree AS (
        SELECT e.child, 1 AS depth
          FROM edges e
         WHERE e.parent = v_actor
        UNION ALL
        SELECT e.child, t.depth + 1
          FROM tree t
          JOIN edges e ON e.parent = t.child
         WHERE t.depth < 20
      )
      SELECT 1 FROM tree WHERE child = p_target_user_id
    ) THEN
      RETURN 'downline';
    END IF;
  END IF;

  RETURN 'identity';
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_roster_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_roster_access(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The canonical role-shaped row set. Client-callable RPCs below delegate here.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_roster_rows(p_club_id uuid)
RETURNS TABLE (
  user_id uuid,
  management_club_id uuid,
  home_club_id uuid,
  home_club_name text,
  player_number text,
  alias text,
  username text,
  display_name text,
  avatar_url text,
  role text,
  role_rank int,
  is_online boolean,
  is_seated boolean,
  chip_balance numeric,
  player_wallet numeric,
  agent_wallet numeric,
  promo_wallet numeric,
  total_fees numeric,
  downline_fees numeric,
  total_hands bigint,
  downline_direct int,
  downline_total int,
  upline_user_id uuid,
  upline_name text,
  joined_at timestamptz,
  last_login timestamptz,
  nickname text,
  remark text,
  can_view_financials boolean,
  can_view_notes boolean,
  in_viewer_downline boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin
      FROM public.profiles p
     WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  IF NOT v_service
     AND NOT v_platform_admin
     AND NOT v_union_staff
     AND (
       v_actor IS NULL OR NOT EXISTS (
         SELECT 1
           FROM public.club_members actor
          WHERE actor.user_id = v_actor
            AND actor.club_id = ANY(v_scope)
            AND coalesce(actor.status, 'approved') IN ('active', 'approved')
       )
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE base AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id AS m_user_id,
           cm.club_id AS m_club_id,
           cm.role AS m_role,
           cm.agent_id AS m_agent_id,
           cm.chip_balance AS m_chip_balance,
           cm.promo_balance AS m_promo_balance,
           cm.joined_at AS m_joined_at,
           cm.last_active_at AS m_last_active_at,
           cm.nickname AS m_nickname,
           cm.notes AS m_notes,
           cm.display_name AS m_display_name,
           public.fn_club_role_rank(cm.role) AS m_rank
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id,
              public.fn_club_role_rank(cm.role) DESC,
              cm.joined_at ASC,
              cm.club_id
  ),
  edges AS MATERIALIZED (
    SELECT DISTINCT cm.agent_id AS parent, cm.user_id AS child
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope)
       AND cm.agent_id IS NOT NULL
       AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  closure AS MATERIALIZED (
    SELECT e.parent AS root, e.child AS descendant, 1 AS depth FROM edges e
    UNION ALL
    SELECT c.root, e.child, c.depth + 1
      FROM closure c
      JOIN edges e ON e.parent = c.descendant
     WHERE c.depth < 20
  ),
  viewer_tree AS MATERIALIZED (
    SELECT DISTINCT c.descendant AS uid
      FROM closure c
     WHERE c.root = v_actor
  ),
  downlines AS MATERIALIZED (
    SELECT c.root AS uid,
           count(DISTINCT c.descendant) FILTER (WHERE c.depth = 1)::int AS direct_count,
           count(DISTINCT c.descendant)::int AS total_count
      FROM closure c
     GROUP BY c.root
  ),
  staff_clubs AS MATERIALIZED (
    SELECT DISTINCT cm.club_id
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = ANY(v_scope)
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  staff_targets AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS uid
      FROM public.club_members cm
     WHERE cm.club_id IN (SELECT sc.club_id FROM staff_clubs sc)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ),
  viewer_agent AS MATERIALIZED (
    SELECT EXISTS (
      SELECT 1
        FROM public.club_members cm
       WHERE cm.user_id = v_actor
         AND cm.club_id = ANY(v_scope)
         AND cm.role IN ('super_agent', 'agent', 'sub_agent')
         AND coalesce(cm.status, 'approved') IN ('active', 'approved')
    ) AS yes
  ),
  access AS MATERIALIZED (
    SELECT b.m_user_id AS uid,
           (
             v_service OR v_platform_admin OR v_union_staff
             OR st.uid IS NOT NULL
             OR vt.uid IS NOT NULL
             OR (b.m_user_id = v_actor AND va.yes)
           ) AS sensitive,
           (vt.uid IS NOT NULL) AS is_downline
      FROM base b
      CROSS JOIN viewer_agent va
      LEFT JOIN staff_targets st ON st.uid = b.m_user_id
      LEFT JOIN viewer_tree vt ON vt.uid = b.m_user_id
  ),
  seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id AS uid
      FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ),
  member_wallets AS MATERIALIZED (
    SELECT cm.user_id AS uid,
           sum(coalesce(cm.chip_balance, 0)) AS player_total,
           sum(coalesce(cm.promo_balance, 0)) AS member_promo_total
      FROM public.club_members cm
      JOIN base b ON b.m_user_id = cm.user_id
     WHERE cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     GROUP BY cm.user_id
  ),
  agent_wallets AS MATERIALIZED (
    SELECT a.user_id AS uid,
           sum(coalesce(a.agent_wallet_balance, 0)) AS agent_total,
           sum(coalesce(a.promo_wallet_balance, 0)) AS agent_promo_total
      FROM public.agents a
      JOIN base b ON b.m_user_id = a.user_id
     WHERE a.club_id = ANY(v_scope)
       AND coalesce(a.status, 'active') = 'active'
     GROUP BY a.user_id
  ),
  fees AS MATERIALIZED (
    SELECT r.user_id AS uid,
           sum(r.fees) AS fee_total,
           sum(r.hands)::bigint AS hand_total
      FROM public.member_fee_rollup r
      JOIN base b ON b.m_user_id = r.user_id
     GROUP BY r.user_id
  ),
  downline_fee_totals AS MATERIALIZED (
    SELECT c.root AS uid, sum(f.fee_total) AS fee_total
      FROM closure c
      JOIN fees f ON f.uid = c.descendant
     GROUP BY c.root
  )
  SELECT
    b.m_user_id,
    b.m_club_id,
    b.m_club_id,
    cl.name::text,
    pr.player_number::text,
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
    (s.uid IS NOT NULL)
      OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'),
    (s.uid IS NOT NULL),
    CASE WHEN ac.sensitive THEN coalesce(b.m_chip_balance, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(mw.player_total, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(aw.agent_total, 0) END,
    CASE WHEN ac.sensitive
         THEN coalesce(mw.member_promo_total, 0) + coalesce(aw.agent_promo_total, 0) END,
    CASE WHEN ac.sensitive THEN round(coalesce(f.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN round(coalesce(df.fee_total, 0), 2) END,
    CASE WHEN ac.sensitive THEN coalesce(f.hand_total, 0)::bigint END,
    CASE WHEN ac.sensitive THEN coalesce(d.direct_count, 0) END,
    CASE WHEN ac.sensitive THEN coalesce(d.total_count, 0) END,
    CASE WHEN ac.sensitive THEN b.m_agent_id END,
    CASE WHEN ac.sensitive THEN up.upline_name END,
    b.m_joined_at,
    CASE WHEN ac.sensitive
         THEN coalesce(pr.last_login, pr.last_seen, b.m_last_active_at) END,
    CASE WHEN ac.sensitive THEN b.m_nickname::text END,
    CASE WHEN ac.sensitive THEN b.m_notes::text END,
    ac.sensitive,
    ac.sensitive,
    ac.is_downline
  FROM base b
  JOIN access ac ON ac.uid = b.m_user_id
  LEFT JOIN public.profiles pr ON pr.id = b.m_user_id
  LEFT JOIN public.clubs cl ON cl.id = b.m_club_id
  LEFT JOIN seated s ON s.uid = b.m_user_id
  LEFT JOIN member_wallets mw ON mw.uid = b.m_user_id
  LEFT JOIN agent_wallets aw ON aw.uid = b.m_user_id
  LEFT JOIN fees f ON f.uid = b.m_user_id
  LEFT JOIN downlines d ON d.uid = b.m_user_id
  LEFT JOIN downline_fee_totals df ON df.uid = b.m_user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''),
                    nullif(btrim(u.display_name), ''),
                    u.username)::text AS upline_name
      FROM public.profiles u
     WHERE u.id = b.m_agent_id
  ) up ON true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_roster_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_roster_rows(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Lightweight summary: no wallet, fee, note, or recursive downline aggregation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_members_summary(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[];
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_viewer_role text := 'player';
  v_has_agent_scope boolean := false;
  v_has_staff_scope boolean := false;
  v_can_export boolean := false;
  v_out jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false)
      INTO v_platform_admin FROM public.profiles p WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
  END IF;

  IF NOT v_service AND NOT v_platform_admin AND NOT v_union_staff THEN
    SELECT cm.role
      INTO v_viewer_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor
       AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC
     LIMIT 1;
    IF v_viewer_role IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF v_platform_admin OR v_union_staff OR v_service THEN
    v_viewer_role := 'owner';
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('super_agent', 'agent', 'sub_agent')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         ),
         EXISTS (
           SELECT 1 FROM public.club_members cm
            WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
              AND cm.role IN ('owner', 'co_owner', 'admin')
              AND coalesce(cm.status, 'approved') IN ('active', 'approved')
         )
    INTO v_has_agent_scope, v_has_staff_scope;

  v_can_export := v_service OR v_platform_admin OR v_union_staff OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  );

  WITH base AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.role, public.fn_club_role_rank(cm.role) AS role_rank,
           cm.updated_at
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id
      FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  )
  SELECT jsonb_build_object(
    'viewer_role', coalesce(v_viewer_role, 'player'),
    'capabilities', jsonb_build_object(
      'can_view_financials', v_service OR v_platform_admin OR v_union_staff
                              OR v_has_staff_scope OR v_has_agent_scope,
      'can_export', v_can_export,
      'can_manage_members', v_service OR v_platform_admin OR v_union_staff OR v_has_staff_scope,
      'can_view_notes', v_service OR v_platform_admin OR v_union_staff
                        OR v_has_staff_scope OR v_has_agent_scope
    ),
    'counts', jsonb_build_object(
      'total', count(*),
      'online', count(*) FILTER (
        WHERE s.user_id IS NOT NULL
           OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
      ),
      'seated', count(*) FILTER (WHERE s.user_id IS NOT NULL),
      'agents', count(*) FILTER (WHERE b.role IN ('super_agent', 'agent', 'sub_agent')),
      'admins', count(*) FILTER (WHERE b.role IN ('owner', 'co_owner', 'admin'))
    ),
    'data_version', max(b.updated_at),
    'page_size', 80
  ) INTO v_out
  FROM base b
  LEFT JOIN seated s ON s.user_id = b.user_id
  LEFT JOIN public.profiles pr ON pr.id = b.user_id;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_summary(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Keyset page. The cursor is opaque to the client and generated by this RPC.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_members_page(
  p_club_id uuid,
  p_search text DEFAULT '',
  p_filter text DEFAULT 'all',
  p_sort text DEFAULT 'hierarchy',
  p_cursor jsonb DEFAULT NULL,
  p_limit integer DEFAULT 80
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_filter text := lower(coalesce(nullif(btrim(p_filter), ''), 'all'));
  v_sort text := lower(coalesce(nullif(btrim(p_sort), ''), 'hierarchy'));
  v_limit int := greatest(20, least(coalesce(p_limit, 80), 200));
  v_cursor jsonb := p_cursor;
  v_out jsonb;
BEGIN
  IF v_filter NOT IN (
    'all', 'mine', 'seated', 'online', 'agents', 'admins',
    'inactive_30', 'inactive_60', 'inactive_90', 'high_fees'
  ) THEN
    v_filter := 'all';
  END IF;
  IF v_sort NOT IN ('hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees') THEN
    v_sort := 'hierarchy';
  END IF;

  -- A cursor is an opaque server token, but it still crosses a hostile client
  -- boundary. Treat malformed numeric components as an expired cursor instead
  -- of letting a text-to-number cast turn the whole roster into a 500.
  IF v_cursor IS NOT NULL AND (
    (v_cursor ? 'rank' AND coalesce(v_cursor->>'rank', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'downlines' AND coalesce(v_cursor->>'downlines', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'presence' AND coalesce(v_cursor->>'presence', '') !~ '^-?[0-9]+$')
    OR (v_cursor ? 'activity' AND coalesce(v_cursor->>'activity', '') !~ '^-?[0-9]+([.][0-9]+)?$')
    OR (v_cursor ? 'metric' AND coalesce(v_cursor->>'metric', '') !~ '^-?[0-9]+([.][0-9]+)?$')
  ) THEN
    v_cursor := NULL;
  END IF;

  WITH rows AS MATERIALIZED (
    SELECT r.*,
           lower(r.alias) AS sort_name,
           CASE WHEN r.is_seated THEN 2 WHEN r.is_online THEN 1 ELSE 0 END AS presence_rank,
           coalesce(extract(epoch FROM r.last_login), 0)::numeric AS activity_epoch,
           coalesce(r.player_wallet, 0) + coalesce(r.agent_wallet, 0) AS wallet_total
      FROM public.ca_club_roster_rows(p_club_id) r
     WHERE (
       v_search = ''
       OR lower(r.alias) LIKE '%' || v_search || '%'
       OR lower(r.username) LIKE '%' || v_search || '%'
       OR lower(coalesce(r.player_number, '')) LIKE '%' || v_search || '%'
       OR lower(coalesce(r.home_club_name, '')) LIKE '%' || v_search || '%'
       OR lower(coalesce(r.upline_name, '')) LIKE '%' || v_search || '%'
     )
       AND CASE v_filter
         WHEN 'mine' THEN r.in_viewer_downline
         WHEN 'seated' THEN r.is_seated
         WHEN 'online' THEN r.is_online
         WHEN 'agents' THEN r.role IN ('super_agent', 'agent', 'sub_agent')
         WHEN 'admins' THEN r.role IN ('owner', 'co_owner', 'admin')
         WHEN 'inactive_30' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '30 days'
         WHEN 'inactive_60' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '60 days'
         WHEN 'inactive_90' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '90 days'
         WHEN 'high_fees' THEN coalesce(r.total_fees, 0) >= 100
         ELSE true
       END
  ), eligible AS MATERIALIZED (
    SELECT r.*
      FROM rows r
     WHERE v_cursor IS NULL OR CASE v_sort
       WHEN 'name' THEN
         (r.sort_name, r.user_id::text) >
         (coalesce(v_cursor->>'name', ''), coalesce(v_cursor->>'id', ''))
       WHEN 'activity' THEN
         r.presence_rank < coalesce((v_cursor->>'presence')::int, 0)
         OR (r.presence_rank = coalesce((v_cursor->>'presence')::int, 0)
             AND r.activity_epoch < coalesce((v_cursor->>'activity')::numeric, 0))
         OR (r.presence_rank = coalesce((v_cursor->>'presence')::int, 0)
             AND r.activity_epoch = coalesce((v_cursor->>'activity')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'downlines' THEN
         coalesce(r.downline_total, 0) < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (coalesce(r.downline_total, 0) = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'wallet' THEN
         r.wallet_total < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (r.wallet_total = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       WHEN 'fees' THEN
         coalesce(r.total_fees, 0) < coalesce((v_cursor->>'metric')::numeric, 0)
         OR (coalesce(r.total_fees, 0) = coalesce((v_cursor->>'metric')::numeric, 0)
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       ELSE
         r.role_rank < coalesce((v_cursor->>'rank')::int, 0)
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) < coalesce((v_cursor->>'downlines')::int, 0))
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) = coalesce((v_cursor->>'downlines')::int, 0)
             AND r.sort_name > coalesce(v_cursor->>'name', ''))
         OR (r.role_rank = coalesce((v_cursor->>'rank')::int, 0)
             AND coalesce(r.downline_total, 0) = coalesce((v_cursor->>'downlines')::int, 0)
             AND r.sort_name = coalesce(v_cursor->>'name', '')
             AND r.user_id::text > coalesce(v_cursor->>'id', ''))
       END
  ), ordered AS MATERIALIZED (
    SELECT e.*,
           row_number() OVER (
             ORDER BY
               CASE WHEN v_sort = 'hierarchy' THEN e.role_rank END DESC,
               CASE WHEN v_sort = 'hierarchy' THEN coalesce(e.downline_total, 0) END DESC,
               CASE WHEN v_sort = 'hierarchy' THEN e.sort_name END ASC,
               CASE WHEN v_sort = 'activity' THEN e.presence_rank END DESC,
               CASE WHEN v_sort = 'activity' THEN e.activity_epoch END DESC,
               CASE WHEN v_sort = 'name' THEN e.sort_name END ASC,
               CASE WHEN v_sort = 'downlines' THEN coalesce(e.downline_total, 0) END DESC,
               CASE WHEN v_sort = 'wallet' THEN e.wallet_total END DESC,
               CASE WHEN v_sort = 'fees' THEN coalesce(e.total_fees, 0) END DESC,
               e.user_id ASC
           ) AS rn
      FROM eligible e
     ORDER BY
       CASE WHEN v_sort = 'hierarchy' THEN e.role_rank END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN coalesce(e.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN e.sort_name END ASC,
       CASE WHEN v_sort = 'activity' THEN e.presence_rank END DESC,
       CASE WHEN v_sort = 'activity' THEN e.activity_epoch END DESC,
       CASE WHEN v_sort = 'name' THEN e.sort_name END ASC,
       CASE WHEN v_sort = 'downlines' THEN coalesce(e.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'wallet' THEN e.wallet_total END DESC,
       CASE WHEN v_sort = 'fees' THEN coalesce(e.total_fees, 0) END DESC,
       e.user_id ASC
     LIMIT v_limit + 1
  ), visible AS MATERIALIZED (
    SELECT * FROM ordered WHERE rn <= v_limit
  ), last_row AS (
    SELECT * FROM visible ORDER BY rn DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(
        to_jsonb(v) - ARRAY['sort_name', 'presence_rank', 'activity_epoch', 'wallet_total', 'rn']::text[]
        ORDER BY v.rn
      ) FROM visible v
    ), '[]'::jsonb),
    'next_cursor', CASE WHEN (SELECT count(*) FROM ordered) > v_limit THEN (
      SELECT jsonb_build_object(
        'id', l.user_id,
        'name', l.sort_name,
        'rank', l.role_rank,
        'downlines', coalesce(l.downline_total, 0),
        'presence', l.presence_rank,
        'activity', l.activity_epoch,
        'metric', CASE v_sort
          WHEN 'wallet' THEN l.wallet_total
          WHEN 'fees' THEN coalesce(l.total_fees, 0)
          WHEN 'downlines' THEN coalesce(l.downline_total, 0)
          ELSE 0 END
      ) FROM last_row l
    ) ELSE NULL END,
    'has_more', (SELECT count(*) FROM ordered) > v_limit,
    'filtered_total', (SELECT count(*) FROM rows),
    'query', jsonb_build_object('filter', v_filter, 'sort', v_sort)
  ) INTO v_out;

  RETURN coalesce(v_out, jsonb_build_object(
    'items', '[]'::jsonb,
    'next_cursor', NULL,
    'has_more', false,
    'filtered_total', 0,
    'query', jsonb_build_object('filter', v_filter, 'sort', v_sort)
  ));
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members_page(uuid, text, text, text, jsonb, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_page(uuid, text, text, text, jsonb, integer)
  TO authenticated, service_role;

-- Backward-compatible full roster. Existing clients become safe immediately;
-- the Phase Three client moves to ca_club_members_page for payload size.
CREATE OR REPLACE FUNCTION public.ca_club_members_overview(p_club_id uuid)
RETURNS TABLE (
  user_id uuid,
  home_club_id uuid,
  home_club_name text,
  player_number text,
  alias text,
  username text,
  display_name text,
  avatar_url text,
  role text,
  role_rank int,
  is_online boolean,
  is_seated boolean,
  chip_balance numeric,
  player_wallet numeric,
  agent_wallet numeric,
  promo_wallet numeric,
  total_fees numeric,
  downline_fees numeric,
  total_hands bigint,
  downline_direct int,
  downline_total int,
  upline_user_id uuid,
  upline_name text,
  joined_at timestamptz,
  last_login timestamptz,
  nickname text,
  remark text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT r.user_id, r.home_club_id, r.home_club_name, r.player_number,
         r.alias, r.username, r.display_name, r.avatar_url, r.role, r.role_rank,
         r.is_online, r.is_seated, r.chip_balance, r.player_wallet,
         r.agent_wallet, r.promo_wallet, r.total_fees, r.downline_fees,
         r.total_hands, r.downline_direct, r.downline_total, r.upline_user_id,
         r.upline_name, r.joined_at, r.last_login, r.nickname, r.remark
    FROM public.ca_club_roster_rows(p_club_id) r
   ORDER BY r.role_rank DESC, coalesce(r.downline_total, 0) DESC, lower(r.alias), r.user_id;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_overview(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Audited staff export. Search text is never written into the audit trail.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_members_export(
  p_club_id uuid,
  p_search text DEFAULT '',
  p_filter text DEFAULT 'all',
  p_sort text DEFAULT 'hierarchy',
  p_user_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_platform_admin boolean := false;
  v_union_staff boolean := false;
  v_staff boolean := false;
  v_actor_role text := 'service_role';
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_filter text := lower(coalesce(nullif(btrim(p_filter), ''), 'all'));
  v_sort text := lower(coalesce(nullif(btrim(p_sort), ''), 'hierarchy'));
  v_rows jsonb;
  v_count int := 0;
  v_audit_id uuid;
BEGIN
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;

  IF NOT v_service AND v_actor IS NOT NULL THEN
    SELECT coalesce(p.is_admin, false) INTO v_platform_admin
      FROM public.profiles p WHERE p.id = v_actor;
    v_union_staff := coalesce(public.fn_is_union_overseer(p_club_id, v_actor), false);
    SELECT cm.role INTO v_actor_role
      FROM public.club_members cm
     WHERE cm.user_id = v_actor AND cm.club_id = p_club_id
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;
    v_staff := v_platform_admin OR v_union_staff OR v_actor_role IS NOT NULL;
  ELSE
    v_staff := v_service;
  END IF;

  IF NOT v_staff THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Roster Export Requires Club Staff Access';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Roster Export Requires An Auditable Actor';
  END IF;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE
      WHEN v_platform_admin THEN 'platform_admin'
      WHEN v_union_staff THEN 'union_admin'
      ELSE 'system'
    END;
  END IF;

  WITH rows AS MATERIALIZED (
    SELECT r.*,
           lower(r.alias) AS sort_name,
           CASE WHEN r.is_seated THEN 2 WHEN r.is_online THEN 1 ELSE 0 END AS presence_rank,
           coalesce(extract(epoch FROM r.last_login), 0)::numeric AS activity_epoch,
           coalesce(r.player_wallet, 0) + coalesce(r.agent_wallet, 0) AS wallet_total
      FROM public.ca_club_roster_rows(p_club_id) r
     WHERE r.can_view_financials
       AND (p_user_ids IS NULL OR r.user_id = ANY(p_user_ids))
       AND (
         v_search = '' OR lower(r.alias) LIKE '%' || v_search || '%'
         OR lower(r.username) LIKE '%' || v_search || '%'
         OR lower(coalesce(r.player_number, '')) LIKE '%' || v_search || '%'
         OR lower(coalesce(r.home_club_name, '')) LIKE '%' || v_search || '%'
         OR lower(coalesce(r.upline_name, '')) LIKE '%' || v_search || '%'
       )
       AND CASE v_filter
         WHEN 'mine' THEN r.in_viewer_downline
         WHEN 'seated' THEN r.is_seated
         WHEN 'online' THEN r.is_online
         WHEN 'agents' THEN r.role IN ('super_agent', 'agent', 'sub_agent')
         WHEN 'admins' THEN r.role IN ('owner', 'co_owner', 'admin')
         WHEN 'inactive_30' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '30 days'
         WHEN 'inactive_60' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '60 days'
         WHEN 'inactive_90' THEN r.last_login IS NOT NULL AND r.last_login < now() - interval '90 days'
         WHEN 'high_fees' THEN coalesce(r.total_fees, 0) >= 100
         ELSE true END
  ), ordered AS (
    SELECT r.* FROM rows r
     ORDER BY
       CASE WHEN v_sort = 'hierarchy' THEN r.role_rank END DESC,
       CASE WHEN v_sort = 'hierarchy' THEN coalesce(r.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'activity' THEN r.presence_rank END DESC,
       CASE WHEN v_sort = 'activity' THEN r.activity_epoch END DESC,
       CASE WHEN v_sort = 'name' THEN r.sort_name END ASC,
       CASE WHEN v_sort = 'downlines' THEN coalesce(r.downline_total, 0) END DESC,
       CASE WHEN v_sort = 'wallet' THEN r.wallet_total END DESC,
       CASE WHEN v_sort = 'fees' THEN coalesce(r.total_fees, 0) END DESC,
       r.sort_name ASC, r.user_id ASC
  )
  SELECT coalesce(jsonb_agg(
           to_jsonb(o) - ARRAY['sort_name', 'presence_rank', 'activity_epoch', 'wallet_total',
                                  'can_view_financials', 'can_view_notes', 'in_viewer_downline']::text[]
         ), '[]'::jsonb), count(*)::int
    INTO v_rows, v_count
    FROM ordered o;

  INSERT INTO public.audit_trail (
    actor_id, actor_role, action, target_type, target_id, club_id,
    after_state, reason
  ) VALUES (
    v_actor, v_actor_role,
    'export_club_roster', 'club', p_club_id, p_club_id,
    jsonb_build_object(
      'row_count', v_count,
      'selected_only', p_user_ids IS NOT NULL,
      'selected_count', coalesce(array_length(p_user_ids, 1), 0),
      'filter', v_filter,
      'sort', v_sort,
      'search_used', v_search <> ''
    ),
    'Authorized Club Roster Export'
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'success', true,
    'rows', v_rows,
    'row_count', v_count,
    'audit_id', v_audit_id
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_members_export(uuid, text, text, text, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_export(uuid, text, text, text, uuid[])
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Audited nickname/remark writer. Direct client updates are closed below.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_member_notes_update(
  p_club_id uuid,
  p_target_user_id uuid,
  p_nickname text,
  p_remark text,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text;
  v_member_club uuid;
  v_before_nickname text;
  v_before_remark text;
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Member Note Updates Require An Auditable Actor';
  END IF;

  v_access := public.ca_club_roster_access(p_club_id, p_target_user_id);
  IF v_access NOT IN ('staff', 'downline', 'service') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'You Do Not Have Permission To Edit These Notes';
  END IF;

  IF p_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_trail a
     WHERE a.actor_id IS NOT DISTINCT FROM v_actor
       AND a.action = 'update_member_notes'
       AND a.target_id = p_target_user_id
       AND a.club_id = p_club_id
       AND a.request_id = p_request_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true);
  END IF;

  SELECT cm.club_id, cm.nickname, cm.notes
    INTO v_member_club, v_before_nickname, v_before_remark
    FROM public.club_members cm
   WHERE cm.user_id = p_target_user_id
     AND cm.club_id = ANY(v_scope)
     AND coalesce(cm.status, 'approved') IN ('active', 'approved')
   ORDER BY public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_member_club IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member Not Found');
  END IF;

  PERFORM set_config('app.club_notes_update', 'on', true);
  UPDATE public.club_members
     SET nickname = nullif(btrim(left(coalesce(p_nickname, ''), 64)), ''),
         notes = nullif(btrim(left(coalesce(p_remark, ''), 240)), ''),
         updated_at = now()
   WHERE club_id = v_member_club AND user_id = p_target_user_id;
  PERFORM set_config('app.club_notes_update', '', true);

  SELECT cm.role INTO v_actor_role
    FROM public.club_members cm
   WHERE cm.user_id = v_actor AND cm.club_id = ANY(v_scope)
   ORDER BY public.fn_club_role_rank(cm.role) DESC LIMIT 1;

  INSERT INTO public.audit_trail (
    actor_id, actor_role, action, target_type, target_id, club_id,
    before_state, after_state, reason, request_id
  ) VALUES (
    v_actor, coalesce(v_actor_role, 'service_role'), 'update_member_notes',
    'club_member', p_target_user_id, p_club_id,
    jsonb_build_object(
      'nickname_present', v_before_nickname IS NOT NULL,
      'remark_present', v_before_remark IS NOT NULL,
      'nickname_length', length(coalesce(v_before_nickname, '')),
      'remark_length', length(coalesce(v_before_remark, ''))
    ),
    jsonb_build_object(
      'nickname_present', nullif(btrim(coalesce(p_nickname, '')), '') IS NOT NULL,
      'remark_present', nullif(btrim(coalesce(p_remark, '')), '') IS NOT NULL,
      'nickname_length', length(btrim(left(coalesce(p_nickname, ''), 64))),
      'remark_length', length(btrim(left(coalesce(p_remark, ''), 240)))
    ),
    'Authorized Member Note Update', p_request_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'replayed', false,
    'nickname', nullif(btrim(left(coalesce(p_nickname, ''), 64)), ''),
    'remark', nullif(btrim(left(coalesce(p_remark, ''), 240)), '')
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_notes_update(uuid, uuid, text, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_member_notes_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.nickname IS NOT DISTINCT FROM OLD.nickname
     AND NEW.notes IS NOT DISTINCT FROM OLD.notes THEN
    RETURN NEW;
  END IF;

  IF coalesce(auth.role(), 'service_role') = 'service_role'
     OR current_setting('app.club_notes_update', true) = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'Member Notes Must Be Updated Through ca_club_member_notes_update';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_club_member_notes_guard ON public.club_members;
CREATE TRIGGER trg_club_member_notes_guard
BEFORE UPDATE OF nickname, notes ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_club_member_notes_guard();

-- ---------------------------------------------------------------------------
-- Role-shaped Member Management detail, statistics, and downline.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_club_member_detail(
  p_club_id uuid,
  p_user_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_sensitive boolean := v_access IN ('staff', 'downline', 'service');
  v_overall boolean := p_from IS NULL AND p_to IS NULL;
  v_ts_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_ts_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_out jsonb;
BEGIN
  IF v_access = 'none' OR v_scope IS NULL THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.club_id, cm.role, cm.agent_id, cm.chip_balance,
           cm.promo_balance, cm.nickname, cm.notes, cm.display_name, cm.joined_at,
           public.fn_club_role_rank(cm.role) AS role_rank
      FROM public.club_members cm
     WHERE cm.user_id = p_user_id
       AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope)
       AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS MATERIALIZED (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child
     WHERE t.depth < 20
  ), downline AS MATERIALIZED (
    SELECT count(DISTINCT child) FILTER (WHERE depth = 1)::int AS direct,
           count(DISTINCT child)::int AS total FROM tree
  ), seat AS MATERIALIZED (
    SELECT 1 AS seated
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope)) LIMIT 1
  ), member_wallet AS MATERIALIZED (
    SELECT sum(coalesce(cm.chip_balance, 0)) AS player_wallet,
           sum(coalesce(cm.promo_balance, 0)) AS member_promo
      FROM public.club_members cm
     WHERE v_sensitive AND cm.user_id = p_user_id AND cm.club_id = ANY(v_scope)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), agent_wallet AS MATERIALIZED (
    SELECT sum(coalesce(a.agent_wallet_balance, 0)) AS agent_wallet,
           sum(coalesce(a.promo_wallet_balance, 0)) AS agent_promo
      FROM public.agents a
     WHERE v_sensitive AND a.user_id = p_user_id AND a.club_id = ANY(v_scope)
       AND coalesce(a.status, 'active') = 'active'
  ), roll AS MATERIALIZED (
    SELECT coalesce(sum(r.hands) FILTER (WHERE NOT r.is_mtt), 0)::bigint AS hands,
           coalesce(sum(r.hands) FILTER (WHERE r.is_mtt), 0)::bigint AS mtt_hands,
           coalesce(sum(r.fees) FILTER (WHERE NOT r.is_mtt), 0) AS fees,
           coalesce(sum(r.fees) FILTER (WHERE r.is_mtt), 0) AS mtt_fees,
           coalesce(sum(r.won - r.contributed) FILTER (WHERE NOT r.is_mtt), 0) AS net,
           coalesce(sum(r.won - r.contributed) FILTER (WHERE r.is_mtt), 0) AS mtt_net
      FROM public.member_fee_rollup r
     WHERE v_sensitive AND r.user_id = p_user_id
       AND (p_from IS NULL OR r.day >= p_from) AND (p_to IS NULL OR r.day <= p_to)
  ), txn AS MATERIALIZED (
    SELECT coalesce(sum(wt.amount) FILTER (
             WHERE wt.amount > 0 AND lower(coalesce(wt.type, '')) NOT IN ('debit', 'withdrawal')
               AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
                   ~ '(rakeback|rake_back|rake back|commission)'
           ), 0) AS claimed_back,
           coalesce(sum(abs(wt.amount)) FILTER (
             WHERE (wt.amount < 0 OR lower(coalesce(wt.type, '')) IN ('debit', 'withdrawal', 'send', 'transfer_out'))
               AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
                   ~ '(transfer|send|distribute)'
           ), 0) AS sent_out
      FROM public.wallet_transactions wt
     WHERE v_sensitive AND wt.user_id = p_user_id
       AND (v_ts_from IS NULL OR wt.created_at >= v_ts_from)
       AND (v_ts_to IS NULL OR wt.created_at < v_ts_to)
  )
  SELECT jsonb_build_object(
    'identity', jsonb_build_object(
      'user_id', p_user_id,
      'player_number', pr.player_number,
      'alias', coalesce(nullif(btrim(pr.alias), ''), nullif(btrim(m.display_name), ''),
                        nullif(btrim(pr.display_name), ''), pr.username),
      'username', pr.username,
      'display_name', coalesce(nullif(btrim(pr.display_name), ''), pr.username),
      'avatar_url', coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url),
      'role', m.role,
      'role_rank', coalesce(m.role_rank, 0),
      'nickname', CASE WHEN v_sensitive THEN m.nickname END,
      'remark', CASE WHEN v_sensitive THEN m.notes END,
      'last_login', CASE WHEN v_sensitive THEN coalesce(pr.last_login, pr.last_seen) END,
      'joined_at', m.joined_at,
      'home_club_id', m.club_id,
      'home_club_name', cl.name,
      'upline_user_id', CASE WHEN v_sensitive THEN m.agent_id END,
      'upline_name', CASE WHEN v_sensitive THEN up.up_name END,
      'upline_player_number', CASE WHEN v_sensitive THEN up.up_number END
    ),
    'presence', jsonb_build_object(
      'is_online', s.seated IS NOT NULL OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes'),
      'is_seated', s.seated IS NOT NULL
    ),
    'wallets', CASE WHEN v_sensitive THEN jsonb_build_object(
      'chip_balance', coalesce(m.chip_balance, 0),
      'player_wallet', coalesce(mw.player_wallet, 0),
      'agent_wallet', coalesce(aw.agent_wallet, 0),
      'promo_wallet', coalesce(mw.member_promo, 0) + coalesce(aw.agent_promo, 0)
    ) ELSE NULL END,
    'downline', CASE WHEN v_sensitive THEN jsonb_build_object(
      'downline_direct', coalesce(d.direct, 0), 'downline_total', coalesce(d.total, 0)
    ) ELSE NULL END,
    'stats', CASE WHEN v_sensitive THEN jsonb_build_object(
      'hands', coalesce(rl.hands, 0), 'mtt_hands', coalesce(rl.mtt_hands, 0),
      'total_fee', round(coalesce(rl.fees, 0), 2), 'mtt_fee', round(coalesce(rl.mtt_fees, 0), 2),
      'total_winnings', round(coalesce(rl.net, 0), 2), 'mtt_winnings', round(coalesce(rl.mtt_net, 0), 2),
      'claimed_back', round(coalesce(tx.claimed_back, 0), 2), 'sent_out', round(coalesce(tx.sent_out, 0), 2)
    ) ELSE NULL END,
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'is_overall', v_overall),
    'capabilities', jsonb_build_object(
      'access', v_access,
      'can_view_financials', v_sensitive,
      'can_view_stats', v_sensitive,
      'can_view_downline', v_sensitive,
      'can_view_notes', v_sensitive,
      'can_edit_notes', v_sensitive AND auth.uid() IS DISTINCT FROM p_user_id,
      'can_manage_role', v_access IN ('staff', 'downline', 'service')
    )
  ) INTO v_out
  FROM (SELECT 1) anchor
  LEFT JOIN mem m ON true
  LEFT JOIN public.profiles pr ON pr.id = p_user_id
  LEFT JOIN public.clubs cl ON cl.id = m.club_id
  LEFT JOIN seat s ON true
  LEFT JOIN member_wallet mw ON true
  LEFT JOIN agent_wallet aw ON true
  LEFT JOIN downline d ON true
  LEFT JOIN roll rl ON true
  LEFT JOIN txn tx ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''), nullif(btrim(u.display_name), ''), u.username) AS up_name,
           u.player_number AS up_number
      FROM public.profiles u WHERE u.id = m.agent_id
  ) up ON true;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_detail(uuid, uuid, date, date)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(
  p_club_id uuid,
  p_user_id uuid,
  p_variant text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := nullif(lower(btrim(coalesce(p_variant, ''))), '');
  v_all boolean;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN jsonb_build_object('authorized', false);
  END IF;
  v_all := v_variant IS NULL OR v_variant = 'all';

  WITH agg AS (
    SELECT coalesce(sum(r.hands), 0)::bigint AS hands,
           coalesce(sum(r.wins), 0)::bigint AS wins,
           coalesce(sum(r.vpip_hands), 0)::bigint AS vpip_hands,
           coalesce(sum(r.pfr_hands), 0)::bigint AS pfr_hands,
           coalesce(sum(r.three_bet_hands), 0)::bigint AS tb_hands,
           coalesce(sum(r.three_bet_opps), 0)::bigint AS tb_opps,
           coalesce(sum(r.cbet_hands), 0)::bigint AS cb_hands,
           coalesce(sum(r.cbet_opps), 0)::bigint AS cb_opps,
           coalesce(sum(r.won - r.contributed), 0) AS net,
           coalesce(sum(r.fees), 0) AS fees,
           count(DISTINCT r.day) FILTER (WHERE r.hands > 0)::int AS games
      FROM public.member_fee_rollup r
     WHERE r.user_id = p_user_id
       AND (v_all OR r.game_variant = v_variant)
       AND (p_from IS NULL OR r.day >= p_from) AND (p_to IS NULL OR r.day <= p_to)
  ), vars AS (
    SELECT coalesce(jsonb_agg(DISTINCT r.game_variant ORDER BY r.game_variant), '[]'::jsonb) AS list
      FROM public.member_fee_rollup r
     WHERE r.user_id = p_user_id AND r.game_variant IS NOT NULL
  )
  SELECT jsonb_build_object(
    'authorized', true, 'variant', coalesce(v_variant, 'all'), 'variants', vars.list,
    'total_games', coalesce(a.games, 0), 'total_hands', coalesce(a.hands, 0),
    'wins', coalesce(a.wins, 0), 'winner', coalesce(a.wins, 0),
    'vpip', coalesce(round(100.0 * a.vpip_hands / nullif(a.hands, 0), 2), 0),
    'pfr', coalesce(round(100.0 * a.pfr_hands / nullif(a.hands, 0), 2), 0),
    'three_bet', coalesce(round(100.0 * a.tb_hands / nullif(a.tb_opps, 0), 2), 0),
    'cbet', coalesce(round(100.0 * a.cb_hands / nullif(a.cb_opps, 0), 2), 0),
    'net', round(coalesce(a.net, 0), 2), 'fees', round(coalesce(a.fees, 0), 2),
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid, uuid, text, date, date)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_club_member_downline(p_club_id uuid, p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  player_number text,
  alias text,
  username text,
  role text,
  role_rank int,
  depth int,
  chip_balance numeric,
  total_fees numeric,
  is_online boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_scope uuid[] := public.fn_club_scope_ids(p_club_id);
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
BEGIN
  IF v_access NOT IN ('staff', 'downline', 'service') OR v_scope IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope) AND cm.agent_id IS NOT NULL AND cm.agent_id <> cm.user_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), tree AS (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child WHERE t.depth < 20
  ), flat AS MATERIALIZED (
    SELECT t.child AS uid, min(t.depth)::int AS depth FROM tree t GROUP BY t.child
  ), mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id) cm.user_id AS uid, cm.role, cm.chip_balance,
           public.fn_club_role_rank(cm.role) AS role_rank
      FROM public.club_members cm
     WHERE cm.club_id = ANY(v_scope) AND cm.user_id IN (SELECT f.uid FROM flat f)
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id AS uid FROM public.table_seats ts
      JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL AND ts.user_id IN (SELECT f.uid FROM flat f)
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ), fees AS MATERIALIZED (
    SELECT r.user_id AS uid, sum(r.fees) AS fee_total FROM public.member_fee_rollup r
     WHERE r.user_id IN (SELECT f.uid FROM flat f) GROUP BY r.user_id
  )
  SELECT f.uid, pr.player_number::text,
         coalesce(nullif(btrim(pr.alias), ''), nullif(btrim(pr.display_name), ''), pr.username, 'Unknown')::text,
         coalesce(pr.username, '')::text, coalesce(m.role, 'player')::text,
         coalesce(m.role_rank, 0), f.depth, coalesce(m.chip_balance, 0)::numeric,
         round(coalesce(fe.fee_total, 0), 2)::numeric,
         s.uid IS NOT NULL OR (coalesce(pr.is_online, false) AND pr.last_seen > now() - interval '5 minutes')
    FROM flat f LEFT JOIN mem m ON m.uid = f.uid LEFT JOIN public.profiles pr ON pr.id = f.uid
    LEFT JOIN seated s ON s.uid = f.uid LEFT JOIN fees fe ON fe.uid = f.uid
   ORDER BY f.depth, coalesce(m.role_rank, 0) DESC,
            lower(coalesce(nullif(btrim(pr.alias), ''), pr.display_name, pr.username, ''));
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_member_downline(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_downline(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_members_page(uuid, text, text, text, jsonb, integer) IS
  'Role-shaped, keyset-paginated Club Arena roster. Identity and presence are visible to approved members; wallets, fees, activity, hierarchy and notes are returned only to authorized staff or the requesting agent for their recursive downline.';
COMMENT ON FUNCTION public.ca_club_members_export(uuid, text, text, text, uuid[]) IS
  'Staff-only full or selected roster export. Every successful export writes an audit_trail row without storing the search text.';
