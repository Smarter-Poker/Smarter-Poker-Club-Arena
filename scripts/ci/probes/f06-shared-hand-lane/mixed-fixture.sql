-- Isolated fixture columns mirror the authoritative persisted receipt, not a mock RPC.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
ALTER TABLE table_seats ADD COLUMN joined_at timestamptz DEFAULT '2026-09-18 03:25:00+00';
ALTER TABLE hand_atomic_commits ADD COLUMN payload_hash text,
 ADD COLUMN stack_result jsonb, ADD COLUMN committed_at timestamptz DEFAULT now(),
 ADD COLUMN post_commit_payload jsonb, ADD COLUMN post_commit_request_hash text,
 ADD COLUMN post_commit_payload_hash text;
CREATE FUNCTION fixture_expected_mixed(t uuid) RETURNS jsonb LANGUAGE sql AS $$
 WITH owner AS (SELECT * FROM engine_tournament_leases WHERE tournament_id=t),
 tabs AS (SELECT x.* FROM tables x JOIN owner l ON l.tournament_id=x.tournament_id WHERE lower(x.status)<>'closed' AND NOT coalesce(x.is_deleted,false)),
 roster AS (SELECT jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) x,s.id,s.table_id,s.user_id
 FROM table_seats s JOIN tabs tab ON tab.id=s.table_id JOIN tournament_players p ON p.tournament_id=tab.tournament_id
 AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number WHERE s.left_at IS NULL AND p.status='playing')
 SELECT jsonb_build_object('tournament_id',l.tournament_id,'generation',l.lease_generation,
 'generations',(SELECT jsonb_agg(x ORDER BY x) FROM (SELECT DISTINCT generation x FROM smarter_private.f06_hand_permits WHERE tournament_id=t AND state='reserved' UNION SELECT l.lease_generation) q),
 'instance_id',l.instance_id,'engine_version',l.engine_version,'format_contract',e.format_contract,
 'open_tables',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id) FROM tabs),
 'roster',(SELECT jsonb_agg(x ORDER BY id) FROM roster),
 'parks',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.break_id),'[]') FROM smarter_private.f06_operations o
 WHERE o.tournament_id=t AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')),
 'accepted',(SELECT coalesce(jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'atomic_hash',md5(to_jsonb(c)::text)) ORDER BY p.permit_id),'[]')
 FROM smarter_private.f06_hand_permits p JOIN hand_atomic_commits c USING(table_id,hand_number)
 WHERE p.tournament_id=t AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number)),
 'hands',(SELECT jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'snapshot_id',s.id,
 'snapshot_hash',CASE WHEN s.id IS NULL THEN NULL ELSE md5(to_jsonb(s)::text) END,
 'roster',(SELECT jsonb_agg(r.x ORDER BY r.user_id) FROM roster r WHERE r.table_id=p.table_id),
 'break_id',(SELECT break_id FROM smarter_private.f06_operations WHERE source_table_id=p.table_id AND state NOT IN('acknowledged','withdrawn_before_manifest')),
 'prior',CASE WHEN s.id IS NOT NULL THEN NULL WHEN a.hand_id IS NULL AND ab.receipt_id IS NOT NULL THEN jsonb_build_object('kind','aborted_unsettled','receipt_id',ab.receipt_id,'receipt_hash',md5(to_jsonb(ab)::text)) ELSE jsonb_build_object('hand_number',a.hand_number,'atomic_hand_id',a.hand_id,
 'stack_hand_id',a.stack_result->>'hand_id','atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(hh)::text),
 'payload_hash',a.payload_hash,'post_commit_payload_hash',a.post_commit_payload_hash,
 'post_commit_request_hash',a.post_commit_request_hash,'post_commit_completed_at',a.post_commit_completed_at) END)
 ORDER BY p.permit_id) FROM smarter_private.f06_hand_permits p
 LEFT JOIN hand_state_snapshots s ON s.table_id=p.table_id AND s.hand_number=p.hand_number AND NOT s.is_complete
 LEFT JOIN LATERAL (SELECT c.* FROM hand_atomic_commits c WHERE c.table_id=p.table_id AND c.hand_number<p.hand_number ORDER BY c.hand_number DESC LIMIT 1) a ON s.id IS NULL
 LEFT JOIN hand_history hh ON hh.id=a.hand_id AND hh.table_id=a.table_id AND hh.hand_number=a.hand_number
 LEFT JOIN LATERAL (SELECT c.* FROM smarter_private.f06_unsettled_hand_aborts c WHERE c.table_id=p.table_id AND c.hand_number<p.hand_number ORDER BY c.hand_number DESC LIMIT 1) ab ON s.id IS NULL AND a.hand_id IS NULL
 WHERE p.tournament_id=t AND p.state='reserved'))
 FROM owner l JOIN tournaments e ON e.id=l.tournament_id $$;
CREATE FUNCTION fixture_seed_mixed(i integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('mt'||i)::uuid; tab uuid; g uuid; u uuid; k integer; j integer; n integer; st numeric;
 payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}'; stacks jsonb; written jsonb; chips jsonb;
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','mtt-v1',9,24);
 INSERT INTO engine_tournament_leases VALUES(t,'mixed-current','6f3c6858',now(),now(),md5('mg-current'||i)::uuid,2);
 FOR k IN 1..4 LOOP
  tab:=md5('mtab'||i||':'||k)::uuid;g:=md5(CASE k WHEN 1 THEN 'mg-old' WHEN 2 THEN 'mg-middle' ELSE 'mg-current' END||i)::uuid;
  n:=CASE k WHEN 1 THEN 9 WHEN 2 THEN 7 ELSE 4 END;
  INSERT INTO tables(id,tournament_id,status) VALUES(tab,t,'running');
  FOR j IN 1..n LOOP
   u:=md5('mu'||i||':'||k||':'||j)::uuid;
   st:=CASE k WHEN 1 THEN (ARRAY[18463,16847,23419,21139,19463,21184,25447,21221,30817])[j]
       WHEN 2 THEN (ARRAY[8609,29026,23508,45813,36962,26220,27862])[j] ELSE 49500 END;
   INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
   VALUES(md5('ms'||i||':'||k||':'||j)::uuid,tab,u,j,st,md5('mo'||i||':'||k||':'||j)::uuid,'2026-09-18 03:25:00+00'::timestamptz+j*interval '1 second');
   INSERT INTO tournament_players VALUES(md5('mr'||i||':'||k||':'||j)::uuid,t,tab,u,j,st,'playing');
  END LOOP;
  IF k=1 THEN
   SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack',stack,'stack_before',stack) ORDER BY user_id),
    jsonb_object_agg(user_id::text,stack),jsonb_agg(jsonb_build_object('user_id',user_id,'chips',stack) ORDER BY user_id)
   INTO stacks,written,chips FROM table_seats WHERE table_id=tab;
   INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,payload_hash,stack_result,
     committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
   VALUES(tab,4000000+i*100,md5('ma-prior'||i)::uuid,'2026-09-18 04:19:16+00',
     jsonb_build_object('ok',true,'hand_id',md5('ma-prior'||i)::uuid,'hand_number',4000000+i*100),repeat('a',64),
     jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',4000000+i*100,
       'hand_id',md5('ms-prior'||i)::uuid,'conservation_checked',true,'tournament_players_synced',true,'rebased','{}'::jsonb,
       'departed','[]'::jsonb,'players',9,'tournament_player_count',9,'net_deltas',0,'inflow',0,'rake',0,'bbj',0,
       'request',jsonb_build_object('stacks',stacks),'written',written,'tournament_player_chips',chips),
     '2026-09-18 04:19:13+00',payload,
     encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
     encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
   INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('ma-prior'||i)::uuid,tab,4000000+i*100);
  END IF;
  INSERT INTO smarter_private.f06_hand_permits SELECT md5('mp'||i||':'||k)::uuid,t,tab,f06_lifecycle,4000000+i*100+k,
    md5('mc'||i||':'||k)::uuid,g,'reserved',NULL FROM tables WHERE id=tab;
  IF k=2 THEN
   INSERT INTO hand_state_snapshots(table_id,hand_number,state_json)
   SELECT tab,4000000+i*100+k,jsonb_build_object('stage','preflop','pot',2550,'players',jsonb_agg(jsonb_build_object(
    'user_id',user_id,'seat',seat_number,'stack',stack-CASE seat_number WHEN 1 THEN 500 WHEN 5 THEN 2050 ELSE 0 END,
    'totalInvested',CASE seat_number WHEN 1 THEN 500 WHEN 5 THEN 2050 ELSE 0 END,
    'deadInvested',CASE seat_number WHEN 5 THEN 1050 ELSE 0 END,'individualAnteInvested',0,'returnedUncalled',0) ORDER BY seat_number))
   FROM table_seats WHERE table_id=tab;
  ELSIF k>2 THEN
   INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result)
   VALUES(tab,4000000+i*100+k,md5('ma'||i||':'||k)::uuid,now(),'{"ok":true}');
   INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('ma'||i||':'||k)::uuid,tab,4000000+i*100+k);
  END IF;
  IF k=4 THEN
   INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation)
   SELECT md5('mpark'||i)::uuid,t,tab,f06_lifecycle,md5('mb'||i)::uuid,g FROM tables WHERE id=tab;
  END IF;
 END LOOP;
 INSERT INTO fixture_expected_inputs VALUES(i,fixture_expected_mixed(t));
END $$;

-- One explicit two-player SNG boundary with a completed canonical hand.
-- It intentionally has no snapshot or park for the new unresolved permit.
CREATE FUNCTION fixture_seed_mixed_hu() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('mixed-hu')::uuid;tab uuid:=md5('mixed-hu-table')::uuid;
 j integer;u uuid;st numeric;stacks jsonb;written jsonb;chips jsonb;
 payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}';
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','sng-v1',2,2);
 INSERT INTO engine_tournament_leases VALUES(t,'mixed-hu-current','fixed',now(),now(),md5('mixed-hu-current')::uuid,2);
 INSERT INTO tables(id,tournament_id,status,max_players) VALUES(tab,t,'running',2);
 FOR j IN 1..2 LOOP
  u:=md5('mixed-hu-user'||j)::uuid;st:=CASE j WHEN 1 THEN 377 ELSE 223 END;
  INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
   VALUES(md5('mixed-hu-seat'||j)::uuid,tab,u,j,st,md5('mixed-hu-occupancy'||j)::uuid,
    '2026-09-18 04:17:41+00'::timestamptz+j*interval '1 second');
  INSERT INTO tournament_players VALUES(md5('mixed-hu-registration'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack',stack,'stack_before',stack) ORDER BY user_id),
  jsonb_object_agg(user_id::text,stack),jsonb_agg(jsonb_build_object('user_id',user_id,'chips',stack) ORDER BY user_id)
 INTO stacks,written,chips FROM table_seats WHERE table_id=tab;
 INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,payload_hash,stack_result,
   committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
 VALUES(tab,12428969,md5('mixed-hu-atomic')::uuid,'2026-09-18 07:03:10.498154+00',
  jsonb_build_object('ok',true,'hand_id',md5('mixed-hu-atomic')::uuid,'hand_number',12428969),repeat('c',64),
  jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',12428969,
   'hand_id',md5('mixed-hu-stack')::uuid,'conservation_checked',true,'tournament_players_synced',true,
   'rebased','{}'::jsonb,'departed','[]'::jsonb,'players',2,'tournament_player_count',2,
   'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'request',jsonb_build_object('stacks',stacks),'written',written,'tournament_player_chips',chips),
  '2026-09-18 07:03:10.241595+00',payload,
  encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
 INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('mixed-hu-atomic')::uuid,tab,12428969);
 INSERT INTO smarter_private.f06_hand_permits SELECT md5('mixed-hu-permit')::uuid,t,tab,f06_lifecycle,12429075,
  md5('mixed-hu-custody')::uuid,md5('mixed-hu-old')::uuid,'reserved',NULL FROM tables WHERE id=tab;
 INSERT INTO fixture_expected_inputs VALUES(361,fixture_expected_mixed(t));
END $$;
