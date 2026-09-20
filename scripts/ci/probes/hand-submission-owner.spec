session "a"
setup { SET application_name='submission-owner-a'; SET statement_timeout='10s'; AUTHORITY }
step "a_begin" { BEGIN; }
step "a_write" { A_OPERATION }
step "a_finish" { A_FINISH; }
session "b"
setup { SET application_name='submission-owner-b'; SET statement_timeout='10s'; AUTHORITY }
step "b_begin" { BEGIN; }
step "b_write" { B_OPERATION }
step "b_commit" { COMMIT; }
session "observer"
step "fixture_boundary" { FIXTURE_BOUNDARY }
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='submission-owner-b'
 AND a.application_name='submission-owner-a' AND b.wait_event_type='Lock') THEN
 RAISE EXCEPTION 'SUBMISSION_OWNER_WAIT_NOT_PROVEN'; END IF;
 RAISE NOTICE 'SUBMISSION_OWNER_WAIT_PROVEN'; END $$;
}
step "final_state" { FINAL_STATE }
permutation "a_begin" "b_begin" "a_write" "fixture_boundary" "b_write" "observed_wait" "a_finish" "b_commit" "final_state"
