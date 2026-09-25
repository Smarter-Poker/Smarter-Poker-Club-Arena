# Actual row-only activation versus an existing owning creator/admission.
setup { SELECT r46_activation.pristine(); }
session "a"
setup {
 SET application_name='r46-mtt-a';
 SET statement_timeout='8s';
 SET lock_timeout='3s';
 SET idle_in_transaction_session_timeout='15s';
 SET session_replication_role=origin;
 INSERT INTO r46_mtt_isolation.connections VALUES('a',pg_backend_pid());
}
step "a_begin" { BEGIN ISOLATION LEVEL READ COMMITTED; }
step "a_action" { SELECT r46_activation.activate(); }
step "a_finish" { ROLLBACK; }
teardown { ROLLBACK; }
session "b"
setup {
 SET application_name='r46-mtt-b';
 SET statement_timeout='8s';
 SET lock_timeout='3s';
 SET idle_in_transaction_session_timeout='15s';
 SET session_replication_role=origin;
 INSERT INTO r46_mtt_isolation.connections VALUES('b',pg_backend_pid());
}
step "b_begin" { BEGIN ISOLATION LEVEL READ COMMITTED; }
step "b_action" { SELECT r46_activation.enter_event('b'); }
step "b_finish" { COMMIT; }
teardown { ROLLBACK; }
session "observer"
setup { SET application_name='r46-mtt-observer'; SET statement_timeout='8s'; }
step "observed_wait" { SELECT r46_activation.blocked('a','b'); }
step "final_state" { SELECT r46_activation.verify_final('admission_activation_first_rollback'); }
permutation "a_begin" "a_action" "b_begin" "b_action" "observed_wait" "a_finish" "b_finish" "final_state"
