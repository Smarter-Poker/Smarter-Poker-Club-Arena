session "holder"
setup { SET application_name='continuation-gate-holder'; SET statement_timeout='8s'; }
step "hold" { BEGIN; SELECT pg_advisory_xact_lock(530090,1); }
step "change" { HOLDER_CHANGE }
step "release" { COMMIT; }
step "outwait" { SELECT pg_sleep(HOLD_SECONDS); }
session "original"
setup { SET application_name='continuation-gate-original'; SET statement_timeout='8s'; SET lock_timeout='CALLER_TIMEOUT'; SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='86000000-0000-0000-0000-000000000001'; SET app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000001'; }
step "retain" {
 DO $$ DECLARE failure text; BEGIN
 BEGIN ORIGINAL_OPERATION EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS failure=RETURNED_SQLSTATE; END;
 IF failure IS DISTINCT FROM EXPECTED_FAILURE THEN RAISE EXCEPTION 'ADMISSION_OUTCOME: %',failure; END IF;
 IF current_setting('lock_timeout') <> 'CALLER_TIMEOUT' THEN RAISE EXCEPTION 'ADMISSION_GUC_LEAK'; END IF;
 RAISE NOTICE 'ADMISSION_OUTCOME_PROVEN'; END $$;
}
session "observer"
step "wait" {
 DO $$ BEGIN
 IF (EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='continuation-gate-original'
 AND a.application_name='continuation-gate-holder' AND b.wait_event_type='Lock')) IS DISTINCT FROM EXPECT_WAIT THEN
 RAISE EXCEPTION 'ADMISSION_WAIT_NOT_PROVEN'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.hand_continuations) THEN RAISE EXCEPTION 'ADMISSION_EARLY_WRITE'; END IF;
 RAISE NOTICE 'ADMISSION_WAIT_PROVEN'; END $$;
}
step "final" {
 DO $$ BEGIN
 IF (SELECT count(*) FROM smarter_private.hand_continuations) <> FINAL_COUNT
 OR EXISTS(SELECT 1 FROM smarter_private.hand_continuations WHERE sequence<>0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001') THEN
 RAISE EXCEPTION 'ADMISSION_FINAL_STATE'; END IF;
 IF NOT pg_try_advisory_xact_lock(530090,1) THEN RAISE EXCEPTION 'ADMISSION_LOCK_LEAK'; END IF;
 RAISE NOTICE 'ADMISSION_FINAL_PROVEN'; END $$;
}
permutation PERMUTATION
