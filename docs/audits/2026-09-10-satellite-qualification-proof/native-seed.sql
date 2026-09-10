\set ON_ERROR_STOP on
BEGIN;
DO $local_only$ BEGIN
  IF current_setting('data_directory') NOT LIKE '/tmp/codex-satellite-cohort-pg17/%'
     OR current_database()<>'satellite_qualification_verified' THEN
    RAISE EXCEPTION 'Private native qualification fixture only';
  END IF;
END; $local_only$;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SELECT set_config('app.money_path','fn_settle_satellite_tournament',true);
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||
 jsonb_build_object('id','e1000000-0000-4000-8000-000000000002','name','Equal Qualifier Target',
 'status','REGISTERING','prize_pool',0,'total_rake',0,'buy_in_amount',180,'buy_in_fee',20,
 'prize_pool_finalized',true,'current_players',0,'ended_at',now()))).*
FROM public.tournaments t WHERE id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||
 jsonb_build_object('id','e1000000-0000-4000-8000-000000000001','name','Equal Qualifier Source',
 'variant','satellite','tournament_type','SATELLITE','status','REGISTERING',
 'satellite_target_id','e1000000-0000-4000-8000-000000000002',
 'blind_structure','[{"level":1,"smallBlind":10,"bigBlind":20,"durationMinutes":3}]','min_players',2,'rebuy_levels',0,'late_reg_mins',0,'satellite_seats',3,'prize_pool',600,'total_rake',0,'buy_in_amount',200,
 'prize_pool_finalized',false,'current_players',0))).*
FROM public.tournaments t WHERE id='30000000-0000-0000-0000-000000000001';
INSERT INTO auth.users(id) VALUES ('47965354-0e56-43ef-931c-ddaab82af765') ON CONFLICT(id) DO NOTHING;
INSERT INTO auth.users(id) VALUES ('e1000000-0000-4000-8000-000000000004');
INSERT INTO public.profiles(id,username,display_name)
VALUES ('e1000000-0000-4000-8000-000000000004','equal_qualifier_two','Equal Qualifier Two')
ON CONFLICT(id) DO NOTHING;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,status,role) VALUES ('20000000-0000-0000-0000-000000000001','e1000000-0000-4000-8000-000000000004','active','player');
INSERT INTO auth.users(id) VALUES ('e1000000-0000-4000-8000-000000000005');
INSERT INTO public.club_members(club_id,user_id,status,role) VALUES('20000000-0000-0000-0000-000000000001','e1000000-0000-4000-8000-000000000005','active','player');
INSERT INTO public.tables(id,name,club_id,tournament_id,status,game_type)
VALUES('e1000000-0000-4000-8000-000000000009','Qualification Native Source',
 '20000000-0000-0000-0000-000000000001','e1000000-0000-4000-8000-000000000001','running','tournament');
INSERT INTO public.tournament_players(tournament_id,user_id,status,chips,table_id,seat_number)
VALUES('e1000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000001','registered',0,NULL,NULL),
 ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004','registered',0,NULL,NULL),
 ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000005','registered',0,NULL,NULL);
COMMIT;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SELECT set_config('app.money_path','fn_settle_satellite_tournament',true);
SELECT public.fn_tournament_management_readiness_for_row(to_jsonb(t)||'{"status":"RUNNING"}'::jsonb) FROM public.tournaments t WHERE id='e1000000-0000-4000-8000-000000000001';
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,lease_generation,protocol_version) VALUES('e1000000-0000-4000-8000-000000000001','qualification-native-probe','e1000000-0000-4000-8000-000000000051',2);
SELECT public.fn_begin_tournament_launch_atomic('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000050',now(),'e1000000-0000-4000-8000-000000000051');
SELECT public.fn_assign_tournament_player_seat_atomic('e1000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000001','e1000000-0000-4000-8000-000000000009',1);
SELECT public.fn_assign_tournament_player_seat_atomic('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004','e1000000-0000-4000-8000-000000000009',2);
SELECT public.fn_assign_tournament_player_seat_atomic('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000005','e1000000-0000-4000-8000-000000000009',3);
SELECT public.fn_complete_tournament_launch_atomic('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000050','e1000000-0000-4000-8000-000000000051');
SELECT public.fn_close_tournament_entry_window('e1000000-0000-4000-8000-000000000001','qualification.native.fixture');
SELECT public.fn_ca_escrow_apply('e1000000-0000-4000-8000-000000000001','Open disposable settlement fixture');
SELECT public.fn_ca_escrow_apply('e1000000-0000-4000-8000-000000000001','Disposable funded settlement fixture',p_gross_in=>600);
SELECT public.fn_materialize_satellite_entitlements_locked('e1000000-0000-4000-8000-000000000001');
