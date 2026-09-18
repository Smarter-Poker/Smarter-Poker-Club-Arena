session "a"
setup { SET application_name='submission-fence-a'; SET statement_timeout='10s'; }
step "a_begin" { BEGIN; }
step "a_write" { A_OPERATION }
step "a_finish" { A_FINISH; }
session "b"
setup { SET application_name='submission-fence-b'; SET statement_timeout='10s'; }
step "b_begin" { BEGIN ISOLATION LEVEL ISOLATION_KIND; }
step "b_snapshot" { SELECT count(*) FROM smarter_private.hand_submission_dispositions; }
step "b_write" {
 DO $$ DECLARE failure text; BEGIN
 BEGIN B_OPERATION EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS failure=RETURNED_SQLSTATE; END;
 IF failure IS DISTINCT FROM EXPECTED_FAILURE THEN RAISE EXCEPTION 'SUBMISSION_RACE_OUTCOME: %',failure; END IF;
 RAISE NOTICE 'SUBMISSION_RACE_OUTCOME_PROVEN'; END $$;
}
step "b_commit" { COMMIT; }
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='submission-fence-b'
 AND a.application_name='submission-fence-a' AND b.wait_event_type='Lock') THEN
 RAISE EXCEPTION 'SUBMISSION_RACE_WAIT_NOT_PROVEN'; END IF;
 RAISE NOTICE 'SUBMISSION_RACE_WAIT_PROVEN'; END $$;
}
step "final_state" {
 DO $$ BEGIN
 IF (SELECT count(*) FROM smarter_private.hand_submission_dispositions)<>1
 OR (SELECT disposition FROM smarter_private.hand_submission_dispositions)<>FINAL_DISPOSITION
 OR (SELECT count(*) FROM smarter_private.hand_submissions)<>FINAL_SUBMISSIONS
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id='86100000-0000-0000-0000-000000000001') THEN
 RAISE EXCEPTION 'SUBMISSION_RACE_FINAL_STATE'; END IF;
 RAISE NOTICE 'SUBMISSION_RACE_FINAL_PROVEN'; END $$;
}
permutation "a_begin" "b_begin" "b_snapshot" "a_write" "b_write" "observed_wait" "a_finish" "b_commit" "final_state"
