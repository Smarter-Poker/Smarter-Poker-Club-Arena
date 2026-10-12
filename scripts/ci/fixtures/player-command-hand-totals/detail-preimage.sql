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
  ), roll AS MATERIALIZED (
    SELECT count(DISTINCT r.hand_id) FILTER (WHERE r.tournament_id IS NULL)::bigint AS hands,
           count(DISTINCT r.hand_id) FILTER (WHERE r.tournament_id IS NOT NULL)::bigint AS mtt_hands,
           coalesce(sum(r.rake_paid) FILTER (WHERE r.tournament_id IS NULL), 0) AS fees,
           coalesce(sum(r.rake_paid) FILTER (WHERE r.tournament_id IS NOT NULL), 0) AS mtt_fees,
           coalesce(sum(r.net) FILTER (WHERE r.tournament_id IS NULL), 0) AS net,
           coalesce(sum(r.net) FILTER (WHERE r.tournament_id IS NOT NULL), 0) AS mtt_net
      FROM public.ca_hand_facts r
     WHERE v_sensitive AND r.user_id = p_user_id AND r.club_id = p_club_id
       AND (v_ts_from IS NULL OR r.played_at >= v_ts_from)
       AND (v_ts_to IS NULL OR r.played_at < v_ts_to)
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
    SELECT coalesce(nullif(btrim(u.alias), ''), nullif(btrim(public.fn_arena_name(u.alias, u.username, u.display_name, u.first_name, u.last_name, u.full_name)), ''), u.username) AS up_name,
           u.player_number AS up_number
      FROM public.profiles u WHERE u.id = m.agent_id
  ) up ON true;

  RETURN v_out;
END;
$function$;
