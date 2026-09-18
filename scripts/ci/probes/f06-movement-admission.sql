-- This entire probe, including deliberately changed input scenes, rolls back.
-- Public business functions and their real captured guards remain installed.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.assert_movement(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'MOVEMENT FAIL: %',label; END IF;
RAISE NOTICE 'MOVEMENT PASS: %',label; END $$;
CREATE FUNCTION pg_temp.movement_state(money_only boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE name text; result jsonb:='{}'; value jsonb; names text[]:=ARRAY[
 'public.wallet_transactions','public.wallet_credit_idempotency','public.chip_ledger',
 'public.tournament_escrow','public.club_members'];
BEGIN
 IF NOT money_only THEN names:=names||ARRAY['public.tables','public.tournaments','public.table_seats',
 'public.tournament_players','public.hand_history','public.hand_atomic_commits','public.hand_private_state',
 'public.hand_state_snapshots','public.tournament_seat_move_receipts','public.engine_tournament_leases',
 'smarter_private.f06_operations','smarter_private.f06_members','smarter_private.f06_attempts',
 'smarter_private.f06_dispatch','smarter_private.f06_hand_permits','smarter_private.f06_hand_dispatch',
 'smarter_private.f06_movement_admissions']; END IF;
 FOREACH name IN ARRAY names LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(j ORDER BY j::text),''[]''::jsonb) FROM (SELECT to_jsonb(r) j FROM %s r) q',name) INTO value;
 result:=result||jsonb_build_object(name,value);
 END LOOP; RETURN result;
END $$;
CREATE FUNCTION pg_temp.movement_admit(a uuid DEFAULT 'b7600000-0000-4000-8000-000000000004',
 c uuid DEFAULT 'b7700000-0000-4000-8000-000000000004',revision bigint DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o smarter_private.f06_operations; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 RETURN public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,o.break_id,a,c,revision);
END $$;
CREATE FUNCTION pg_temp.movement_refuses(command text,expected text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before jsonb:=pg_temp.movement_state(); seen text; BEGIN
 BEGIN
 EXECUTE command;
 RAISE EXCEPTION 'FIXTURE_EXPECTED_REFUSAL_NOT_OBSERVED';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT;
 IF position(expected IN seen)=0 THEN RAISE EXCEPTION 'MOVEMENT FAIL: %, expected %, got %',label,expected,seen; END IF;
 END;
 PERFORM pg_temp.assert_movement(pg_temp.movement_state()=before,label||' (all effects rolled back)');
END $$;
-- Only opening historical evidence is synthetic. No replacement business
-- authority is introduced; every accepted permit joins the actual opening hand.
CREATE FUNCTION pg_temp.movement_permit(p_state text DEFAULT 'accepted',evidence uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
 SELECT 'b7800000-0000-4000-8000-000000000004',(a.stack_result->>'tournament_id')::uuid,t.id,t.f06_lifecycle,a.hand_number,
 'b7900000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000004',p_state,COALESCE(evidence,a.hand_id)
 FROM public.hand_atomic_commits a JOIN public.tables t ON t.id=a.table_id WHERE a.hand_number=9720004;
END $$;
-- The native elimination removes the original zero-stack participant first.
SELECT public.fn_eliminate_tournament_player_atomic(
 'b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0);
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','b7200000-0000-4000-8000-000000000004',true);
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000004',true);
SELECT pg_temp.assert_movement(granted,'actual current protocol-2 lease claimed') FROM public.claim_tournament_lease_v2(
 'b7200000-0000-4000-8000-000000000004','movement-original','qualified','b7500000-0000-4000-8000-000000000004',30);
SELECT pg_temp.assert_movement((SELECT relrowsecurity FROM pg_class WHERE oid='smarter_private.f06_movement_admissions'::regclass)
 AND has_function_privilege('service_role','public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)','EXECUTE')
 AND NOT has_function_privilege('anon','public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)','EXECUTE')
 AND NOT has_table_privilege('service_role','smarter_private.f06_movement_admissions','INSERT,UPDATE,DELETE,TRUNCATE'),
 'only service RPC exposes movement admission; private receipt is not client writable');
SELECT pg_temp.movement_refuses($q$SET LOCAL ROLE authenticated; SELECT public.fn_f06_admit_parked_movement(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)$q$,
 'permission denied','authenticated execution refused');
SELECT pg_temp.movement_refuses($q$SET LOCAL ROLE service_role; INSERT INTO smarter_private.f06_movement_admissions DEFAULT VALUES$q$,
 'permission denied','service cannot mint private receipt');
SELECT pg_temp.movement_refuses($q$SELECT set_config('app.smarter_data_actor','service',true); SELECT pg_temp.movement_admit()$q$,
 'F06_PROTOCOL2_REQUIRED','ordinary service is not current Manager');
SELECT pg_temp.movement_refuses($q$UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds'
 WHERE tournament_id='b7200000-0000-4000-8000-000000000004'; SELECT pg_temp.movement_admit()$q$,
 'F06_LEASE_FENCED','stale generation refuses admission');
SELECT pg_temp.movement_refuses($q$SELECT pg_temp.movement_permit('reserved'); SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY','reserved original is not a movement boundary');
SELECT pg_temp.movement_refuses($q$SELECT pg_temp.movement_permit('accepted','b7800000-0000-4000-8000-000000000099'); SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY','accepted label without exact commit refuses');
SELECT pg_temp.movement_refuses($q$SELECT pg_temp.movement_permit(); INSERT INTO smarter_private.f06_hand_dispatch VALUES('b7800000-0000-4000-8000-000000000004',txid_current()); SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY','retained hand dispatch refuses');
SELECT pg_temp.movement_refuses($q$SELECT pg_temp.movement_permit(); SET LOCAL session_replication_role=replica;
 UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_number=9720004;
 SET LOCAL session_replication_role=origin; SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_PRIOR_INCOMPLETE','accepted hand without completed postcommit refuses');

SELECT pg_temp.movement_refuses($q$SET LOCAL session_replication_role=replica;
 INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json)
 VALUES('b7300000-0000-4000-8000-000000000004',9720005,'{}','{}',1,'[]');
 SET LOCAL session_replication_role=origin; SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY','active hand snapshot refuses admission');
SELECT pg_temp.movement_refuses($q$SET LOCAL session_replication_role=replica;
 INSERT INTO public.hand_private_state(hand_id,player_id,table_id,hand_number)
 VALUES('b7b00000-0000-4000-8000-000000000005','b7100000-0000-4000-8000-000000000008','b7300000-0000-4000-8000-000000000004',9720005);
 SET LOCAL session_replication_role=origin; SELECT pg_temp.movement_admit()$q$,
 'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY','later private hand evidence refuses admission');

-- The original custody RPC can return without incrementing when the exact
-- current custody already matches. Retain its requested CAS independently.
DO $$ DECLARE before jsonb:=pg_temp.movement_state(); o smarter_private.f06_operations; a jsonb; b jsonb; BEGIN
 BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 PERFORM public.fn_f06_claim_custody(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,'b7700000-0000-4000-8000-000000000004',0);
 a:=pg_temp.movement_admit('b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000004',1);
 b:=pg_temp.movement_admit('b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000004',1);
 PERFORM pg_temp.assert_movement(a=b AND a->>'revision'='1' AND (SELECT requested_revision=1 FROM smarter_private.f06_movement_admissions),
 'matching original custody replay preserves actual requested revision');
 PERFORM pg_temp.movement_refuses('SELECT pg_temp.movement_admit()','F06_MOVEMENT_CHANGED_REPLAY','changed replay CAS refuses');
 RAISE EXCEPTION 'FIXTURE_FLOW_ROLLBACK';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'FIXTURE_FLOW_ROLLBACK' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_movement(pg_temp.movement_state()=before,'same-custody admission scenario fully rolled back');
END $$;

CREATE FUNCTION pg_temp.movement_flow(modern boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o smarter_private.f06_operations; admission jsonb; replay jsonb; next_admission jsonb; r jsonb; manifest jsonb;
 first jsonb; second jsonb; receipt jsonb; before jsonb; money jsonb; original_proof jsonb; label text:=CASE WHEN modern THEN 'modern accepted' ELSE 'legacy zero-permit' END;
BEGIN
 before:=pg_temp.movement_state();
 BEGIN
 IF modern THEN PERFORM pg_temp.movement_permit(); END IF;
 money:=pg_temp.movement_state(true);
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 admission:=pg_temp.movement_admit(); replay:=pg_temp.movement_admit();
 SELECT proof INTO STRICT original_proof FROM smarter_private.f06_movement_admissions WHERE admission_id=(admission->>'admission_id')::uuid;
 PERFORM pg_temp.assert_movement(admission=replay AND admission->>'mode'='movement_only' AND admission->>'revision'='1'
 AND jsonb_array_length(original_proof->'roster')=2 AND jsonb_array_length(original_proof->'eliminated')=1
 AND jsonb_array_length(original_proof->'permits')=CASE WHEN modern THEN 1 ELSE 0 END,label||' immutable admission and replay');
 PERFORM pg_temp.movement_refuses($q$SELECT pg_temp.movement_admit('b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000099',0)$q$,
 'F06_MOVEMENT_CHANGED_REPLAY','changed admission identity refuses');
 PERFORM pg_temp.movement_refuses($q$SELECT pg_temp.movement_admit('b7600000-0000-4000-8000-000000000099','b7700000-0000-4000-8000-000000000099',0)$q$,
 'F06_MOVEMENT_CAS_CHANGED','stale custody CAS refuses');
 PERFORM pg_temp.movement_refuses('UPDATE smarter_private.f06_movement_admissions SET proof_hash=repeat(''0'',64)',
 'F06_MOVEMENT_RECEIPT_IMMUTABLE','receipt UPDATE immutable');
 PERFORM pg_temp.movement_refuses('DELETE FROM smarter_private.f06_movement_admissions',
 'F06_MOVEMENT_RECEIPT_IMMUTABLE','receipt DELETE immutable');
 PERFORM pg_temp.movement_refuses('TRUNCATE smarter_private.f06_movement_admissions',
 'F06_MOVEMENT_RECEIPT_IMMUTABLE','receipt TRUNCATE immutable');
 r:=public.fn_f06_begin_hand(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,
 'b7800000-0000-4000-8000-000000000099',9720005,'b7900000-0000-4000-8000-000000000099');
 PERFORM pg_temp.assert_movement(r->>'reason'='source_excluded' AND r->'ok'='false'::jsonb,
 label||' movement admission never reserves a new hand');
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'source_seat_id',s.id,'source_seat_number',s.seat_number,
 'occupancy_id',s.occupancy_id,'request_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7a00000-0000-4000-8000-000000000001' ELSE 'b7a00000-0000-4000-8000-000000000002' END,
 'destination_table_id',CASE WHEN s.user_id::text LIKE '%000008' THEN 'b7300000-0000-4000-8000-000000000005' ELSE 'b7300000-0000-4000-8000-000000000006' END,
 'destination_seat_number',1) ORDER BY s.user_id) INTO manifest FROM public.table_seats s WHERE s.table_id=o.source_table_id AND s.left_at IS NULL;
 PERFORM pg_temp.movement_refuses(format('SELECT public.fn_f06_begin_break(%L,%L,%L,%L::jsonb)',o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,jsonb_build_array(manifest->0)),
 'F06_WHOLE_ROSTER_REQUIRED','partial manifest refused');
 PERFORM pg_temp.movement_refuses(format($q$SET LOCAL session_replication_role=replica;
 INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json)
 VALUES(%L,9720005,'{}','{}',1,'[]'); SET LOCAL session_replication_role=origin;
 SELECT public.fn_f06_begin_break(%L,%L,%L,%L::jsonb)$q$,o.source_table_id,o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,manifest),
 'F06_MOVEMENT_BOUNDARY_CHANGED','new active snapshot between admission and begin refuses full transaction');
 r:=public.fn_f06_begin_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,manifest);
 replay:=public.fn_f06_begin_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,manifest);
 PERFORM pg_temp.assert_movement(r=replay AND r->>'state'='begun' AND jsonb_array_length(r->'members')=2,
 label||' full original manifest begun exactly once');
 PERFORM pg_temp.movement_refuses(format('SELECT public.fn_f06_begin_break(%L,%L,%L,%L::jsonb)',o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,jsonb_set(manifest,'{0,destination_seat_number}','2')),
 'F06_CHANGED_MANIFEST','changed manifest replay refused');
 r:=public.fn_f06_close_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id);
 PERFORM pg_temp.assert_movement(r->>'reason'='members_unresolved',label||' unresolved members cannot close');
 r:=public.fn_f06_ack_cleanup(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,(admission->>'custody_id')::uuid,1,'retired');
 PERFORM pg_temp.assert_movement(r->>'reason'='terminal_handoff_required',label||' premature ACK refuses');
 first:=manifest->0; second:=manifest->1;
 r:=public.fn_move_tournament_player(o.tournament_id,(first->>'user_id')::uuid,o.source_table_id,
 (first->>'destination_table_id')::uuid,1,(first->>'request_id')::uuid,'live_source');
 receipt:=public.fn_ca_tournament_seat_move_receipt((first->>'request_id')::uuid);
 replay:=public.fn_move_tournament_player(o.tournament_id,(first->>'user_id')::uuid,o.source_table_id,
 (first->>'destination_table_id')::uuid,1,(first->>'request_id')::uuid,'live_source');
 PERFORM pg_temp.assert_movement(r->'replayed'='false'::jsonb AND replay->'replayed'='true'::jsonb
 AND r-'replayed'=receipt AND replay-'replayed'=receipt AND (receipt->>'stack')::numeric=100
 AND (SELECT count(*) FROM smarter_private.f06_attempts WHERE break_id=o.break_id AND state='winner')=1
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_dispatch),label||' first public move and exact replay have one winner');
 PERFORM pg_temp.movement_refuses(format('SELECT public.fn_move_tournament_player(%L,%L,%L,%L,2,%L,''live_source'')',o.tournament_id,first->>'user_id',o.source_table_id,first->>'destination_table_id',first->>'request_id'),
 'tournament move request id belongs to another operation','changed move replay refuses');
 -- Missing receipt is still unknown, not a successful/no-start disposition.
 PERFORM set_config('app.smarter_data_actor','service',true);
 r:=public.fn_resolve_committed_tournament_seat_move('b7a00000-0000-4000-8000-000000000099',o.tournament_id,(second->>'user_id')::uuid,
 o.source_table_id,(second->>'destination_table_id')::uuid,1,'live_source');
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM pg_temp.assert_movement(r IS NULL,label||' absent original receipt stays unknown');
 replay:=pg_temp.movement_admit();
 PERFORM pg_temp.assert_movement(replay=admission,label||' partial winner revalidates original admission');
 -- A stopped owner/successor custody carries the complete original proof, not
 -- the remaining one-seat roster; the actual claim RPC performs the CAS.
 next_admission:=pg_temp.movement_admit('b7600000-0000-4000-8000-000000000005','b7700000-0000-4000-8000-000000000005',1);
 PERFORM pg_temp.assert_movement(next_admission->>'revision'='2' AND next_admission->>'proof_hash'=admission->>'proof_hash'
 AND (SELECT proof=original_proof FROM smarter_private.f06_movement_admissions WHERE admission_id=(next_admission->>'admission_id')::uuid),
 label||' recovered custody preserves entire original proof after first winner');
 PERFORM pg_temp.movement_refuses('SELECT pg_temp.movement_admit()','F06_MOVEMENT_CUSTODY_CHANGED','superseded admission fenced');
 PERFORM pg_temp.movement_refuses(format($q$SET LOCAL session_replication_role=replica; UPDATE public.table_seats SET stack=101 WHERE id=%L; UPDATE public.tournament_players SET chips=101 WHERE tournament_id=%L AND user_id=%L;
 SET LOCAL session_replication_role=origin; SELECT public.fn_move_tournament_player(%L,%L,%L,%L,1,%L,'live_source')$q$,
 second->>'source_seat_id',o.tournament_id,second->>'user_id',o.tournament_id,second->>'user_id',o.source_table_id,second->>'destination_table_id',second->>'request_id'),
 'F06_MOVEMENT_ROSTER_CHANGED','changed remaining source cannot dispatch');
 PERFORM pg_temp.movement_refuses($q$SET LOCAL session_replication_role=replica;
 UPDATE public.tournament_players SET position=99 WHERE tournament_id='b7200000-0000-4000-8000-000000000004' AND user_id='b7100000-0000-4000-8000-000000000007';
 SET LOCAL session_replication_role=origin; SELECT pg_temp.movement_admit('b7600000-0000-4000-8000-000000000005','b7700000-0000-4000-8000-000000000005',1)$q$,
 'F06_MOVEMENT_ELIMINATION_CHANGED','original zero-stack elimination stays bound');
 PERFORM pg_temp.movement_refuses(format($q$UPDATE smarter_private.f06_attempts SET state='fenced' WHERE request_id=%L;
 SELECT public.fn_move_tournament_player(%L,%L,%L,%L,1,%L,'live_source')$q$,second->>'request_id',o.tournament_id,second->>'user_id',o.source_table_id,second->>'destination_table_id',second->>'request_id'),
 'F06_ATTEMPT_FENCED_OR_SOURCE_CHANGED','fenced original attempt cannot dispatch');
 PERFORM pg_temp.movement_refuses(format($q$SELECT public.fn_move_tournament_player(%L,%L,%L,%L,1,'b7a00000-0000-4000-8000-000000000099','live_source')$q$,
 o.tournament_id,second->>'user_id',o.source_table_id,second->>'destination_table_id'),
 'F06_UNBOUND_MOVE','unknown request cannot replace original attempt');
 r:=public.fn_move_tournament_player(o.tournament_id,(second->>'user_id')::uuid,o.source_table_id,
 (second->>'destination_table_id')::uuid,1,(second->>'request_id')::uuid,'live_source');
 PERFORM pg_temp.assert_movement(r->'ok'='true'::jsonb AND (r->>'stack')::numeric=100
 AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)
 AND (SELECT count(*) FROM smarter_private.f06_attempts WHERE break_id=o.break_id AND state='winner')=2,
 label||' second public move drains exact original source');
 r:=public.fn_f06_close_break(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id);
 PERFORM pg_temp.assert_movement(r->>'state'='close_confirmed' AND (SELECT lower(status)='closed' AND current_players=0 FROM public.tables WHERE id=o.source_table_id),label||' original close is durable');
 r:=public.fn_f06_ack_cleanup(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,(admission->>'custody_id')::uuid,1,'retired');
 PERFORM pg_temp.assert_movement(r->>'reason'='custody_revision_conflict',label||' retired former custody cannot ACK');
 r:=public.fn_f06_ack_cleanup(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,(next_admission->>'custody_id')::uuid,2,'retired');
 replay:=public.fn_f06_ack_cleanup(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.break_id,(next_admission->>'custody_id')::uuid,2,'retired');
 PERFORM pg_temp.assert_movement(r=replay AND r->>'state'='acknowledged',label||' current custody retires with idempotent ACK');
 PERFORM pg_temp.assert_movement((SELECT count(*)=2 AND sum(stack)=200 FROM public.tournament_seat_move_receipts WHERE source_table_id=o.source_table_id)
 AND (SELECT count(*)=2 AND sum(s.stack)=200 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=o.tournament_id AND s.left_at IS NULL)
 AND (SELECT sum(chips)=200 FROM public.tournament_players WHERE tournament_id=o.tournament_id)
 AND pg_temp.movement_state(true)=money AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_dispatch),
 label||' exactly 200 chips remain with two players; financial ledgers unchanged');
 RAISE EXCEPTION 'FIXTURE_FLOW_ROLLBACK';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'FIXTURE_FLOW_ROLLBACK' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.assert_movement(pg_temp.movement_state()=before,label||' entire flow rolled back');
END $$;
SELECT pg_temp.movement_flow(false);
SELECT pg_temp.movement_flow(true);
SELECT 'F06_MOVEMENT_ADMISSION_PASS';
ROLLBACK;
