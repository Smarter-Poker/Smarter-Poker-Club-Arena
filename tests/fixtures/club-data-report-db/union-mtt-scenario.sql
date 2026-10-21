-- Private PostgreSQL fixture only. No production endpoint is used.
TRUNCATE ca_club_data_fact,club_table_daily,ca_club_tournament_daily,ca_club_tournament_player_daily;
UPDATE table_seats SET left_at=now();
INSERT INTO unions VALUES ('fade0000-0000-0000-0000-000000000001','Midway Union','00000000-0000-0000-0000-0000000000a1');
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
 s:=public.ca_club_data_screen('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'MTT','ALL',NULL,200);
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
 IF (pg->>'filtered_count')::integer<>5 OR (SELECT sum((x->>'winnings')::numeric) FROM jsonb_array_elements(pg->'rows') x)<>22 THEN RAISE EXCEPTION 'Paged rows fail reconciliation: %',pg; END IF;
 IF (SELECT sum((x->>'fee')::numeric) FROM jsonb_array_elements(pg->'rows') x)<>24.01 THEN RAISE EXCEPTION 'Paged fees fail reconciliation: %',pg; END IF;
 IF (SELECT sum(winnings) FROM public.fn_ca_club_games('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'ALL','ALL',NULL))<>22 THEN RAISE EXCEPTION 'Export winnings disagree'; END IF;
 r:=public.ca_club_player_breakdown('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,200);
 IF (r->>'player_count')::integer<2 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'players') x WHERE x->>'user_id'='00000000-0000-0000-0000-0000000000b2') THEN RAISE EXCEPTION 'Union player breakdown missed member club: %',r; END IF;
 pg:=public.ca_club_player_page_core_20261006('fade0000-0000-0000-0000-000000000001',CURRENT_DATE,CURRENT_DATE,'winners',NULL,NULL,200);
 IF (pg->>'filtered_count')::integer<>(r->>'player_count')::integer THEN RAISE EXCEPTION 'Player pagination scope disagrees'; END IF;
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
DO $test$ BEGIN RAISE NOTICE 'UNION MTT SCENARIO PASSED'; END $test$;
