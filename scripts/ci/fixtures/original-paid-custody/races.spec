setup {
 CREATE FUNCTION original_paid_fixture.resume(n integer,want text) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE r jsonb; BEGIN
 BEGIN
 r:=public.fn_ca_resume_original_paid_tournament_entry(md5('original-paid-race:'||n)::uuid,(SELECT expected FROM original_paid_fixture.input));
 EXCEPTION WHEN SQLSTATE '55000' THEN
 IF want='consumed' AND SQLERRM='ORIGINAL_PAID_SCOPE_CHANGED' THEN RAISE NOTICE 'CUSTODY_RACE_REFUSAL_PROVEN'; RETURN; END IF; RAISE;
 END;
 IF r->>'ok' IS DISTINCT FROM 'true' OR (r->>'stack')::numeric IS DISTINCT FROM 2500
 OR coalesce((r->>'replayed')::boolean,false) IS DISTINCT FROM (want='replayed')
 OR want NOT IN ('fresh','replayed') THEN RAISE EXCEPTION 'CUSTODY_RACE_RESULT_DIFFERS: %',r; END IF;
 RAISE NOTICE 'CUSTODY_RACE_RESULT_PROVEN'; END $$;
}
session "a"
setup { SET application_name='custody-race-a'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "a_begin" { BEGIN; }
step "a_resume" { SELECT original_paid_fixture.resume(1,'fresh'); }
step "a_commit" { COMMIT; }
step "a_rollback" { ROLLBACK; }
session "b"
setup { SET application_name='custody-race-b'; SET statement_timeout='10s'; }
step "b_same_commit" { SELECT original_paid_fixture.resume(1,'replayed'); }
step "b_same_rollback" { SELECT original_paid_fixture.resume(1,'fresh'); }
step "b_other_commit" { SELECT original_paid_fixture.resume(2,'consumed'); }
step "b_other_rollback" { SELECT original_paid_fixture.resume(2,'fresh'); }
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='custody-race-b'
 AND a.application_name='custody-race-a' AND b.wait_event_type='Lock') THEN RAISE EXCEPTION 'CUSTODY_RACE_WAIT_MISSING'; END IF;
 RAISE NOTICE 'CUSTODY_RACE_WAIT_PROVEN'; END $$;
}
step "final_state" {
 DO $$ BEGIN
 IF (SELECT count(*)=1 AND bool_and(state='seated' AND grant_chips=2500 AND scoring_excess=5000)
     FROM public.tournament_paid_stack_custody_receipts) IS DISTINCT FROM true
 OR public.fn_ca_tournament_chip_supply('b7200000-0000-4000-8000-000000000001') IS DISTINCT FROM 320000::numeric
 OR (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id='b7200000-0000-4000-8000-000000000001') IS DISTINCT FROM (SELECT expected->'supply_acknowledgement' FROM original_paid_fixture.input)
 OR public.fn_ca_tournament_felt_total('b7200000-0000-4000-8000-000000000001') IS DISTINCT FROM 322500::numeric
 OR NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.id='b7400000-0000-4000-8000-000000000002' AND s.stack=320000)
 THEN RAISE EXCEPTION 'CUSTODY_RACE_EFFECTS_DIFFER'; END IF;
 RAISE NOTICE 'CUSTODY_RACE_EFFECTS_PROVEN'; END $$;
}
permutation "a_begin" "a_resume" "b_same_commit" "observed_wait" "a_commit" "final_state"
permutation "a_begin" "a_resume" "b_same_rollback" "observed_wait" "a_rollback" "final_state"
permutation "a_begin" "a_resume" "b_other_commit" "observed_wait" "a_commit" "final_state"
permutation "a_begin" "a_resume" "b_other_rollback" "observed_wait" "a_rollback" "final_state"
