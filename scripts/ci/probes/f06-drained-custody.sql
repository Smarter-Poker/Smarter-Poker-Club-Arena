-- Synthetic scenes only; the candidate and all connected financial authorities
-- are real. The complete case transaction rolls back, including all fixtures.
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.check_drained(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'DRAINED FAIL: %',label; END IF;
 RAISE NOTICE 'DRAINED PASS: %',label; END $$;
CREATE FUNCTION pg_temp.drained_state() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record;v jsonb;result jsonb:='{}';BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN('public','smarter_private','auth') ORDER BY 1,2 LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]'') FROM %I.%I r',r.schemaname,r.tablename) INTO v;
 result:=result||jsonb_build_object(r.schemaname||'.'||r.tablename,v); END LOOP;RETURN result; END $$;
CREATE FUNCTION pg_temp.read_drained(g uuid DEFAULT NULL,proof jsonb DEFAULT NULL,with_park boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o smarter_private.f06_operations;BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 RETURN public.fn_f06_assert_drained_manager_custody(o.tournament_id,g,CASE WHEN with_park THEN o.origin_generation ELSE NULL END,
 CASE WHEN with_park THEN jsonb_build_array(jsonb_build_object('break_id',o.break_id,'table_id',o.source_table_id,'lifecycle',o.lifecycle::text)) ELSE '[]'::jsonb END,proof);END $$;
CREATE FUNCTION pg_temp.refuse_drained(command text,reason text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before jsonb:=pg_temp.drained_state();seen text;BEGIN
 BEGIN EXECUTE command;RAISE EXCEPTION 'EXPECTED_REFUSAL_MISSING';EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS seen=MESSAGE_TEXT;IF position(reason IN seen)=0 THEN RAISE EXCEPTION 'DRAINED FAIL: %, expected %, got %',label,reason,seen;END IF;END;
 PERFORM pg_temp.check_drained(pg_temp.drained_state()=before,label||' rollback');END $$;
SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0);
SELECT pg_temp.check_drained(has_function_privilege('service_role','public.fn_f06_assert_drained_manager_custody(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_f06_assert_drained_manager_custody(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE')
 AND NOT has_function_privilege('anon','public.fn_f06_assert_drained_manager_custody(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE'),'service-only read authority');
SELECT pg_temp.refuse_drained('SET LOCAL ROLE authenticated; SELECT public.fn_f06_assert_drained_manager_custody(NULL,NULL,NULL,''[]'',NULL)','permission denied','client refuses');
DO $$ DECLARE before jsonb:=pg_temp.drained_state();r jsonb; BEGIN
 r:=pg_temp.read_drained();PERFORM pg_temp.check_drained(r->>'ok'='true' AND r->>'recovery_required'='false'
 AND jsonb_array_length(r#>'{proof,parks}')=1,'exact old absent lease premanifest accepted boundary');
 PERFORM pg_temp.check_drained(pg_temp.drained_state()=before,'old observation changes no lease, park, money or hand');END $$;
SELECT pg_temp.refuse_drained($q$UPDATE smarter_private.f06_operations SET revision=1 WHERE source_table_id='b7300000-0000-4000-8000-000000000004';SELECT pg_temp.read_drained()$q$,'NOT_PREMANIFEST','changed park CAS');
SELECT pg_temp.refuse_drained($q$SET LOCAL session_replication_role=replica; UPDATE public.table_seats SET stack=stack+1 WHERE table_id='b7300000-0000-4000-8000-000000000004' AND left_at IS NULL;SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained()$q$,'F06_MOVEMENT','canonical stack drift');
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','b7200000-0000-4000-8000-000000000004',true);
SELECT set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000004',true);
SELECT pg_temp.check_drained(granted,'normal successor claimed') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','drained-native','qualified','b7500000-0000-4000-8000-000000000004',30);
SELECT pg_temp.refuse_drained('SELECT pg_temp.read_drained()','LEASE_CHANGED','foreign current owner refuses former read');
SELECT pg_temp.refuse_drained($q$SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000099')$q$,'F06_PROTOCOL2_REQUIRED','wrong manager authority');
DO $$ DECLARE before jsonb:=pg_temp.drained_state();r jsonb;BEGIN
 r:=pg_temp.read_drained('b7500000-0000-4000-8000-000000000004');
 PERFORM pg_temp.check_drained(r->>'recovery_required'='false' AND pg_temp.drained_state()=before,'current owner assertion also creates no effects');END $$;
-- Captured non-source hand, no inference that it never started.
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
SELECT 'b7800000-0000-4000-8000-000000000005',tournament_id,id,f06_lifecycle,9721005,'b7900000-0000-4000-8000-000000000005','b7500000-0000-4000-8000-000000000004'
FROM public.tables WHERE id='b7300000-0000-4000-8000-000000000005';
DO $$ DECLARE before jsonb:=pg_temp.drained_state();r jsonb;proof jsonb;h smarter_private.f06_hand_permits;BEGIN
 r:=pg_temp.read_drained('b7500000-0000-4000-8000-000000000004');proof:=r->'proof';
 PERFORM pg_temp.check_drained(r->>'recovery_required'='true' AND r->'pending_tables'='["b7300000-0000-4000-8000-000000000005"]'::jsonb AND pg_temp.drained_state()=before,'reserved original selects non-dealing ownership without side effects');
 PERFORM pg_temp.check_drained(pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',proof)=r,'identical assertion replay');
 PERFORM pg_temp.refuse_drained(format('SELECT pg_temp.read_drained(''b7500000-0000-4000-8000-000000000004'',%L::jsonb)',jsonb_set(proof,'{originals}',(proof->'originals')||(proof->'originals'))),'CAPTURE_INVALID','duplicate capture');
 PERFORM pg_temp.refuse_drained(format('SELECT pg_temp.read_drained(''b7500000-0000-4000-8000-000000000004'',%L::jsonb)',jsonb_set(proof,'{originals,0,state}','"accepted"')),'CAPTURE_INVALID','terminal input is not captured original');
 PERFORM pg_temp.refuse_drained(format($q$SET LOCAL session_replication_role=replica;UPDATE smarter_private.f06_hand_permits SET state='accepted',evidence_id='b7800000-0000-4000-8000-000000000099';SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',%L::jsonb)$q$,proof),'TERMINAL_EVIDENCE_REQUIRED','accepted label lacks actual canonical evidence');
 PERFORM pg_temp.refuse_drained(format($q$SET LOCAL session_replication_role=replica;UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=permit_id;SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',%L::jsonb)$q$,proof),'TERMINAL_EVIDENCE_REQUIRED','no-start label lacks original receipt');
 PERFORM pg_temp.refuse_drained(format($q$SET LOCAL session_replication_role=replica;UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id='b7800000-0000-4000-8000-000000000099';SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',%L::jsonb)$q$,proof),'TERMINAL_EVIDENCE_REQUIRED','aborted label lacks exact receipt and fence');
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id='b7800000-0000-4000-8000-000000000005';
 PERFORM public.fn_f06_cancel_prepared_hand(h.tournament_id,h.generation,h.table_id,h.lifecycle,h.permit_id,h.hand_number,h.custody_id);
 r:=pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',proof);
 PERFORM pg_temp.check_drained(r->>'recovery_required'='false' AND jsonb_array_length(r->'terminal_proof')=1,'real original preparation receipt permits terminal archive');
END $$;
-- An original submission that already accepted can finish its permit normally.
DO $$ DECLARE h smarter_private.f06_hand_permits;proof jsonb;r jsonb;BEGIN
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 SELECT 'b7800000-0000-4000-8000-000000000004',tournament_id,id,f06_lifecycle,9720004,'b7900000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000004'
 FROM public.tables WHERE id='b7300000-0000-4000-8000-000000000004' RETURNING * INTO h;
 proof:=pg_temp.read_drained(h.generation,NULL,false)->'proof';
 PERFORM public.fn_f06_finish_hand(h.tournament_id,h.generation,h.permit_id,'accepted',(SELECT hand_id FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number=h.hand_number));
 r:=pg_temp.read_drained(h.generation,proof,false);
 PERFORM pg_temp.check_drained(r->>'recovery_required'='false' AND r#>>'{terminal_proof,0,permit,state}'='accepted','real accepted original journal completion remains admissible');
 PERFORM pg_temp.refuse_drained(format($q$SET LOCAL session_replication_role=replica;UPDATE public.hand_atomic_commits SET post_commit_completed_at=NULL WHERE hand_number=9720004;SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000004',%L::jsonb,false)$q$,proof),'TERMINAL_EVIDENCE_REQUIRED','accepted postcommit priority cannot be skipped');
END $$;
-- Synthetic second table in the same actual financial event; the accepted
-- source park and original completed source hand remain unchanged.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(10,11) n;
INSERT INTO public.users(id,username) SELECT id,'drained_'||right(id::text,2) FROM auth.users WHERE id IN('b7100000-0000-4000-8000-000000000010','b7100000-0000-4000-8000-000000000011');
INSERT INTO public.profiles(id,username,display_name) SELECT id,username,username FROM public.users WHERE id IN('b7100000-0000-4000-8000-000000000010','b7100000-0000-4000-8000-000000000011');
INSERT INTO public.tournament_players(id,tournament_id,user_id,club_id,status,chips,table_id,seat_number,prize,current_bounty)
SELECT ('b7500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'b7200000-0000-4000-8000-000000000004',
('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000001','playing',100,'b7300000-0000-4000-8000-000000000005',n-9,0,0 FROM generate_series(10,11) n;
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,joined_at,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key,occupancy_id)
SELECT ('b7400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'b7300000-0000-4000-8000-000000000005',n-9,
('b7100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,100,'active',clock_timestamp()-interval '2 minutes',NULL,false,false,false,
'20000000-0000-0000-0000-000000000001','table:b7300000-0000-4000-8000-000000000005','tournament:b7200000-0000-4000-8000-000000000004',
('b7410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(10,11) n;
INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
SELECT 'b7800000-0000-4000-8000-000000000015',tournament_id,id,f06_lifecycle,9722005,'b7900000-0000-4000-8000-000000000015','b7500000-0000-4000-8000-000000000015'
FROM public.tables WHERE id='b7300000-0000-4000-8000-000000000005';
INSERT INTO public.hand_state_snapshots(table_id,hand_number,state_json,config_json,dealer_seat,players_json)
SELECT 'b7300000-0000-4000-8000-000000000005',9722005,jsonb_build_object('stage','preflop','pot',15,'players',jsonb_agg(jsonb_build_object('user_id',user_id,'seat',seat_number,'stack',stack-seat_number*5,'totalInvested',seat_number*5))), '{}',1,'[]'
FROM public.table_seats WHERE table_id='b7300000-0000-4000-8000-000000000005' AND left_at IS NULL;
SET LOCAL session_replication_role=origin;
DO $$ DECLARE proof jsonb;expected jsonb;r jsonb;money jsonb;park jsonb;old_snap jsonb;receipt uuid:='b7810000-0000-4000-8000-000000000015';BEGIN
 proof:=pg_temp.read_drained('b7500000-0000-4000-8000-000000000004')->'proof';
 expected:=fixture_expected_mixed('b7200000-0000-4000-8000-000000000004');
 money:=pg_temp.drained_state()-ARRAY['smarter_private.f06_hand_permits','smarter_private.f06_mixed_aborts','smarter_private.f06_mixed_abort_hands','smarter_private.f06_mixed_abort_generations','public.engine_tournament_leases','public.hand_state_snapshots'];
 SELECT to_jsonb(s) INTO old_snap FROM public.hand_state_snapshots s WHERE table_id='b7300000-0000-4000-8000-000000000005';
 PERFORM set_config('app.smarter_data_actor','service',true);
 r:=public.fn_f06_abort_mixed_unsettled_generation(receipt,expected);
 PERFORM pg_temp.check_drained(r->>'ok'='true' AND r->>'outcome'='aborted_unsettled' AND r->>'credit'='0' AND r->>'hands'='1','actual mixed abort owns terminal receipt');
 PERFORM pg_temp.check_drained((pg_temp.drained_state()-ARRAY['smarter_private.f06_hand_permits','smarter_private.f06_mixed_aborts','smarter_private.f06_mixed_abort_hands','smarter_private.f06_mixed_abort_generations','public.engine_tournament_leases','public.hand_state_snapshots'])=money,'mixed abort preserves all financial rows and accepted park');
 PERFORM pg_temp.check_drained(EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.id=(old_snap->>'id')::uuid AND to_jsonb(s)-'is_complete'=old_snap-'is_complete' AND s.is_complete),'actual snapshot completion preserves original contents');
 PERFORM pg_temp.check_drained(smarter_private.f06_generation_aborted('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000004') AND smarter_private.f06_generation_aborted('b7200000-0000-4000-8000-000000000004','b7500000-0000-4000-8000-000000000015'),'actual original and former current writers fenced');
 PERFORM pg_temp.check_drained(granted,'normal post-disposition successor claimed') FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','drained-native-next','qualified','b7500000-0000-4000-8000-000000000019',30);
 PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
 PERFORM set_config('app.smarter_tournament_lease_generation','b7500000-0000-4000-8000-000000000019',true);
 r:=pg_temp.read_drained('b7500000-0000-4000-8000-000000000019',proof);
 PERFORM pg_temp.check_drained(r->>'recovery_required'='false' AND r#>>'{terminal_proof,0,permit,state}'='aborted_unsettled' AND r#>>'{terminal_proof,0,evidence,receipt,receipt_id}'=receipt::text,'real mixed receipt admits original terminal archive under genuine new owner');
 PERFORM pg_temp.check_drained(pg_temp.read_drained('b7500000-0000-4000-8000-000000000019',proof)=r,'terminal archive proof exact replay');
 PERFORM pg_temp.refuse_drained(format($q$SET LOCAL session_replication_role=replica;UPDATE smarter_private.f06_mixed_abort_hands SET expected=expected||'{"permit":{}}' WHERE receipt_id='b7810000-0000-4000-8000-000000000015';SET LOCAL session_replication_role=origin;SELECT pg_temp.read_drained('b7500000-0000-4000-8000-000000000019',%L::jsonb)$q$,proof),'TERMINAL_EVIDENCE_REQUIRED','foreign aborted original witness refuses');
END $$;
DO $$ BEGIN RAISE NOTICE 'DRAINED_COMPLETE';END $$;
ROLLBACK;
