SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE m text; v jsonb; c jsonb; e record; h record; BEGIN
 FOREACH m IN ARRAY ARRAY['cash','tournament'] LOOP
  SELECT * INTO STRICT e FROM separated_expected WHERE cash=(m='cash');
  v:=public.ca_player_stats_overview_separated('20000000-0000-0000-0000-000000000001',NULL,'UTC','chips',m);
  c:=public.ca_player_stats_overview_separated_by_club('20000000-0000-0000-0000-000000000001',NULL,'UTC','chips','10000000-0000-0000-0000-000000000001',m);
  IF v#>>'{scope,game_mode}'<>m OR c#>>'{scope,game_mode}'<>m THEN RAISE EXCEPTION 'Mode receipt lost'; END IF;
  IF (v#>>'{overall,total_hands}')::int<>e.hands OR (v#>>'{overall,vpip}')::numeric<>round(e.vpip_hands::numeric/e.hands,4)
  THEN RAISE EXCEPTION 'Global behavior blended: %, expected %',v,e; END IF;
  IF m='cash' AND ((v#>>'{overall,tourney_hands}')::int<>0 OR (c#>>'{overall,tourney_hands}')::int<>0)
  OR m='tournament' AND ((v#>>'{overall,cash_hands}')::int<>0 OR (v#>>'{overall,total_profit}')::numeric<>0 OR jsonb_array_length(v->'daily')<>0)
  THEN RAISE EXCEPTION 'Cash and tournament money/population leaked: %',v; END IF;
  IF (v#>>'{lifetime,hands}')::int<e.hands THEN RAISE EXCEPTION 'Known mode lifetime lost'; END IF;
  FOR h IN SELECT * FROM public.ca_own_hand_history_separated_by_club('10000000-0000-0000-0000-000000000001',NULL,1,0,m) LOOP
   IF (h.hand->>'tournament_id' IS NULL)<>(m='cash') THEN RAISE EXCEPTION 'Archive mode applied after page'; END IF;
  END LOOP;
 END LOOP;
 -- Both the heatmap and the class drilldown must exclude the NLH tournament.
 v:=public.ca_player_hand_grid('20000000-0000-0000-0000-000000000001',NULL,'nlh',NULL,'chips');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'cells') cell WHERE (cell->>'net_bb')::numeric>=100)
 THEN RAISE EXCEPTION 'NLH tournament entered cash heatmap'; END IF;
 v:=public.ca_player_class_hands('20000000-0000-0000-0000-000000000001','AA',NULL,'nlh',NULL,100,'chips');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'hands') hand WHERE hand->>'hand_id'='99000000-0000-0000-0000-000000000002')
 THEN RAISE EXCEPTION 'NLH tournament entered cash class drilldown'; END IF;
 BEGIN
  PERFORM public.ca_player_stats_overview_separated('20000000-0000-0000-0000-000000000002',NULL,'UTC','chips','cash');
  RAISE EXCEPTION 'Cross-user read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.ca_player_stats_overview_separated('20000000-0000-0000-0000-000000000001',NULL,'UTC','chips','all');
  RAISE EXCEPTION 'Invalid mode accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
RESET ROLE;
-- A mixed-mode opponent pool must not distort the cash benchmark population.
BEGIN;
INSERT INTO public.ca_hand_player_stat(user_id,hand_id,created_at,is_cash,tournament_id,game_variant,big_blind,seat_position,my_blind,won_amt,is_winner,invested_actions,vpip,pfr,profit,asset)
SELECT '20000000-0000-0000-0000-000000000099',md5('mode-benchmark-'||i)::uuid,now(),i<=1000,
 CASE WHEN i>1000 THEN '92000000-0000-0000-0000-000000000001'::uuid END,'nlh',1,'BTN',0,1,true,1,i>1000,i>1000,0,'chips'
FROM generate_series(1,2000) i;
SELECT public.ca_refresh_stat_distribution(1000);
DO $$ BEGIN
 IF (SELECT p50 FROM public.ca_stat_distribution WHERE cohort='field:cash:chips' AND metric='vpip') IS DISTINCT FROM 0::numeric
 OR (SELECT sample_size FROM public.ca_stat_distribution WHERE cohort='field:cash:chips' AND metric='vpip') IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'Tournament tendencies contaminated cash benchmark'; END IF;
 IF has_function_privilege('authenticated','public.ca_refresh_stat_distribution(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Browser can mutate benchmark snapshots'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: cash/tournament mode populations, NLH identity, privacy, pagination, heatmap and benchmark separation' result;
