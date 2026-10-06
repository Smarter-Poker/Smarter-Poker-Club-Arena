\set ON_ERROR_STOP on

INSERT INTO public.clubs(id,lifecycle_status,asset) VALUES
 ('10000000-0000-0000-0000-000000000001','active','chips'),
 ('10000000-0000-0000-0000-000000000002','retired','chips');
INSERT INTO public.club_members(club_id,user_id,status) VALUES
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active');

CREATE FUNCTION public.ca_assert_player_stats_club(p_user uuid,p_club uuid,p_asset text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR p_user IS DISTINCT FROM auth.uid() OR NOT EXISTS(
   SELECT 1 FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
   WHERE m.user_id=p_user AND m.club_id=p_club AND m.status IN ('active','approved')
     AND coalesce(c.lifecycle_status,'active')<>'retired' AND c.asset=p_asset
 ) THEN RAISE EXCEPTION 'not authorized for stats club' USING ERRCODE='42501'; END IF;
END $$;

CREATE TABLE public.ca_hand_notes(user_id uuid NOT NULL,hand_id uuid NOT NULL);

CREATE FUNCTION public.ca_stats_calendar_bounds(
 p_days integer,p_tz text,p_now timestamptz
) RETURNS TABLE(range_days integer,range_tz text,from_at timestamptz,to_at timestamptz)
LANGUAGE sql STABLE AS $$
 SELECT p_days,p_tz,
  (((p_now AT TIME ZONE p_tz)::date-(p_days-1))::timestamp AT TIME ZONE p_tz),
  ((((p_now AT TIME ZONE p_tz)::date+1)::timestamp) AT TIME ZONE p_tz)
$$;

CREATE FUNCTION public.fixture_stats_v2(p_hand uuid,p_stack numeric) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('version',2,'facts',jsonb_build_array(jsonb_build_object(
 'hand_id',p_hand,'user_id','20000000-0000-0000-0000-000000000001',
 'club_id','10000000-0000-0000-0000-000000000001','table_id','40000000-0000-0000-0000-000000000009',
 'tournament_id',NULL,'played_at','2026-10-03T12:00:00Z','game_variant','nlh','big_blind',2,
 'seat',1,'position','BTN','players_dealt',2,'opponent_ids',jsonb_build_array('20000000-0000-0000-0000-000000000002'),
 'hole_cards',NULL,'hand_class','AKs','invested',10,'returned',15,'net',5,'net_bb',2.5,
 'rake_paid',0,'vpip',true,'pfr',true,'three_bet',true,'four_bet',false,
 'faced_three_bet',false,'folded_to_three_bet',false,'had_cbet_flop_opp',true,
 'cbet_flop',true,'saw_flop',true,'went_to_showdown',true,'won_at_showdown',true,
 'aggressive_actions',2,'passive_actions',1,'effective_stack_bb_at_deal',p_stack
 ) || jsonb_build_object(
 'hero_in_position',true,'aggressive_actions_preflop',1,'passive_actions_preflop',0,
 'aggressive_actions_flop',1,'passive_actions_flop',0,'aggressive_actions_turn',0,
 'passive_actions_turn',1,'aggressive_actions_river',0,'passive_actions_river',0,
 'three_bet_opportunity',true,'four_bet_opportunity',false,'steal_opportunity',false,
 'stole',false,'squeeze_opportunity',true,'squeezed',true,'blind_defense_opportunity',false,
 'defended_blind',false,'cbet_flop_opportunity',true,'barrel_turn_opportunity',false,
 'barreled_turn',false,'barrel_river_opportunity',false,'barreled_river',false,
 'check_raise_opportunity',false,'check_raised',false,'donk_opportunity',false,
 'donk_bet',false,'probe_opportunity',false,'probe_bet',false,'was_all_in',false,
 'all_in_street',NULL,'all_in_at_risk',NULL,'all_in_equity',NULL,'ev_returned',NULL,
 'ev_net',5,'ev_net_bb',2.5)),'transfers','[]'::jsonb)
$$;

-- Rolling engines can still emit payload v1 while the v2 projector is live.
-- Remove representative v2 keys so the regression proves that nullable
-- columns present only on the stored row do not manufacture a conflict.
CREATE FUNCTION public.fixture_stats_v1(p_hand uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_set(
    public.fixture_stats_v2(p_hand,100)
      #- '{facts,0,effective_stack_bb_at_deal}'
      #- '{facts,0,hero_in_position}',
    '{version}',to_jsonb('1'::text)
  )
$$;

INSERT INTO public.tables VALUES(
 '40000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001');
INSERT INTO public.hand_history(id,table_id,hand_number) VALUES(
 '30000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000009',9);
INSERT INTO public.hand_atomic_commits VALUES(
 '40000000-0000-0000-0000-000000000009',9,'30000000-0000-0000-0000-000000000009',
 jsonb_build_object('accepted_hand_facts',jsonb_build_object(
  'stats_facts',fixture_stats_v2('30000000-0000-0000-0000-000000000009',100))));
SELECT public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000009');
UPDATE public.ca_hand_facts SET source_hash=NULL,effective_stack_bb_at_deal=NULL,
 three_bet_opportunity=NULL,squeeze_opportunity=NULL
 WHERE hand_id='30000000-0000-0000-0000-000000000009';
DELETE FROM public.ca_hand_fact_projection_receipts
 WHERE hand_id='30000000-0000-0000-0000-000000000009';
DO $$ BEGIN
 PERFORM public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000009');
 IF (SELECT effective_stack_bb_at_deal FROM public.ca_hand_facts
      WHERE hand_id='30000000-0000-0000-0000-000000000009')<>100 THEN
   RAISE EXCEPTION 'v2 legacy adoption did not populate exact opportunity columns';
 END IF;
END $$;
UPDATE public.hand_atomic_commits SET post_commit_payload=jsonb_build_object(
 'accepted_hand_facts',jsonb_build_object(
  'stats_facts',fixture_stats_v2('30000000-0000-0000-0000-000000000009',90)))
 WHERE hand_number=9;
DO $$ BEGIN
 BEGIN PERFORM public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000009');
 EXCEPTION WHEN OTHERS THEN
   IF SQLERRM LIKE '%source_hash_conflict%' THEN RETURN; END IF;
   RAISE;
 END;
 RAISE EXCEPTION 'changed v2 source did not refuse';
END $$;

-- v1 remains projectable after Phase 6 even though the physical row now has
-- additional nullable opportunity columns. No hand_history row is present.
INSERT INTO public.hand_atomic_commits VALUES(
 '40000000-0000-0000-0000-000000000009',10,'30000000-0000-0000-0000-000000000010',
 jsonb_build_object('accepted_hand_facts',jsonb_build_object(
  'stats_facts',fixture_stats_v1('30000000-0000-0000-0000-000000000010'))));
DO $$ DECLARE r jsonb; BEGIN
 r:=public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000010');
 IF (r->>'ok')::boolean IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM public.ca_hand_fact_projection_receipts
      WHERE hand_id='30000000-0000-0000-0000-000000000010')
    OR (SELECT effective_stack_bb_at_deal IS NOT NULL OR hero_in_position IS NOT NULL
          FROM public.ca_hand_facts
         WHERE hand_id='30000000-0000-0000-0000-000000000010') THEN
   RAISE EXCEPTION 'rolling v1 projection failed after v2 schema: %',r;
 END IF;
END $$;

-- A retained atomic v2 payload is projected only by the accepted-hand outbox;
-- no repair/reconcile door exists.
INSERT INTO public.hand_atomic_commits VALUES(
 '40000000-0000-0000-0000-000000000009',11,'30000000-0000-0000-0000-000000000011',
 jsonb_build_object('accepted_hand_facts',jsonb_build_object(
  'stats_facts',fixture_stats_v2('30000000-0000-0000-0000-000000000011',75))));
DO $$ DECLARE r jsonb; BEGIN
 r:=public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000011');
 IF NOT COALESCE((r->>'ok')::boolean,false)
    OR NOT EXISTS(SELECT 1 FROM public.ca_hand_fact_projection_receipts
      WHERE hand_id='30000000-0000-0000-0000-000000000011')
    OR (SELECT effective_stack_bb_at_deal FROM public.ca_hand_facts
         WHERE hand_id='30000000-0000-0000-0000-000000000011')<>75 THEN
   RAISE EXCEPTION 'accepted v2 projection failed without hand_history: %',r;
 END IF;
END $$;

-- Supplied v2 fields remain strict: extra nullable database columns are
-- tolerated for v1, but a changed canonical opportunity value still refuses.
DELETE FROM public.ca_hand_fact_projection_receipts
 WHERE hand_id='30000000-0000-0000-0000-000000000011';
UPDATE public.ca_hand_facts SET three_bet_opportunity=false
 WHERE hand_id='30000000-0000-0000-0000-000000000011';
DO $$ BEGIN
 BEGIN
  PERFORM public.ca_project_hand_stats_facts('30000000-0000-0000-0000-000000000011');
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%existing_fact_conflict%' THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'changed canonical v2 fact did not refuse';
END $$;

-- The compatibility rows have completed their assertions and are not part of
-- the aggregate fixture population below.
DELETE FROM public.ca_hand_fact_projection_receipts
 WHERE hand_id IN (
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000011'
 );
DELETE FROM public.ca_hand_facts
 WHERE hand_id IN (
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000011'
 );
DELETE FROM public.hand_atomic_commits WHERE hand_number IN (10,11);

INSERT INTO public.ca_hand_facts(
 hand_id,user_id,club_id,table_id,played_at,game_variant,big_blind,position,players_dealt,
 invested,returned,net,net_bb,ev_net,ev_net_bb,three_bet,three_bet_opportunity,
 squeeze_opportunity,squeezed,aggressive_actions_preflop,passive_actions_preflop,
 hero_in_position,effective_stack_bb_at_deal)
VALUES
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',now(),'nlh',2,'BTN',6,
  12,24,12,6,12,6,true,true,true,true,2,0,true,100),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',now(),'nlh',2,'BB',6,
  2,0,-2,-1,-2,-1,false,false,false,false,0,1,false,80),
 ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',now(),'nlh',2,'CO',6,
  0,0,0,0,0,0,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$
DECLARE r jsonb;
BEGIN
 r:=public.ca_player_cash_opportunity_stats(
  '20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF r#>>'{opportunities,three_bet,opportunities}' <> '2'
    OR r#>>'{opportunities,three_bet,actions}' <> '2'
    OR r#>>'{coverage,exact_hands}' <> '3'
    OR r#>>'{coverage,unavailable_hands}' <> '1' THEN
   RAISE EXCEPTION 'cash opportunity aggregate mismatch: %',r;
 END IF;
 IF has_function_privilege('anon','public.ca_player_cash_opportunity_stats(uuid,integer,text,text,uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'anon execute leak';
 END IF;
END $$;

DO $$ BEGIN
 PERFORM public.ca_player_cash_opportunity_stats(
  '20000000-0000-0000-0000-000000000002',30,'UTC','chips',NULL);
 RAISE EXCEPTION 'cross-user read unexpectedly succeeded';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

DO $$
DECLARE first_page jsonb; second_page jsonb; cursor_at timestamptz; cursor_id uuid;
BEGIN
 first_page:=public.ca_player_stats_hand_evidence(
  '20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  'chips',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'three_bet',NULL,NULL,1);
 IF jsonb_array_length(first_page->'hands')<>1 OR (first_page->>'has_more')::boolean IS NOT TRUE
    OR first_page#>>'{hands,0,cash_metric}'<>'three_bet'
    OR (first_page#>>'{hands,0,cash_metric_action}')::boolean IS NOT TRUE THEN
   RAISE EXCEPTION 'cash evidence first page mismatch: %',first_page;
 END IF;
 cursor_at:=(first_page#>>'{next_cursor,played_at}')::timestamptz;
 cursor_id:=(first_page#>>'{next_cursor,hand_id}')::uuid;
 second_page:=public.ca_player_stats_hand_evidence(
  '20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  'chips',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'three_bet',cursor_at,cursor_id,1);
 IF jsonb_array_length(second_page->'hands')<>1 THEN
   RAISE EXCEPTION 'cash evidence cursor page mismatch: %',second_page;
 END IF;
 BEGIN
  PERFORM public.ca_player_stats_hand_evidence(
   '20000000-0000-0000-0000-000000000001',NULL,'chips',NULL,NULL,NULL,NULL,NULL,
   NULL,NULL,NULL,NULL,NULL,NULL,NULL,'made_up',NULL,NULL,25);
  RAISE EXCEPTION 'unknown cash evidence metric unexpectedly succeeded';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

DO $$ BEGIN
 PERFORM public.ca_player_cash_opportunity_stats(
  '20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000002');
 RAISE EXCEPTION 'unauthorized club read unexpectedly succeeded';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

RESET ROLE;
SELECT 'stats cash opportunity native fixture passed' AS result;
