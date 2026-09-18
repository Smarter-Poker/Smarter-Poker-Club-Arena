session "a"
setup { SET application_name='submission-maintenance-a'; SET statement_timeout='10s'; }
step "a_begin" { BEGIN; }
step "a_write" { MAINTENANCE_WRITE }
step "a_finish" { A_FINISH; }
session "b"
setup {
 SET application_name='submission-maintenance-b'; SET statement_timeout='10s';
 SET request.jwt.claim.role='service_role'; SET app.smarter_data_actor='tournament-manager';
 SET app.smarter_tournament_id='86000000-0000-0000-0000-000000000001';
 SET app.smarter_tournament_lease_generation='86500000-0000-0000-0000-000000000002';
}
step "b_begin" { BEGIN; }
step "b_refuse" {
 DO $$ DECLARE refused boolean:=false; BEGIN
 BEGIN PERFORM RESUME_CALL;
 EXCEPTION WHEN SQLSTATE '55P03' THEN refused:=SQLERRM='HAND_SUBMISSION_MAINTENANCE_BUSY'; END;
 IF NOT refused OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispatch) THEN
 RAISE EXCEPTION 'SUBMISSION_MAINTENANCE_REFUSAL_UNPROVEN'; END IF;
 RAISE NOTICE 'SUBMISSION_MAINTENANCE_REFUSAL_PROVEN'; END $$;
}
step "b_commit" { COMMIT; }
step "final_state" { FINAL_STATE }
session "observer"
step "observed_owner" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
 WHERE a.datname=current_database() AND a.application_name='submission-maintenance-a'
 AND l.locktype='advisory' AND l.classid=530090 AND l.objid=1 AND l.objsubid=2
 AND l.mode='ExclusiveLock' AND l.granted) THEN
 RAISE EXCEPTION 'SUBMISSION_MAINTENANCE_OWNER_UNPROVEN'; END IF;
 RAISE NOTICE 'SUBMISSION_MAINTENANCE_OWNER_PROVEN'; END $$;
}
permutation "a_begin" "b_begin" "a_write" "observed_owner" "b_refuse" "b_commit" "a_finish" "final_state"
