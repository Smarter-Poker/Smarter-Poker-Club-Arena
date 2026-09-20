-- Exact retained custody shape with synthetic identifiers; no snapshot or fictitious hand.
CREATE FUNCTION fixture_seed_absent_spin(i integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('absent-spin'||i)::uuid;tab uuid:=md5('absent-spin'||i||'-table')::uuid;
 j integer;u uuid;st numeric;stacks jsonb;written jsonb;chips jsonb;
 payload jsonb:='{"version":1,"accepted_hand_facts":{},"pending_addons":{"ids":[]}}';
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','spin-v1',3,3);
 INSERT INTO engine_tournament_leases VALUES(t,'absent-spin'||i||'-current','fixed',now(),now(),md5('absent-spin'||i||'-current')::uuid,2);
 INSERT INTO tables(id,tournament_id,status,max_players) VALUES(tab,t,'running',3);
 FOR j IN 1..3 LOOP
  u:=md5('absent-spin'||i||'-user'||j)::uuid;st:=(ARRAY[970,1030,1000])[j];
  INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
   VALUES(md5('absent-spin'||i||'-seat'||j)::uuid,tab,u,j,st,md5('absent-spin'||i||'-occupancy'||j)::uuid,
    '2026-09-18 04:17:41+00'::timestamptz+j*interval '1 second');
  INSERT INTO tournament_players VALUES(md5('absent-spin'||i||'-registration'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'stack',stack,'stack_before',stack) ORDER BY user_id),
  jsonb_object_agg(user_id::text,stack),jsonb_agg(jsonb_build_object('user_id',user_id,'chips',stack) ORDER BY user_id)
 INTO stacks,written,chips FROM table_seats WHERE table_id=tab;
 INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result,payload_hash,stack_result,
   committed_at,post_commit_payload,post_commit_request_hash,post_commit_payload_hash)
 VALUES(tab,12428969,md5('absent-spin'||i||'-atomic')::uuid,'2026-09-18 07:03:10.498154+00',
  jsonb_build_object('ok',true,'hand_id',md5('absent-spin'||i||'-atomic')::uuid,'hand_number',12428969),repeat('c',64),
  jsonb_build_object('success',true,'mode','delta','table_id',tab,'tournament_id',t,'hand_number',12428969,
   'hand_id',md5('absent-spin'||i||'-stack')::uuid,'conservation_checked',true,'tournament_players_synced',true,
   'rebased','{}'::jsonb,'departed','[]'::jsonb,'players',3,'tournament_player_count',3,
   'net_deltas',0,'inflow',0,'rake',0,'bbj',0,'request',jsonb_build_object('stacks',stacks),'written',written,'tournament_player_chips',chips),
  '2026-09-18 07:03:10.241595+00',payload,
  encode(extensions.digest(convert_to(((payload-'accepted_hand_facts')#-'{pending_addons,ids}')::text,'UTF8'),'sha256'),'hex'),
  encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'));
 INSERT INTO hand_history(id,table_id,hand_number) VALUES(md5('absent-spin'||i||'-atomic')::uuid,tab,12428969);
 INSERT INTO smarter_private.f06_hand_permits SELECT md5('absent-spin'||i||'-permit')::uuid,t,tab,f06_lifecycle,12429075,
  md5('absent-spin'||i||'-custody')::uuid,md5('absent-spin'||i||'-old')::uuid,'reserved',NULL FROM tables WHERE id=tab;
 INSERT INTO table_hole_cards(id,table_id,hand_number,user_id,seat_number,cards)
 SELECT md5('absent-card'||i||':'||s.seat_number)::uuid,tab,12429075,s.user_id,s.seat_number,'["As","Kd"]' FROM table_seats s WHERE s.table_id=tab;
 INSERT INTO financial_alerts(id,source,context,message,severity)
 VALUES(md5('absent-refusal'||i)::uuid,'ServerTableEngine.authoritative_hand_semantic_refusal',
 jsonb_build_object('table_id',tab,'hand_number',12429075,'channel','server_rpc',
 'error','atomic hand commit refused (atomic_hand_rolled_back): cannot find parent statement on pldbgapi2 call stack',
 'hand_request_identity_v1',jsonb_build_object('hand_id',md5('absent-attempt'||i)::uuid,
 'table_id',tab,'hand_number',12429075,'version',1,'post_commit_required',true)),
 'Exact original refusal, no accepted result claimed','critical');
 INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,result,completed_at)
 SELECT table_id,(stack_result->>'hand_id')::uuid,'succeeded',stack_result,committed_at FROM hand_atomic_commits WHERE table_id=tab;
 INSERT INTO ca_settlements(settlement_type,external_ref,state,table_id,hand_id)
 SELECT 'hand_stacks',table_id::text||':'||(stack_result->>'hand_id'),'final',table_id,(stack_result->>'hand_id')::uuid FROM hand_atomic_commits WHERE table_id=tab;
 INSERT INTO smarter_private.f06_hand_dispatch VALUES(md5('absent-spin'||i||'-permit')::uuid,txid_current());
 INSERT INTO fixture_expected_inputs VALUES(i,fixture_expected_mixed(t));
END $$;

CREATE FUNCTION fixture_absent_spin_expected(i integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_set(x,'{hands,0,interruption}',x#>'{hands,0,interruption}'||jsonb_build_object(
 'kind','snapshot_absent_unaccepted_spin','cards',(SELECT jsonb_agg(jsonb_build_object(
 'id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,'hand_number',c.hand_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM table_hole_cards c
 WHERE c.table_id=md5('absent-spin'||i||'-table')::uuid AND c.hand_number=12429075)))
 FROM (SELECT fixture_spin_prior_expected(md5('absent-spin'||i)::uuid) x) q $$;
