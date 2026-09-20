CREATE FUNCTION fixture_seed_no_start() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('no-start')::uuid;tab uuid:=md5('no-start-table')::uuid;
 j integer;u uuid;st numeric;stacks jsonb;written jsonb;chips jsonb;
 payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}';
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','spin-v1',3,3);
 INSERT INTO engine_tournament_leases VALUES(t,'no-start-current','fixed',now(),now(),md5('no-start-current')::uuid,2);
 INSERT INTO tables(id,tournament_id,status,max_players) VALUES(tab,t,'running',3);
 FOR j IN 1..2 LOOP
  u:=md5('no-start-user'||j)::uuid;st:=CASE j WHEN 1 THEN 377 ELSE 223 END;
  INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
   VALUES(md5('no-start-seat'||j)::uuid,tab,u,j,st,md5('no-start-occupancy'||j)::uuid,
    '2026-09-18 04:17:41+00'::timestamptz+j*interval '1 second');
  INSERT INTO tournament_players VALUES(md5('no-start-registration'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 -- One player was canonically eliminated before the later positively unstarted hand.
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at,status)
 VALUES(md5('no-start-seat3')::uuid,tab,md5('no-start-user3')::uuid,3,0,
   md5('no-start-occupancy3')::uuid,'2026-09-18 04:17:44+00','2026-09-18 07:03:10.241595+00','left');
 INSERT INTO tournament_players VALUES(md5('no-start-registration3')::uuid,t,tab,
   md5('no-start-user3')::uuid,3,0,'eliminated');
 SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack',stack,'stack_before',stack) ORDER BY user_id),
  jsonb_object_agg(user_id::text,stack),jsonb_agg(jsonb_build_object('user_id',user_id,'chips',stack) ORDER BY user_id)
 INTO stacks,written,chips FROM table_seats WHERE table_id=tab;
 INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,payload_hash,stack_result,
   committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
 VALUES(tab,12428969,md5('no-start-atomic')::uuid,'2026-09-18 07:03:10.498154+00',
  jsonb_build_object('ok',true,'hand_id',md5('no-start-atomic')::uuid,'hand_number',12428969),repeat('c',64),
  jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',12428969,
   'hand_id',md5('no-start-stack')::uuid,'conservation_checked',true,'tournament_players_synced',true,
   'rebased','{}'::jsonb,'departed','[]'::jsonb,'players',3,'tournament_player_count',3,
   'tournament_zero_stack_vacated_at','2026-09-18 07:03:10.241595+00',
   'tournament_zero_stack_seat_generations',jsonb_build_array(jsonb_build_object(
     'seat_id',md5('no-start-seat3')::uuid,'user_id',md5('no-start-user3')::uuid,
     'seat_number',3,'joined_at','2026-09-18 04:17:44+00')),
   'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'request',jsonb_build_object('stacks',stacks),'written',written,'tournament_player_chips',chips),
  '2026-09-18 07:03:10.241595+00',payload,
  encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
 INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('no-start-atomic')::uuid,tab,12428969);
 INSERT INTO smarter_private.f06_hand_permits SELECT md5('no-start-permit')::uuid,t,tab,f06_lifecycle,12429075,
  md5('no-start-custody')::uuid,md5('no-start-old')::uuid,'reserved',NULL FROM tables WHERE id=tab;

END $$;
