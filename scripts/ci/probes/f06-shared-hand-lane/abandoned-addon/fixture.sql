-- Minimal native dependencies; the complete installed recovery function runs unchanged.
CREATE SCHEMA smarter_private;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb->>'role' $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql AS $$ SELECT 60 $$;
CREATE FUNCTION smarter_private.f06_try_lane(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE TABLE tournaments(id uuid PRIMARY KEY,status text,format_contract text,starting_chips numeric,addon_chips numeric,on_break boolean,current_level integer,blind_structure jsonb,variant text,tournament_type text,blind_level_state jsonb,level_started_at timestamptz);
CREATE TABLE engine_tournament_leases(tournament_id uuid PRIMARY KEY,lease_generation uuid,heartbeat_at timestamptz,instance_id text,engine_version text);
CREATE TABLE tables(id uuid PRIMARY KEY,tournament_id uuid,is_deleted boolean,status text,f06_lifecycle uuid,small_blind numeric,big_blind numeric,ante numeric,stakes text);
CREATE TABLE table_seats(id uuid PRIMARY KEY,table_id uuid,occupancy_id uuid,user_id uuid,seat_number integer,stack numeric,left_at timestamptz,joined_at timestamptz);
CREATE TABLE tournament_players(id uuid PRIMARY KEY,tournament_id uuid,table_id uuid,user_id uuid,seat_number integer,status text,chips numeric,add_on boolean);
CREATE TABLE hand_history(id uuid DEFAULT gen_random_uuid(),table_id uuid,tournament_id uuid,hand_number bigint,created_at timestamptz,ended_at timestamptz,players jsonb,small_blind numeric,big_blind numeric);
CREATE TABLE hand_atomic_commits(table_id uuid,hand_number bigint);
CREATE TABLE hand_private_state(table_id uuid,hand_number bigint);
CREATE TABLE table_hole_cards(table_id uuid,hand_number bigint,user_id uuid);
CREATE TABLE hand_discards(table_id uuid,hand_number bigint);
CREATE TABLE hand_state_snapshots(id uuid,table_id uuid,hand_number bigint,is_complete boolean,stage text,state_json jsonb,config_json jsonb,created_at timestamptz);
CREATE TABLE smarter_private.f06_generation_aborts(receipt_id uuid PRIMARY KEY,tournament_id uuid,generation uuid,expected jsonb,outcome text DEFAULT 'aborted_unsettled',UNIQUE(tournament_id,generation));
CREATE TABLE smarter_private.f06_generation_abort_hands(permit_id uuid PRIMARY KEY,receipt_id uuid,tournament_id uuid,generation uuid,table_id uuid,hand_number bigint,snapshot_id uuid,break_id uuid,expected jsonb);
CREATE TABLE smarter_private.f06_hand_permits(permit_id uuid PRIMARY KEY,tournament_id uuid,table_id uuid,generation uuid,state text,evidence_id uuid,lifecycle uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_hand_dispatch(permit_id uuid,xid bigint);
CREATE TABLE smarter_private.f06_operations(break_id uuid,tournament_id uuid,source_table_id uuid,state text,origin_generation uuid,lifecycle uuid,custody_generation uuid,manifest jsonb,close_receipt jsonb,cleanup_kind text,abort_receipt_id uuid,custody_id uuid);
CREATE TABLE smarter_private.f06_members(break_id uuid);
CREATE TABLE smarter_private.f06_attempts(break_id uuid);
CREATE TABLE smarter_private.f06_manager_custody_transfers(tournament_id uuid,transfer_id uuid);
CREATE TABLE smarter_private.f06_manager_custody_completions(transfer_id uuid);
CREATE TABLE smarter_private.hand_submissions(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.hand_submission_dispositions(table_id uuid,hand_number bigint,disposition text,submission_id uuid);
CREATE FUNCTION fixture_seed() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('addon-event')::uuid; tab uuid:=md5('addon-table')::uuid; u uuid; j integer;
BEGIN
 INSERT INTO tournaments(id,status,format_contract,starting_chips,addon_chips,current_level) VALUES(t,'RUNNING','mtt-v1',3000,10000,0);
 INSERT INTO engine_tournament_leases VALUES(t,md5('new-generation')::uuid,now(),'current','test');
 INSERT INTO tables(id,tournament_id,is_deleted,status,f06_lifecycle) VALUES(tab,t,false,'running',md5('lifecycle')::uuid);
 FOR j IN 1..2 LOOP
  u:=md5('addon-user'||j)::uuid;
  INSERT INTO table_seats VALUES(md5('addon-seat'||j)::uuid,tab,md5('occupancy'||j)::uuid,u,j,13000,NULL,now());
  INSERT INTO tournament_players VALUES(md5('addon-reg'||j)::uuid,t,tab,u,j,'playing',13000,true);
  INSERT INTO table_hole_cards VALUES(tab,11,u);
 END LOOP;
 INSERT INTO hand_history(table_id,tournament_id,hand_number,created_at,players)
 SELECT tab,t,10,now()-interval '1 hour',jsonb_agg(jsonb_build_object('userId',user_id,'stack',3000)) FROM table_seats;
 INSERT INTO smarter_private.f06_hand_permits VALUES(md5('addon-permit')::uuid,t,tab,md5('old-generation')::uuid,'reserved',NULL,md5('lifecycle')::uuid,11);
END $$;
