-- Exact installed predecessor, retained for native compatibility qualification.
CREATE OR REPLACE FUNCTION public.ca_own_hand_history_by_club(p_club_id uuid, p_table_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(hand jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'ca_own_hand_history_by_club requires authentication' USING ERRCODE='42501';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'ca_own_hand_history_by_club requires a club' USING ERRCODE='22023';
  END IF;
  IF COALESCE((public.fn_poker_arena_context(p_club_id::text)->>'member')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'not authorized for hand-history club' USING ERRCODE='42501';
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
      'id',h.id,
      'created_at',h.created_at,
      'started_at',h.started_at,
      'table_id',h.table_id,
      'hand_number',h.hand_number,
      'pot_size',h.pot_size,
      'community_cards',h.community_cards,
      'community_cards2',h.community_cards2,
      'community_cards3',h.community_cards3,
      'rit_boards',h.rit_boards,
      'players',h.players,
      'actions',h.actions,
      'winners',h.winners,
      'winners_by_board',h.winners_by_board,
      'game_variant',h.game_variant,
      'small_blind',h.small_blind,
      'big_blind',h.big_blind,
      'rake_amount',h.rake_amount,
      'bbj_amount',h.bbj_amount,
      'button_seat',h.button_seat,
      -- This is the same participant-visible showdown-only field selected by
      -- the prior query; private folded cards remain only in own fact rows.
      'hole_cards',h.hole_cards,
      'showdown',h.showdown,
      'pots',h.pots,
      'bomb_pot',h.bomb_pot,
      'kill_pot',h.kill_pot
    ) AS hand
    FROM public.hand_history h
   WHERE (p_table_id IS NULL OR h.table_id=p_table_id)
     AND EXISTS (
       SELECT 1
         FROM public.ca_hand_facts f
        WHERE f.hand_id=h.id
          AND f.user_id=v_user
          AND f.club_id=p_club_id
     )
   ORDER BY h.hand_number DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),200)
  OFFSET LEAST(GREATEST(COALESCE(p_offset,0),0),1000000);
END
$function$
;

-- Exact installed overview predecessors, including funded-club and retained coverage fixes.
CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
  v_base jsonb; v_overall jsonb; v_daily jsonb; v_tournaments jsonb; v_recent jsonb;
  v_analysis jsonb; v_recorded_fact_rates jsonb;
  v_total integer; v_cash integer; v_tourney integer; v_won integer;
  v_vpip integer; v_pfr integer; v_profit numeric; v_returned numeric;
  v_invested numeric; v_net_bb numeric; v_biggest numeric; v_loss numeric;
  v_first timestamptz; v_last timestamptz; v_exact_cash integer;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %',p_asset USING ERRCODE='22023';
  END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at
    INTO v_days,v_tz,v_from,v_to FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  v_base := public.ca_player_stats_full(p_user,v_days,v_tz,p_asset);

  WITH source_rows AS MATERIALIZED (
    SELECT s.hand_id,s.created_at,s.is_cash,s.tournament_id,coalesce(f.returned>0,s.is_winner) AS is_winner,coalesce(f.vpip,s.vpip) AS vpip,coalesce(f.pfr,s.pfr) AS pfr,
      f.three_bet fact_three_bet,f.three_bet_opportunity,f.cbet_flop,f.cbet_flop_opportunity,
      f.faced_three_bet,f.folded_to_three_bet,f.saw_flop,f.went_to_showdown,f.won_at_showdown,f.af_bet_raise_actions,f.af_call_actions,
      coalesce(f.net,s.profit) net,coalesce(f.returned,s.won_amt) returned,
      coalesce(f.invested,s.invested_actions+s.my_blind) invested,
      coalesce(f.net_bb,s.profit/nullif(s.big_blind,0)) net_bb,(f.hand_id IS NOT NULL) exact
    FROM public.ca_hand_player_stat s
    LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,(f.tournament_id IS NULL),f.tournament_id,(f.returned>0),f.vpip,f.pfr,
      f.three_bet,f.three_bet_opportunity,f.cbet_flop,f.cbet_flop_opportunity,
      f.faced_three_bet,f.folded_to_three_bet,f.saw_flop,f.went_to_showdown,f.won_at_showdown,f.af_bet_raise_actions,f.af_call_actions,
      f.net,f.returned,f.invested,f.net_bb,true
    FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  ), recorded_coverage AS MATERIALIZED (SELECT public.ca_player_recorded_hand_coverage(p_user,coalesce(jsonb_agg(jsonb_build_object('hand_id',hand_id,'is_cash',is_cash,'bets',af_bet_raise_actions,'calls',af_call_actions)),'[]'::jsonb),v_from,v_to) m FROM source_rows)
  SELECT count(*)::integer,count(*) FILTER(WHERE is_cash)::integer,
    count(*) FILTER(WHERE NOT is_cash)::integer,count(*) FILTER(WHERE is_winner)::integer,
    count(*) FILTER(WHERE vpip)::integer,count(*) FILTER(WHERE pfr)::integer,
    coalesce(sum(net) FILTER(WHERE is_cash),0),coalesce(sum(returned) FILTER(WHERE is_cash),0),
    coalesce(sum(invested) FILTER(WHERE is_cash),0),coalesce(sum(net_bb) FILTER(WHERE is_cash),0),
    coalesce(max(returned) FILTER(WHERE is_cash),0),coalesce(min(net) FILTER(WHERE is_cash),0),
    min(created_at),max(created_at),count(*) FILTER(WHERE is_cash AND exact)::integer,
    jsonb_build_object(
      'three_bet_percent',coalesce(round(count(*) FILTER(WHERE fact_three_bet AND three_bet_opportunity)::numeric/nullif(count(*) FILTER(WHERE three_bet_opportunity),0),4),0),
      'cbet_flop',coalesce(round(count(*) FILTER(WHERE cbet_flop AND cbet_flop_opportunity)::numeric/nullif(count(*) FILTER(WHERE cbet_flop_opportunity),0),4),0),
      'fold_to_three_bet',coalesce(round(count(*) FILTER(WHERE folded_to_three_bet)::numeric/nullif(count(*) FILTER(WHERE faced_three_bet),0),4),0),
      'wtsd',coalesce(round(count(*) FILTER(WHERE went_to_showdown)::numeric/nullif(count(*) FILTER(WHERE saw_flop),0),4),0),
      'showdowns_total',count(*) FILTER(WHERE went_to_showdown),
      'showdowns_won',count(*) FILTER(WHERE won_at_showdown),
      'tournaments_with_hands',count(DISTINCT tournament_id),
      'recorded_hand_coverage',(SELECT m->'recorded_coverage' FROM recorded_coverage),'cash_hours_played',(SELECT (m->>'cash_hours_played')::numeric FROM recorded_coverage),'hours_played',(SELECT (m->>'hours_played')::numeric FROM recorded_coverage),'aggression_factor',(SELECT (m->>'aggression_factor')::numeric FROM recorded_coverage),
      'metric_availability',jsonb_build_object(
        'three_bet_percent',count(*) FILTER(WHERE three_bet_opportunity)>0,
        'three_bet_numerator',count(*) FILTER(WHERE fact_three_bet AND three_bet_opportunity),
        'three_bet_opportunities',count(*) FILTER(WHERE three_bet_opportunity),
        'cbet_flop',count(*) FILTER(WHERE cbet_flop_opportunity)>0,
        'cbet_flop_opportunities',count(*) FILTER(WHERE cbet_flop_opportunity),
        'fold_to_three_bet',count(*) FILTER(WHERE faced_three_bet)>0,
        'fold_to_three_bet_opportunities',count(*) FILTER(WHERE faced_three_bet),
        'wtsd',count(*) FILTER(WHERE saw_flop)>0,
        'wtsd_opportunities',count(*) FILTER(WHERE saw_flop),
        'aggression_factor',(SELECT (m#>>'{metric_availability,aggression_factor}')::boolean FROM recorded_coverage),
        'aggression_factor_denominator',(SELECT (m#>>'{metric_availability,aggression_factor_denominator}')::numeric FROM recorded_coverage),
        'cash_hours_played',(SELECT (m#>>'{metric_availability,cash_hours_played}')::boolean FROM recorded_coverage),'hours_played',(SELECT (m#>>'{metric_availability,hours_played}')::boolean FROM recorded_coverage)))
  INTO v_total,v_cash,v_tourney,v_won,v_vpip,v_pfr,v_profit,v_returned,
    v_invested,v_net_bb,v_biggest,v_loss,v_first,v_last,v_exact_cash,v_recorded_fact_rates FROM source_rows;

  v_overall := coalesce(v_base->'overall','{}'::jsonb)||jsonb_build_object(
    'total_hands',v_total,'cash_hands',v_cash,'exact_cash_hands',v_exact_cash,
    'tourney_hands',v_tourney,'hands_won',v_won,'hands_lost',v_total-v_won,
    'vpip',coalesce(round(v_vpip::numeric/nullif(v_total,0),4),0),
    'pfr',coalesce(round(v_pfr::numeric/nullif(v_total,0),4),0),
    'total_profit',round(v_profit,2),'total_winnings',round(v_returned,2),
    'total_invested',round(v_invested,2),'biggest_pot_won',round(v_biggest,2),
    'biggest_hand_loss',round(v_loss,2),
    'bb_per_100',coalesce(round(v_net_bb/nullif(v_cash,0)*100,2),0),
    'hands_capped',false,'first_hand_at',v_first,'last_hand_at',v_last);
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',d,'hands',hands,'profit',profit) ORDER BY d),'[]'::jsonb)
  INTO v_daily FROM (WITH source_rows AS (
    SELECT s.hand_id,s.created_at,coalesce(f.net,s.profit) net
    FROM public.ca_hand_player_stat s
    LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.is_cash AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,f.net FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND f.tournament_id IS NULL AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  ) SELECT date(created_at AT TIME ZONE v_tz) d,count(*)::integer hands,round(sum(net),2) profit
    FROM source_rows GROUP BY 1) x;
  WITH tr AS MATERIALIZED (
    SELECT tp.*,t.name,t.start_time,t.ended_at,t.variant,t.buy_in_amount,t.buy_in_fee,
      t.rebuy_cost,t.addon_cost,t.is_mystery_bounty
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
  ), totals AS (
    SELECT count(*)::integer entries,count(*) FILTER(WHERE coalesce(prize,0)>0)::integer cashes,
      count(*) FILTER(WHERE position=1 OR status='winner')::integer wins,
      min(position) FILTER(WHERE position IS NOT NULL) best_finish,coalesce(sum(coalesce(bounties_collected,0)),0)::integer total_bounties,
      coalesce(sum(coalesce(buy_in_amount,0)+coalesce(buy_in_fee,0)+coalesce(rebuys,0)*coalesce(rebuy_cost,0)+CASE WHEN add_on THEN coalesce(addon_cost,0) ELSE 0 END),0) buyins,
      coalesce(sum(coalesce(prize,0)),0) prizes,coalesce(sum(coalesce(bounty_winnings,0)),0) bounties
    FROM tr
  ) SELECT jsonb_build_object('entries',entries,'cashes',cashes,'wins',wins,'best_finish',best_finish,
      'itm_percent',coalesce(round(cashes::numeric/nullif(entries,0),4),0),'total_buyins',round(buyins,2),
      'total_winnings',round(prizes+bounties,2),'total_prizes',round(prizes,2),
      'total_bounty_winnings',round(bounties,2),'total_bounties',total_bounties,'net_profit',round(prizes+bounties-buyins,2),
      'roi',coalesce(round((prizes+bounties-buyins)/nullif(buyins,0),4),0))
    INTO v_tournaments FROM totals;
  WITH tr AS (
    SELECT tp.tournament_id,t.name,t.start_time,t.ended_at,t.variant,
      coalesce(t.is_mystery_bounty,false) is_mystery_bounty,tp.position AS finish_rank,tp.status,
      coalesce(tp.prize,0) prize,coalesce(tp.bounty_winnings,0) bounty_winnings,
      coalesce(tp.bounties_collected,0) bounties,
      coalesce(tp.prize,0)+coalesce(tp.bounty_winnings,0) total_won,
      coalesce(t.buy_in_amount,0)+coalesce(t.buy_in_fee,0)
        +coalesce(tp.rebuys,0)*coalesce(t.rebuy_cost,0)
        +CASE WHEN tp.add_on THEN coalesce(t.addon_cost,0) ELSE 0 END buyin
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
    ORDER BY t.ended_at DESC LIMIT 25
  ) SELECT coalesce(jsonb_agg(to_jsonb(tr) ORDER BY ended_at DESC),'[]'::jsonb) INTO v_recent FROM tr;
  -- The legacy full RPC uses a rolling clock cutoff. Rebuild every capped
  -- analysis section from the same validated calendar population as the
  -- headline so one range label never describes two different windows.
  WITH source_rows AS MATERIALIZED (
    SELECT s.hand_id,s.created_at,s.is_cash,s.game_variant,s.big_blind,s.seat_position position,
      coalesce(f.returned>0,s.is_winner) AS is_winner,coalesce(f.vpip,s.vpip) AS vpip,coalesce(f.pfr,s.pfr) AS pfr,coalesce(f.net,s.profit) net,
      coalesce(f.invested,s.invested_actions+s.my_blind) invested,
      coalesce(f.net_bb,s.profit/nullif(s.big_blind,0)) net_bb
    FROM public.ca_hand_player_stat s LEFT JOIN public.ca_hand_facts f ON f.hand_id=s.hand_id AND f.user_id=s.user_id
    WHERE s.user_id=p_user AND s.asset=p_asset
      AND (v_from IS NULL OR s.created_at>=v_from) AND (v_to IS NULL OR s.created_at<v_to)
    UNION ALL
    SELECT f.hand_id,f.played_at,(f.tournament_id IS NULL),f.game_variant,f.big_blind,f.position,
      (f.returned>0),f.vpip,f.pfr,f.net,f.invested,f.net_bb
    FROM public.ca_hand_facts f JOIN public.clubs c ON c.id=f.club_id
    WHERE f.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND (v_from IS NULL OR f.played_at>=v_from) AND (v_to IS NULL OR f.played_at<v_to)
      AND NOT EXISTS (SELECT 1 FROM public.ca_hand_player_stat s WHERE s.user_id=f.user_id AND s.hand_id=f.hand_id)
  ), scored AS MATERIALIZED (SELECT * FROM source_rows ORDER BY created_at DESC LIMIT 750),
  positions AS (SELECT position,count(*)::integer hands_played,count(*) FILTER(WHERE vpip)::integer vpip_count,
    count(*) FILTER(WHERE pfr)::integer pfr_count,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(coalesce(sum(net) FILTER(WHERE is_cash),0),2) total_profit,
    coalesce(round(sum(net_bb) FILTER(WHERE is_cash)/nullif(count(*) FILTER(WHERE is_cash),0)*100,2),0) bb100
    FROM scored GROUP BY position),
  variants AS (SELECT game_variant variant,count(*)::integer hands,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(coalesce(sum(net) FILTER(WHERE is_cash),0),2) profit,
    coalesce(round(sum(net_bb) FILTER(WHERE is_cash)/nullif(count(*) FILTER(WHERE is_cash),0)*100,2),0) bb100
    FROM scored GROUP BY game_variant),
  stakes AS (SELECT big_blind,count(*)::integer hands,count(*) FILTER(WHERE is_winner)::integer hands_won,
    round(sum(net),2) profit,coalesce(round(sum(net_bb)/nullif(count(*),0)*100,2),0) bb100
    FROM scored WHERE is_cash AND big_blind>0 GROUP BY big_blind),
  marked AS (SELECT *,CASE WHEN created_at-lag(created_at) OVER(ORDER BY created_at)>interval '45 minutes'
    OR lag(created_at) OVER(ORDER BY created_at) IS NULL THEN 1 ELSE 0 END new_session FROM scored WHERE is_cash),
  grouped AS (SELECT *,sum(new_session) OVER(ORDER BY created_at) session_no FROM marked),
  sessions AS (SELECT session_no,min(created_at) started,max(created_at) ended,count(*)::integer hands,
    round(sum(net),2) profit,round(sum(invested),2) invested FROM grouped GROUP BY session_no ORDER BY session_no DESC LIMIT 50)
  SELECT jsonb_build_object(
    'positions',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY position) FROM positions p),'[]'::jsonb),
    'variants',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY hands DESC) FROM variants v),'[]'::jsonb),
    'stakes',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY big_blind DESC) FROM stakes s),'[]'::jsonb),
    'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',session_no,'date',started,'ended',ended,
      'duration_minutes',greatest(1,round(extract(epoch FROM (ended-started))/60)::integer),
      'hands_played',hands,'buy_in',invested,'cash_out',round(invested+profit,2),'profit_loss',profit)
      ORDER BY session_no DESC) FROM sessions),'[]'::jsonb)) INTO v_analysis;
  RETURN v_base||jsonb_build_object('contract_version',2,'generated_at',now(),'window_days',v_days,
    'window_tz',v_tz,'scope',jsonb_build_object('target_user_id',p_user,'club_id',NULL,
      'asset',p_asset,'range_days',v_days,'range_tz',v_tz,'visibility','owner'),
    'overall',v_overall||(v_recorded_fact_rates-'metric_availability'-'recorded_hand_coverage'),'daily',v_daily,'positions',v_analysis->'positions',
    'variants',v_analysis->'variants','stakes',v_analysis->'stakes','sessions',v_analysis->'sessions',
    'tournaments',v_tournaments,'recent_tournaments',v_recent,
    'coverage',coalesce(v_base->'coverage','{}'::jsonb)||jsonb_build_object(
      'analysis_hand_cap',750,'analysis_sample_hands',least(v_total,750),
      'analysis_hands_capped',v_total>750),
    'quality',coalesce(v_base->'quality','{}'::jsonb)||jsonb_build_object(
      'cash_money_source',CASE WHEN v_cash=0 OR v_exact_cash=v_cash THEN 'exact_settlement'
        WHEN v_exact_cash=0 THEN 'reconstructed_actions' ELSE 'mixed' END,
      'cash_money_exact',(v_cash=0 OR v_exact_cash=v_cash),'exact_cash_hands',v_exact_cash,
      'advanced_facts_source','ca_hand_facts','recorded_hand_coverage',v_recorded_fact_rates->'recorded_hand_coverage','metric_availability',v_recorded_fact_rates->'metric_availability'));
END;$function$;
CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2_by_club(p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '20s'
 SET work_mem TO '64MB'
 SET enable_indexscan TO 'off'
 SET search_path TO 'public'
AS $function$
DECLARE
  c_analysis_cap constant integer := 750;
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days, 1), 3650) END;
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END;
  v_from timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    (((now() AT TIME ZONE v_tz)::date - (v_days - 1))::timestamp AT TIME ZONE v_tz) END;
  v_to timestamptz := CASE WHEN v_days IS NULL THEN NULL ELSE
    ((((now() AT TIME ZONE v_tz)::date + 1)::timestamp) AT TIME ZONE v_tz) END;
  v_first timestamptz;
  v_last timestamptz;
  v_lifetime integer;
BEGIN
  -- funded_stats_scope: historical funding, original caller gates.
  PERFORM public.ca_assert_player_stats_club(p_user, p_club_id, p_asset);



  RETURN (
    WITH funded_stats_scope AS MATERIALIZED (SELECT hand_id,user_id,played_at,tournament_id,game_variant,big_blind,position,invested,returned,net,net_bb,vpip,pfr,three_bet,three_bet_opportunity,cbet_flop_opportunity,faced_three_bet,folded_to_three_bet,had_cbet_flop_opp,cbet_flop,saw_flop,went_to_showdown,won_at_showdown,aggressive_actions,passive_actions,af_bet_raise_actions,af_call_actions,funded_club FROM (
 WITH receipts AS MATERIALIZED (
  SELECT DISTINCT ON(table_id,account_entity_id,seat_joined_at)
   table_id,account_entity_id,seat_joined_at,funding_club_id
  FROM public.cash_participant_funding_receipts
  WHERE account_entity_id=p_user AND operation_kind='buyin'
  ORDER BY table_id,account_entity_id,seat_joined_at,recorded_at DESC,id DESC
 ), funding AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) until_at
  FROM receipts
 )
 SELECT fact.*,coalesce(x.funding_club_id,tp.club_id,ra.club_id,fact.club_id) funded_club
 FROM public.ca_hand_facts fact
 LEFT JOIN funding x ON fact.tournament_id IS NULL AND x.table_id=fact.table_id
  AND fact.played_at>=x.seat_joined_at AND (x.until_at IS NULL OR fact.played_at<x.until_at)
 LEFT JOIN public.tournament_players tp ON tp.tournament_id=fact.tournament_id AND tp.user_id=fact.user_id
 LEFT JOIN public.rake_attributions ra ON x.funding_club_id IS NULL AND tp.club_id IS NULL
  AND ra.hand_id=fact.hand_id AND ra.player_id=fact.user_id
 WHERE fact.user_id=p_user
 ) resolved), coverage_totals AS (SELECT count(*)::integer total,min(played_at) first_at,max(played_at) last_at FROM funded_stats_scope WHERE funded_club=p_club_id), filtered AS MATERIALIZED (
      SELECT f.*
      FROM funded_stats_scope f
      WHERE f.user_id = p_user
        AND f.funded_club = p_club_id
        AND (v_from IS NULL OR f.played_at >= v_from)
        AND (v_to IS NULL OR f.played_at < v_to)
    ), recorded_coverage AS MATERIALIZED (SELECT public.ca_player_recorded_hand_coverage(p_user,coalesce(jsonb_agg(jsonb_build_object('hand_id',hand_id,'is_cash',tournament_id IS NULL,'bets',af_bet_raise_actions,'calls',af_call_actions)),'[]'::jsonb),v_from,v_to) m FROM filtered), scored AS MATERIALIZED (
      SELECT * FROM filtered ORDER BY played_at DESC LIMIT c_analysis_cap
    ), totals AS (
      SELECT count(*)::integer hands,
        count(*) FILTER (WHERE tournament_id IS NULL)::integer cash_hands,
        count(*) FILTER (WHERE tournament_id IS NOT NULL)::integer tourney_hands,
        count(DISTINCT tournament_id) FILTER (WHERE tournament_id IS NOT NULL)::integer tournaments_with_hands,
        count(*) FILTER (WHERE returned > 0)::integer hands_won,
        count(*) FILTER (WHERE vpip)::integer vpip_hands,
        count(*) FILTER (WHERE pfr)::integer pfr_hands,
        count(*) FILTER (WHERE three_bet AND three_bet_opportunity)::integer three_bet_hands,
        count(*) FILTER (WHERE three_bet_opportunity)::integer recorded_three_bet_opportunities,
        count(*) FILTER (WHERE faced_three_bet)::integer faced_three_bet_hands,
        count(*) FILTER (WHERE folded_to_three_bet)::integer folded_to_three_bet_hands,
        count(*) FILTER (WHERE cbet_flop_opportunity)::integer cbet_opps,
        count(*) FILTER (WHERE cbet_flop AND cbet_flop_opportunity)::integer cbet_hands,
        coalesce(sum(af_bet_raise_actions), 0)::integer aggro,
        count(*) FILTER(WHERE af_bet_raise_actions IS NOT NULL AND af_call_actions IS NOT NULL)::integer af_measured_hands,
        coalesce(sum(af_call_actions), 0)::integer passive,
        count(*) FILTER (WHERE saw_flop)::integer saw_flop_hands,
        count(*) FILTER (WHERE went_to_showdown)::integer showdowns,
        count(*) FILTER (WHERE won_at_showdown)::integer showdowns_won,
        coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0) cash_profit,
        coalesce(sum(returned) FILTER (WHERE tournament_id IS NULL), 0) cash_won,
        coalesce(sum(invested) FILTER (WHERE tournament_id IS NULL), 0) cash_invested,
        coalesce(max(returned) FILTER (WHERE tournament_id IS NULL), 0) biggest_pot,
        coalesce(min(net) FILTER (WHERE tournament_id IS NULL), 0) biggest_loss,
        coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0) cash_net_bb,
        min(played_at) first_hand_at, max(played_at) last_hand_at
      FROM filtered
    ), analysis_sample AS (
      SELECT count(*)::integer hands FROM scored
    ), daily AS (
      SELECT date(played_at AT TIME ZONE v_tz) d, count(*)::integer hands,
             round(sum(net), 2) profit
      FROM filtered WHERE tournament_id IS NULL GROUP BY 1 ORDER BY 1
    ), positions AS (
      SELECT position, count(*)::integer hands_played,
        count(*) FILTER (WHERE vpip)::integer vpip_count,
        count(*) FILTER (WHERE pfr)::integer pfr_count,
        count(*) FILTER (WHERE three_bet AND three_bet_opportunity)::integer three_bet_count,
        count(*) FILTER (WHERE three_bet_opportunity)::integer three_bet_opps,
        count(*) FILTER (WHERE returned > 0)::integer hands_won,
        round(coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0), 2) total_profit,
        round(coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0)
          / nullif(count(*) FILTER (WHERE tournament_id IS NULL), 0) * 100, 2) bb100
      FROM scored GROUP BY position
    ), variants AS (
      SELECT game_variant, count(*)::integer hands,
        count(*) FILTER (WHERE returned > 0)::integer hands_won,
        round(coalesce(sum(net) FILTER (WHERE tournament_id IS NULL), 0), 2) profit,
        round(coalesce(sum(net_bb) FILTER (WHERE tournament_id IS NULL), 0)
          / nullif(count(*) FILTER (WHERE tournament_id IS NULL), 0) * 100, 2) bb100
      FROM scored GROUP BY game_variant
    ), stakes AS (
      SELECT big_blind, count(*)::integer hands,
        count(*) FILTER (WHERE returned > 0)::integer hands_won,
        round(sum(net), 2) profit,
        round(sum(net_bb) / nullif(count(*), 0) * 100, 2) bb100
      FROM scored WHERE tournament_id IS NULL AND big_blind > 0 GROUP BY big_blind
    ), tournament_rows AS (
      SELECT tp.*, t.name, t.start_time, t.ended_at, t.variant, t.buy_in_amount, t.buy_in_fee,
             t.rebuy_cost, t.addon_cost, t.is_mystery_bounty
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
      WHERE tp.user_id = p_user AND coalesce(tp.club_id,t.club_id) = p_club_id
        AND upper(coalesce(t.status, '')) = 'COMPLETED'
        AND t.ended_at IS NOT NULL
        AND (v_from IS NULL OR t.ended_at >= v_from)
        AND (v_to IS NULL OR t.ended_at < v_to)
    ), tournament_totals AS (
      SELECT count(*)::integer entries,
        count(*) FILTER (WHERE coalesce(prize, 0) > 0)::integer cashes,
        count(*) FILTER (WHERE position = 1 OR status = 'winner')::integer wins,
        min(position) FILTER (WHERE position IS NOT NULL) best_finish,
        coalesce(sum(coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)
          + coalesce(rebuys, 0) * coalesce(rebuy_cost, 0)
          + CASE WHEN add_on THEN coalesce(addon_cost, 0) ELSE 0 END), 0) total_buyins,
        coalesce(sum(coalesce(prize, 0)), 0) total_prizes,
        coalesce(sum(coalesce(bounty_winnings, 0)), 0) total_bounty_winnings,
        coalesce(sum(coalesce(bounties_collected, 0)), 0)::integer total_bounties
      FROM tournament_rows
    )
    SELECT jsonb_build_object(
      'contract_version', 2, 'generated_at', now(), 'window_days', v_days, 'window_tz', v_tz,
      'scope', jsonb_build_object('target_user_id', p_user, 'club_id', p_club_id,
        'asset', p_asset, 'range_days', v_days, 'range_tz', v_tz, 'visibility', 'owner'),
      'quality', jsonb_build_object('cash_money_source', 'exact_settlement',
        'cash_money_exact', true, 'exact_cash_hands', (SELECT cash_hands FROM totals),
        'advanced_facts_source', 'ca_hand_facts',
        'historical_club_breakdown_available', false,
        'club_breakdown_available', true, 'club_breakdown_source', 'ca_hand_facts',
        'club_breakdown_starts_at', (SELECT first_at FROM coverage_totals), 'live_tail_included', true,
        'section_availability', jsonb_build_object(
          'sessions', false,
          'sessions_reason', 'not_captured_in_ca_hand_facts'
        ),
        'recorded_hand_coverage', (SELECT m->'recorded_coverage' FROM recorded_coverage), 'metric_availability', (SELECT jsonb_build_object(
          'three_bet_percent', recorded_three_bet_opportunities > 0,
          'three_bet_numerator', three_bet_hands,
          'three_bet_opportunities', recorded_three_bet_opportunities,
          'fold_to_three_bet', faced_three_bet_hands > 0,
          'fold_to_three_bet_opportunities', faced_three_bet_hands,
          'cbet_flop', cbet_opps > 0,
          'cbet_flop_opportunities', cbet_opps,
          'aggression_factor', (SELECT (m#>>'{metric_availability,aggression_factor}')::boolean FROM recorded_coverage),
          'aggression_factor_denominator', (SELECT (m#>>'{metric_availability,aggression_factor_denominator}')::numeric FROM recorded_coverage),
          'wtsd', saw_flop_hands > 0,
          'wtsd_opportunities', saw_flop_hands,
          'cash_hours_played', (SELECT (m#>>'{metric_availability,cash_hours_played}')::boolean FROM recorded_coverage),'hours_played', (SELECT (m#>>'{metric_availability,hours_played}')::boolean FROM recorded_coverage)
        ) FROM totals)),
      'coverage', jsonb_build_object('analysis_hand_cap', c_analysis_cap,
        'analysis_sample_hands', (SELECT hands FROM analysis_sample),
        'analysis_hands_capped', (SELECT hands FROM totals) > c_analysis_cap,
        'lifetime_index_complete', true, 'first_hand_at', (SELECT first_at FROM coverage_totals), 'last_hand_at', (SELECT last_at FROM coverage_totals),
        'rollup_covered_through', (SELECT last_at FROM coverage_totals), 'rollup_updated_at', now()),
      'lifetime', jsonb_build_object('hands', (SELECT total FROM coverage_totals), 'first_hand_at', (SELECT first_at FROM coverage_totals),
        'last_hand_at', (SELECT last_at FROM coverage_totals), 'indexed_complete', true),
      'overall', (SELECT jsonb_build_object(
        'total_hands', hands, 'cash_hands', cash_hands, 'exact_cash_hands', cash_hands,
        'tourney_hands', tourney_hands, 'tournaments_with_hands', tournaments_with_hands,
        'hands_won', hands_won, 'hands_lost', hands - hands_won,
        'vpip', coalesce(round(vpip_hands::numeric / nullif(hands, 0), 4), 0),
        'pfr', coalesce(round(pfr_hands::numeric / nullif(hands, 0), 4), 0),
        -- ca_hand_facts does not retain the three-bet-opportunity flag. A
        -- per-hand denominator would manufacture a tracker statistic, so the
        -- compatible numeric field is zero and quality.metric_availability
        -- says it was not measured.
        'three_bet_percent', coalesce(round(three_bet_hands::numeric / nullif(recorded_three_bet_opportunities,0),4),0),
        'fold_to_three_bet', coalesce(round(folded_to_three_bet_hands::numeric / nullif(faced_three_bet_hands, 0), 4), 0),
        'cbet_flop', coalesce(round(cbet_hands::numeric / nullif(cbet_opps, 0), 4), 0),
        -- An action count is not a ratio. Zero passive actions means AF is
        -- unmeasured/infinite; keep the legacy numeric shape at zero and make
        -- availability explicit in quality.metric_availability.
        'aggression_factor', (SELECT (m->>'aggression_factor')::numeric FROM recorded_coverage),
        'showdowns_total', showdowns, 'showdowns_won', showdowns_won,
        'wtsd', coalesce(round(showdowns::numeric / nullif(saw_flop_hands, 0), 4), 0),
        'total_profit', round(cash_profit, 2), 'total_winnings', round(cash_won, 2),
        'total_invested', round(cash_invested, 2), 'biggest_pot_won', round(biggest_pot, 2),
        'biggest_hand_loss', round(biggest_loss, 2),
        'bb_per_100', coalesce(round(cash_net_bb / nullif(cash_hands, 0) * 100, 2), 0),
        'cash_hours_played', (SELECT (m->>'cash_hours_played')::numeric FROM recorded_coverage),'hours_played', (SELECT (m->>'hours_played')::numeric FROM recorded_coverage), 'hand_cap', c_analysis_cap, 'hands_capped', false,
        'first_hand_at', first_hand_at, 'last_hand_at', last_hand_at) FROM totals),
      'daily', coalesce((SELECT jsonb_agg(jsonb_build_object('date', d, 'hands', hands, 'profit', profit) ORDER BY d) FROM daily), '[]'::jsonb),
      'sessions', '[]'::jsonb,
      'positions', coalesce((SELECT jsonb_agg(jsonb_build_object('position', position,
        'hands_played', hands_played, 'vpip_count', vpip_count, 'pfr_count', pfr_count,
        'three_bet_count', three_bet_count, 'three_bet_opps', three_bet_opps, 'hands_won', hands_won,
        'total_profit', total_profit, 'bb100', coalesce(bb100, 0))) FROM positions), '[]'::jsonb),
      'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('variant', game_variant,
        'hands', hands, 'hands_won', hands_won, 'profit', profit, 'bb100', coalesce(bb100, 0))) FROM variants), '[]'::jsonb),
      'stakes', coalesce((SELECT jsonb_agg(jsonb_build_object('big_blind', big_blind,
        'hands', hands, 'hands_won', hands_won, 'profit', profit, 'bb100', bb100)) FROM stakes), '[]'::jsonb),
      'tournaments', (SELECT jsonb_build_object('entries', entries, 'cashes', cashes,
        'wins', wins, 'best_finish', best_finish,
        'itm_percent', coalesce(round(cashes::numeric / nullif(entries, 0), 4), 0),
        'total_buyins', round(total_buyins, 2),
        'total_winnings', round(total_prizes + total_bounty_winnings, 2),
        'total_prizes', round(total_prizes, 2),
        'total_bounty_winnings', round(total_bounty_winnings, 2),
        'total_bounties', total_bounties,
        'net_profit', round(total_prizes + total_bounty_winnings - total_buyins, 2),
        'roi', coalesce(round((total_prizes + total_bounty_winnings - total_buyins) / nullif(total_buyins, 0), 4), 0)) FROM tournament_totals),
      'recent_tournaments', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'tournament_id', tournament_id, 'name', name, 'start_time', start_time,
        'ended_at', ended_at,
        'variant', variant, 'is_mystery_bounty', coalesce(is_mystery_bounty, false),
        'finish_rank', position, 'status', status, 'prize', coalesce(prize, 0),
        'bounty_winnings', coalesce(bounty_winnings, 0),
        'bounties', coalesce(bounties_collected, 0),
        'total_won', coalesce(prize, 0) + coalesce(bounty_winnings, 0),
        'buyin', coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)
          + coalesce(rebuys, 0) * coalesce(rebuy_cost, 0)
          + CASE WHEN add_on THEN coalesce(addon_cost, 0) ELSE 0 END)
        ORDER BY ended_at DESC) FROM (SELECT * FROM tournament_rows ORDER BY ended_at DESC LIMIT 25) recent), '[]'::jsonb)
    )
  );
END;
$function$;