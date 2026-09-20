# R46 candidate test asset. NOT EXECUTED. No admission or runner is created.
# One explicit permutation in its own qualified disposable database.
# Load fixture.sql through the protected provider first. See README.md.
setup { SELECT r46_mtt_isolation.pristine(); }

session "a"
setup
{
  SET application_name='r46-mtt-a';
  SET statement_timeout='15s';
  SET lock_timeout='10s';
  SET idle_in_transaction_session_timeout='20s';
  SET session_replication_role=origin;
  SET request.jwt.claim.role='service_role';
  SELECT set_config('request.jwt.claims',json_build_object('role','service_role')::text,false);
  INSERT INTO r46_mtt_isolation.connections VALUES('a',pg_backend_pid());
}
step "a_begin" { BEGIN ISOLATION LEVEL READ COMMITTED; }
step "a_action" { SELECT r46_mtt_isolation.restart('a',5,false); }
step "a_finish" { COMMIT; }
teardown { ROLLBACK; }

session "b"
setup
{
  SET application_name='r46-mtt-b';
  SET statement_timeout='15s';
  SET lock_timeout='10s';
  SET idle_in_transaction_session_timeout='20s';
  SET session_replication_role=origin;
  SET request.jwt.claim.role='service_role';
  SELECT set_config('request.jwt.claims',json_build_object('role','service_role')::text,false);
  INSERT INTO r46_mtt_isolation.connections VALUES('b',pg_backend_pid());
}
step "b_begin" { BEGIN ISOLATION LEVEL READ COMMITTED; }
step "b_action" { SELECT r46_mtt_isolation.restart('b',6,true); }
step "b_finish" { COMMIT; }
teardown { ROLLBACK; }

session "observer"
setup
{
  SET application_name='r46-mtt-observer';
  SET statement_timeout='15s';
}
step "observed_wait" { SELECT r46_mtt_isolation.blocked('a','b'); }
step "final_state" { SELECT r46_mtt_isolation.verify_final('restart_commit'); }

permutation "a_begin" "a_action" "b_begin" "b_action" "observed_wait" "a_finish" "b_finish" "final_state"
