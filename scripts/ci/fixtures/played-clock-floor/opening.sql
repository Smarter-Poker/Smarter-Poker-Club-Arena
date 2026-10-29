SET LOCAL session_replication_role=replica;
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
'id','853b3df9-9e15-4d05-97b1-7a38dd0345c1','name','Native unavailable-field clock',
'current_level',16,'level_started_at',clock_timestamp()-interval '30 minutes',
'blind_level_state','{"index":16,"small_blind":1500,"big_blind":3000,"ante":0}'::jsonb,
'blind_structure',(SELECT jsonb_agg(CASE WHEN i=14 THEN '{"ante":0,"level":15,"bigBlind":2000,"smallBlind":1000,"durationMinutes":8}'::jsonb WHEN i=15 THEN '{"ante":0,"level":16,"bigBlind":2500,"smallBlind":1250,"durationMinutes":8}'::jsonb WHEN i=16 THEN jsonb_build_object('durationMinutes',8,'smallBlind',1500,'bigBlind',3000,'ante',0,'level',i+1) ELSE jsonb_build_object('durationMinutes',8,'smallBlind',25*(i+1),'bigBlind',50*(i+1),'ante',0,'level',i+1) END ORDER BY i) FROM generate_series(0,16)i)::text,
'on_break',false,'break_started_at',NULL,'break_ends_at',NULL))).* FROM public.tournaments t WHERE id='30000000-0000-0000-0000-000000000001';
DO $seed$
DECLARE tid uuid; i integer; u uuid; sid uuid;
BEGIN
FOREACH tid IN ARRAY ARRAY['2242461f-90c9-4443-9a89-ceb20b905f97','7c845d07-92e2-44e9-9122-51a2f28f4079','f855c60a-8223-4e83-88ae-8e32191f5c46']::uuid[] LOOP
 INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,small_blind,big_blind,ante,stakes,seat_game_scope,seat_admission_key)
 VALUES(tid,'Native clock table','853b3df9-9e15-4d05-97b1-7a38dd0345c1','running','live',6,'tournament','20000000-0000-0000-0000-000000000001',1500,3000,0,'1500/3000','table:'||tid,'tournament:853b3df9-9e15-4d05-97b1-7a38dd0345c1');
 UPDATE public.tables SET f06_lifecycle=1 WHERE id=tid;
 FOR i IN 1..6 LOOP
 u:=md5(tid::text||':user:'||i)::uuid;sid:=md5(tid::text||':seat:'||i)::uuid;
 INSERT INTO auth.users(id) VALUES(u);
 INSERT INTO public.users(id,username) VALUES(u,'clock-user-'||sid);
 INSERT INTO public.profiles(id,username,display_name) VALUES(u,'clock-user-'||sid,'Clock Native');
 INSERT INTO public.table_seats SELECT(jsonb_populate_record(NULL::public.table_seats,to_jsonb(s)||jsonb_build_object(
 'id',sid,'user_id',u,'table_id',tid,'seat_number',i,'stack',CASE tid WHEN '2242461f-90c9-4443-9a89-ceb20b905f97'::uuid THEN CASE WHEN i=6 THEN 44260 ELSE 40000 END WHEN '7c845d07-92e2-44e9-9122-51a2f28f4079'::uuid THEN CASE WHEN i=6 THEN 58409 ELSE 45000 END ELSE CASE WHEN i=6 THEN 97331 ELSE 80000 END END,
 'occupancy_id',md5(sid::text||':occupancy')::uuid,'active_game_scope','table:'||tid,
 'active_parent_key','tournament:853b3df9-9e15-4d05-97b1-7a38dd0345c1'))).* FROM public.table_seats s WHERE id='86300000-0000-0000-0000-000000000001';
 INSERT INTO public.tournament_players SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object(
 'id',md5(sid::text||':registration')::uuid,'tournament_id','853b3df9-9e15-4d05-97b1-7a38dd0345c1',
 'table_id',tid,'seat_number',i,'user_id',u,'chips',(SELECT stack::integer FROM public.table_seats WHERE id=sid),'status','playing',
 'position',NULL,'eliminated_at',NULL))).* FROM public.tournament_players tp WHERE id='31000000-0000-0000-0000-000000000001';
 END LOOP;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
 VALUES(md5(tid::text||':permit')::uuid,'853b3df9-9e15-4d05-97b1-7a38dd0345c1',tid,1,51229213,md5(tid::text||':custody')::uuid,'c6b911a0-0847-4bbf-82a5-f40fb5b915fd','reserved');
END LOOP;
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
 VALUES('853b3df9-9e15-4d05-97b1-7a38dd0345c1','1-dcee5724','a5dc7ff7',clock_timestamp(),clock_timestamp(),'96981566-3305-4907-8ae9-b0e377250d19',2);
INSERT INTO public.hand_history(id,tournament_id,table_id,hand_number,started_at,ended_at,created_at,small_blind,big_blind)
SELECT md5('clock-history:'||h.n)::uuid,'853b3df9-9e15-4d05-97b1-7a38dd0345c1','bce827d5-5b6d-4366-abc5-a5078689b8da',h.n,
CASE h.n WHEN 51233329 THEN '2026-10-28T23:16:09.455Z'::timestamptz WHEN 51233523 THEN '2026-10-28T23:16:28.672Z'::timestamptz ELSE '2026-10-28T23:17:12.252Z'::timestamptz END,
CASE h.n WHEN 51233329 THEN '2026-10-28T23:16:24.178Z'::timestamptz ELSE '2026-10-28T23:17:42.201Z'::timestamptz END,
'2026-10-28T23:17:42.36199Z',CASE h.n WHEN 51233329 THEN 1000 ELSE 1250 END,CASE h.n WHEN 51233329 THEN 2000 ELSE 2500 END
FROM unnest(ARRAY[51233329,51233523,51233858,51233989])h(n);
END $seed$;
INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,enforce_freeze,ownership_token)
VALUES(true,'counting_down',clock_timestamp()-interval '2 minutes',clock_timestamp(),clock_timestamp()+interval '5 minutes','Deployment Recovery',true,'77777777-0000-4000-8000-000000000001')
ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,announced_at=excluded.announced_at,break_started_at=excluded.break_started_at,break_ends_at=excluded.break_ends_at,reason=excluded.reason,enforce_freeze=excluded.enforce_freeze,ownership_token=excluded.ownership_token;
SET LOCAL session_replication_role=origin;
