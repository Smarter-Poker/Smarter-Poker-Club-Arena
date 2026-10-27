-- Reserved by scripts/new-migration.mjs. Burls has recorded three-bets, but
-- the club RPC predates exact opportunity facts and still returns a literal zero.
-- Patch the owning readers in place to preserve funded-club resolution and ACLs.
-- No player facts, money, membership or history rows are changed.
-- @live-proof: position('recorded_three_bet_opportunities' in pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $patch$
DECLARE d text; original text;
BEGIN
 d:=pg_get_functiondef('public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure);
 original:=d;
 IF position('recorded_three_bet_opportunities' in d)>0 THEN
  RAISE EXCEPTION 'Recorded opportunity patch already installed';
 END IF;
 -- The funding projection is deliberately explicit. New columns must travel
 -- through that projection before any denominator can consume them.
 d:=replace(d,'pfr,three_bet,faced_three_bet',
  'pfr,three_bet,three_bet_opportunity,cbet_flop_opportunity,faced_three_bet');
 d:=replace(d,'count(*) FILTER (WHERE three_bet)::integer three_bet_hands,',
  'count(*) FILTER (WHERE three_bet AND three_bet_opportunity)::integer three_bet_hands,
        count(*) FILTER (WHERE three_bet_opportunity)::integer recorded_three_bet_opportunities,');
 d:=replace(d,$text$'three_bet_percent', false,$text$,$text$'three_bet_percent', recorded_three_bet_opportunities > 0,$text$);
 d:=replace(d,$text$'three_bet_opportunities', NULL,$text$,$text$'three_bet_opportunities', recorded_three_bet_opportunities,$text$);
 d:=replace(d,$text$'three_bet_percent', 0,$text$,
  $text$'three_bet_percent', coalesce(round(three_bet_hands::numeric / nullif(recorded_three_bet_opportunities,0),4),0),$text$);
 d:=replace(d,'count(*) FILTER (WHERE had_cbet_flop_opp)::integer cbet_opps,',
  'count(*) FILTER (WHERE cbet_flop_opportunity)::integer cbet_opps,');
 d:=replace(d,'count(*) FILTER (WHERE cbet_flop)::integer cbet_hands,',
  'count(*) FILTER (WHERE cbet_flop AND cbet_flop_opportunity)::integer cbet_hands,');
 d:=replace(d,'count(*) FILTER (WHERE three_bet)::integer three_bet_count,',
  'count(*) FILTER (WHERE three_bet AND three_bet_opportunity)::integer three_bet_count,
        count(*) FILTER (WHERE three_bet_opportunity)::integer three_bet_opps,');
 d:=replace(d,$text$'three_bet_count', three_bet_count, 'hands_won', hands_won,$text$,
  $text$'three_bet_count', three_bet_count, 'three_bet_opps', three_bet_opps, 'hands_won', hands_won,$text$);
 d:=replace(d,$text$'aggression_factor', passive > 0,$text$,$text$'aggression_factor', false,$text$);
 IF d=original OR position('recorded_three_bet_opportunities' in d)=0
  OR position('three_bet_opportunity,cbet_flop_opportunity' in d)=0
  OR position('funded_stats_scope' in d)=0 THEN
  RAISE EXCEPTION 'Recorded opportunity source anchors changed; inspect reader before installation';
 END IF;
 EXECUTE d;
END $patch$;

-- All Clubs previously inherited advanced rates from the legacy latest-750
-- sample while the headline used the complete calendar population.
DO $patch$
DECLARE d text; original text;
BEGIN
 d:=pg_get_functiondef('public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure);
 original:=d;
 IF position('recorded_fact_rates' in d)>0 THEN RAISE EXCEPTION 'Fact rates already installed'; END IF;
 d:=replace(d,'  v_analysis jsonb;','  v_analysis jsonb; v_recorded_fact_rates jsonb;');
 d:=replace(d,'s.tournament_id,s.is_winner,s.vpip,s.pfr,',
  's.tournament_id,s.is_winner,s.vpip,s.pfr,
      f.three_bet fact_three_bet,f.three_bet_opportunity,f.cbet_flop,f.cbet_flop_opportunity,
      f.faced_three_bet,f.folded_to_three_bet,f.saw_flop,f.went_to_showdown,f.won_at_showdown,');
 d:=replace(d,'f.tournament_id,(f.net>0),f.vpip,f.pfr,',
  'f.tournament_id,(f.net>0),f.vpip,f.pfr,
      f.three_bet,f.three_bet_opportunity,f.cbet_flop,f.cbet_flop_opportunity,
      f.faced_three_bet,f.folded_to_three_bet,f.saw_flop,f.went_to_showdown,f.won_at_showdown,');
 d:=replace(d,'count(*) FILTER(WHERE is_cash AND exact)::integer',
  $sql$count(*) FILTER(WHERE is_cash AND exact)::integer,
    jsonb_build_object(
      'three_bet_percent',coalesce(round(count(*) FILTER(WHERE fact_three_bet AND three_bet_opportunity)::numeric/nullif(count(*) FILTER(WHERE three_bet_opportunity),0),4),0),
      'cbet_flop',coalesce(round(count(*) FILTER(WHERE cbet_flop AND cbet_flop_opportunity)::numeric/nullif(count(*) FILTER(WHERE cbet_flop_opportunity),0),4),0),
      'fold_to_three_bet',coalesce(round(count(*) FILTER(WHERE folded_to_three_bet)::numeric/nullif(count(*) FILTER(WHERE faced_three_bet),0),4),0),
      'wtsd',coalesce(round(count(*) FILTER(WHERE went_to_showdown)::numeric/nullif(count(*) FILTER(WHERE saw_flop),0),4),0),
      'showdowns_total',count(*) FILTER(WHERE went_to_showdown),
      'showdowns_won',count(*) FILTER(WHERE won_at_showdown),
      'tournaments_with_hands',count(DISTINCT tournament_id),
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
        'aggression_factor',false,'aggression_factor_denominator',0,
        'hours_played',false))$sql$);
 d:=replace(d,'v_exact_cash FROM source_rows;',
  'v_exact_cash,v_recorded_fact_rates FROM source_rows;');
 d:=replace(d,$text$'overall',v_overall,'daily',v_daily$text$,
  $text$'overall',v_overall||(v_recorded_fact_rates-'metric_availability'),'daily',v_daily$text$);
 d:=replace(d,$text$'advanced_facts_source','ca_hand_player_stat'$text$,
  $text$'advanced_facts_source','ca_hand_facts','metric_availability',v_recorded_fact_rates->'metric_availability'$text$);
 -- The recent-results consumer reads finish_rank, not the storage column position.
 d:=replace(d,'is_mystery_bounty,tp.position,tp.status,',
  'is_mystery_bounty,tp.position AS finish_rank,tp.status,');
 d:=replace(d,'min(position) FILTER(WHERE position IS NOT NULL) best_finish,',
  'min(position) FILTER(WHERE position IS NOT NULL) best_finish,coalesce(sum(coalesce(bounties_collected,0)),0)::integer total_bounties,');
 d:=replace(d,$text$'total_bounty_winnings',round(bounties,2),'net_profit'$text$,
  $text$'total_bounty_winnings',round(bounties,2),'total_bounties',total_bounties,'net_profit'$text$);
 IF d=original OR position('v_recorded_fact_rates FROM source_rows' in d)=0
 OR position('f.three_bet fact_three_bet' in d)=0 THEN
  RAISE EXCEPTION 'All Clubs fact rate anchors changed'; END IF;
 EXECUTE d;
END $patch$;
COMMIT;
