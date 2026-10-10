-- Initialize from one facts/delta snapshot without locking the hot facts table.
-- Dated records and performance use the same exact retained facts and formulas.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='5min';
SELECT pg_advisory_xact_lock(hashtextextended('club_member_daily_facts_initialization',0));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND NOT initialized)
 THEN RAISE EXCEPTION 'Member daily facts already initialized or state is missing'; END IF;
 IF md5(pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure))<>'62621ac10a1dc33bcc5dbc44e5c87f60'
 OR md5(pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure))<>'fbdfb2174da3f0ab8ef59c46aa490b5e'
 THEN RAISE EXCEPTION 'Member detail/statistics source changed after qualification'; END IF;
END $$;
WITH facts AS MATERIALIZED (
 SELECT club_id,user_id,(played_at AT TIME ZONE 'UTC')::date AS played_on,
        lower(game_variant) AS game_variant,(tournament_id IS NOT NULL) AS is_mtt,
        sum(1)::bigint AS hands,
        sum(CASE WHEN net>0 THEN 1 ELSE 0 END)::bigint AS wins,
        sum(CASE WHEN vpip THEN 1 ELSE 0 END)::bigint AS vpip_hands,
        sum(CASE WHEN pfr THEN 1 ELSE 0 END)::bigint AS pfr_hands,
        sum(CASE WHEN three_bet THEN 1 ELSE 0 END)::bigint AS tb_hands,
        sum(CASE WHEN faced_three_bet THEN 1 ELSE 0 END)::bigint AS faced_tb,
        sum(CASE WHEN folded_to_three_bet THEN 1 ELSE 0 END)::bigint AS folded_tb,
        sum(CASE WHEN cbet_flop THEN 1 ELSE 0 END)::bigint AS cb_hands,
        sum(CASE WHEN had_cbet_flop_opp THEN 1 ELSE 0 END)::bigint AS cb_opps,
        sum(rake_paid) AS fees,
        sum(coalesce(net,0)) AS net
 FROM public.ca_hand_facts WHERE club_id IS NOT NULL
 GROUP BY club_id,user_id,(played_at AT TIME ZONE 'UTC')::date,lower(game_variant),(tournament_id IS NOT NULL)
), captured AS MATERIALIZED (
 SELECT * FROM public.club_member_daily_facts
), baseline AS MATERIALIZED (
 SELECT 
   coalesce(f.club_id,c.club_id) AS club_id,
   coalesce(f.user_id,c.user_id) AS user_id,
   coalesce(f.played_on,c.played_on) AS played_on,
   coalesce(f.game_variant,c.game_variant) AS game_variant,
   coalesce(f.is_mtt,c.is_mtt) AS is_mtt,
   coalesce(f.hands,0)-coalesce(c.hands,0) AS hands,
   coalesce(f.wins,0)-coalesce(c.wins,0) AS wins,
   coalesce(f.vpip_hands,0)-coalesce(c.vpip_hands,0) AS vpip_hands,
   coalesce(f.pfr_hands,0)-coalesce(c.pfr_hands,0) AS pfr_hands,
   coalesce(f.tb_hands,0)-coalesce(c.tb_hands,0) AS tb_hands,
   coalesce(f.faced_tb,0)-coalesce(c.faced_tb,0) AS faced_tb,
   coalesce(f.folded_tb,0)-coalesce(c.folded_tb,0) AS folded_tb,
   coalesce(f.cb_hands,0)-coalesce(c.cb_hands,0) AS cb_hands,
   coalesce(f.cb_opps,0)-coalesce(c.cb_opps,0) AS cb_opps,
   coalesce(f.fees,0)-coalesce(c.fees,0) AS fees,
   coalesce(f.net,0)-coalesce(c.net,0) AS net
 FROM facts f FULL JOIN captured c ON f.club_id=c.club_id AND f.user_id=c.user_id
   AND f.played_on IS NOT DISTINCT FROM c.played_on
   AND f.game_variant IS NOT DISTINCT FROM c.game_variant AND f.is_mtt=c.is_mtt
)
INSERT INTO public.club_member_daily_facts AS totals(club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net)
SELECT club_id,user_id,played_on,game_variant,is_mtt,hands,wins,vpip_hands,pfr_hands,tb_hands,faced_tb,folded_tb,cb_hands,cb_opps,fees,net FROM baseline ORDER BY club_id,user_id,played_on,game_variant,is_mtt
ON CONFLICT(club_id,user_id,played_on,game_variant,is_mtt) DO UPDATE SET
    hands=totals.hands+EXCLUDED.hands,
    wins=totals.wins+EXCLUDED.wins,
    vpip_hands=totals.vpip_hands+EXCLUDED.vpip_hands,
    pfr_hands=totals.pfr_hands+EXCLUDED.pfr_hands,
    tb_hands=totals.tb_hands+EXCLUDED.tb_hands,
    faced_tb=totals.faced_tb+EXCLUDED.faced_tb,
    folded_tb=totals.folded_tb+EXCLUDED.folded_tb,
    cb_hands=totals.cb_hands+EXCLUDED.cb_hands,
    cb_opps=totals.cb_opps+EXCLUDED.cb_opps,
    fees=totals.fees+EXCLUDED.fees,
    net=totals.net+EXCLUDED.net;
UPDATE public.club_member_daily_facts_state SET initialized=true WHERE singleton;
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
$function$;

REVOKE ALL ON FUNCTION public.ca_club_member_detail(uuid,uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_detail(uuid,uuid,date,date) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid,uuid,text,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid,uuid,text,date,date) TO authenticated,service_role;
COMMIT;
