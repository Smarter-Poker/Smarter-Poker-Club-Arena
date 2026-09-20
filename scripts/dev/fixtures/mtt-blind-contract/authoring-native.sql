-- Actual two-RPC authoring contract. Run only in the complete owned PG17
-- accounting fixture, with the captured schedule table/auth dependencies.
-- All synthetic data and both RPCs' effects roll back; no financial stand-ins.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned local fixture required';END IF;
END $$;
CREATE FUNCTION pg_temp.authoring_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'AUTHORING FAIL: %',label;END IF;
 RAISE NOTICE 'AUTHORING PASS: %',label;
END $$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('17000399-0000-4000-8000-000000000001'),('17000399-0000-4000-8000-000000000002');
INSERT INTO public.profiles(id,username,display_name,role) VALUES
 ('17000399-0000-4000-8000-000000000001','native_break_owner','Native Break Owner','admin'),
 ('17000399-0000-4000-8000-000000000002','native_break_outsider','Native Break Outsider','user');
INSERT INTO public.clubs(id,name,owner_id,chip_treasury,asset,is_platform) VALUES
 ('17000398-0000-4000-8000-000000000001','Native Break Club','17000399-0000-4000-8000-000000000001',0,'chips',false);
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,diamonds,membership_lifecycle_status) VALUES
 ('17000398-0000-4000-8000-000000000001','17000399-0000-4000-8000-000000000001','owner','active',0,0,'active');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE authoring_inputs(key text PRIMARY KEY,value jsonb);
INSERT INTO authoring_inputs VALUES('config',jsonb_build_object(
 'name','Native Break Draft','type','mtt','gameVariant','NLH','buyIn',20,'maxPlayers',100,
 'minPlayers',3,'startingStack',10000,'startTime',(now()+interval '1 day')::text,
 'synchronizedBreaks',false,'payoutPercent',15,
 'blindStructure','[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":0,"bigBlind":0,"ante":0,"duration":300,"isBreak":true},{"level":3,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
 'payoutStructure','[{"place":1,"percentage":100}]'::jsonb));
INSERT INTO public.tournament_schedules(id,club_id,name,days_of_week,start_times_utc,config)
 SELECT '17000397-0000-4000-8000-000000000001','17000398-0000-4000-8000-000000000001','Accepted Historical Schedule',ARRAY[1],ARRAY['18:00'],value FROM authoring_inputs;
INSERT INTO public.tournament_schedules(id,club_id,name,days_of_week,start_times_utc,config)
 SELECT '17000397-0000-4000-8000-000000000002','17000398-0000-4000-8000-000000000001',
 'Accepted Linked Schedule',ARRAY[1],ARRAY['18:00'],
 value||'{"type":"sng","satelliteTargetId":"17000396-0000-4000-8000-000000000001"}'::jsonb
 FROM authoring_inputs WHERE key='config';
GRANT SELECT,INSERT,UPDATE ON authoring_inputs TO authenticated;
SELECT set_config('request.jwt.claim.sub','17000399-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims','{"sub":"17000399-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL SESSION AUTHORIZATION authenticated;
DO $rpc$
DECLARE cfg jsonb;playing jsonb;r jsonb;v_id uuid;before_count bigint;schedule jsonb;row_value jsonb;
BEGIN
 SELECT value INTO cfg FROM authoring_inputs WHERE key='config';
 SELECT count(*) INTO before_count FROM public.tournaments;
 r:=public.fn_create_tournament('17000398-0000-4000-8000-000000000001',cfg);
 PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported' AND r->>'success'='false',
  'new manual MTT refuses ignored break rows');
 PERFORM pg_temp.authoring_assert((SELECT count(*) FROM public.tournaments)=before_count,'refused manual request creates no event');
 r:=public.fn_create_tournament('17000398-0000-4000-8000-000000000001',cfg||'{"type":"satellite","maxPlayers":2}'::jsonb);
 PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported','legacy numeric two-cap does not bypass manual MTT refusal');
 schedule:=jsonb_build_object('clubId','17000398-0000-4000-8000-000000000001','name','New Schedule','daysOfWeek',ARRAY[1],'startTimesUtc',ARRAY['18:00'],'config',cfg);
 r:=public.fn_upsert_tournament_schedule(schedule);
 PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported' AND NOT(r ? 'schedule_id'),'new saved schedule refuses ignored break rows');
 PERFORM pg_temp.authoring_assert((SELECT count(*) FROM public.tournament_schedules)=2,'refused schedule creates no row');
 -- The compatible scheduled writer promotes these target-linked fixed labels
 -- to MTT satellites. No actual target event is needed to reject authoring.
 FOR row_value IN SELECT value FROM jsonb_array_elements('[
  {"type":"sng","satelliteTargetId":"17000396-0000-4000-8000-000000000001"},
  {"type":"spin","satellite_target_id":"17000396-0000-4000-8000-000000000001"},
  {"type":"SNG","satelliteTarget":{"tournamentId":"17000396-0000-4000-8000-000000000001"}},
  {"type":"SPIN","satellite_target":{"tournament_id":"17000396-0000-4000-8000-000000000001"}}
 ]'::jsonb) LOOP
  r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('config',cfg||row_value));
  PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported'
   AND NOT(r ? 'schedule_id') AND (SELECT count(*) FROM public.tournament_schedules)=2,
   'target-linked fixed label cannot author ignored satellite breaks: '||(row_value->>'type'));
 END LOOP;
 r:=public.fn_upsert_tournament_schedule('{"id":"17000397-0000-4000-8000-000000000001","active":false}'::jsonb);
 PERFORM pg_temp.authoring_assert(r->>'ok'='true' AND (SELECT NOT active AND config=cfg FROM public.tournament_schedules WHERE id='17000397-0000-4000-8000-000000000001'),
  'historical schedule opt-out preserves its exact accepted config');
 r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('id','17000397-0000-4000-8000-000000000001','active',true,'name','Renamed Historical Schedule'));
 PERFORM pg_temp.authoring_assert(r->>'ok'='true' AND (SELECT active AND config=cfg AND name='Renamed Historical Schedule' FROM public.tournament_schedules WHERE id='17000397-0000-4000-8000-000000000001'),
  'identical historical config and metadata edits remain supported');
 SELECT to_jsonb(t) INTO row_value FROM public.tournament_schedules t WHERE id='17000397-0000-4000-8000-000000000001';
 r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('id','17000397-0000-4000-8000-000000000001','config',cfg||'{"startingStack":20000}'::jsonb));
 PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported' AND row_value=(SELECT to_jsonb(t) FROM public.tournament_schedules t WHERE id='17000397-0000-4000-8000-000000000001'),
  'changed historical config cannot author another ignored break and leaves row exact');
 SELECT to_jsonb(t) INTO row_value FROM public.tournament_schedules t WHERE id='17000397-0000-4000-8000-000000000002';
 r:=public.fn_upsert_tournament_schedule('{"id":"17000397-0000-4000-8000-000000000002","active":false}'::jsonb);
 PERFORM pg_temp.authoring_assert(r->>'ok'='true' AND (SELECT NOT active AND config=row_value->'config' FROM public.tournament_schedules WHERE id='17000397-0000-4000-8000-000000000002'),
  'unchanged historical linked schedule keeps its accepted config');
 SELECT to_jsonb(t) INTO row_value FROM public.tournament_schedules t WHERE id='17000397-0000-4000-8000-000000000002';
 r:=public.fn_upsert_tournament_schedule(jsonb_build_object('id','17000397-0000-4000-8000-000000000002',
  'config',(row_value->'config')||'{"startingStack":20000}'::jsonb));
 PERFORM pg_temp.authoring_assert(r->>'error'='custom_level_breaks_not_supported' AND row_value=(SELECT to_jsonb(t) FROM public.tournament_schedules t WHERE id='17000397-0000-4000-8000-000000000002'),
  'changed historical linked config refuses ignored breaks without altering the saved row');
 playing:=cfg||jsonb_build_object('blindStructure',jsonb_build_array(cfg#>'{blindStructure,0}',(cfg#>'{blindStructure,2}')||'{"level":2}'::jsonb));
 r:=public.fn_create_tournament('17000398-0000-4000-8000-000000000001',playing);
 v_id:=(r->>'tournament_id')::uuid;
 PERFORM pg_temp.authoring_assert(r->>'success'='true' AND v_id IS NOT NULL,'actual manual playing-only creator succeeds');
 INSERT INTO authoring_inputs VALUES('created',to_jsonb(v_id));
 -- The authenticated RPC response is followed by the real RLS-readable row.
 PERFORM pg_temp.authoring_assert((SELECT blind_structure::jsonb=playing->'blindStructure'
   AND NOT synchronized_breaks AND payout_percent=15 AND starting_chips=10000
   AND buy_in_amount=18 AND buy_in_fee=2 FROM public.tournaments WHERE id=v_id),
  'stored playing ladder, opt-out, stack, fee and payout depth remain exact');
 r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('config',playing));
 v_id:=(r->>'schedule_id')::uuid;
 PERFORM pg_temp.authoring_assert(r->>'ok'='true' AND (SELECT config=playing FROM public.tournament_schedules WHERE id=v_id),'playing-only saved schedule persists exact configuration');
 r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('config',cfg||'{"type":"SNG"}'::jsonb));
 PERFORM pg_temp.authoring_assert(r->>'ok'='true','fixed scheduled SNG retains existing case-normalized classification');
 r:=public.fn_upsert_tournament_schedule(schedule||jsonb_build_object('config',cfg||'{"type":"spin","satelliteTarget":{},"satelliteTargetId":" "}'::jsonb));
 PERFORM pg_temp.authoring_assert(r->>'ok'='true','empty target does not reclassify a genuine fixed Spin');

END $rpc$;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claim.sub','17000399-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claims','{"sub":"17000399-0000-4000-8000-000000000002","role":"authenticated"}',true);
SET LOCAL SESSION AUTHORIZATION authenticated;
DO $$ DECLARE cfg jsonb;r jsonb;denied boolean:=false; BEGIN
 SELECT value INTO cfg FROM authoring_inputs WHERE key='config';
 r:=public.fn_create_tournament('17000398-0000-4000-8000-000000000001',cfg);
 PERFORM pg_temp.authoring_assert(r->>'error'='not_authorised','manual authorization precedes validation');
 r:=public.fn_upsert_tournament_schedule(jsonb_build_object('clubId','17000398-0000-4000-8000-000000000001','name','Not Mine','daysOfWeek',ARRAY[1],'startTimesUtc',ARRAY['18:00'],'config',cfg));
 PERFORM pg_temp.authoring_assert(r->>'error'='not_authorised','new schedule authorization remains authoritative');
 r:=public.fn_upsert_tournament_schedule('{"id":"17000397-0000-4000-8000-000000000001","active":false}'::jsonb);
 PERFORM pg_temp.authoring_assert(r->>'error'='not_authorised','existing schedule authorization uses stored ownership');
 BEGIN INSERT INTO public.tournament_schedules(club_id,name,days_of_week,config) VALUES('17000398-0000-4000-8000-000000000001','Bypass',ARRAY[1],cfg);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 PERFORM pg_temp.authoring_assert(denied,'authenticated direct schedule insertion stays denied');
END $$;
RESET SESSION AUTHORIZATION;
SET LOCAL SESSION AUTHORIZATION anon;
DO $$ DECLARE refused_manual boolean:=false;refused_schedule boolean:=false;BEGIN
 BEGIN PERFORM public.fn_create_tournament(NULL,'{}');EXCEPTION WHEN insufficient_privilege THEN refused_manual:=true;END;
 BEGIN PERFORM public.fn_upsert_tournament_schedule('{}');EXCEPTION WHEN insufficient_privilege THEN refused_schedule:=true;END;
 PERFORM pg_temp.authoring_assert(refused_manual AND refused_schedule,'both RPCs remain inaccessible to anonymous callers');
END $$;
RESET SESSION AUTHORIZATION;
SELECT pg_temp.authoring_assert(NOT EXISTS(SELECT 1 FROM public.tournament_players)
 AND NOT EXISTS(SELECT 1 FROM public.tables)
 AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions),'authoring does not enroll players, create felt or move wallet money');
ROLLBACK;
SELECT 'MTT_AUTHORING_BREAK_NATIVE_PASS';
