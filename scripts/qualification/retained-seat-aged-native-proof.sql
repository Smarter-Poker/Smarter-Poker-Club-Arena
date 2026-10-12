SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}';
CREATE TRIGGER zz_aged_financial_refusal BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION retirement_native.submission_fault();
DO $$ DECLARE denied boolean:=false;r jsonb;
BEGIN
BEGIN r:=retirement_native.resume_aged(); EXCEPTION WHEN SQLSTATE 'P0404' THEN denied:=true; END;
PERFORM retirement_native.submission_assert(denied,'actual financial refusal rolls back receipt and revival');
PERFORM retirement_native.submission_assert(NOT EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_restorations) AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_id='86400000-0000-0000-0000-000000000001'),'no financial or custody partial result after refusal');
PERFORM retirement_native.submission_assert((SELECT status='left' AND left_at IS NOT NULL AND stack=10 FROM public.table_seats WHERE id='86300000-0000-0000-0000-000000000001'),'aged exact old seat remains held on rollback');
END $$;
DROP TRIGGER zz_aged_financial_refusal ON public.hand_projection_outbox;
DO $$ DECLARE r jsonb;
BEGIN
r:=retirement_native.resume_aged(); RAISE NOTICE 'AGED_OWNER_RESULT %',r;
PERFORM retirement_native.submission_assert(r->>'completed'='true' AND r->>'post_commit_completed'='true' AND r->>'financial_handoff'='true','actual aged seat-first original owner financial+postcommit complete');
PERFORM retirement_native.submission_assert((SELECT stack_result->>'conservation_checked'='true' AND (stack_result->>'net_deltas')::numeric=0 FROM public.hand_atomic_commits WHERE hand_id='86400000-0000-0000-0000-000000000001'),'actual aged financial conservation');
PERFORM retirement_native.submission_assert((SELECT r.transaction_id=h.transaction_id FROM smarter_private.retirement_original_hand_restorations r JOIN smarter_private.hand_submission_handoffs h USING(submission_id)),'receipt and original handoff same transaction');
r:=retirement_native.resume_aged();
PERFORM retirement_native.submission_assert(r->>'found'='false','acknowledgement replay has no second financial handoff');
PERFORM retirement_native.submission_assert((SELECT status='deleted' AND horse_status='disabled' FROM public.profiles WHERE id='10000000-0000-0000-0000-000000000001'),'closed identity stays closed');
END $$;
SELECT 'AGED_SEAT_FIRST_NATIVE_OWNER_PASS';

SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{"role":"service_role"}';
BEGIN; SET LOCAL session_replication_role=replica;
-- Counterfactual reset only; the native original receipt keeps its earlier txid.
UPDATE public.table_seats s SET stack=(e->'seat'->>'stack')::numeric,left_at=(e->'seat'->>'left_at')::timestamptz,status=e->'seat'->>'status',is_sitting_out=true
FROM smarter_private.retirement_original_hand_qualification c CROSS JOIN LATERAL jsonb_array_elements(c.expected->'rows')e WHERE s.id=(e->'seat'->>'id')::uuid;
SET LOCAL session_replication_role=origin;
SET LOCAL app.smarter_data_actor='tournament-manager';
SET LOCAL app.smarter_tournament_id='86000000-0000-0000-0000-000000000001';
SET LOCAL app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000002';
UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id='86000000-0000-0000-0000-000000000001';
SELECT smarter_private.f06_prefix('86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000002',ARRAY['10000000-0000-0000-0000-000000000001'::uuid],ARRAY['86100000-0000-0000-0000-000000000001'::uuid]);
DO $$ DECLARE denied boolean:=false;
BEGIN
BEGIN UPDATE public.table_seats SET left_at=NULL,status='active' WHERE id='86300000-0000-0000-0000-000000000001'; EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%'; END;
PERFORM retirement_native.submission_assert(denied,'old committed receipt cannot revive a chair in a later transaction');
denied:=false;
BEGIN UPDATE public.table_seats SET left_at=NULL,status='active',stack=11 WHERE id='86300000-0000-0000-0000-000000000001'; EXCEPTION WHEN check_violation THEN denied:=SQLERRM LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%'; END;
PERFORM retirement_native.submission_assert(denied,'altered stack cannot borrow original capability');
END $$;
ROLLBACK;
SELECT retirement_native.submission_assert(NOT has_function_privilege('service_role','smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)','EXECUTE') AND NOT has_function_privilege('anon','smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)','EXECUTE'),'private helper is not callable by external roles');
SELECT retirement_native.submission_assert(NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r CROSS JOIN unnest(ARRAY['smarter_private.retirement_original_hand_qualification','smarter_private.retirement_original_hand_restorations'])t WHERE has_table_privilege(r,t,'INSERT,UPDATE,DELETE,TRUNCATE')),'external roles cannot manufacture recovery receipts');
SELECT clock_timestamp() at,p.oid::regprocedure::text signature,md5(pg_get_functiondef(p.oid)) full_md5,md5(p.prosrc) body_md5,p.proowner::regrole owner,p.prosecdef,p.proconfig,p.proacl
FROM pg_proc p WHERE p.oid IN ('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure,'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure,'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure,'public.fn_ca_reject_automated_user_club_row()'::regprocedure,'public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure,'public.fn_ca_guard_seat_creation()'::regprocedure,'smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure,'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
