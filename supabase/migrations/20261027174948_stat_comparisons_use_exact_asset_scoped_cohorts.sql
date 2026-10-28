-- Reserved by scripts/new-migration.mjs. Repair the existing statistics
-- snapshot producer; this adds no schedule, repair loop or new table.
-- Percentages use hand counts, BB/100 uses each recorded hand's own profit and blind, and chips
-- and Diamonds never enter the same cohort. Horses qualify identically.
-- @live-proof: position('recent_action_cache' in pg_get_functiondef('public.ca_refresh_stat_distribution(integer)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
CREATE OR REPLACE FUNCTION public.ca_refresh_stat_distribution(p_min_hands integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_rows integer;
BEGIN
 IF p_min_hands IS NULL OR p_min_hands<1000 OR p_min_hands>1000000 THEN
  RAISE EXCEPTION 'Invalid cohort minimum hands' USING ERRCODE='22023';
 END IF;
 -- Delete only the snapshots this same producer owns, in the same transaction.
 -- An asset with no qualifying population must never retain yesterday's ranks.
 DELETE FROM public.ca_stat_distribution WHERE cohort IN ('field','field:chips','field:diamonds');
 WITH stats AS MATERIALIZED (
  -- The existing narrow action cache retains each player's most recent 1,000
  -- hands. Never scan the wide lifetime fact heap from the 15-minute snapshot.
  -- This is explicitly an action-reconstructed comparison sample, not a claim
  -- of exact settlement or complete lifetime coverage.
  SELECT s.asset,s.user_id,count(*) hands,
   count(*) FILTER(WHERE s.is_cash) cash_hands,
   count(*) FILTER(WHERE s.vpip) vpip_hands,count(*) FILTER(WHERE s.pfr) pfr_hands,
   count(*) FILTER(WHERE s.is_winner) hands_won,
   sum(s.profit/nullif(s.big_blind,0)) FILTER(WHERE s.is_cash) cash_net_bb,
   count(*) FILTER(WHERE s.three_bet_opp) three_bet_opps,
   count(*) FILTER(WHERE s.three_bet AND s.three_bet_opp) three_bets
  FROM public.ca_hand_player_stat s WHERE s.asset IN ('chips','diamonds')
  GROUP BY s.asset,s.user_id
 ), metrics AS (
  SELECT asset,m.metric,m.value FROM stats s CROSS JOIN LATERAL (VALUES
   ('bb100',CASE WHEN cash_hands>=p_min_hands THEN cash_net_bb/cash_hands*100 END),
   ('vpip',CASE WHEN hands>=p_min_hands THEN vpip_hands::numeric/hands*100 END),
   ('pfr',CASE WHEN hands>=p_min_hands THEN pfr_hands::numeric/hands*100 END),
   ('win_rate',CASE WHEN hands>=p_min_hands THEN hands_won::numeric/hands*100 END),
   ('three_bet',CASE WHEN hands>=p_min_hands AND three_bet_opps>0 THEN three_bets::numeric/three_bet_opps*100 END)
  ) m(metric,value) WHERE m.value IS NOT NULL
 ), computed AS (
  SELECT asset,metric,percentile_cont(0.1) WITHIN GROUP(ORDER BY value)::numeric p10,
   percentile_cont(0.25) WITHIN GROUP(ORDER BY value)::numeric p25,
   percentile_cont(0.5) WITHIN GROUP(ORDER BY value)::numeric p50,
   percentile_cont(0.75) WITHIN GROUP(ORDER BY value)::numeric p75,
   percentile_cont(0.9) WITHIN GROUP(ORDER BY value)::numeric p90,count(*) n
  FROM metrics GROUP BY asset,metric
 ), snapshots AS (
  SELECT 'field:'||asset cohort,metric,p10,p25,p50,p75,p90,n FROM computed
  UNION ALL
  -- Keep older chip clients on the corrected chip population during rollout.
  SELECT 'field',metric,p10,p25,p50,p75,p90,n FROM computed WHERE asset='chips'
 ) INSERT INTO public.ca_stat_distribution(cohort,metric,p10,p25,p50,p75,p90,sample_size,computed_at)
 SELECT cohort,metric,round(p10,3),round(p25,3),round(p50,3),round(p75,3),round(p90,3),n,now()
 FROM snapshots;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 RETURN jsonb_build_object('metrics_written',v_rows,'min_hands',p_min_hands,'at',now(),
  'source','ca_hand_player_stat','sample','recent_action_cache','asset_scoped',true);
END $function$;
REVOKE ALL ON FUNCTION public.ca_refresh_stat_distribution(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_stat_distribution(integer) TO service_role;

-- Winning any pot (including a split/side pot) is different from net profit.
-- The fact producer's returned column contains pot awards, not uncalled refunds.
DO $patch$
DECLARE d text; r record;
BEGIN
 FOR r IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('ca_player_stats_overview_v2',
   'ca_player_stats_overview_v2_by_club','ca_player_stats_shared_overview_v1','ca_player_stats_club_comparison')
 LOOP
  d:=pg_get_functiondef(r.oid);
  d:=replace(d,'WHERE net > 0','WHERE returned > 0');
  d:=replace(d,'WHERE net>0','WHERE returned>0');
  d:=replace(d,'(f.net>0)','(f.returned>0)');
  IF r.proname='ca_player_stats_overview_v2' THEN
   d:=replace(d,'s.is_winner,coalesce(f.vpip','coalesce(f.returned>0,s.is_winner) AS is_winner,coalesce(f.vpip');
   d:=replace(d,'s.is_winner,s.vpip','coalesce(f.returned>0,s.is_winner) AS is_winner,s.vpip');
  END IF;
  EXECUTE d;
 END LOOP;
END $patch$;
COMMIT;
