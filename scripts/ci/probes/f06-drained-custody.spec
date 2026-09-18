# Run each rendered permutation on its own exact native fixture clone.
# Only pg_temp test helpers are used; every business RPC is the captured owner.
setup {
 SET request.jwt.claim.role='service_role';
 SELECT set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,false);
 SELECT public.fn_eliminate_tournament_player_atomic('b7200000-0000-4000-8000-000000000004','b7100000-0000-4000-8000-000000000007',2,0,0);
 DO $$ BEGIN IF NOT (SELECT granted FROM public.claim_tournament_lease_v2('b7200000-0000-4000-8000-000000000004','movement-race','qualified','b7500000-0000-4000-8000-000000000004',30)) THEN
 RAISE EXCEPTION 'MOVEMENT_RACE_MANAGER_CLAIM_FAILED'; END IF; END $$;
}
session "a"
setup {
 SET application_name='movement-admission-a'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s';
 SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='b7200000-0000-4000-8000-000000000004'; SET app.smarter_tournament_lease_generation='b7500000-0000-4000-8000-000000000004';
 CREATE FUNCTION pg_temp.claim() RETURNS void LANGUAGE plpgsql AS $$ DECLARE o smarter_private.f06_operations; r jsonb; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 r:=public.fn_f06_assert_drained_manager_custody(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.origin_generation,
 jsonb_build_array(jsonb_build_object('break_id',o.break_id,'table_id',o.source_table_id,'lifecycle',o.lifecycle::text)),NULL);
 IF r->>'recovery_required'<>'false' OR jsonb_array_length(r->'proof'->'parks')<>1 THEN RAISE EXCEPTION 'DRAINED_RACE_ASSERT_WRONG';END IF;
 RAISE NOTICE 'DRAINED_RACE_ASSERT_PROVEN';END $$;
}
step "a_begin" { BEGIN; }
step "a_claim" { SELECT pg_temp.claim(); }
step "a_commit" { COMMIT; }
step "a_rollback" { ROLLBACK; }
session "b"
setup {
 SET application_name='movement-admission-b'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s';
 SET app.smarter_data_actor='tournament-manager'; SET app.smarter_tournament_id='b7200000-0000-4000-8000-000000000004'; SET app.smarter_tournament_lease_generation='b7500000-0000-4000-8000-000000000004';
 CREATE FUNCTION pg_temp.claim() RETURNS void LANGUAGE plpgsql AS $$ DECLARE o smarter_private.f06_operations; r jsonb; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 r:=public.fn_f06_admit_parked_movement(o.tournament_id,'b7500000-0000-4000-8000-000000000004',o.source_table_id,o.lifecycle,o.break_id,'b7600000-0000-4000-8000-000000000004','b7700000-0000-4000-8000-000000000004',0);
 IF r->>'mode' IS DISTINCT FROM 'movement_only' OR r->>'revision' IS DISTINCT FROM '1' OR r->>'custody_id' IS DISTINCT FROM 'b7700000-0000-4000-8000-000000000004' THEN RAISE EXCEPTION 'MOVEMENT_RACE_CLAIM_WRONG: %',r; END IF;
 RAISE NOTICE 'MOVEMENT_RACE_CLAIM_PROVEN'; END $$;
}
step "b_claim" { SELECT pg_temp.claim(); }
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='movement-admission-b' AND a.application_name='movement-admission-a' AND b.wait_event_type='Lock') THEN
 RAISE EXCEPTION 'MOVEMENT_RACE_WAIT_NOT_PROVEN'; END IF; RAISE NOTICE 'DRAINED_RACE_WAIT_PROVEN'; END $$;
}
step "final_state" {
 DO $$ DECLARE o smarter_private.f06_operations; a smarter_private.f06_movement_admissions; BEGIN
 SELECT * INTO STRICT o FROM smarter_private.f06_operations WHERE source_table_id='b7300000-0000-4000-8000-000000000004';
 SELECT * INTO STRICT a FROM smarter_private.f06_movement_admissions WHERE break_id=o.break_id;
 IF a.admission_id<>'b7600000-0000-4000-8000-000000000004' OR o.custody_id<>a.custody_id OR o.revision<>1 OR a.revision<>1
 OR o.custody_generation<>a.lease_generation OR o.state<>'park_requested' OR o.manifest IS NOT NULL
 OR jsonb_array_length(a.proof->'roster')<>2 OR jsonb_array_length(a.proof->'eliminated')<>1 OR a.proof->'permits'<>'[]'::jsonb
 OR a.proof_hash<>encode(extensions.digest(convert_to(a.proof::text,'UTF8'),'sha256'),'hex')
 OR (SELECT count(*) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>2
 OR (SELECT sum(stack) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>200
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts WHERE source_table_id=o.source_table_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=o.source_table_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_dispatch) THEN RAISE EXCEPTION 'MOVEMENT_RACE_EFFECTS_WRONG'; END IF;
 RAISE NOTICE 'DRAINED_RACE_FINAL_PROVEN'; END $$;
}
permutation "a_begin" "a_claim" "b_claim" "observed_wait" "a_commit" "final_state"
permutation "a_begin" "a_claim" "b_claim" "observed_wait" "a_rollback" "final_state"
