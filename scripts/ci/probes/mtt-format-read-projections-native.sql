-- Actual read RPCs on synthetic structural identities; no financial lifecycle claim.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned PG17 fixture required';END IF;
END $local$;
CREATE FUNCTION pg_temp.projection_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FORMAT PROJECTION FAIL: %',label;END IF;
 RAISE NOTICE 'FORMAT PROJECTION PASS: %',label;
END $$;
-- Historical inputs only. Every actual RPC below runs with origin triggers and its real auth helper.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46466300-0000-4000-8000-000000000001'),('46466300-0000-4000-8000-000000000003');
INSERT INTO public.users(id,username) VALUES('46466300-0000-4000-8000-000000000001','projection_fixture'),('46466300-0000-4000-8000-000000000003','projection_outsider');
INSERT INTO public.profiles(id) VALUES('46466300-0000-4000-8000-000000000001'),('46466300-0000-4000-8000-000000000003');
INSERT INTO public.clubs(id,club_id,name,slug,asset,is_platform,owner_id)
VALUES('46466300-0000-4000-8000-000000000002',994663,'Projection fixture','projection-fixture','chips',false,'46466300-0000-4000-8000-000000000001');
INSERT INTO public.club_members(club_id,user_id,role,status)
VALUES('46466300-0000-4000-8000-000000000002','46466300-0000-4000-8000-000000000001','owner','active');
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,ended_at,format_contract)
VALUES
 ('46466300-0000-4000-8000-000000000010','46466300-0000-4000-8000-000000000002','Projection MTT active','MTT','freezeout',100,3,9,18,2,10000,4,'RUNNING',now()-interval '1 hour',NULL,'mtt-v1'),
 ('46466300-0000-4000-8000-000000000011','46466300-0000-4000-8000-000000000002','Projection HU waiting','SATELLITE','sng',2,2,2,19,1,300,1,'REGISTERING',now()+interval '1 hour',NULL,'seat-first-satellite-v1'),
 ('46466300-0000-4000-8000-000000000012','46466300-0000-4000-8000-000000000002','Projection terminal history','MTT','freezeout',100,3,9,18,2,10000,0,'COMPLETED',now()-interval '2 hours',now()-interval '10 minutes',NULL);
UPDATE public.tournaments SET is_private=true WHERE id='46466300-0000-4000-8000-000000000011';
INSERT INTO public.tables(id,club_id,name,game_type,game_variant,max_players,current_players,status)
-- An archived cash row is legal without an active game-cluster identity. Its
-- management projection must retain the same physical capacity and NULL format.
VALUES('46466300-0000-4000-8000-000000000020','46466300-0000-4000-8000-000000000002','Projection cash table','cash','nlh',6,0,'closed');
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.sub','46466300-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims','{"sub":"46466300-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET SESSION AUTHORIZATION authenticated;
DO $reads$
DECLARE dashboard jsonb; home jsonb; search_result jsonb; management jsonb; row_json jsonb;
BEGIN
 PERFORM pg_temp.projection_assert(session_user='authenticated' AND current_user='authenticated',
  'read checks use actual authenticated session authority');
 dashboard:=public.ca_club_tournaments('46466300-0000-4000-8000-000000000002',20,30);
 PERFORM pg_temp.projection_assert(dashboard#>>'{summary,live_count}'='2'
  AND jsonb_array_length(dashboard->'live')=2,'dashboard includes actual uppercase RUNNING and REGISTERING states');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(dashboard->'live') WHERE value->>'id'='46466300-0000-4000-8000-000000000010';
 PERFORM pg_temp.projection_assert(row_json->>'format_contract'='mtt-v1','dashboard live preserves recorded MTT');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(dashboard->'recent') WHERE value->>'id'='46466300-0000-4000-8000-000000000012';
 PERFORM pg_temp.projection_assert(row_json?'format_contract' AND row_json->'format_contract'='null'::jsonb,'dashboard terminal NULL retained');
 home:=public.get_club_home('46466300-0000-4000-8000-000000000002');
 PERFORM pg_temp.projection_assert(home->>'found'='true','real club membership admitted');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(home->'tournaments') WHERE value->>'id'='46466300-0000-4000-8000-000000000010';
 PERFORM pg_temp.projection_assert(row_json->>'format_contract'='mtt-v1','club home carries recorded MTT');
 search_result:=public.fn_community_search('Projection','tournaments',40);
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(search_result->'tournaments') WHERE value->>'id'='46466300-0000-4000-8000-000000000011';
 PERFORM pg_temp.projection_assert(row_json->>'format_contract'='seat-first-satellite-v1','search carries funded legacy format');
 management:=public.fn_list_managed_games('club','46466300-0000-4000-8000-000000000002');
 PERFORM pg_temp.projection_assert(management->>'ok'='true','real owner management permission admitted');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(management->'items') WHERE value->>'id'='46466300-0000-4000-8000-000000000010';
 PERFORM pg_temp.projection_assert(row_json->>'format_contract'='mtt-v1','management carries recorded MTT');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(management->'items') WHERE value->>'id'='46466300-0000-4000-8000-000000000012';
 PERFORM pg_temp.projection_assert(row_json?'format_contract' AND row_json->'format_contract'='null'::jsonb,'management terminal NULL retained');
 SELECT value INTO STRICT row_json FROM jsonb_array_elements(management->'items') WHERE value->>'id'='46466300-0000-4000-8000-000000000020';
 PERFORM pg_temp.projection_assert(row_json->>'kind'='table' AND row_json?'format_contract'
  AND row_json->'format_contract'='null'::jsonb AND row_json->>'max_players'='6',
  'management cash row retains physical capacity and explicit NULL format column');
END $reads$;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claim.sub','46466300-0000-4000-8000-000000000003',true);
SELECT set_config('request.jwt.claims','{"sub":"46466300-0000-4000-8000-000000000003","role":"authenticated"}',true);
SET SESSION AUTHORIZATION authenticated;
DO $outsider$
DECLARE refused boolean:=false; result jsonb;
BEGIN
 PERFORM pg_temp.projection_assert(session_user='authenticated' AND current_user='authenticated',
  'outsider checks also use authenticated session authority');
 BEGIN PERFORM public.ca_club_tournaments('46466300-0000-4000-8000-000000000002',20,30);
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM<>'not authorized for this club' THEN RAISE;END IF;refused:=true;
 END;
 PERFORM pg_temp.projection_assert(refused,'dashboard refuses authenticated nonmember');
 result:=public.get_club_home('46466300-0000-4000-8000-000000000002');
 PERFORM pg_temp.projection_assert(result->>'found'='false' AND result->>'reason'='membership_required',
  'club home refuses authenticated nonmember');
 result:=public.fn_community_search('Projection','tournaments',40);
 PERFORM pg_temp.projection_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'tournaments') x
  WHERE x->>'id'='46466300-0000-4000-8000-000000000011')
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'tournaments') x
  WHERE x->>'id'='46466300-0000-4000-8000-000000000010'),
  'search excludes private tournament while preserving public discovery for nonmember');
 result:=public.fn_list_managed_games('club','46466300-0000-4000-8000-000000000002');
 PERFORM pg_temp.projection_assert(result->>'ok'='false' AND result->>'reason'='not_authorized',
  'management refuses authenticated nonoperator');
END $outsider$;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SET SESSION AUTHORIZATION authenticated;
DO $missing_identity$
DECLARE refused boolean:=false;
BEGIN
 BEGIN PERFORM public.fn_community_search('Projection','tournaments',40);
 EXCEPTION WHEN invalid_authorization_specification THEN
  IF SQLERRM<>'Authentication required' THEN RAISE;END IF;refused:=true;
 END;
 PERFORM pg_temp.projection_assert(refused,'search refuses authenticated role without a player identity');
END $missing_identity$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
SELECT 'MTT_FORMAT_READ_PROJECTIONS_NATIVE_PASS';
