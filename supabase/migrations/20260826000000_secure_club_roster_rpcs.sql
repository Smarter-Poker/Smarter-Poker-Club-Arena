-- SECURE CLUB ROSTER RPCs
-- ═══════════════════════════════════════════════════════════════════════════════
-- Prevent non-members from extracting rosters and member details from clubs
-- they have not joined by enforcing a membership check in the SECURITY DEFINER RPCs.

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
  downline_fees   numeric,
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

  -- 🔒 SECURITY CHECK: Reject unauthorized access by non-members.
  -- Service roles (auth.uid() IS NULL) bypass this check.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.club_id = ANY(v_scope)
        AND coalesce(cm.status, 'pending') IN ('active', 'approved')
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH RECURSIVE base AS MATERIALIZED (
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
      AND coalesce(cm.status, 'approved') NOT IN ('banned', 'suspended', 'rejected', 'left', 'pending')
    ORDER BY cm.user_id,
             CASE cm.role
               WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
               WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
               ELSE 0 END DESC,
             cm.joined_at ASC
  ),
  edges AS MATERIALIZED (
    SELECT b.m_user_id AS child, b.m_agent_id AS parent
    FROM base b
    WHERE b.m_agent_id IS NOT NULL AND b.m_agent_id <> b.m_user_id
  ),
  closure AS MATERIALIZED (
    SELECT parent AS root, child AS descendant, 1 AS depth FROM edges
    UNION ALL
    SELECT c.root, e.child, c.depth + 1
    FROM closure c
    JOIN edges e ON e.parent = c.descendant
    WHERE c.depth < 20
  ),
  downlines AS MATERIALIZED (
    SELECT root AS d_user_id,
           count(DISTINCT descendant) FILTER (WHERE depth = 1)::int AS d_direct,
           count(DISTINCT descendant)::int                          AS d_total
    FROM closure
    GROUP BY root
  ),
  seated AS MATERIALIZED (
    SELECT DISTINCT ts.user_id AS s_user_id
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL
      AND ts.user_id IS NOT NULL
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
  ),
  wal AS MATERIALIZED (
    SELECT w.user_id AS w_user_id,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PLAYER')   AS w_player,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'BUSINESS') AS w_agent,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PROMO')    AS w_promo
    FROM public.wallets w
    JOIN base b ON b.m_user_id = w.user_id
    GROUP BY w.user_id
  ),
  fees AS MATERIALIZED (
    SELECT r.user_id AS f_user_id,
           sum(r.fees)  AS f_fees,
           sum(r.hands) AS f_hands
    FROM public.member_fee_rollup r
    JOIN base b ON b.m_user_id = r.user_id
    GROUP BY r.user_id
  ),
  downline_fees_agg AS MATERIALIZED (
    SELECT c.root AS df_user_id,
           sum(f.f_fees) AS df_fees
    FROM closure c
    JOIN fees f ON f.f_user_id = c.descendant
    GROUP BY c.root
  )
  SELECT
    b.m_user_id,
    b.m_club_id,
    c.name::text,
    pr.player_number,
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
    round(coalesce(df.df_fees, 0), 2),
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
  LEFT JOIN seated    s  ON s.s_user_id = b.m_user_id
  LEFT JOIN wal       w  ON w.w_user_id = b.m_user_id
  LEFT JOIN fees      f  ON f.f_user_id = b.m_user_id
  LEFT JOIN downlines d  ON d.d_user_id = b.m_user_id
  LEFT JOIN downline_fees_agg df ON df.df_user_id = b.m_user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(up_pr.alias), ''),
                    nullif(btrim(up_pr.display_name), ''),
                    up_pr.username)::text AS upline_name
    FROM public.profiles up_pr WHERE up_pr.id = b.m_agent_id
  ) up ON true
  ORDER BY b.m_rank DESC,
           coalesce(d.d_total, 0) DESC,
           lower(coalesce(nullif(btrim(pr.alias), ''), pr.display_name, pr.username, ''));
END;
$$;


CREATE OR REPLACE FUNCTION public.ca_club_member_detail(
  p_club_id uuid,
  p_user_id uuid,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_scope   uuid[];
  v_overall boolean := (p_from IS NULL AND p_to IS NULL);
  v_ts_from timestamptz := CASE WHEN p_from IS NULL THEN NULL
                                ELSE (p_from::timestamp AT TIME ZONE 'UTC') END;
  v_ts_to   timestamptz := CASE WHEN p_to IS NULL THEN NULL
                                ELSE ((p_to + 1)::timestamp AT TIME ZONE 'UTC') END;
  v_out     jsonb;
BEGIN
  v_scope := public.fn_club_scope_ids(p_club_id);
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    v_scope := ARRAY[p_club_id];
  END IF;

  -- 🔒 SECURITY CHECK: Reject unauthorized access by non-members.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.club_id = ANY(v_scope)
        AND coalesce(cm.status, 'pending') IN ('active', 'approved')
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  WITH RECURSIVE
  mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.club_id, cm.role, cm.agent_id, cm.chip_balance,
           cm.nickname, cm.notes, cm.display_name, cm.joined_at,
           CASE cm.role
             WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
             WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
             ELSE 0 END AS role_rank
    FROM public.club_members cm
    WHERE cm.user_id = p_user_id
      AND cm.club_id = ANY(v_scope)
    ORDER BY cm.user_id,
             CASE cm.role
               WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
               WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
               ELSE 0 END DESC,
             cm.joined_at ASC
  ),
  edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
    FROM public.club_members cm
    WHERE cm.club_id = ANY(v_scope)
      AND cm.agent_id IS NOT NULL
      AND cm.agent_id <> cm.user_id
  ),
  tree AS MATERIALIZED (
    SELECT e.child, 1 AS depth FROM edges e WHERE e.parent = p_user_id
    UNION ALL
    SELECT e.child, t.depth + 1
    FROM tree t JOIN edges e ON e.parent = t.child
    WHERE t.depth < 20
  ),
  down AS MATERIALIZED (
    SELECT count(DISTINCT child) FILTER (WHERE depth = 1)::int AS direct,
           count(DISTINCT child)::int                          AS total
    FROM tree
  ),
  seat AS MATERIALIZED (
    SELECT 1 AS seated
    FROM public.table_seats ts
    JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.user_id = p_user_id
      AND ts.left_at IS NULL
      AND t.status IN ('waiting', 'running')
      AND (ts.club_id = ANY(v_scope) OR t.club_id = ANY(v_scope))
    LIMIT 1
  ),
  wal AS MATERIALIZED (
    SELECT sum(w.balance) FILTER (WHERE w.wallet_type = 'PLAYER')   AS w_player,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'BUSINESS') AS w_agent,
           sum(w.balance) FILTER (WHERE w.wallet_type = 'PROMO')    AS w_promo
    FROM public.wallets w
    WHERE w.user_id = p_user_id
  ),
  roll AS MATERIALIZED (
    SELECT
      coalesce(sum(r.hands) FILTER (WHERE NOT r.is_mtt), 0)::bigint AS hands,
      coalesce(sum(r.hands) FILTER (WHERE r.is_mtt), 0)::bigint     AS mtt_hands,
      coalesce(sum(r.fees)  FILTER (WHERE NOT r.is_mtt), 0)         AS fees,
      coalesce(sum(r.fees)  FILTER (WHERE r.is_mtt), 0)             AS mtt_fees,
      coalesce(sum(r.won - r.contributed) FILTER (WHERE NOT r.is_mtt), 0) AS net,
      coalesce(sum(r.won - r.contributed) FILTER (WHERE r.is_mtt), 0)     AS mtt_net
    FROM public.member_fee_rollup r
    WHERE r.user_id = p_user_id
      AND (v_overall OR (p_from IS NULL OR r.day >= p_from))
      AND (v_overall OR (p_to   IS NULL OR r.day <= p_to))
  ),
  txn AS MATERIALIZED (
    SELECT
      coalesce(sum(wt.amount) FILTER (
        WHERE wt.amount > 0
          AND lower(coalesce(wt.type, '')) NOT IN ('debit', 'withdrawal')
          AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
              ~ '(rakeback|rake_back|rake back|commission)'
      ), 0) AS claimed_back,
      coalesce(sum(abs(wt.amount)) FILTER (
        WHERE (wt.amount < 0 OR lower(coalesce(wt.type, ''))
                                IN ('debit', 'withdrawal', 'send', 'transfer_out'))
          AND lower(coalesce(wt.category, '') || ' ' || coalesce(wt.type, ''))
              ~ '(transfer|send|distribute)'
      ), 0) AS sent_out
    FROM public.wallet_transactions wt
    WHERE wt.user_id = p_user_id
      AND (v_ts_from IS NULL OR wt.created_at >= v_ts_from)
      AND (v_ts_to   IS NULL OR wt.created_at <  v_ts_to)
  )
  SELECT jsonb_build_object(
    'identity', jsonb_build_object(
      'user_id',              p_user_id,
      'player_number',        pr.player_number,
      'alias',                coalesce(nullif(btrim(pr.alias), ''),
                                       nullif(btrim(m.display_name), ''),
                                       nullif(btrim(pr.display_name), ''),
                                       pr.username),
      'username',             pr.username,
      'display_name',         coalesce(nullif(btrim(pr.display_name), ''), pr.username),
      'avatar_url',           coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url),
      'role',                 m.role,
      'role_rank',            coalesce(m.role_rank, 0),
      'nickname',             m.nickname,
      'remark',               m.notes,
      'last_login',           pr.last_login,
      'joined_at',            m.joined_at,
      'home_club_id',         m.club_id,
      'home_club_name',       cl.name,
      'upline_user_id',       m.agent_id,
      'upline_name',          up.up_name,
      'upline_player_number', up.up_number
    ),
    'presence', jsonb_build_object(
      'is_online', (s.seated IS NOT NULL)
                   OR (coalesce(pr.is_online, false)
                       AND pr.last_seen > now() - interval '5 minutes'),
      'is_seated', (s.seated IS NOT NULL)
    ),
    'wallets', jsonb_build_object(
      'chip_balance',  coalesce(m.chip_balance, 0),
      'player_wallet', coalesce(w.w_player, 0),
      'agent_wallet',  coalesce(w.w_agent, 0),
      'promo_wallet',  coalesce(w.w_promo, 0)
    ),
    'downline', jsonb_build_object(
      'downline_direct', coalesce(d.direct, 0),
      'downline_total',  coalesce(d.total, 0)
    ),
    'stats', jsonb_build_object(
      'hands',          coalesce(rl.hands, 0),
      'mtt_hands',      coalesce(rl.mtt_hands, 0),
      'total_fee',      round(coalesce(rl.fees, 0), 2),
      'mtt_fee',        round(coalesce(rl.mtt_fees, 0), 2),
      'total_winnings', round(coalesce(rl.net, 0), 2),
      'mtt_winnings',   round(coalesce(rl.mtt_net, 0), 2),
      'claimed_back',   round(coalesce(tx.claimed_back, 0), 2),
      'sent_out',       round(coalesce(tx.sent_out, 0), 2)
    ),
    'range', jsonb_build_object(
      'from',       p_from,
      'to',         p_to
    )
  ) INTO v_out
  FROM (SELECT 1) anchor
  LEFT JOIN mem m         ON true
  LEFT JOIN public.profiles pr ON pr.id = p_user_id
  LEFT JOIN public.clubs cl    ON cl.id = m.club_id
  LEFT JOIN seat s        ON true
  LEFT JOIN wal  w        ON true
  LEFT JOIN down d        ON true
  LEFT JOIN roll rl       ON true
  LEFT JOIN txn  tx       ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''),
                    nullif(btrim(u.display_name), ''),
                    u.username) AS up_name,
           u.player_number       AS up_number
    FROM public.profiles u WHERE u.id = m.agent_id
  ) up ON true;

  RETURN v_out;
END;
$fn$;
