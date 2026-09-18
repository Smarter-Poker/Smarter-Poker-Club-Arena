setup {
 CREATE FUNCTION original_paid_fixture.attempt(want text) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE r jsonb; BEGIN
 BEGIN
 r:=public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000002',(SELECT expected FROM original_paid_fixture.input));
 EXCEPTION WHEN OTHERS THEN
 IF (want='busy' AND SQLSTATE='55P03') OR (want='frozen' AND SQLERRM='ORIGINAL_PAID_PLATFORM_FROZEN')
 OR (want='changed' AND SQLERRM='ORIGINAL_PAID_SCOPE_CHANGED') OR (want='lease' AND SQLERRM='ORIGINAL_PAID_LEASE_CHANGED')
 THEN RAISE NOTICE 'CUSTODY_OWNER_REFUSAL_PROVEN'; RETURN; END IF; RAISE;
 END;
 IF want<>'fresh' OR r->>'ok' IS DISTINCT FROM 'true' OR (r->>'stack')::numeric IS DISTINCT FROM 2500
 THEN RAISE EXCEPTION 'CUSTODY_OWNER_RESULT_DIFFERS: %',r; END IF;
 RAISE NOTICE 'CUSTODY_OWNER_RESULT_PROVEN'; END $$;
}
session "a"
setup { SET application_name='custody-owner-a'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "a_freeze_boundary" { INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,updated_at,enforce_freeze,ownership_token) VALUES(true,'counting_down',clock_timestamp()+interval '35 seconds',clock_timestamp()+interval '36 seconds',clock_timestamp()+interval '5 minutes','native custody clock boundary','native',now(),true,gen_random_uuid()); DO $$ BEGIN IF public.fn_platform_frozen() OR public.fn_entry_purchases_frozen() THEN RAISE EXCEPTION 'NATIVE_BOUNDARY_ALREADY_FROZEN'; END IF; END $$; }
step "a_begin" { BEGIN; }
step "a_lease" { SELECT tournament_id FROM public.engine_tournament_leases WHERE tournament_id='b7200000-0000-4000-8000-000000000001' FOR KEY SHARE; }
step "a_lane" { DO $$ BEGIN IF NOT pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1:b7200000-0000-4000-8000-000000000001',0)) THEN RAISE EXCEPTION 'LEASE_LANE_INVERTED'; END IF; RAISE NOTICE 'CUSTODY_OWNER_ORDER_PROVEN'; END $$; }
step "a_resume" { SELECT original_paid_fixture.attempt('fresh'); }
step "a_old_seat" { SELECT id FROM public.table_seats WHERE id='b7400000-0000-4000-8000-000000000001' FOR UPDATE; }
step "a_candidate" { SELECT public.fn_ca_lock_tournament_seat_acquisition('b7200000-0000-4000-8000-000000000001','b7300000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001'); UPDATE public.tournament_knockout_candidates SET state='rebought',resolved_at=clock_timestamp() WHERE id='b7800000-0000-4000-8000-000000000001'; }
step "a_commit" { COMMIT; }
step "a_rollback" { ROLLBACK; }
session "b"
setup { SET application_name='custody-owner-b'; SET statement_timeout='10s'; }
step "b_busy" { SELECT original_paid_fixture.attempt('busy'); }
step "b_frozen" { SELECT original_paid_fixture.attempt('frozen'); }
step "b_changed" { SELECT original_paid_fixture.attempt('changed'); }
step "b_fresh" { SELECT original_paid_fixture.attempt('fresh'); }
step "b_heartbeat" { DO $$ DECLARE s text; BEGIN SELECT state INTO STRICT s FROM public.heartbeat_tournament_leases_v4('native-original-custody',jsonb_build_array(jsonb_build_object('tournament_id','b7200000-0000-4000-8000-000000000001','lease_generation','b7b00000-0000-4000-8000-000000000001'))); IF s<>'busy' THEN RAISE EXCEPTION 'HEARTBEAT_DID_NOT_PRESERVE_BUSY: %',s; END IF; RAISE NOTICE 'CUSTODY_OWNER_HEARTBEAT_PROVEN'; END $$; }
step "b_claim" { DO $$ DECLARE r record; BEGIN SELECT * INTO STRICT r FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000001','native-original-custody','native','b7b00000-0000-4000-8000-000000000001'); IF r.granted IS DISTINCT FROM true OR r.lease_generation IS DISTINCT FROM 'b7b00000-0000-4000-8000-000000000001'::uuid THEN RAISE EXCEPTION 'CLAIM_DIFFERED'; END IF; RAISE NOTICE 'CUSTODY_OWNER_CLAIM_PROVEN'; END $$; }
session "observer"
step "observed_wait" { DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid)) WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='custody-owner-b' AND a.application_name='custody-owner-a' AND b.wait_event_type='Lock') THEN RAISE EXCEPTION 'CUSTODY_OWNER_WAIT_MISSING'; END IF; RAISE NOTICE 'CUSTODY_OWNER_WAIT_PROVEN'; END $$; }
step "freeze" { SELECT pg_sleep_until((SELECT announced_at-interval '30 seconds'+interval '10 milliseconds' FROM public.engine_maintenance_break WHERE id)); DO $$ BEGIN IF NOT public.fn_platform_frozen() THEN RAISE EXCEPTION 'NATIVE_CLOCK_BOUNDARY_NOT_FROZEN'; END IF; END $$; }
permutation "a_begin" "a_lease" "b_busy" "a_lane" "a_commit"
permutation "a_begin" "a_resume" "b_heartbeat" "b_claim" "observed_wait" "a_commit"
permutation "a_begin" "a_candidate" "b_changed" "observed_wait" "a_commit"
permutation "a_begin" "a_candidate" "b_fresh" "observed_wait" "a_rollback"
permutation "a_freeze_boundary" "a_begin" "a_old_seat" "b_frozen" "observed_wait" "freeze" "a_commit"
