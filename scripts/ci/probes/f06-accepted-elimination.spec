# One rendered commit/rollback permutation runs on a fresh exact native clone.
setup {
 CREATE SCHEMA f06_elimination_native;
 CREATE FUNCTION f06_elimination_native.claim(expected_already boolean) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE c public.tournament_knockout_candidates;r jsonb; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+CASE_NUMBER;
 IF CASE_NUMBER=4 THEN r:=public.fn_eliminate_tournament_player_atomic(c.tournament_id,c.eliminated_user_id,2,0,0);
 ELSE r:=public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.eliminated_user_id,2,0,c.table_id,c.hand_id,c.hand_number,c.seat_joined_at,NULL,NULL,0,false); END IF;
 IF r->>'ok' IS DISTINCT FROM 'true' OR coalesce((r->>'already')::boolean,false) IS DISTINCT FROM expected_already
 OR (NOT expected_already AND r->>'claimed' IS DISTINCT FROM 'true')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch) THEN
 RAISE EXCEPTION 'ELIMINATION_RACE_CLAIM_FAILED: %',r; END IF;
 RAISE NOTICE 'ELIMINATION_RACE_CLAIM_PROVEN'; END $$;
}
session "a"
setup { SET application_name='elimination-claim-a'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s'; SET idle_in_transaction_session_timeout='15s'; }
step "a_begin" { BEGIN; }
step "a_claim" { SELECT f06_elimination_native.claim(false); }
step "a_commit" { COMMIT; }
step "a_rollback" { ROLLBACK; }
session "b"
setup { SET application_name='elimination-claim-b'; SET request.jwt.claim.role='service_role'; SET statement_timeout='10s'; }
step "b_claim_commit" { SELECT f06_elimination_native.claim(true); }
step "b_claim_rollback" { SELECT f06_elimination_native.claim(false); }
session "observer"
step "observed_wait" {
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
 WHERE b.datname=current_database() AND a.datname=current_database() AND b.application_name='elimination-claim-b' AND a.application_name='elimination-claim-a' AND b.wait_event_type='Lock') THEN
 RAISE EXCEPTION 'ELIMINATION_RACE_WAIT_NOT_PROVEN'; END IF; RAISE NOTICE 'ELIMINATION_RACE_WAIT_PROVEN'; END $$;
}
step "final_state" {
 DO $$ DECLARE c public.tournament_knockout_candidates; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+CASE_NUMBER;
 IF c.state<>'eliminated'
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id AND status='eliminated' AND chips=0 AND position=2)<>1
 OR (SELECT count(*) FROM public.table_seats WHERE id=c.seat_id AND left_at IS NOT NULL AND stack=0)<>1
 OR (SELECT count(*) FROM public.tournament_bounty_obligations WHERE tournament_id=c.tournament_id)<>(CASE WHEN CASE_NUMBER=4 THEN 0 ELSE 1 END)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=c.table_id AND (state<>'park_requested' OR manifest IS NOT NULL OR custody_id IS NOT NULL OR revision<>0)) THEN
 RAISE EXCEPTION 'ELIMINATION_RACE_EFFECTS_WRONG'; END IF; RAISE NOTICE 'ELIMINATION_RACE_EFFECTS_PROVEN'; END $$;
}
permutation "a_begin" "a_claim" "b_claim_commit" "observed_wait" "a_commit" "final_state"
permutation "a_begin" "a_claim" "b_claim_rollback" "observed_wait" "a_rollback" "final_state"
