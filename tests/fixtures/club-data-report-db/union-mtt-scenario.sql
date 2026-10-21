-- Private PostgreSQL fixture only. No production endpoint is used.
TRUNCATE ca_club_data_fact,club_table_daily,ca_club_tournament_daily,ca_club_tournament_player_daily;
-- This private fixture owns a complete 31-day synthetic fact history.
INSERT INTO ca_club_data_fact_seed_log(from_at,to_at,rows_put) VALUES(CURRENT_DATE-30,CURRENT_DATE-1,1);
UPDATE table_seats SET left_at=now();
INSERT INTO unions VALUES ('fade0000-0000-0000-0000-000000000001','Midway Union','00000000-0000-0000-0000-0000000000a1');
INSERT INTO clubs(id,name) VALUES('fade0000-0000-0000-0000-000000000001','Midway Union Account'),('88000000-0000-0000-0000-000000000099','Empty Member Club') ON CONFLICT DO NOTHING;
INSERT INTO union_clubs(union_id,club_id) VALUES('fade0000-0000-0000-0000-000000000001','88000000-0000-0000-0000-000000000099');
INSERT INTO tournaments(id,club_id,union_id,name,tournament_type,status,start_time) VALUES
('88000000-0000-0000-0000-000000000001','fade0000-0000-0000-0000-000000000001','fade0000-0000-0000-0000-000000000001','Fixture SNG','SNG','COMPLETED',now()),
('88000000-0000-0000-0000-000000000002','fade0000-0000-0000-0000-000000000001','fade0000-0000-0000-0000-000000000001','Fixture Spin','SPIN','COMPLETED',now()),
('88000000-0000-0000-0000-000000000003','fade0000-0000-0000-0000-000000000001','fade0000-0000-0000-0000-000000000001','Direct Union MTT','MTT','COMPLETED',now());
INSERT INTO ca_club_data_fact(club_id,stat_date,kind,game_id,user_id,fee,buyins,cashouts,winnings,last_at) VALUES
('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,'CASH','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',2.005,100,0,-100,now()),
('a4143400-0000-0000-0000-000000000001',CURRENT_DATE,'CASH','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b2',2.005,50,0,-50,now()),
('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,'TOURNAMENT','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',10,100,130,30,now()),
('a4143400-0000-0000-0000-000000000001',CURRENT_DATE,'TOURNAMENT','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b2',5,50,20,-30,now()),
('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,'TOURNAMENT','88000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1',1,10,5,-5,now()),
('a4143400-0000-0000-0000-000000000001',CURRENT_DATE,'TOURNAMENT','88000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000b2',2,10,20,10,now()),
('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,'TOURNAMENT','88000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000a1',2,10,17,7,now());
INSERT INTO table_seats(table_id,user_id,club_id,stack,joined_at) VALUES
('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','a0000000-0000-0000-0000-000000000001',120,now()),
('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b2','a4143400-0000-0000-0000-000000000001',40,now());
INSERT INTO tournaments(id,club_id,name,tournament_type,status,start_time) VALUES('88000000-0000-0000-0000-000000000004','fade0000-0000-0000-0000-000000000001','Satellite Is Not MTT','SATELLITE','COMPLETED',now()-interval '1 day');
INSERT INTO ca_club_data_fact(club_id,stat_date,kind,game_id,user_id,fee,buyins,cashouts,winnings,last_at) VALUES('fade0000-0000-0000-0000-000000000001',CURRENT_DATE-1,'TOURNAMENT','88000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000a1',0,0,0,0,now()-interval '1 day');
INSERT INTO tournaments(id,club_id,name,tournament_type,status,start_time) VALUES('88000000-0000-0000-0000-000000000005','fade0000-0000-0000-0000-000000000001','Earlier MTT','MTT','COMPLETED',now()-interval '20 days');
INSERT INTO ca_club_data_fact(club_id,stat_date,kind,game_id,user_id,fee,buyins,cashouts,winnings,last_at) VALUES('fade0000-0000-0000-0000-000000000001',CURRENT_DATE-20,'TOURNAMENT','88000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000a1',1,10,23,13,now()-interval '20 days');
SELECT public.fn_ca_reporting_rollups_from_facts(CURRENT_DATE-20);
SELECT public.fn_ca_reporting_rollups_from_facts(CURRENT_DATE-1);
SELECT public.fn_ca_reporting_rollups_from_facts(CURRENT_DATE);
INSERT INTO member_record_daily_facts VALUES
('a0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1',CURRENT_DATE,false,20,5,NULL),
('a4143400-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b2',CURRENT_DATE,false,-10,5,NULL);

DO $test$
DECLARE s jsonb; r jsonb; pg jsonb;
BEGIN
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,1);
 IF s->'summary'->>'games'<>'5' OR s->'summary'->>'mtt_winnings'<>'7.00' OR s->'summary'->>'total_winnings'<>'22.00' OR s->'summary'->>'fee'<>'24.01' THEN RAISE EXCEPTION 'Union totals wrong: %',s; END IF;
 IF (s->'summary'->>'live_games')::integer<=jsonb_array_length(s->'rows') THEN RAISE EXCEPTION 'live count was limited by page: %',s; END IF;
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE-1,CURRENT_DATE,'MTT','ALL',NULL,200);
 IF s->'summary'->>'games'<>'2' OR s->'summary'->>'mtt_winnings'<>'7.00' OR s->'summary'->>'total_winnings'<>'7.00' THEN RAISE EXCEPTION 'MTT includes SNG/Spin or misses a member club: %',s; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'rows') x WHERE x->>'kind'<>'MTT') THEN RAISE EXCEPTION 'MTT row misclassified'; END IF;
 s:=public.ca_club_data_screen('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,200);
 IF s->'summary'->>'total_winnings'<>'45.00' OR s->'summary'->>'mtt_winnings'<>'30.00' OR s->'summary'->>'games'<>'3' THEN RAISE EXCEPTION 'Club scope changed: %',s; END IF;
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'SNG','ALL',NULL,200);
 IF (s->'summary'->>'mtt_winnings')::numeric<>0 OR (s->'summary'->>'total_winnings')::numeric<>-5 THEN RAISE EXCEPTION 'SNG slice leaks into MTT'; END IF;
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL','Fixture',200);
 IF (s->'summary'->>'mtt_winnings')::numeric<>0 OR (s->'summary'->>'total_winnings')::numeric<>5 OR (s->'summary'->>'games')::integer<>2 THEN RAISE EXCEPTION 'Search totals disagree: %',s; END IF;
 r:=public.ca_club_data_snapshot_v2('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,200);
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,200);
 IF ((r->'summary')-'hands')<>((s->'summary')-'hands') THEN RAISE EXCEPTION 'Report and screen totals disagree: %, %',r->'summary',s->'summary'; END IF;
 SELECT public.ca_club_game_page_core_20261006('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,'winnings',NULL,200) INTO pg;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(pg->'rows') x WHERE x->>'kind'='CASH' AND (x->>'on_felt')::numeric=160 AND (x->>'live')::boolean) THEN RAISE EXCEPTION 'Paged cash lost live felt metadata: %',pg; END IF;
 IF (pg->>'filtered_count')::integer<>5 OR (SELECT sum((x->>'winnings')::numeric) FROM jsonb_array_elements(pg->'rows') x)<>22 THEN RAISE EXCEPTION 'Paged rows fail reconciliation: %',pg; END IF;
 IF (SELECT sum((x->>'fee')::numeric) FROM jsonb_array_elements(pg->'rows') x)<>24.01 THEN RAISE EXCEPTION 'Paged fees fail reconciliation: %',pg; END IF;
 IF (SELECT sum(winnings) FROM public.fn_ca_club_games('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL))<>22 THEN RAISE EXCEPTION 'Export winnings disagree'; END IF;
 PERFORM set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);
 r:=public.ca_rake_snapshot_v2('union',NULL,'fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,NULL,200);
 IF (r->'summary'->>'total_winnings')::numeric<>22 OR (r->'summary'->>'mtt_winnings')::numeric<>7 OR (r->'summary'->>'fee')::numeric<>24.01 OR (r->'summary'->>'games')::integer<>5 THEN RAISE EXCEPTION 'Dedicated union page disagrees: %',r; END IF;
 IF jsonb_array_length(r->'breakdown')<>4 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'breakdown') x WHERE x->>'name'='Empty Member Club') THEN RAISE EXCEPTION 'Union breakdown omitted empty member club: %',r; END IF;
 IF (SELECT sum((x->>'winnings')::numeric) FROM jsonb_array_elements(r->'series') x)<>22 THEN RAISE EXCEPTION 'Series does not reconcile'; END IF;
 r:=public.ca_club_data_snapshot_v2('fade0000-0000-0000-0000-000000000001',CURRENT_DATE-30,CURRENT_DATE,'ALL','ALL',NULL,200);
 IF (r->'summary'->>'total_winnings')::numeric<>35 OR (r->'summary'->>'mtt_winnings')::numeric<>20 OR (r->>'row_count')::integer<>7 OR jsonb_array_length(r->'rows')<>7 THEN RAISE EXCEPTION 'Long window totals and rows disagree: %',r; END IF;
 r:=public.ca_club_data_snapshot('fade0000-0000-0000-0000-000000000001',CURRENT_DATE-30,CURRENT_DATE,'ALL','ALL',NULL,200);
 IF (r->'summary'->>'mtt_winnings')::numeric<>25 OR (r->'summary'->>'tournament_winnings')::numeric<>25 THEN RAISE EXCEPTION 'Open legacy client contract changed'; END IF;
 r:=public.ca_club_player_breakdown('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,200);
 IF (r->>'player_count')::integer<2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'players') x WHERE x->>'user_id'='00000000-0000-0000-0000-0000000000b2') THEN RAISE EXCEPTION 'Union player breakdown missed member club: %',r; END IF;
 pg:=public.ca_club_player_page_core_20261006('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'winners',NULL,NULL,200);
 IF (pg->>'filtered_count')::integer<>(r->>'player_count')::integer THEN RAISE EXCEPTION 'Player pagination scope disagrees'; END IF;
END $test$;
-- A zero-fee or negative adjustment is not an additional raked cash hand.
DO $test$ DECLARE before_count bigint; after_count bigint; BEGIN
 before_count:=public.fn_ca_club_data_hand_count('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL);
 INSERT INTO rake_records(table_id,tournament_id,is_tournament,rake_amount,created_at) VALUES
 ('00000000-0000-0000-0000-0000000000c1',NULL,false,0,now()),
 ('00000000-0000-0000-0000-0000000000c1',NULL,false,-1,now());
 after_count:=public.fn_ca_club_data_hand_count('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL);
 IF before_count<>after_count THEN RAISE EXCEPTION 'Adjustment counted as another hand'; END IF;
END $test$;
UPDATE clubs SET owner_id='00000000-0000-0000-0000-0000000000b3' WHERE id='a0000000-0000-0000-0000-000000000001';
-- True authorization boundary: role and session_user are the browser transport.
\connect live authenticator 127.0.0.1 @PORT@
SET ROLE authenticated;
SELECT set_config('test.role','authenticated',false);
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a2',false);
DO $test$ BEGIN
 BEGIN PERFORM public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE); RAISE EXCEPTION 'agent saw union'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF public.fn_ca_club_data_scope('a0000000-0000-0000-0000-000000000001') IS DISTINCT FROM 'downline' THEN RAISE EXCEPTION 'agent downline scope lost'; END IF;
END $test$;
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000b3',false);
DO $test$ BEGIN
 IF (public.ca_club_data_screen('a0000000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE)->'summary'->>'games')::integer<>3 THEN RAISE EXCEPTION 'member club owner cannot read own club'; END IF;
 BEGIN PERFORM public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE); RAISE EXCEPTION 'member club owner saw whole union'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);
DO $test$ BEGIN
 IF (public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE)->'summary'->>'games')::integer<>5 THEN RAISE EXCEPTION 'union overseer cannot read union'; END IF;
END $test$;
DO $test$ DECLARE r jsonb; again jsonb; BEGIN
 r:=public.ca_rake_export_start_v2('union','fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,NULL,NULL,'rake','88000000-0000-0000-0000-000000000088');
 IF (r->>'total_rows')::integer<>4 OR (r->>'total_amount')::numeric<>24.01 THEN RAISE EXCEPTION 'Export disagrees: %',r; END IF;
 again:=public.ca_rake_export_start_v2('union','fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,NULL,NULL,'rake','88000000-0000-0000-0000-000000000088');
 IF again<>r THEN RAISE EXCEPTION 'Export request replay changed receipt'; END IF;
END $test$;
\connect live postgres 127.0.0.1 @PORT@
DO $test$ BEGIN
 IF (SELECT round(sum((payload->>'fee')::numeric),2) FROM ca_club_data_export_rows)<>24.01 THEN RAISE EXCEPTION 'Immutable export precision disagrees'; END IF;
 IF (SELECT sum((payload->>'winnings')::numeric) FROM ca_club_data_export_rows)<>22 THEN RAISE EXCEPTION 'Immutable export rows disagree'; END IF;
END $test$;
DO $test$ DECLARE pg jsonb; BEGIN
 UPDATE table_seats SET left_at=now();
 pg:=public.ca_club_game_page_core_20261006('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,'recent',NULL,200);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(pg->'rows') x WHERE x->>'kind'='CASH' AND (x->>'players')::integer=2 AND NOT (x->>'live')::boolean) THEN RAISE EXCEPTION 'Closed union cash game missed distinct players: %',pg; END IF;
 IF (SELECT players FROM public.fn_ca_club_games('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL) WHERE kind='CASH')<>2 THEN RAISE EXCEPTION 'Export player count differs'; END IF;
END $test$;
-- Exact immutable game export, including union scope and fractional fees.
DELETE FROM ca_club_data_export_rows WHERE true;
DELETE FROM ca_club_data_exports WHERE true;
UPDATE table_seats s SET left_at=NULL WHERE s.table_id='00000000-0000-0000-0000-0000000000c1' AND s.stack IN(120,40) AND s.joined_at=(SELECT max(x.joined_at) FROM table_seats x WHERE x.table_id=s.table_id AND x.user_id=s.user_id);
INSERT INTO tables(id,club_id,name,big_blind) VALUES
 ('88000000-0000-0000-0000-000000000011','fade0000-0000-0000-0000-000000000001','Fractional Fee One',0.5),
 ('88000000-0000-0000-0000-000000000012','fade0000-0000-0000-0000-000000000001','Fractional Fee Two',0.5);
INSERT INTO ca_club_data_fact(club_id,stat_date,kind,game_id,user_id,fee,last_at) VALUES
 ('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,'CASH','88000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-0000000000a1',0.0049,now()),
 ('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,'CASH','88000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-0000000000a1',0.0049,now());
SELECT public.fn_ca_reporting_rollups_from_facts(CURRENT_DATE);
\connect live authenticator 127.0.0.1 @PORT@
SET ROLE authenticated;
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);
DO $test$ DECLARE r jsonb; again jsonb; BEGIN
 r:=public.ca_club_game_export_start('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,'fee','88000000-0000-0000-0000-000000000091');
 IF (r->>'total_rows')::integer<>7 THEN RAISE EXCEPTION 'Game CSV missed union clubs: %',r; END IF;
 again:=public.ca_club_game_export_start('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,'fee','88000000-0000-0000-0000-000000000091');
 IF again<>r THEN RAISE EXCEPTION 'Game export replay changed receipt'; END IF;
END $test$;
\connect live postgres 127.0.0.1 @PORT@
DO $test$ DECLARE pg jsonb; BEGIN
 IF (SELECT round(sum((payload->>'fee_exact')::numeric),2) FROM ca_club_data_export_rows)<>24.02 OR (SELECT sum((payload->>'fee')::numeric) FROM ca_club_data_export_rows)<>24.01 THEN RAISE EXCEPTION 'Exact CSV shares were rounded before totaling'; END IF;
 IF (SELECT sum((payload->>'winnings')::numeric) FROM ca_club_data_export_rows)<>22 THEN RAISE EXCEPTION 'Game CSV missed cash stacks'; END IF;
 pg:=public.ca_club_game_page_core_20261006('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL,'fee',NULL,200);
 IF (SELECT round(sum((x->>'fee_exact')::numeric),2) FROM jsonb_array_elements(pg->'rows') x)<>24.02 THEN RAISE EXCEPTION 'Paged fee precision differs'; END IF;
END $test$;
DELETE FROM ca_club_data_export_rows WHERE true;
DELETE FROM ca_club_data_exports WHERE true;
\connect live authenticator 127.0.0.1 @PORT@
SET ROLE authenticated;
SELECT set_config('test.uid','00000000-0000-0000-0000-0000000000a1',false);
DO $test$ DECLARE r jsonb; BEGIN
 r:=public.ca_club_game_export_start('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'MTT','ALL',NULL,'recent','88000000-0000-0000-0000-000000000092');
 IF (r->>'total_rows')::integer<>2 THEN RAISE EXCEPTION 'Game MTT CSV includes other formats'; END IF;
END $test$;
\connect live postgres 127.0.0.1 @PORT@
DO $test$ BEGIN
 IF EXISTS(SELECT 1 FROM ca_club_data_export_rows WHERE payload->>'kind'<>'MTT') THEN RAISE EXCEPTION 'MTT export row misclassified'; END IF;
END $test$;
DO $test$ BEGIN RAISE NOTICE 'UNION MTT SCENARIO PASSED'; END $test$;
