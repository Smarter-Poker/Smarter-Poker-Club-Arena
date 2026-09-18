# Existing PostgreSQL17 stock isolationtester, private prepared fixture only.
setup {
 DO $check$ BEGIN
  IF inet_server_addr() IS NOT NULL OR current_database() !~ '^r46_mtt_'
    OR public.fn_ca_lock_mtt_admission_contract()<>'legacy-capacity-v1' THEN
   RAISE EXCEPTION 'FORMAT_LOCK_PRIVATE_FIXTURE_REQUIRED';
  END IF;
 END $check$;
}
session "reader"
setup { SET application_name='r46-format-reader'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "reader_begin" { BEGIN; }
step "reader_lock" { SELECT public.fn_ca_lock_mtt_admission_contract(); }
step "reader_commit" { COMMIT; }
step "reader_rollback" { ROLLBACK; }
teardown { ROLLBACK; }
session "writer"
setup { SET application_name='r46-format-writer'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "writer_begin" { BEGIN; }
# Even a no-op UPDATE needs the exclusive row lock. No activation is performed.
step "writer_update" { UPDATE public.ca_mtt_admission_contract SET abi=abi WHERE singleton; }
step "writer_rollback" { ROLLBACK; }
teardown { ROLLBACK; }
session "observer"
step "observed_wait" {
 DO $wait$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity r
    ON r.pid=ANY(pg_blocking_pids(w.pid))
    WHERE w.datname=current_database() AND r.datname=current_database()
      AND w.application_name='r46-format-writer' AND r.application_name='r46-format-reader'
      AND w.wait_event_type='Lock') THEN
   RAISE EXCEPTION 'FORMAT_LOCK_WAIT_NOT_PROVEN';
  END IF;
  RAISE NOTICE 'FORMAT_LOCK_WAIT_PROVEN';
 END $wait$;
}
step "final_legacy" { SELECT abi FROM public.ca_mtt_admission_contract; }
permutation "reader_begin" "reader_lock" "writer_begin" "writer_update" "observed_wait" "reader_commit" "writer_rollback" "final_legacy"
permutation "reader_begin" "reader_lock" "writer_begin" "writer_update" "observed_wait" "reader_rollback" "writer_rollback" "final_legacy"

