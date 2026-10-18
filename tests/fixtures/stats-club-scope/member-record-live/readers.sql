CREATE OR REPLACE FUNCTION public.ca_club_member_detail(p_club_id uuid, p_user_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF NOT EXISTS (
    SELECT 1 FROM public.club_members cm
    LEFT JOIN public.profiles profile ON profile.id = cm.user_id
    WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
      AND coalesce(cm.status, 'approved') IN ('active', 'approved')
      AND profile.status IS DISTINCT FROM 'deleted'
  ) THEN
    RETURN jsonb_build_object('identity', jsonb_build_object('user_id', NULL));
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  WITH RECURSIVE mem AS MATERIALIZED (
    SELECT DISTINCT ON (cm.user_id)
           cm.user_id, cm.club_id, cm.role, cm.agent_id, cm.chip_balance,
           cm.promo_balance, cm.nickname, cm.notes, cm.display_name, cm.joined_at,
           public.fn_club_role_rank(cm.role) AS role_rank
      FROM public.club_members cm
     WHERE cm.user_id = p_user_id
       AND cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
     ORDER BY cm.user_id, public.fn_club_role_rank(cm.role) DESC, cm.joined_at ASC
  ), edges AS MATERIALIZED (
    SELECT DISTINCT cm.user_id AS child, cm.agent_id AS parent
      FROM public.club_members cm
     WHERE cm.club_id = p_club_id
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
      LEFT JOIN public.profiles downline_profile ON downline_profile.id = tree.child
     WHERE downline_profile.status IS DISTINCT FROM 'deleted'
  ), seat AS MATERIALIZED (
    SELECT 1 AS seated
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
       AND t.status IN ('waiting', 'running')
       AND (ts.club_id = p_club_id OR t.club_id = p_club_id) LIMIT 1
  ), member_wallet AS MATERIALIZED (
    SELECT sum(coalesce(cm.chip_balance, 0)) AS player_wallet,
           sum(coalesce(cm.promo_balance, 0)) AS member_promo
      FROM public.club_members cm
     WHERE v_sensitive AND cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND coalesce(cm.status, 'approved') IN ('active', 'approved')
  ), agent_wallet AS MATERIALIZED (
    SELECT sum(coalesce(a.agent_wallet_balance, 0)) AS agent_wallet,
           sum(coalesce(a.promo_wallet_balance, 0)) AS agent_promo
      FROM public.agents a
     WHERE v_sensitive AND a.user_id = p_user_id AND a.club_id = p_club_id
       AND coalesce(a.status, 'active') = 'active'
  ), ranged_roll AS MATERIALIZED (
    SELECT coalesce(sum(r.hands) FILTER (WHERE NOT r.is_mtt),0)::bigint AS hands,
           coalesce(sum(r.hands) FILTER (WHERE r.is_mtt),0)::bigint AS mtt_hands,
           coalesce(sum(r.fees) FILTER (WHERE NOT r.is_mtt),0) AS fees,
           coalesce(sum(r.fees) FILTER (WHERE r.is_mtt),0) AS mtt_fees,
           coalesce(sum(r.net) FILTER (WHERE NOT r.is_mtt),0) AS net,
           coalesce(sum(r.net) FILTER (WHERE r.is_mtt),0) AS mtt_net
      FROM public.club_member_daily_facts r
     WHERE v_sensitive AND NOT v_overall AND r.user_id = p_user_id AND r.club_id = p_club_id
       AND (p_from IS NULL OR r.played_on >= p_from)
       AND (p_to IS NULL OR r.played_on <= p_to)
  ), roll AS MATERIALIZED (
    SELECT hands,mtt_hands,fees,mtt_fees,net,mtt_net FROM ranged_roll WHERE NOT v_overall
    UNION ALL
    SELECT coalesce(t.hands,0),coalesce(t.mtt_hands,0),coalesce(t.fees,0),
           coalesce(t.mtt_fees,0),coalesce(t.net,0),coalesce(t.mtt_net,0)
    FROM (SELECT 1) anchor LEFT JOIN public.club_member_play_totals t
      ON t.club_id=p_club_id AND t.user_id=p_user_id
    WHERE v_sensitive AND v_overall
  ), ledger_fee AS MATERIALIZED (
    SELECT coalesce(sum(lf.cash_fees), 0) AS fees,
           coalesce(sum(lf.tournament_fees), 0) AS mtt_fees
      FROM public.ca_club_member_fee_totals(p_club_id, p_from, p_to, p_user_id) lf
     WHERE v_sensitive
  ), txn AS MATERIALIZED (
    SELECT coalesce(sum(ct.amount) FILTER (WHERE ct.to_user_id = p_user_id
             AND lower(coalesce(ct.transaction_type, '')) ~ '(rakeback|commission)'), 0) AS claimed_back,
           coalesce(sum(abs(ct.amount)) FILTER (WHERE ct.from_user_id = p_user_id
             AND lower(coalesce(ct.transaction_type, '')) ~ '(transfer|send|distribute)'), 0) AS sent_out
      FROM public.chip_transactions ct
     WHERE v_sensitive AND ct.club_id = p_club_id
       -- The player bound. Both FILTERs above already require one of these
       -- equalities; stating it here lets the planner use the two
       -- (club_id, <user>, created_at) indexes instead of reading the club.
       AND (ct.to_user_id = p_user_id OR ct.from_user_id = p_user_id)
       AND (v_ts_from IS NULL OR ct.created_at >= v_ts_from)
       AND (v_ts_to IS NULL OR ct.created_at < v_ts_to)
  )
  SELECT jsonb_build_object(
    'identity', jsonb_build_object(
      'user_id', p_user_id,
      'player_number', pr.player_number,
      'alias', coalesce(nullif(btrim(pr.alias), ''), nullif(btrim(m.display_name), ''),
                        nullif(btrim(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name)), ''), pr.username),
      'username', pr.username,
      'display_name', coalesce(nullif(btrim(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name)), ''), pr.username),
      'avatar_url', coalesce(nullif(pr.arena_avatar_url, ''), pr.avatar_url),
      'role', m.role,
      'role_rank', coalesce(m.role_rank, 0),
      'nickname', CASE WHEN v_sensitive THEN m.nickname END,
      'remark', CASE WHEN v_sensitive THEN m.notes END,
      'last_login', CASE WHEN v_sensitive THEN greatest(pr.last_login, pr.last_seen) END,
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
      'total_fee', round(coalesce(ledger.fees, 0), 2), 'mtt_fee', round(coalesce(ledger.mtt_fees, 0), 2),
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
  LEFT JOIN ledger_fee ledger ON true
  LEFT JOIN txn tx ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(nullif(btrim(u.alias), ''), nullif(btrim(public.fn_arena_name(u.alias, u.username, u.display_name, u.first_name, u.last_name, u.full_name)), ''), u.username) AS up_name,
           u.player_number AS up_number
      FROM public.profiles u WHERE u.id = m.agent_id
        AND u.status IS DISTINCT FROM 'deleted'
  ) up ON true;

  RETURN v_out;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(p_club_id uuid, p_user_id uuid, p_variant text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := NULLIF(lower(btrim(COALESCE(p_variant, ''))), '');
  v_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_viewer_is_member boolean;
  v_target_is_member boolean;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff','downline','service') THEN
    -- A member of the club asking about somebody who is not one is told so;
    -- anyone else is told only that they may not look.
    v_viewer_is_member := auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    v_target_is_member := EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', CASE WHEN v_viewer_is_member AND NOT v_target_is_member
                     THEN 'not_member' ELSE 'restricted' END);
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  WITH agg AS (
    SELECT coalesce(sum(f.hands),0)::bigint AS hands,
           coalesce(sum(f.wins),0)::bigint AS wins,
           coalesce(sum(f.vpip_hands),0)::bigint AS vpip_hands,
           coalesce(sum(f.pfr_hands),0)::bigint AS pfr_hands,
           coalesce(sum(f.tb_hands),0)::bigint AS tb_hands,
           coalesce(sum(f.faced_tb),0)::bigint AS faced_tb,
           coalesce(sum(f.folded_tb),0)::bigint AS folded_tb,
           coalesce(sum(f.cb_hands),0)::bigint AS cb_hands,
           coalesce(sum(f.cb_opps),0)::bigint AS cb_opps,
           coalesce(sum(f.fees),0) AS fees,
           coalesce(sum(f.net),0) AS net
      FROM public.club_member_daily_facts f
     WHERE f.club_id=p_club_id AND f.user_id=p_user_id
       AND (v_variant IS NULL OR v_variant='all' OR f.game_variant=v_variant)
       AND (p_from IS NULL OR f.played_on>=p_from)
       AND (p_to IS NULL OR f.played_on<=p_to)
  ), vars AS (
    SELECT coalesce(jsonb_agg(v.game_variant ORDER BY v.game_variant),'[]'::jsonb) AS list
      FROM (SELECT DISTINCT f.game_variant FROM public.club_member_daily_facts f
             WHERE f.club_id=p_club_id AND f.user_id=p_user_id
               AND f.game_variant IS NOT NULL AND f.hands>0) v
  )
  SELECT jsonb_build_object(
    'authorized', true, 'variant', COALESCE(v_variant,'all'), 'variants', vars.list,
    'hands', a.hands,
    'hands_won', a.wins,
    'win_rate', COALESCE(round(100.0*a.wins/NULLIF(a.hands,0),2),0),
    'vpip', COALESCE(round(100.0*a.vpip_hands/NULLIF(a.hands,0),2),0),
    'pfr',  COALESCE(round(100.0*a.pfr_hands/NULLIF(a.hands,0),2),0),
    -- 3-bets per hand dealt. Not per opportunity: the facts table does not
    -- record whether this player faced an open they could have 3-bet.
    'three_bet', COALESCE(round(100.0*a.tb_hands/NULLIF(a.hands,0),2),0),
    'three_bet_basis', 'hands',
    'three_bets', a.tb_hands,
    'fold_to_three_bet', COALESCE(round(100.0*a.folded_tb/NULLIF(a.faced_tb,0),2),0),
    'faced_three_bets', a.faced_tb,
    'cbet', COALESCE(round(100.0*a.cb_hands/NULLIF(a.cb_opps,0),2),0),
    'cbet_opportunities', a.cb_opps,
    'net', round(a.net,2), 'fees', round(a.fees,2),
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ca_club_member_win_loss(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_week date := date_trunc('week', v_today)::date;
  v_month date := date_trunc('month', v_today)::date;
  v_earliest date;
  v_cash_today numeric; v_cash_week numeric; v_cash_month numeric; v_cash_all numeric;
  v_mtt_today numeric; v_mtt_week numeric; v_mtt_month numeric; v_mtt_all numeric;
BEGIN
  IF v_access IS NULL OR v_access NOT IN ('staff', 'downline', 'service') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  -- A week that started last month reaches back past the 1st.
  v_earliest := least(v_week, v_month);

  SELECT coalesce(sum(f.net) FILTER (WHERE f.played_on = v_today), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_week), 0),
         coalesce(sum(f.net) FILTER (WHERE f.played_on >= v_month), 0)
    INTO v_cash_today, v_cash_week, v_cash_month
    FROM public.club_member_daily_facts f
   WHERE f.club_id = p_club_id AND f.user_id = p_user_id
     AND NOT f.is_mtt
     AND f.played_on >= v_earliest AND f.played_on <= v_today;

  SELECT coalesce(t.net, 0) INTO v_cash_all
    FROM (SELECT 1) anchor
    LEFT JOIN public.club_member_play_totals t
      ON t.club_id = p_club_id AND t.user_id = p_user_id;

  v_mtt_today := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_today::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_week := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_week::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_month := public.ca_club_member_tournament_money(
    p_club_id, p_user_id, v_month::timestamp AT TIME ZONE 'UTC', NULL);
  v_mtt_all := public.ca_club_member_tournament_money(p_club_id, p_user_id, NULL, NULL);

  RETURN jsonb_build_object(
    'as_of', v_today,
    'week_from', v_week,
    'month_from', v_month,
    'today', jsonb_build_object('cash', round(v_cash_today, 2), 'mtt', round(v_mtt_today, 2),
                                'net', round(v_cash_today + v_mtt_today, 2)),
    'week', jsonb_build_object('cash', round(v_cash_week, 2), 'mtt', round(v_mtt_week, 2),
                               'net', round(v_cash_week + v_mtt_week, 2)),
    'month', jsonb_build_object('cash', round(v_cash_month, 2), 'mtt', round(v_mtt_month, 2),
                                'net', round(v_cash_month + v_mtt_month, 2)),
    'overall', jsonb_build_object('cash', round(v_cash_all, 2), 'mtt', round(v_mtt_all, 2),
                                  'net', round(v_cash_all + v_mtt_all, 2))
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.ca_club_members_win_loss(p_club_id uuid, p_user_ids uuid[], p_period text DEFAULT 'overall'::text)
 RETURNS TABLE(user_id uuid, cash numeric, mtt numeric, net numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period text := lower(btrim(coalesce(p_period, 'overall')));
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from date;
BEGIN
  IF v_period NOT IN ('today', 'week', 'month', 'overall') THEN
    RAISE EXCEPTION 'Invalid win loss period' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_user_ids), 0) > 100 THEN
    RAISE EXCEPTION 'At most 100 members per call' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  v_from := CASE v_period
    WHEN 'today' THEN v_today
    WHEN 'week' THEN date_trunc('week', v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    ELSE NULL END;

  RETURN QUERY
  WITH asked AS (
    SELECT DISTINCT u AS uid FROM unnest(coalesce(p_user_ids, ARRAY[]::uuid[])) u WHERE u IS NOT NULL
  ), allowed AS (
    SELECT a.uid FROM asked a
     WHERE public.ca_club_roster_access(p_club_id, a.uid) IN ('staff', 'downline', 'service')
  ), cash AS (
    SELECT al.uid,
           CASE WHEN v_from IS NULL THEN
             (SELECT coalesce(t.net, 0) FROM (SELECT 1) anchor
                LEFT JOIN public.club_member_play_totals t
                  ON t.club_id = p_club_id AND t.user_id = al.uid)
           ELSE
             (SELECT coalesce(sum(f.net), 0) FROM public.club_member_daily_facts f
               WHERE f.club_id = p_club_id AND f.user_id = al.uid AND NOT f.is_mtt
                 AND f.played_on >= v_from AND f.played_on <= v_today)
           END AS cash_net
      FROM allowed al
  )
  SELECT c.uid,
         round(c.cash_net, 2),
         round(m.mtt_net, 2),
         round(c.cash_net + m.mtt_net, 2)
    FROM cash c
    CROSS JOIN LATERAL (
      SELECT public.ca_club_member_tournament_money(
        p_club_id, c.uid,
        CASE WHEN v_from IS NULL THEN NULL ELSE v_from::timestamp AT TIME ZONE 'UTC' END,
        NULL) AS mtt_net
    ) m;
END;
$function$
;
