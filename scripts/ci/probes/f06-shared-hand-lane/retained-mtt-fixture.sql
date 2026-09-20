-- Isolated synthetic fixtures mirror both proven original boundaries. No active
-- production identities, cards, wallets or financial payer are used here.
ALTER TABLE tournament_seat_move_receipts ADD COLUMN tournament_id uuid, ADD COLUMN user_id uuid,
 ADD COLUMN source_table_id uuid, ADD COLUMN destination_table_id uuid,
 ADD COLUMN source_seat_id uuid, ADD COLUMN destination_seat_id uuid,
 ADD COLUMN source_seat_number integer, ADD COLUMN destination_seat_number integer,
 ADD COLUMN source_mode text, ADD COLUMN stack numeric, ADD COLUMN moved_at timestamptz;
CREATE UNIQUE INDEX fixture_move_receipt_identity ON tournament_seat_move_receipts(request_id);
CREATE FUNCTION fixture_retained_atomic(i integer,which text,n bigint,zero_only boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('rm-event'||i)::uuid;tab uuid:=md5('rm-table'||i)::uuid;
 payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}';
 stacks jsonb; written jsonb; chips jsonb; count_players integer; stamp timestamptz;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
 'stack',CASE WHEN zero_only AND seat_number=1 THEN stack+37000 ELSE stack END,
 'stack_before',CASE WHEN zero_only AND seat_number=3 THEN 37000 ELSE stack END) ORDER BY user_id),
 jsonb_object_agg(user_id::text,CASE WHEN zero_only AND seat_number=1 THEN stack+37000 ELSE stack END),
 jsonb_agg(jsonb_build_object('user_id',user_id,'chips',CASE WHEN zero_only AND seat_number=1 THEN stack+37000 ELSE stack END) ORDER BY user_id),count(*)
 INTO stacks,written,chips,count_players FROM table_seats WHERE table_id=tab
 AND CASE WHEN zero_only THEN seat_number IN(1,3) ELSE seat_number IN(1,2,4) END;
 stamp:=CASE WHEN zero_only THEN '2026-09-18 22:12:05+00'::timestamptz ELSE '2026-09-18 22:12:25+00'::timestamptz END;
 INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,payload_hash,
 stack_result,committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
 VALUES(tab,n,md5('rm-atomic-'||which||i)::uuid,stamp+interval '2 seconds',
 jsonb_build_object('ok',true,'hand_id',md5('rm-atomic-'||which||i)::uuid,'hand_number',n),repeat('a',64),
 jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',n,
 'hand_id',md5('rm-stack-'||which||i)::uuid,'conservation_checked',true,'tournament_players_synced',true,
 'rebased','{}'::jsonb,'departed','[]'::jsonb,'players',count_players,'tournament_player_count',count_players,
 'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'request',jsonb_build_object('stacks',stacks),'written',written,'tournament_player_chips',chips),
 stamp,payload,encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
 encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
 INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('rm-atomic-'||which||i)::uuid,tab,n);
 INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,result,error,attempt_count,first_attempt_at,last_attempt_at,completed_at)
 SELECT tab,md5('rm-stack-'||which||i)::uuid,'succeeded',stack_result,NULL,1,stamp,stamp+interval '2 seconds',stamp+interval '2 seconds'
 FROM hand_atomic_commits WHERE hand_id=md5('rm-atomic-'||which||i)::uuid;
 INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id,idempotency_key,totals,error_detail,created_at,updated_at)
 VALUES('hand_stacks',tab::text||':'||md5('rm-stack-'||which||i)::uuid::text,'final',tab,md5('rm-stack-'||which||i)::uuid,
 'hand:'||tab::text||':'||md5('rm-stack-'||which||i)::uuid::text,'{}',NULL,stamp,stamp+interval '2 seconds');
END $$;
CREATE FUNCTION fixture_seed_retained_mtt(i integer,with_snapshot boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('rm-event'||i)::uuid;tab uuid:=md5('rm-table'||i)::uuid;g uuid:=md5('rm-generation'||i)::uuid;
 src uuid;u uuid;b uuid;request uuid; j integer; st numeric;stamp timestamptz;mr tournament_seat_move_receipts;
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','mtt-v1',9,CASE WHEN with_snapshot THEN 2 ELSE 6 END);
 INSERT INTO engine_tournament_leases VALUES(t,'rm-process','8825-test','2026-09-18 21:55:00+00','2026-09-18 22:15:00+00',g,2);
 INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'running');
 FOR j IN 1..CASE WHEN with_snapshot THEN 2 ELSE 6 END LOOP
 u:=md5('rm-user'||i||':'||j)::uuid;
 st:=CASE WHEN with_snapshot THEN (ARRAY[46125,88875])[j] ELSE (ARRAY[188949,386750,0,23000,84000,24000])[j] END;
 stamp:=CASE j WHEN 5 THEN '2026-09-18 22:12:19+00'::timestamptz WHEN 6 THEN '2026-09-18 22:12:31+00'::timestamptz ELSE '2026-09-18 21:00:00+00'::timestamptz END;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at)
 VALUES(md5('rm-seat'||i||':'||j)::uuid,tab,u,j,st,md5('rm-occupancy'||i||':'||j)::uuid,stamp,
 CASE WHEN NOT with_snapshot AND j=3 THEN '2026-09-18 22:12:06+00'::timestamptz ELSE NULL END);
 INSERT INTO tournament_players VALUES(md5('rm-reg'||i||':'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 IF with_snapshot THEN
 INSERT INTO hand_state_snapshots(id,table_id,hand_number,state_json)
 SELECT md5('rm-snapshot'||i)::uuid,tab,10003,jsonb_build_object('stage','preflop','actionHistory','[]'::jsonb,'pot',90000,
 'players',jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,
 'stack',CASE seat_number WHEN 1 THEN 0 ELSE 45000 END,
 'totalInvested',CASE seat_number WHEN 1 THEN 46125 ELSE 43875 END,'deadInvested',0,
 'individualAnteInvested',0,'returnedUncalled',0) ORDER BY seat_number)) FROM table_seats WHERE table_id=tab;
 INSERT INTO table_hole_cards(table_id,hand_number,user_id,seat_number)
 SELECT tab,10003,user_id,seat_number FROM table_seats WHERE table_id=tab;
 ELSE
 PERFORM fixture_retained_atomic(i,'zero',10001,true);
 PERFORM fixture_retained_atomic(i,'prior',10002,false);
 END IF;
 -- Preserve an acknowledged old-origin move and a begun old-origin move. The
 -- first arrival PRECEDES the last accepted hand but was not its participant.
 FOR j IN 1..2 LOOP
 src:=md5('rm-source'||i||':'||j)::uuid;b:=md5('rm-break'||i||':'||j)::uuid;
 request:=md5('rm-move'||i||':'||j)::uuid;u:=md5('rm-user'||i||':'||(j+4))::uuid;
 INSERT INTO tables(id,tournament_id,status) VALUES(src,t,CASE j WHEN 1 THEN 'closed' ELSE 'running' END);
 IF NOT with_snapshot THEN
 SELECT joined_at,stack INTO stamp,st FROM table_seats WHERE id=md5('rm-seat'||i||':'||(j+4))::uuid;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at)
 VALUES(md5('rm-source-seat'||i||':'||j)::uuid,src,u,j,0,md5('rm-source-occupancy'||i||':'||j)::uuid,'2026-09-18 20:00:00+00',stamp);
 END IF;
 INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,
 state,manifest,revision,custody_id,custody_generation,cleanup_kind,close_receipt)
 SELECT b,t,src,f06_lifecycle,md5('rm-boundary'||i||':'||j)::uuid,md5('rm-old-generation'||i||':'||j)::uuid,
 CASE j WHEN 1 THEN 'acknowledged' ELSE 'begun' END,'[]',1,md5('rm-custody'||i||':'||j)::uuid,g,
 CASE j WHEN 1 THEN 'retired' ELSE NULL END,CASE j WHEN 1 THEN '{"ok":true}'::jsonb ELSE NULL END FROM tables WHERE id=src;
 IF NOT with_snapshot THEN
 INSERT INTO smarter_private.f06_members SELECT b,u,id,j,occupancy_id FROM table_seats WHERE id=md5('rm-source-seat'||i||':'||j)::uuid;
 INSERT INTO tournament_seat_move_receipts VALUES(request,t,u,src,tab,md5('rm-source-seat'||i||':'||j)::uuid,
 md5('rm-seat'||i||':'||(j+4))::uuid,j,j+4,'live_source',st,stamp) RETURNING * INTO mr;
 INSERT INTO smarter_private.f06_attempts(request_id,break_id,user_id,revision,destination_table_id,destination_seat_number,generation,state,receipt)
 SELECT request,b,u,1,tab,j+4,g,'winner',to_jsonb(mr)||jsonb_build_object('break_id',b,'source_lifecycle',f06_lifecycle::text,
 'source_occupancy_id',(SELECT occupancy_id FROM table_seats WHERE id=md5('rm-source-seat'||i||':'||j)::uuid)) FROM tables WHERE id=src;
 END IF;
 END LOOP;
 INSERT INTO smarter_private.f06_hand_permits SELECT md5('rm-permit'||i)::uuid,t,tab,f06_lifecycle,10003,
 md5('rm-hand-custody'||i)::uuid,g,'reserved',NULL FROM tables WHERE id=tab;
END $$;
CREATE FUNCTION fixture_retained_input(i integer,with_snapshot boolean) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('kind','retained_mtt_interruption_v1','tournament_id',l.tournament_id,'generation',l.lease_generation,
 'lease',to_jsonb(l),'physical',jsonb_build_object('instance_id',l.instance_id,'source',l.engine_version,'generation',l.lease_generation,
 'evidence_sha256',repeat('e',64),'process_id','fixture-only','container_id','isolated-native-postgres',
 'manager_id',md5('rm-manager'||i)::uuid,'engine_id',md5('rm-engine'||i)::uuid,'table_id',h.table_id,'permit_id',h.permit_id,
 'all_processes_accounted',true,'all_owned_work_joined',true,'original_stop_completed',true),
 'accepted_zeros',CASE WHEN with_snapshot THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
 'registration_id',md5('rm-reg'||i||':3')::uuid,'seat_id',md5('rm-seat'||i||':3')::uuid,
 'atomic_hand_id',md5('rm-atomic-zero'||i)::uuid,'stack_hand_id',md5('rm-stack-zero'||i)::uuid)) END,
 'hands',jsonb_build_array(jsonb_build_object('permit',to_jsonb(h),
 'prior',CASE WHEN with_snapshot THEN NULL ELSE fixture_expected_mixed(l.tournament_id)#>'{hands,0,prior}' END,
 'interruption',jsonb_build_object('kind',CASE WHEN with_snapshot THEN 'original_preflop_snapshot' ELSE 'prior_commit_plus_inbound_moves' END,
 'inbound_requests',CASE WHEN with_snapshot THEN '[]'::jsonb ELSE
 (SELECT jsonb_agg(request_id ORDER BY request_id) FROM tournament_seat_move_receipts WHERE tournament_id=l.tournament_id) END))))
 FROM engine_tournament_leases l JOIN smarter_private.f06_hand_permits h ON h.tournament_id=l.tournament_id
 WHERE l.tournament_id=md5('rm-event'||i)::uuid $$;
